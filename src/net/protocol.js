// The vs Players wire protocol between the host (src/net/host.js) and every replica (src/net/replica.js).
// Every message is one ArrayBuffer whose first byte is its type. Control messages (lobby, chat, commands and their
// results) carry UTF-8 JSON after that byte; the state stream (FRAME), PING, PONG and WATCH are binary, little endian,
// with LEB128 varints. Both sides index towers, units and tech buildings by their position in src/data and run lanes
// of the same size, so DATA_SIG (a hash of those tables, the lane size and PROTO) must match or the host refuses the
// join (a page of a build with 8-row lanes cannot play with one that has 9).
//
// A FRAME (host -> one client) is a delta against what that client already has:
//   u8 FRAME, u8 flags (FULL, BOARD, SHOP, MEVENTS, PHASE, TECH, ARCADE), uv seq, u32 tick
//   [PHASE]   u8 phase (index in PHASES: the build phase, playing, won, over), u8 winner (0 = none), u8 '-onextra' on,
//             u8 its slot (0 = none)
//   [BOARD]   u8 n, n x player:  u8 slot, u8 bits (alive, left, kicked), num gold, num income, num lives, num lumber,
//                                num wisps, num kills, u8 eliminatedBy (0 = none), and the lane's stats: num creeps
//                                killed, num leaks, num towers built, num towers destroyed
//   [TECH]    u8 n, n x player:  u8 slot, u8 bits (eliminated, label), [num eliminatedAt], [str label],
//                                u8 k, k x u8 tech building (index in TECH_IDS), u8 k, k x num training doneAt
//   [SHOP]    u8 n, n x stock:   u8 unit (index in SOLD), u8 count, u8 bits (open, has next), [u32 next tick]
//   [ARCADE]  the player's own Arcade lumber stock: u8 count, u8 bits (open, has next), [u32 next tick]
//   u8 lanes, per lane: u8 slot, u8 bits (TOWERS, CREEPS, TSTATS, EVENTS)
//     [TOWERS] uv base version, uv version, uv n, n x tower, uv removed, removed x uv (id * 2 + destroyed)
//              tower: uv id, u8 def, u8 c, u8 r, u8 bits (selling, building), [u8 building, u8 buildTotal] x 1/250 s,
//                     [u8 sell delay x 1/250 s], num spent, uv hp (rounded up), uv maxHp, uv kills
//     [CREEPS] u8 ticks between this lane's updates, uv n, the lane's whole creep list sorted by id: uv id delta,
//              u8 mask (NEW, ABS, DELTA, HP, FLAGS, TARGET)
//              NEW: u8 unit, u8 owner, num maxHp, u16 x, u16 y, u16 hp, uv flags   ABS: u16 x, u16 y
//              DELTA: sv dx, sv dy   HP: u16   FLAGS: uv   TARGET: uv what it attacks (0 none, creep id * 2, tower
//              id * 2 + 1)   (x, y in 1/64 tile; hp as a fraction of maxHp x 65535)
//              A creep the client had that is missing from the list is gone.
//     [TSTATS] uv n, n x (uv id, uv hp, uv kills): towers whose hit points or kills changed (same cadence as creeps)
//     [EVENTS] uv n, n x (u8 ticks before the frame tick, u8 code, fields): the watched lane's combat events
//   [MEVENTS] str JSON: match events since the last frame, each with its tick
// Seq numbers let a client spot a lost frame and ask for a FULL one (C.RESYNC).
// Joining: HELLO { v, data, name, nonce, token | rejoin } -> WELCOME { you, token, phase, proof } or ERROR { fatal,
// message, proof }; a player with a rejoin token first sends { rejoin: true } without it and gets PROOF { proof }, then
// sends the token. Every proof is the host's signature for that nonce (src/net/auth.js).
import { TOWERS } from '../data/towers.js?v=99dfd38af943';
import { LTW_UNITS, LTW_SHOPS, LTW_TECH_ORDER, LTW_RULES } from '../data/ltw.js?v=99dfd38af943';

export const PROTO = 4;
export const C = { HELLO: 1, LOBBY: 2, CMD: 3, WATCH: 4, PING: 5, RESYNC: 6, LEAVE: 7 };                  // client -> host
export const H = { WELCOME: 16, LOBBY: 17, CHAT: 18, START: 19, FRAME: 20, RESULT: 21, PONG: 22, END: 23, ERROR: 24, PROOF: 25 };
export const F = { FULL: 1, BOARD: 2, SHOP: 4, MEVENTS: 8, PHASE: 16, TECH: 32, ARCADE: 64 };             // frame flags
export const LB = { TOWERS: 1, CREEPS: 2, EVENTS: 4, TSTATS: 8 };                                        // lane block
export const CM = { NEW: 1, ABS: 2, DELTA: 4, HP: 8, FLAGS: 16, TARGET: 32 };                            // creep mask
// Creep flags: what the renderer needs from slow, stun, poison, aura and true sight, reincarnation, and which creep
// aura bonuses apply this tick (each bonus has one value in the data, so a bit carries it).
export const CF = { SLOW: 1, STUN: 2, POISON: 4, PSLOW: 8, AURA: 16, SEEN: 32, REVIVE: 64,
  MOVE: 128, ATK: 256, DMG: 512, REGEN: 1024, RPCT: 2048 };
// Lane event codes. Creeps travel as refs (see writeEvents in host.js), "fix" numbers in 1/16 steps:
//   shot: uv tower, ref target   impact: uv tower, ref creep, u16 x, u16 y   death: ref, num gold, u8 fix, u8 to
//   leak, bash, reborn: ref   spawn: ref, ref from   build, upgrade, selling: uv tower   sell: uv tower, num gold
//   removeTower: uv tower, u8 destroyed   removeCreep: ref   attack: ref creep, what (u8 0 none / 1 tower + uv id /
//   2 creep + ref)   damaged: uv tower, ref creep, fix amount, fix hp   hurt: ref creep, ref by, u8 owner, fix amount,
//   fix hp   destroyed: uv tower, ref by, u8 reason   blast: u16 x, u16 y, u8 owner, num radius, ref creep
//   reincarnate: ref, num at   evade: ref creep, ref by   other: str JSON (an event this version doesn't know)
export const EV = { shot: 1, impact: 2, death: 3, leak: 4, build: 5, upgrade: 6, sell: 7, selling: 8, bash: 9, spawn: 10,
  removeTower: 11, removeCreep: 12, attack: 13, damaged: 14, hurt: 15, destroyed: 16, blast: 17, reincarnate: 18,
  reborn: 19, evade: 20, other: 255 };
export const DESTROY_REASONS = ['attack', 'deathDamage', 'destroy'];
export const PHASES = ['prep', 'playing', 'won', 'over'];
export const Q = 64;                                   // position quantum: 1/64 tile
export const HPQ = 65535;
export const BT = 250;                                 // build and sell timers: 1/250 s
export const FIX = 16;                                 // damage amounts and hit points in events: 1/16

// Index tables shared by both ends.
export const TOWER_IDS = Object.keys(TOWERS);
export const TOWER_INDEX = Object.fromEntries(TOWER_IDS.map((id, i) => [id, i]));
export const UNIT_IDS = Object.keys(LTW_UNITS);
export const UNIT_INDEX = Object.fromEntries(UNIT_IDS.map((id, i) => [id, i]));
export const SOLD = LTW_SHOPS.flatMap(s => s.units);
export const SOLD_INDEX = Object.fromEntries(SOLD.map((id, i) => [id, i]));
export const TECH_IDS = LTW_TECH_ORDER.slice();
export const TECH_INDEX = Object.fromEntries(TECH_IDS.map((id, i) => [id, i]));
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
export const DATA_SIG = fnv([PROTO, TOWER_IDS.join(','), UNIT_IDS.join(','), SOLD.join(','), TECH_IDS.join(','),
  LTW_RULES.laneLength + 'x' + LTW_RULES.laneWidth].join('|'));

const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------------------------------- binary
export class Writer {
  constructor(size = 512) { this.buf = new ArrayBuffer(size); this.dv = new DataView(this.buf); this.b = new Uint8Array(this.buf); this.n = 0; }
  need(k) {
    if (this.n + k <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2; while (size < this.n + k) size *= 2;
    const b = new Uint8Array(size); b.set(this.b.subarray(0, this.n));
    this.buf = b.buffer; this.b = b; this.dv = new DataView(this.buf);
  }
  u8(v) { this.need(1); this.b[this.n++] = v; return this; }
  u16(v) { this.need(2); this.dv.setUint16(this.n, v, true); this.n += 2; return this; }
  u32(v) { this.need(4); this.dv.setUint32(this.n, v >>> 0, true); this.n += 4; return this; }
  f64(v) { this.need(8); this.dv.setFloat64(this.n, v, true); this.n += 8; return this; }
  uv(v) {   // unsigned varint, 0 to 2^53
    this.need(8);
    while (v >= 128) { this.b[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.b[this.n++] = v;
    return this;
  }
  sv(v) { return this.uv(v >= 0 ? v * 2 : -v * 2 - 1); }   // zigzag
  fix(v) { return this.uv(Number.isFinite(v) && v > 0 ? Math.round(v * FIX) : 0); }   // a non-negative number in 1/16
  // Any number: integers as a tagged zigzag varint, everything else as a float64.
  num(v) {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 50) return this.uv((v >= 0 ? v * 2 : -v * 2 - 1) * 2);
    return this.uv(1).f64(Number.isFinite(v) ? v : 0);
  }
  str(s) { const b = enc.encode(s); this.uv(b.length); this.need(b.length); this.b.set(b, this.n); this.n += b.length; return this; }
  pos() { return this.n; }
  patch8(at, v) { this.b[at] = v; }
  finish() { return this.buf.slice(0, this.n); }
}

// Reads with bounds checks: a short or corrupt message throws a RangeError, never reads past the end.
export class Reader {
  constructor(buf, at = 0) { this.dv = new DataView(buf); this.b = new Uint8Array(buf); this.n = at; }
  get left() { return this.b.length - this.n; }
  u8() { if (this.n >= this.b.length) throw new RangeError('short message'); return this.b[this.n++]; }
  u16() { const v = this.dv.getUint16(this.n, true); this.n += 2; return v; }
  u32() { const v = this.dv.getUint32(this.n, true); this.n += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.n, true); this.n += 8; return v; }
  uv() {
    let v = 0, k = 1;
    for (let i = 0; i < 8; i++) { const b = this.u8(); v += (b & 127) * k; if (b < 128) return v; k *= 128; }
    throw new RangeError('bad varint');
  }
  sv() { const v = this.uv(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  fix() { return this.uv() / FIX; }
  num() {
    const v = this.uv();
    if (v === 1) return this.f64();
    const z = v / 2; return z % 2 ? -(z + 1) / 2 : z / 2;
  }
  str(max = 1 << 20) {
    const len = this.uv();
    if (len > max || len > this.left) throw new RangeError('bad string');
    const s = dec.decode(this.b.subarray(this.n, this.n + len)); this.n += len; return s;
  }
}

// ---------------------------------------------------------------------------------------------------- messages
export function jsonMsg(type, obj) {
  const body = enc.encode(JSON.stringify(obj));
  const b = new Uint8Array(body.length + 1); b[0] = type; b.set(body, 1);
  return b.buffer;
}
// { type, json } for control messages, { type, r } (a Reader past the type byte) for binary ones; null if unreadable.
export function readMsg(buf, max = Infinity) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 1 || buf.byteLength > max) return null;
  const type = new Uint8Array(buf, 0, 1)[0];
  if (BINARY.has(type)) return { type, r: new Reader(buf, 1) };
  try {
    const json = JSON.parse(dec.decode(new Uint8Array(buf, 1)));
    return json && typeof json === 'object' && !Array.isArray(json) ? { type, json } : null;
  } catch { return null; }
}
const BINARY = new Set([C.WATCH, C.PING, C.RESYNC, C.LEAVE, H.FRAME, H.PONG]);
export const binMsg = (type) => new Writer(16).u8(type);

// ---------------------------------------------------------------------------------------------------- input hygiene
// Strips control, zero-width, bidi-override and private-use characters, folds whitespace and caps the length, so a
// name or chat line from a peer can't break the layout or impersonate system text. Angle brackets become look-alikes
// so text is harmless even if a UI ever puts it into innerHTML.
const STRIP = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f\\u1160\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\ufff0-\\uffff]' +
  '|[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]|\\udb40[\\udc00-\\udfff]|[\\udb80-\\udbff][\\udc00-\\udfff]', 'g');
export function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  s = s.slice(0, max * 4).normalize('NFC').replace(/\s+/g, ' ').replace(STRIP, '').replace(/</g, '\u2039').replace(/>/g, '\u203a').replace(/ +/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}
export const cleanName = (s) => cleanText(s, 16);
export const cleanChat = (s) => cleanText(s, 255);   // the map's chat line, as Match.command cuts it
export const isId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 8 && /^[A-Za-z0-9]+$/.test(s);
export const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
