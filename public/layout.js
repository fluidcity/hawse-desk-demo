// Card layout: drag to reorder, hide/show, saved views (display only; this file never talks to the desk).
// State = { v: 1, order: [card ids], hidden: [card ids] }, keyed by each section's stable data-card-id,
// saved in localStorage 'hawse.layout.v1'. Named views live in 'hawse.layout.views.v1'.
// The `hidden` ATTRIBUTE stays owned by the per-card render code (no data = hidden); the user's choice is the
// separate .u-hidden class, so "shown" in the menu never forces an empty card onto the page.
(function (root) {
  'use strict';
  // Stage Z: the real-money Kalshi pilot (its HALT button) is the page's top panel, then the "Paper desk (simulated)"
  // divider. TOP ids are always first, in this order, whatever a saved/imported layout says: never hidden, never moved.
  const TOP = ['kalshi-live-pilot', 'paper-desk-head'];
  const PINNED = new Set(TOP);
  const KEY = 'hawse.layout.v1', VIEWS = 'hawse.layout.views.v1';
  const isId = (x) => typeof x === 'string' && x.length > 0 && x.length < 80;

  // Saved state + the page's default order -> a clean state. Unknown ids are dropped; ids that are new on the
  // page (not in the saved order) are placed right after their nearest earlier default neighbour.
  function normalize(saved, defaults) {
    const known = new Set(defaults), seen = new Set(), order = [];
    const src = saved && Array.isArray(saved.order) ? saved.order : [];
    for (const id of src) if (isId(id) && known.has(id) && !seen.has(id)) { seen.add(id); order.push(id); }
    defaults.forEach((id, i) => {
      if (seen.has(id)) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) { const k = order.indexOf(defaults[j]); if (k >= 0) { at = k + 1; break; } }
      order.splice(at, 0, id); seen.add(id);
    });
    const top = TOP.filter((id) => known.has(id)); // pin to the top, in TOP order (old saved layouts cannot push them down)
    const rest = order.filter((id) => !PINNED.has(id)); order.length = 0; order.push(...top, ...rest);
    const hs = saved && Array.isArray(saved.hidden) ? saved.hidden : [];
    const hidden = hs.filter((id, i) => isId(id) && known.has(id) && hs.indexOf(id) === i && !PINNED.has(id)); // the live pilot (its HALT button) can never be hidden
    return { v: 1, order, hidden };
  }
  function move(state, id, delta) {
    const order = state.order.slice(), i = order.indexOf(id), j = i + delta;
    const pins = order.filter((x) => PINNED.has(x)).length;
    if (i < 0 || j < 0 || j >= order.length || PINNED.has(id) || j < pins) return state; // pinned cards stay on top
    order.splice(i, 1); order.splice(j, 0, id); return { ...state, order };
  }
  function setHidden(state, id, hide) {
    const hidden = state.hidden.filter((x) => x !== id); if (hide) hidden.push(id); return { ...state, hidden };
  }
  // Accepts an exported blob ({hawseLayout, order, hidden, views}) or a bare state; null when it is not a layout.
  function parse(text) {
    let o; try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (o.layout && typeof o.layout === 'object') o = { ...o.layout, views: o.views };
    if (!Array.isArray(o.order) && !Array.isArray(o.hidden)) return null;
    const views = {};
    if (o.views && typeof o.views === 'object' && !Array.isArray(o.views)) {
      for (const [k, v] of Object.entries(o.views)) if (isId(k) && v && typeof v === 'object') views[k.slice(0, 40)] = { order: Array.isArray(v.order) ? v.order.filter(isId) : [], hidden: Array.isArray(v.hidden) ? v.hidden.filter(isId) : [] };
    }
    return { order: Array.isArray(o.order) ? o.order : [], hidden: Array.isArray(o.hidden) ? o.hidden : [], views };
  }
  const L = { KEY, VIEWS, TOP, normalize, move, setHidden, parse };
  if (typeof module === 'object' && module.exports) { module.exports = L; return; }
  root.HAWSE = root.HAWSE || {}; root.HAWSE.layoutState = L;

  // ---------- DOM wiring ----------
  const board = document.getElementById('board'); if (!board) return;
  const $ = (id) => document.getElementById(id);
  const cards = () => [...board.children].filter((c) => c.dataset && c.dataset.cardId);
  const byId = new Map(cards().map((c) => [c.dataset.cardId, c]));
  const DEFAULT = [...byId.keys()];
  const name = (id) => (byId.get(id) && byId.get(id).dataset.cardName) || id;
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  let state = normalize(read(KEY), DEFAULT);
  let views = read(VIEWS); if (!views || typeof views !== 'object' || Array.isArray(views)) views = {};
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
  const saveViews = () => { try { localStorage.setItem(VIEWS, JSON.stringify(views)); } catch {} };
  const kick = () => requestAnimationFrame(() => dispatchEvent(new Event('resize'))); // canvases re-measure after a move

  function apply() { // move existing nodes (never re-create: the render code holds ids inside them)
    let prev = null;
    for (const id of state.order) {
      const c = byId.get(id); if (!c) continue;
      const want = prev ? prev.nextElementSibling : board.firstElementChild;
      if (want !== c) board.insertBefore(c, want);
      prev = c;
    }
    const hid = new Set(state.hidden);
    for (const [id, c] of byId) c.classList.toggle('u-hidden', hid.has(id));
    renderList(); kick();
  }
  function set(next) { state = normalize(next, DEFAULT); save(); apply(); }

  // Per-card tools: drag handle (edit mode only) + hide. Re-added if a render replaces the card's children.
  function tools(c) {
    if (c.querySelector(':scope > .ctools, :scope > .card-h > .ctools')) return;
    const t = document.createElement('span'); t.className = 'ctools';
    const nm = c.dataset.cardName || 'card';
    t.innerHTML = '<button type="button" class="c-drag" title="Drag to move (arrow keys work too)">✥</button><button type="button" class="c-hide" title="Hide this card (the Cards menu brings it back)">×</button>';
    t.children[0].setAttribute('aria-label', 'Move ' + nm); t.children[1].setAttribute('aria-label', 'Hide ' + nm);
    if (PINNED.has(c.dataset.cardId)) return; // pinned top cards: no drag handle, no hide button
    const h = c.querySelector(':scope > .card-h');
    if (h) h.appendChild(t); else { t.classList.add('abs'); c.appendChild(t); }
  }
  const mo = new MutationObserver((recs) => {
    let attr = false;
    for (const r of recs) { if (r.type === 'childList') tools(r.target); else attr = true; }
    if (attr && !panel.hidden) renderList();
  });
  for (const c of byId.values()) { tools(c); mo.observe(c, { childList: true, attributes: true, attributeFilter: ['hidden'] }); }

  board.addEventListener('click', (e) => {
    const b = e.target.closest('.c-hide'); if (!b) return;
    const c = b.closest('[data-card-id]'); if (c) set(setHidden(state, c.dataset.cardId, true));
  });
  board.addEventListener('keydown', (e) => {
    const b = e.target.closest('.c-drag'); if (!b || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault(); const id = b.closest('[data-card-id]').dataset.cardId;
    set(move(state, id, e.key === 'ArrowUp' ? -1 : 1)); b.focus(); b.scrollIntoView({ block: 'nearest' });
  });

  // Drag: pointer events (mouse, pen and touch alike). The handle has touch-action:none so a finger drag does
  // not scroll; the page auto-scrolls near the top/bottom edge while dragging.
  let drag = null;
  board.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.c-drag'); if (!h || !document.body.classList.contains('layout-edit') || e.button > 0) return;
    e.preventDefault();
    try { h.setPointerCapture(e.pointerId); } catch {}
    drag = { c: h.closest('[data-card-id]'), pid: e.pointerId, x: e.clientX, y: e.clientY, key: '' };
    drag.c.classList.add('dragging'); document.body.classList.add('is-dragging');
    requestAnimationFrame(scrollLoop);
  });
  // move/up are watched on window: moving the card node can drop pointer capture, so events may land elsewhere.
  addEventListener('pointermove', (e) => { if (!drag || e.pointerId !== drag.pid) return; drag.x = e.clientX; drag.y = e.clientY; place(); });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    drag.c.classList.remove('dragging'); document.body.classList.remove('is-dragging'); drag = null;
    set({ ...state, order: cards().map((c) => c.dataset.cardId) });
  };
  addEventListener('pointerup', end); addEventListener('pointercancel', end);
  function place() {
    const { x, y, c } = drag;
    const vis = cards().filter((k) => k !== c && k.offsetParent !== null);
    let tgt = null, after = false;
    for (const k of vis) {
      const r = k.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        tgt = k; const wide = r.width > board.clientWidth * 0.6;
        after = wide ? y > r.top + r.height / 2 : x > r.left + r.width / 2; break;
      }
    }
    if (!tgt) { const last = vis[vis.length - 1]; if (last && y > last.getBoundingClientRect().bottom) { tgt = last; after = true; } }
    if (!tgt) return;
    const key = tgt.dataset.cardId + (after ? '>' : '<'); if (key === drag.key) return; drag.key = key;
    const ref = after ? tgt.nextElementSibling : tgt;
    if (ref !== c && c.nextElementSibling !== ref) board.insertBefore(c, ref);
  }
  function scrollLoop() {
    if (!drag) return;
    const top = (document.querySelector('.topbar') || { getBoundingClientRect: () => ({ bottom: 0 }) }).getBoundingClientRect().bottom;
    const dy = drag.y < top + 50 ? -14 : drag.y > innerHeight - 50 ? 14 : 0;
    if (dy) { scrollBy(0, dy); place(); }
    requestAnimationFrame(scrollLoop);
  }

  // ---------- Cards menu ----------
  const panel = $('layoutPanel'), btn = $('layoutBtn'), list = $('lpList');
  function openPanel(on) {
    if (on) { const top = Math.max(8, $('layoutBtn').getBoundingClientRect().bottom + 8); panel.style.top = top + 'px'; panel.style.maxHeight = (innerHeight - top - 10) + 'px'; }
    panel.hidden = !on; btn.setAttribute('aria-expanded', String(on)); if (on) { renderList(); renderViews(); }
  }
  btn.onclick = () => openPanel(panel.hidden);
  $('lpClose').onclick = () => openPanel(false);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) openPanel(false); });
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target) && !e.target.closest('.ctools')) openPanel(false); });

  function setEdit(on) {
    document.body.classList.toggle('layout-edit', on);
    const b = $('lpEdit'); b.setAttribute('aria-pressed', String(on)); b.textContent = '✥ Edit layout: ' + (on ? 'on' : 'off'); b.classList.toggle('on', on);
    btn.classList.toggle('on', on);
  }
  $('lpEdit').onclick = () => setEdit(!document.body.classList.contains('layout-edit'));
  $('lpShowAll').onclick = () => set({ ...state, hidden: [] });
  $('lpHideAll').onclick = () => set({ ...state, hidden: DEFAULT.slice() });
  $('lpReset').onclick = () => set({ ...state, order: DEFAULT.slice() });

  function renderList() {
    if (!panel || panel.hidden) return;
    const hid = new Set(state.hidden), pins = state.order.filter((x) => PINNED.has(x)).length; // the first movable card cannot go above the pinned ones
    $('lpCount').textContent = `${state.order.length - hid.size} shown · ${hid.size} hidden`;
    list.textContent = '';
    state.order.forEach((id, i) => {
      const li = document.createElement('li'); li.className = 'lp-item' + (hid.has(id) ? ' off' : '');
      const lab = document.createElement('label'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !hid.has(id);
      const pin = PINNED.has(id); if (pin) { cb.disabled = true; cb.title = 'Pinned to the top: always shown'; li.classList.add('pinned'); }
      cb.onchange = () => set(setHidden(state, id, !cb.checked));
      const sp = document.createElement('span'); sp.textContent = name(id); lab.append(cb, sp);
      if (pin) { const t = document.createElement('small'); t.className = 'lp-nd'; t.textContent = 'pinned top'; lab.append(t); }
      if (byId.get(id).hidden) { const t = document.createElement('small'); t.className = 'lp-nd'; t.textContent = 'no data'; t.title = 'This card hides itself until it has data'; lab.append(t); }
      const up = document.createElement('button'); up.type = 'button'; up.className = 'lp-mv'; up.textContent = '↑'; up.disabled = pin || i <= pins; up.setAttribute('aria-label', 'Move ' + name(id) + ' up');
      const dn = document.createElement('button'); dn.type = 'button'; dn.className = 'lp-mv'; dn.textContent = '↓'; dn.disabled = pin || i === state.order.length - 1; dn.setAttribute('aria-label', 'Move ' + name(id) + ' down');
      up.onclick = () => set(move(state, id, -1)); dn.onclick = () => set(move(state, id, 1));
      li.append(lab, up, dn); list.append(li);
    });
  }
  function renderViews() {
    const ul = $('lpViews'); ul.textContent = '';
    const names = Object.keys(views);
    if (!names.length) { const li = document.createElement('li'); li.className = 'dim sm'; li.textContent = 'none saved yet (the current layout always saves itself)'; ul.append(li); return; }
    for (const n of names) {
      const li = document.createElement('li'); const s = document.createElement('span'); s.textContent = n;
      const ld = document.createElement('button'); ld.type = 'button'; ld.className = 'btn sm'; ld.textContent = 'Load'; ld.onclick = () => { set(views[n]); msg('loaded “' + n + '”'); };
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn sm ghost'; del.textContent = 'Delete'; del.onclick = () => { delete views[n]; saveViews(); renderViews(); };
      li.append(s, ld, del); ul.append(li);
    }
  }
  const msg = (t) => { const m = $('lpMsg'); if (m) { m.textContent = t; clearTimeout(msg.t); msg.t = setTimeout(() => { m.textContent = ''; }, 4000); } };
  $('lpSaveView').onclick = () => {
    const inp = $('lpViewName'), n = inp.value.trim().slice(0, 40) || 'view ' + (Object.keys(views).length + 1);
    views[n] = { order: state.order.slice(), hidden: state.hidden.slice() }; saveViews(); inp.value = ''; renderViews();
  };
  $('lpExport').onclick = async () => {
    const ta = $('lpJson'); ta.value = JSON.stringify({ hawseLayout: 1, order: state.order, hidden: state.hidden, views });
    ta.select(); let ok = false;
    try { await navigator.clipboard.writeText(ta.value); ok = true; } catch { try { ok = document.execCommand('copy'); } catch {} }
    msg(ok ? 'copied: paste it into Import on the other device' : 'select the text above and copy it');
  };
  $('lpImport').onclick = () => {
    const p = parse($('lpJson').value); if (!p) { msg('not a layout: paste the text from Copy layout'); return; }
    Object.assign(views, p.views); saveViews(); renderViews(); set(p); msg('layout imported');
  };

  root.HAWSE.layout = { get: () => state, set, openPanel, setEdit, defaults: DEFAULT.slice() };
  apply();
})(typeof window !== 'undefined' ? window : globalThis);
