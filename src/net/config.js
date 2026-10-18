// Network settings for vs Players. Everything the owner may want to tune lives here; nothing else in src/net needs
// editing to change servers or timings.
//
// TURN: some school, office and mobile networks block direct browser-to-browser connections. A TURN relay fixes that.
// To add one, paste its details into TURN below, for example a free Cloudflare or Metered Open Relay account:
//
//   export const TURN = [{ urls: ['turn:global.relay.metered.ca:80', 'turns:global.relay.metered.ca:443?transport=tcp'],
//                          username: '<username>', credential: '<password>' }];
//
// The credentials end up in the public page source, so use a relay account meant for that (rate limited, revocable).
// Game data stays end-to-end encrypted through a TURN relay.

export const APP_ID = 'lejdaeron-ltw-v1';          // Trystero app id: only peers with the same id see each other

// Public STUN servers only (they help browsers find their public address; no game data goes through them).
export const STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
export const TURN = [];                            // see above; empty by default

// Signalling. Peers find each other over public Nostr relays first; if no peer has connected after FALLBACK_AFTER
// seconds, BitTorrent WebSocket trackers join in as a second channel. null keeps Trystero's own default lists.
export const NOSTR_RELAYS = null;                  // e.g. ['wss://nos.lol', 'wss://relay.damus.io']
export const NOSTR_REDUNDANCY = 5;                 // how many of the default relays to use at once
export const TORRENT_TRACKERS = null;              // e.g. ['wss://tracker.openwebtorrent.com']
export const TORRENT_REDUNDANCY = 3;
export const FALLBACK_AFTER = 5;                   // seconds without a peer before the tracker fallback starts
// Every player announces itself, so the host hears a joiner at once; a short handshake right after each WebRTC link
// opens then keeps only host <-> player links (players never stay connected to each other). Trystero's passive mode
// would avoid the extra links, but a passive joiner only hears the host's periodic announcement (once a minute on
// Nostr), so joining took up to a minute; it stays here as an option.
export const PASSIVE_JOINERS = false;
export const HANDSHAKE_TIMEOUT = 8;                // seconds for the role handshake on a new link

// Lobby and match.
export const MAX_SEATS = 8;                        // vs Players: 2 to 8 players, empty seats can be bots
export const ROOM_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';   // no 0/O, 1/I/L, 2/Z, 5/S, 8/B look-alikes
export const ROOM_LENGTH = 5;                      // new rooms; joining accepts 4 to 6 characters
export const REJOIN_GRACE = 60;                    // seconds a dropped player keeps their seat (lobby and match)
export const JOIN_TIMEOUT = 25;                    // seconds a joiner waits for the host before giving up
export const HOST_SILENT_AFTER = 5;                // seconds a ping goes unanswered (nothing at all from the host) before
                                                   // the link counts as lost although the connection still looks up
export const HOST_LOST_AFTER = 10;                 // seconds the link stays lost (reconnecting meanwhile) before a joiner
                                                   // gives up: the match is over for them (the 60 s rejoin still works)
export const PEER_SILENT_AFTER = 20;               // seconds without any message before the host drops a peer
export const PING_EVERY = 2;                       // seconds between pings (ping is reported in session.on('net'))

// Streaming (host to each client), in 1/60 s match ticks.
export const NET_TICKS = 4;                        // 15 Hz: the lane a client watches
export const OTHER_TICKS = 20;                     // 3 Hz: every other lane
export const WATCH_CROWD = 300;                    // creeps in the watched lane before its rate is lowered
export const OTHER_CROWD = 120;                    // the same for the other lanes
export const MAX_SLOWDOWN = 3;                     // the lowest rate is the base rate divided by this

// Abuse limits, per peer (the host trusts no one).
export const MAX_MESSAGE = 4096;                   // bytes in one client message (a "-destroy" can name 320 towers)
export const HOST_RECEIVE_LIMIT = 64 * 1024;       // Trystero's own receive cap on the host (bigger is never valid)
export const PLAYER_RECEIVE_LIMIT = 16 * 1024 * 1024;   // and on players (full frames of a crowded match)
export const MSG_RATE = [40, 120];                 // messages per second and burst
export const CMD_RATE = [12, 40];                  // game commands per second and burst
export const CHAT_RATE = [0.5, 5];                 // chat lines per second and burst
export const STRIKES = 30;                         // rejected messages within a minute before a peer is kicked
