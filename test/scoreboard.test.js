'use strict';
// Scoreboard card (public/scoreboard.js): pure summarizer + static page wiring. Display only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SB = require(path.join(ROOT, 'public', 'scoreboard.js'));
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const T0 = Date.UTC(2026, 9, 31, 16, 0, 0);
const min = (n) => T0 + n * 60e3;
function state() {
  return {
    strategies: [
      { id: 'funding', name: 'Funding Arb', armed: true, dataMode: 'live' },
      { id: 'orb', name: 'ORB', armed: false, dataMode: 'sim' },
      { id: 'gaps', name: 'DEX Gap', armed: true, dataMode: 'live' },
      { id: 'whale', name: 'Whale', armed: false, dataMode: 'live' },
    ],
    pnlBoard: { strategies: [
      { id: 'funding', real: { trades: 3, wins: 2, losses: 1, realized: 3.4 }, sim: null },
      { id: 'orb', real: { trades: 0 }, sim: { trades: 2, wins: 1, losses: 1, realized: -500 } },
      { id: 'gaps', real: { trades: 0 }, sim: null },
    ] },
    closed: [
      { t: min(0), strategy: 'funding', symbol: 'BNB-PERP', pnl: -1 },
      { t: min(1), strategy: 'funding', symbol: 'ETH-PERP', pnl: 2 },
      { t: min(3), strategy: 'funding', symbol: 'BTC-PERP', pnl: -1.5 },
      { t: min(5), strategy: 'funding', symbol: 'SOL-PERP', pnl: 2.9 },
      { t: min(4), strategy: 'orb', symbol: 'MES', pnl: -500, simulated: true },
    ],
    feeds: {
      kalshiH2: { stats: { settled: 3, wins: 2, losses: 1 }, pnl: { realizedCents: { total: -84 },
        curve: [{ at: min(10), tk: 'A', pnlCents: 5, cumCents: 5 }, { at: min(20), tk: 'B', pnlCents: -94, cumCents: -89 }, { at: min(30), tk: 'C', pnlCents: 5, cumCents: -84 }],
        unrealized: { open: [{ tk: 'D', entryAt: min(35), px: 0.95, unrealizedCents: 1 }] } } },
      kalshiH2v2: { stats: { v2: { settled: 1, wins: 1, losses: 0, totalNetCents: 5 }, curve: [{ at: min(10), tk: 'A', pnlCents: 5, cumCents: 5 }] }, signals: [{ tk: 'A', px: 0.94 }] },
      kalshiH2v3: { stats: {
        lines: [{ id: '3pct', start: 10000, balance: 9915, pnl: -85, settled: 2, wins: 1, losses: 1, open: 0,
          curve: [{ at: min(0), balance: 10000 }, { at: min(10), tk: 'A', balance: 10015 }, { at: min(20), tk: 'B', balance: 9915 }] }],
        compare: { table: [
          { at: min(4), tk: 'A', ya: 0.94, decision: 'take', result: 'yes', v1Cents: 5, v3: [{ id: '3pct', filled: 300, dollars: 282, fee: 3, pnl: 15 }] },
          { at: min(14), tk: 'B', ya: 0.93, decision: 'skip', result: 'no', v1Cents: -94, v3: [{ id: '3pct', filled: 100, dollars: 93, fee: 1, pnl: -100 }] },
        ] } } },
    },
  };
}

test('scoreboard: desk wins/losses come from the board; SIM never merges into REAL totals', () => {
  const m = SB.summarize(state());
  assert.deepStrictEqual([m.real.trades, m.real.wins, m.real.losses, m.real.net], [3, 2, 1, 3.4]);
  assert.deepStrictEqual([m.sim.trades, m.sim.wins, m.sim.losses, m.sim.net], [2, 1, 1, -500]);
  const orb = m.desk.find((t) => t.id === 'orb');
  assert.strictEqual(orb.real.trades, 0);
  assert.strictEqual(orb.data[0], 'SIM');
  assert.match(m.sentence, /1 strategy has SIM-only results \(not counted\)/);
});

test('scoreboard: losing desk trades are listed newest first; empty and untracked strategies say so', () => {
  const m = SB.summarize(state());
  const f = m.desk.find((t) => t.id === 'funding');
  assert.deepStrictEqual(f.losses.map((x) => x.what), ['BTC-PERP', 'BNB-PERP']);
  assert.deepStrictEqual(f.wins.map((x) => x.what), ['SOL-PERP', 'ETH-PERP']);
  const html = SB.render(m, { tz: 'America/Los_Angeles' });
  assert.match(html, /no trades yet/);
  assert.match(html, /not tracked/);
  const empty = SB.summarize({});
  assert.strictEqual(empty.real.trades, 0);
  assert.strictEqual(empty.h2.arms.length, 0);
  assert.doesNotThrow(() => SB.render(empty, {}));
});

test('scoreboard: H2 v1 rows newest first with cumulative ¢ before -> after and the open position', () => {
  const v1 = SB.h2Trades(state()).arms.find((a) => a.id === 'v1');
  assert.deepStrictEqual(v1.rows.filter((r) => r.status !== 'open').map((r) => r.tk), ['C', 'B', 'A']);
  const b = v1.rows.find((r) => r.tk === 'B');
  assert.deepStrictEqual([b.status, b.pnl, b.before, b.after, b.entryAt, b.entry.kind], ['loss', -94, 5, -89, min(14), 'ask']);
  const a = v1.rows.find((r) => r.tk === 'A');
  assert.deepStrictEqual([a.entry.px, a.entry.kind], [0.94, 'fill']);
  const d = v1.rows.find((r) => r.tk === 'D');
  assert.deepStrictEqual([d.status, d.before, d.after], ['open', -84, null]);
  assert.deepStrictEqual([v1.wins, v1.losses], [2, 1]);
});

test('scoreboard: H2 v3 balance before -> after in dollars; v2 lists skipped signals with what they would have done', () => {
  const arms = SB.h2Trades(state()).arms;
  const v3 = arms.find((a) => a.id === 'v3-3pct');
  assert.deepStrictEqual(v3.rows.map((r) => [r.tk, r.before, r.after, r.pnl, r.status]), [['B', 10015, 9915, -100, 'loss'], ['A', 10000, 10015, 15, 'win']]);
  assert.match(v3.rows[0].size, /^100 contracts/);
  const v2 = arms.find((a) => a.id === 'v2');
  assert.deepStrictEqual(v2.skipped.map((r) => [r.tk, r.would, r.status]), [['B', -94, 'skipped']]);
  assert.strictEqual(v2.rows.length, 1);
});

test('scoreboard: render marks losing rows and shows times with a zone', () => {
  const out = SB.render(SB.summarize(state()), { tz: 'America/Los_Angeles' });
  assert.match(out, /class="sb-tr[^"]*is-loss[^"]*" data-trade="v1\|B"/);
  assert.match(out, /LOSS/);
  assert.match(out, /P[DS]T/);
  assert.match(out, /not dollars/);
  assert.match(SB.when(min(20), 'America/Los_Angeles'), /09:20:00 PDT/);
  assert.ok(SB.tipLines(SB.h2Trades(state()).arms[0].rows.find((r) => r.tk === 'B'), 'America/Los_Angeles').join('\n').includes('−89'));
});

test('scoreboard: card sits between h2-chart-v3 and h2-v1 and loads before app.js', () => {
  const ids = [...html.matchAll(/data-card-id="([^"]+)"/g)].map((x) => x[1]);
  const i = ids.indexOf('scoreboard');
  assert.ok(i > 0, 'scoreboard card present');
  assert.strictEqual(ids[i - 1], 'h2-chart-v3');
  assert.strictEqual(ids[i + 1], 'h2-v1');
  assert.ok(html.indexOf('scoreboard.js') > 0 && html.indexOf('scoreboard.js') < html.indexOf('app.js'));
});
