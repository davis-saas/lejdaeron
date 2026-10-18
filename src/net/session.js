// vs Players: hosting and joining a room (docs/SPEC-client.md "Session contract").
//
//   const lobby = await hostLobby({ name })           // creates a room; lobby.link is the invite link
//   const lobby = await joinLobby(link, { name })     // joins from an invite link (inviteFromLocation() reads its hash)
//   lobby.on('start', (session) => ...)               // session.world, session.command(op), session.tick(dt), ...
//
// The host's browser is authoritative: the Match and the Bots run in a Web Worker (src/net/host_worker.js), remote
// players reach it over WebRTC (src/net/trystero.js), and the host's own UI is a replica over a postMessage link, so it
// plays exactly as a joiner does. Nothing here needs a server of our own: the page can be static (GitHub Pages).
// A joiner who drops can reopen the link within REJOIN_GRACE seconds: a token kept in localStorage gets their seat back.
// The link carries the host's key (#room=CODE&key=..., src/net/auth.js): a joiner believes only a peer that proves it
// holds that key, so knowing the room code (or the link) is not enough to pose as the host.
// Both entry points take optional { net, worker, timers, storage } (and hostLobby a match seed) so tests can run them
// on a fake network, on a virtual clock, reproducibly.
import { Lobby, systemTimers } from './client.js?v=99dfd38af943';
import { PortTransport, Loopback } from './transport.js?v=99dfd38af943';
import { HostCore, LOCAL } from './host.js?v=99dfd38af943';
import { jsonMsg, H } from './protocol.js?v=99dfd38af943';
import { hostKey, prover, remoteId, KEY_RE } from './auth.js?v=99dfd38af943';
import * as CFG from './config.js?v=99dfd38af943';

export { CFG as netConfig };

// ---------------------------------------------------------------------------------------------------- rooms and links
export function newRoomCode(n = CFG.ROOM_LENGTH) {
  const a = CFG.ROOM_ALPHABET, b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, x => a[x % a.length]).join('');
}
// A room code as typed or pasted (any case, spaces, a whole link), or null if it can't be one.
export function normalizeRoom(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/room=([^&\s]+)/i);
  const code = (m ? m[1] : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4 || code.length > 6) return null;
  for (const ch of code) if (!CFG.ROOM_ALPHABET.includes(ch)) return null;
  return code;
}
export function roomFromLocation(loc = globalThis.location) {
  const m = loc && loc.hash ? loc.hash.match(/room=([^&]+)/i) : null;
  return m ? normalizeRoom(m[1]) : null;
}
// { room, key } from an invite link (or its hash, or a bare room code: key null), or null if there is no room in it.
// key is '' when the text has a key= that isn't one (a link cut short).
export function parseInvite(s) {
  if (typeof s !== 'string') return null;
  const room = normalizeRoom(s);
  if (!room) return null;
  const m = s.match(/[#&?]key=([^&\s]*)/);
  return { room, key: m ? (KEY_RE.test(m[1]) ? m[1] : '') : null };
}
export const inviteFromLocation = (loc = globalThis.location) => (loc && loc.hash ? parseInvite(loc.hash) : null);
// The invite link: this very page (whatever host and path it is served from) with #room=CODE&key=KEY.
export function inviteLink(room, loc = globalThis.location, key = null) {
  const hash = '#room=' + room + (key ? '&key=' + key : '');
  if (!loc) return hash;
  return loc.origin + loc.pathname + loc.search + hash;
}

// ---------------------------------------------------------------------------------------------------- rejoin tokens
// localStorage keeps each seat's token for a closed tab (reopen the link to rejoin), with a heartbeat while its tab is
// open; sessionStorage marks a token as this tab's. A reopened link takes a token whose tab has gone quiet, so two tabs
// of one browser in the same room each keep their own seat. A tab that was just closed may not have said goodbye
// (crash, killed process): wait() says how long until its heartbeat counts as quiet. Tokens expire after KEEP, and
// saving one sweeps away the expired rooms.
const KEY = 'lejdaeron.rejoin.';
const BEAT = 1000, QUIET = 2500, KEEP = 10 * 60 * 1000;
const beats = new Map();   // room -> this page's heartbeat (one per room, however often the page rejoins)
export function browserStorage() {
  const ls = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
  const ss = (() => { try { return globalThis.sessionStorage || null; } catch { return null; } })();
  let mine = null;
  const read = (room) => {
    try {
      const v = JSON.parse((ls && ls.getItem(KEY + room)) || '[]');
      const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
      return list.filter(r => r && typeof r.token === 'string' && Date.now() - (r.at || 0) < KEEP);
    } catch { return []; }
  };
  const write = (room, token, alive) => {
    try {
      const list = read(room).filter(r => r.token !== token);
      list.push({ token, beat: alive ? Date.now() : 0, at: Date.now() });
      ls && ls.setItem(KEY + room, JSON.stringify(list.slice(-8)));
    } catch { /* storage full or blocked */ }
  };
  return {
    load(room) {
      try { const own = ss && ss.getItem(KEY + room); if (own) return own; } catch { /* blocked */ }
      const free = read(room).filter(r => Date.now() - r.beat > QUIET).sort((a, b) => b.at - a.at);
      return free.length ? free[0].token : null;
    },
    wait(room) {
      try { if (ss && ss.getItem(KEY + room)) return 0; } catch { /* blocked */ }
      const list = read(room);
      if (list.some(r => Date.now() - r.beat > QUIET)) return 0;
      const busy = list.map(r => QUIET - (Date.now() - r.beat)).filter(ms => ms > 0);
      return busy.length ? Math.min(...busy) + 100 : 0;
    },
    save(room, token) {
      if (!token) return;
      mine = token;
      try { ss && ss.setItem(KEY + room, token); } catch { /* blocked */ }
      write(room, token, true);
      try {
        for (let i = ls ? ls.length - 1 : -1; i >= 0; i--) {
          const k = ls.key(i);
          if (k && k.startsWith(KEY) && k !== KEY + room && !read(k.slice(KEY.length)).length) ls.removeItem(k);
        }
      } catch { /* blocked */ }
      const old = beats.get(room);
      if (old) { clearInterval(old.timer); globalThis.removeEventListener?.('pagehide', old.bye); }
      const b = { timer: setInterval(() => write(room, token, true), BEAT), bye: () => { clearInterval(b.timer); write(room, token, false); } };
      beats.set(room, b);
      globalThis.addEventListener?.('pagehide', b.bye, { once: true });
    },
    clear(room) {
      const b = beats.get(room);
      if (b) { clearInterval(b.timer); globalThis.removeEventListener?.('pagehide', b.bye); beats.delete(room); }
      try {
        ss && ss.removeItem(KEY + room);
        const list = read(room).filter(r => r.token !== mine);
        if (ls) { if (list.length) ls.setItem(KEY + room, JSON.stringify(list)); else ls.removeItem(KEY + room); }
      } catch { /* blocked */ }
    },
  };
}
const noStorage = { load: () => null, save() {}, clear() {} };

// ---------------------------------------------------------------------------------------------------- hosting
// opts: name; net(room, role) -> transport (default: Trystero); worker (default: true when Workers exist);
// timers (default: the real clock); log(text).
export async function hostLobby({ name = 'Host', net = null, worker = true, timers = systemTimers, log = defaultLog, seed = null } = {}) {
  const room = newRoomCode();
  const key = await hostKey();   // before any network: a page without WebCrypto (plain http) can't host
  // Closing the host's tab tells everyone straight away (best effort; otherwise they notice the dropped link). Trystero
  // leaves its rooms on 'beforeunload' (its goodbye then reaches the players first and drops ours), so this listener is
  // added before the transport adds Trystero's; 'pagehide' covers browsers that skip beforeunload (iOS Safari).
  let lobby = null, remote = null, said = false;
  const bye = () => {
    if (!lobby || lobby.closed || said) return;
    said = true;
    for (const p of remote.peers()) remote.send(p, jsonMsg(H.END, { reason: 'host-left', message: 'The host closed the game. The game is over.' }));
  };
  const unhook = () => { globalThis.removeEventListener?.('beforeunload', bye); globalThis.removeEventListener?.('pagehide', bye); };
  globalThis.addEventListener?.('beforeunload', bye);
  globalThis.addEventListener?.('pagehide', bye);
  try { remote = net ? await net(room, 'host') : await (await import('./trystero.js?v=99dfd38af943')).createTrysteroTransport({ room, role: 'host', log }); }
  catch (e) { unhook(); throw e; }
  const bridge = worker && typeof Worker !== 'undefined' ? workerHost(room, name, remote, log, key) : inlineHost(room, name, remote, timers, log, seed, key);
  lobby = new Lobby({ transport: bridge.ui, name, room, link: inviteLink(room, globalThis.location, key.fingerprint), isHost: true, timers, onClose: () => bridge.stop() });
  lobby.key = key.fingerprint;
  lobby.diagnostics = () => (remote.diagnostics ? remote.diagnostics() : null);
  lobby.transport = remote;   // for debugging pages
  lobby.on('closed', unhook);
  lobby.hostStatus = bridge.status;
  lobby.core = bridge.core || null;   // the HostCore itself when it runs on this thread (tests, no Worker support)
  try { await lobby.ready(10); } catch (e) { unhook(); bridge.stop(); throw e; }
  return lobby;
}
const defaultLog = (text) => { if (globalThis.console) console.info('[net] ' + text); };

// Remote peer ids get a prefix so no peer can ever pass for the host's own UI ('local').
const wrap = (peer) => 'p:' + peer, unwrap = remoteId;
const DROP_AFTER = 1000;   // ms between the host dropping a peer (kicked, silent) and closing its link: the goodbye goes first
// Closes a peer's link DROP_AFTER ms after the host core asks; a link that went meanwhile is not dropped, so a new
// one from the same page (a player removed from the lobby trying again) is left alone.
function dropper(remote, timers) {
  const due = new Map();
  remote.onPeerLeave((p) => { if (due.has(p)) { timers.clearTimeout(due.get(p)); due.delete(p); } });
  return (p) => {
    if (due.has(p)) return;
    due.set(p, timers.setTimeout(() => { due.delete(p); remote.drop(p); }, DROP_AFTER));
  };
}

function workerHost(room, name, remote, log, key) {
  const w = new Worker(new URL('./host_worker.js?v=99dfd38af943', import.meta.url), { type: 'module' });
  const ch = new MessageChannel();
  const ui = new PortTransport(ch.port2, { id: 'ui', peer: 'host' });
  let stopped = false;
  const drop = dropper(remote, systemTimers);
  w.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'send') remote.send(unwrap(m.peer), m.d);
    else if (m.t === 'drop') drop(unwrap(m.peer));
    else if (m.t === 'log') log(m.text);
    else if (m.t === 'closed') setTimeout(() => { remote.close(); w.terminate(); }, 400);   // let the goodbyes go out
  };
  w.onerror = (e) => log('host worker failed: ' + (e.message || e));
  remote.onPeerJoin((p) => w.postMessage({ t: 'join', peer: wrap(p) }));
  remote.onPeerLeave((p) => w.postMessage({ t: 'leave', peer: wrap(p) }));
  remote.onMessage((p, buf) => w.postMessage({ t: 'msg', peer: wrap(p), d: buf }, [buf]));
  w.postMessage({ t: 'init', room, name, port: ch.port1, key: { privateKey: key.privateKey, pub: key.pub } }, [ch.port1]);
  return {
    ui,
    status: () => null,
    stop() { if (stopped) return; stopped = true; w.postMessage({ t: 'close' }); setTimeout(() => { remote.close(); w.terminate(); }, 1500); },
  };
}

// The host core on this thread (no Worker support, or tests on a fake network and clock).
function inlineHost(room, name, remote, timers, log, seed, key) {
  const hub = new Loopback(), ui = hub.endpoint('ui'), side = hub.endpoint('core');
  const sign = prover(key, room), drop = dropper(remote, timers);
  const core = new HostCore({ room, hostName: name, log, seed, prove: (peer, nonce, what) => sign(remoteId(peer), nonce, what),
    send: (peer, buf) => (peer === LOCAL ? side.send('ui', buf) : remote.send(unwrap(peer), buf)),
    drop: (peer) => { if (peer !== LOCAL) drop(unwrap(peer)); } });
  side.onPeerJoin(() => core.join(LOCAL));
  side.onMessage((p, buf) => core.receive(LOCAL, buf));
  remote.onPeerJoin((p) => core.join(wrap(p)));
  remote.onPeerLeave((p) => core.leave(wrap(p)));
  remote.onMessage((p, buf) => core.receive(wrap(p), buf));
  const timer = timers.setInterval(() => core.update(timers.now() / 1000), 1000 / 60);
  let stopped = false;
  return {
    ui, core,
    status: () => core.status(),
    stop() {
      if (stopped) return; stopped = true;
      core.close();
      timers.clearInterval(timer);
      timers.setTimeout(() => remote.close(), 400);
    },
  };
}

// ---------------------------------------------------------------------------------------------------- joining
// invite: the invite link (or a room code, and then opts.key); without a key the first peer that answers as the host
// is believed, which only the tests and the demo page do. onTransport(t) gets the transport as soon as it exists (a
// join screen can show its diagnostics() while it connects); timeout: seconds to wait for the host (JOIN_TIMEOUT);
// signal: an AbortSignal that gives the join up (the join screen's Back) and rejects with 'Joining was cancelled.'.
export async function joinLobby(invite, { name = 'Player', key = undefined, net = null, timers = systemTimers, storage = null, log = defaultLog, onTransport = null, timeout = CFG.JOIN_TIMEOUT, signal = null } = {}) {
  const inv = parseInvite(invite);
  if (!inv) throw new Error('That is not a room code. Codes are 4 to 6 letters and digits, like ' + newRoomCode() + '.');
  const code = inv.room, hostKeyPrint = key !== undefined ? key : inv.key;
  if (hostKeyPrint === '' || (hostKeyPrint && !KEY_RE.test(hostKeyPrint))) throw new Error('That invite link is cut short. Copy the whole link from the host again.');
  const store = storage || (globalThis.localStorage ? browserStorage() : noStorage);
  const CANCELLED = 'Joining was cancelled.';
  if (signal && signal.aborted) throw new Error(CANCELLED);
  const transport = net ? await net(code, 'join') : await (await import('./trystero.js?v=99dfd38af943')).createTrysteroTransport({ room: code, role: 'join', log });
  if (signal && signal.aborted) { transport.close(); throw new Error(CANCELLED); }
  if (onTransport) onTransport(transport);
  const wait = store.wait ? store.wait(code) : 0;   // the link is connecting meanwhile; the lobby says hello once it's up
  if (wait > 0) await new Promise(r => timers.setTimeout(r, wait));
  // a cancelled join keeps the seat token: the player may still come back within the grace
  const lobby = new Lobby({ transport, name, token: store.load(code), room: code, key: hostKeyPrint || null, link: inviteLink(code, globalThis.location, hostKeyPrint), timers,
    onToken: (token) => store.save(code, token),
    onClose: (info) => { if (info.reason !== 'lost' && info.reason !== 'cancelled') store.clear(code); } });
  lobby.diagnostics = () => (transport.diagnostics ? transport.diagnostics() : null);
  lobby.transport = transport;
  if (signal) {
    const cancel = () => { if (lobby.me === null) lobby.end({ reason: 'cancelled', message: CANCELLED }); };
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  }
  await lobby.ready(timeout);
  return lobby;
}
