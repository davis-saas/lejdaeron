// The host's key: how a joiner knows the lobby it reached is the real host's and not someone else in the same room.
// A room code alone is public enough (five characters, typed into chats), so the invite link also carries a key:
//
//   https://<site>/#room=K7Q2X&key=<fingerprint>
//
// hostLobby makes an ECDSA P-256 key pair when it opens a room; the fingerprint is the first 16 bytes of the SHA-256
// of its public key. Every HELLO carries a random nonce, and the host answers its WELCOME (and a refusal: full,
// already started) with { pub, sig }: the public key and a signature over the room, the joiner's own peer id, that
// nonce and the answer. The joiner checks that the public key matches the link's fingerprint and that the signature is
// good before it believes anything, so a player who knows the room code, or even the whole link, can't pose as the
// host (it has no private key), and a WELCOME can't be replayed to another joiner or relayed from another connection
// (the nonce and the peer id differ). Uses WebCrypto (crypto.subtle): browsers give it to https pages and localhost,
// Node has it built in.
const enc = new TextEncoder();
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }, SIGN = { name: 'ECDSA', hash: 'SHA-256' };
export const KEY_RE = /^[A-Za-z0-9_-]{22}$/;
export const NONCE_RE = /^[0-9a-f]{32}$/;

const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('Online play needs a secure page: open the game over https (or from localhost).');
  return s;
};
export const canSign = () => !!(globalThis.crypto && globalThis.crypto.subtle);
const b64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export function newNonce() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
async function fingerprintOf(raw) {
  return b64(new Uint8Array(await subtle().digest('SHA-256', raw)).subarray(0, 16));
}
// The text the host signs for one answer to one joiner.
const signed = (room, peer, nonce, what) => enc.encode(['lejdaeron-host', room, peer, nonce, what].join('|'));

// A new key pair: { privateKey (a CryptoKey, not extractable; it can be posted to a Worker), pub (base64url of the raw
// public key), fingerprint (what goes into the invite link) }.
export async function hostKey() {
  const pair = await subtle().generateKey(ECDSA, false, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, pub: b64(raw), fingerprint: await fingerprintOf(raw) };
}
// prove(peer, nonce, what) -> Promise<{ pub, sig }> for HostCore. `peer` is the joiner's id as the host's transport sees it.
export function prover(key, room) {
  return async (peer, nonce, what) => {
    const sig = new Uint8Array(await subtle().sign(SIGN, key.privateKey, signed(room, peer, nonce, what)));
    return { pub: key.pub, sig: b64(sig) };
  };
}
// Whether `proof` is the link's host answering this joiner (my peer id, my nonce) with `what`.
export async function verify(proof, { key, room, peer, nonce, what }) {
  try {
    if (!proof || typeof proof.pub !== 'string' || typeof proof.sig !== 'string' || proof.pub.length > 100 || proof.sig.length > 100) return false;
    const raw = unb64(proof.pub);
    if (await fingerprintOf(raw) !== key) return false;
    const pub = await subtle().importKey('raw', raw, ECDSA, false, ['verify']);
    return await subtle().verify(SIGN, pub, unb64(proof.sig), signed(room, peer, nonce, what));
  } catch { return false; }
}
// The id a remote peer has on the host's transport: the host core sees it with a 'p:' prefix (src/net/session.js), so
// that no remote peer can pass for the host's own UI ('local').
export const remoteId = (peer) => (typeof peer === 'string' && peer.startsWith('p:') ? peer.slice(2) : peer);
