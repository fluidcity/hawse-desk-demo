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
  lab(engine) {
    const file = engine.cfg.lab && engine.cfg.lab.file !== undefined ? engine.cfg.lab.file : path.join(__dirname, '..', 'data', 'lab', 'strategies.json');
    engine.lab = engine.addFeed('lab', new Lab({ file, health: engine.health })); engine.lab.importers = engine.importers || (engine.importers = []); // modules (e.g. betting) register import handlers
  },
};
