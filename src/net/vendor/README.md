# Vendored Trystero

`trystero.js` is a self-contained ES module (no imports, no CDN at runtime) that bundles the two Trystero
signalling strategies the game uses, on one shared core, so both strategies have the same `selfId` and a peer
found on both can be recognised as the same peer:

| package | version | npm integrity |
| --- | --- | --- |
| `@trystero-p2p/core` | 0.26.0 | `sha512-CZpeXPgfbDdFKrGxfD98F9tn/fTjya4mQ2o/Ax6H0qpBaJXCBz5+jyPtjsYEPAAcKRK/btOatCetFiQ5qIMCOA==` |
| `@trystero-p2p/nostr` | 0.26.0 | `sha512-HArp9fonBkqFZgw3U2D823fCePQv7haKkvjtwbGRkWzy+Wo9G3cCDEnG/GENDWwzERHrhRcRacpFsFt4JpwRJQ==` |
| `@trystero-p2p/torrent` | 0.26.0 | `sha512-pb3tYMGpxo+C7EacxXTfXK9tmSBzSPMubieMjAioNc+jCmwfdYc7xiMGJ/uIz4mD9Ts83ZG25qIqsoErVh6+VA==` |
| `@noble/secp256k1` | 3.2.0 | `sha512-Z3ZAWOTxJ0EuTuZTi7Y69iK7GgrLHh8sgm45lVDhg/b3Nk1TpAiKhick2KkZisHuupeepSkyIydN/J459SdX1w==` |

Built with esbuild 0.28.2. All packages came from the official npm registry (registry.npmjs.org). Since 0.25 Trystero
ships each strategy as its own `@trystero-p2p/*` package (the plain `trystero` package only re-exports Nostr), so the
scoped packages are used directly.

Why 0.26.0 and not 0.25.4 (the first version vendored here): 0.25.4 pre-creates a pool of WebRTC offers when a room
is joined and hands them out later. Once a pooled offer is about a minute old, its ICE candidates are gone (they were
trickled before anyone listened), and every peer that arrives after that fails with "could not connect to peer after
exchanging SDP". Reproduced in the browser: hosts younger than a minute connected in about 1 s, hosts older than 75 s
failed every time. 0.26.0 replaced the pool with fresh offers per peer (and added receive limits, `maxReceiveBytes`,
which the transport uses); with it the same test connects at any host age. MQTT is not bundled (its client pulls in a large dependency tree); the
fallback is the BitTorrent tracker strategy, which has no dependencies.

Exports: `joinNostr`, `joinTorrent` (each Trystero's `joinRoom(config, roomId, callbacks)`), `nostrRelayUrls`,
`torrentTrackerUrls` (the default public relay and tracker lists), `nostrSockets`, `torrentSockets` (each
strategy's `getRelaySockets()`, used for connection diagnostics) and `selfId`.

`src/net/trystero.js` is the only file that imports it, lazily, so Classic Defense and vs Computer never load it.

## Rebuilding

In a scratch folder outside the project:

```sh
npm init -y
npm install --ignore-scripts --save-exact @trystero-p2p/core@0.26.0 @trystero-p2p/nostr@0.26.0 \
  @trystero-p2p/torrent@0.26.0 @noble/secp256k1@3.2.0 esbuild@0.28.2
cat > entry.mjs <<'EOF'
export { joinRoom as joinNostr, defaultRelayUrls as nostrRelayUrls, getRelaySockets as nostrSockets } from '@trystero-p2p/nostr';
export { joinRoom as joinTorrent, defaultRelayUrls as torrentTrackerUrls, getRelaySockets as torrentSockets } from '@trystero-p2p/torrent';
export { selfId } from '@trystero-p2p/core';
EOF
./node_modules/.bin/esbuild entry.mjs --bundle --format=esm --platform=browser --target=es2020 \
  --legal-comments=eof --charset=utf8 \
  --banner:js="// Trystero 0.26.0 (@trystero-p2p/core, nostr and torrent 0.26.0) with @noble/secp256k1 3.2.0, MIT licensed, see LICENSE. Generated, do not edit: see README.md in this folder." \
  --outfile=<project>/src/net/vendor/trystero.js
```

The result is 178,697 bytes, sha256 `b1d8ca8b36a6af30b4acef77d796c42eca7625640aebacb7c6222bc945f108c9`. Rebuilt with this
command on 2026-10-18 from the same registry packages (integrity as above): the same bytes. To check a copy, run
`shasum -a 256 src/net/vendor/trystero.js`.

`LICENSE` holds the MIT texts of Trystero (Dan Motzenbecker) and noble-secp256k1 (Paul Miller).
