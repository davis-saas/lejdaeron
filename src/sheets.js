// Drawing the v2 effect sheets (manifest.effects, docs/FX-v2.md) and other one-facing frame animations (the terrain's
// water glints): a frame is drawn like every v2 sprite, at X - ax * k, Y - ay * k, w * k, h * k, from its page's best
// loaded image (src/assets.js art.at). `add` sheets are light only and go in a 'lighter' batch, `alpha` sheets are
// drawn normally; the caller sets the blend and the alpha. Turned sheets (missiles, muzzle flashes, beams) are drawn
// about their anchor; a beam is also stretched along its length (kx).
import { art } from './assets.js?v=3947ef6d39d3';

let EFFECTS = {};
export function setEffects(man) { EFFECTS = (man && man.effects) || {}; GROUND.clear(); }
// The anim `name` of effect `key`, or null (the procedural effect is drawn instead).
export function sheet(key, name = 'play') {
  const e = EFFECTS[key], a = e && e.anims && e.anims[name];
  return a && a.rects && a.rects.length && !(a.pg && a.pg.missing) ? a : null;
}

// The other one-shot anims of effect `key` that lie on the ground (cloud_poison's murk): spawned with its 'play' at
// the same anchor, start and scale, and drawn in the ground layer.
const GROUND = new Map();
export function groundAnims(key) {
  let g = GROUND.get(key);
  if (!g) {
    const e = EFFECTS[key];
    g = Object.keys((e && e.anims) || {}).filter((n) => n !== 'play' && e.anims[n].ground && !e.anims[n].loop && sheet(key, n));
    GROUND.set(key, g);
  }
  return g;
}

// Draws frame f of anim a. k: logical px per manifest px; ang: turn (rad) about the anchor; kx: the stretch along the
// turned x axis (beams), else k. img: a canvas made from this frame (a tint), drawn in its place.
export function drawFrame(ctx, a, f, X, Y, k, ang = 0, kx = 0, img = null) {
  const r = a.rects[f];
  if (!r) return;
  let im, q, sx, sy;
  if (img) { im = img; q = img.width / r[2]; sx = 0; sy = 0; }
  else { const S = art.at(a.pg, r[0], r[1]); im = S.img; q = S.q; sx = S.x; sy = S.y; }
  const w = r[2], h = r[3];
  if (ang || kx) {   // turned about the anchor, then turned back (cheaper than save and restore for hundreds of missiles)
    const c = Math.cos(ang), s = Math.sin(ang), x = kx || k;
    ctx.transform(c, s, -s, c, X, Y);
    ctx.drawImage(im, sx, sy, w * q, h * q, -r[4] * x, -r[5] * k, w * x, h * k);
    ctx.transform(c, -s, s, c, -(c * X + s * Y), s * X - c * Y);
  } else ctx.drawImage(im, sx, sy, w * q, h * q, X - r[4] * k, Y - r[5] * k, w * k, h * k);
}
// The frame of a loop at time t (s) with a phase in frames.
export const loopFrame = (a, t, phase = 0) => Math.floor(t * a.fps + phase) % a.frames;

// muzzle_magic is white light: one sheet for every magic tower, tinted per colour into a small canvas per frame
// (multiply by the colour, then masked to the frame's own alpha), for the set it is drawn from.
const TINTED = new Map();
export function tintedSheetFrame(a, f, color) {
  const r = a.rects[f];
  if (!r) return null;
  const S = art.at(a.pg, r[0], r[1], true), key = `${color}|${f}|${S.q}|${a.page}|${r[0]}|${r[1]}`;
  let c = TINTED.get(key);
  if (!c) {
    if (TINTED.size > 200) TINTED.clear();
    const { img, x: sx, y: sy, q } = S;
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r[2] * q)); c.height = Math.max(1, Math.round(r[3] * q));
    const x = c.getContext('2d');
    x.drawImage(img, sx, sy, r[2] * q, r[3] * q, 0, 0, c.width, c.height);
    x.globalCompositeOperation = 'multiply'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(img, sx, sy, r[2] * q, r[3] * q, 0, 0, c.width, c.height);
    TINTED.set(key, c);
  }
  return c;
}
