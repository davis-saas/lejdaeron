// Transports: how the host and the replicas move ArrayBuffers between peers. Every transport has the same shape:
//
//   t.id                      my peer id
//   t.send(peer, buf)         one ArrayBuffer to one peer (ordered and reliable, like a WebRTC data channel)
//   t.broadcast(buf)          to every connected peer
//   t.onMessage(fn)           fn(peer, buf)
//   t.onPeerJoin(fn)          fn(peer)
//   t.onPeerLeave(fn)         fn(peer)
//   t.peers()                 connected peer ids
//   t.drop(peer)              ends the link to one peer (the host's answer to a kicked or silent peer), where it can
//   t.stats                   { up, down, msgsUp, msgsDown }: bytes and messages so far
//   t.close()
//
// Implementations: TrysteroTransport (src/net/trystero.js, browsers, WebRTC), PortTransport (a postMessage link: the
// host's own UI talking to the host worker), Loopback (in memory, same thread, for a host without a worker) and FakeNet
// (a virtual-clock network with latency, jitter and loss, for tools/net_test.mjs).

export class Transport {
  constructor(id) {
    this.id = id; this.closed = false;
    this.handlers = { message: [], join: [], leave: [] };
    this.stats = { up: 0, down: 0, msgsUp: 0, msgsDown: 0 };
    this.connected = new Set();
  }
  onMessage(fn) { this.handlers.message.push(fn); }
  onPeerJoin(fn) { this.handlers.join.push(fn); }
  onPeerLeave(fn) { this.handlers.leave.push(fn); }
  peers() { return [...this.connected]; }
  broadcast(buf) { for (const p of this.connected) this.send(p, buf); }
  send() { throw new Error('not implemented'); }
  drop() {}
  close() { this.closed = true; for (const p of [...this.connected]) this.left(p); }
  // for implementations
  sent(buf) { this.stats.up += buf.byteLength; this.stats.msgsUp++; }
  got(peer, buf) {
    if (this.closed || !this.connected.has(peer)) return;
    this.stats.down += buf.byteLength; this.stats.msgsDown++;
    for (const fn of this.handlers.message) fn(peer, buf);
  }
  joined(peer) { if (this.closed || this.connected.has(peer)) return; this.connected.add(peer); for (const fn of this.handlers.join) fn(peer); }
  left(peer) { if (!this.connected.delete(peer)) return; for (const fn of this.handlers.leave) fn(peer); }
}

// ---------------------------------------------------------------------------------------------------- loopback
// In-memory hub: every endpoint sees every other one. Delivery is asynchronous (a microtask) and copies the buffer,
// like a real link.
export class Loopback {
  constructor() { this.ends = new Map(); }
  endpoint(id) {
    const hub = this, t = new Transport(id);
    t.send = (peer, buf) => {
      const to = hub.ends.get(peer);
      if (t.closed || !to || !t.connected.has(peer)) return;
      const copy = buf.slice(0); t.sent(copy);
      queueMicrotask(() => to.got(id, copy));
    };
    const close = t.close.bind(t);
    t.close = () => { hub.ends.delete(id); close(); for (const o of hub.ends.values()) queueMicrotask(() => o.left(id)); };
    for (const o of this.ends.values()) queueMicrotask(() => { o.joined(id); t.joined(o.id); });
    this.ends.set(id, t);
    return t;
  }
}

// ---------------------------------------------------------------------------------------------------- postMessage
// One end of a MessagePort (or a Worker, or the worker's own global scope). The other end is a single peer that
// counts as joined from the start. Buffers are transferred, not copied, so don't reuse a buffer after sending it.
export class PortTransport extends Transport {
  constructor(port, { id = 'self', peer = 'peer' } = {}) {
    super(id);
    this.port = port; this.peer = peer;
    port.onmessage = (e) => {
      const m = e.data;
      if (m && m.bye) { this.left(peer); return; }
      if (m && m.d instanceof ArrayBuffer) this.got(peer, m.d);
    };
    if (port.start) port.start();
    queueMicrotask(() => this.joined(peer));
  }
  send(peer, buf) {
    if (this.closed || peer !== this.peer) return;
    this.sent(buf);
    this.port.postMessage({ d: buf }, [buf]);
  }
  close() {
    if (this.closed) return;
    try { this.port.postMessage({ bye: true }); } catch { /* port already gone */ }
    super.close();
    if (this.port.close) this.port.close();
  }
}

// ---------------------------------------------------------------------------------------------------- fake network
// A deterministic virtual network for tests. Time only moves when advance() is called; net.timers can stand in for
// setTimeout/setInterval/Date so code under test runs on the same clock. Each link (a pair of endpoints) has latency
// and jitter in seconds and a loss rate. In 'reliable' mode (what WebRTC data channels give) a lost packet is resent
// after a retransmission timeout and the link stays in order, so loss shows up as delay and head-of-line blocking; in
// 'lossy' mode messages are really dropped and can arrive out of order, which exercises the resync path.
export class FakeNet {
  constructor({ seed = 1 } = {}) {
    this.time = 0; this.queue = []; this.order = 0;
    this.ends = new Map(); this.links = new Map();
    let a = seed >>> 0;
    this.rng = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const net = this;
    let tid = 1;
    const timers = new Map();
    this.timers = {
      now: () => net.time * 1000,
      setTimeout(fn, ms = 0) { const id = tid++; timers.set(id, true); net.at(net.time + ms / 1000, () => { if (timers.delete(id)) fn(); }); return id; },
      clearTimeout(id) { timers.delete(id); },
      setInterval(fn, ms) {
        const id = tid++; timers.set(id, true);
        const run = () => { if (!timers.has(id)) return; fn(); net.at(net.time + Math.max(1, ms) / 1000, run); };
        net.at(net.time + Math.max(1, ms) / 1000, run);
        return id;
      },
      clearInterval(id) { timers.delete(id); },
    };
  }
  at(t, fn) {
    const e = { t, k: this.order++, fn }, q = this.queue;
    let i = q.length;
    while (i > 0 && (q[i - 1].t > t || (q[i - 1].t === t && q[i - 1].k > e.k))) i--;
    q.splice(i, 0, e);
  }
  advance(dt) {
    const end = this.time + dt;
    while (this.queue.length && this.queue[0].t <= end) {
      const e = this.queue.shift();
      this.time = Math.max(this.time, e.t);
      e.fn();
    }
    this.time = end;
  }
  key(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  endpoint(id) {
    const net = this, t = new Transport(id);
    t.send = (peer, buf) => {
      if (t.closed || !t.connected.has(peer)) return;
      const link = net.links.get(net.key(id, peer));
      if (!link || link.down) return;
      const copy = buf.slice(0); t.sent(copy);
      const dir = link.dir[id];
      dir.bytes += copy.byteLength; dir.msgs++;
      let when = net.time + link.latency + link.jitter * net.rng();
      if (link.mode === 'reliable') {
        while (net.rng() < link.loss) when += Math.max(0.2, 3 * link.latency);   // retransmission timeout
        when = Math.max(when, dir.last); dir.last = when;
      } else if (net.rng() < link.loss) { dir.lost++; return; }
      const epoch = link.epoch;
      net.at(when, () => { if (link.epoch === epoch && !link.down) net.ends.get(peer)?.got(id, copy); });
    };
    t.drop = (peer) => net.disconnect(id, peer);
    const close = t.close.bind(t);
    t.close = () => { close(); net.ends.delete(id); for (const [k, l] of net.links) if (k.split('|').includes(id)) net.cut(l); };
    this.ends.set(id, t);
    return t;
  }
  // Connects two endpoints; both see the other join after one latency.
  connect(a, b, { latency = 0.04, jitter = 0.01, loss = 0, mode = 'reliable' } = {}) {
    const k = this.key(a, b);
    let link = this.links.get(k);
    if (!link) {
      link = { a, b, latency, jitter, loss, mode, down: true, epoch: 0, dir: {} };
      link.dir[a] = { bytes: 0, msgs: 0, lost: 0, last: 0 }; link.dir[b] = { bytes: 0, msgs: 0, lost: 0, last: 0 };
      this.links.set(k, link);
    }
    Object.assign(link, { latency, jitter, loss, mode });
    if (!link.down) return link;
    link.down = false; link.epoch++;
    const epoch = link.epoch;
    this.at(this.time + latency, () => {
      if (link.down || link.epoch !== epoch) return;
      this.ends.get(a)?.joined(b); this.ends.get(b)?.joined(a);
    });
    return link;
  }
  // Breaks a link: in-flight messages are lost and both ends see the other leave.
  cut(link) {
    if (typeof link === 'string') link = this.links.get(link);
    if (!link || link.down) return;
    link.down = true; link.epoch++;
    this.ends.get(link.a)?.left(link.b); this.ends.get(link.b)?.left(link.a);
  }
  disconnect(a, b) { this.cut(this.links.get(this.key(a, b))); }
  link(a, b) { return this.links.get(this.key(a, b)); }
}
