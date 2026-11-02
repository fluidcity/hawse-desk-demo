'use strict';
// Stage 5 data: CME micro futures (MES, MNQ) 1-minute bars.
//  LIVE: Tradovate DEMO API only (demo.tradovateapi.com auth + md-demo websocket), used only when all of
//        TRADOVATE_USERNAME/PASSWORD/APP_ID/CID/SECRET are set server-side. Credentials never leave the server.
//        Market data only; this module has no order endpoint at all.
//  SIMULATED: otherwise (or if auth/market data fails), an accelerated random-walk session replay.
//        Everything from it is labeled SIMULATED and its PnL is booked to the SIM book.
const { fetchJson } = require('../lib/net');

const SPECS = { MES: { pointValue: 5, tickSize: 0.25, simAnchor: 6800, simVolPerBar: 0.00045 }, MNQ: { pointValue: 2, tickSize: 0.25, simAnchor: 25000, simVolPerBar: 0.0006 } };
const SESSION_MIN = 390; // 09:30-16:00 ET
const MONTHS = [[3, 'H'], [6, 'M'], [9, 'U'], [12, 'Z']];

function thirdFriday(y, m) { const d = new Date(Date.UTC(y, m - 1, 1)); const first = (5 - d.getUTCDay() + 7) % 7 + 1; return Date.UTC(y, m - 1, first + 14); }
/** Pure: front quarterly contract code, rolling 8 days before the third-Friday expiry. */
function frontMonth(root, now = Date.now()) {
  const y0 = new Date(now).getUTCFullYear();
  for (const y of [y0, y0 + 1]) for (const [m, c] of MONTHS) if (thirdFriday(y, m) - 8 * 864e5 > now) return `${root}${c}${y % 10}`;
}
/** Pure: minutes since 09:30 America/New_York for a timestamp (may be negative / > 390 outside RTH). */
function etSessionMinute(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { min: (+p.hour % 24) * 60 + +p.minute - 570, weekday: p.weekday };
}

class TradovateFeed {
  constructor({ health, cfg, rng = Math.random }) {
    this.health = health; this.c = cfg; this.rng = rng;
    this.roots = ['MES', 'MNQ'];
    this.contracts = cfg.symbols && cfg.symbols.length ? cfg.symbols : this.roots.map((r) => frontMonth(r));
    this.mode = cfg.configured ? 'pending' : 'sim';
    this.note = cfg.configured ? 'authenticating (demo)' : 'TRADOVATE_APP_ID/CID/SECRET (+ username/password) not all set → SIMULATED';
    this.data = {}; for (const r of this.roots) this.data[r] = { bars: [], last: null, sessionId: 0 };
    health.register('tradovate.auth', { label: 'Tradovate demo auth', group: 'futures', staleMs: Infinity, note: cfg.configured ? 'demo.tradovateapi.com' : 'not configured' });
    health.register('tradovate.md', { label: 'Tradovate demo market data', group: 'futures', note: 'md-demo websocket' });
    health.register('futures.sim', { label: 'Simulated MES/MNQ session replay', group: 'futures', kind: 'mock', note: 'used when Tradovate is unavailable' });
  }
  spec(root) { return SPECS[root]; }
  start() { if (this.c.configured) this.connect().catch((e) => this.fallback('auth failed: ' + e.message)); else this.startSim(); }
  stop() { clearInterval(this.simT); clearInterval(this.hb); try { this.ws && this.ws.close(); } catch {} }
  fallback(why) { if (this.mode === 'sim') return; this.mode = 'sim'; this.note = why + ' → SIMULATED'; try { this.ws && this.ws.close(); } catch {} this.startSim(); }
  async connect() {
    const c = this.c;
    const j = await fetchJson('https://demo.tradovateapi.com/v1/auth/accesstokenrequest', { method: 'POST', health: this.health, id: 'tradovate.auth',
      body: { name: c.username, password: c.password, appId: c.appId, appVersion: c.appVersion, cid: c.cid, sec: c.secret, deviceId: 'hawse-paper-desk' } });
    if (!j.mdAccessToken) { const why = j.errorText || (j['p-ticket'] ? 'rate-limit p-ticket' : 'no mdAccessToken'); this.health.fail('tradovate.auth', why); throw new Error(why); }
    this.note = 'demo market data'; const ws = (this.ws = new WebSocket('wss://md-demo.tradovateapi.com/v1/websocket')); let reqId = 1; const charts = {}, reqRoot = {};
    const send = (ep, body) => { ws.send(`${ep}\n${++reqId}\n\n${body ? JSON.stringify(body) : ''}`); return reqId; };
    const watchdog = setTimeout(() => { if (this.mode !== 'live') this.fallback('no demo market data within 60s'); }, 60000);
    ws.onmessage = (ev) => {
      const s = String(ev.data);
      if (s === 'o') { ws.send(`authorize\n0\n\n${j.mdAccessToken}`); this.hb = setInterval(() => { try { ws.send('[]'); } catch {} }, 2500); return; }
      if (s[0] !== 'a') return;
      for (const m of JSON.parse(s.slice(1))) {
        if (m.i === 0 && m.s === 200) this.contracts.forEach((sym, k) => reqRoot[send('md/getChart', { symbol: sym, chartDescription: { underlyingType: 'MinuteBar', elementSize: 1, elementSizeUnit: 'UnderlyingUnits', withHistogram: false }, timeRange: { asMuchAsElements: 400 } })] = this.roots[k]);
        if (m.i && reqRoot[m.i] && m.d) { if (m.d.realtimeId) charts[m.d.realtimeId] = reqRoot[m.i]; if (m.d.historicalId) charts[m.d.historicalId] = reqRoot[m.i]; }
        if (m.e === 'chart') for (const ch of m.d.charts || []) {
          const root = charts[ch.id]; if (!root || !ch.bars) continue;
          const d = this.data[root];
          for (const b of ch.bars) {
            const t = Date.parse(b.timestamp), { min } = etSessionMinute(t); if (min < 0 || min >= SESSION_MIN) continue;
            const bar = { t, m: min, o: b.open, h: b.high, l: b.low, c: b.close }; const k = d.bars.findIndex((x) => x.t === t);
            if (k >= 0) d.bars[k] = bar; else d.bars.push(bar);
          }
          d.bars.sort((a, b) => a.t - b.t); const today = d.bars.length ? new Date(d.bars[d.bars.length - 1].t).toDateString() : null;
          d.bars = d.bars.filter((b) => new Date(b.t).toDateString() === today); d.last = d.bars.length ? d.bars[d.bars.length - 1].c : d.last; d.sessionId = today;
          this.health.ok('tradovate.md', 0); if (this.mode !== 'live') { this.mode = 'live'; clearTimeout(watchdog); }
        }
      }
    };
    ws.onerror = () => { this.health.fail('tradovate.md', 'websocket error'); this.fallback('websocket error'); };
    ws.onclose = () => { if (this.mode === 'live') this.fallback('websocket closed'); };
  }
  // ---- simulated session replay (accelerated: one 1-minute bar every simBarMs) ----
  startSim() {
    this.health.setKind('futures.sim', 'mock');
    for (const r of this.roots) { const d = this.data[r]; d.px = d.last || SPECS[r].simAnchor; d.bars = []; d.sessionId++; }
    clearInterval(this.simT); this.simT = setInterval(() => this.simStep(), this.c.simBarMs);
  }
  simStep() {
    for (const r of this.roots) {
      const d = this.data[r], sp = SPECS[r];
      if (d.bars.length >= SESSION_MIN) { d.bars = []; d.sessionId++; }
      const m = d.bars.length, vol = sp.simVolPerBar * (m < 30 ? 1.8 : 1); // opening range is more volatile
      const o = d.px; let px = o, h = o, l = o;
      for (let k = 0; k < 6; k++) { px *= 1 + vol / Math.sqrt(6) * gauss(this.rng); h = Math.max(h, px); l = Math.min(l, px); }
      const q = (x) => Math.round(x / sp.tickSize) * sp.tickSize;
      d.bars.push({ t: Date.now(), m, o: q(o), h: q(h), l: q(l), c: q(px), simulated: true }); d.px = px; d.last = q(px);
    }
    this.health.ok('futures.sim', 0);
  }
  session() { if (this.mode !== 'live') return `SIMULATED accelerated session (1 bar / ${this.c.simBarMs / 1000}s) · ${this.note}`; return `Tradovate DEMO · ${this.contracts.join(', ')} · RTH 09:30–16:00 ET`; }
  snapshot() { return { mode: this.mode, contracts: this.contracts, note: this.note }; }
}
function gauss(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
module.exports = { TradovateFeed, frontMonth, etSessionMinute, thirdFriday, SPECS, SESSION_MIN };
