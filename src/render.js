// Draws the battlefield: Blender ground and props, depth-sorted towers and creeps, overlays.
// The art is the v2 set (src/assets.js, docs/GRAPHICS-v2.md): creeps walk in 8 rendered facings and fall in 4, the five
// Line Tower Wars attackers swing at towers, towers play an attack (patches over their base, composed per frame in
// src/assets.js towerStrip) on every shot and six of them an idle loop, and the effect sheets (src/sheets.js, src/fx.js,
// docs/FX-v2.md) lay frost, poison, fire and stun over creeps and aura rings under towers and creeps. Nothing is
// mirrored: the light and the cast shadows are baked per facing.
import { COLS, ROWS, SIN, COS, TOP, SCREEN_W, SCREEN_H, buildable, TILE } from './level.js?v=3947ef6d39d3';
import { art, tintedFrame, towerStrip } from './assets.js?v=3947ef6d39d3';
import { pixelRatio, canvasScale, LIGHT } from './device.js?v=3947ef6d39d3';
import { setEffects, sheet, drawFrame, loopFrame } from './sheets.js?v=3947ef6d39d3';

export const P = 48;                 // logical px per tile
export const K = P / 96;             // sprites are rendered at 96 px per tile
export const TK = K * 1.12;          // towers are drawn a little larger so they fill their tile
export const CK = K * 1.15;          // creeps too, so they read clearly at game size
export const W = Math.round(SCREEN_W * P), H = Math.round(SCREEN_H * P);
export const sx = (x) => x * P;
export const sy = (y, z = 0) => (y * SIN - z * COS + TOP) * P;

const overlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const GLOWS = new Map();   // color -> pre-rendered radial glow, so particles cost one drawImage instead of a gradient
export const DIRS8 = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
const OCT = Math.PI / 4;
const HOLD = 0.1;                    // s a new facing must hold before a creep turns to it ...
const PAST = 8 * Math.PI / 180;      // ... unless the way it goes is this far past the octant's edge
const CORPSE_HOLD = 2.5, CORPSE_FADE = 1;   // s a corpse lies after its fall, then fades
const TOP_EASE = 0.1;                // s: a creep's bar height follows its facing's height this smoothly as it turns
const NO_SHIFT = [0, 0], ATTACH = 6, THROWN = 16;   // manifest px (fxShift)
// creep overlays (docs/FX-v2.md, Creep overlays), in drawing order; ov_stun goes over the head
const OVERLAYS = ['ov_frost', 'ov_poison', 'ov_burn', 'ov_stun'];
const OV_IN = 0.15, OV_OUT = 0.2;
const GHOSTS = new Set(['shade', 'wraith', 'banshee', 'o002']), MACHINES = new Set(['h01B', 'h01I']);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mod8 = (n) => ((n % 8) + 8) % 8;

// A creep sprite's drawing data (one per unit def): its anims, the box of its walk frames (today's fw, ay: health bars,
// picking and effect heights use it), its height above the ground point and its size for effect overlays.
function makeLook(key, m, k, scale) {
  const L = { key, m, k, scale, walk: null, death: null, attack: null, v1: false };
  if (m.anims && m.anims.walk) {
    Object.assign(L, { walk: m.anims.walk, death: m.anims.death || null, attack: m.anims.attack || null });
  } else {   // the old format: one sheet, E and S rows (W mirrored, N drawn as S), no death
    const rects = [];
    for (let row = 0; row < (m.dirs || ['E', 'S']).length; row++) for (let col = 0; col < m.frames; col++) rects.push([m.sx + col * m.fw, m.sy + row * m.fh, m.fw, m.fh, m.ax, m.ay]);
    for (const r of rects) r.pg = m.page;
    L.walk = { dirs: m.dirs || ['E', 'S'], frames: m.frames, rate: 1.7, rects, pg: m.pg, page: m.page };
    L.v1 = true;
  }
  const a = L.walk;
  if (!a.rects || !a.rects.length || !a.dirs) {   // not packed onto a page yet (being re-rendered): a box to place bars by
    Object.assign(L, { ax: 40, ay: 60, fw: 80, fh: 80, hgt: 60, cs: scale, dirs: DIRS8.map(() => 0), tops: DIRS8.map(() => 60), missing: true, kind: 'blood' });
    L.walk = { dirs: [], frames: 1, rects: [], pg: { missing: true } }; L.death = L.attack = null;
    return L;
  }
  let ax = 0, ay = 0, rx = 0, by = 0;
  for (const r of a.rects) { ax = Math.max(ax, r[4]); ay = Math.max(ay, r[5]); rx = Math.max(rx, r[2] - r[4]); by = Math.max(by, r[3] - r[5]); }
  Object.assign(L, { ax, ay, fw: ax + rx, fh: ay + by });
  // the height of each facing's walk (its tallest frame above the ground point): health bars, hit points and the
  // overlays over the head follow the facing drawn, not the tallest of all eight (a raised weapon facing away)
  L.tops = DIRS8.map((d) => {
    const i = a.dirs.indexOf(d);
    if (i < 0 || L.v1) return ay;
    let h = 0;
    for (let f = 0; f < a.frames; f++) { const r = a.rects[i * a.frames + f]; if (r) h = Math.max(h, r[5]); }
    return h || ay;
  });
  const s = Math.max(0, a.dirs.indexOf('S'));
  L.hgt = (a.rects[s * a.frames] || a.rects[0])[5];
  L.cs = clamp(L.hgt / 60, 0.8, 1.6) * scale;   // effect overlay size
  L.dirs = DIRS8.map((d) => a.dirs.indexOf(d));
  if (L.attack && !(L.attack.rects && L.attack.rects.length)) L.attack = null;
  if (L.death && !(L.death.rects && L.death.rects.length)) L.death = null;
  if (L.attack) L.atkDirs = DIRS8.map((d) => L.attack.dirs.indexOf(d));
  if (L.death) {
    const D = L.death, map = D.dirmap || {};
    L.deathDirs = DIRS8.map((d) => Math.max(0, D.dirs.indexOf(map[d] || d)));
    L.corpse = D.events && D.events.corpse !== undefined ? D.events.corpse : D.frames - 1;
  }
  // what its death leaves (src/fx.js): by the sprite drawn
  L.kind = GHOSTS.has(key) ? 'ghost' : key === 'infernal' ? 'fel' : MACHINES.has(key) ? 'machine' : key === 'treant' ? 'treant' : key === 'h01M' ? 'phoenix' : 'blood';
  return L;
}

export class Renderer {
  constructor(canvas, assets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.man = assets.man;
    this.layout = assets.layout;
    setEffects(this.man);
    this.scale = 1;
    this.res = 2 * (this.man.ground.q || 1);   // device px per logical px the ground has (normal 2, light 1)
    this.looks = new Map();   // creep def -> look (makeLook)
    this.faces = new WeakMap();   // creep -> { f, cand, since }: its facing, turned with a little hysteresis
    this.ov = new WeakMap();      // creep -> { name: [on, since] }: its overlays fading in and out
    const g = this.man.terrain && this.man.terrain.water_glint;
    this.glint = g && g.anims && g.anims.play && !g.anims.play.pg.missing ? g.anims.play : null;
    this.props = this.buildProps();
  }

  // A prop type: Classic and lane props, then the terrain's scenery sprites.
  propOf(type) { const m = (this.man.props && this.man.props[type]) || (this.man.terrain && this.man.terrain[type]); return m && m.pg ? m : null; }

  // ---------------------------------------------------------------- setup
  buildProps() {
    const L = this.layout, list = [];
    for (const t of [...L.trees, ...L.rocks]) { const m = this.propOf(t.type); if (m) list.push({ m, x: t.x, y: t.y, z: t.z || 0, flip: false, key: t.y }); }
    const castle = this.propOf('castle'), portal = this.propOf('portal');
    if (castle) list.push({ m: castle, x: L.castle.x, y: L.castle.y, z: L.castle.z || 0, key: L.castle.y, castle: true });
    if (portal) list.push({ m: portal, x: L.portal.x, y: L.portal.y, z: L.portal.z || 0, key: L.portal.y, portal: true, dynamic: true });
    for (const p of list) p.box = [sx(p.x) - p.m.ax * K, sy(p.y, p.z) - p.m.ay * K, p.m.w * K, p.m.h * K];
    list.sort((a, b) => a.key - b.key);
    return list;
  }

  // Classic's view. resize(): the whole map fitted to the stage (css px), as the farthest zoom shows it. view(cam), every
  // frame: the canvas covers what the camera shows (src/client/camera.js, its view is the stage), so it has the fitted
  // size at the farthest zoom, exactly as before there was a camera, and at most the stage's when zoomed in.
  resize(cssW, cssH) {
    this.fitW = cssW; this.fitH = cssH; this.fitZoom = cssW / W;
    this.size = null;
  }
  view(cam) {
    const dpr = pixelRatio(), fitted = cam.zoom <= this.fitZoom * 1.0001;
    const w = fitted ? this.fitW : Math.min(Math.floor(cam.vw), Math.round(W * cam.zoom));
    const h = fitted ? this.fitH : Math.min(Math.floor(cam.vh), Math.round(H * cam.zoom));
    if (!this.size || this.size[0] !== w || this.size[1] !== h || this.size[2] !== dpr) {
      this.size = [w, h, dpr];
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.canvas.width = Math.round(fitted ? W * this.fitZoom * dpr : w * dpr);
      this.canvas.height = Math.round(fitted ? H * this.fitZoom * dpr : h * dpr);
    }
    this.scale = cam.zoom * dpr;
    art.frame(this.scale * P);
    // the ground and props at the view's resolution, up to the art's own (its upgrade's once loaded, or the fitted
    // view's, where that is finer) and within the device's canvas budget; while the zoom moves the one there is is
    // scaled, and once it stops a ground made while upgrades were still on their way is made again when they are in
    const g = this.man.ground, up = art.groundUp(g), res = up ? 2 * up[0].q : this.res;
    const cs = canvasScale(W, H, Math.min(this.scale, Math.max(res, this.fitZoom * dpr)));
    const still = !cam.zooming && !cam.live, st = this.static;
    if (!st || (still && (Math.abs(st.cs - cs) > 1e-6 || arrived(st.wait)))) this.buildStatic(cs);
  }

  buildStatic(cs) {
    const c = document.createElement('canvas');
    c.width = Math.round(W * cs); c.height = Math.round(H * cs);
    if (!c.width || !c.height) { this.static = null; return; }   // zero-size viewport
    c.cs = cs;
    const x = c.getContext('2d');
    x.setTransform(cs, 0, 0, cs, 0, 0);
    x.imageSmoothingQuality = 'high';
    art.track = [];
    const g = this.man.ground, up = art.groundUp(g);
    if (up) {   // the hd tiles, each edge on a whole cache pixel (tiles meeting mid-pixel leave a see-through seam)
      const d = (v) => Math.round(v * K * cs);
      x.setTransform(1, 0, 0, 1, 0, 0);
      for (const u of up) x.drawImage(u.img, 0, 0, u.img.width, u.img.height, d(u.x), d(u.y), d(u.x + u.w) - d(u.x), d(u.y + u.h) - d(u.y));
      x.setTransform(cs, 0, 0, cs, 0, 0);
    }
    else if (g.img && !g.missing) x.drawImage(g.img, 0, 0, W, H);
    else { x.fillStyle = '#34501f'; x.fillRect(0, 0, W, H); }
    if (!this.man.shadows) for (const p of this.props) if (!p.castle && !p.portal) this.blob(x, sx(p.x) + 2, sy(p.y, p.z) + 1, p.m.w * K * 0.3, 0.32);
    for (const p of this.props) if (!p.dynamic) this.sprite(x, p.m, sx(p.x), sy(p.y, p.z), p.flip);
    // soft vignette like the in-game fog at the map edges
    const v = x.createRadialGradient(W / 2, H * 0.55, H * 0.45, W / 2, H * 0.55, W * 0.62);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.38)');
    x.fillStyle = v;
    x.fillRect(0, 0, W, H);
    c.wait = art.track; art.track = null;
    this.static = c;
  }

  // ---------------------------------------------------------------- primitives
  // m: a manifest sprite (towers, props: on a page, drawn from its best loaded set) or a canvas made from one (img, ss)
  sprite(ctx, m, X, Y, flip = false, img = null, k = K) {
    let im, q, x0, y0;
    if (m.pg) { const S = art.at(m.pg, m.sx, m.sy); im = S.img; q = S.q; x0 = S.x; y0 = S.y; } else { im = m.img; q = m.ss; x0 = m.sx * q; y0 = m.sy * q; }
    if (!im) return;   // not packed onto a page yet (the art is being re-rendered): nothing to draw
    if (flip) {
      ctx.save(); ctx.translate(X, Y); ctx.scale(-1, 1);
      ctx.drawImage(im, x0, y0, m.w * q, m.h * q, -m.ax * k, -m.ay * k, m.w * k, m.h * k);
      ctx.restore();
    } else ctx.drawImage(im, x0, y0, m.w * q, m.h * q, X - m.ax * k, Y - m.ay * k, m.w * k, m.h * k);
  }
  // One frame r (a rect of anim a: [sx, sy, w, h, ax, ay]) with its anchor at X, Y; tint: 'slow' or 'hit'.
  blit(ctx, a, r, X, Y, k, flip = false, tint = null) {
    if (!r || a.pg.missing) return;
    const S = art.at(a.pg, r[0], r[1]), q = S.q;
    let im = S.img, x0 = S.x, y0 = S.y;
    if (tint) { im = tintedFrame(a.pg, r, tint); x0 = 0; y0 = 0; }
    if (flip) {
      ctx.save(); ctx.translate(X, Y); ctx.scale(-1, 1);
      ctx.drawImage(im, x0, y0, r[2] * q, r[3] * q, -r[4] * k, -r[5] * k, r[2] * k, r[3] * k);
      ctx.restore();
    } else ctx.drawImage(im, x0, y0, r[2] * q, r[3] * q, X - r[4] * k, Y - r[5] * k, r[2] * k, r[3] * k);
  }
  blob(ctx, X, Y, rx, a = 0.3) {
    const ry = rx * SIN * 0.75;
    ctx.save(); ctx.translate(X, Y); ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, rx * 0.1, 0, 0, rx);
    g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(0.6, `rgba(0,0,0,${a * 0.6})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  ring(ctx, X, Y, r, color, width = 2, dash = null, fill = null) {
    ctx.save();
    ctx.beginPath(); ctx.ellipse(X, Y, r, r * SIN, 0, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (dash) ctx.setLineDash(dash);
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke();
    ctx.restore();
  }
  // Reforged-style selection: soft glowing ring with a bright core line
  selection(ctx, X, Y, r, color) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [w, a] of [[7, 0.12], [4, 0.22], [1.6, 0.9]]) {
      ctx.beginPath(); ctx.ellipse(X, Y, r, r * SIN, 0, 0, Math.PI * 2);
      ctx.lineWidth = w; ctx.strokeStyle = hexA(color, a); ctx.stroke();
    }
    ctx.restore();
  }
  glow(ctx, X, Y, r, color, a = 0.7) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(X, Y, 0, X, Y, r);
    g.addColorStop(0, hexA(color, a)); g.addColorStop(0.45, hexA(color, a * 0.35)); g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  // The same glow from a cached sprite. The caller sets the 'lighter' blend (and restores globalAlpha) once for a batch.
  glowAdd(ctx, X, Y, r, color, a = 0.7) {
    if (!(r > 0) || !(a > 0)) return;
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(glowSprite(color), X - r, Y - r, r * 2, r * 2);
  }

  // ---------------------------------------------------------------- geometry helpers
  // A creep's sprite: one modelled for its unit id if it exists, else its shared look (scaled by the unit's
  // placeholder `scale` hint, which a unit-id sprite ignores). Portraits follow the same rule.
  look(def) {
    let l = this.looks.get(def);
    if (!l) {
      const C = this.man.creeps, own = C[def.id], key = own ? def.id : C[def.look] ? def.look : Object.keys(C)[0];
      const scale = own ? 1 : def.scale || 1;
      l = makeLook(key, C[key], CK * scale, scale);
      this.looks.set(def, l);
    }
    return l;
  }
  creepMeta(c) { return this.look(c.def); }
  creepK(c) { return this.look(c.def).k; }
  creepBox(c) {
    const L = this.look(c.def), X = sx(c.x), Y = sy(c.y), k = L.k;
    return [X - L.ax * k, Y - L.ay * k, L.fw * k, L.fh * k];
  }
  creepCenter(c) {
    const L = this.look(c.def);
    return { X: sx(c.x), Y: sy(c.y) - this.creepTop(c) * L.k * (c.def.flying ? 0.55 : 0.45) };
  }
  // A creep's height above its ground point (manifest px): the walk height of the facing it is drawn in (makeLook
  // tops), eased as it turns (drawCreep keeps it), so its health bar, hit point and stun stay on its head.
  creepTop(c) {
    const s = this.faces.get(c);
    return s && s.top !== undefined ? s.top : this.look(c.def).tops[this.faceNow(c)];
  }
  easeTop(c, L, f, t) {
    const s = this.faces.get(c), goal = L.tops[f];
    if (!s) return;
    if (s.top === undefined || !(t > s.tt)) { if (s.top === undefined) s.top = goal; s.tt = t; return; }
    const dt = Math.min(0.25, t - s.tt);
    s.tt = t;
    s.top += (goal - s.top) * (1 - Math.exp(-dt / TOP_EASE));
  }
  // The console's still of a unit (src/ui.js, src/client/hud.js): its walk frame f facing the camera (S), the ground
  // point at cx, gy, s css px per manifest px. lookBox(def): the walk frames' box (fw, fh, ax, ay) to size it by.
  lookBox(def) { return this.look(def); }
  drawStill(ctx, def, f, cx, gy, s) {
    const L = this.look(def), a = L.walk, d = Math.max(0, L.dirs[2]), r = a.rects[d * a.frames + (f % a.frames)];
    if (!r || a.pg.missing) return;
    const S = art.at(a.pg, r[0], r[1], true, true);   // the base set: the console draws small
    ctx.drawImage(S.img, S.x, S.y, r[2] * S.q, r[3] * S.q, cx - r[4] * s, gy - r[5] * s, r[2] * s, r[3] * s);
  }
  towerBox(t) {
    const m = this.man.towers[t.def.id], X = sx(t.x), Y = sy(t.y);
    return [X - m.ax * TK, Y - m.ay * TK, m.w * TK, m.h * TK];
  }
  fxPoint(t, f) {
    const m = this.man.towers[t.def.id];
    return { X: sx(t.x) + (f.px - m.ax) * TK, Y: sy(t.y) + (f.py - m.ay) * TK };
  }
  // Where a tower's shots start: the muzzle point of its attack's release frame (on the barrel, bow or orb as it fires),
  // else its muzzle effect point.
  muzzle(t) {
    const m = this.man.towers[t.def.id], at = m.anims && m.anims.attack;
    const pt = at && at.muzzle && at.muzzle[(at.events && at.events.release) ?? 1];
    if (pt) return { X: sx(t.x) + (pt[0] - m.ax) * TK, Y: sy(t.y) + (pt[1] - m.ay) * TK };
    const f = m.fx.find(f => f.kind === 'muzzle') || m.fx.find(f => f.kind !== 'bubble' && f.kind !== 'spores');
    if (f) return this.fxPoint(t, f);
    return { X: sx(t.x), Y: sy(t.y) - m.ay * TK * 0.7 };
  }
  // A creep's facing (0..7, E SE S SW W NW N NE, map y growing south) from the way it moves: round(atan2 / 45 deg),
  // turning only once the new octant has held for HOLD s or the way is PAST beyond the octant's edge, so creeps do not
  // flicker between two facings on a corner or a diagonal. Kept while it stands.
  face(c, t) {
    const a = Math.atan2(c.diry || 0, c.dirx || 0), o = mod8(Math.round(a / OCT));
    let s = this.faces.get(c);
    if (!s) { this.faces.set(c, { f: o, cand: o, since: t }); return o; }
    if (o === s.f) { s.cand = o; return o; }
    let d = Math.abs(a - s.f * OCT) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > OCT / 2 + PAST) { s.f = s.cand = o; return o; }
    if (s.cand !== o || t < s.since) { s.cand = o; s.since = t; } else if (t - s.since >= HOLD) s.f = o;
    return s.f;
  }
  faceNow(c) { const s = this.faces.get(c); return s ? s.f : mod8(Math.round(Math.atan2(c.diry || 0, c.dirx || 0) / OCT)); }
  // The old format's row and mirror (E and S rows, W mirrored)
  creepDir(c) {
    if (Math.abs(c.diry) > Math.abs(c.dirx)) return { row: 1, flip: false };
    return { row: 0, flip: c.dirx < 0 };
  }

  // ---------------------------------------------------------------- frame
  draw(game, view, fx, t, cam) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.static) return;   // zero-size viewport
    const s = this.scale, st = this.static;
    const tx = Math.round(this.canvas.width / 2 - cam.x * s), ty = Math.round(this.canvas.height / 2 - cam.y * s);
    if (Math.abs(st.cs - s) < 1e-6) ctx.drawImage(st, tx, ty);
    else ctx.drawImage(st, tx, ty, W * s, H * s);
    ctx.setTransform(s, 0, 0, s, tx, ty);
    const rect = cam.rect();

    this.glints(ctx, this.man.terrain_fx, t);
    if (view.placing) this.drawGrid(ctx, game, view);
    fx.drawGround(ctx, rect);
    for (const tw of game.towers) this.towerRing(ctx, tw, t, false);
    const sel = view.selected;
    if (sel && sel.def && sel.def.range) this.ring(ctx, sx(sel.x), sy(sel.y), sel.def.range / TILE * P, 'rgba(255,255,255,0.55)', 1.5, [6, 5], 'rgba(255,255,255,0.05)');
    if (view.hoverTower && view.hoverTower !== sel) this.ring(ctx, sx(view.hoverTower.x), sy(view.hoverTower.y), view.hoverTower.def.range / TILE * P, 'rgba(255,255,255,0.25)', 1, [4, 6]);

    const baked = this.man.shadows;   // Cycles sprites carry their own cast shadows; keep only a faint contact shadow
    for (const tw of game.towers) this.blob(ctx, sx(tw.x) + 1, sy(tw.y) + 1, P * 0.42, baked ? 0.14 : 0.34);
    for (const c of game.creeps) this.blob(ctx, sx(c.x) + 1, sy(c.y) + 1, P * (c.def.flying ? 0.16 : 0.2), baked ? (c.def.flying ? 0.12 : 0.16) : 0.3);
    if (sel) {
      if (sel.def && sel.def.range) this.selection(ctx, sx(sel.x), sy(sel.y), P * 0.5, '#5aff4a');
      else if (sel.hp !== undefined) this.selection(ctx, sx(sel.x), sy(sel.y), P * (sel.def.flying ? 0.3 : 0.34), '#ff4a3a');
    }

    const items = [];
    for (const tw of game.towers) items.push({ key: tw.y, kind: 'tower', o: tw, box: this.towerBox(tw) });
    for (const c of game.creeps) items.push({ key: c.y + 0.001, kind: 'creep', o: c, box: this.creepBox(c) });
    for (const d of fx.corpses) items.push({ key: d.y, kind: 'corpse', o: d, box: d.box });
    const extra = new Set();
    for (const it of items) for (const p of this.props) if (!p.dynamic && p.key > it.key && overlap(it.box, p.box)) extra.add(p);
    for (const p of extra) items.push({ key: p.key, kind: 'prop', o: p });
    for (const p of this.props) if (p.dynamic) items.push({ key: p.key, kind: 'portal', o: p });
    items.sort((a, b) => a.key - b.key);
    for (const it of items) {
      if (it.kind === 'tower') this.drawTower(ctx, it.o, game, t);
      else if (it.kind === 'creep') this.drawCreep(ctx, it.o, game, t, fx);
      else if (it.kind === 'corpse') fx.drawCorpse(ctx, it.o, this);
      else if (it.kind === 'portal') this.drawPortal(ctx, it.o, t);
      else this.sprite(ctx, it.o.m, sx(it.o.x), sy(it.o.y, it.o.z), it.o.flip);
    }
    if (view.placing && view.hover) this.drawGhost(ctx, game, view);
    fx.drawAir(ctx, this, rect);
    for (const c of game.creeps) this.healthBar(ctx, c, game);
    for (const tw of game.towers) if (tw.building > 0) this.buildBar(ctx, tw);
    fx.drawTexts(ctx);
  }

  // The terrain's water glints (manifest terrain_fx: { x, y, z, phase }), light added over the ground.
  glints(ctx, list, t) {
    const a = this.glint;
    if (!a || !list || !list.length) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const g of list) drawFrame(ctx, a, Math.floor(t * a.fps + (g.phase || 0) * a.frames) % a.frames, sx(g.x), sy(g.y, g.z || 0), K);
    ctx.globalCompositeOperation = 'source-over';
  }

  drawGrid(ctx, game, view) {
    const h = view.hover;
    ctx.save();
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const near = h ? Math.max(Math.abs(c - h.c), Math.abs(r - h.r)) : 99;
      if (near > 4) continue;
      const ok = buildable(c, r) && !game.towerAt(c, r);
      const a = near === 0 ? 0.42 : 0.16 * (1 - near / 5);
      ctx.fillStyle = ok ? `rgba(90,255,80,${a})` : `rgba(255,70,50,${a})`;
      const Y0 = sy(r), Y1 = sy(r + 1);
      ctx.fillRect(c * P + 1, Y0 + 1, P - 2, Y1 - Y0 - 2);
    }
    ctx.restore();
  }

  drawGhost(ctx, game, view) {
    const def = view.placing, h = view.hover;
    const m = this.man.towers[def.id];
    const X = sx(h.c + 0.5), Y = sy(h.r + 0.5);
    const ok = game.canBuild(def.id, h.c, h.r);
    this.ring(ctx, X, Y, def.range / TILE * P, ok ? 'rgba(160,255,140,0.8)' : 'rgba(255,120,100,0.8)', 1.5, [6, 5], ok ? 'rgba(120,255,100,0.06)' : 'rgba(255,80,60,0.06)');
    ctx.save(); ctx.globalAlpha = 0.6; this.sprite(ctx, m, X, Y, false, null, TK); ctx.restore();
  }

  // ---------------------------------------------------------------- towers
  // The frame a tower shows (game: its field, for the sim's time): its attack from the shot on (the release frame when
  // the shot leaves, then on at the anim's fps, faster for a tower whose cooldown is shorter than the anim), the wind-up
  // frame just before a shot it is about to fire, else its idle loop where it has one. null: the base sprite.
  towerAnim(tw, m, game, t) {
    const A = m.anims;
    if (!A) return null;
    const at = A.attack;
    if (at) {
      const rel = (at.events && at.events.release) ?? 1, fps = Math.max(at.fps || 20, at.frames / (0.8 * (tw.def.cooldown || 1)));
      if (tw.firedAt) {
        const f = rel + Math.floor((game.time - tw.firedAt) * fps);
        if (f >= rel && f < at.frames) return ['attack', f];
      }
      if (rel > 0 && tw.target && !tw.target.dead && tw.cd > 0 && tw.cd <= 1 / fps) return ['attack', 0];
    }
    if (A.idle) return ['idle', Math.floor(t * A.idle.fps + (tw.id || 0) * 0.37 * A.idle.fps) % A.idle.frames];
    return null;
  }
  drawTower(ctx, tw, game, t) {
    const m = this.man.towers[tw.def.id], X = sx(tw.x), Y = sy(tw.y);
    if (tw.building > 0) {
      const k = 1 - tw.building / (tw.buildTotal || 1);
      const top = Y - m.ay * TK, hgt = m.h * TK;
      ctx.save();
      ctx.beginPath(); ctx.rect(X - m.w * TK, top + hgt * (1 - k), m.w * TK * 2, hgt * k + 2); ctx.clip();
      this.sprite(ctx, m, X, Y, false, null, TK);
      ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.35 * (1 - k); this.sprite(ctx, m, X, Y, false, null, TK); ctx.restore();
      const cut = top + hgt * (1 - k);
      ctx.save(); ctx.strokeStyle = 'rgba(120,80,40,0.9)'; ctx.lineWidth = 2;
      for (const dx of [-0.32, 0.32]) { ctx.beginPath(); ctx.moveTo(X + dx * P, Y); ctx.lineTo(X + dx * P * 0.9, cut); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(X - 0.3 * P, cut); ctx.lineTo(X + 0.3 * P, cut); ctx.stroke(); ctx.restore();
      return;
    }
    const an = m.pg && !m.pg.missing ? this.towerAnim(tw, m, game, t) : null;
    const strip = an && towerStrip(m, an[0]);
    if (strip) ctx.drawImage(strip, an[1] * strip.cw, 0, strip.cw, strip.height, X - m.ax * TK, Y - m.ay * TK, m.w * TK, m.h * TK);
    else this.sprite(ctx, m, X, Y, false, null, TK);
    this.towerRing(ctx, tw, t, true);
    for (const f of m.fx) this.towerFx(ctx, tw, m, f, t, an);
  }
  // Where an fx point is while the attack plays (an: towerAnim's frame): one on the part that moves (within ATTACH
  // manifest px of the muzzle's rest point, in the patch) moves with the muzzle, so a crystal's glow rises with it; a
  // flame there is a payload (the catapult's), gone from the bucket while the arm is swung away (null: not drawn).
  fxShift(m, f, an) {
    const a = m.anims && m.anims.attack;
    if (!an || an[0] !== 'attack' || !a || !a.muzzle || !a.patch) return NO_SHIFT;
    const [px, py, pw, ph] = a.patch, rest = a.muzzle[a.frames - 1], cur = a.muzzle[an[1]];
    if (!rest || !cur || f.px < px || f.px > px + pw || f.py < py || f.py > py + ph) return NO_SHIFT;
    if (Math.hypot(f.px - rest[0], f.py - rest[1]) > ATTACH) return NO_SHIFT;
    const dx = cur[0] - rest[0], dy = cur[1] - rest[1];
    if (f.kind === 'flame' && Math.hypot(dx, dy) > THROWN) return null;
    return [dx * TK, dy * TK];
  }

  // A tower's aura on the ground (aura_frost for the slow aura, ring_immolation): the back half in the ground layer,
  // the front half after the tower sprite, split at the footprint's front edge.
  towerRing(ctx, tw, t, front) {
    const d = tw.def;
    if ((!d.auraSlow && !d.immolation) || tw.building > 0) return;
    const a = sheet(d.auraSlow ? 'aura_frost' : 'ring_immolation');
    if (!a) return;
    const X = sx(tw.x), Y = sy(tw.y), cut = Y + 0.45 * SIN * P, R = 2 * P;
    ctx.save();
    ctx.beginPath();
    if (front) ctx.rect(X - R, cut, 2 * R, R); else ctx.rect(X - R, Y - R, 2 * R, cut - (Y - R));
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    drawFrame(ctx, a, loopFrame(a, t, (tw.id || 0) * 0.37 * a.fps), X, Y, K);
    ctx.restore();
  }

  towerFx(ctx, tw, m, f, t, an = null) {
    if (f.kind === 'muzzle') return;
    const d = this.fxShift(m, f, an);
    if (!d) return;
    const p = this.fxPoint(tw, f), X = p.X + d[0], Y = p.Y + d[1];
    const ph = t * 2.6 + tw.id * 1.7, s = f.size || 1;
    if (f.kind === 'orb') this.glow(ctx, X, Y, (9 + 2.5 * Math.sin(ph)) * s, f.color, 0.75);
    else if (f.kind === 'wisp') {
      const bob = Math.sin(ph * 0.8) * 3;
      this.glow(ctx, X, Y + bob, 18 * s, f.color, 0.6);
      this.glow(ctx, X, Y + bob, 6 * s, '#ffffff', 0.95);
    } else if (f.kind === 'flame') drawFlame(ctx, X, Y, 10 * s, 18 * s, t + (tw.id || 0) * 0.37);
    else if (f.kind === 'bubble') this.glow(ctx, X, Y, (14 + 2 * Math.sin(ph)) * s, f.color, 0.45);
    else if (f.kind === 'sparkle' || f.kind === 'spores') this.glow(ctx, X, Y, 10 * s, f.color, 0.3 + 0.1 * Math.sin(ph));
  }

  drawPortal(ctx, p, t) {
    this.sprite(ctx, p.m, sx(p.x), sy(p.y, p.z));
    // live swirl over the portal surface
    const X = sx(p.x), Y = sy(p.y, 1.2 + p.z);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const a = t * (0.9 + i * 0.35) + i * 2.1;
      ctx.save(); ctx.translate(X, Y); ctx.scale(1, 1.55); ctx.rotate(a);
      const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
      g.addColorStop(0, 'rgba(180,255,140,0.35)'); g.addColorStop(0.5, 'rgba(150,60,255,0.18)'); g.addColorStop(1, 'rgba(60,0,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(6, 0, 22, 10, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    this.glow(ctx, X, Y, 46, '#7d3cff', 0.28 + 0.06 * Math.sin(t * 3));
  }

  // ---------------------------------------------------------------- creeps
  // field: the creep's Field (Classic's game or a lane), for its time and true sight; t: the animation clock.
  drawCreep(ctx, c, field, t, fx) {
    const L = this.look(c.def), X = sx(c.x), Y = sy(c.y);
    const hidden = c.def.invisible && !field.visible(c);
    if (c.reviving) { this.drawReviving(ctx, c, L, X, Y, field, t, hidden); return; }
    const a0 = L.walk;
    if (a0.pg.missing) return;
    let slowed = (c.slowUntil > field.time && c.slowPct > 0) || c.auraSlow > 0;
    if (!slowed) for (const p of c.poisons) if (p.slow) { slowed = true; break; }
    const hit = fx.hitFlash.get(c.id);
    const tint = hit !== undefined && fx.t - hit < 0.06 ? 'hit' : slowed ? 'slow' : null;
    if (hidden) ctx.globalAlpha = 0.28;
    if (L.v1) {   // old format: E and S rows, W mirrored
      const { row, flip } = this.creepDir(c), col = Math.floor(c.walk * 1.7) % a0.frames;
      this.blit(ctx, a0, a0.rects[row * a0.frames + col], X, Y, L.k, flip, tint);
    } else {
      const f8 = this.face(c, t), sw = L.attack ? this.swingFrame(c, L, field.time) : -1;
      this.easeTop(c, L, f8, t);
      let a = a0, i;
      if (sw >= 0) { a = L.attack; i = Math.max(0, L.atkDirs[f8]) * a.frames + sw; }
      else i = Math.max(0, L.dirs[f8]) * a.frames + (c.attacking && L.attack ? 0 : Math.floor(c.walk * (a.rate || 1.7)) % a.frames);
      this.blit(ctx, a, a.rects[i], X, Y, L.k, false, tint);
    }
    if (hidden) ctx.globalAlpha = 1;
    this.overlays(ctx, c, L, X, Y, field, t, hidden);
  }
  // An attacker's swing (Line Tower Wars, src/lane.js fight): the attack's release frame when the blow lands (the
  // weapon's damage point after the swing starts), the frames before it winding up and the ones after recovering, at
  // the anim's fps, faster when the cooldown is shorter than the anim. -1: not swinging.
  swingFrame(c, L, now) {
    const w = c.def.weapon;
    if (!w || !c.firedAt) return -1;
    const a = L.attack, sp = 1 + (c.atkBonus || 0), dp = (w.damagePoint || 0) / sp, cd = (w.cooldown || 1) / sp;
    const rel = (a.events && a.events.release) ?? 3, fps = Math.max(a.fps || 15, a.frames / (0.8 * cd));
    const tau = now - c.firedAt;
    if (tau < 0) return -1;
    const f = Math.floor(rel + (tau - dp) * fps);
    return f >= a.frames ? -1 : Math.max(0, f);
  }
  // A creep lying dead until it reincarnates (Line Tower Wars): it falls, lies as its corpse, then rises (the death
  // played backwards) as the time comes. A ghost fades to half on frame 3 instead of lying.
  drawReviving(ctx, c, L, X, Y, field, t, hidden) {
    const delay = (c.def.reincarnation && c.def.reincarnation.delay) || 7;
    const left = Math.max(0, (c.reviveAt ?? field.time) - field.time), el = delay - left;
    const D = L.death;
    if (!D || D.pg.missing) {   // no death frames: a faded, still body that firms up as the time comes
      const a = L.walk, k = Math.max(0, Math.min(1, left / delay));
      ctx.globalAlpha = (0.3 + 0.4 * (1 - k)) * (hidden ? 0.4 : 1);
      this.blit(ctx, a, a.rects[Math.max(0, L.v1 ? this.creepDir(c).row : L.dirs[this.faceNow(c)]) * a.frames], X, Y, L.k, L.v1 && this.creepDir(c).flip);
      ctx.globalAlpha = 1;
      return;
    }
    const ghost = L.corpse === null, hold = ghost ? Math.min(3, D.frames - 1) : L.corpse, fps = D.fps || 12;
    const f = left < hold / fps ? Math.max(0, Math.min(hold, Math.floor(left * fps))) : Math.max(0, Math.min(hold, Math.floor(el * fps)));
    const alpha = ghost && f === hold ? 0.5 : 1;
    ctx.globalAlpha = alpha * (hidden ? 0.4 : 1);
    this.blit(ctx, D, D.rects[L.deathDirs[this.faceNow(c)] * D.frames + f], X, Y, L.k);
    ctx.globalAlpha = 1;
  }
  // The effect sheets over a creep: frost while slowed (not by poison), poison, the immolation's fire, a stun over its
  // head; each fades in and out. Light devices draw at most two (the stun first, then the newest).
  overlays(ctx, c, L, X, Y, field, t, hidden) {
    const now = field.time;
    const on = [(c.slowUntil > now && c.slowPct > 0) || c.auraSlow > 0, c.poisons.length > 0, c.burn > 0, c.stunUntil > now];
    let s = this.ov.get(c);
    if (!s) {
      if (!on[0] && !on[1] && !on[2] && !on[3]) return;
      s = [[false, 0], [false, 0], [false, 0], [false, 0]];
      this.ov.set(c, s);
    }
    let draw = [];
    const top = this.creepTop(c);
    for (let i = 0; i < 4; i++) {
      const o = s[i];
      if (o[0] !== on[i]) { o[0] = on[i]; o[1] = t; }
      const al = o[0] ? Math.min(1, (t - o[1]) / OV_IN) : 1 - (t - o[1]) / OV_OUT;
      if (al > 0.001) draw.push([i, al, o[1]]);
    }
    if (!draw.length) { if (!on[0] && !on[1] && !on[2] && !on[3]) this.ov.delete(c); return; }
    if (LIGHT && draw.length > 2) {   // the stun, then the newest
      const rest = draw.filter((x) => x[0] !== 3).sort((a, b) => b[2] - a[2]);
      draw = [...draw.filter((x) => x[0] === 3), ...rest].slice(0, 2);
    }
    draw.sort((a, b) => a[0] - b[0]);
    const op = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    for (const [i, al] of draw) {
      const a = sheet(OVERLAYS[i]);
      if (!a) { if (i === 3) this.stunDots(ctx, X, Y - top * L.k - 4, t); continue; }
      let oy = Y;
      if (a.attach === 'head') oy = Y - top * L.k - 6;
      else if (c.def.flying) oy = Y - top * L.k * 0.55 + 0.3 * L.hgt * L.k;
      ctx.globalAlpha = al * (hidden ? 0.28 : 1);
      drawFrame(ctx, a, loopFrame(a, t, (c.id || 0) * 0.37 * a.fps), X, oy, K * L.cs);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = op;
  }
  stunDots(ctx, X, top, t) {
    const op = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffe36b';
    for (let i = 0; i < 3; i++) { const a = t * 6 + i * 2.1; ctx.beginPath(); ctx.arc(X + Math.cos(a) * 9, top + Math.sin(a) * 3, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalCompositeOperation = op;
  }

  // ---------------------------------------------------------------- corpses (src/fx.js keeps them)
  // A dead creep's corpse record, t0 the effects clock: its death in the facing it had (diagonals fall to the side),
  // played at the anim's fps, then the corpse frame held CORPSE_HOLD s and faded over CORPSE_FADE s; a ghost dissolves
  // within its frames. Without death frames, the old fade of the walk frame.
  corpseOf(c, t0) {
    const L = this.look(c.def), X = sx(c.x), Y = sy(c.y), k = L.k;
    const d = { L, x: c.x, y: c.y, t0, fly: c.def.flying, box: [X - L.ax * k, Y - L.ay * k, L.fw * k, L.fh * k] };
    if (L.death && !L.v1 && !L.death.pg.missing) {
      const D = L.death, fps = D.fps || 12;
      d.dir = L.deathDirs[this.faceNow(c)];
      d.end = t0 + (L.corpse === null ? D.frames / fps : L.corpse / fps + CORPSE_HOLD + CORPSE_FADE);
    } else {
      const { row, flip } = L.v1 ? this.creepDir(c) : { row: Math.max(0, L.dirs[this.faceNow(c)]), flip: false };
      Object.assign(d, { row, flip, col: Math.floor(c.walk * 1.7) % L.walk.frames, end: t0 + 1.1, old: true });
    }
    return d;
  }
  drawCorpse(ctx, d, now) {
    const L = d.L, el = now - d.t0;
    if (d.old) {
      const k = Math.max(0, 1 - el / 1.1), a = L.walk;
      ctx.globalAlpha = Math.min(1, k * 1.6) * 0.95;
      this.blit(ctx, a, a.rects[d.row * a.frames + d.col], sx(d.x), sy(d.y) + (1 - k) * (d.fly ? 14 : 6), L.k, d.flip);
      ctx.globalAlpha = 1;
      return;
    }
    const D = L.death, fps = D.fps || 12, f = Math.min(D.frames - 1, Math.max(0, Math.floor(el * fps)));
    let alpha = 1;
    if (L.corpse === null) { if (f >= D.frames - 1) return; }
    else { const hold = L.corpse / fps + CORPSE_HOLD; if (el > hold) alpha = Math.max(0, 1 - (el - hold) / CORPSE_FADE); }
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    this.blit(ctx, D, D.rects[d.dir * D.frames + Math.min(f, L.corpse ?? f)], sx(d.x), sy(d.y), L.k);
    ctx.globalAlpha = 1;
  }

  healthBar(ctx, c, game) {
    const L = this.look(c.def), ck = L.k, X = sx(c.x), Y = sy(c.y);
    const w = Math.max(22, Math.min(46, L.fw * ck * 0.75)), top = Y - this.creepTop(c) * ck - 5;
    const k = Math.max(0, c.hp / c.maxHp);
    ctx.fillStyle = 'rgba(8,6,4,0.9)';
    ctx.fillRect(X - w / 2 - 1.5, top - 1.5, w + 3, 6);
    ctx.fillStyle = 'rgba(60,20,16,0.85)';
    ctx.fillRect(X - w / 2, top, w, 3);
    const g = ctx.createLinearGradient(0, top, 0, top + 3);
    const [c1, c2] = k > 0.6 ? ['#8cff6a', '#1f9a18'] : k > 0.3 ? ['#ffe86a', '#b08a10'] : ['#ff7a5a', '#a01a10'];
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(X - w / 2, top, w * k, 3);
  }
  buildBar(ctx, tw) {
    const X = sx(tw.x), Y = sy(tw.y) + 6, w = P * 0.7, k = 1 - tw.building / (tw.buildTotal || 1);
    ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(X - w / 2 - 1, Y - 1, w + 2, 5);
    ctx.fillStyle = '#e8c05a'; ctx.fillRect(X - w / 2, Y, w * k, 3);
  }

  // ---------------------------------------------------------------- picking
  pick(game, lx, ly) {
    let best = null, bd = 1e9;
    for (const c of game.creeps) {
      if (c.def.invisible && !game.visible(c)) continue;
      const { X, Y } = this.creepCenter(c), L = this.look(c.def);
      const d = Math.hypot(lx - X, ly - Y);
      if (d < Math.max(14, L.fw * L.k * 0.45) && d < bd) { bd = d; best = c; }
    }
    if (best) return { creep: best };
    const x = lx / P, y = (ly / P - TOP) / SIN;
    const c = Math.floor(x), r = Math.floor(y);
    const tw = game.towerAt(c, r);
    if (tw) return { tower: tw, c, r };
    // allow clicking the body of a tall tower standing south of the cursor tile
    for (let dr = 1; dr <= 2; dr++) { const t2 = game.towerAt(c, r + dr); if (t2 && overlap([lx, ly, 1, 1], this.towerBox(t2))) return { tower: t2, c, r: r + dr }; }
    return { c, r };
  }
}

// Whether the upgrades a cache waited for have all arrived (or failed): then it is made again with them.
export function arrived(wait) {
  if (!wait || !wait.length) return false;
  for (const u of wait) if (u.state !== 'ready' && u.state !== 'failed') return false;
  return true;
}

function glowSprite(color) {
  let c = GLOWS.get(color);
  if (!c) {
    c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, hexA(color, 1)); g.addColorStop(0.45, hexA(color, 0.35)); g.addColorStop(1, hexA(color, 0));
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    GLOWS.set(color, c);
  }
  return c;
}

export function hexA(h, a) {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// A small live flame (tower and prop fx points 'flame': braziers, lamps, the catapult's payload), w x h logical px over
// its base at X, Y, added to the light. Drawn from a pre-rendered loop of FLAME_FRAMES frames (one second): filling
// the three curved tongues as paths between sprite draws made the GPU flush per flame (measured: 18 flames among
// 311 animated towers took a Retina view from 60 to 47 fps).
const FLAME_FRAMES = 32, FLAME_RES = LIGHT ? 3 : 6, FW = 16, FH = 26, FB = 23;   // logical px cell for w 10, h 18; base y
let FLAMES = null;
function flameTongues(x, X, Y, w, h, u) {   // u: the loop's phase, 0..1
  const cols = ['rgba(210,52,12,0.75)', 'rgba(255,150,30,0.8)', 'rgba(255,240,170,0.85)'], a = 2 * Math.PI * u;
  for (let i = 0; i < 3; i++) {
    const k = 1 - i * 0.28, f = Math.sin(2 * a + i * 2.1) * 0.12 + Math.sin(3 * a + i) * 0.06;
    const ww = w * k, hh = h * k * (1 + f);
    x.beginPath(); x.moveTo(X - ww / 2, Y);
    x.quadraticCurveTo(X - ww * 0.6, Y - hh * 0.55, X + Math.sin(a + i) * ww * 0.25, Y - hh);
    x.quadraticCurveTo(X + ww * 0.6, Y - hh * 0.5, X + ww / 2, Y);
    x.closePath(); x.fillStyle = cols[i]; x.fill();
  }
}
function flameSheet() {
  if (FLAMES) return FLAMES;
  const c = document.createElement('canvas'), cw = FW * FLAME_RES, ch = FH * FLAME_RES;
  c.width = cw * FLAME_FRAMES; c.height = ch;
  const x = c.getContext('2d');
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < FLAME_FRAMES; i++) {
    x.setTransform(FLAME_RES, 0, 0, FLAME_RES, i * cw, 0);
    flameTongues(x, FW / 2, FB, 10, 18, i / FLAME_FRAMES);
  }
  FLAMES = { c, cw, ch };
  return FLAMES;
}
export function drawFlame(ctx, X, Y, w, h, t) {
  const S = flameSheet(), u = t - Math.floor(t), i = Math.min(FLAME_FRAMES - 1, Math.floor(u * FLAME_FRAMES));
  const kx = w / 10, ky = h / 18, op = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(S.c, i * S.cw, 0, S.cw, S.ch, X - FW / 2 * kx, Y - FB * ky, FW * kx, FH * ky);
  ctx.globalCompositeOperation = op;
}
