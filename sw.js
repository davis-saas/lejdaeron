// The service worker of a published build (src/client/app.js registers it; a working copy has none). After the first
// visit Classic Defense and vs Computer work without a network, and a new build is picked up on the next load:
// - The page (index.html), every module and the files without a version (the app manifest, the icons): the network
//   first, the cache only when the network fails. A page that loads online is always the newest build, and every file it
//   names carries that build's ?v=, so old code is never served after an update. (A module or the page the network
//   stalls on for STALL ms comes from the cache: a versioned URL always holds the same bytes, and the cached page is
//   this build's, which names only files this cache holds. After a stall the next ones come from the cache at once for
//   a while, so a page whose modules import one another does not wait STALL ms at every step.)
// - This build's other ?v= files (the stylesheet, the art, the data, the console images): the cache first. That keeps
//   the art pages this device draws from: its base set (assets/v2/normal on a computer, assets/v2/light on a phone)
//   and, once fetched, the upgrades it loads while zoomed in (hd, or normal on a phone).
// - The fonts (Google Fonts): the cache first. Nothing else is touched: vs Players' signalling (WebSockets to public
//   relays) and WebRTC never pass through here.
// Each build has its own cache, filled when it installs: the page, the stylesheet, the modules, the console art and the
// map pictures (the start screen's, which the page loads before this worker exists), plus the base set of art the
// build before it kept (light or normal, whichever this device loads; its zoomed-in upgrades are fetched again only
// when drawn) and the fonts. The page adds what it loaded on top (a 'keep' message), which covers the first visit.
// Older builds' caches go once it is active.
// The page is kept only by the install: a page the network brings may be a newer build's (whose worker is still
// installing), and in this cache it would name files that are not here.
// tools/publish.mjs writes the three constants below.
const VERSION = '3947ef6d39d3';
const FILES = ["./","style.css?v=3947ef6d39d3","app.webmanifest","assets/app/apple-touch-icon.png","assets/app/favicon-32.png","assets/app/icon-192.png","assets/app/icon-512.png","assets/app/icon-maskable-512.png","assets/maps/classic.jpg?v=3947ef6d39d3","assets/maps/gemtd.jpg?v=3947ef6d39d3","assets/maps/ltw.jpg?v=3947ef6d39d3","assets/maps/ttw.jpg?v=3947ef6d39d3","assets/v2/layout.json?v=3947ef6d39d3","assets/v2/manifest.json?v=3947ef6d39d3","assets/v2/ui/btn_wide.png?v=3947ef6d39d3","assets/v2/ui/btn_wide_hover.png?v=3947ef6d39d3","assets/v2/ui/button.png?v=3947ef6d39d3","assets/v2/ui/button_active.png?v=3947ef6d39d3","assets/v2/ui/button_empty.png?v=3947ef6d39d3","assets/v2/ui/button_hover.png?v=3947ef6d39d3","assets/v2/ui/console_bg.png?v=3947ef6d39d3","assets/v2/ui/corner.png?v=3947ef6d39d3","assets/v2/ui/crest.png?v=3947ef6d39d3","assets/v2/ui/dialog.png?v=3947ef6d39d3","assets/v2/ui/frame_gold.png?v=3947ef6d39d3","assets/v2/ui/frame_minimap.png?v=3947ef6d39d3","assets/v2/ui/portrait_frame.png?v=3947ef6d39d3","assets/v2/ui/res_gold.png?v=3947ef6d39d3","assets/v2/ui/res_income.png?v=3947ef6d39d3","assets/v2/ui/res_level.png?v=3947ef6d39d3","assets/v2/ui/res_lives.png?v=3947ef6d39d3","assets/v2/ui/res_lumber.png?v=3947ef6d39d3","assets/v2/ui/res_wisp.png?v=3947ef6d39d3","assets/v2/ui/tooltip.png?v=3947ef6d39d3","assets/v2/ui/topbar.png?v=3947ef6d39d3","assets/v2/ui/topbar_center.png?v=3947ef6d39d3","src/assets.js?v=3947ef6d39d3","src/bot.js?v=3947ef6d39d3","src/client/app.js?v=3947ef6d39d3","src/client/camera.js?v=3947ef6d39d3","src/client/common.js?v=3947ef6d39d3","src/client/hud.js?v=3947ef6d39d3","src/client/lanes.js?v=3947ef6d39d3","src/client/ltw.js?v=3947ef6d39d3","src/client/maps.js?v=3947ef6d39d3","src/client/online.js?v=3947ef6d39d3","src/client/screens.js?v=3947ef6d39d3","src/client/touch.js?v=3947ef6d39d3","src/data/creeps.js?v=3947ef6d39d3","src/data/ltw.js?v=3947ef6d39d3","src/data/rules.js?v=3947ef6d39d3","src/data/towers.js?v=3947ef6d39d3","src/device.js?v=3947ef6d39d3","src/field.js?v=3947ef6d39d3","src/fx.js?v=3947ef6d39d3","src/game.js?v=3947ef6d39d3","src/lane.js?v=3947ef6d39d3","src/level.js?v=3947ef6d39d3","src/main.js?v=3947ef6d39d3","src/match.js?v=3947ef6d39d3","src/net/auth.js?v=3947ef6d39d3","src/net/client.js?v=3947ef6d39d3","src/net/config.js?v=3947ef6d39d3","src/net/host.js?v=3947ef6d39d3","src/net/host_worker.js?v=3947ef6d39d3","src/net/protocol.js?v=3947ef6d39d3","src/net/replica.js?v=3947ef6d39d3","src/net/session.js?v=3947ef6d39d3","src/net/transport.js?v=3947ef6d39d3","src/net/trystero.js?v=3947ef6d39d3","src/net/vendor/trystero.js?v=3947ef6d39d3","src/render.js?v=3947ef6d39d3","src/rng.js?v=3947ef6d39d3","src/session_local.js?v=3947ef6d39d3","src/sheets.js?v=3947ef6d39d3","src/ui.js?v=3947ef6d39d3"];      // precached: the page ('./'), then paths with ?v=VERSION and the app icons
const ASSETS = ["assets/app/apple-touch-icon.png","assets/app/favicon-32.png","assets/app/icon-192.png","assets/app/icon-512.png","assets/app/icon-maskable-512.png","assets/maps/classic.jpg","assets/maps/gemtd.jpg","assets/maps/ltw.jpg","assets/maps/ttw.jpg","assets/v2/hd/creeps_0.webp","assets/v2/hd/creeps_1.webp","assets/v2/hd/creeps_10.webp","assets/v2/hd/creeps_11.webp","assets/v2/hd/creeps_12.webp","assets/v2/hd/creeps_2.webp","assets/v2/hd/creeps_3.webp","assets/v2/hd/creeps_4.webp","assets/v2/hd/creeps_5.webp","assets/v2/hd/creeps_6.webp","assets/v2/hd/creeps_7.webp","assets/v2/hd/creeps_8.webp","assets/v2/hd/creeps_9.webp","assets/v2/hd/effects_0.webp","assets/v2/hd/ground_0_0.webp","assets/v2/hd/ground_0_1.webp","assets/v2/hd/ground_1_0.webp","assets/v2/hd/ground_1_1.webp","assets/v2/hd/ground_2_0.webp","assets/v2/hd/ground_2_1.webp","assets/v2/hd/lane9_ground_0_0.webp","assets/v2/hd/lane9_ground_1_0.webp","assets/v2/hd/lane9_ground_2_0.webp","assets/v2/hd/lane9_ground_3_0.webp","assets/v2/hd/lane9_ground_4_0.webp","assets/v2/hd/lane9_ground_5_0.webp","assets/v2/hd/props_0.webp","assets/v2/hd/terrain_0.webp","assets/v2/hd/towers_0.webp","assets/v2/hd/towers_1.webp","assets/v2/layout.json","assets/v2/light/creeps_0.webp","assets/v2/light/creeps_1.webp","assets/v2/light/creeps_10.webp","assets/v2/light/creeps_11.webp","assets/v2/light/creeps_12.webp","assets/v2/light/creeps_2.webp","assets/v2/light/creeps_3.webp","assets/v2/light/creeps_4.webp","assets/v2/light/creeps_5.webp","assets/v2/light/creeps_6.webp","assets/v2/light/creeps_7.webp","assets/v2/light/creeps_8.webp","assets/v2/light/creeps_9.webp","assets/v2/light/effects_0.webp","assets/v2/light/ground.webp","assets/v2/light/lane9_ground.webp","assets/v2/light/portraits_0.webp","assets/v2/light/portraits_1.webp","assets/v2/light/portraits_2.webp","assets/v2/light/props_0.webp","assets/v2/light/terrain_0.webp","assets/v2/light/towers_0.webp","assets/v2/light/towers_1.webp","assets/v2/manifest.json","assets/v2/normal/creeps_0.webp","assets/v2/normal/creeps_1.webp","assets/v2/normal/creeps_10.webp","assets/v2/normal/creeps_11.webp","assets/v2/normal/creeps_12.webp","assets/v2/normal/creeps_2.webp","assets/v2/normal/creeps_3.webp","assets/v2/normal/creeps_4.webp","assets/v2/normal/creeps_5.webp","assets/v2/normal/creeps_6.webp","assets/v2/normal/creeps_7.webp","assets/v2/normal/creeps_8.webp","assets/v2/normal/creeps_9.webp","assets/v2/normal/effects_0.webp","assets/v2/normal/ground.webp","assets/v2/normal/icons_0.webp","assets/v2/normal/lane9_ground.webp","assets/v2/normal/portraits_0.webp","assets/v2/normal/portraits_1.webp","assets/v2/normal/portraits_2.webp","assets/v2/normal/props_0.webp","assets/v2/normal/terrain_0.webp","assets/v2/normal/towers_0.webp","assets/v2/normal/towers_1.webp","assets/v2/ui/btn_wide.png","assets/v2/ui/btn_wide_hover.png","assets/v2/ui/button.png","assets/v2/ui/button_active.png","assets/v2/ui/button_empty.png","assets/v2/ui/button_hover.png","assets/v2/ui/console_bg.png","assets/v2/ui/corner.png","assets/v2/ui/crest.png","assets/v2/ui/dialog.png","assets/v2/ui/frame_gold.png","assets/v2/ui/frame_minimap.png","assets/v2/ui/portrait_frame.png","assets/v2/ui/res_gold.png","assets/v2/ui/res_income.png","assets/v2/ui/res_level.png","assets/v2/ui/res_lives.png","assets/v2/ui/res_lumber.png","assets/v2/ui/res_wisp.png","assets/v2/ui/tooltip.png","assets/v2/ui/topbar.png","assets/v2/ui/topbar_center.png"];     // every file under assets/ in this build (paths), which an older cache's art may come from

const SCOPE = new URL(self.registration.scope);
const PREFIX = `lejdaeron:${SCOPE.pathname}:`;    // one site can hold other builds of the game under other paths
const CACHE = PREFIX + VERSION;
const PAGE = SCOPE.href;                           // the page's cache key, whatever query the URL had
const PRECACHE = FILES.map((f) => new URL(f, SCOPE).href);
const FONTS = /^fonts\.(googleapis|gstatic)\.com$/;
const STALL = 4000;                                // ms a versioned module waits for the network before the cache answers
const STALLED_FOR = 30000;                         // ms after a stall in which the cache answers those at once
let stalledAt = -Infinity;

self.addEventListener('install', (ev) => ev.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // 'no-cache': ask the server every time, so the HTTP cache never puts an older page into a newer build's cache
  await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'no-cache' })));
  const paths = new Set(), fonts = [];
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX) || name === CACHE) continue;
    const old = await caches.open(name);
    for (const req of await old.keys()) {
      const u = new URL(req.url);
      if (FONTS.test(u.hostname)) fonts.push([req, await old.match(req)]);
      else if (u.origin === SCOPE.origin && u.pathname.startsWith(SCOPE.pathname + 'assets/')) {
        const path = u.pathname.slice(SCOPE.pathname.length);
        if (ASSETS.includes(path)) paths.add(path);
      }
    }
  }
  // the device's base set: light if it kept any light pages (a phone), else normal; not the sets above it
  const base = [...paths].some((p) => p.startsWith('assets/v2/light/')) ? 'light' : 'normal';
  const art = new Set();
  for (const p of paths) {
    const set = /^assets\/v2\/(hd|normal|light)\//.exec(p);
    if (!set || set[1] === base) art.add(new URL(`${p}?v=${VERSION}`, SCOPE).href);
  }
  await cache.addAll([...art].filter((u) => !PRECACHE.includes(u)));
  for (const [req, res] of fonts) if (res) await cache.put(req, res);
  await self.skipWaiting();
})()));

self.addEventListener('activate', (ev) => ev.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (FONTS.test(url.hostname)) { ev.respondWith(cacheFirst(req, true)); return; }
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (req.mode === 'navigate') {
    if (url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + 'index.html') ev.respondWith(page(req));
    return;
  }
  if (url.searchParams.get('v') === VERSION && !url.pathname.endsWith('.js')) ev.respondWith(cacheFirst(req, false));
  else ev.respondWith(networkFirst(req));
});

// The page: from the server whenever it answers within STALL ms, else this build's page from the cache (the network's
// answer, should it come later, is dropped; the next load asks again).
async function page(req) {
  const cache = await caches.open(CACHE);
  const net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
    .then((res) => (res.redirected ? Response.redirect(res.url, 302) : res));
  net.catch(() => {});   // the cache may answer first
  try {
    return await Promise.race([net, stall(net, () => cache.match(PAGE)).then((hit) => hit || net)]);
  } catch (err) {
    const hit = await cache.match(PAGE);
    if (hit) return hit;
    throw err;
  }
}

// Kept in this build's cache: files without a version and this build's own (an older page's ?v= URLs now fetch the
// newer build's files from the server, which must not be kept under the old names).
async function networkFirst(req) {
  const cache = await caches.open(CACHE), v = new URL(req.url).searchParams.get('v');
  const net = fetch(req).then((res) => {
    if (res.ok && (v === null || v === VERSION)) cache.put(req, res.clone());
    return res;
  });
  try {
    if (v !== VERSION) return await net;
    net.catch(() => {});   // the cache may answer first
    const hit = Date.now() - stalledAt < STALLED_FOR && await cache.match(req);
    if (hit) return hit;
    return await Promise.race([net, stall(net, () => cache.match(req)).then((hit) => hit || net)]);
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

// The cache's answer when the network has not answered a request (net) within STALL ms, and the time of that stall.
async function stall(net, match) {
  let answered = false;
  net.then(() => { answered = true; }, () => { answered = true; });
  await new Promise((resolve) => setTimeout(resolve, STALL));
  if (answered) return null;
  const hit = await match();
  if (hit) stalledAt = Date.now();
  return hit;
}

async function cacheFirst(req, font) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  // a font stylesheet comes as a cors response, so it can be kept whole and given to the page's no-cors request later
  const res = await fetch(font ? new Request(req.url, { mode: 'cors', credentials: 'omit' }) : req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

// What a page of this build loaded: the art for this device, the data, the fonts.
self.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.type !== 'keep' || !Array.isArray(d.urls)) return;
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const href of d.urls.slice(0, 400)) {
      let u;
      try { u = new URL(href, SCOPE); } catch { continue; }
      const font = FONTS.test(u.hostname);
      if (!font && !(u.origin === SCOPE.origin && u.pathname.startsWith(SCOPE.pathname) && u.searchParams.get('v') === VERSION)) continue;
      if (await cache.match(u.href)) continue;
      try {
        const res = await fetch(font ? new Request(u.href, { mode: 'cors', credentials: 'omit' }) : u.href);
        if (res.ok) await cache.put(u.href, res.clone());
        if (res.ok && u.hostname === 'fonts.googleapis.com') await keepFonts(cache, await res.text());
      } catch { /* the next visit tries again */ }
    }
  })());
});

// The font files a Google Fonts stylesheet names for the Latin letters (the ones the game's text uses).
async function keepFonts(cache, css) {
  for (const [face] of css.matchAll(/@font-face\s*{[^}]*}/g)) {
    const src = face.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
    if (!src || !/U\+0000-00FF/i.test(face) || await cache.match(src[1])) continue;
    try {
      const res = await fetch(new Request(src[1], { mode: 'cors', credentials: 'omit' }));
      if (res.ok) await cache.put(src[1], res);
    } catch { /* the next visit tries again */ }
  }
}
