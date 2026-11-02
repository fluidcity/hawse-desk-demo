'use strict';
// Strategy 1: funding carry v2 on REAL public funding rates (batch-1 §3 H2).
//  - perp↔perp: long the venue paying the lowest hourly funding, short the richest, equal notional.
//  - carry:     long spot + short perp on the SAME venue when that perp's funding is persistently positive.
// v2 over v1: persistence (≥ N consecutive positive observations), predicted next funding (Hyperliquid predictedFundings),
// a net-APR gate, an entry-basis gate, liquidity-capped size, a 2-print flip exit, a basis stop, and a forced paper close
// when a leg stays stale. Honest modeling kept from v1: hourly normalization, discrete settlement on each venue's own schedule,
// taker fees on all fills, spread+impact slippage, basis buffer, MTM of both legs, exit costs inside unrealized.
// Control: a not-booked naive-v1 shadow and a v2 shadow scored with identical accounting.
const fs = require('fs');
const path = require('path');
const { Strategy } = require('./base');
const F = require('../lib/fees');
const X = require('../lib/explain');
const S = require('./funding-score');

const H = 3600e3;
const DEPTH = { BTC: 5e6, ETH: 3e6, SOL: 1.5e6 }; // conservative top-of-book depth proxy (USD) when a venue gives no volume
const CARRY_VENUES = Object.freeze(['okx', 'binance', 'bybit']); // venues with both a spot book and a USDT perp (HL spot uses wrapped names; skipped)

class FundingArb extends Strategy {
  constructor(engine) {
    super(engine, { id: 'funding', name: 'Funding Arb', desc: 'Funding carry v2: cross-venue perp↔perp + same-venue spot↔perp (Binance · Bybit · OKX · Hyperliquid)', allocPct: 0.22, chains: ['CEX', 'Hyperliquid'] });
    const c = engine.cfg.funding;
    this.cfg = { persistPrints: 3, flipPrints: 2, minApr: 10, maxEntryBasisBps: 15, basisStopBps: 40, usePredicted: true, obsSec: 900, shadowV1: true, ...c,
      carry: { enabled: false, minNetBps: 15, holdHours: 72, ...(c.carry || {}) } };
    this.best = []; this.carryRows = []; this.v1Best = [];
    // Fixed rules (read by the logic below AND by explain(), so the explainer cannot drift).
    this.rules = { maxPositions: 2, maxPerSymbol: 1, maxHoldH: 72, sizePct: 0.45, evalMs: 15000, freshMs: 3 * 60e3, staleMs: 10 * 60e3, staleForceMs: 30 * 60e3,
      staleSlipX: 2, basisBufferFrac: 0.5, basisBufferBps: 2, liqFrac: 0.0005, spotFreshMs: 90e3, seriesLen: 6 };
    this.series = new Map(); this.lastObs = 0;
    this.shadow = { v1: new S.ShadowBook('naive v1'), v2: new S.ShadowBook('v2 rules') };
    this.closedLog = [];
    this.scoreFile = c.scoreFile !== undefined ? c.scoreFile : path.join(__dirname, '..', '..', 'data', 'funding', 'scoreboard.json');
    this.load();
  }
  get maxPositions() { return this.rules.maxPositions; }
  get maxHoldH() { return this.rules.maxHoldH; }
  feed() { return this.e.feeds.funding; }
  symbols() { return this.feed().symbols || this.cfg.symbols; }
  dataMode() { return new Set(this.feed().fresh().map((r) => r.venue)).size >= 2 ? 'live' : 'down'; }
  // ---- persistence of the scoreboard (closed records only; never secrets) ----
  load() { try { if (this.scoreFile && fs.existsSync(this.scoreFile)) { const j = JSON.parse(fs.readFileSync(this.scoreFile, 'utf8')); this.closedLog = j.booked || []; this.shadow.v1.closed = j.v1 || []; this.shadow.v2.closed = j.v2 || []; } } catch { /* corrupt file: start fresh */ } }
  save() { if (!this.scoreFile) return; try { fs.mkdirSync(path.dirname(this.scoreFile), { recursive: true }); fs.writeFileSync(this.scoreFile, JSON.stringify({ booked: this.closedLog.slice(-500), v1: this.shadow.v1.closed, v2: this.shadow.v2.closed })); } catch { /* read-only disk: scoreboard stays in memory */ } }
  // ---- quotes ----
  slipHalf(halfSpreadBps, symbol, notional, dayNtlVlm) { return F.slippageBps({ halfSpreadBps, notional, depthUsd: dayNtlVlm ? dayNtlVlm * this.rules.liqFrac : DEPTH[symbol] || 5e5 }); }
  slip(r, notional) { return this.slipHalf(r.halfSpreadBps, r.symbol, notional, r.dayNtlVlm); }
  spot(symbol, venue, maxAgeMs = this.rules.spotFreshMs) { return this.e.spotQuote ? this.e.spotQuote(symbol, venue, Math.min(maxAgeMs, 10000), maxAgeMs) : null; }
  /** Next-funding hourly rate: HL predictedFundings when available, else the venue's current rate (OKX's current rate IS its next-period forecast). */
  predHourly(r) {
    if (this.cfg.usePredicted) { const p = this.feed().predicted && this.feed().predicted(r.venue, r.symbol); if (p) return { h: p.hourly, src: 'predicted' }; }
    return { h: r.hourly, src: r.venue === 'okx' ? 'okx current (next-period)' : 'current' };
  }
  pairKey(sym, lo, hi) { return `${sym}|${lo}>${hi}`; }
  carryKey(sym, v) { return `${sym}|carry|${v}`; }
  push(key, v) { const s = this.series.get(key) || []; s.push(v); while (s.length > this.rules.seriesLen) s.shift(); this.series.set(key, s); }
  /** One persistence observation per pair / carry venue at most every obsSec, from fresh rows only. */
  sample(now) {
    if (now - this.lastObs < this.cfg.obsSec * 1000) return false; this.lastObs = now;
    for (const sym of this.symbols()) {
      const rows = this.feed().bySymbol(sym, this.rules.freshMs);
      for (const lo of rows) for (const hi of rows) if (lo !== hi) this.push(this.pairKey(sym, lo.venue, hi.venue), hi.hourly - lo.hourly);
      for (const r of rows) if (CARRY_VENUES.includes(r.venue)) this.push(this.carryKey(sym, r.venue), r.hourly);
    }
    return true;
  }
  // ---- signals ----
  evaluate(symbol, notional) {
    const rows = this.feed().bySymbol(symbol, this.rules.freshMs);
    if (rows.length < 2) return { symbol, mode: 'perp-perp', ok: false, reason: `${symbol}: need 2+ live venues (have ${rows.length})` };
    const c = this.cfg; let best = null, bestOk = null, v1 = null;
    for (const lo of rows) for (const hi of rows) {
      if (lo === hi) continue;
      const basisBps = Math.abs(hi.mark - lo.mark) / ((lo.mark + hi.mark) / 2) * 1e4;
      const edgeAt = (n) => F.fundingArbEdge({ shortHourly: hi.hourly, longHourly: lo.hourly, holdHours: c.holdHours, notional: n,
        shortFee: F.TAKER_FEES[hi.venue], longFee: F.TAKER_FEES[lo.venue], shortSlipBps: this.slip(hi, n), longSlipBps: this.slip(lo, n),
        basisBufferBps: basisBps * this.rules.basisBufferFrac + this.rules.basisBufferBps });
      const ev1 = edgeAt(notional);
      if (!v1 || ev1.net > v1.edge.net) v1 = { symbol, mode: 'perp-perp', long: lo, short: hi, edge: ev1, size: notional, basisBps, ok: ev1.netBps >= c.minNetBps };
      const size = S.liquidityCap(notional, [lo, hi], this.rules.liqFrac), edge = edgeAt(size);
      const ps = this.predHourly(hi), pl = this.predHourly(lo), series = this.series.get(this.pairKey(symbol, lo.venue, hi.venue)) || [];
      const cand = { symbol, mode: 'perp-perp', long: lo, short: hi, edge, size, basisBps, signedBasisBps: S.signedBasisBps(hi.mark, lo.mark), spreadApr: F.annualizedPct(hi.hourly - lo.hourly),
        persistCount: S.persistCount(series), predictedSpreadH: ps.h - pl.h, predSrc: ps.src === pl.src ? ps.src : `${ps.src}/${pl.src}`, aprPct: S.netAprPct({ net: edge.net, notional: size, holdH: c.holdHours }),
        holdH: c.holdHours, liqCapped: size < notional };
      cand.reason = this.gateReason(cand); cand.ok = !cand.reason;
      if (!best || edge.net > best.edge.net) best = cand;
      if (cand.ok && (!bestOk || cand.aprPct > bestOk.aprPct)) bestOk = cand;
    }
    if (v1 && !v1.ok) v1.reason = `${symbol}: v1 net ${v1.edge.netBps.toFixed(1)}bps < ${c.minNetBps}bps`;
    const out = bestOk || best; out.v1 = v1; return out;
  }
  gateReason(x) {
    const c = this.cfg, s = x.symbol;
    if (!(x.size > 0)) return `${s}: no size after liquidity cap`;
    if (x.persistCount < c.persistPrints) return `${s}: persistence ${x.persistCount}/${c.persistPrints} positive observations`;
    if (!S.predictedOk(x.predictedSpreadH)) return `${s}: predicted next spread ${(x.predictedSpreadH * 1e4).toFixed(3)}bp/h ≤ 0`;
    const minBps = x.mode === 'carry' ? c.carry.minNetBps : c.minNetBps;
    if (x.edge.netBps < minBps) return `${s}: net ${x.edge.netBps.toFixed(1)}bps/${x.holdH}h < ${minBps}bps after fees/slip/basis`;
    if (x.mode === 'perp-perp' && x.aprPct < c.minApr) return `${s}: net APR ${x.aprPct.toFixed(1)}% < ${c.minApr}% on gross notional`;
    if (x.mode === 'perp-perp' && x.basisBps > c.maxEntryBasisBps) return `${s}: entry basis ${x.basisBps.toFixed(1)}bps > ${c.maxEntryBasisBps}bps (mid-dislocation)`;
    return null;
  }
  evaluateCarry(symbol, notional) {
    const c = this.cfg; let best = null;
    for (const v of CARRY_VENUES) {
      const perp = this.feed().get(v, symbol), spot = this.spot(symbol, v);
      if (!perp || Date.now() - perp.ts > this.rules.freshMs || !spot) continue;
      const size = S.liquidityCap(notional, [perp], this.rules.liqFrac);
      const basisSigned = (perp.mark - spot.mid) / spot.mid * 1e4;
      const edge = F.fundingArbEdge({ shortHourly: perp.hourly, longHourly: 0, holdHours: c.carry.holdHours, notional: size, shortFee: F.TAKER_FEES[v], longFee: F.SPOT_TAKER_FEES[v],
        shortSlipBps: this.slip(perp, size), longSlipBps: this.slipHalf(spot.halfSpreadBps, symbol, size), basisBufferBps: Math.abs(basisSigned) * this.rules.basisBufferFrac + this.rules.basisBufferBps });
      const pr = this.predHourly(perp), series = this.series.get(this.carryKey(symbol, v)) || [];
      const cand = { symbol, mode: 'carry', venue: v, long: { ...spot, kind: 'spot', venue: v, mark: spot.mid }, short: perp, edge, size, basisBps: Math.abs(basisSigned), signedBasisBps: basisSigned,
        spreadApr: F.annualizedPct(perp.hourly), persistCount: S.persistCount(series), predictedSpreadH: pr.h, predSrc: pr.src,
        aprPct: S.netAprPct({ net: edge.net, notional: size, holdH: c.carry.holdHours }), holdH: c.carry.holdHours, liqCapped: size < notional };
      cand.reason = this.gateReason(cand); cand.ok = !cand.reason;
      if (!best || (cand.ok && !best.ok) || (cand.ok === best.ok && edge.net > best.edge.net)) best = cand;
    }
    return best;
  }
  candidates() {
    return [...this.best, ...this.carryRows].filter((b) => b.ok).sort((a, b) => b.aprPct - a.aprPct);
  }
  tick(now) {
    this.sample(now);
    this.manage(now);
    if (now - this.lastEval < this.rules.evalMs) return; this.lastEval = now;
    const notional = Math.max(0, this.sleeve() * this.rules.sizePct) || 1000;
    this.best = this.symbols().map((s) => this.evaluate(s, notional)).filter(Boolean).sort((a, b) => (b.ok - a.ok) || ((b.edge ? b.edge.netBps : -1e9) - (a.edge ? a.edge.netBps : -1e9)));
    this.carryRows = this.cfg.carry.enabled ? this.symbols().map((s) => this.evaluateCarry(s, notional)).filter(Boolean).sort((a, b) => (b.ok - a.ok) || (b.edge.netBps - a.edge.netBps)) : [];
    this.v1Best = this.best.map((b) => b.v1).filter(Boolean).sort((a, b) => b.edge.netBps - a.edge.netBps);
    this.runShadows(now);
    if (!this.armed) return;
    if (this.positions.length >= this.maxPositions) return this.skip('max concurrent pairs reached', `${this.maxPositions}`);
    const cand = this.candidates().find((b) => !this.positions.some((p) => p.symbol === b.symbol) && !(this.e.symbolHeld && this.e.symbolHeld(b.symbol, this.id)));
    if (!cand) { const top = this.best[0]; return this.skip('no pair clears v2 gates', top && top.reason ? top.reason : ''); }
    const g = this.gate(false); if (!g.ok) return this.skip('risk gate: ' + g.reason);
    this.open(cand, now);
  }
  expOf(c) { return { grossPerH: c.edge.grossFunding / c.holdH, costs: c.edge.fees + c.edge.slippage + c.edge.basisBuffer, holdH: c.holdH }; }
  open(c, now) {
    const b = this.e.broker, n = c.size, carry = c.mode === 'carry';
    const qty = n / ((c.long.mark + c.short.mark) / 2);
    const longFee = carry ? F.SPOT_TAKER_FEES[c.venue] : F.TAKER_FEES[c.long.venue];
    const longSlip = carry ? this.slipHalf(c.long.halfSpreadBps, c.symbol, n) : this.slip(c.long, n);
    const lf = b.fill({ strategy: this.id, venue: carry ? c.venue + ' spot' : c.long.venue, symbol: c.symbol, side: 'buy', qty, price: c.long.mark, feeRate: longFee, slipBps: longSlip });
    const sf = b.fill({ strategy: this.id, venue: c.short.venue, symbol: c.symbol, side: 'sell', qty, price: c.short.mark, feeRate: F.TAKER_FEES[c.short.venue], slipBps: this.slip(c.short, n) });
    this.e.ledger.charge(this.id, { amount: lf.fee + sf.fee, simulated: false });
    const leg = (f, r, side, kind) => ({ venue: r.venue, kind, side, qty, entry: f.price, mark: r.mark, halfSpreadBps: r.halfSpreadBps, rate: kind === 'perp' ? r.rate : 0,
      intervalH: r.intervalH, nextFT: kind === 'perp' ? r.nextFundingTime : null, funding: 0, settlements: 0 });
    const p = { id: lf.id, mode: c.mode, symbol: c.symbol, openedAt: now, notional: n, legs: [leg(lf, c.long, 'long', carry ? 'spot' : 'perp'), leg(sf, c.short, 'short', 'perp')],
      entryFees: lf.fee + sf.fee, expected: c.edge, exp: this.expOf(c), expectedNetBps: c.edge.netBps, persistCount: c.persistCount, predictedSpreadH: c.predictedSpreadH,
      entrySignedBasisBps: c.signedBasisBps, aprPct: c.aprPct, holdH: c.holdH, key: carry ? this.carryKey(c.symbol, c.venue) : this.pairKey(c.symbol, c.long.venue, c.short.venue), mtm: 0, staleSince: null };
    this.positions.push(p);
    const desc = carry ? `carry long ${c.venue} spot / short ${c.venue} perp` : `long ${c.long.venue} / short ${c.short.venue}`;
    this.fillLog(`OPEN ${c.symbol} ${desc} · $${n.toFixed(0)}/leg · est ${c.edge.netBps.toFixed(1)}bps/${c.holdH}h (${c.aprPct.toFixed(1)}% APR) · persist ${c.persistCount}`, -p.entryFees, false);
  }
  legQuote(p, l, maxAgeMs) {
    if (l.kind === 'spot') { const q = this.spot(p.symbol, l.venue, maxAgeMs); return q && { ...q, mark: q.mid }; }
    const r = this.feed().get(l.venue, p.symbol); return r && Date.now() - r.ts <= maxAgeMs ? r : null;
  }
  /** v2 exit rules shared by the booked position and the v2 shadow. Returns {why, byStop} or null. */
  exitReason(p, now, marks) {
    const c = this.cfg, heldH = (now - p.openedAt) / H, [L, Sh] = marks;
    const flips = S.flipCount(this.series.get(p.key));
    if (flips >= c.flipPrints) return { why: `spread flipped on ${flips} consecutive observations` };
    const perp = this.feed().get(p.legs[1].venue, p.symbol);
    if (perp) {
      const ps = this.predHourly(perp).h, pl = p.mode === 'carry' ? 0 : (() => { const lr = this.feed().get(p.legs[0].venue, p.symbol); return lr ? this.predHourly(lr).h : null; })();
      if (pl != null && ps - pl < 0) return { why: 'predicted next funding spread negative' };
    }
    const move = S.signedBasisBps(Sh.mark, L.mark) - p.entrySignedBasisBps;
    if (move > c.basisStopBps) return { why: `basis stop: moved ${move.toFixed(1)}bps against (> ${c.basisStopBps})`, byStop: true };
    const maxH = p.mode === 'carry' ? c.carry.holdHours : this.maxHoldH;
    if (heldH >= maxH) return { why: `max hold ${maxH}h` };
    return null;
  }
  manage(now) {
    let unreal = 0;
    for (const p of [...this.positions]) {
      let fresh = true, mtm = 0, exitCost = 0; const marks = [];
      for (const l of p.legs) {
        const r = this.legQuote(p, l, this.rules.staleMs);
        if (!r) { fresh = false; marks.push({ mark: l.mark }); mtm += (l.side === 'long' ? 1 : -1) * ((l.mark ?? l.entry) - l.entry) * l.qty; continue; }
        if (l.kind === 'perp') {
          // Discrete funding settlement at the venue's own schedule, using the last rate known before settlement.
          if (l.nextFT && now >= l.nextFT && l.nextFT > p.openedAt) {
            const pay = F.fundingPayment({ side: l.side, notional: l.qty * r.mark, rate: l.rate });
            this.e.ledger.cashflow(this.id, { amount: pay, simulated: false });
            l.funding += pay; l.settlements++;
            this.e.tape.push({ kind: 'fill', strategy: this.id, msg: `FUNDING ${p.symbol} ${l.venue} ${l.side} @ ${(l.rate * 100).toFixed(4)}%`, pnl: pay, simulated: false });
            l.nextFT = r.nextFundingTime && r.nextFundingTime > now ? r.nextFundingTime : l.nextFT + l.intervalH * H;
          } else if (r.nextFundingTime && r.nextFundingTime > now) l.nextFT = l.nextFT && l.nextFT > now ? l.nextFT : r.nextFundingTime;
          l.rate = r.rate; l.hourly = r.hourly;
        }
        l.mark = r.mark; l.halfSpreadBps = r.halfSpreadBps; marks.push(r);
        mtm += (l.side === 'long' ? 1 : -1) * (r.mark - l.entry) * l.qty;
        exitCost += l.qty * r.mark * (this.legFee(p, l) + this.slipHalf(r.halfSpreadBps, p.symbol, p.notional, r.dayNtlVlm) / 1e4);
      }
      p.mtm = mtm; p.exitCost = exitCost; p.funding = p.legs.reduce((a, l) => a + l.funding, 0);
      if (!fresh) {
        p.stale = true; p.staleSince = p.staleSince || now;
        if (now - p.staleSince > this.rules.staleForceMs) { this.close(p, `leg stale > ${this.rules.staleMs / 60e3} min for > ${this.rules.staleForceMs / 60e3} min: forced paper close at last mark + ${this.rules.staleSlipX}× slippage`, { force: true }); continue; }
        unreal += mtm - exitCost; continue;
      }
      p.stale = false; p.staleSince = null;
      const ex = this.exitReason(p, now, marks);
      if (ex) this.close(p, ex.why, { byStop: ex.byStop }); else unreal += mtm - exitCost;
    }
    this.e.ledger.setUnrealized(this.id, { real: unreal });
  }
  legFee(p, l) { return l.kind === 'spot' ? F.SPOT_TAKER_FEES[l.venue] : F.TAKER_FEES[l.venue]; }
  close(p, why, { force = false, byStop = false } = {}) {
    let pricePnl = 0, fees = 0; const now = Date.now();
    for (const l of p.legs) {
      const r = force ? null : this.legQuote(p, l, this.rules.staleMs);
      const mark = r ? r.mark : l.mark ?? l.entry, half = r ? r.halfSpreadBps : l.halfSpreadBps || 0;
      const slip = this.slipHalf(half, p.symbol, p.notional, r && r.dayNtlVlm) * (force ? this.rules.staleSlipX : 1);
      const f = this.e.broker.fill({ strategy: this.id, venue: l.kind === 'spot' ? l.venue + ' spot' : l.venue, symbol: p.symbol, side: l.side === 'long' ? 'sell' : 'buy', qty: l.qty, price: mark, feeRate: this.legFee(p, l), slipBps: slip });
      pricePnl += (l.side === 'long' ? 1 : -1) * (f.price - l.entry) * l.qty; fees += f.fee;
    }
    const booked = pricePnl - fees, total = booked + p.funding - p.entryFees, heldH = (now - p.openedAt) / H;
    this.e.ledger.close(this.id, { pnl: booked, total, fees: fees + p.entryFees, simulated: false, meta: { symbol: p.symbol, why, mode: p.mode } });
    this.positions = this.positions.filter((x) => x !== p);
    this.closedLog.push({ symbol: p.symbol, mode: p.mode, openedAt: p.openedAt, closedAt: now, notional: p.notional, realized: total, expected: S.expectedAtHeld(p.exp, heldH),
      realizedNetBps: (total / p.notional) * 1e4, expectedNetBps: p.expectedNetBps, byStop: byStop || force, why, funding: p.funding, basis: pricePnl });
    this.save();
    this.fillLog(`CLOSE ${p.symbol} ${p.mode} (${why}) · funding ${p.funding.toFixed(2)} · basis ${pricePnl.toFixed(2)} · fees ${(fees + p.entryFees).toFixed(2)}`, total, false);
  }
  // ---- shadows: not booked, same real quotes, identical accounting for v1 and v2 ----
  shadowOpen(book, c, now) {
    const carry = c.mode === 'carry', n = c.size, qty = n / ((c.long.mark + c.short.mark) / 2);
    book.open({ symbol: c.symbol, mode: c.mode, openedAt: now, notional: n, entryCost: (c.edge.fees + c.edge.slippage) / 2, exp: this.expOf(c), expectedNetBps: c.edge.netBps,
      entrySignedBasisBps: c.signedBasisBps ?? S.signedBasisBps(c.short.mark, c.long.mark), key: carry ? this.carryKey(c.symbol, c.venue) : this.pairKey(c.symbol, c.long.venue, c.short.venue),
      legs: [{ venue: c.long.venue, kind: carry ? 'spot' : 'perp', side: 'long', qty, entry: c.long.mark }, { venue: c.short.venue, kind: 'perp', side: 'short', qty, entry: c.short.mark }] });
  }
  shadowExitCost(p) { return p.legs.reduce((a, l) => a + l.qty * (l.mark ?? l.entry) * (this.legFee(p, l) + this.slipHalf(l.halfSpreadBps || 0, p.symbol, p.notional) / 1e4), 0); }
  runShadows(now) {
    const q = (p, l) => { const r = this.legQuote(p, l, this.rules.staleMs); if (r) l.halfSpreadBps = r.halfSpreadBps; return r; };
    const { v1, v2 } = this.shadow; let changed = false;
    if (this.cfg.shadowV1) {
      v1.mark(now, q);
      for (const p of [...v1.positions]) {
        const L = this.feed().get(p.legs[0].venue, p.symbol), Sh = this.feed().get(p.legs[1].venue, p.symbol); if (!L || !Sh) continue;
        const why = Sh.hourly - L.hourly <= 0 ? 'funding spread flipped (1 print)' : (now - p.openedAt) / H >= this.maxHoldH ? `max hold ${this.maxHoldH}h` : null;
        if (why) { v1.close(p, now, why, { exitCost: this.shadowExitCost(p) }); changed = true; }
      }
      for (const c of this.v1Best) if (c.ok && v1.positions.length < this.maxPositions && !v1.holds(c.symbol)) this.shadowOpen(v1, c, now);
    }
    v2.mark(now, q);
    for (const p of [...v2.positions]) {
      const marks = p.legs.map((l) => ({ mark: l.mark ?? l.entry }));
      const ex = this.exitReason(p, now, marks);
      if (ex) { v2.close(p, now, ex.why, { exitCost: this.shadowExitCost(p), byStop: ex.byStop }); changed = true; }
    }
    for (const c of this.candidates()) if (v2.positions.length < this.maxPositions && !v2.holds(c.symbol)) this.shadowOpen(v2, c, now);
    if (changed) this.save();
  }
  posView(p) {
    return { symbol: p.symbol, mode: p.mode, openedAt: p.openedAt, notional: p.notional, legs: p.legs.map(({ venue, kind, side, entry, mark, rate, nextFT, funding }) => ({ venue, kind, side, entry, mark, rate, nextFT, funding })),
      funding: p.funding, mtm: p.mtm, exitCost: p.exitCost, entryFees: p.entryFees, stale: p.stale, persistCount: p.persistCount, predictedSpreadH: p.predictedSpreadH, expectedNetBps: p.expectedNetBps, aprPct: p.aprPct };
  }
  row(b) {
    return { symbol: b.symbol, mode: b.mode, ok: !!b.ok, reason: b.reason || null, long: b.long && (b.mode === 'carry' ? b.long.venue + ' spot' : b.long.venue), short: b.short && b.short.venue,
      netBps: b.edge ? b.edge.netBps : null, spreadApr: b.spreadApr ?? null, basisBps: b.basisBps ?? null, aprPct: b.aprPct ?? null, persistCount: b.persistCount ?? null,
      predictedApr: typeof b.predictedSpreadH === 'number' ? F.annualizedPct(b.predictedSpreadH) : null, predSrc: b.predSrc || null, holdH: b.holdH || null, liqCapped: !!b.liqCapped,
      gross: b.edge ? b.edge.grossFunding : null, costs: b.edge ? b.edge.fees + b.edge.slippage + b.edge.basisBuffer : null };
  }
  view() {
    const sleeve = this.alloc || this.sleeve(), now = Date.now();
    return { best: this.best.slice(0, 8).map((b) => this.row(b)), carry: this.carryRows.slice(0, 6).map((b) => this.row(b)), holdHours: this.cfg.holdHours, minNetBps: this.cfg.minNetBps,
      gates: { persistPrints: this.cfg.persistPrints, flipPrints: this.cfg.flipPrints, minApr: this.cfg.minApr, maxEntryBasisBps: this.cfg.maxEntryBasisBps, basisStopBps: this.cfg.basisStopBps,
        obsSec: this.cfg.obsSec, usePredicted: this.cfg.usePredicted, carry: this.cfg.carry },
      score: { plan: S.PLAN, booked: S.summarize(this.closedLog, { sleeve, now }), shadowV1: this.cfg.shadowV1 ? S.summarize(this.shadow.v1.closed, { sleeve, now }) : null,
        shadowV2: S.summarize(this.shadow.v2.closed, { sleeve, now }), shadowOpen: { v1: this.shadow.v1.positions.length, v2: this.shadow.v2.positions.length } } };
  }
  explain() {
    const c = this.cfg, r = this.rules, P = S.PLAN;
    return X.explanation(`Two ways to earn funding with price risk hedged out. Perp↔perp: long the coin's perpetual where funding is cheapest and short it
      where funding is richest, so price moves roughly cancel and the pair earns the difference. Cash-and-carry: buy spot and short the perp on the
      same venue while that perp keeps paying shorts. v2 only acts on a spread that has persisted, that the venues' own next-funding forecast agrees
      with, and that beats every fee, slippage and a basis buffer.`, {
      Markets: [`Perpetual futures on ${X.list(Object.keys(F.TAKER_FEES).filter((v) => !/spot/i.test(v)))}`, `Coins: ${X.list(c.symbols)}${c.hlTopOi > 0 ? ` plus the top ${c.hlTopOi} Hyperliquid perps by open interest` : ''}`,
        c.carry.enabled ? `Carry mode: spot books on ${X.list(CARRY_VENUES)} (public REST every ${X.num((c.carry.spotPollMs || 30000) / 1000, 0)} s, or the websocket when fresh)` : 'Carry mode: off (CARRY_ENABLED=false)'],
      Signal: [`Every ${X.num(r.evalMs / 1000, 0)} s, each coin with fresh funding (< ${X.num(r.freshMs / 60e3, 0)} min old) on 2+ venues is scored for every venue pair`,
        `Net edge = funding spread over ${X.hours(c.holdHours)} − 4 taker fees − slippage on both legs − basis buffer (${X.num(r.basisBufferFrac * 100, 0)}% of the price gap + ${X.num(r.basisBufferBps)} bp)`,
        `Persistence: one observation of every pair's hourly spread per ${X.num(c.obsSec / 60, 0)} min; the spread must be positive on the last ${c.persistPrints} in a row`,
        c.usePredicted ? 'Predicted funding: Hyperliquid\'s predictedFundings (next rate for Hyperliquid, Binance and Bybit, one call per poll) must keep the spread positive; OKX uses its current-period rate, which is its forecast' : 'Predicted funding: off (uses the last rate)'],
      Entry: [`Perp↔perp: net ≥ ${X.num(c.minNetBps)} bp per ${X.hours(c.holdHours)} AND net APR ≥ ${X.pct(c.minApr, 0)} on gross notional (both legs) AND price gap between legs ≤ ${X.num(c.maxEntryBasisBps)} bp`,
        c.carry.enabled ? `Carry: same persistence and forecast rules on that venue's funding, and net ≥ ${X.num(c.carry.minNetBps)} bp over ${X.hours(c.carry.holdHours)} after spot + perp taker fees on entry and exit` : 'Carry: disabled',
        `Size: ${X.pct(r.sizePct * 100, 0)} of the sleeve per leg, cut so a venue's daily volume × ${r.liqFrac} covers 2× the leg (when the venue reports volume)`,
        `One trade per coin (also across the Perp Basis strategy), at most ${r.maxPositions} open; best net APR first`],
      Exit: [`Spread ≤ 0 on ${c.flipPrints} consecutive observations (v1 exited on one)`, 'Predicted next funding spread turns negative',
        `Basis stop: the price gap moves more than ${X.num(c.basisStopBps)} bp against the position`, `Max hold ${X.hours(r.maxHoldH)} (carry ${X.hours(c.carry.holdHours)}); re-entry must pass every rule again`,
        `A leg older than ${X.num(r.staleMs / 60e3, 0)} min is stale; stale for > ${X.num(r.staleForceMs / 60e3, 0)} min forces a paper close at the last mark with ${r.staleSlipX}× slippage`,
        'Funding is credited at each venue\'s own settlement time'],
      Risk: X.deskRisk(this),
      Data: [X.feesLine(), 'All inputs are real public market data (no keys). Geo-blocked venues show DOWN and are never filled in with fake data',
`Realized net (funding − fees − slippage − basis P&L) vs the expected net at entry, pro-rated to the actual hold`,
        `Pass after ≥ ${P.minClosed} closed and ≥ ${P.minDays} days: realized/expected ≥ ${P.passRatio}, net APR ≥ ${P.passApr}%, no pair loss > ${P.maxPairLossPct}% of sleeve, max DD < ${P.maxDdPct}%. Fail: ratio < ${P.failRatio} or APR < ${P.failApr}%`,
        'Control: a naive-v1 shadow (no persistence, no forecast, no APR/basis gates, exits on one flip) and a v2 shadow run side by side on the same real quotes. Neither is booked; both accrue funding continuously, an approximation'] });
  }
}
module.exports = { FundingArb, CARRY_VENUES };
