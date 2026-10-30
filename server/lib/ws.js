'use strict';
// Reconnecting WebSocket client on Node's built-in WebSocket (Node >= 22, no dependency).
// Reports into the health registry: ok() on each message with measured latency (exchange event time → box
// when the venue provides it, otherwise null), fail() on error/close. Exponential backoff 1s → 30s.
// Dead-socket protection (H5.1): a half-open TCP connection (e.g. after the box VM was paused/resumed) never fires
// 'close', so the client keeps its own clock: no frame for idleMs => the socket is dropped and reconnected;
// not open within connectTimeoutMs => same. restart() does that on demand (used by the feed watchdog).
class WsClient {
  constructor({ url, health, id, onOpen, onMessage, pingMs = 0, ping = null, label, idleMs, connectTimeoutMs = 15000, now = () => Date.now(), WebSocketImpl, log = null }) {
    this.url = url; this.health = health; this.id = id; this.onOpen = onOpen; this.onMessage = onMessage; this.pingMs = pingMs; this.ping = ping;
    this.label = label || id; this.backoff = 1000; this.open = false; this.msgs = 0; this.stopped = false; this.lastLatency = null;
    this.idleMs = idleMs != null ? idleMs : Math.max(60000, pingMs * 3); this.connectTimeoutMs = connectTimeoutMs; this.now = now;
    this.WS = WebSocketImpl || globalThis.WebSocket; this.log = log; this.reconnects = 0; this.idleKicks = 0; this.lastMsgAt = null;
  }
  start() { this.stopped = false; this.connect(); this.armIdle(); }
  stop() { this.stopped = true; clearInterval(this.pt); clearTimeout(this.rt); clearInterval(this.it); clearTimeout(this.ct); this.drop(); }
  send(obj) { if (this.open) { try { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch { /* socket died under us: idle check will reconnect */ } } }
  /** Detach and close the current socket without waiting for a close handshake that may never come. */
  drop() { const ws = this.ws; this.ws = null; this.open = false; clearInterval(this.pt); clearTimeout(this.ct); if (!ws) return; ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch {} }
  /** Force a fresh connection now (watchdog / idle / connect timeout). */
  restart(reason = 'restart') {
    if (this.stopped) return; this.drop(); this.reconnects++;
    if (this.health && this.id) this.health.fail(this.id, 'websocket ' + reason + ' → reconnecting');
    if (this.log) this.log(`[ws] ${this.label}: ${reason} -> reconnecting`);
    clearTimeout(this.rt); this.backoff = Math.max(1000, Math.min(this.backoff, 5000)); this.connect();
  }
  armIdle() { clearInterval(this.it); const every = Math.max(1000, Math.min(15000, Math.floor(this.idleMs / 4))); this.it = setInterval(() => this.checkIdle(), every); if (this.it.unref) this.it.unref(); }
  checkIdle() {
    if (this.stopped || !this.open) return;
    const ref = this.lastMsgAt != null && this.lastMsgAt >= (this.openedAt || 0) ? this.lastMsgAt : this.openedAt;
    if (ref != null && this.now() - ref > this.idleMs) { this.idleKicks++; this.restart(`idle ${Math.round((this.now() - ref) / 1000)}s`); }
  }
  connect() {
    if (this.stopped) return;
    let ws; try { ws = this.ws = new this.WS(this.url); } catch (e) { return this.retry(e.message); }
    clearTimeout(this.ct); this.ct = setTimeout(() => { if (this.ws === ws && !this.open) { this.drop(); if (this.health && this.id) this.health.fail(this.id, 'websocket connect timeout'); this.retry(); } }, this.connectTimeoutMs);
    if (this.ct.unref) this.ct.unref();
    ws.onopen = () => { if (this.ws !== ws) return; clearTimeout(this.ct); this.open = true; this.backoff = 1000; this.openedAt = this.now(); try { this.onOpen && this.onOpen(this); } catch {}
      if (this.pingMs) { clearInterval(this.pt); this.pt = setInterval(() => this.send(typeof this.ping === 'function' ? this.ping() : this.ping), this.pingMs); } };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.msgs++; this.lastMsgAt = this.now(); let exTs = null;
      try { exTs = this.onMessage(String(ev.data), this); } catch { /* malformed frame: ignore */ }
      const lat = exTs ? Math.max(0, Date.now() - exTs) : null; if (lat != null) this.lastLatency = lat;
      if (this.health && this.id) this.health.ok(this.id, lat != null ? lat : this.lastLatency);
    };
    ws.onerror = () => {};
    ws.onclose = () => { if (this.ws !== ws) return; this.open = false; this.ws = null; clearInterval(this.pt); if (this.health && this.id) this.health.fail(this.id, 'websocket closed'); this.retry(); };
  }
  retry() { if (this.stopped) return; clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), this.backoff); if (this.rt.unref) this.rt.unref(); this.backoff = Math.min(30000, this.backoff * 2); }
  view() { return { open: this.open, msgs: this.msgs, reconnects: this.reconnects, idleKicks: this.idleKicks, lastMsgAgeMs: this.lastMsgAt ? this.now() - this.lastMsgAt : null }; }
}
module.exports = { WsClient };
