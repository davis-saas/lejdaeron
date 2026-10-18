// WebRTC transport over Trystero (vendored in src/net/vendor, loaded only when vs Players is used). Peers find each other
// through public signalling networks, then talk directly over a WebRTC data channel (ordered and reliable).
// - Nostr relays first. If no peer has connected after FALLBACK_AFTER seconds, BitTorrent WebSocket trackers join in as
//   a second signalling channel; the host always adds them after that delay, so late joiners stuck on one network still
//   find it. Both strategies share one Trystero core and so one selfId: a peer found on both is one peer here, and
//   messages go over the first link that came up (the other takes over if it drops).
// - Star topology: right after a link opens both ends say whether they are the host or a player, and a link that isn't
//   host <-> player (two players, or two hosts on the same room code) is refused, so players only talk to the host.
// - ICE uses the public STUN servers and optional TURN relays from src/net/config.js.
import * as CFG from './config.js?v=c7bd234229c1';
import { Transport } from './transport.js?v=c7bd234229c1';

// Trystero gives a second joinRoom for the same room the first one's room object, so a second transport would take over
// the first one's handlers and closing either would cut both: one live transport per room and page.
const live = new Set();
export async function createTrysteroTransport({ room, role = 'join', log = () => {} }) {
  if (live.has(room)) throw new Error(`This page is already in room ${room}.`);
  live.add(room);
  try {
    const lib = await import('./vendor/trystero.js?v=c7bd234229c1');
    return new TrysteroTransport(lib, { room, role, log });
  } catch (e) { live.delete(room); throw e; }
}

export class TrysteroTransport extends Transport {
  constructor(lib, { room, role, log }) {
    super(lib.selfId);
    this.lib = lib; this.room = room; this.role = role; this.log = log;
    this.rooms = {};                     // strategy -> { room, action, since }
    this.routes = new Map();             // peer -> Set of strategies it is connected over, oldest first
    this.missing = new Set();            // 'peer|strategy' routes whose room didn't have the peer at the last check
    this.refused = new Set();            // peers whose handshake showed they aren't the other role (two players)
    this.errors = [];
    this.started = Date.now();
    this.healer = setInterval(() => this.heal(), 2000);
    this.join('nostr');
    this.fallback = setTimeout(() => {
      if (this.role === 'host' || !this.connected.size) { this.log('no peer after ' + CFG.FALLBACK_AFTER + ' s: adding the tracker fallback'); this.join('torrent'); }
    }, CFG.FALLBACK_AFTER * 1000);
  }
  config(strategy) {
    const urls = strategy === 'nostr' ? CFG.NOSTR_RELAYS : CFG.TORRENT_TRACKERS;
    const redundancy = strategy === 'nostr' ? CFG.NOSTR_REDUNDANCY : CFG.TORRENT_REDUNDANCY;
    return { appId: CFG.APP_ID, passive: this.role !== 'host' && CFG.PASSIVE_JOINERS,
      relayConfig: urls ? { urls } : { redundancy }, rtcConfig: { iceServers: [...CFG.STUN, ...CFG.TURN] },
      // Trystero refuses bigger messages before reassembling them: players only send small commands to the host
      maxReceiveBytes: this.role === 'host' ? CFG.HOST_RECEIVE_LIMIT : CFG.PLAYER_RECEIVE_LIMIT };
  }
  join(strategy) {
    if (this.rooms[strategy] || this.closed) return;
    const joinRoom = strategy === 'nostr' ? this.lib.joinNostr : this.lib.joinTorrent;
    const role = this.role === 'host' ? 'host' : 'join';
    const room = joinRoom(this.config(strategy), this.room, {
      onJoinError: (d) => {
        const why = String(d && d.error);
        if (/handshake/i.test(why)) return;   // a refused player-to-player link: expected
        this.errors.push(strategy + ': ' + why); this.log(strategy + ' join error: ' + why);
      },
      onPeerHandshake: async (peer, send, receive) => {
        // Trystero keeps a refused peer's connection in its shared pool and offers it to the room again at once, so a
        // refusal repeated on the spot spins (dozens of handshakes a second between two players): a peer refused once
        // is left to time out instead, one try per HANDSHAKE_TIMEOUT.
        if (this.refused.has(peer)) return new Promise(() => {});
        await send({ app: CFG.APP_ID, role });
        const { data } = await receive();
        const theirs = data && typeof data === 'object' ? data.role : null;
        if (role === 'host' ? theirs !== 'join' : theirs !== 'host') { this.refused.add(peer); throw new Error('handshake: not a host and a player'); }
      },
      handshakeTimeoutMs: CFG.HANDSHAKE_TIMEOUT * 1000,
    });
    const action = room.makeAction('m');
    action.onMessage = (data, ctx) => {
      const peer = ctx && ctx.peerId;
      if (!peer) return;
      if (ArrayBuffer.isView(data)) data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (!(data instanceof ArrayBuffer)) return;
      if (!this.routes.get(peer)?.has(strategy)) this.route(peer, strategy, true);   // data can beat onPeerJoin
      this.got(peer, data);
    };
    room.onPeerJoin = (peer) => this.route(peer, strategy, true);
    room.onPeerLeave = (peer) => this.route(peer, strategy, false);
    this.rooms[strategy] = { room, action, since: Date.now() };
    this.log('signalling over ' + strategy);
  }
  route(peer, strategy, up) {
    let via = this.routes.get(peer);
    if (up) {
      if (!via) this.routes.set(peer, via = new Set());
      via.add(strategy);
      this.log('peer ' + peer.slice(0, 6) + ' connected over ' + strategy + (via.size > 1 ? ' (already connected, kept as a spare)' : ''));
      if (via.size === 1) this.joined(peer);
    } else if (via) {
      via.delete(strategy);
      this.log('peer ' + peer.slice(0, 6) + ' dropped on ' + strategy);
      if (!via.size) { this.routes.delete(peer); this.left(peer); }
    }
  }
  // Over the oldest route whose room has the peer up (a route can outlive its connection for a moment, see heal()).
  send(peer, buf) {
    const via = this.routes.get(peer);
    if (!via || this.closed) return;
    for (const strategy of via) {
      const r = this.rooms[strategy];
      if (!r || !r.room.getPeers()[peer]) continue;
      this.sent(buf);
      r.action.send(buf, { target: peer }).catch(() => {});
      return;
    }
  }
  // Trystero can lose a peer without an onPeerLeave (seen with a peer on both signalling networks, and with rooms left
  // on unload): a route whose room hasn't had the peer at two checks in a row is dropped, so the leave gets reported.
  heal() {
    for (const [peer, via] of [...this.routes]) {
      for (const strategy of [...via]) {
        const r = this.rooms[strategy], key = peer + '|' + strategy;
        if (r && r.room.getPeers()[peer]) { this.missing.delete(key); continue; }
        if (!this.missing.has(key)) { this.missing.add(key); continue; }
        this.missing.delete(key);
        this.log('peer ' + peer.slice(0, 6) + ' is gone from ' + strategy + ' without a leave');
        this.route(peer, strategy, false);
      }
    }
  }
  // Closes the WebRTC connection to one peer on every strategy; Trystero then reports it gone as usual.
  drop(peer) {
    for (const r of Object.values(this.rooms)) {
      try { const pc = r.room.getPeers()[peer]; if (pc) pc.close(); } catch { /* already gone */ }
    }
  }
  // What the demo page and error messages show: which relays and trackers answered, which peers are up and how.
  diagnostics() {
    const sockets = (get) => { try { return Object.entries(get() || {}).map(([url, ws]) => [url.replace('wss://', ''), ['connecting', 'open', 'closing', 'closed'][ws.readyState] || '?']); } catch { return []; } };
    return {
      id: this.id, role: this.role, room: this.room, seconds: Math.round((Date.now() - this.started) / 1000),
      strategies: Object.keys(this.rooms),
      nostr: this.rooms.nostr ? sockets(this.lib.nostrSockets) : [], torrent: this.rooms.torrent ? sockets(this.lib.torrentSockets) : [],
      peers: [...this.routes].map(([p, via]) => ({ peer: p, via: [...via] })), errors: this.errors.slice(-5),
    };
  }
  close() {
    if (this.closed) return;
    clearTimeout(this.fallback); clearInterval(this.healer);
    live.delete(this.room);
    super.close();
    for (const r of Object.values(this.rooms)) { try { r.room.leave(); } catch { /* already gone */ } }
  }
}
