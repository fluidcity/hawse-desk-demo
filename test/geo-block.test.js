'use strict';
// Part A: a jurisdiction block (Binance 451, Bybit CloudFront 403) is shown as BLOCKED (HTTP xxx), never as data
// and never as a bare "down"; the REST venue is re-probed every 30 min instead of every poll.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { fetchJson, isGeoBlock } = require('../server/lib/net');
const { Health } = require('../server/lib/health');
const { describe } = require('../server/providers');

async function withServer(handler, fn) {
  const srv = http.createServer(handler); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

test('isGeoBlock: 451 and CloudFront country 403 are blocks; auth 403, 404 and 5xx are not', () => {
  assert.equal(isGeoBlock(451, '{"msg":"Service unavailable from a restricted location"}'), true);
  assert.equal(isGeoBlock(403, '{ error:The Amazon CloudFront distribution is configured to block access from your country }'), true);
  assert.equal(isGeoBlock(403, '{"msg":"invalid api key"}'), false);
  assert.equal(isGeoBlock(404, 'restricted location'), false); assert.equal(isGeoBlock(502, ''), false);
});

test('fetchJson marks a geo-blocked source BLOCKED (HTTP 451) with its alternative, and a later success clears it', async () => {
  let mode = 451;
  await withServer((req, res) => {
    if (mode === 451) { res.writeHead(451, { 'content-type': 'application/json' }); res.end('{"code":0,"msg":"Service unavailable from a restricted location according to b. Eligibility"}'); }
    else if (mode === 403) { res.writeHead(403); res.end('{ error:The Amazon CloudFront distribution is configured to block access from your country }'); }
    else if (mode === 500) { res.writeHead(500); res.end('oops'); }
    else { res.writeHead(200); res.end('{"ok":1}'); }
  }, async (base) => {
    const h = new Health(); h.register('funding.binance', { label: 'Binance USD-M' }); h.setBlockedAlt('funding.binance', 'rates/marks via ws.binance (public WS)');
    await assert.rejects(fetchJson(base + '/fapi', { health: h, id: 'funding.binance' }), (e) => e.status === 451 && e.geoBlocked === true);
    let row = h.get('funding.binance');
    assert.equal(row.status, 'blocked'); assert.equal(row.blockedHttp, 451);
    assert.match(row.error, /^blocked from this host \(HTTP 451\) · rates\/marks via ws\.binance/);
    assert.equal(h.isBlocked('funding.binance', 30 * 60e3), true, 'no re-probe inside 30 min');
    assert.equal(h.isBlocked('funding.binance', 0), false, 're-probe once the window has passed');
    mode = 403; h.register('spot.bybit', { label: 'Bybit spot' });
    await assert.rejects(fetchJson(base + '/v5', { health: h, id: 'spot.bybit' })); assert.equal(h.get('spot.bybit').status, 'blocked'); assert.equal(h.get('spot.bybit').blockedHttp, 403);
    mode = 500; h.register('x', { label: 'x' }); await assert.rejects(fetchJson(base + '/x', { health: h, id: 'x' })); assert.equal(h.get('x').status, 'down', 'a real outage stays DOWN');
    mode = 200; await fetchJson(base + '/fapi', { health: h, id: 'funding.binance' }); row = h.get('funding.binance');
    assert.equal(row.status, 'live'); assert.equal(row.blockedHttp, null); assert.equal(row.error, null);
  });
});

test('providers: a provider whose only rows are blocked reports "blocked", not live or down', () => {
  const p = describe({ id: 'binance', name: 'Binance', category: 'cex', keyless: true, health: ['funding.binance'] }, {}, [{ id: 'funding.binance', status: 'blocked', latencyMs: null }]);
  assert.equal(p.status, 'blocked');
});

test('feeds: Binance spot uses the documented market-data host; blocked REST venues are skipped inside the re-probe window', async () => {
  const src = require('fs').readFileSync(require.resolve('../server/feeds/spot.js'), 'utf8');
  assert.match(src, /data-api\.binance\.vision/); assert.ok(!/api\.binance\.com\/api\/v3/.test(src));
  const { FundingFeed } = require('../server/feeds/funding');
  const h = new Health(); const f = new FundingFeed({ health: h, symbols: ['BTC'], pollMs: 60000 });
  h.blocked('funding.binance', 451); h.blocked('funding.bybit', 403);
  const real = global.fetch; let calls = 0; global.fetch = async () => { calls++; throw new Error('should not be called'); };
  try { await f.pollBinance(); await f.pollBybit(); } finally { global.fetch = real; }
  assert.equal(calls, 0, 'no request to a blocked venue inside the window');
  assert.match(h.get('funding.binance').error, /HTTP 451\) · rates\/marks via ws\.binance/);
});
