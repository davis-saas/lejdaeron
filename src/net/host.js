// The vs Players host: the lobby, the authoritative Match with its Bots, and one state stream per connected player.
// Pure and environment-free: src/net/host_worker.js runs it in a Web Worker, tools/net_test.mjs runs it in Node.
//
//   const core = new HostCore({ room, send: (peer, buf) => ..., drop: (peer) => ... });
//   core.join(peer); core.receive(peer, buf); core.leave(peer);   // from the transports
//   core.update(nowSeconds);                                      // call often (60 Hz): steps the match and streams
//   core.close();                                                 // the host leaves: the game ends for everyone
//
// The peer id 'local' is the host's own UI: seat 1, and the only peer allowed to change seats, kick and start.
// The host trusts no other peer: every message is size- and rate-limited, may only act for the sender's own seat, and
// game commands are rebuilt field by field and then validated by match.command against the rules.
// With `prove` (src/net/auth.js) the host signs its answers to every HELLO (the welcome, a refusal, or the proof a
// rejoining player asks for before it sends its token), so players can tell the real host from anyone else in the room.
//
// Streaming (see src/net/protocol.js for the bytes): each player gets frames at 15 Hz with the lane they watch (towers,
// every creep, the lane's combat events), the other lanes' creeps and tower hit points at 3 Hz, tower changes of every
// lane as soon as they happen, the board (with tech and Arcade training), their own shop and Arcade stock and the match
// events. Crowded lanes stream at a lower rate. A frame is a delta against what that player already has, so a player who
// misses one asks for a full one.
import { Match, STEP, TPS } from '../match.js?v=91305a8026e8';
import { Bot } from '../bot.js?v=91305a8026e8';
import { LTW_COLORS, LTW_RULES } from '../data/ltw.js?v=91305a8026e8';
import * as P from './protocol.js?v=91305a8026e8';
import * as CFG from './config.js?v=91305a8026e8';
import { NONCE_RE } from './auth.js?v=91305a8026e8';

const { C, H, F, LB, CM, CF, EV } = P;
export const LOCAL = 'local';
const MAX_CATCHUP = 15;                 // ticks per update before the host lets the match run slower than real time
const EVENT_KEEP = 3 * TPS;             // lane events kept for players who fall behind
const SWEEP_EVERY = 5 * TPS;            // tower signature check (catches tower changes no event announced)
const DIFFS = ['easy', 'normal', 'hard', 'insane'];
const KINDS = ['open', 'closed', 'human', 'bot'];
const MAX_PICK = 400;                   // towers one '-destroy' may name (a lane has 320 tiles)
// what a command result may carry back, by type (match.command's results; anything else stays on the host)
const RESULT_NUMBERS = ['tower', 'to', 'n', 'income', 'gold', 'wisps', 'lumber', 'doneAt', 'destroyed'];
const botName = (d) => 'Computer (' + d[0].toUpperCase() + d.slice(1) + ')';
const BOT_NAME = /^computer\s*\(/i;   // a player's name may not look like one of these
const BANNED = 'You were removed from this game.';
const TOO_FAST = 'You are sending messages too fast.';
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
function randomHex(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
// token bucket: rate per second, burst
const bucket = ([rate, burst]) => ({ rate, burst, v: burst, t: null });
function take(b, now) {
  if (b.t !== null) b.v = Math.min(b.burst, b.v + (now - b.t) * b.rate);
  b.t = now;
  if (b.v < 1) return false;
  b.v -= 1; return true;
}

export class HostCore {
  constructor({ room = '', hostName = 'Host', send, drop = () => {}, seats = CFG.MAX_SEATS, seed = null, prove = null, log = () => {} } = {}) {
    this.room = room; this.sendRaw = send; this.dropPeer = drop; this.log = log; this.prove = prove;
    this.seedOverride = seed;
    this.now = 0;
    this.phase = 'lobby';                // 'lobby' | 'playing' | 'closed'
    this.peers = new Map();              // peer id -> { id, local, seat, hello, lastSeen, msg, cmd, chat, strikes, stream }
    this.banned = new Map();             // peer id -> why it was removed (its HELLOs get that as a signed refusal)
    this.seats = [];
    for (let s = 1; s <= seats; s++) this.seats[s] = { slot: s, kind: 'open', name: '', difficulty: 'normal', ready: false, peer: null, token: null, connected: false, dropAt: 0 };
    Object.assign(this.seats[1], { kind: 'human', name: P.cleanName(hostName) || 'Host', ready: true });
    this.options = { extra: LTW_RULES.extra };   // lobby options, passed to the Match (extra: '-onextra' works)
    this.match = null; this.bots = []; this.t0 = null; this.done = 0;
    this.lanes = {};                     // per lane: event log, tower versions
    this.mlog = []; this.mseq = 0;       // match events
    this.sorted = {};                    // per lane: { tick, list } creeps sorted by id
    this.bytes = { frames: 0, frameBytes: 0 };
  }

  // ---------------------------------------------------------------------------------------------------- peers
  join(id) {
    if (this.phase === 'closed' || this.peers.has(id)) return;
    const local = id === LOCAL;
    this.peers.set(id, { id, local, seat: null, hello: false, lastSeen: this.now, msg: bucket(CFG.MSG_RATE),
      cmd: bucket(CFG.CMD_RATE), chat: bucket(CFG.CHAT_RATE), strikes: [], stream: null, ignored: this.banned.has(id) });
  }
  leave(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    const seat = p.seat ? this.seats[p.seat] : null;
    if (!seat || seat.peer !== id) return;
    seat.peer = null; seat.connected = false; seat.dropAt = this.now;
    if (this.phase === 'playing' && this.match) {
      const pl = this.match.players[seat.slot];
      if (pl && pl.alive && !pl.left) this.match.leave(seat.slot, { grace: CFG.REJOIN_GRACE });
    }
    this.lobbyChanged();
  }
  send(id, buf) { this.sendRaw(id, buf); }
  json(id, type, obj) { this.send(id, P.jsonMsg(type, obj)); }
  each(fn) { for (const p of this.peers.values()) if (p.hello && !p.ignored) fn(p); }
  strike(p, why) {
    const now = this.now;
    p.strikes.push(now);
    while (p.strikes.length && p.strikes[0] < now - 60) p.strikes.shift();
    if (p.strikes.length >= CFG.STRIKES && !p.local) {
      this.log('kicking ' + p.id + ' after ' + p.strikes.length + ' rejected messages (' + why + ')');
      this.kickPeer(p, 'Too many invalid messages.', true);
    }
  }
  // ban: the peer stays out (an abuser, or a player kicked during the match); a player the host removes from the lobby
  // may come back, as in a WC3 lobby, from this page as from any other
  kickPeer(p, message, ban) {
    this.json(p.id, H.END, { reason: 'kicked', message });
    p.ignored = true;
    if (ban) this.banned.set(p.id, BANNED);
    const seat = p.seat ? this.seats[p.seat] : null;
    if (seat && seat.peer === p.id) {
      seat.token = null;
      if (this.phase === 'lobby') this.openSeat(seat);
      else if (this.match) { this.match.leave(seat.slot, { grace: 0 }); seat.peer = null; seat.connected = false; }
    }
    p.seat = null;
    this.dropPeer(p.id);
    this.lobbyChanged();
  }

  // ---------------------------------------------------------------------------------------------------- messages
  receive(id, buf) {
    if (!this.peers.has(id) && !this.banned.has(id) && this.phase !== 'closed') {
      // a peer the host timed out but whose link is still up: it must say hello again (its token gets its seat back)
      this.join(id);
      const m = P.readMsg(buf, CFG.MAX_MESSAGE);
      if (!m || m.type !== C.HELLO) { this.json(id, H.ERROR, { rehello: true, message: 'Reconnecting.' }); return; }
    }
    const p = this.peers.get(id);
    if (!p || this.phase === 'closed') return;
    if (p.ignored) return this.turnAway(p, buf);
    p.lastSeen = this.now;
    if (!p.local && !take(p.msg, this.now)) return this.strike(p, 'rate');
    const m = P.readMsg(buf, p.local ? Infinity : CFG.MAX_MESSAGE);
    if (!m) return this.strike(p, 'unreadable');
    try {
      if (!p.hello) {
        if (m.type === C.HELLO) this.hello(p, m.json);
        else if (m.type !== C.PING) this.strike(p, 'before hello');
        if (m.type === C.PING) this.pong(p, m.r);
        return;
      }
      switch (m.type) {
        case C.PING: return this.pong(p, m.r);
        case C.LOBBY: return this.lobbyOp(p, m.json);
        case C.CMD: return this.command(p, m.json);
        case C.WATCH: return this.watch(p, m.r.u8());
        case C.RESYNC: if (p.stream && this.now - p.stream.lastFull > 1) p.stream.full = true; return;
        case C.LEAVE: return this.quit(p);
        case C.HELLO: {   // already in: the welcome went missing, or the player's page reconnected; say it again
          const nonce = nonceOf(m.json);
          if (!this.seats[p.seat] || p.greeting) return;
          if (m.json.rejoin === true && !m.json.token) return this.answer(p, nonce, 'hello', (proof) => this.json(p.id, H.PROOF, { proof }));
          return this.answer(p, nonce, 'welcome', (proof) => this.welcome(p, proof));
        }
        default: return this.strike(p, 'unknown type');
      }
    } catch (e) {
      this.strike(p, 'bad message');
    }
  }
  // A removed player trying again from the same page is told so (signed, as every answer to a HELLO), not left to time
  // out; everything else from an ignored peer is dropped.
  turnAway(p, buf) {
    const why = this.banned.get(p.id);
    if (!why || !take(p.msg, this.now)) return;
    const m = P.readMsg(buf, CFG.MAX_MESSAGE);
    if (m && m.type === C.HELLO) this.refuse(p, nonceOf(m.json), why);
  }
  pong(p, r) {
    const t = r.f64();
    const w = P.binMsg(H.PONG).f64(Number.isFinite(t) ? t : 0).u32(this.match ? this.match.ticks : 0);
    this.send(p.id, w.finish());
  }

  hello(p, msg) {
    const nonce = nonceOf(msg);
    if (msg.v !== P.PROTO || msg.data !== P.DATA_SIG) return this.refuse(p, nonce, 'Your game version differs from the host\'s. Reload the page (and ask the host to reload too).');
    if (p.greeting) return;   // a repeat while the answer to the first one is being signed
    // a player with a rejoin token first asks the host to prove itself, and sends the token only to a proven host
    if (msg.rejoin === true && !msg.token) return this.answer(p, nonce, 'hello', (proof) => this.json(p.id, H.PROOF, { proof }));
    const name = P.cleanName(msg.name);
    const token = typeof msg.token === 'string' && /^[0-9a-f]{32}$/.test(msg.token) ? msg.token : null;
    let seat = null;
    if (p.local) seat = this.seats[1];
    else if (token) seat = this.seats.find(s => s && s.kind === 'human' && s.token === token && s.slot !== 1) || null;
    if (seat && seat.peer && seat.peer !== p.id) {   // the same player from a new connection: the old one is stale
      const old = this.peers.get(seat.peer);
      if (old) { this.json(old.id, H.END, { reason: 'replaced', message: 'You joined this game from another tab.' }); old.seat = null; old.ignored = true; }
    }
    if (!seat) {
      if (this.phase !== 'lobby') return this.refuse(p, nonce, 'This game has already started.');
      seat = this.seats.find(s => s && s.kind === 'open');
      if (!seat) return this.refuse(p, nonce, 'This game is full.');
      Object.assign(seat, { kind: 'human', name: this.nameFor(seat, name || 'Player ' + seat.slot), ready: false, token: randomHex(16) });
    } else if (name && seat.slot !== 1 && this.phase === 'lobby') seat.name = this.nameFor(seat, name);
    if (p.local) { seat.name = this.nameFor(seat, name || seat.name); seat.token = null; }
    seat.peer = p.id; seat.connected = true;
    p.seat = seat.slot;
    this.lobbyChanged();   // everyone else sees the seat taken now; the player gets the lobby with its welcome
    this.answer(p, nonce, 'welcome', (proof) => this.welcome(p, proof));
  }
  // The welcome (signed for the player's nonce), the lobby and, in a match, the stream from a full frame.
  welcome(p, proof) {
    const seat = this.seats[p.seat];
    if (this.phase === 'closed' || p.ignored || this.peers.get(p.id) !== p || !seat || seat.peer !== p.id) return;
    p.hello = true;
    this.json(p.id, H.WELCOME, { v: P.PROTO, room: this.room, you: seat.slot, token: seat.token, phase: this.phase, host: p.local, proof });
    this.json(p.id, H.LOBBY, this.lobbyState());
    if (this.phase === 'playing' && this.match) {
      const pl = this.match.players[seat.slot];
      if (pl && pl.left && pl.alive) this.match.rejoin(seat.slot);
      if (!p.stream || this.now - p.stream.lastFull > 1) this.startStream(p, true);
    }
  }
  refuse(p, nonce, message) { this.answer(p, nonce, 'refuse:' + message, (proof) => this.json(p.id, H.ERROR, { fatal: true, message, proof })); }
  // Answers a HELLO: signed when the host has a key (the host's own UI, and a player too old to send a nonce, get the
  // answer unsigned and at once). One signature at a time per peer; a HELLO meanwhile waits for it.
  answer(p, nonce, what, send) {
    if (!this.prove || p.local || !nonce) return send(null);
    if (p.proof && p.proof.nonce === nonce && p.proof.what === what) return send(p.proof.proof);
    p.greeting = true;
    Promise.resolve().then(() => this.prove(p.id, nonce, what)).then((proof) => {
      p.greeting = false; p.proof = { nonce, what, proof };
      send(proof);
    }, (e) => { p.greeting = false; this.log('could not sign an answer: ' + (e && e.message || e)); });
  }
  lobbyState() {
    return { room: this.room, phase: this.phase, options: { ...this.options }, seats: this.seats.filter(Boolean).map(s => ({ slot: s.slot, kind: s.kind,
      name: s.kind === 'open' || s.kind === 'closed' ? '' : s.name, difficulty: s.kind === 'bot' ? s.difficulty : null,
      ready: s.kind === 'bot' || s.slot === 1 || s.ready, connected: s.kind === 'bot' || s.connected, color: LTW_COLORS[s.slot] })) };
  }
  lobbyChanged() {
    if (this.phase === 'closed') return;
    const buf = P.jsonMsg(H.LOBBY, this.lobbyState());
    this.each(p => this.send(p.id, buf.slice(0)));
  }
  openSeat(seat) { Object.assign(seat, { kind: 'open', name: '', ready: false, peer: null, token: null, connected: false }); }
  lobbyOp(p, op) {
    const seat = this.seats[p.seat];
    if (!seat) return;
    switch (op.op) {
      // every change goes out to everyone, so changes share the command budget (unused before the match)
      case 'name': {   // a new name is announced in every lobby's chat, so it shares the chat budget
        const name = P.cleanName(op.name);
        if (!name || this.phase !== 'lobby' || name === seat.name) return;
        if (!p.local && !take(p.chat, this.now)) return this.tooFast(p);
        seat.name = this.nameFor(seat, name); return this.lobbyChanged();
      }
      case 'ready':
        if (this.phase !== 'lobby' || seat.ready === !!op.ready) return;
        if (!p.local && !take(p.cmd, this.now)) return this.strike(p, 'lobby rate');
        seat.ready = !!op.ready; return this.lobbyChanged();
      case 'chat': return this.chat(p, op.text, 'lobby');
      case 'seat': case 'kick': case 'start': case 'options':
        if (!p.local) return this.strike(p, 'host only');
        if (op.op === 'start') return this.start();
        if (op.op === 'kick') return this.kickSlot(op.slot);
        if (op.op === 'options') return this.setOptions(op);
        return this.setSeat(op.slot, op);
      default: return this.strike(p, 'unknown lobby op');
    }
  }
  setSeat(slot, { kind, difficulty }) {
    if (this.phase !== 'lobby' || !P.isInt(slot, 2, this.seats.length - 1) || !KINDS.includes(kind) || kind === 'human') return;
    const seat = this.seats[slot];
    if (seat.kind === 'human') {
      const p = this.peers.get(seat.peer);
      if (p) { this.json(p.id, H.END, { reason: 'kicked', message: 'The host gave your seat away.' }); p.seat = null; p.ignored = true; }
    }
    this.openSeat(seat);
    seat.kind = kind;
    if (kind === 'bot') { seat.difficulty = DIFFS.includes(difficulty) ? difficulty : 'normal'; seat.name = botName(seat.difficulty); }
    this.lobbyChanged();
  }
  setOptions({ extra }) {
    if (this.phase !== 'lobby' || typeof extra !== 'boolean') return;
    this.options.extra = extra;
    this.lobbyChanged();
  }
  kickSlot(slot) {
    if (!P.isInt(slot, 2, this.seats.length - 1)) return;
    const seat = this.seats[slot];
    if (seat.kind !== 'human') return;
    // in a match the host kicks as Red does with '-kick <colour>': "Kicked" on the board, then out (harvest drops the peer;
    // once the match is over nothing is harvested any more, so then it is a plain kick)
    if (this.match && this.phase === 'playing' && this.match.phase !== 'over' && this.match.kick(slot, 1)) return;
    const p = this.peers.get(seat.peer);
    if (p) this.kickPeer(p, 'The host removed you from the game.', this.phase !== 'lobby');
    else if (this.phase === 'lobby') { this.openSeat(seat); this.lobbyChanged(); }
    else { seat.token = null; if (this.match) this.match.leave(slot, { grace: 0 }); }
  }
  chat(p, text, at) {
    const line = P.cleanChat(text);
    if (!line) return;
    if (!p.local && !take(p.chat, this.now)) return this.tooFast(p);
    this.say(p, line, at);
  }
  // A lobby line or rename over the chat budget: the sender is told (at most once a second), it is not just lost.
  tooFast(p) {
    if (p.toldAt !== undefined && this.now - p.toldAt < 1) return;
    p.toldAt = this.now;
    this.json(p.id, H.ERROR, { message: TOO_FAST });
  }
  // A name nobody else in the game has (whatever the case), and none that passes for a computer player's: a second
  // 'Ann' becomes 'Ann 2'.
  nameFor(seat, wanted) {
    const base = BOT_NAME.test(wanted) ? 'Player ' + seat.slot : wanted;
    const taken = new Set(this.seats.filter(s => s && s !== seat && (s.kind === 'human' || s.kind === 'bot')).map(s => s.name.toLowerCase()));
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = base.slice(0, 15 - String(k).length).trimEnd() + ' ' + k;
    return name;
  }
  say(p, line, at) {
    const seat = this.seats[p.seat];
    const buf = P.jsonMsg(H.CHAT, { slot: seat.slot, name: seat.name, text: line, at });
    this.each(q => this.send(q.id, buf.slice(0)));
  }
  // Chat during the match goes through match.command, so the map's chat commands run (-income, -destroy, -onextra,
  // -kick ...) and everyone gets the line as a 'chat' match event. After the match, or for a player who has left the
  // match, it is a plain chat line.
  gameChat(p, op) {
    const text = P.cleanChat(op.text);
    if (!text) return { ok: false, why: 'Nothing to say.' };
    if (!p.local && !take(p.chat, this.now)) return { ok: false, why: TOO_FAST };
    if (this.match && this.phase === 'playing' && p.stream) {
      const r = this.match.command(p.seat, picked({ type: 'chat', text }, op));
      if (r.ok) return result(r);
    }
    this.say(p, text, 'game');
    return { ok: true, why: null, command: null };
  }
  quit(p) {
    const seat = this.seats[p.seat];
    if (!seat || seat.peer !== p.id) return;
    p.seat = null; p.ignored = true;
    if (seat.slot === 1) return this.close();
    seat.token = null;
    if (this.phase === 'lobby') this.openSeat(seat);
    else { seat.peer = null; seat.connected = false; if (this.match) this.match.leave(seat.slot, { grace: 0 }); }
    this.lobbyChanged();
  }
  // The host leaves: everyone gets a clear message and the game is over.
  close(message = 'The host left. The game is over.') {
    if (this.phase === 'closed') return;
    this.each(p => { if (!p.local) this.json(p.id, H.END, { reason: 'host-left', message }); });
    this.phase = 'closed';
  }

  // ---------------------------------------------------------------------------------------------------- the match
  start() {
    if (this.phase !== 'lobby') return;
    const seats = this.seats.filter(s => s && (s.kind === 'human' || s.kind === 'bot'));
    const fail = (message) => { const p = this.peers.get(LOCAL); if (p) this.json(p.id, H.ERROR, { message }); };
    if (seats.length < 2) return fail('You need at least two players. Open a seat for a friend or add a computer.');
    const waiting = seats.filter(s => s.kind === 'human' && (!s.connected || (!s.ready && s.slot !== 1)));
    if (waiting.length) return fail('Waiting for ' + waiting.map(s => s.name).join(', ') + ' to be ' + (waiting.some(s => !s.connected) ? 'connected and ' : '') + 'ready.');
    const slots = seats.map(s => ({ slot: s.slot, name: s.name, kind: s.kind, difficulty: s.kind === 'bot' ? s.difficulty : null }));
    const seed = this.seedOverride ?? (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] || 1);
    this.match = new Match({ slots, seed, options: this.options });
    this.bots = slots.filter(s => s.kind === 'bot').map(s => new Bot(this.match, s.slot, s.difficulty));
    this.phase = 'playing'; this.t0 = null; this.done = 0;
    for (const s of this.match.ring) this.lanes[s] = { log: [], seq: 0, ver: 0, mark: new Map(), removed: [], trimmed: 0, sig: new Map() };
    for (const s of this.seats) if (s && s.kind === 'open') s.kind = 'closed';
    this.lobbyChanged();
    for (const p of this.peers.values()) if (p.hello && !p.ignored && p.seat) this.startStream(p, false);
  }
  startStream(p, rejoin) {
    const m = this.match, slot = p.seat;
    const players = m.ring.map(s => { const q = m.players[s]; return { slot: s, name: q.name, color: q.color, kind: q.kind, difficulty: q.difficulty }; });
    this.json(p.id, H.START, { you: slot, ring: m.ring, players, seed: m.seed, options: { ...m.options }, rejoin });
    const lanes = {};
    for (const s of m.ring) lanes[s] = { ...laneState(), ev: this.lanes[s].seq };
    p.stream = { slot, watch: m.players[slot] ? slot : m.ring[0], seq: 0, full: true, lastFull: -1e9, lanes, board: {}, tech: {},
      shop: [], arcade: null, mev: this.mseq, phase: null, results: p.stream ? p.stream.results : [], next: 0, bytes: 0 };
  }
  watch(p, slot) {
    const st = p.stream;
    if (!st || !this.match || !this.match.players[slot] || st.watch === slot) return;
    st.watch = slot;
    const cs = st.lanes[slot];
    cs.ev = this.lanes[slot].seq; cs.due = 0;
  }
  // A game command: rebuilt from known fields only, then validated by the match itself.
  command(p, msg) {
    const rid = P.isInt(msg.rid, 0, 2 ** 31) ? msg.rid : null;
    const reply = (r) => { if (rid === null) return; if (p.stream) p.stream.results.push({ rid, ...r }); else this.json(p.id, H.RESULT, { rid, ...r }); };
    const op = msg.op && typeof msg.op === 'object' ? msg.op : {};
    if (op.type === 'chat') return reply(this.gameChat(p, op));
    if (!this.match || this.phase !== 'playing' || !p.stream) return reply({ ok: false, why: 'The game has not started.' });
    // over the command budget: refused, but not held against the player (holding a send key runs into it; a real flood
    // trips the message limit)
    if (!p.local && !take(p.cmd, this.now)) return reply({ ok: false, why: 'Too many commands.' });
    let clean = null;
    switch (op.type) {
      case 'build': if (P.isId(op.id) && P.isInt(op.c, 0, 255) && P.isInt(op.r, 0, 255)) clean = { type: 'build', id: op.id, c: op.c, r: op.r }; break;
      case 'upgrade': if (P.isInt(op.tower, 1, 2 ** 32) && P.isId(op.id)) clean = { type: 'upgrade', tower: op.tower, id: op.id }; break;
      case 'sell': if (P.isInt(op.tower, 1, 2 ** 32)) clean = { type: 'sell', tower: op.tower }; break;
      case 'send': if (P.isId(op.unit)) clean = { type: 'send', unit: op.unit }; break;
      case 'tech': if (P.isId(op.id)) clean = { type: 'tech', id: op.id }; break;
      case 'arcade': if (op.item === 'lumber' || op.item === 'wisp') clean = { type: 'arcade', item: op.item }; break;
      case 'destroy': {
        const d = picked({ type: 'destroy' }, op);
        if (d.tower !== undefined || d.towers || d.tech) clean = d;
        break;
      }
    }
    if (!clean) { this.strike(p, 'bad command'); return reply({ ok: false, why: 'Unknown command.' }); }
    reply(result(this.match.command(p.seat, clean)));
  }

  // ---------------------------------------------------------------------------------------------------- driving
  update(now) {
    this.now = now;
    if (this.phase === 'closed') return;
    for (const p of [...this.peers.values()]) if (!p.local && now - p.lastSeen > CFG.PEER_SILENT_AFTER) { this.leave(p.id); this.dropPeer(p.id); }
    if (this.phase === 'lobby') {
      for (const s of this.seats) if (s && s.kind === 'human' && s.slot !== 1 && !s.connected && now - s.dropAt > CFG.REJOIN_GRACE) { this.openSeat(s); this.lobbyChanged(); }
      return;
    }
    const m = this.match;
    if (!m) return;
    if (this.t0 === null) this.t0 = now - STEP;
    let due = Math.floor((now - this.t0) * TPS + 1e-6) - this.done;
    if (due > MAX_CATCHUP) { this.t0 += (due - MAX_CATCHUP) / TPS; due = MAX_CATCHUP; }
    let stepped = false;
    for (let i = 0; i < due; i++) {
      this.done++;
      if (m.phase === 'over') continue;
      m.step(STEP);
      for (const b of this.bots) {
        try { b.tick(STEP); }
        catch (e) { this.botFailed(b, e); }
      }
      this.harvest();
      stepped = true;
      if (m.ticks % SWEEP_EVERY === 0) this.sweep();
    }
    if (stepped || [...this.peers.values()].some(p => p.stream && (p.stream.results.length || p.stream.full))) this.stream();
  }
  // A bot that throws stops playing (its lane plays on without it) rather than stopping the match for everyone.
  botFailed(b, e) {
    this.log(`bot ${b.slot} stopped: ${e && e.stack || e}`);
    b.tick = () => {};
    const p = this.peers.get(LOCAL);
    if (p) this.json(p.id, H.ERROR, { message: `Computer player ${b.slot} stopped.` });
  }
  // Moves this tick's events into the logs and tracks tower changes, then clears them (bots have already ticked).
  harvest() {
    const m = this.match, tick = m.ticks;
    for (const s of m.ring) {
      const lane = m.lanes[s], L = this.lanes[s];
      for (const e of lane.events) {
        L.log.push({ seq: ++L.seq, tick, e });
        const t = e.tower;
        if (t) {
          if (e.type === 'build' || e.type === 'upgrade' || e.type === 'selling') this.touch(L, t);
          else if (e.type === 'sell' || e.type === 'remove') this.gone(L, t.id, !!t.destroyed);
        }
      }
      if (L.log.length && L.log[0].tick < tick - EVENT_KEEP) { let k = 0; while (k < L.log.length && L.log[k].tick < tick - EVENT_KEEP) k++; L.log.splice(0, k); }
    }
    for (const e of m.events) {
      this.mlog.push({ seq: ++this.mseq, tick: Math.round(e.t * TPS), e });
      if (e.type === 'kicked') this.kicked(e.slot);
    }
    if (this.mlog.length > 2000) this.mlog.splice(0, this.mlog.length - 1000);
    m.clearEvents();
  }
  // Red's '-kick <colour>' (or lobby.kick during the match): the match has defeated the player; their link goes too,
  // and their token, so they can't come back.
  kicked(slot) {
    const seat = this.seats[slot];
    if (!seat || seat.kind !== 'human') return;
    seat.token = null;
    const p = this.peers.get(seat.peer);
    if (p && !p.local) {
      this.json(p.id, H.END, { reason: 'kicked', message: 'The host removed you from the game.' });
      p.seat = null; p.ignored = true; this.banned.set(p.id, BANNED);
      seat.peer = null; seat.connected = false;
      this.dropPeer(p.id);
    }
    this.lobbyChanged();
  }
  touch(L, t) { L.mark.set(t.id, ++L.ver); L.sig.set(t.id, towerSig(t)); }
  gone(L, id, destroyed = false) {
    if (!L.mark.delete(id)) return;
    L.sig.delete(id);
    L.removed.push({ id, ver: ++L.ver, destroyed });
    if (L.removed.length > 600) L.trimmed = L.removed.splice(0, 300).pop().ver;
  }
  sweep() {
    for (const s of this.match.ring) {
      const lane = this.match.lanes[s], L = this.lanes[s], seen = new Set();
      for (const t of lane.towers) { seen.add(t.id); if (L.sig.get(t.id) !== towerSig(t)) this.touch(L, t); }
      for (const id of [...L.mark.keys()]) if (!seen.has(id)) this.gone(L, id);
    }
  }
  sortedCreeps(s) {
    const m = this.match;
    let c = this.sorted[s];
    if (!c || c.tick !== m.ticks) {
      const list = m.lanes[s].creeps.filter(k => !k.dead);
      list.sort((a, b) => a.id - b.id);
      c = this.sorted[s] = { tick: m.ticks, list };
    }
    return c.list;
  }
  stream() {
    const tick = this.match.ticks;
    for (const p of this.peers.values()) {
      const st = p.stream;
      if (!st || p.ignored) continue;
      if (st.full || st.results.length || tick >= st.next) {
        const buf = this.frame(st, tick);
        if (buf) { const size = buf.byteLength; st.bytes += size; this.bytes.frames++; this.bytes.frameBytes += size; this.send(p.id, buf); }
        if (tick >= st.next) st.next = tick - tick % CFG.NET_TICKS + CFG.NET_TICKS;
      }
      for (const r of st.results) this.json(p.id, H.RESULT, r);
      st.results.length = 0;
    }
  }

  // ---------------------------------------------------------------------------------------------------- frames
  // One client's frame; null if there is nothing new to tell them.
  frame(st, tick) {
    const m = this.match, full = st.full, w = new P.Writer(full ? 16384 : 2048);
    w.u8(H.FRAME);
    const flagsAt = w.pos(); w.u8(0);
    w.uv(st.seq + 1).u32(tick);
    let flags = full ? F.FULL : 0, any = full;
    if (full) { st.board = {}; st.tech = {}; st.shop = []; st.arcade = null; st.lastFull = this.now; for (const s of m.ring) Object.assign(st.lanes[s], laneState()); }
    const phase = [m.phase, m.winner, m.extra.on, m.extra.slot].join(',');
    if (full || st.phase !== phase) {
      flags |= F.PHASE; any = true;
      w.u8(P.PHASES.indexOf(m.phase)).u8(m.winner || 0).u8(m.extra.on ? 1 : 0).u8(m.extra.slot || 0);
      st.phase = phase;
    }
    // board
    let at = w.pos(), n = 0;
    w.u8(0);
    for (const s of m.ring) {
      const q = m.players[s], ls = m.lanes[s].stats;
      const sig = [q.gold, q.income, q.lives, q.lumber, q.wisps, q.kills, q.alive, q.left, q.kicked, q.eliminatedBy, ls.kills, ls.leaks, ls.built, ls.destroyed].join(',');
      if (st.board[s] === sig) continue;
      st.board[s] = sig; n++;
      w.u8(s).u8((q.alive ? 1 : 0) | (q.left ? 2 : 0) | (q.kicked ? 4 : 0)).num(q.gold).num(q.income).num(q.lives).num(q.lumber).num(q.wisps).num(q.kills).u8(q.eliminatedBy || 0);
      w.num(ls.kills).num(ls.leaks).num(ls.built).num(ls.destroyed || 0);
    }
    if (n) { w.patch8(at, n); flags |= F.BOARD; any = true; } else w.n = at;
    // what changes rarely: tech buildings, Arcade wisps in training, elimination time, the board label
    at = w.pos(); n = 0; w.u8(0);
    for (const s of m.ring) {
      const q = m.players[s], tech = q.tech || [], training = q.training || [];
      const sig = [q.eliminatedAt, q.label, tech.join('.'), training.map(x => x.doneAt).join('.')].join(',');
      if (st.tech[s] === sig) continue;
      st.tech[s] = sig; n++;
      const elim = typeof q.eliminatedAt === 'number', label = typeof q.label === 'string';
      w.u8(s).u8((elim ? 1 : 0) | (label ? 2 : 0));
      if (elim) w.num(q.eliminatedAt);
      if (label) w.str(q.label.slice(0, 32));
      const known = tech.filter(id => P.TECH_INDEX[id] !== undefined).slice(0, 255);
      w.u8(known.length); for (const id of known) w.u8(P.TECH_INDEX[id]);
      w.u8(Math.min(255, training.length)); for (const x of training.slice(0, 255)) w.num(x.doneAt);
    }
    if (n) { w.patch8(at, n); flags |= F.TECH; any = true; } else w.n = at;
    // shop and Arcade stock of the player's own slot
    if (m.players[st.slot]) {
      at = w.pos(); n = 0; w.u8(0);
      for (let i = 0; i < P.SOLD.length; i++) {
        const k = m.stockOf(st.slot, P.SOLD[i]);
        const sig = stockSig(k);
        if (st.shop[i] === sig) continue;
        st.shop[i] = sig; n++;
        w.u8(i).u8(Math.min(255, k.count)).u8((k.open ? 1 : 0) | (k.next !== null ? 2 : 0));
        if (k.next !== null) w.u32(k.next);
      }
      if (n) { w.patch8(at, n); flags |= F.SHOP; any = true; } else w.n = at;
      const k = m.arcadeStock(st.slot), sig = stockSig(k);
      if (st.arcade !== sig) {
        st.arcade = sig; flags |= F.ARCADE; any = true;
        w.u8(Math.min(255, k.count)).u8((k.open ? 1 : 0) | (k.next !== null ? 2 : 0));
        if (k.next !== null) w.u32(k.next);
      }
    }
    // lanes
    at = w.pos(); n = 0; w.u8(0);
    for (const s of m.ring) if (this.laneBlock(w, st, s, tick, full)) n++;
    if (n) { w.patch8(at, n); any = true; }
    // match events
    if (this.mseq > st.mev) {
      const list = [];
      for (const x of this.mlog) {
        if (x.seq <= st.mev) continue;
        if (x.e.type === 'message' && x.e.to !== null && x.e.to !== st.slot) continue;
        list.push({ ...x.e, tick: x.tick });
      }
      st.mev = this.mseq;
      if (list.length) { flags |= F.MEVENTS; w.str(JSON.stringify(list)); any = true; }
    }
    if (!any) return null;
    w.patch8(flagsAt, flags);
    st.seq++; st.full = false;
    return w.finish();
  }
  laneBlock(w, st, s, tick, full) {
    const lane = this.match.lanes[s], L = this.lanes[s], cs = st.lanes[s], watched = s === st.watch;
    const due = tick >= cs.due || full;
    const list = this.sortedCreeps(s);
    const towers = cs.ver !== L.ver;
    const creeps = due && (list.length > 0 || cs.ids.length > 0);
    const events = due && watched && L.seq > cs.ev;
    let period = cs.period || CFG.NET_TICKS;
    if (due) {
      // the watched lane every NET_TICKS, the others every OTHER_TICKS, both slower when crowded; other lanes are
      // spread over the 4-tick grid so their updates don't all land in the same frame
      const base = watched ? CFG.NET_TICKS : CFG.OTHER_TICKS, crowd = watched ? CFG.WATCH_CROWD : CFG.OTHER_CROWD;
      period = cs.period = base * clamp(Math.ceil(list.length / crowd), 1, CFG.MAX_SLOWDOWN);
      const phase = watched ? tick % period : (s * CFG.NET_TICKS) % period;
      cs.due = tick + period - (((tick - phase) % period) + period) % period;
      if (!watched) cs.ev = L.seq;
    }
    if (!towers && !creeps && !events && !(due && lane.towers.length)) return false;
    w.u8(s); const bitsAt = w.pos(); w.u8(0);
    let bits = 0;
    if (towers) { bits |= LB.TOWERS; this.writeTowers(w, lane, L, cs); }
    const prev = { ids: cs.ids };
    if (creeps) { bits |= LB.CREEPS; w.u8(period); this.writeCreeps(w, list, cs, this.match.time, lane); }
    if (due && this.writeTowerStats(w, lane, cs)) bits |= LB.TSTATS;
    if (events) { bits |= LB.EVENTS; this.writeEvents(w, L, cs, tick, prev); }
    if (!bits) { w.n = bitsAt - 1; return false; }
    w.patch8(bitsAt, bits);
    return true;
  }
  writeTowers(w, lane, L, cs) {
    const fullList = cs.ver === 0 || cs.ver < L.trimmed;
    const base = fullList ? 0 : cs.ver;
    w.uv(base).uv(L.ver);
    const up = fullList ? lane.towers : lane.towers.filter(t => (L.mark.get(t.id) || 0) > base);
    w.uv(up.length);
    if (fullList) cs.ts.clear();
    for (const t of up) {
      const selling = t.sellAt !== undefined, building = t.building > 0;
      w.uv(t.id).u8(P.TOWER_INDEX[t.def.id] ?? 0).u8(t.c).u8(t.r).u8((selling ? 1 : 0) | (building ? 2 : 0));
      if (building) w.u8(clamp(Math.round(t.building * P.BT), 1, 255)).u8(clamp(Math.round((t.buildTotal || 1) * P.BT), 1, 255));
      if (selling) w.u8(clamp(Math.round((t.sellAt - lane.time) * P.BT), 0, 255));
      const hp = towerHp(t), kills = t.kills || 0;
      w.num(t.spent).uv(hp).uv(Math.max(0, Math.ceil(t.maxHp || 0))).uv(kills);
      cs.ts.set(t.id, hp * KILLS + kills);
    }
    const rm = fullList ? [] : L.removed.filter(x => x.ver > base);
    w.uv(rm.length);
    for (const x of rm) { w.uv(x.id * 2 + (x.destroyed ? 1 : 0)); cs.ts.delete(x.id); }
    cs.ver = L.ver;
  }
  // Hit points (attackers, regeneration) and kills of the lane's towers that changed since this client last heard.
  writeTowerStats(w, lane, cs) {
    const list = [];
    for (const t of lane.towers) {
      const hp = towerHp(t), kills = t.kills || 0, sig = hp * KILLS + kills;
      if (cs.ts.get(t.id) !== sig) { cs.ts.set(t.id, sig); list.push(t.id, hp, kills); }
    }
    if (!list.length) return false;
    w.uv(list.length / 3);
    for (const v of list) w.uv(v);
    return true;
  }
  writeCreeps(w, list, cs, now, lane) {
    const n = list.length, pids = cs.ids, pqx = cs.qx, pqy = cs.qy, php = cs.hp, pfl = cs.fl, pta = cs.ta, pn = pids.length;
    const ids = new Array(n), qxs = new Array(n), qys = new Array(n), hps = new Array(n), fls = new Array(n), tas = new Array(n);
    w.uv(n);
    let last = 0, pi = 0;
    for (let i = 0; i < n; i++) {
      const c = list[i];
      const qx = clamp(Math.round(c.x * P.Q), 0, 65535), qy = clamp(Math.round(c.y * P.Q), 0, 65535);
      const hp = clamp(Math.round(c.hp / (c.maxHp || 1) * P.HPQ), 0, P.HPQ);
      const fl = creepFlags(c, now, lane), ta = targetRef(c.attacking);
      ids[i] = c.id; qxs[i] = qx; qys[i] = qy; hps[i] = hp; fls[i] = fl; tas[i] = ta;
      w.uv(c.id - last); last = c.id;
      while (pi < pn && pids[pi] < c.id) pi++;
      if (pi < pn && pids[pi] === c.id) {
        const dx = qx - pqx[pi], dy = qy - pqy[pi];
        let mask = 0;
        if (dx || dy) mask |= Math.abs(dx) < 8192 && Math.abs(dy) < 8192 ? CM.DELTA : CM.ABS;
        if (hp !== php[pi]) mask |= CM.HP;
        if (fl !== pfl[pi]) mask |= CM.FLAGS;
        if (ta !== pta[pi]) mask |= CM.TARGET;
        w.u8(mask);
        if (mask & CM.DELTA) w.sv(dx).sv(dy);
        if (mask & CM.ABS) w.u16(qx).u16(qy);
        if (mask & CM.HP) w.u16(hp);
        if (mask & CM.FLAGS) w.uv(fl);
        if (mask & CM.TARGET) w.uv(ta);
      } else {
        w.u8(CM.NEW | (ta ? CM.TARGET : 0)).u8(P.UNIT_INDEX[c.def.id] ?? 0).u8(c.owner || 0).num(c.maxHp).u16(qx).u16(qy).u16(hp).uv(fl);
        if (ta) w.uv(ta);
      }
    }
    cs.ids = ids; cs.qx = qxs; cs.qy = qys; cs.hp = hps; cs.fl = fls; cs.ta = tas;
  }
  // The watched lane's combat events since the last frame. A creep the client never had (spawned and gone between two
  // frames) travels inline with its look and position so its death or leak can still be drawn.
  writeEvents(w, L, cs, tick, prev) {
    const known = (id) => has(cs.ids, id) || has(prev.ids, id);
    const ref = (c) => {
      if (!c) { w.uv(0); return; }
      if (known(c.id)) { w.uv(c.id * 2); return; }
      w.uv(c.id * 2 + 1).u8(P.UNIT_INDEX[c.def.id] ?? 0).u8(c.owner || 0)
        .u16(clamp(Math.round(c.x * P.Q), 0, 65535)).u16(clamp(Math.round(c.y * P.Q), 0, 65535));
    };
    const what = (x) => {   // an attacker's target: a tower or a creep
      if (!x) w.u8(0);
      else if (isTower(x)) w.u8(1).uv(x.id);
      else { w.u8(2); ref(x); }
    };
    const xy = (x, y) => w.u16(clamp(Math.round(x * P.Q), 0, 65535)).u16(clamp(Math.round(y * P.Q), 0, 65535));
    let start = 0;
    while (start < L.log.length && L.log[start].seq <= cs.ev) start++;
    const list = L.log.slice(start, start + 4000);
    w.uv(list.length);
    for (const { tick: et, e } of list) {
      w.u8(clamp(tick - et, 0, 255));
      switch (e.type) {
        case 'shot': w.u8(EV.shot).uv(e.tower.id); ref(e.target); break;
        case 'impact': w.u8(EV.impact).uv(e.tower.id); ref(e.creep); xy(e.x, e.y); break;
        case 'death': w.u8(EV.death); ref(e.creep); w.num(e.gold || 0).u8(e.fix ? 1 : 0).u8(e.to || 0); break;
        case 'leak': w.u8(EV.leak); ref(e.creep); break;
        case 'bash': w.u8(EV.bash); ref(e.creep); break;
        case 'spawn': w.u8(EV.spawn); ref(e.creep); ref(e.from); break;
        case 'build': case 'upgrade': case 'selling': w.u8(EV[e.type]).uv(e.tower.id); break;
        case 'sell': w.u8(EV.sell).uv(e.tower.id).num(e.gold || 0); break;
        case 'remove':
          if (e.tower) w.u8(EV.removeTower).uv(e.tower.id).u8(e.reason === 'destroyed' ? 1 : 0);
          else { w.u8(EV.removeCreep); ref(e.creep); }
          break;
        case 'attack': w.u8(EV.attack); ref(e.creep); what(e.target); break;
        case 'damaged': w.u8(EV.damaged).uv(e.tower.id); ref(e.creep); w.fix(e.amount).fix(e.hp); break;
        case 'hurt': w.u8(EV.hurt); ref(e.creep); ref(e.by); w.u8(e.owner || 0).fix(e.amount).fix(e.hp); break;
        case 'destroyed': w.u8(EV.destroyed).uv(e.tower.id); ref(e.by); w.u8(Math.max(0, P.DESTROY_REASONS.indexOf(e.reason))); break;
        case 'blast': w.u8(EV.blast); xy(e.x, e.y); w.u8(e.owner || 0).num(e.radius || 0); ref(e.creep); break;
        case 'reincarnate': w.u8(EV.reincarnate); ref(e.creep); w.num(e.at); break;
        case 'reborn': w.u8(EV.reborn); ref(e.creep); break;
        case 'evade': w.u8(EV.evade); ref(e.creep); ref(e.by); break;
        default: {   // events the engine adds later: plain fields, with tower and creep objects as ids
          const o = {};
          for (const [k, v] of Object.entries(e)) {
            if (v && typeof v === 'object') { if (typeof v.id === 'number') o[k] = { id: v.id, kind: isTower(v) ? 'tower' : 'creep' }; }
            else o[k] = v;
          }
          w.u8(EV.other).str(JSON.stringify(o));
        }
      }
    }
    cs.ev = list.length ? list[list.length - 1].seq : cs.ev;
  }

  // ---------------------------------------------------------------------------------------------------- reporting
  status() {
    return { phase: this.phase, room: this.room, peers: [...this.peers.values()].map(p => ({ id: p.id, seat: p.seat, bytes: p.stream ? p.stream.bytes : 0 })),
      ticks: this.match ? this.match.ticks : 0, matchPhase: this.match ? this.match.phase : null };
  }
}

// What a tower looks like on the wire (a change means it must be resent).
const towerSig = (t) => t.def.id + (t.sellAt !== undefined ? '/s' : '') + '/' + t.spent;
const towerHp = (t) => Math.max(0, Math.ceil(t.hp ?? 0));
const KILLS = 2 ** 24;                  // tower stat signature: hp * KILLS + kills
const isTower = (x) => !!(x.def && x.def.upgrades);
const targetRef = (x) => (!x ? 0 : isTower(x) ? x.id * 2 + 1 : x.id * 2);
const stockSig = (k) => k.count + (k.open ? 1000 : 0) + (k.next === null ? -1 : k.next) * 4096;
// What one client has of a lane: tower version and stats, and the creeps as last sent (sorted by id).
const laneState = () => ({ ver: 0, ts: new Map(), ids: [], qx: [], qy: [], hp: [], fl: [], ta: [], due: 0 });
const nonceOf = (msg) => (typeof msg.nonce === 'string' && NONCE_RE.test(msg.nonce) ? msg.nonce : null);
// A command or chat line's selection ('-destroy'): towers by id, tech buildings by id, capped.
function picked(out, op) {
  if (P.isInt(op.tower, 1, 2 ** 32)) out.tower = op.tower;
  if (Array.isArray(op.towers)) out.towers = op.towers.slice(0, MAX_PICK).filter(v => P.isInt(v, 1, 2 ** 32));
  if (Array.isArray(op.tech)) out.tech = op.tech.slice(0, 32).filter(P.isId);
  return out;
}
// The part of match.command's answer a player gets back.
function result(r) {
  const out = { ok: !!r.ok, why: r.why || null };
  for (const k of RESULT_NUMBERS) if (typeof r[k] === 'number') out[k] = r[k];
  if (typeof r.id === 'string') out.id = r.id;
  if ('command' in r) out.command = typeof r.command === 'string' ? r.command : null;
  if (typeof r.kicked === 'boolean') out.kicked = r.kicked;
  return out;
}
function creepFlags(c, now, lane) {
  let f = 0;
  if (c.slowUntil > now && c.slowPct > 0) f |= CF.SLOW;
  if (c.stunUntil > now) f |= CF.STUN;
  if (c.poisons.length) { f |= CF.POISON; if (c.poisons.some(p => p.slow)) f |= CF.PSLOW; }
  if (c.auraSlow > 0) f |= CF.AURA;
  if (!c.def.invisible || lane.visible(c)) f |= CF.SEEN;
  if (c.reviving) f |= CF.REVIVE;
  if (c.moveBonus > 0) f |= CF.MOVE;
  if (c.atkBonus > 0) f |= CF.ATK;
  if (c.dmgBonus > 0) f |= CF.DMG;
  if (c.regenBonus > 0) f |= CF.REGEN;
  if (c.regenPct > 0) f |= CF.RPCT;
  return f;
}
function has(sorted, id) {   // binary search in an ascending id list
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1, v = sorted[mid]; if (v === id) return true; if (v < id) lo = mid + 1; else hi = mid - 1; }
  return false;
}
