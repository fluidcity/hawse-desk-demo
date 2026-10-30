'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../server/feeds/funding');
const { redact } = require('../server/lib/net');

test('binance parser normalizes interval from fundingInfo (default 8h)', () => {
  const r = P.parseBinance([{ symbol: 'BTCUSDT', lastFundingRate: '0.0001', nextFundingTime: 1, markPrice: '60000' }, { symbol: 'SOLUSDT', lastFundingRate: '0.0004', nextFundingTime: 1, markPrice: '100' }],
    [{ symbol: 'BTCUSDT', bidPrice: '59999', askPrice: '60001' }], [{ symbol: 'SOLUSDT', fundingIntervalHours: 4 }], ['BTC', 'SOL', 'XRP']);
  assert.equal(r.length, 2);
  assert.equal(r[0].intervalH, 8); assert.ok(Math.abs(r[0].hourly - 0.0000125) < 1e-12);
  assert.equal(r[1].intervalH, 4); assert.ok(Math.abs(r[1].hourly - 0.0001) < 1e-12);
});

test('bybit parser uses fundingIntervalHour or instruments-info minutes', () => {
  const r = P.parseBybit({ result: { list: [{ symbol: 'ETHUSDT', fundingRate: '0.0002', nextFundingTime: '1', markPrice: '3000', bid1Price: '2999.9', ask1Price: '3000.1' }] } },
    { result: { list: [{ symbol: 'ETHUSDT', fundingInterval: 240 }] } }, ['ETH']);
  assert.equal(r[0].intervalH, 4); assert.ok(r[0].halfSpreadBps > 0);
});

test('okx parser derives interval from nextFundingTime - fundingTime', () => {
  const r = P.parseOkx({ SOL: { fundingRate: '-0.00024', fundingTime: '1793347200000', nextFundingTime: '1793376000000' } }, { data: [{ instId: 'SOL-USDT-SWAP', bidPx: '97.1', askPx: '97.11', last: '97.1' }] }, { data: [{ instId: 'SOL-USDT-SWAP', markPx: '97.11' }] }, ['SOL']);
  assert.equal(r[0].intervalH, 8); assert.equal(r[0].mark, 97.11);
});

test('hyperliquid parser: hourly funding, next settlement on the hour', () => {
  const now = Date.parse('2026-10-29T10:20:00Z');
  const r = P.parseHyperliquid([{ universe: [{ name: 'BTC' }, { name: 'SOL' }] }, [{ funding: '0.0000125', markPx: '78000', impactPxs: ['77999', '78001'], dayNtlVlm: '1e9', openInterest: '100' }, { funding: '-0.00001', markPx: '97' }]], ['SOL', 'BTC'], now);
  assert.equal(r.length, 2); assert.equal(r[0].symbol, 'SOL'); assert.equal(r[1].intervalH, 1);
  assert.equal(r[1].nextFundingTime, Date.parse('2026-10-29T11:00:00Z'));
});

test('redact strips api keys from urls in errors', () => {
  assert.equal(redact('https://x/y?api-key=abc123&z=1'), 'https://x/y?api-key=***&z=1');
  assert.ok(!redact('https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstu').includes('abcdefghijklmnop'));
});
