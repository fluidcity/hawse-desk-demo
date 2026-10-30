(() => {
  const PACE_LABELS = {
    1: ["Crawl", "Very slow · size 0.4×"],
    2: ["Study", "Study · size 0.6×"],
    3: ["Easy", "Light queue · size 0.75×"],
    4: ["Calm", "Calm · size 0.9×"],
    5: ["Steady", "Normal queue · size 1.0×"],
    6: ["Active", "Active · size 1.1×"],
    7: ["Push", "Retail queue · size 1.2×"],
    8: ["Hot", "Hot · size 1.3×"],
    9: ["Aggressive", "Aggressive · size 1.4×"],
    10: ["Max", "Max throughput · size 1.5×"],
  };
  const AGG_LABELS = {
    1: ["Tiny", "Micro clips"],
    2: ["Small", "Small clips"],
    3: ["Desk", "Balanced clip size"],
    4: ["Firm", "Firm size"],
    5: ["Max", "Full clip"],
  };
  const STRATS = [
    { id: "cross", name: "Cross-venue arb", weight: 0.3 },
    { id: "tri", name: "Triangular", weight: 0.15 },
    { id: "basis", name: "Funding basis", weight: 0.35 },
    { id: "backrun", name: "Atomic backrun", weight: 0.1 },
    { id: "liq", name: "Liquidation snipe", weight: 0.1 },
  ];
  const VENUES = ["Binance", "Bybit", "Hyperliquid", "OKX"];
  const S = {
    equity: 1000, peak: 1000, dayPnl: 0, halted: false,
    pace: 5, agg: 3, dd: 0.3, elapsed: 0, curve: [1000],
    armed: { cross: true, tri: false, basis: true, backrun: false, liq: false },
    pnl: { cross: 0, tri: 0, basis: 0, backrun: 0, liq: 0 },
    trades: { cross: 0, tri: 0, basis: 0, backrun: 0, liq: 0 },
    tape: [], rates: {},
  };
  const $ = (id) => document.getElementById(id);
  const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (n) => `<span class="${n >= 0 ? "pos" : "neg"}">${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}</span>`;
  function pushTape(msg, pnl) {
    S.tape.unshift({ t: new Date().toLocaleTimeString("en-US", { hour12: false }), msg, pnl });
    S.tape = S.tape.slice(0, 36);
    renderTape();
  }
  function renderStrats() {
    const el = $("stratList");
    el.innerHTML = STRATS.map((s) => {
      const on = S.armed[s.id];
      return `<div class="strat ${on ? "armed" : ""}">
        <div class="strat-name">${s.name}</div>
        <button type="button" class="toggle ${on ? "on" : ""}" data-id="${s.id}">${on ? "ARMED" : "OFF"}</button>
        <div class="strat-meta">Weight ${(s.weight * 100).toFixed(0)}% · paper lane</div>
        <div class="strat-stats"><span>PnL ${signed(S.pnl[s.id])}</span><span style="color:var(--muted)">${S.trades[s.id]} prints</span></div>
      </div>`;
    }).join("");
    el.querySelectorAll("[data-id]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        S.armed[id] = !S.armed[id];
        renderStrats();
        pushTape((S.armed[id] ? "Armed " : "Disarmed ") + id, null);
      };
    });
  }
  function renderSliders() {
    const p = PACE_LABELS[S.pace];
    $("paceVal").textContent = p[0];
    $("paceHint").textContent = p[1];
    const a = AGG_LABELS[S.agg];
    $("aggVal").textContent = a[0];
    $("aggHint").textContent = a[1];
    $("ddVal").textContent = Math.round(S.dd * 100) + "%";
  }
  function renderMatrix() {
    const body = VENUES.map((v) => {
      const r = S.rates[v] ?? 0;
      const apr = r * 3 * 365 * 100;
      return `<div class="m-row"><span>${v}</span><span class="${r >= 0 ? "pos" : "neg"}">${(r * 100).toFixed(4)}%</span><span>${apr.toFixed(1)}% APR</span></div>`;
    }).join("");
    $("matrix").innerHTML = `<div class="m-row head"><span>Venue</span><span>8h</span><span>APR</span></div>` + body;
    const sorted = VENUES.map((v) => ({ v, r: S.rates[v] ?? 0 })).sort((a, b) => a.r - b.r);
    const L = sorted[0], H = sorted[sorted.length - 1];
    const net = (H.r - L.r) * 3 * 365 * 100 - 12;
    const pass = net > 15;
    $("bestBody").innerHTML = pass
      ? `Long <strong>${L.v}</strong> · Short <strong>${H.v}</strong><br/>Net ~${net.toFixed(1)}% APR after fees`
      : `No arm — net ~${net.toFixed(1)}% APR (floor 15%)`;
    $("armBest").disabled = !pass || S.halted;
    $("fundTs").textContent = new Date().toLocaleTimeString("en-US", { hour12: false });
  }
  function renderTape() {
    $("tape").innerHTML = S.tape.map((x) =>
      `<div class="tape-row"><span style="color:var(--muted)">${x.t}</span><span>${x.msg}</span><span>${x.pnl == null ? "" : signed(x.pnl)}</span></div>`
    ).join("");
  }
  function renderEquity() {
    $("equity").textContent = money(S.equity);
    $("pnlDay").innerHTML = `${signed(S.dayPnl)} today`;
    $("goalFill").style.width = Math.max(0.12, Math.min(100, (S.equity / 1e6) * 100)) + "%";
    drawChart();
  }
  function drawChart() {
    const c = $("chart"), ctx = c.getContext("2d"), dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = 110;
    c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const data = S.curve.slice(-160);
    if (data.length < 2) return;
    const min = Math.min(...data) * 0.997, max = Math.max(...data) * 1.003, range = max - min || 1, pad = 4;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad + (i / (data.length - 1)) * (w - pad * 2);
      const y = h - 10 - ((v - min) / range) * (h - 22);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    const lastX = pad + (w - pad * 2);
    ctx.lineTo(lastX, h); ctx.lineTo(pad, h); ctx.closePath();
    const up = data[data.length - 1] >= data[0];
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, up ? "rgba(184,255,46,0.22)" : "rgba(255,61,90,0.18)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad + (i / (data.length - 1)) * (w - pad * 2);
      const y = h - 10 - ((v - min) / range) * (h - 22);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = up ? "#b8ff2e" : "#ff3d5a"; ctx.lineWidth = 2; ctx.lineJoin = "round";
    ctx.shadowColor = up ? "rgba(184,255,46,0.45)" : "rgba(255,61,90,0.4)"; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
    const last = data[data.length - 1];
    const lx = pad + (w - pad * 2);
    const ly = h - 10 - ((last - min) / range) * (h - 22);
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = up ? "#b8ff2e" : "#ff3d5a"; ctx.fill();
  }
  function tickRates() {
    VENUES.forEach((v) => {
      const base = S.rates[v] ?? (Math.random() - 0.45) * 0.0004;
      S.rates[v] = base + (Math.random() - 0.5) * 0.00008;
    });
    renderMatrix();
  }
  function tickDesk() {
    if (S.halted) return;
    S.elapsed += 1;
    const paceMul = S.pace / 5, aggMul = S.agg / 3;
    let delta = 0;
    STRATS.forEach((s) => {
      if (!S.armed[s.id]) return;
      if (Math.random() > 0.32 * paceMul) return;
      const edge = (Math.random() - 0.27) * 0.32 * s.weight * aggMul * paceMul;
      const pnl = S.equity * edge * 0.01;
      S.pnl[s.id] += pnl; S.trades[s.id] += 1; delta += pnl;
      if (Math.abs(pnl) > 0.12) pushTape(s.name.split(" ")[0] + " fill", pnl);
    });
    S.equity += delta; S.dayPnl += delta;
    S.peak = Math.max(S.peak, S.equity);
    S.curve.push(S.equity);
    if (S.curve.length > 240) S.curve.shift();
    if ((S.peak - S.equity) / S.peak >= S.dd) {
      S.halted = true;
      $("pulse").className = "pulse halt";
      $("haltBtn").textContent = "Halted";
      pushTape("Breaker " + Math.round(S.dd * 100) + "% — halted", null);
    }
    renderEquity(); renderStrats();
  }
  function clock() {
    const s = S.elapsed;
    $("clock").textContent = [s / 3600 | 0, (s % 3600) / 60 | 0, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
    $("regime").textContent = ["Quiet", "Quiet", "Dislocation", "Quiet", "Cascade"][(s / 40 | 0) % 5];
  }
  $("pace").oninput = (e) => { S.pace = +e.target.value; renderSliders(); };
  $("agg").oninput = (e) => { S.agg = +e.target.value; renderSliders(); };
  $("dd").oninput = (e) => { S.dd = +e.target.value / 100; renderSliders(); };
  $("haltBtn").onclick = () => {
    S.halted = !S.halted;
    $("pulse").className = S.halted ? "pulse halt" : "pulse";
    $("haltBtn").textContent = S.halted ? "Resume" : "Halt";
    pushTape(S.halted ? "Desk halted" : "Desk resumed", null);
  };
  $("resetBtn").onclick = () => {
    S.equity = 1000; S.peak = 1000; S.dayPnl = 0; S.halted = false;
    S.curve = [1000]; S.elapsed = 0;
    STRATS.forEach((s) => { S.pnl[s.id] = 0; S.trades[s.id] = 0; });
    $("pulse").className = "pulse"; $("haltBtn").textContent = "Halt";
    pushTape("Paper reset → $1,000", null); renderEquity(); renderStrats();
  };
  $("armRec").onclick = () => {
    S.armed = { cross: true, tri: false, basis: true, backrun: false, liq: false };
    renderStrats(); pushTape("Armed recommended set", null);
  };
  $("armBest").onclick = () => {
    if (S.halted) return;
    const pnl = S.equity * 0.05 * (0.001 + Math.random() * 0.004);
    S.equity += pnl; S.dayPnl += pnl; S.pnl.basis += pnl; S.trades.basis += 1;
    S.curve.push(S.equity);
    pushTape("Best funding pair (paper)", pnl); renderEquity(); renderStrats();
  };
  VENUES.forEach((v, i) => { S.rates[v] = [-0.00005, 0.00012, 0.00035, 0.00008][i]; });
  renderStrats(); renderSliders(); renderMatrix(); renderEquity();
  pushTape("Desk online · paper mode", null);
  setInterval(() => { clock(); tickRates(); }, 2000);
  setInterval(tickDesk, 850);
  addEventListener("resize", drawChart);
})();
