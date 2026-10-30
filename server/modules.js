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
};
