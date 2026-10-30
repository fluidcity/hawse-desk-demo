/**
 * HAWSE UI reference — simulated paper desk.
 */
(() => {
  const PACES = [
    { id: 2, label: "Study", hint: "Study · slow queue · size 0.6×" },
    { id: 5, label: "Steady", hint: "Steady · normal queue · size 1.0×" },
    { id: 8, label: "Push", hint: "Push · retail queue · gross 1.15×" },
  ];
  const AGGS = [
    { id: 1, label: "Tiny" },
    { id: 2, label: "Small" },
    { id: 3, label: "Desk" },
    { id: 4, label: "Firm" },
    { id: 5, label: "Max" },
  ];
  const DDS = [
    { id: 0.15, label: "15%" },
    { id: 0.3, label: "30%" },
    { id: 0.45, label: "45%" },
  ];
  const STRATS = [
    { id: "cross", name: "Cross-venue arb", weight: 0.3 },
    { id: "tri", name: "Triangular", weight: 0.15 },
    { id: "basis", name: "Funding basis", weight: 0.35 },
    { id: "backrun", name: "Atomic backrun", weight: 0.1 },
    { id: "liq", name: "Liquidation snipe", weight: 0.1 },
  ];
  const VENUES = ["Binance", "Bybit", "Hyperliquid", "OKX"];
  const state = {
    equity: 1000, peak: 1000, dayPnl: 0, halted: false, pace: 5, agg: 3, dd: 0.3,
    elapsed: 0, curve: [1000],
    armed: { cross: true, tri: false, basis: true, backrun: false, liq: false },
    pnl: { cross: 0, tri: 0, basis: 0, backrun: 0, liq: 0 },
    trades: { cross: 0, tri: 0, basis: 0, backrun: 0, liq: 0 },
    tape: [], rates: {},
  };
  const $ = (id) => document.getElementById(id);
  const money = (n) =>
    (n < 0 ? "-$" : "$") +
    Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (n) =>
    `<span class="${n >= 0 ? "pos" : "neg"}">${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}</span>`;
  function pushTape(msg, pnl) {
    state.tape.unshift({ t: new Date().toLocaleTimeString("en-US", { hour12: false }), msg, pnl });
    state.tape = state.tape.slice(0, 40);
    renderTape();
  }
  function renderStrats() {
    const el = $("stratList");
    el.innerHTML = STRATS.map((s) => {
      const on = state.armed[s.id];
      return `<div class="strat ${on ? "armed" : ""}">
        <div class="strat-name">${s.name}</div>
        <button type="button" class="toggle ${on ? "on" : ""}" data-toggle="${s.id}">${on ? "ARMED" : "OFF"}</button>
        <div class="strat-meta">Weight ${(s.weight * 100).toFixed(0)}% · paper lane</div>
        <div class="strat-stats"><span>PnL ${signed(state.pnl[s.id])}</span><span class="muted">${state.trades[s.id]} prints</span></div>
      </div>`;
    }).join("");
    el.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-toggle");
        state.armed[id] = !state.armed[id];
        renderStrats();
        pushTape(`${state.armed[id] ? "Armed" : "Disarmed"} ${id}`, null);
      });
    });
  }
  function renderSeg(containerId, items, current, key, labelFn) {
    const el = $(containerId);
    el.innerHTML = items
      .map((it) => `<button type="button" class="${it.id === current ? "active" : ""}" data-v="${it.id}">${labelFn(it)}</button>`)
      .join("");
    el.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        state[key] = items.find((x) => String(x.id) === b.dataset.v).id;
        if (key === "pace") $("paceHint").textContent = PACES.find((p) => p.id === state.pace).hint;
        renderAllControls();
      });
    });
  }
  function renderAllControls() {
    renderSeg("paceSeg", PACES, state.pace, "pace", (p) => p.label);
    renderSeg("aggSeg", AGGS, state.agg, "agg", (a) => a.label);
    renderSeg("ddSeg", DDS, state.dd, "dd", (d) => d.label);
    $("paceHint").textContent = PACES.find((p) => p.id === state.pace).hint;
  }
  function renderMatrix() {
    const rates = state.rates;
    const body = VENUES.map((v) => {
      const r = rates[v] ?? 0;
      const apr = r * 3 * 365 * 100;
      return `<div class="row"><span>${v}</span><span class="mono ${r >= 0 ? "pos" : "neg"}">${(r * 100).toFixed(4)}%</span><span class="mono">${apr.toFixed(1)}% APR</span></div>`;
    }).join("");
    $("matrix").innerHTML = `<div class="row head"><span>Venue</span><span>8h</span><span>APR</span></div>` + body;
    const sorted = VENUES.map((v) => ({ v, r: rates[v] ?? 0 })).sort((a, b) => a.r - b.r);
    const long = sorted[0], short = sorted[sorted.length - 1];
    const netApr = (short.r - long.r) * 3 * 365 * 100 - 12;
    const pass = netApr > 15;
    $("bestBody").innerHTML = pass
      ? `Long <strong>${long.v}</strong> · Short <strong>${short.v}</strong><br/>Net ~${netApr.toFixed(1)}% APR after fees`
      : `No arm — net ~${netApr.toFixed(1)}% APR (floor 15%)`;
    $("armBest").disabled = !pass || state.halted;
    $("fundTs").textContent = new Date().toLocaleTimeString("en-US", { hour12: false });
  }
  function renderTape() {
    $("tape").innerHTML = state.tape
      .map((x) => `<div class="tape-item"><span class="muted">${x.t}</span><span>${x.msg}</span><span>${x.pnl == null ? "" : signed(x.pnl)}</span></div>`)
      .join("");
  }
  function renderEquity() {
    $("equity").textContent = money(state.equity);
    $("pnlDay").innerHTML = `${signed(state.dayPnl)} today`;
    $("goalFill").style.width = Math.max(0.15, Math.min(100, (state.equity / 1_000_000) * 100)) + "%";
    drawSpark();
  }
  function drawSpark() {
    const c = $("spark"), ctx = c.getContext("2d"), dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = 72;
    c.width = w * dpr; c.height = h * dpr; ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
    const data = state.curve.slice(-120);
    if (data.length < 2) return;
    const min = Math.min(...data) * 0.995, max = Math.max(...data) * 1.005, range = max - min || 1;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * (w - 4) + 2;
      const y = h - 6 - ((v - min) / range) * (h - 14);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    const up = data[data.length - 1] >= data[0];
    ctx.strokeStyle = up ? "#a3ff00" : "#ff2d55"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(w - 2, h); ctx.lineTo(2, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, up ? "rgba(163,255,0,0.18)" : "rgba(255,45,85,0.15)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fill();
  }
  function tickRates() {
    VENUES.forEach((v) => {
      const base = state.rates[v] ?? (Math.random() - 0.45) * 0.0004;
      state.rates[v] = base + (Math.random() - 0.5) * 0.00008;
    });
    renderMatrix();
  }
  function tickDesk() {
    if (state.halted) return;
    state.elapsed += 1;
    const paceMul = state.pace / 5, aggMul = state.agg / 3;
    let delta = 0;
    STRATS.forEach((s) => {
      if (!state.armed[s.id]) return;
      if (Math.random() > 0.35 * paceMul) return;
      const edge = (Math.random() - 0.28) * 0.35 * s.weight * aggMul * paceMul;
      const pnl = state.equity * edge * 0.01;
      state.pnl[s.id] += pnl; state.trades[s.id] += 1; delta += pnl;
      if (Math.abs(pnl) > 0.15) pushTape(`${s.name.split(" ")[0]} fill`, pnl);
    });
    state.equity += delta; state.dayPnl += delta;
    state.peak = Math.max(state.peak, state.equity);
    state.curve.push(state.equity);
    if (state.curve.length > 200) state.curve.shift();
    const dd = (state.peak - state.equity) / state.peak;
    if (dd >= state.dd) {
      state.halted = true;
      $("liveDot").className = "dot halted";
      $("haltBtn").textContent = "Halted";
      pushTape(`Breaker ${Math.round(state.dd * 100)}% — desk halted`, null);
    }
    renderEquity(); renderStrats();
  }
  function clock() {
    const s = state.elapsed;
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    $("clock").textContent = `${hh}:${mm}:${ss}`;
    $("regime").textContent = ["Quiet", "Quiet", "Dislocation", "Quiet", "Cascade"][Math.floor(s / 40) % 5];
  }
  $("haltBtn").addEventListener("click", () => {
    state.halted = !state.halted;
    $("liveDot").className = state.halted ? "dot halted" : "dot live";
    $("haltBtn").textContent = state.halted ? "Resume" : "Halt";
    pushTape(state.halted ? "Desk halted" : "Desk resumed", null);
  });
  $("resetBtn").addEventListener("click", () => {
    state.equity = 1000; state.peak = 1000; state.dayPnl = 0; state.halted = false;
    state.curve = [1000]; state.elapsed = 0;
    STRATS.forEach((s) => { state.pnl[s.id] = 0; state.trades[s.id] = 0; });
    $("liveDot").className = "dot live"; $("haltBtn").textContent = "Halt";
    pushTape("Paper reset → $1,000", null); renderEquity(); renderStrats();
  });
  $("armRec").addEventListener("click", () => {
    state.armed = { cross: true, tri: false, basis: true, backrun: false, liq: false };
    renderStrats(); pushTape("Armed recommended set", null);
  });
  $("armBest").addEventListener("click", () => {
    if (state.halted) return;
    const pnl = state.equity * 0.05 * (0.001 + Math.random() * 0.004);
    state.equity += pnl; state.dayPnl += pnl; state.pnl.basis += pnl; state.trades.basis += 1;
    state.curve.push(state.equity);
    pushTape("Armed best funding pair (paper)", pnl); renderEquity(); renderStrats();
  });
  VENUES.forEach((v, i) => { state.rates[v] = [-0.00005, 0.00012, 0.00035, 0.00008][i]; });
  renderStrats(); renderAllControls(); renderMatrix(); renderEquity();
  pushTape("Desk online · paper mode", null);
  setInterval(() => { clock(); tickRates(); }, 2000);
  setInterval(tickDesk, 900);
  window.addEventListener("resize", drawSpark);
})();
