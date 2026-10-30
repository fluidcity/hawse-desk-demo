#!/usr/bin/env node
'use strict';
// Offline weekly watchlist builder for wallet-follow v2 (batch-1 H3). Hyperliquid only: fills are public and free.
//   node scripts/score-wallets.js 0xabc… 0xdef…              score and print (dry run, nothing written)
//   node scripts/score-wallets.js --file candidates.txt --write  also write data/watchlist.json (add dates preserved)
// Candidates are entered by hand (from public leaderboard / vault pages); this script does not scrape anything.
// Solana scoring is NOT run here: it needs Helius Parsed Events (10 credits per page) and this repo never spends Helius credits implicitly.
const fs = require('fs');
const path = require('path');
const { scoreWallet, buildWatchlist, RULES } = require('../server/lib/wallet-score');
const { HL_INFO } = require('../server/feeds/hl-fills');

const args = process.argv.slice(2), flag = (f) => args.includes(f), opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const out = opt('--out', path.join(__dirname, '..', 'data', 'watchlist.json')), days = +opt('--days', RULES.days), maxPages = +opt('--pages', 5);
let addrs = args.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
if (opt('--file')) addrs = addrs.concat(fs.readFileSync(opt('--file'), 'utf8').split(/\s+/).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)));
if (!addrs.length) { console.error('usage: score-wallets.js <0x addr…> [--file f] [--days 30] [--pages 5] [--write] [--out data/watchlist.json]'); process.exit(2); }

const post = async (body) => { const r = await fetch(HL_INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const now = Date.now(), scored = []; let calls = 0;
  for (const addr of [...new Set(addrs)]) {
    let fills = [], start = now - days * 864e5;
    for (let p = 0; p < maxPages; p++) { // userFillsByTime returns ≤ 2000 fills per call, oldest first
      const page = await post({ type: 'userFillsByTime', user: addr, startTime: start, aggregateByTime: false }); calls++;
      fills = fills.concat(page); if (page.length < 2000) break; start = Math.max(...page.map((f) => f.time)) + 1; await sleep(1200);
    }
    const s = { addr, ...scoreWallet(fills, { now, days }) }; scored.push(s);
    console.log(`${addr}  fills ${s.fills}  trades ${s.trades}  pnl ${s.realized.toFixed(0)}  score ${s.score == null ? '—' : s.score.toFixed(2)}  medHold ${s.medianHoldMin == null ? '—' : s.medianHoldMin.toFixed(0) + 'm'}  ${s.pass ? 'PASS' : 'reject: ' + s.why.join('; ')}${s.fills >= maxPages * 2000 ? '  (truncated at ' + maxPages + ' pages)' : ''}`);
    await sleep(1200);
  }
  let prev = { wallets: [] }; try { prev = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* first run */ }
  const wl = buildWatchlist(scored, prev, { now });
  console.log(`\n${wl.wallets.length} wallet(s) kept (top ${RULES.top}); ${calls} public Hyperliquid calls; 0 credits.`);
  if (flag('--write')) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(wl, null, 2)); console.log('wrote', out); }
  else console.log('dry run: pass --write to save', out);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
