'use strict';
// Later-stage strategy modules. Each is called as mod(engine, name) and registers feeds/strategies.
const { SolanaWhaleFeed, EvmWhaleFeed, EVM } = require('./feeds/whales');
const HELIUS = require('./feeds/helius');
const { CreditBudget } = require('./lib/credits');
const { WhaleFollow } = require('./strategies/whale-follow');
const { WalletFollow, loadWatchlist } = require('./strategies/wallet-follow');
const { HlFillsFeed } = require('./feeds/hl-fills');
const { CandleFeed } = require('./feeds/candles');
const { OnePct } = require('./strategies/one-pct');
const { DexFeed } = require('./feeds/dex');
const { GapScanner } = require('./strategies/gaps');
const { TradovateFeed } = require('./feeds/tradovate');
const { OpeningRangeBreakout } = require('./strategies/orb');
const { PerpBars } = require('./feeds/perp-bars');
const { Lab } = require('./lab/lab');
const path = require('path');
const { PerpMomentum, PerpBasis } = require('./strategies/perps');
const betting = require('./betting'); // self-contained module; see server/betting/index.js for the host contract
const { Strategy } = require('./strategies/base');
const { MempoolFeed } = require('./feeds/mempool');
const { MevLab } = require('./strategies/mev-lab');
const { Recorder } = require('./recorder');
const { makeWsAuth } = require('./kalshi-auth/ws-sign');
const { StorageMonitor, readRuntimeCap } = require('./storage');
const { CfRecorderRemote } = require('./recorder/cf-remote');
const { KalshiH2Paper } = require('./kalshi-h2');

module.exports = {
  whales(engine) {
    const c = engine.cfg; const priceFn = (s) => engine.price(s);
    const h = c.helius;
    const budget = engine.heliusBudget = new CreditBudget({ provider: 'helius', budget: h.creditBudget, dailyBudget: h.dailyBudget, pauseAtPct: h.pauseAtPct, planCredits: HELIUS.CREDITS.freePlanMonthly, file: c.creditsFile });
    // Auto-pause the remote webhook near the cap (deliveries cannot be refused locally; Helius bills each one).
    const pauseRemote = h.autoPauseWebhook && h.apiKey && h.webhookUrl ? () => HELIUS.pauseWebhook({ apiKey: h.apiKey, url: h.webhookUrl, ...(h.webhooksApi ? { api: h.webhooksApi } : {}) }) : null;
    // Live whale data arrives ONLY via the HAWSE inbox poller (server/feeds/inbox.js); there is no local webhook receiver.
    const sol = engine.addFeed('whale.solana', new SolanaWhaleFeed({ health: engine.health, apiKey: h.apiKey, watch: h.watch, minUsd: h.minUsd, priceFn,
      mode: h.mode, enabled: h.enabled, inbox: h.inbox, budget, pauseRemote, maxSignalAgeSec: h.maxSignalAgeSec }));
    const feeds = [sol];
    for (const chain of c.evm.chains.filter((x) => EVM[x])) feeds.push(engine.addFeed('whale.' + chain, new EvmWhaleFeed({ health: engine.health, chain, evmCfg: c.evm, minUsd: c.helius.minUsd, priceFn })));
    engine.addStrategy(new WhaleFollow(engine, feeds));
    // Wallet-follow v2 (H3): Hyperliquid fills (public) + the same Solana feed (no extra Helius calls).
    const fc = c.follow;
    if (fc && fc.enabled) {
      const wallets = loadWatchlist(fc.watchlistFile, fc.walletsHl);
      const hl = engine.addFeed('follow.hl', new HlFillsFeed({ health: engine.health, wallets, pollMs: fc.pollMs, minUsd: fc.minUsdHl }));
      engine.addStrategy(new WalletFollow(engine, { hl, sol, cfg: fc }));
    }
  },
  mempool(engine) { // H4: measurement-only lab. The feed does not connect unless MEMPOOL_ENABLED=true.
    const m = engine.cfg.mempool || { enabled: false };
    const feed = engine.addFeed('mempool', new MempoolFeed({ health: engine.health, cfg: m }));
    engine.addStrategy(new MevLab(engine, { feed, cfg: { minUsd: m.minUsd, bidShare: m.bidShare, gasSandwich: m.gasSandwich, gasBackrun: m.gasBackrun, eventsFile: m.eventsFile, duneFile: m.duneFile } }));
  },
  onepct(engine) {
    const feed = engine.addFeed('candles', new CandleFeed({ health: engine.health, symbols: engine.cfg.onepct.symbols }));
    engine.addStrategy(new OnePct(engine, feed));
  },
  gaps(engine) {
    const c = engine.cfg;
    const feed = engine.addFeed('dex', new DexFeed({ health: engine.health, cfg: { ...c.gaps, jupiterBase: c.jupiter.base, jupiterKey: c.jupiter.apiKey }, evmCfg: c.evm, priceFn: (s) => engine.price(s) }));
    engine.addStrategy(new GapScanner(engine, feed));
  },
  orb(engine) {
    const feed = engine.addFeed('futures', new TradovateFeed({ health: engine.health, cfg: engine.cfg.tradovate }));
    engine.addStrategy(new OpeningRangeBreakout(engine, feed));
  },
  perps(engine) {
    const bars = engine.addFeed('perpbars', new PerpBars({ health: engine.health, symbols: engine.cfg.perps.symbols, bar: engine.cfg.perps.momentum.bar }));
    engine.addStrategy(new PerpMomentum(engine, bars));
    engine.addStrategy(new PerpBasis(engine));
  },
  betting(engine) { betting.mount(engine, { Strategy }); },
  recorder(engine) { // H6: record-only market data (public endpoints; no orders, no auth). Mounted after betting so it can tap the odds feed.
    const c = engine.cfg.recorder; if (!c || !c.enabled) return;
    const sc = engine.cfg.storage; // a cap set live in the Storage panel survives restarts (data/runtime/recorder-cap.json) and wins over RECORDER_CAP_GB
    if (sc && sc.enabled && sc.runtimeCap) { const gb = readRuntimeCap(path.join(sc.dataDir, 'runtime', 'recorder-cap.json')); if (gb && gb >= sc.minGb && gb <= sc.maxGb) { c.capBytes = gb * 2 ** 30; c.capSource = 'runtime'; } }
    const log = engine.log || ((m) => console.log(m)); const deps = {};
    if (c.kalshiWs && c.kalshiWs.enabled) { // H7: the WS handshake signer is built here from env, server-side; the recorder only gets the header function
      try { deps.kalshiWsAuth = makeWsAuth(engine.env || process.env); } catch (e) { log('[recorder] ' + e.message); deps.kalshiWsAuth = null; }
    }
    engine.recorder = engine.addFeed('recorder', new Recorder({ health: engine.health, cfg: c, odds: engine.feeds.odds || null, log, deps }));
  },
  kalshiH2(engine) { // H6 Part C: frozen forward paper test; paper ledger only, never desk equity, no order path.
    const c = engine.cfg.kalshiH2; if (!c || !c.enabled || !engine.recorder || !engine.recorder.kalshi) return;
    engine.kalshiH2 = engine.addFeed('kalshiH2', new KalshiH2Paper({ kalshi: engine.recorder.kalshi, health: engine.health, dir: c.dir, log: engine.log || ((m) => console.log(m)) }));
  },
  cfRecorder(engine) { // H7 Stage L: status + pull client for the always-on Cloudflare recorder. READ token stays server-side.
    const c = engine.cfg.cfRecorder; if (!c || !c.enabled) return;
    engine.cfRecorder = engine.addFeed('cfRecorder', new CfRecorderRemote({ url: c.url, token: c.readToken, dir: c.dir, health: engine.health, statusMs: c.statusMs, syncMs: c.syncMs, sync: c.sync, staleMs: c.staleMs, log: engine.log || ((m) => console.log(m)) }));
  },
  storage(engine) { // H7: disk/memory fill bars + live recorder-cap control. Read-only measuring; the only write is the cap file.
    const c = engine.cfg.storage; if (!c || !c.enabled) return;
    engine.storage = engine.addFeed('storage', new StorageMonitor({ dataDir: c.dataDir, recorder: engine.recorder || null, cf: engine.cfRecorder || null, logFiles: c.logFile ? [c.logFile] : [], minGb: c.minGb, maxGb: c.maxGb, warnPct: c.warnPct, critPct: c.critPct, log: engine.log || ((m) => console.log(m)) }));
  },
  lab(engine) {
    const file = engine.cfg.lab && engine.cfg.lab.file !== undefined ? engine.cfg.lab.file : path.join(__dirname, '..', 'data', 'lab', 'strategies.json');
    engine.lab = engine.addFeed('lab', new Lab({ file, health: engine.health })); engine.lab.importers = engine.importers || (engine.importers = []); // modules (e.g. betting) register import handlers
  },
};
