'use strict';
// H4 mempool lab: (1) no capability to authorize, bundle or broadcast anything, (2) off by default, (3) read-only RPC,
// (4) the pending → simulate → included → ground-truth pipeline against a scripted node, (5) no secret leaks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../server/config');
const { Engine } = require('../server/engine');
const { MempoolFeed, READ_ONLY_METHODS } = require('../server/feeds/mempool');
const { MevLab, PLAN } = require('../server/strategies/mev-lab');
const T = require('../server/mev/truth');
const S = require('../server/mev/sim');

const ROOT = path.join(__dirname, '..');
const FILES = ['server/mev/decode.js', 'server/mev/sim.js', 'server/mev/truth.js', 'server/feeds/mempool.js', 'server/strategies/mev-lab.js', 'scripts/mev-import-dune.js'];
const FORBIDDEN = ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sendBundle', 'mev_sendBundle', 'eth_sendPrivateTransaction', 'eth_signTransaction', 'eth_sign', 'personal_sign',
  'signTransaction', 'createSign', 'secp256k1', 'PRIVATE_KEY', 'privateKey', 'relay.flashbots', 'rpc.flashbots', 'flashbots.net', 'mev-share', 'builder0x69', 'rsync-builder'];

test('no code path can authorize, bundle or broadcast: source scan + exported surface', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const w of FORBIDDEN) assert.ok(!src.includes(w), `${f} contains forbidden token ${w}`);
    assert.ok(!/require\(['"](ethers|web3|viem|@ethersproject|@noble\/secp256k1|@flashbots)/.test(src), `${f} imports a signing/tx library`);
    assert.ok(!/\b(ethers|web3)\b/.test(src), `${f} mentions ethers/web3`);
  }
  const mods = FILES.filter((f) => f.startsWith('server/')).map((f) => require(path.join(ROOT, f)));
  const names = mods.flatMap((m) => Object.keys(m));
  for (const C of [MempoolFeed, MevLab]) names.push(...Object.getOwnPropertyNames(C.prototype));
  for (const n of names) assert.ok(!/send(?!$)|sign|submit|bundle|broadcast|wallet|key/i.test(n), `exported capability looks like a write path: ${n}`);
  for (const m of READ_ONLY_METHODS) assert.ok(/^eth_(call|blockNumber|getBlockByNumber|getTransactionReceipt|getTransactionCount|getTransactionByHash)$/.test(m), m);
});

test('rpc() refuses every non-read method before any network call', async () => {
  let calls = 0; const feed = new MempoolFeed({ cfg: { enabled: true }, fetch: async () => { calls++; return { result: '0x1' }; } });
  for (const m of ['eth_sendRawTransaction', 'eth_sendBundle', 'eth_sign', 'personal_sign', 'eth_signTransaction', 'eth_sendTransaction', 'debug_traceCall', 'anything'])
    await assert.rejects(feed.rpc(m, []), /read-only/);
  assert.equal(calls, 0);
  assert.equal(await feed.rpc('eth_blockNumber'), '0x1'); assert.equal(calls, 1);
  assert.ok(Object.isFrozen(READ_ONLY_METHODS));
});

test('MEMPOOL_ENABLED defaults to false: no connection, no calls, card says so', async () => {
  const cfg = config.build({}); assert.equal(cfg.mempool.enabled, false);
  assert.equal(config.build({ MEMPOOL_ENABLED: 'true' }).mempool.enabled, true);
  const e = new Engine(cfg, { modules: { mempool: require('../server/modules').mempool } }); const lab = e.strategies.find((s) => s.id === 'mevlab'); assert.ok(lab, 'lab registered');
  const feed = e.feeds.mempool; feed.start(); assert.equal(feed.ws, undefined, 'no socket when disabled'); assert.equal(feed.mode, 'off');
  await assert.rejects(feed.rpc('eth_blockNumber'), /disabled/);
  assert.equal(lab.dataMode(), 'down'); assert.match(e.health.get('mempool.ws').note, /MEMPOOL_ENABLED=false/);
  assert.equal(lab.view().metrics.verdict.status, 'collecting');
});

test('alchemy key never appears in views, health or explainers', () => {
  const FAKE = 'SECRETALCHEMYKEY123';
  const e = new Engine(config.build({ MEMPOOL_ENABLED: 'true', ALCHEMY_API_KEY: FAKE }), { modules: { mempool: require('../server/modules').mempool } });
  const lab = e.strategies.find((s) => s.id === 'mevlab');
  assert.equal(e.feeds.mempool.source, 'alchemy');
  const blob = JSON.stringify([lab.view(), lab.snapshot(), lab.explain(), e.health.list(), e.feeds.mempool.snapshot()]);
  assert.ok(!blob.includes(FAKE));
});

// ---- scripted node -------------------------------------------------------------------------------------------
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const POOL = '0x' + 'ab'.repeat(20), V2R = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', BOT = '0x' + 'b0'.repeat(20), BOTC = '0x' + 'c0'.repeat(20);
const W = (x) => BigInt(x).toString(16).padStart(64, '0'); const A = (a) => a.slice(2).padStart(64, '0');
const E6 = 10n ** 6n, E18 = 10n ** 18n, R0 = 3000000n * E6, R1 = 1000n * E18;
const H = (n) => '0x' + n.toString(16).padStart(64, '0');
function victimTx(hash, from, nonce, usd) {
  const amountIn = BigInt(usd) * E6, minOut = S.amountOut(amountIn, R0, R1) * 99n / 100n;
  const input = '0x38ed1739' + W(amountIn) + W(minOut) + W(160) + A(from) + W(9999999999) + W(2) + A(USDC) + A(WETH);
  return { hash, from, nonce: '0x' + nonce.toString(16), to: V2R, input, value: '0x0', maxFeePerGas: '0x0' };
}
const swapLog = (a0in, a1in, a0out, a1out) => ({ address: POOL, topics: [T.V2_SWAP], data: '0x' + W(a0in) + W(a1in) + W(a0out) + W(a1out) });
function node(state) {
  return async (url, { body }) => {
    const { method, params } = body; state.calls.push(method);
    if (method === 'eth_call') {
      const { to, data } = params[0];
      if (data.startsWith('0xe6a43905')) return { result: '0x' + A(POOL) };
      if (to === POOL && data === '0x0902f1ac') return { result: '0x' + W(R0) + W(R1) + W(0) };
    }
    if (method === 'eth_getBlockByNumber') return { result: state.blocks[parseInt(params[0], 16)] || { transactions: [] } };
    if (method === 'eth_getTransactionReceipt') return { result: state.receipts[params[0]] || null };
    if (method === 'eth_getTransactionCount') return { result: '0x' + (state.nonces[params[0]] || 0).toString(16) };
    return { error: { message: 'unexpected ' + method } };
  };
}

test('pipeline: pending swap → simulated sandwich → included + sandwiched in block → attacker gross, metrics, SIM booking only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mev-'));
  const e = new Engine(config.build({ FUNDING_HL_TOP_OI: '0', CARRY_ENABLED: 'false', WS_ENABLED: 'false' }), { modules: {} });
  e.spotQuote = (sym) => (sym === 'ETH' ? { mid: 3000 } : null);
  const state = { calls: [], blocks: {}, receipts: {}, nonces: {} };
  const feed = new MempoolFeed({ cfg: { enabled: true }, fetch: node(state) });
  const lab = new MevLab(e, { feed, cfg: { eventsFile: path.join(dir, 'ev.json'), duneFile: null } }); e.addStrategy(lab); lab.armed = true;
  await lab.onHead({ number: '0x10', baseFeePerGas: '0x' + (10n ** 9n).toString(16) }); // 1 gwei base
  const v1 = victimTx(H(1), '0x' + '11'.repeat(20), 5, 100000), v2 = victimTx(H(2), '0x' + '22'.repeat(20), 7, 60000), small = victimTx(H(3), '0x' + '33'.repeat(20), 1, 500);
  const pend = []; feed.onPending((x) => pend.push(lab.byHash.get(x.tx.hash)));
  feed.ingest(v1); feed.ingest(v2); feed.ingest(small); feed.ingest({ hash: H(9), to: '0x' + '99'.repeat(20), input: '0x' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(feed.stats.pendingSeen, 4); assert.equal(feed.stats.routerTxs, 3); assert.equal(lab.counts.small, 1);
  const ev = lab.byHash.get(H(1)); assert.equal(ev.status, 'simulated'); assert.equal(ev.pair, 'USDC→WETH'); assert.ok(Math.abs(ev.slipTolPct - 1) < 0.01);
  assert.ok(ev.simGrossUsd > 800 && ev.simGrossUsd < 1100, 'gross ≈ $935 on a 3M/1000 pool with 1% slippage');
  assert.ok(Math.abs(ev.gasUsd - 360000 * 2e-9 * 3000) < 1e-6, 'gas = units × (base + 1 gwei) × ETH');
  assert.ok(ev.simSandwichCeilUsd > ev.simSandwichRealUsd && ev.simSandwichRealUsd > 0);
  assert.ok(ev.simBackrunUsd != null);
  // block 0x11: bot front-run, victim 1, bot back-run (plus one unrelated tx); victim 2 not included
  state.blocks[0x11] = { transactions: [{ hash: H(100), from: BOT, to: BOTC }, { hash: H(1), from: v1.from, to: V2R }, { hash: H(101), from: '0x' + '44'.repeat(20), to: V2R }, { hash: H(102), from: BOT, to: BOTC }] };
  state.receipts[H(100)] = { logs: [swapLog(50000n * E6, 0n, 0n, 16n * E18)] }; state.receipts[H(102)] = { logs: [swapLog(0n, 16n * E18, 50900n * E6, 0n)] };
  await lab.onHead({ number: '0x11' }); await new Promise((r) => setTimeout(r, 20));
  assert.equal(ev.inclusion, 'included'); assert.equal(ev.observedSandwich, true); assert.equal(ev.index, 1);
  assert.ok(Math.abs(ev.attackerGrossUsd - 900) < 1e-6, 'attacker gross from the two Swap logs = 50,900 − 50,000');
  assert.equal(lab.counts.victims, 2, 'both mid-sandwich txs counted (heuristic)'); assert.equal(lab.counts.victimsSeen, 1);
  // victim 2: 3 blocks later its sender's nonce moved on without it → replaced
  state.nonces[v2.from] = 8; for (const n of [0x12, 0x13]) await lab.onHead({ number: '0x' + n.toString(16) }); await new Promise((r) => setTimeout(r, 20));
  assert.equal(lab.byHash.get(H(2)).inclusion, 'replaced');
  const m = lab.metrics();
  assert.equal(m.observed, 2); assert.equal(m.confirmed, 1); assert.equal(m.recallPct, 100); assert.equal(m.precisionPct, 100);
  assert.ok(m.medianErrPct >= 0 && m.medianErrPct < 25); assert.equal(m.coverageVictimsPct, 50); assert.equal(m.verdict.status, 'collecting');
  const b = e.ledger.book('mevlab'); assert.equal(b.real.n || 0, 0); assert.ok(b.sim.realized > 0, 'booked to the SIM book only'); assert.ok(Math.abs(b.sim.realized - ev.simSandwichRealUsd) < 1e-9);
  for (const c of state.calls) assert.ok(READ_ONLY_METHODS.has(c), 'only read methods hit the node: ' + c);
  assert.ok(PLAN.minObserved >= 500 && PLAN.minConfirmed >= 50);
});

test('detectSandwiches heuristic and Dune CSV import', () => {
  const tx = (h, from, to) => ({ hash: h, from, to });
  const m = T.detectSandwiches([tx('0xa', 'b', 'c'), tx('0xv', 'u', 'r'), tx('0xb', 'b', 'c'), tx('0xz', 'b', 'c'), tx('0xq', 'q', 'r')]);
  assert.deepEqual([...m.keys()], ['0xv']); assert.equal(m.get('0xv').attacker, 'b');
  assert.equal(T.detectSandwiches([tx('0xa', 'b', 'c'), tx('0xb', 'b', 'c')]).size, 0, 'adjacent pair with nothing between is not a sandwich');
  const far = [tx('0xa', 'b', 'c'), ...[1, 2, 3, 4, 5].map((i) => tx('0x' + i, 'x' + i, 'r')), tx('0xb', 'b', 'c')];
  assert.equal(T.detectSandwiches(far).size, 0, `> ${T.MAX_GAP} apart is ignored`);
  const h = '0x' + 'ab'.repeat(32);
  const rows = T.parseCsv(`block_time,block_number,tx_hash,project,amount_usd\n"2026-10-28 10:00",123,${h},uniswap,"12,345.5"\nbad,1,nothex,x,1\n`);
  const idx = T.duneIndex(rows); assert.equal(idx.size, 1); assert.equal(idx.get(h).block, 123); assert.equal(idx.get(h).usd, null, 'amount_usd is victim size, not profit');
});
