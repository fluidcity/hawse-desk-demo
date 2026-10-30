'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../server/lib/ledger');
const { PaperBroker, LiveBroker } = require('../server/lib/broker');
const config = require('../server/config');
const { Engine } = require('../server/engine');

test('ledger keeps real and simulated PnL in separate books', () => {
  const l = new Ledger({ startEquity: 1000 });
  l.close('a', { pnl: 10, simulated: false }); l.close('a', { pnl: 50, simulated: true });
  l.charge('b', { amount: 2, simulated: false });
  const t = l.totals();
  assert.equal(t.realEquity, 1008); assert.equal(t.simPnl, 50);
  assert.throws(() => l.close('a', { pnl: 1 }), TypeError, 'simulated flag is mandatory');
  assert.throws(() => l.close('a', { pnl: NaN, simulated: false }));
});

test('win/loss uses full trade outcome', () => {
  const l = new Ledger({ startEquity: 1000 });
  l.close('x', { pnl: 1, total: -0.5, simulated: false });
  assert.equal(l.book('x').real.losses, 1);
});

test('paper fill applies slippage and fee', () => {
  const f = new PaperBroker().fill({ strategy: 's', venue: 'v', symbol: 'BTC', side: 'buy', qty: 1, price: 100, feeRate: 0.001, slipBps: 10 });
  assert.ok(Math.abs(f.price - 100.1) < 1e-9); assert.ok(Math.abs(f.fee - 0.1001) < 1e-9); assert.equal(f.paper, true);
});

test('live order path is a disabled stub', () => {
  assert.throws(() => new LiveBroker().placeOrder({}), /disabled/);
  assert.throws(() => new LiveBroker().cancelOrder({}), /disabled/);
});

test('engine refuses non-paper trading mode', () => {
  assert.throws(() => new Engine({ ...config.build({}), tradingMode: 'live' }), /paper/);
});

test('public flags never contain secrets', () => {
  const cfg = config.build({ HELIUS_API_KEY: 'sekret-helius', TRADOVATE_PASSWORD: 'pw-123', TRADOVATE_SECRET: 'sec-xyz', TRADOVATE_USERNAME: 'u', TRADOVATE_APP_ID: 'a', TRADOVATE_CID: '1', ALCHEMY_API_KEY: 'alch-key' });
  const s = JSON.stringify(config.publicFlags(cfg));
  for (const v of ['sekret-helius', 'pw-123', 'sec-xyz', 'alch-key']) assert.ok(!s.includes(v));
  assert.equal(config.publicFlags(cfg).tradovateConfigured, true);
});
