'use strict';
// Historical public data for the lab: OKX candles (swap or spot) and OKX funding-rate history. No keys.
const { fetchJson } = require('../lib/net');
const { fetchOkxBars } = require('../feeds/perp-bars');

async function fundingHistory(symbol, sinceT, { health } = {}) {
  let out = [], after = '';
  for (let page = 0; page < 10; page++) {
    const j = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${symbol}-USDT-SWAP&limit=100${after ? '&after=' + after : ''}`, { health, id: 'lab.okx', timeoutMs: 10000 });
    const rows = (j.data || []).map((r) => ({ t: +r.fundingTime, rate: +(r.realizedRate || r.fundingRate) }));
    if (!rows.length) break; out = out.concat(rows); after = rows[rows.length - 1].t;
    if (after <= sinceT) break;
  }
  return out.filter((r) => r.t >= sinceT).sort((a, b) => a.t - b.t);
}

async function history(cfg, { limit = 1000, health } = {}) {
  const symbol = cfg.market.symbol, bar = cfg.market.bar, market = cfg.kind === 'dca_grid' ? 'spot' : (cfg.market.instrument || 'swap');
  const bars = (await fetchOkxBars({ symbol, bar, limit, market, health, id: 'lab.okx' })).filter((b) => b.closed);
  const out = { bars, source: `OKX ${symbol}-USDT${market === 'swap' ? '-SWAP' : ''} ${bar} candles (public REST)` };
  if (market === 'swap' && bars.length) {
    try { const f = await fundingHistory(symbol, bars[0].t, { health }); const byT = bars; out.funding = f.map((r) => ({ ...r, mark: (byT.find((b) => b.t >= r.t) || byT[byT.length - 1]).o })); out.source += ' + OKX funding history'; } catch { out.fundingError = 'funding history unavailable'; }
  }
  if (cfg.kind === 'basis_carry') out.spotBars = (await fetchOkxBars({ symbol, bar, limit, market: 'spot', health, id: 'lab.okx' })).filter((b) => b.closed);
  return out;
}
module.exports = { history, fundingHistory };
