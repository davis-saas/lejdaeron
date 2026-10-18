// The host's match in a Web Worker, so it keeps its 60 Hz pace while the host's tab is in the background.
// Started by src/net/session.js (hostLobby). Messages from the page:
//   { t: 'init', room, name, port, key } port: the MessagePort of the host's own UI (peer 'local'); key: the host's
//                                        signing key { privateKey, pub } (src/net/auth.js)
//   { t: 'join' | 'leave', peer }        a remote peer connected or dropped (ids from the page, 'p:<trystero id>')
//   { t: 'msg', peer, d }                an ArrayBuffer from a remote peer
//   { t: 'close', message }              the host leaves: everyone is told, then the worker stops
// and to the page: { t: 'send', peer, d }, { t: 'drop', peer }, { t: 'log', text }, { t: 'closed' }.
import { HostCore, LOCAL } from './host.js?v=91305a8026e8';
import { prover, remoteId } from './auth.js?v=91305a8026e8';

let core = null, local = null, timer = null;
const post = (m, transfer) => self.postMessage(m, transfer || []);
const guard = (fn) => { try { fn(); } catch (e) { post({ t: 'log', text: 'host error: ' + (e && e.stack || e) }); } };

function send(peer, buf) {
  if (peer === LOCAL) local.postMessage({ d: buf }, [buf]);
  else post({ t: 'send', peer, d: buf }, [buf]);
}

self.onmessage = (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'init':
      if (core) return;
      local = m.port;
      const sign = m.key ? prover(m.key, m.room) : null;
      core = new HostCore({ room: m.room, hostName: m.name, send, drop: (peer) => post({ t: 'drop', peer }), log: (text) => post({ t: 'log', text }),
        prove: sign && ((peer, nonce, what) => sign(remoteId(peer), nonce, what)) });
      local.onmessage = (ev) => {
        const d = ev.data;
        if (d && d.d instanceof ArrayBuffer) guard(() => core.receive(LOCAL, d.d));
      };
      local.start();
      core.join(LOCAL);
      timer = setInterval(() => guard(() => core.update(performance.now() / 1000)), 1000 / 60);
      return;
    case 'join': return core && guard(() => core.join(m.peer));
    case 'leave': return core && guard(() => core.leave(m.peer));
    case 'msg': return core && m.d instanceof ArrayBuffer && guard(() => core.receive(m.peer, m.d));
    case 'close':
      if (core) guard(() => core.close(m.message));
      clearInterval(timer);
      post({ t: 'closed' });
      return;
  }
};
