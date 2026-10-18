// Loads the Blender-rendered sprite atlases listed in assets/manifest.json; tinted() makes a creep's slowed and hit looks.
// Asset URLs carry a version: the published build's stamp (tools/publish.mjs writes BUILD, a hash of the build), so a
// browser keeps what it has until the next build; a working copy has none and asks for fresh files on every load, so
// re-rendered sprites show up at once.
//
// With the light set (src/device.js: phones, tablets, little memory) the atlases and grounds come from assets/light at
// half size (tools/light_art.mjs). Every manifest entry keeps its sizes and anchors in the manifest's own pixels, so
// everything is placed and drawn exactly as before; `ss` is the image's pixels per manifest pixel (1, or 0.5 for the
// light art) and `sx`, `sy` are in the image's pixels, so a sprite's source rectangle is sx, sy, w * ss, h * ss (a
// frame's: sx + col * fw * ss, ...). The light atlases are trusted only while light.json says they were made from this
// manifest (after a repack, until they are made again, everything loads at full size).
import { LIGHT } from './device.js?v=99dfd38af943';

export const BUILD = '99dfd38af943';
const V = BUILD || String(Date.now());
const url = (path) => `assets/${path}?v=${V}`;

function loadImage(path, tries = 3) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => (tries > 1 ? setTimeout(() => loadImage(path, tries - 1).then(resolve, reject), 300) : reject(new Error('Missing image: ' + path)));
    img.src = url(path);
  });
}

// FNV-1a over the manifest's text, as tools/light_art.mjs computes it
function textHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
async function lightSet(manText) {
  try {
    const info = await fetch(url('light/light.json')).then(r => (r.ok ? r.json() : null));
    if (info && info.manifest === textHash(manText)) return info;
    console.warn('assets/light was made from another manifest: loading the full art (node tools/light_art.mjs remakes it)');
  } catch { /* no light set: the full art */ }
  return null;
}

// The source rectangle, in its image's pixels, of the part x, y, w, h (manifest pixels from the sprite's corner; the
// whole sprite by default) of sprite m: ctx.drawImage(m.img, ...src(m), dx, dy, dw, dh).
export const src = (m, x = 0, y = 0, w = m.w, h = m.h) => [m.sx + x * m.ss, m.sy + y * m.ss, w * m.ss, h * m.ss];

// A creep's slowed ('slow') or hit ('hit') look: its own frames with the tint over them, made the first time it is drawn,
// as a sprite entry of its own (sx, sy 0). Tinting single sprites instead of whole atlas pages keeps the extra canvases
// as small as the creeps that are actually slowed or hit.
const TINTS = { slow: 'rgba(80,160,255,0.45)', hit: 'rgba(255,255,255,0.55)' };
export function tinted(m, kind) {
  const key = kind + 'Look';
  if (!m[key]) {
    const q = m.ss, w = m.fw * m.frames * q, h = m.fh * m.dirs.length * q;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w); c.height = Math.ceil(h);
    const x = c.getContext('2d');
    x.drawImage(m.img, m.sx, m.sy, w, h, 0, 0, w, h);
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = TINTS[kind];
    x.fillRect(0, 0, w, h);
    m[key] = { ...m, img: c, sx: 0, sy: 0 };
  }
  return m[key];
}

export async function loadAssets(onProgress) {
  const manText = await fetch(url('manifest.json')).then(r => r.text());
  const man = JSON.parse(manText);
  const layout = await fetch(url('layout.json')).then(r => r.json());
  const light = LIGHT ? await lightSet(manText) : null;
  const entries = [man.ground];
  if (man.lane && man.lane.ground && man.lane.ground.file) entries.push(man.lane.ground);   // Line Tower Wars lane art
  for (const sec of ['towers', 'creeps', 'props', 'icons', 'portraits', 'ui']) if (man[sec]) entries.push(...Object.values(man[sec]).filter(m => m && m.file));
  const files = [...new Set(entries.map(m => m.file))];
  const half = (f) => !!(light && light.files[f]);
  const images = {};
  let done = 0;
  const queue = [...files];
  const worker = async () => {          // four downloads at a time
    while (queue.length) {
      const f = queue.shift();
      images[f] = await loadImage(half(f) ? 'light/' + f : f);
      onProgress?.(++done / files.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  for (const m of entries) {
    const q = half(m.file) ? light.scale : 1;
    m.img = images[m.file]; m.ss = q; m.sx = (m.sx || 0) * q; m.sy = (m.sy || 0) * q;
  }
  man.light = !!light;
  // what was loaded, for the service worker to keep (src/client/app.js)
  const urls = ['manifest.json', 'layout.json', ...(light ? ['light/light.json'] : []), ...files.map(f => (half(f) ? 'light/' + f : f))].map(url);
  return { man, layout, urls };
}
