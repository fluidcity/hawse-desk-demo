'use strict';
// Reconnecting WebSocket client on Node's built-in WebSocket (Node >= 22, no dependency).
// Reports into the health registry: ok() on each message with measured latency (exchange event time → box
// when the venue provides it, otherwise null), fail() on error/close. Exponential backoff 1s → 30s.
class WsClient {
  constructor({ url, health, id, onOpen, onMessage, pingMs = 0, ping = null, label }) {
    this.url = url; this.health = health; this.id = id; this.onOpen = onOpen; this.onMessage = onMessage; this.pingMs = pingMs; this.ping = ping;
    this.label = label || id; this.backoff = 1000; this.open = false; this.msgs = 0; this.stopped = false; this.lastLatency = null;
  }
  start() { this.stopped = false; this.connect(); }
  stop() { this.stopped = true; clearInterval(this.pt); clearTimeout(this.rt); try { this.ws && this.ws.close(); } catch {} }
  send(obj) { if (this.open) this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
  connect() {
    let ws; try { ws = this.ws = new WebSocket(this.url); } catch (e) { return this.retry(e.message); }
    ws.onopen = () => { this.open = true; this.backoff = 1000; this.openedAt = Date.now(); try { this.onOpen && this.onOpen(this); } catch {}
      if (this.pingMs) { clearInterval(this.pt); this.pt = setInterval(() => this.send(typeof this.ping === 'function' ? this.ping() : this.ping), this.pingMs); } };
    ws.onmessage = (ev) => {
      this.msgs++; let exTs = null;
      try { exTs = this.onMessage(String(ev.data), this); } catch { /* malformed frame: ignore */ }
      const lat = exTs ? Math.max(0, Date.now() - exTs) : null; if (lat != null) this.lastLatency = lat;
      if (this.health && this.id) this.health.ok(this.id, lat != null ? lat : this.lastLatency);
    };
    ws.onerror = () => {};
    ws.onclose = () => { this.open = false; clearInterval(this.pt); if (this.health && this.id) this.health.fail(this.id, 'websocket closed'); this.retry(); };
  }
  retry() { if (this.stopped) return; clearTimeout(this.rt); this.rt = setTimeout(() => this.connect(), this.backoff); this.backoff = Math.min(30000, this.backoff * 2); }
}
module.exports = { WsClient };
