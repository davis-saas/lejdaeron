// The player's side of vs Players: the link to the host, the lobby object and the online session, as docs/SPEC-client.md
// ("Session contract") describes them. The host's own UI uses exactly the same code over the postMessage link to the host
// worker, so the host plays like any joiner. src/net/session.js wires these to real transports (hostLobby, joinLobby).
//
//   lobby.room, lobby.link, lobby.me, lobby.seats [{ slot, kind, name, difficulty, ready, connected, color, me }]
//   lobby.setSeat(slot, { kind, difficulty }), lobby.setName(name), lobby.setReady(bool), lobby.chat(text),
//   lobby.kick(slot), lobby.start(), lobby.leave(), lobby.on('change' | 'chat' | 'start' | 'closed' | 'error', fn)
//   lobby.options { extra }, lobby.setOptions({ extra }) (host only: whether '-onextra' works in the match)
//   session.kind, .me, .world, .command(op) -> Promise<{ ok, why }>, .tick(realDt), .on(type, fn), .close()
import { Replica } from './replica.js?v=91305a8026e8';
import { newNonce, verify } from './auth.js?v=91305a8026e8';
import * as P from './protocol.js?v=91305a8026e8';
import * as CFG from './config.js?v=91305a8026e8';

const { C, H } = P;
const LEAVE_LINGER = 500;   // ms the link stays open after a LEAVE, so the host gets it
export const systemTimers = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
  setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id),
};

export class Emitter {
  constructor() { this.listeners = {}; }
  on(type, fn) { (this.listeners[type] ||= []).push(fn); return () => this.off(type, fn); }
  off(type, fn) { const l = this.listeners[type]; if (l) this.listeners[type] = l.filter(f => f !== fn); }
  emit(type, arg) {
    for (const fn of this.listeners[type] || []) {
      try { fn(arg); } catch (e) { console.error(e); }
    }
  }
}

// ---------------------------------------------------------------------------------------------------- the link
// One transport to the host. Until the host answers, the link says hello to every peer it meets (the transport only
// keeps host <-> player links, but anyone who knows the room code can claim to be a host). With the invite link's key
// (src/net/auth.js) an answer counts only once its signature checks out for this link's nonce and peer id, and
// everything that peer sends meanwhile waits for the check; a rejoining player asks for that proof before it sends its
// token, so an impostor never learns it. After that the link listens to the host alone, and every new connection to it
// proves itself again. Without a key (the host's own UI) the first answer is the host's.
// If the host drops, or goes silent while its connection still looks up (no answer to a ping for HOST_SILENT_AFTER
// seconds: a frozen page, a dead network path), the link is lost: it keeps saying hello, closes a connection that stays
// silent so the transport can build a new one, and gives up after HOST_LOST_AFTER seconds.
class Link extends Emitter {
  constructor(transport, { name, token = null, key = null, room = '', timers = systemTimers }) {
    super();
    this.t = transport; this.name = name; this.token = token; this.key = key; this.room = room; this.timers = timers;
    this.nonce = newNonce();
    this.host = null;               // the host's peer id, once it has proved itself
    this.trusted = null;            // the same while its current connection has proved itself (null again after a drop)
    this.checking = new Map();      // peer -> messages held while its answer is checked
    this.impostors = 0;             // answers that failed the check (a refusal too: only the host's own is believed)
    this.welcome = null; this.closed = false;
    this.ping = null; this.lastPing = -1e9; this.asked = null;   // asked: the first ping since the host was last heard
    this.lostAt = null; this.lostTimer = null; this.retry = null; this.dropped = false;
    this.rates = { up: 0, down: 0, at: timers.now(), up0: 0, down0: 0 };
    transport.onPeerJoin((peer) => {
      if (this.closed) return;
      if (this.host === null || peer === this.host) this.hello(peer);
    });
    // peers the transport found before this link existed (joinLobby may wait for an old tab's token), then, until a host
    // answers, hello again now and then (a first hello can be lost while a link is still settling)
    queueMicrotask(() => { if (!this.closed && this.host === null) for (const p of this.t.peers()) this.hello(p); });
    this.helloTimer = timers.setInterval(() => {
      if (this.closed || this.welcome) { timers.clearInterval(this.helloTimer); return; }
      for (const p of this.t.peers()) if (!this.checking.has(p)) this.hello(p);
    }, 2000);
    transport.onPeerLeave((peer) => {
      this.checking.delete(peer);
      if (this.closed || peer !== this.host) return;
      if (this.key) this.trusted = null;
      this.lost();
    });
    transport.onMessage((peer, buf) => this.receive(peer, buf));
    this.pinger = timers.setInterval(() => this.sendPing(), CFG.PING_EVERY * 1000);
    this.dog = timers.setInterval(() => this.watchdog(), 1000);
  }
  now() { return this.timers.now() / 1000; }
  get up() { return !this.closed && this.host !== null && this.trusted === this.host; }
  hello(peer) {
    const probe = !!(this.key && this.token && peer !== this.trusted);
    this.t.send(peer, P.jsonMsg(C.HELLO, { v: P.PROTO, data: P.DATA_SIG, name: this.name, nonce: this.nonce, ...(probe ? { rejoin: true } : { token: this.token }) }));
  }
  receive(peer, buf) {
    if (this.closed || (this.host !== null && peer !== this.host)) return;   // only the host may talk to us
    if (peer !== this.trusted) return this.vet(peer, buf);
    const m = P.readMsg(buf);
    if (!m) return;
    this.asked = null;
    if (this.lostAt !== null) this.back();
    switch (m.type) {
      case H.WELCOME:
        this.welcome = m.json; this.token = typeof m.json.token === 'string' ? m.json.token : this.token;
        return this.emit('welcome', m.json);
      case H.PROOF: return;
      case H.PONG: {
        const t = m.r.f64(), rtt = this.now() - t;
        if (rtt >= 0 && rtt < 30) this.ping = this.ping === null ? rtt : this.ping + (rtt - this.ping) * 0.3;
        return;
      }
      case H.ERROR:
        if (m.json.rehello) return this.hello(peer);
        if (!this.welcome) return this.emit('refused', m.json);
        return this.emit('error', m.json);
      case H.FRAME:
        if (this.now() - this.lastPing > CFG.PING_EVERY) this.sendPing();   // keeps pinging when timers are throttled
        return this.emit('frame', { r: m.r, size: buf.byteLength });
      default:
        return this.emit('msg', m);
    }
  }
  // A message from a peer that has not shown (on this connection) that it holds the host's key. Its answer to our hello
  // is checked, and what it sends meanwhile is held for after the check; anything else from it is dropped.
  vet(peer, buf) {
    const held = this.checking.get(peer);
    if (held) { held.push(buf); return; }
    const m = P.readMsg(buf);
    if (!m) return;
    if (m.type === H.ERROR && m.json.rehello) return this.hello(peer);
    if (m.type !== H.WELCOME && m.type !== H.ERROR && m.type !== H.PROOF) return;
    if (!this.key) {
      if (m.type === H.ERROR) return this.emit('refused', m.json);
      this.host = this.trusted = peer;
      return this.receive(peer, buf);
    }
    const what = m.type === H.WELCOME ? 'welcome' : m.type === H.PROOF ? 'hello' : 'refuse:' + m.json.message;
    const list = [buf];
    this.checking.set(peer, list);
    verify(m.json.proof, { key: this.key, room: this.room, peer: this.t.id, nonce: this.nonce, what }).then((good) => {
      if (this.checking.get(peer) !== list) return;   // the connection dropped meanwhile
      this.checking.delete(peer);
      if (this.closed || (this.host !== null && peer !== this.host)) return;
      if (!good) { this.impostors++; return; }
      if (m.type === H.ERROR) { this.emit('refused', m.json); return; }
      this.host = this.trusted = peer;
      if (m.type === H.PROOF) { list.shift(); this.hello(peer); }   // proven: now the token can go
      for (const b of list) this.receive(peer, b);
    });
  }
  sendPing() {
    if (!this.up) return;
    this.lastPing = this.now();
    if (this.asked === null) this.asked = this.lastPing;
    this.t.send(this.host, P.binMsg(C.PING).f64(this.lastPing).finish());
  }
  // The silent-host watchdog: nothing from the host since a ping that went out HOST_SILENT_AFTER seconds ago. (Timed
  // from the ping, so a page whose own timers were throttled doesn't blame the host for its silence.)
  watchdog() {
    if (!this.up || this.lostAt !== null || this.asked === null) return;
    if (this.now() - this.asked > CFG.HOST_SILENT_AFTER) this.lost();
  }
  lost() {
    if (this.closed || this.lostAt !== null) return;
    this.lostAt = this.now(); this.dropped = false;
    this.emit('hostlost');
    this.lostTimer = this.timers.setTimeout(() => this.fail('lost', 'Lost the connection to the host. The game is over.'), CFG.HOST_LOST_AFTER * 1000);
    this.retry = this.timers.setInterval(() => this.reconnect(), 2000);
  }
  // While lost: hello again over a connection that is still up (the host answers it if it can); one that stays silent
  // for half the time is closed, and the transport finds the host again (onPeerJoin says hello).
  reconnect() {
    if (this.closed || this.lostAt === null) return;
    const host = this.host;
    if (!this.t.peers().includes(host)) return;
    if (!this.dropped && this.now() - this.lostAt >= CFG.HOST_LOST_AFTER / 2) { this.dropped = true; this.t.drop(host); return; }
    this.hello(host);
  }
  back() {
    this.lostAt = null;
    this.timers.clearTimeout(this.lostTimer); this.lostTimer = null;
    this.timers.clearInterval(this.retry); this.retry = null;
    this.emit('hostback');
  }
  json(type, obj) { if (this.up) this.t.send(this.host, P.jsonMsg(type, obj)); }
  bin(buf) { if (this.up) this.t.send(this.host, buf); }
  // Bytes per second up and down since the last call.
  traffic() {
    const r = this.rates, now = this.timers.now(), dt = Math.max(1e-3, (now - r.at) / 1000), s = this.t.stats;
    r.up = (s.up - r.up0) / dt; r.down = (s.down - r.down0) / dt;
    r.up0 = s.up; r.down0 = s.down; r.at = now;
    return r;
  }
  fail(reason, message) {
    if (this.closed) return;
    this.emit('end', { reason, message });
    this.close();
  }
  // linger: ms the transport stays open for a goodbye just sent (closing it at once would drop that message)
  close(linger = 0) {
    if (this.closed) return;
    this.closed = true;
    this.timers.clearInterval(this.pinger); this.timers.clearInterval(this.dog); this.timers.clearInterval(this.helloTimer); this.timers.clearInterval(this.retry);
    if (this.lostTimer !== null) this.timers.clearTimeout(this.lostTimer);
    this.checking.clear();
    if (linger > 0) this.timers.setTimeout(() => this.t.close(), linger);
    else this.t.close();
  }
}

// ---------------------------------------------------------------------------------------------------- the lobby
export class Lobby extends Emitter {
  // opts: { transport, name, token, room, key (the invite link's host key), link (invite URL), isHost, timers,
  // onToken(token, me), onClose() }
  constructor(opts) {
    super();
    this.opts = opts;
    this.room = opts.room; this.link = opts.link || ''; this.isHost = !!opts.isHost;
    this.me = null; this.seats = []; this.options = { extra: true }; this.phase = 'lobby'; this.session = null; this.closed = false;
    this.timers = opts.timers || systemTimers;
    const link = this.conn = new Link(opts.transport, { name: opts.name, token: opts.token, key: opts.key || null, room: opts.room, timers: this.timers });
    link.on('welcome', (w) => {
      this.me = w.you; this.phase = w.phase;
      if (opts.onToken) opts.onToken(w.token, w.you);
      this.emit('welcome', w);
    });
    link.on('refused', (e) => this.emit('refused', e));
    link.on('error', (e) => {
      this.emit('error', { message: e.message || 'Error.' });
      if (this.session) this.session.emit('error', { message: e.message || 'Error.' });
      if (e.fatal) this.end({ reason: 'error', message: e.message });
    });
    link.on('end', (e) => this.end(e));
    link.on('hostlost', () => { this.hostLost = true; if (this.session) this.session.hostLost = true; this.emit('hostlost'); });
    link.on('hostback', () => { this.hostLost = false; if (this.session) this.session.hostLost = false; this.emit('hostback'); });
    link.on('msg', (m) => this.message(m));
    link.on('frame', (f) => this.session && this.session.frame(f.r, f.size));
  }
  // Resolves when the host has let us in (or rejects with its reason).
  ready(timeout = CFG.JOIN_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (this.me !== null) return resolve(this);
      const timer = this.timers.setTimeout(() => {
        off(); this.close();
        const c = this.conn;
        reject(new Error(c.impostors ? `Someone in room ${this.room} answered, but not with the host's key from your invite link. Ask the host for a new link.`
          : `Couldn't reach the host of room ${this.room}. Check the code, or ask the host for a new link.`));
      }, timeout * 1000);
      const offs = [this.on('welcome', () => { off(); resolve(this); }),
        this.on('refused', (e) => { off(); this.close(); reject(new Error(e.message || 'The host refused the connection.')); }),
        this.on('closed', (e) => { off(); reject(new Error(e.message || 'The lobby closed.')); })];
      const off = () => { this.timers.clearTimeout(timer); offs.forEach(f => f()); };
    });
  }
  message(m) {
    const j = m.json;
    switch (m.type) {
      case H.LOBBY:
        if (!Array.isArray(j.seats)) return;
        this.phase = j.phase;
        if (j.options && typeof j.options === 'object') this.options = { extra: j.options.extra !== false };
        this.seats = j.seats.map(s => ({ slot: s.slot, kind: s.kind, name: s.name, difficulty: s.difficulty, ready: !!s.ready,
          connected: !!s.connected, color: s.color, me: s.slot === this.me }));
        if (this.session) this.session.seats = this.seats;
        return this.emit('change', this);
      case H.CHAT: {
        const line = { slot: j.slot, name: P.cleanName(j.name), text: P.cleanChat(j.text) };
        if (j.at === 'game' && this.session) return this.session.emit('chat', line);
        this.emit('chat', line);
        if (this.session) this.session.emit('chat', line);
        return;
      }
      case H.START:
        if (this.session) { this.session.rejoined(); return; }   // our own reconnect: the full frame that follows resyncs us
        this.phase = 'playing';
        this.session = new OnlineSession(this, j);
        return;
      case H.RESULT: return this.session && this.session.result(j);
      case H.END: return this.end(j);
    }
  }
  send(op) { if (!this.closed) this.conn.json(C.LOBBY, op); }
  setSeat(slot, { kind, difficulty } = {}) { this.send({ op: 'seat', slot, kind, difficulty }); }
  setName(name) { this.send({ op: 'name', name }); }
  setReady(ready) { this.send({ op: 'ready', ready: !!ready }); }
  chat(text) { this.send({ op: 'chat', text }); }
  kick(slot) { this.send({ op: 'kick', slot }); }
  setOptions({ extra } = {}) { this.send({ op: 'options', extra: !!extra }); }
  start() { this.send({ op: 'start' }); }
  started(session) { this.emit('start', session); }
  // 'start' is sticky: a listener added after the game started (a rejoin can start it right away) still gets it.
  on(type, fn) {
    const off = super.on(type, fn);
    if (type === 'start' && this.session && this.session.announced) queueMicrotask(() => fn(this.session));
    return off;
  }
  end(e, linger = 0) {
    if (this.closed) return;
    this.closed = true;
    const info = { reason: e.reason || 'closed', message: e.message || 'The game is over.' };
    if (this.session) { this.session.ended(info); this.timers.clearInterval(this.session.net); }
    this.emit('closed', info);
    this.conn.close(linger);
    if (this.opts.onClose) this.opts.onClose(info);
  }
  // Leaves the lobby (or the game). The host leaving ends it for everyone.
  leave() {
    if (this.closed) return;
    const up = this.conn.up;
    this.conn.bin(P.binMsg(C.LEAVE).finish());
    this.end({ reason: 'left', message: 'You left the game.' }, up ? LEAVE_LINGER : 0);   // the host frees the seat at once
  }
  close() { this.leave(); }
}

// ---------------------------------------------------------------------------------------------------- the session
export class OnlineSession extends Emitter {
  constructor(lobby, start) {
    super();
    this.lobby = lobby; this.kind = lobby.isHost ? 'host' : 'client';
    this.me = start.you; this.speed = 1; this.paused = false;
    this.seats = lobby.seats; this.hostLost = false; this.over = false;
    this.timers = lobby.timers;
    this.replica = new Replica(start, { now: () => this.timers.now() / 1000, onMatchEvent: (e) => this.matchEvent(e) });
    this.world = this.replica.world;
    this.rid = 0; this.pending = new Map();
    this.lastResync = -1e9; this.announced = false;
    this.net = this.timers.setInterval(() => this.report(), 1000);
  }
  frame(r, size) {
    let ok;
    try { ok = this.replica.frame(r, size); } catch (e) { ok = false; this.replica.synced = false; }
    if (!ok) {
      const now = this.timers.now() / 1000;
      if (now - this.lastResync > 0.5) { this.lastResync = now; this.replica.stats.resyncs++; this.lobby.conn.bin(P.binMsg(C.RESYNC).finish()); }
      return;
    }
    if (!this.announced) { this.announced = true; this.lobby.started(this); }
  }
  rejoined() { this.replica.synced = false; }
  // Match events as the world clock reaches them. Chat during the match is a match event (the host runs it through
  // match.command so the map's chat commands work), and the session passes it on as 'chat'.
  matchEvent(e) {
    if (e.type === 'left') this.emit('left', { slot: e.slot });
    else if (e.type === 'chat') {
      const p = this.world.players[e.slot];
      this.emit('chat', { slot: e.slot, name: p ? P.cleanName(p.name) : '', text: P.cleanChat(e.text) });
    } else if (e.type === 'over') this.ended({ reason: 'over', winner: e.winner ?? null, message: 'The game is over.' });
  }
  // op: match.command's op, { type: 'chat', text } or { type: 'watch', slot }. Tower objects may be passed for ids
  // (tower, and towers for '-destroy').
  command(op) {
    if (!op || typeof op !== 'object') return Promise.resolve({ ok: false, why: 'Bad command.' });
    if (this.lobby.closed || (this.over && op.type !== 'chat')) return Promise.resolve({ ok: false, why: 'The game is over.' });
    if (op.type === 'watch') {
      if (!this.world.lanes[op.slot]) return Promise.resolve({ ok: false, why: 'No such lane.' });
      this.replica.watch(op.slot);
      this.lobby.conn.bin(P.binMsg(C.WATCH).u8(op.slot).finish());
      return Promise.resolve({ ok: true, why: null });
    }
    const wire = { ...op };
    if (wire.tower && typeof wire.tower === 'object') wire.tower = wire.tower.id;
    if (Array.isArray(wire.towers)) wire.towers = wire.towers.map(t => (t && typeof t === 'object' ? t.id : t));
    const rid = ++this.rid;
    return new Promise((resolve) => {
      const timer = this.timers.setTimeout(() => { this.pending.delete(rid); resolve({ ok: false, why: 'No answer from the host.' }); }, 10000);
      this.pending.set(rid, { resolve, timer });
      this.lobby.conn.json(C.CMD, { rid, op: wire });
    });
  }
  result(r) {
    const p = this.pending.get(r.rid);
    if (!p) return;
    this.pending.delete(r.rid); this.timers.clearTimeout(p.timer);
    const out = { ...r }; delete out.rid;
    p.resolve(out);
  }
  tick(realDt) { this.replica.tick(realDt); }
  report() {
    const t = this.lobby.conn.traffic(), ping = this.lobby.conn.ping;
    const peers = this.seats.filter(s => s.kind === 'human' && s.connected).length;
    this.emit('net', { ping: ping === null ? null : Math.round(ping * 1000), peers, up: t.up, down: t.down,
      host: !this.hostLost, resyncs: this.replica.stats.resyncs });
  }
  ended(info) {
    if (this.over) return;
    this.over = true;
    if (info.reason !== 'over') this.timers.clearInterval(this.net);
    for (const p of this.pending.values()) { this.timers.clearTimeout(p.timer); p.resolve({ ok: false, why: 'The game is over.' }); }
    this.pending.clear();
    this.emit('end', info);
  }
  close() { this.lobby.leave(); }
}
