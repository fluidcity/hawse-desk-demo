'use strict';
// H7 Stage H: Bullish (6th of 7 BRTI constituents) wired into the 1 s reference median; free public, unauthenticated.
const test = require('node:test');
const assert = require('node:assert');
const { parse, RefPriceRecorder } = require('../server/recorder/refprice');
const { Health } = require('../server/lib/health');
const config = require('../server/config');

test('bullish parser: live update batches only (snapshot replays can be weeks old), USD pairs only, oldest→newest', () => {
  const tr = (symbol, price, t) => ({ symbol, tradeId: String(t), price: String(price), quantity: '0.1', side: 'BUY', isTaker: true, createdAtTimestamp: String(t) });
  assert.deepEqual(parse.bullish({ type: 'snapshot', dataType: 'V1TAAnonymousTradeUpdate', data: { symbol: 'XRPUSD', trades: [tr('XRPUSD', 1.38, 1790227732708)] } }), []);
  assert.deepEqual(parse.bullish({ type: 'update', dataType: 'V1TAAnonymousTradeUpdate', data: { symbol: 'BTCUSD', trades: [tr('BTCUSD', 76001, 20), tr('BTCUSD', 76000, 10), tr('BTCUSDC', 75990, 30)] } }),
    [{ asset: 'BTC', px: 76000, ex: 10 }, { asset: 'BTC', px: 76001, ex: 20 }]);
  assert.deepEqual(parse.bullish({ jsonrpc: '2.0', id: 'ka', result: { message: 'Keep alive pong' } }), []);
});

test('Bullish is a default ref venue; subscribes anonymousTrades per asset on the public endpoint, with keepalive; the newest trade feeds the median', () => {
  assert.ok(config.build({}).recorder.ref.venues.includes('bullish'));
  const socks = []; class FakeWS { constructor(url, o) { this.url = url; this.o = o; this.sent = []; socks.push(this); } send(s) { this.sent.push(JSON.parse(s)); } close() {} }
  const r = new RefPriceRecorder({ store: { write() {} }, health: new Health(), cfg: { venues: ['bullish'], assets: ['BTC', 'ETH'] }, WebSocketImpl: FakeWS, now: () => 1000, log: () => {} });
  r.start(); const s = socks[0];
  assert.equal(s.url, 'wss://api.exchange.bullish.com/trading-api/v1/market-data/trades'); assert.equal(s.o, undefined, 'no auth headers');
  s.onopen(); assert.deepEqual(s.sent.map((f) => [f.method, f.params.topic, f.params.symbol]), [['subscribe', 'anonymousTrades', 'BTCUSD'], ['subscribe', 'anonymousTrades', 'ETHUSD']]);
  s.onmessage({ data: JSON.stringify({ type: 'update', dataType: 'V1TAAnonymousTradeUpdate', data: { trades: [{ symbol: 'BTCUSD', price: '76002', createdAtTimestamp: '900' }, { symbol: 'BTCUSD', price: '76000', createdAtTimestamp: '800' }] } }) });
  const row = r.snapshotRow('BTC', 1000); assert.equal(row.med, 76002); assert.equal(row.venues.bullish.ex, 900);
  assert.equal(r.clients[0].c.pingMs, 30000); assert.equal(r.clients[0].c.ping.method, 'keepalivePing');
  r.stop();
});
