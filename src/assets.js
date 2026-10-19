// Loads the Blender-rendered art of assets/v2 (docs/GRAPHICS-v2.md): manifest.json, layout.json and the WebP pages
// every sprite, animation frame and effect sheet sits on, plus the two opaque grounds and the console art.
//
// Asset URLs carry a version: the published build's stamp (tools/publish.mjs writes BUILD, a hash of the build), so a
// browser keeps what it has until the next build; a working copy has none and asks for fresh files on every load, so
// re-rendered sprites show up at once.
//
// Sets. Every page exists in up to three sets: hd (192 px per tile), normal (96) and light (48). A device loads its
// base set at start (src/device.js: light on phones and low-memory devices, normal on computers; a page without that set,
// such as the icons without light, falls back to another). Manifest coordinates never change with the set: every
// rectangle, anchor and size stays in manifest px (96 per tile), and an image's source rectangle is the rectangle times
// the image's scale `q` (light 0.5, normal 1, hd 2).
//
// Lazy upgrades. While the view shows more device px per tile than the base set has (src/device.js UP_AT, high-DPI
// screens only), every page that is drawn asks for its next set up (hd on computers, normal on phones), and every ground
// for its tiles. They load two at a time into a store capped at UP_CAP decoded bytes, least recently drawn out first
// (never one drawn in the last RECENT s); zoomed out again, an upgrade not drawn for IDLE s is dropped. Until an
// upgrade has arrived the base set is drawn. art.version counts arrivals (caches built from the art redraw then).
// Every page image bigger than CHUNK px (normal and hd pages, a phone's normal upgrades; not the icons and portraits,
// which only the console draws) is cut into chunks of at most CHUNK px as it loads, each sprite and frame whole in the
// chunk its corner falls in: Chromium redraws from big images slowly (measured in Brave on an M1 Mac: sub-rectangles
// of one 4096 x 4096 image at 5 to 16 fps, of four 2048 x 2048 images at 6 to 41 fps, of 8 to 64 images of 724 to
// 1448 px at 50 to 60 fps). The first draw of an upgraded chunk uploads it, so a frame draws from at most FRESH of them
// for the first time; the others draw the base set for a frame or two more.
//
// A page that fails to load (after retries, and in the other sets) becomes an empty placeholder with `missing` set:
// what sits on it is not drawn (effects fall back to the procedural ones), and the game keeps running.
//
// Sprite entries (towers, props, terrain sprites, icons, portraits) keep their v2 fields (page, sx, sy, w, h, ax, ay in
// manifest px) and get img and ss, the base image and its scale, for the console's own drawings (src(m) below).
// Animations (creeps, tower attacks and idles, effects, water glints) are drawn per frame through art.at(page, sx, sy).
import { LIGHT, BASE_SET, UP_SET, UP_CAP, UP_AT, upgrades } from './device.js?v=3947ef6d39d3';

export const BUILD = '3947ef6d39d3';
export const ROOT = 'assets/v2/';
const V = BUILD || String(Date.now());
const url = (path) => `${ROOT}${path}?v=${V}`;
const MB = 1048576;
const RECENT = 1.5;    // s: an upgrade drawn this recently is never dropped to make room for another
const IDLE = 10;       // s an upgrade may go undrawn while the view is zoomed out before it is dropped
const PARALLEL = 2;    // upgrades loading at once
const CHUNK = 1.5e6;   // image px an upgraded page's chunk may have (see above)
const FRESH = 2;       // chunks a frame may draw from for the first time (an upload: about 8 ms for 1.5 MP)
const SECTIONS = ['towers', 'props', 'terrain', 'icons', 'portraits'];   // sprite entries with page, sx, sy

// An image decoded before first use, so no frame that draws it stalls on its decoding: an ImageBitmap (decoded off the
// main thread, its memory given back at once by close() when an upgrade is dropped) where the browser makes one from a
// WebP blob, else an <img> after decode().
const bitmaps = typeof createImageBitmap === 'function' && typeof fetch === 'function';
async function loadImage(path, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      if (bitmaps) {
        const res = await fetch(url(path));
        if (!res.ok) throw new Error('Missing image: ' + path);
        const blob = await res.blob();
        try { return await createImageBitmap(blob); } catch { return await imageFrom(URL.createObjectURL(blob), true); }
      }
      return await imageFrom(url(path), false);
    } catch (err) {
      if (i >= tries) throw new Error('Missing image: ' + path);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
function imageFrom(src, revoke) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      img.onload = img.onerror = null;
      (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => { if (revoke) URL.revokeObjectURL(src); resolve(img); });
    };
    img.onerror = () => { img.onload = img.onerror = null; if (revoke) URL.revokeObjectURL(src); reject(new Error('bad image')); };
    img.src = src;
  });
}
// An empty image for a page that could not be loaded.
function placeholder() {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  c.missing = true;
  return c;
}

// The source rectangle, in its image's pixels, of the part x, y, w, h (manifest pixels from the sprite's corner; the
// whole sprite by default) of sprite m: ctx.drawImage(m.img, ...src(m), dx, dy, dw, dh). m.sx, m.sy are manifest px.
// (m.img is the chunk of a cut page the sprite is in, ox, oy that chunk's corner on the page.)
export const src = (m, x = 0, y = 0, w = m.w, h = m.h) => [(m.sx - (m.ox || 0) + x) * m.ss, (m.sy - (m.oy || 0) + y) * m.ss, w * m.ss, h * m.ss];

// ---------------------------------------------------------------- the art store
// An upgrade: one image of the next set up (a page's, or one ground tile's), with its decoded size.
// A page's upgrade may be cut into chunks (cutOf below): then `cells` holds them and img stays null.
class Up {
  constructor(file, q, w, h, x = 0, y = 0, cut = null) {
    this.file = file; this.q = q; this.w = w; this.h = h; this.x = x; this.y = y;   // w, h, x, y: manifest px
    this.cut = cut; this.cells = null;
    this.bytes = cut ? cut.bytes : Math.round(w * q) * Math.round(h * q) * 4;
    this.img = null; this.state = 'idle'; this.used = -1e9; this.retry = 0;
  }
}
// How a page image is cut: a G x G grid over the page (cell cw x ch manifest px); a rectangle belongs to the cell
// its corner is in, and that cell's chunk reaches from the corners of its rectangles to their far edges, so every
// rectangle is whole in one chunk. G is the smallest that keeps every chunk within CHUNK image px. null: one image.
function cutOf(w, h, q, rects) {
  if (!rects.length || w * h * q * q <= CHUNK) return null;
  for (let G = 2; G <= 8; G++) {
    const cw = w / G, ch = h / G, cells = new Array(G * G).fill(null);
    for (const r of rects) {
      const i = Math.min(G - 1, Math.floor(r[1] / ch)) * G + Math.min(G - 1, Math.floor(r[0] / cw));
      const c = cells[i] || (cells[i] = [r[0], r[1], r[0] + r[2], r[1] + r[3]]);
      if (r[0] < c[0]) c[0] = r[0]; if (r[1] < c[1]) c[1] = r[1];
      if (r[0] + r[2] > c[2]) c[2] = r[0] + r[2]; if (r[1] + r[3] > c[3]) c[3] = r[1] + r[3];
    }
    let bytes = 0, big = 0;
    for (const c of cells) if (c) { const a = Math.round((c[2] - c[0]) * q) * Math.round((c[3] - c[1]) * q); bytes += a * 4; big = Math.max(big, a); }
    if (big <= CHUNK || G === 8) return { G, cw, ch, cells, bytes };
  }
  return null;
}
// Loads `file` into o (a base page or an upgrade, with its scale q and its cut): the chunks into o.cells, or, uncut, the
// whole image into o.img. The chunks come from a worker that fetches, decodes and cuts the image, so the page's thread
// never copies its pixels (cutting a 4096 x 4096 page there held a frame for about 55 ms); without workers, or when
// one fails, the page's thread does it, and where the browser cannot crop the image stays whole.
async function loadInto(o, file, tries) {
  if (!o.cut) { o.img = await loadImage(file, tries); return; }
  const w = pool();
  if (w) {
    try {
      const out = await new Promise((resolve, reject) => {
        const id = ++cutId;
        w.jobs.set(id, [resolve, reject]);
        w.postMessage({ id, href: new URL(url(file), location.href).href, boxes: o.cut.cells.map((c) => c && box(c, o.q)) });
      });
      o.cells = out.map((b, i) => b && chunk(b, o.cut.cells[i]));
      return;
    } catch (err) { console.warn('cutting ' + file + ' on the page instead: ' + err.message); }
  }
  const img = await loadImage(file, tries);
  if (typeof createImageBitmap !== 'function') {   // Safari 14: the chunks as canvases, one at a time between frames
    try {
      const cells = [];
      for (const c of o.cut.cells) {
        if (!c) { cells.push(null); continue; }
        const [x, y, w, h] = box(c, o.q), k = document.createElement('canvas');
        k.width = w; k.height = h;
        k.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
        cells.push(chunk(k, c));
        await new Promise((r) => setTimeout(r, 0));
      }
      o.cells = cells;
    } catch { uncut(o, img); }
    return;
  }
  try {
    o.cells = await Promise.all(o.cut.cells.map((c) => c && createImageBitmap(img, ...box(c, o.q)).then((b) => chunk(b, c))));
    if (img.close) img.close();
  } catch { uncut(o, img); }
}
function uncut(o, img) {
  o.cut = null; o.cells = null; o.img = img;
  if (o instanceof Up) { const b = Math.round(o.w * o.q) * Math.round(o.h * o.q) * 4; art.bytes += b - o.bytes; o.bytes = b; }
}
const box = (c, q) => [Math.round(c[0] * q), Math.round(c[1] * q), Math.round((c[2] - c[0]) * q), Math.round((c[3] - c[1]) * q)];
const chunk = (b, c) => { b.x0 = c[0]; b.y0 = c[1]; b.shown = false; return b; };
// The chunk of o that the rectangle with its corner at sx, sy is in.
const cellOf = (o, sx, sy) => { const c = o.cut; return o.cells[Math.min(c.G - 1, Math.floor(sy / c.ch)) * c.G + Math.min(c.G - 1, Math.floor(sx / c.cw))]; };
const CUTTER = `onmessage = async (e) => {
  const { id, href, boxes } = e.data;
  try {
    const r = await fetch(href);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const img = await createImageBitmap(await r.blob());
    const out = await Promise.all(boxes.map((b) => b && createImageBitmap(img, b[0], b[1], b[2], b[3])));
    img.close();
    postMessage({ id, out }, out.filter(Boolean));
  } catch (err) { postMessage({ id, error: String(err && err.message || err) }); }
};`;
// A few such workers, used in turn (null: none can be made).
let workers = null, cutId = 0, turn = 0;
function pool() {
  if (workers === null) {
    workers = [];
    if (typeof Worker === 'function' && typeof location !== 'undefined' && typeof createImageBitmap === 'function') {
      try {
        const href = URL.createObjectURL(new Blob([CUTTER], { type: 'text/javascript' }));
        const n = Math.max(1, Math.min(3, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1));
        for (let i = 0; i < n; i++) {
          const w = new Worker(href);
          w.jobs = new Map();
          w.onmessage = (e) => { const j = w.jobs.get(e.data.id); if (!j) return; w.jobs.delete(e.data.id); if (e.data.error) j[1](new Error(e.data.error)); else j[0](e.data.out); };
          w.onerror = () => { w.dead = true; for (const [, j] of w.jobs) j[1](new Error('worker failed')); w.jobs.clear(); };
          workers.push(w);
        }
      } catch { /* none */ }
    }
  }
  const live = workers.filter((w) => !w.dead);
  return live.length ? live[turn++ % live.length] : null;
}
const NONE = typeof document !== 'undefined' ? placeholder() : null;

class Art {
  constructor() {
    this.pages = new Map();      // name -> { name, img, q, up: Up | null, missing, cut, cells }
    this.grounds = [];           // the grounds (man.ground, man.lane.ground): their base images
    this.ups = [];               // every Up (pages' and grounds' tiles)
    this.bytes = 0;              // decoded bytes of the upgrades loaded or loading
    this.queue = []; this.loading = 0;
    this.want = false;           // the view is zoomed in past the base set (and this screen may upgrade)
    this.version = 0;            // upgrades that have arrived (caches made from the art compare it)
    this.track = null;           // while a cache is made: the upgrades it wanted that were not there yet
    this.t = 0;
    this.base = BASE_SET; this.scale = 1;
    this.outSince = null;        // when the view stopped wanting upgrades (-1: and their frames are dropped)
    this.fresh = FRESH; this.S = { img: null, x: 0, y: 0, q: 1 };
  }
  // Once per frame, from the renderer: the device px per tile the view shows.
  frame(devPerTile) {
    this.t = performance.now() / 1000;
    this.fresh = FRESH;
    this.want = upgrades() && devPerTile > UP_AT * 96 * this.scale;
    if (this.want) { this.outSince = null; return; }
    if (this.bytes) for (const u of this.ups) if (u.state === 'ready' && this.t - u.used > IDLE) this.drop(u);
    // the frames composed from upgrades (tower strips, tinted creep frames) go with them
    if (this.outSince === null) this.outSince = this.t;
    else if (this.t - this.outSince > IDLE && this.outSince !== -1) {
      const fine = (c) => c.q > this.scale;
      strips.prune(fine); tints.prune(fine);
      this.outSince = -1;
    }
  }
  // Where to draw the rectangle with its corner at sx, sy (manifest px) of page p from: { img, x, y, q }, the image,
  // the rectangle's corner in it (image px) and its scale; the upgrade's chunk when there is one, else the base set's.
  // One object, reused: read it before the next call. whole: a cache being made (any chunk may be drawn first now);
  // base: the base set's, never the upgrade.
  at(p, sx, sy, whole = false, base = false) {
    const S = this.S, u = base ? p : this.pick(p);
    if (u.cells) {
      const b = cellOf(u, sx, sy);
      if (b && (u === p || b.shown || whole || this.track || this.fresh-- > 0)) {
        b.shown = true;
        S.img = b; S.q = u.q; S.x = (sx - b.x0) * u.q; S.y = (sy - b.y0) * u.q;
        return S;
      }
      if (u !== p) return this.at(p, sx, sy, whole, true);   // the base set until this chunk's turn comes
      S.img = NONE; S.q = 1; S.x = 0; S.y = 0;              // not on the page (cannot happen)
      return S;
    }
    S.img = u.img || NONE; S.q = u.q; S.x = sx * u.q; S.y = sy * u.q;
    return S;
  }
  // The image to draw page p from: { img, q }, its upgrade when wanted and loaded, else the base image.
  pick(p) {
    const u = p.up;
    if (u && this.want && u.q > p.q) {
      u.used = this.t;
      if (u.state === 'ready') return u;
      if (u.state === 'idle') this.request(u);
      if (this.track) this.track.push(u);
    }
    return p;
  }
  // A ground's upgraded tiles, when wanted and every one of them is loaded (else null: draw the base image). Asking
  // marks them drawn and starts any that are missing.
  groundUp(g) {
    if (!this.want || !g.ups || !g.ups.length) return null;
    let ok = true;
    for (const u of g.ups) {
      u.used = this.t;
      if (u.state !== 'ready') { ok = false; if (u.state === 'idle') this.request(u); if (this.track) this.track.push(u); }
    }
    return ok ? g.ups : null;
  }
  request(u) {
    if (this.t < u.retry) return;
    if (this.bytes + u.bytes > UP_CAP && !this.room(u.bytes)) { u.retry = this.t + 1; return; }
    u.state = 'queued'; this.bytes += u.bytes;
    this.queue.push(u);
    this.pump();
  }
  // Drops the least recently drawn upgrades not drawn in the last RECENT s until `bytes` more fit.
  room(bytes) {
    const old = this.ups.filter((u) => u.state === 'ready' && this.t - u.used > RECENT).sort((a, b) => a.used - b.used);
    for (const u of old) {
      if (this.bytes + bytes <= UP_CAP) break;
      this.drop(u);
    }
    return this.bytes + bytes <= UP_CAP;
  }
  drop(u) {
    if (u.state !== 'ready') return;
    if (u.img && u.img.close) u.img.close();   // an ImageBitmap's pixels go now, not at the next collection
    if (u.cells) for (const b of u.cells) if (b && b.close) b.close(); else if (b) b.width = b.height = 0;   // canvas chunks
    u.img = null; u.cells = null; u.state = 'idle'; this.bytes -= u.bytes;
  }
  pump() {
    while (this.loading < PARALLEL && this.queue.length) {
      const u = this.queue.shift();
      if (performance.now() / 1000 - u.used > 3) { u.state = 'idle'; this.bytes -= u.bytes; continue; }   // no longer drawn
      u.state = 'loading'; this.loading++;
      loadInto(u, u.file, 2).then(() => { u.state = 'ready'; this.version++; },
        () => { u.state = 'failed'; this.bytes -= u.bytes; console.warn('could not load ' + u.file + ': drawing the base art'); })
        .finally(() => { this.loading--; this.pump(); });
    }
  }
  // what is loaded, for the console (window.wc.art.stats())
  stats() {
    const px = (i) => (i && i.width ? i.width * i.height : 0);
    let base = 0, chunks = 0;
    for (const p of this.pages.values()) if (p.cells) for (const b of p.cells) { base += px(b); chunks++; } else base += px(p.img);
    for (const g of this.grounds) base += px(g.img);
    const r = { base: this.base, baseMB: +(base * 4 / MB).toFixed(1), chunks, want: this.want, upMB: +(this.bytes / MB).toFixed(1), capMB: UP_CAP / MB,
      loading: this.loading, queued: this.queue.length, ready: this.ups.filter((u) => u.state === 'ready').map((u) => u.file) };
    return r;
  }
}
export const art = new Art();

// ---------------------------------------------------------------- caches of frames made from the art
// A small least-recently-used store of canvases, capped in decoded bytes. A canvas it lets go is emptied at once
// (width 0): its backing store goes then, not at some later collection (iOS Safari caps all canvases together).
class CanvasCache {
  constructor(cap) { this.cap = cap; this.map = new Map(); this.bytes = 0; }
  prune(drop) {
    for (const [k, c] of this.map) if (drop(c)) { this.map.delete(k); this.bytes -= c.width * c.height * 4; c.width = c.height = 0; }
  }
  get(key) {
    const c = this.map.get(key);
    if (c) { this.map.delete(key); this.map.set(key, c); }
    return c;
  }
  set(key, c) {
    const b = c.width * c.height * 4;
    this.map.set(key, c); this.bytes += b;
    for (const [k, o] of this.map) {
      if (this.bytes <= this.cap || k === key) break;
      this.map.delete(k); this.bytes -= o.width * o.height * 4; o.width = o.height = 0;
    }
    return c;
  }
}
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };

// A creep frame's slowed ('slow') or hit ('hit') look: the frame with the tint over it, made the first time it is drawn
// and kept per frame (page, rectangle, set), so only the frames actually drawn tinted cost a canvas.
const TINTS = { slow: 'rgba(80,160,255,0.45)', hit: 'rgba(255,255,255,0.55)' };
const tints = new CanvasCache((LIGHT ? 8 : 48) * MB);
export function tintedFrame(pg, r, kind) {
  const q = art.pick(pg).q, key = `${kind}|${r[0]}|${r[1]}|${q}|${r.pg}`;
  let c = tints.get(key);
  if (!c) {
    c = canvas(r[2] * q, r[3] * q);
    c.q = q;
    const x = c.getContext('2d'), S = art.at(pg, r[0], r[1], true);
    x.drawImage(S.img, S.x, S.y, r[2] * S.q, r[3] * S.q, 0, 0, c.width, c.height);
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = TINTS[kind];
    x.fillRect(0, 0, c.width, c.height);
    tints.set(key, c);
  }
  return c;
}
// A tower animation's frames composed over its base (docs/GRAPHICS-v2.md, Towers): one strip canvas per tower, anim and
// set, cell i = the base with the patch rectangle replaced by patch i. Drawn exactly like the base, so frames never
// leave a seam. Made the first time the tower plays the anim, for the set its page is drawn from; at most MAKE strips a
// frame (null: draw the base this frame), so a view full of tower types the store cannot hold all of never stalls.
const strips = new CanvasCache((LIGHT ? 16 : 96) * MB), MAKE = 2;
let made = 0, madeAt = -1;
export function towerStrip(m, name) {
  const a = m.anims[name], q = art.pick(m.pg).q, key = `${m.key}|${name}|${q}`;
  let c = strips.get(key);
  if (!c) {
    if (madeAt !== art.t) { madeAt = art.t; made = 0; }
    if (made >= MAKE) return null;
    made++;
    const cw = Math.round(m.w * q), ch = Math.round(m.h * q), [dx, dy, pw, ph] = a.patch;
    c = canvas(cw * a.frames, ch);
    const x = c.getContext('2d');
    for (let i = 0; i < a.frames; i++) {
      const r = a.rects[i], ox = i * cw;
      let S = art.at(m.pg, m.sx, m.sy, true);
      x.drawImage(S.img, S.x, S.y, m.w * S.q, m.h * S.q, ox, 0, cw, ch);
      x.clearRect(ox + dx * q, dy * q, pw * q, ph * q);
      S = art.at(m.pg, r[0], r[1], true);
      x.drawImage(S.img, S.x, S.y, r[2] * S.q, r[3] * S.q, ox + dx * q, dy * q, pw * q, ph * q);
    }
    c.cw = cw; c.q = q;
    strips.set(key, c);
  }
  return c;
}

// ---------------------------------------------------------------- loading
export async function loadAssets(onProgress) {
  const man = await fetch(url('manifest.json')).then((r) => { if (!r.ok) throw new Error('Missing ' + ROOT + 'manifest.json'); return r.json(); });
  const layout = await fetch(url('layout.json')).then((r) => r.json());
  const setsOrder = [BASE_SET, ...['normal', 'light', 'hd'].filter((s) => s !== BASE_SET)];   // fallbacks after the base
  art.scale = man.sets[BASE_SET].scale;
  const scaleOf = (s) => man.sets[s].scale;
  const jobs = [];   // [file candidates, apply(loaded, set), load(file, set)?]
  const loaded = [];   // files actually loaded (for the service worker)

  // every rectangle on each page (sprites, frames), to cut its upgrade by
  const onPage = new Map(), put = (page, r) => { if (page) (onPage.get(page) || onPage.set(page, []).get(page)).push(r); };
  for (const sec of [...SECTIONS, 'creeps', 'effects']) {
    for (const m of Object.values(man[sec] || {})) {
      if (!m || typeof m !== 'object') continue;
      if (m.page && (m.w || m.fw)) put(m.page, [m.sx || 0, m.sy || 0, m.fw ? m.fw * (m.frames || 1) : m.w, m.fh ? m.fh * ((m.dirs && m.dirs.length) || 1) : m.h]);
      for (const a of Object.values(m.anims || {})) for (const r of a.rects || []) put(a.page, r);
    }
  }
  // pages
  for (const [name, pg] of Object.entries(man.pages)) {
    const p = { name, img: null, q: 1, up: null, missing: false, cut: null, cells: null };
    art.pages.set(name, p);
    const files = pg.files || {};
    const cands = setsOrder.filter((s) => s !== 'hd' && files[s]);
    if (files.hd) cands.push('hd');   // the last resort (heavy, but the sprites show)
    // cut like an upgrade where the page is big, unless the console alone draws from it (icons, portraits)
    const cut = (s) => (pg.section === 'icons' || pg.section === 'portraits' ? null : cutOf(pg.w, pg.h, scaleOf(s), onPage.get(name) || []));
    const load = async (file, s) => { const o = { q: scaleOf(s), cut: cut(s), img: null, cells: null }; await loadInto(o, file, 3); return o; };
    jobs.push([cands.map((s) => [files[s], s]), (o, s) => {
      if (o.missing) { p.img = o; p.missing = true; return; }
      p.q = o.q; p.img = o.img; p.cells = o.cells; p.cut = o.cells ? o.cut : null;
    }, load]);
    // the next set up, when this page has it and it is finer than what loads now
    if (files[UP_SET] && scaleOf(UP_SET) > scaleOf(cands[0] || BASE_SET)) {
      p.up = new Up(files[UP_SET], scaleOf(UP_SET), pg.w, pg.h, 0, 0, cutOf(pg.w, pg.h, scaleOf(UP_SET), onPage.get(name) || []));
      art.ups.push(p.up);
    }
  }
  // grounds: one base image each, and the upgrade as tiles (hd) or one image (a phone's normal)
  const grounds = [man.ground, man.lane && man.lane.ground].filter((g) => g && g.sets);
  art.grounds = grounds;
  for (const g of grounds) {
    const cands = setsOrder.filter((s) => g.sets[s] && g.sets[s].file);
    jobs.push([cands.map((s) => [g.sets[s].file, s]), (img, s) => { g.img = img; g.q = scaleOf(s); g.missing = !!img.missing; }]);
    const up = g.sets[UP_SET];
    g.ups = [];
    if (up && scaleOf(UP_SET) > scaleOf(cands[0] || BASE_SET)) {
      if (up.tiles) for (const [file, x, y, w, h] of up.tiles) g.ups.push(new Up(file, scaleOf(UP_SET), w, h, x, y));
      else if (up.file) g.ups.push(new Up(up.file, scaleOf(UP_SET), g.w, g.h));
      art.ups.push(...g.ups);
    }
  }
  // the console art (also used by style.css)
  for (const m of Object.values(man.ui || {})) if (m && m.file) jobs.push([[[m.file, 'normal']], (img) => { m.img = img; m.ss = 1; m.sx = 0; m.sy = 0; }]);

  let done = 0;
  const queue = [...jobs];
  const worker = async () => {          // four downloads at a time
    while (queue.length) {
      const [cands, apply, load] = queue.shift();
      let img = null, set = null;
      for (const [file, s] of cands) {
        try { img = load ? await load(file, s) : await loadImage(file); set = s; loaded.push(file); break; } catch (e) { console.warn(e.message + (cands.length > 1 ? ': trying another set' : '')); }
      }
      if (!img) { img = placeholder(); set = BASE_SET; }
      apply(img, set);
      onProgress?.(++done / jobs.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // sprite entries: their page's base image and scale (for the console), the page itself for the renderer
  for (const sec of SECTIONS) {
    for (const [key, m] of Object.entries(man[sec] || {})) {
      if (!m || typeof m !== 'object') continue;
      m.key = key;
      const p = m.page && art.pages.get(m.page);
      if (p) place(m, p);
      linkAnims(m);
    }
  }
  for (const [key, m] of Object.entries(man.creeps || {})) {
    m.key = key;
    const p = m.page && art.pages.get(m.page);   // an old-format creep (one sheet, no anims)
    if (p) place(m, p);
    linkAnims(m);
  }
  for (const m of Object.values(man.effects || {})) linkAnims(m);
  man.light = LIGHT;
  // what was loaded, for the service worker to keep (src/client/app.js)
  const urls = ['manifest.json', 'layout.json', ...loaded].map(url);
  return { man, layout, urls };
}
// A sprite entry's page (m.pg, for the renderer) and its base image for the console (m.img, m.ss, and the corner ox, oy
// of the chunk it is in on a cut page).
function place(m, p) {
  m.pg = p; m.ss = p.q; m.sx = m.sx || 0; m.sy = m.sy || 0;
  const b = p.cells && cellOf(p, m.sx, m.sy);
  if (b) { m.img = b; m.ox = b.x0; m.oy = b.y0; } else { m.img = p.img; m.ox = m.oy = 0; }
}
// Every anim gets its page object (a.pg) and every frame rectangle its page name (r.pg, for the tint cache's key).
function linkAnims(m) {
  if (!m.anims) return;
  for (const a of Object.values(m.anims)) {
    a.pg = art.pages.get(a.page) || { img: placeholder(), q: 1, up: null, missing: true };
    if (!a.page || !a.rects) a.rects = [];   // not packed yet (the art is being re-rendered): nothing to draw
    for (const r of a.rects) r.pg = a.page;
  }
}

if (typeof window !== 'undefined') window.wcArt = art;
