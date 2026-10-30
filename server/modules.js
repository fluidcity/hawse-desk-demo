'use strict';
// Later-stage strategy modules. Each is called as mod(engine, name) and registers feeds/strategies.
const { SolanaWhaleFeed, EvmWhaleFeed, EVM } = require('./feeds/whales');
const { WhaleFollow } = require('./strategies/whale-follow');
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
const { OddsFeed } = require('./feeds/odds');
const { BetBook } = require('./betting/book');
const { LiveBetPlacer } = require('./betting/live');
const { BetEV, BetSpread, BetArb } = require('./strategies/betting');

module.exports = {
  whales(engine) {
    const c = engine.cfg; const priceFn = (s) => engine.price(s);
    const feeds = [engine.addFeed('whale.solana', new SolanaWhaleFeed({ health: engine.health, apiKey: c.helius.apiKey, watch: c.helius.watch, minUsd: c.helius.minUsd, priceFn }))];
    for (const chain of c.evm.chains.filter((x) => EVM[x])) feeds.push(engine.addFeed('whale.' + chain, new EvmWhaleFeed({ health: engine.health, chain, evmCfg: c.evm, minUsd: c.helius.minUsd, priceFn })));
    engine.addStrategy(new WhaleFollow(engine, feeds));
  },
  onepct(engine) {
    const feed = engine.addFeed('candles', new CandleFeed({ health: engine.health, symbols: engine.cfg.onepct.symbols }));
    engine.addStrategy(new OnePct(engine, feed));
  },
  gaps(engine) {
    const c = engine.cfg;
    const feed = engine.addFeed('dex', new DexFeed({ health: engine.health, cfg: { ...c.gaps, jupiterBase: c.jupiter.base }, evmCfg: c.evm, priceFn: (s) => engine.price(s) }));
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
  betting(engine) {
    const feed = engine.addFeed('odds', new OddsFeed({ health: engine.health, cfg: engine.cfg.betting }));
    const book = engine.bets = engine.addFeed('bets', new BetBook(engine, feed, engine.cfg.betting));
    engine.liveBets = new LiveBetPlacer(); engine.placeLiveBet = () => engine.liveBets.placeBet(); // always throws
    for (const S of [BetEV, BetSpread, BetArb]) engine.addStrategy(new S(engine, feed, book));
  },
  lab(engine) {
    const file = engine.cfg.lab && engine.cfg.lab.file !== undefined ? engine.cfg.lab.file : path.join(__dirname, '..', 'data', 'lab', 'strategies.json');
    engine.lab = engine.addFeed('lab', new Lab({ file, health: engine.health }));
  },
};
