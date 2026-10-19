// Visual effects: missiles in flight, impacts, splashes, beams, muzzle flashes, deaths and corpses, decals, floating
// text and ambient particles. The v2 effect sheets (manifest.effects, drawn by src/sheets.js) carry the missiles,
// impacts, blasts, beams, muzzle flashes and decals as docs/FX-v2.md specifies (sheet, scale, blend, layer and life per
// event and missile kind); procedural particles stay for sparks, smoke puffs, trails, tower ambience and texts, fewer
// than before. Where a sheet is missing (its page failed to load) the procedural effect is drawn instead.
// Layers: drawGround (decals, splash rings and one-shots on the ground such as the poison cloud's murk, under
// everything), drawAir (castle flash, the alpha sheets, one 'lighter' batch of the additive sheets, then the
// particles), drawTexts. Corpses are depth-sorted with the units by the renderer.
import { P, K, sx, sy, hexA } from './render.js?v=3947ef6d39d3';
import { SIN, TILE } from './level.js?v=3947ef6d39d3';
import { LIGHT, FX_DENSITY } from './device.js?v=3947ef6d39d3';
import { sheet, drawFrame, tintedSheetFrame, groundAnims } from './sheets.js?v=3947ef6d39d3';

const COL = {
  arrow: '#e8d8b0', spear: '#d8c8a0', bullet: '#ffe9a0', blood: '#c01818', quake: '#b08a5a', wisp: '#bfe8ff', frost: '#8fe0ff',
  water: '#4aa6ff', spark: '#9ff0ff', shell: '#ffb040', shadow: '#b06bff', lightning: '#cfefff', fire: '#ff8a22', meteor: '#ff6a1a',
  poison: '#7dff4a', spirit: '#9dffb0', holy: '#fff0a8', swarm: '#9a7aba', spore: '#bfe8ff', moon: '#cfe8ff',
};
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// particles and floating numbers one layer keeps (the light set: fewer, and every effect spawns FX_DENSITY of its particles)
const MAX_PARTS = LIGHT ? 500 : 1400, MAX_TEXTS = LIGHT ? 40 : Infinity, MAX_DECALS = LIGHT ? 40 : 90, MAX_CORPSES = LIGHT ? 60 : 160;
// One-shot sprite effects (hits, blasts, muzzle flashes, beams, death bursts) alive at once, counted over every FX (every
// lane): when full, the cheap ones are skipped and the important ones push the cheap ones out. Records are reused.
const CAP = LIGHT ? 120 : 300;
let ACTIVE = 0;
const FREE = [];
const MOON_SPLASH = 0.33;   // the Moonbeam's splash-sized hit_moon, drawn at this alpha
const FAST = 0.35;   // s: towers firing faster than this have cheap hits and muzzles (on light devices, every other one)
// Muzzle sheets per tower kind (docs/FX-v2.md, Events: shot)
const FLASH = new Set(['rifle', 'cannon', 'artillery', 'flame']), MAGIC = new Set(['arcane', 'frost', 'light', 'moon', 'wisp', 'water', 'poison', 'shroom', 'fire']);
const BEAM = { lightning: ['beam_lightning', 0.16], holy: ['beam_holy', 0.2], water: ['beam_water', 0.2], spirit: ['beam_spirit', 0.2], bullet: ['tracer_bullet', 0.08] };
const MOTES = new Set(['frost', 'wisp', 'spore', 'moon', 'poison', 'spirit', 'shadow']);
const DECAL = { scorch: 'decal_scorch', blood: 'decal_blood', poison: 'decal_poison', frost: 'decal_frost' };

// Drops the finished entries of a list in place (no new array every frame).
function prune(list, alive) {
  let n = 0;
  for (let i = 0; i < list.length; i++) if (alive(list[i])) list[n++] = list[i];
  list.length = n;
}
const live = (o) => o.life > 0;
// box [x, y, w, h] against a view rect [x0, y0, x1, y1]
const inView = (v, x, y, w, h) => !v || (x < v[2] && x + w > v[0] && y < v[3] && y + h > v[1]);

export class FX {
  // opts.lane: a Line Tower Wars lane (leaks show at the exit, there is no castle). opts.maxParts caps the particles.
  constructor(opts = {}) {
    this.lane = !!opts.lane; this.maxParts = opts.maxParts || MAX_PARTS; this.density = FX_DENSITY;
    this.parts = []; this.decals = []; this.texts = []; this.beams = []; this.corpses = []; this.sheets = []; this.under = [];
    this.track = new Map(); this.hitFlash = new Map(); this.emitters = new Map(); this.seen = new Set(); this.odd = new Map();
    this.castleFlash = 0; this.t = 0;
  }
  clear() {
    this.parts.length = 0; this.decals.length = 0; this.texts.length = 0; this.beams.length = 0; this.corpses.length = 0;
    for (const e of this.sheets) { e.a = null; FREE.push(e); }
    for (const e of this.under) { e.a = null; FREE.push(e); }
    ACTIVE -= this.sheets.length + this.under.length; this.sheets.length = 0; this.under.length = 0;
    this.track.clear(); this.hitFlash.clear(); this.odd.clear(); this.castleFlash = 0;
  }

  // ---------------------------------------------------------------- spawning helpers
  part(p) { if (this.parts.length < this.maxParts) this.parts.push(Object.assign({ vx: 0, vy: 0, g: 0, grow: 0, add: true, kind: 'glow', life: 0.5, a: 1 }, p, { max: p.life ?? 0.5 })); }
  text(X, Y, text, color, size = 14, life = 1.2) { this.addText({ X, Y, text, color, size, life, max: life }); }
  addText(t) { if (this.texts.length >= MAX_TEXTS) this.texts.shift(); this.texts.push(t); }
  burst(X, Y, color, n = 8, speed = 60, life = 0.35, size = 2, g = 0) {
    n = Math.ceil(n * this.density);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rnd(0.3, 1) * speed;
      this.part({ x: X, y: Y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7 - speed * 0.2, g, life: rnd(0.6, 1) * life, size: rnd(0.6, 1.2) * size, color, kind: 'spark' });
    }
  }
  smoke(X, Y, n = 4, size = 6, color = '#5a5048') {
    n = Math.ceil(n * this.density);
    for (let i = 0; i < n; i++) this.part({ x: X + rnd(-6, 6), y: Y + rnd(-4, 4), vx: rnd(-8, 8), vy: rnd(-24, -8), life: rnd(0.6, 1.1), size, grow: 14, color, kind: 'smoke', add: false, a: 0.5 });
  }
  // A ground decal: a sheet (decal_*, s its scale) or, without one, today's gradient (r logical px).
  decal(X, Y, r, kind, life = 4, s = 0) {
    const a = DECAL[kind] && sheet(DECAL[kind]);
    this.decals.push({ X, Y, r, kind, life, max: life, rot: Math.random() * 6, a, k: K * (s || (2 * r / P) / ((a && a.size) || 1)) });
    if (this.decals.length > MAX_DECALS) this.decals.shift();
  }
  // A one-shot sheet (or a beam: o.life s) at X, Y, scale s (k = K * s). pri: 1 always shows (it pushes cheaper ones
  // out when the cap is reached), 2 pushes out only priority 3, 3 is skipped when full. Returns the record or null.
  // An anim on the ground goes in the ground layer; a 'play' brings its effect's ground anims along (the poison
  // cloud's murk under its gas).
  fx(key, X, Y, s = 1, o = null, name = 'play') {
    const a = sheet(key, name);
    if (!a) return null;
    const pri = (o && o.pri) || 2;
    if (ACTIVE >= CAP && !this.evict(pri)) return null;
    const e = FREE.pop() || {};
    e.a = a; e.t0 = this.t; e.X = X; e.Y = Y; e.k = K * s; e.pri = pri;
    e.ang = (o && o.ang) || 0; e.kx = (o && o.kx) || 0; e.alpha = o && o.alpha !== undefined ? o.alpha : 1;
    e.life = (o && o.life) || 0; e.tint = (o && o.tint) || null;
    (a.ground ? this.under : this.sheets).push(e); ACTIVE++;
    if (name === 'play') for (const g of groundAnims(key)) this.fx(key, X, Y, s, o, g);
    return e;
  }
  evict(pri) {
    if (pri >= 3) return false;
    for (const p of pri === 1 ? [3, 2] : [3]) {
      for (const list of [this.sheets, this.under]) {
        const i = list.findIndex((e) => e.pri === p);
        if (i >= 0) { const e = list[i]; list.splice(i, 1); e.a = null; FREE.push(e); ACTIVE--; return true; }
      }
    }
    return pri === 1;   // the most important ones show even over the cap
  }
  // Light devices: a fast tower shows its muzzle flash and its hit on every other shot only.
  skip(tw, what) {
    if (!LIGHT || !tw || !(tw.def.cooldown < FAST)) return false;
    const k = tw.id * 2 + (what === 'hit' ? 1 : 0), n = (this.odd.get(k) || 0) + 1;
    if (this.odd.size > 512) this.odd.clear();
    this.odd.set(k, n);
    return n % 2 === 0;
  }

  // ---------------------------------------------------------------- events
  handle(e, r, game) {
    switch (e.type) {
      case 'shot': this.shot(e, r); break;
      case 'impact': {
        let X = sx(e.x), Y = sy(e.y) - 6;
        if (e.creep) { const c = r.creepCenter(e.creep); X = c.X; Y = c.Y; this.hitFlash.set(e.creep.id, this.t); }
        this.impact(e, X, Y, sx(e.x), sy(e.y));
        break;
      }
      case 'death': this.death(e, r); break;
      case 'leak': {
        if (this.lane) { const c = e.creep; this.text(sx(Math.min(c.x, 43.5)), sy(c.y) - 40, '-1 life', '#ff5a48', 16, 1.4); break; }
        this.castleFlash = 1;
        this.text(sx(6.6), sy(14.5) - 46, '-1 life', '#ff5a48', 16, 1.4);
        break;
      }
      case 'build': case 'upgrade': {
        const X = sx(e.tower.x), Y = sy(e.tower.y);
        this.smoke(X, Y, 8, 7, '#8a7a62');
        if (e.type === 'build') this.fx('ring_quake', X, Y, 0.5, { alpha: 0.8, pri: 3 });
        else {
          this.fx('burst_holy', X, Y, 0.6, { pri: 1 });
          for (let i = 0; i < 14 * this.density; i++) this.part({ x: X + rnd(-16, 16), y: Y - rnd(0, 40), vy: rnd(-40, -15), life: rnd(0.5, 1), size: 2.5, color: '#ffe39a' });
        }
        break;
      }
      case 'sell': {
        const X = sx(e.tower.x), Y = sy(e.tower.y);
        this.goldText(X, Y - 30, e.gold); this.smoke(X, Y, 8, 8, '#8a7a62');
        this.fx('ring_quake', X, Y, 0.45, { alpha: 0.8, pri: 3 });
        break;
      }
      case 'bash': {
        const c = r.creepCenter(e.creep);
        this.burst(c.X, c.Y, '#ffe36b', 6, 50, 0.3, 2);
        this.fx('hit_spark', c.X, c.Y, 0.8, { pri: 2 });
        break;
      }
      // Line Tower Wars attackers (phase 3): towers that take blows and fall, death damage, reincarnation
      case 'damaged': if (e.tower) {
        const X = sx(e.tower.x), Y = sy(e.tower.y);
        this.burst(X, Y - 22, '#c8b48a', 3, 45, 0.3, 1.8, 180);
        this.fx('hit_quake', X, Y - 10, 0.55, { pri: 2 });
        break;
      }
      case 'destroyed': {
        const X = sx(e.tower.x), Y = sy(e.tower.y), sheets = !!sheet('blast_shell');
        this.part({ x: X, y: Y - 20, life: 0.35, size: 30, color: '#ffb040', kind: 'flash' });
        this.burst(X, Y - 18, '#8a7458', sheets ? 8 : 16, 110, 0.6, 3, 260);
        this.smoke(X, Y - 8, sheets ? 5 : 10, 10, '#5a5048');
        this.fx('blast_shell', X, Y, 0.6, { pri: 1 }, 'smoke');
        this.fx('blast_shell', X, Y, 0.6, { pri: 1 });
        this.fx('ring_quake', X, Y, 0.7, { pri: 1 });
        this.decal(X, Y, 14, 'scorch', 8, 1.1);
        break;
      }
      case 'blast': {   // a Phoenix's death damage
        const X = sx(e.x), Y = sy(e.y), rv = clamp((e.radius || 100) / TILE, 0.5, 1.75);
        this.decals.push({ X, Y, r: Math.max(0.5, (e.radius || 100) / TILE) * P, kind: 'ring', color: '#ff7a2a', life: 0.5, max: 0.5 });
        if (sheet('blast_meteor')) {
          this.fx('blast_meteor', X, Y, rv, { pri: 1 }, 'smoke');
          this.fx('blast_meteor', X, Y, rv, { pri: 1 });
          this.burst(X, Y - 10, '#ffcf60', 8, 120, 0.5, 2.5, 120);
        } else {
          this.part({ x: X, y: Y - 10, life: 0.4, size: 34, color: '#ff8a22', kind: 'flash' });
          this.burst(X, Y - 10, '#ffcf60', 14, 120, 0.5, 2.5, 120);
        }
        break;
      }
      case 'hurt': if (e.creep) {
        this.hitFlash.set(e.creep.id, this.t);
        if (e.by) { const c = r.creepCenter(e.creep); this.fx('hit_blood', c.X, c.Y, 0.6, { pri: 3 }); }
        break;
      }
      case 'reincarnate': case 'reborn': {
        const c = r.creepCenter(e.creep);
        this.burst(c.X, c.Y, e.type === 'reborn' ? '#dff6ff' : '#8fd0ff', e.type === 'reborn' ? 16 : 8, 70, 0.6, 2.2, -40);
        if (e.type === 'reborn') {
          this.part({ x: c.X, y: c.Y, life: 0.4, size: 26, color: '#bfe8ff', kind: 'flash' });
          this.fx('burst_holy', sx(e.creep.x), sy(e.creep.y), 0.5, { pri: 1 });
        } else this.fx('muzzle_magic', c.X, c.Y, 1.4, { pri: 1, tint: '#8fd0ff' });
        break;
      }
    }
  }

  // A tower fires: the muzzle flash (guns, cannons, flamers) or a magic flare tinted to the missile (orbs, crystals,
  // wells), and for instant weapons the beam to the target; Sharp Tower's blade keeps its slash.
  shot(e, r) {
    const tw = e.tower, d = tw.def, A = r.muzzle(tw);
    if (d.weapon === 'normal') {
      const B = r.creepCenter(e.target);
      this.beams.push({ x0: A.X, y0: A.Y, x1: B.X, y1: B.Y, kind: 'slash', life: 0.1, max: 0.1, seed: Math.random() * 99 });
      return;
    }
    const B = e.target ? r.creepCenter(e.target) : null, ang = B ? Math.atan2(B.Y - A.Y, B.X - A.X) : 0;
    const fast = d.cooldown < FAST;
    if (d.weapon === 'instant' && B) {
      const bm = BEAM[d.missile], a = bm && sheet(bm[0]);
      if (a) this.fx(bm[0], A.X, A.Y, 1, { pri: fast ? 3 : 2, ang, kx: Math.max(1, Math.hypot(B.X - A.X, B.Y - A.Y)) / (a.length || 240), life: bm[1] });
      else this.beams.push({ x0: A.X, y0: A.Y, x1: B.X, y1: B.Y, kind: d.missile, life: d.missile === 'lightning' ? 0.16 : 0.1, max: d.missile === 'lightning' ? 0.16 : 0.1, seed: Math.random() * 99 });
    }
    if (this.skip(tw, 'muzzle')) return;
    if (FLASH.has(d.kind) || tw.def.id === 'h02L') this.fx('muzzle_flash', A.X, A.Y, 1, { pri: 3, ang });
    else if (MAGIC.has(d.kind)) this.fx('muzzle_magic', A.X, A.Y, 0.8, { pri: 3, tint: COL[d.missile] || '#ffffff' });
  }

  // A missile lands (or an instant shot hits): its hit sheet at the creep (artillery: the ground), and for splash
  // weapons the kind's blast at the ground point with the splash's true extent as a ring decal; some leave a decal.
  impact(e, X, Y, GX, GY) {
    const kind = e.missile, tw = e.tower, d = tw && tw.def, splash = e.splash, col = COL[kind] || '#ffffff';
    if (splash) {
      const rr = Math.max(0.35, (splash.full || splash.medium || 100) / TILE) * P;
      this.decals.push({ X: GX, Y: GY, r: rr, kind: 'ring', color: col, life: 0.35, max: 0.35 });
    }
    if (!sheet('hit_' + kind)) { this.impactOld(kind, X, Y, splash, GX, GY); return; }
    const fast = d && d.cooldown < FAST, pri = fast ? 3 : 2;
    if (!this.skip(tw, 'hit')) {
      if (kind === 'quake') this.fx('hit_quake', GX, GY, 1, { pri });
      else if (!(kind === 'shell' && splash)) this.fx('hit_' + kind, X, Y, d && d.weapon === 'normal' ? 0.8 : 1, { pri });
    }
    if (splash) {
      const rv = clamp((splash.full || splash.medium || 100) / TILE, 0.5, 1.75);
      switch (kind) {
        case 'shell': this.fx('blast_shell', GX, GY, rv, { pri: 2 }, 'smoke'); this.fx('blast_shell', GX, GY, rv, { pri: 2 }); this.decal(GX, GY, 0.65 * rv * P, 'scorch', 6); this.burst(X, Y, '#ffcf60', 6, 120, 0.45, 2.5, 200); break;
        case 'meteor': this.fx('blast_meteor', GX, GY, rv, { pri: 2 }, 'smoke'); this.fx('blast_meteor', GX, GY, rv, { pri: 2 }); this.decal(GX, GY, 0.75 * rv * P, 'scorch', 8); this.burst(X, Y, '#ffcf60', 6, 120, 0.45, 2.5, 200); break;
        case 'frost': this.fx('nova_frost', GX, GY, rv, { pri: 2 }); this.decal(GX, GY, 0.55 * rv * P, 'frost', 3); break;
        case 'water': this.fx('splash_water', GX, GY, rv, { pri: 2 }); break;
        case 'quake': this.fx('ring_quake', GX, GY, rv, { pri: 2 }); this.burst(GX, GY - 4, '#9a7a52', 6, 90, 0.5, 2.5, 260); break;
        case 'swarm': this.fx('cloud_poison', GX, GY, rv, { pri: 2 }); break;
        case 'fire': { const a = sheet('hit_fire'); this.fx('hit_fire', GX, GY, 2 * rv / ((a && a.size) || 0.8), { pri: 2 }); this.decal(GX, GY, 0.5 * rv * P, 'scorch', 4); break; }
        case 'spore': { const a = sheet('hit_spore'); this.fx('hit_spore', GX, GY, 2 * rv / ((a && a.size) || 0.7), { pri: 2 }); break; }
        // the splash-sized moon at a third: at full strength its crescent is a white disc a tile wide over the creeps
        case 'moon': { const a = sheet('hit_moon'); this.fx('hit_moon', GX, GY, 2 * rv / ((a && a.size) || 0.65), { pri: 2, alpha: MOON_SPLASH }); break; }
      }
    }
    if (kind === 'poison') this.decal(GX, GY, 8, 'poison', 3, 0.8);
    else if (kind === 'blood' && Math.random() < 0.25) this.decal(GX, GY, 6, 'blood', 3, 0.6);
  }
  // The procedural impacts (no effect sheets loaded)
  impactOld(kind, X, Y, splash, GX, GY) {
    const col = COL[kind] || '#ffffff';
    switch (kind) {
      case 'shell': case 'meteor':
        this.part({ x: X, y: Y, life: 0.3, size: kind === 'meteor' ? 30 : 20, color: '#ffb040', kind: 'flash' });
        this.burst(X, Y, '#ffcf60', 12, 120, 0.45, 2.5, 200);
        this.smoke(X, Y, 6, 9, '#4a423a');
        this.decal(GX, GY, kind === 'meteor' ? 16 : 11, 'scorch', 6);
        break;
      case 'fire':
        this.part({ x: X, y: Y, life: 0.25, size: 16, color: '#ff8a22', kind: 'flash' });
        this.burst(X, Y, '#ffb040', 10, 70, 0.4, 2, -40);
        break;
      case 'quake':
        this.decals.push({ X: GX, Y: GY, r: 34, kind: 'ring', color: '#d8b888', life: 0.4, max: 0.4 });
        this.burst(GX, GY - 4, '#9a7a52', 10, 90, 0.5, 2.5, 260);
        this.smoke(GX, GY, 5, 8, '#8a7a62');
        break;
      case 'frost':
        this.part({ x: X, y: Y, life: 0.25, size: 14, color: '#8fe0ff', kind: 'flash' });
        this.burst(X, Y, '#dff6ff', 9, 60, 0.4, 2);
        break;
      case 'poison': case 'spirit':
        this.burst(X, Y, col, 8, 45, 0.45, 2.2, 60);
        if (kind === 'poison') this.decal(GX, GY, 8, 'poison', 3);
        break;
      case 'blood': this.burst(X, Y, '#b01212', 7, 55, 0.35, 2, 200); break;
      case 'arrow': case 'spear': case 'bullet': this.burst(X, Y, '#f0e0b0', 4, 40, 0.2, 1.5); break;
      default:
        this.part({ x: X, y: Y, life: 0.22, size: 12, color: col, kind: 'flash' });
        this.burst(X, Y, col, 7, 55, 0.35, 2);
    }
  }

  // A creep dies: its corpse (the renderer's death frames), the gold it pays, and what its death leaves by the sprite it
  // is drawn with: ghosts dissolve in light, the infernal in fel fire, machines in dust and scorch, the treant in
  // splinters, the Phoenix in fire, everyone else in blood.
  death(e, r) {
    const c = e.creep, L = r.look(c.def), K0 = L.k, X = sx(c.x), Y = sy(c.y), h = r.creepTop ? r.creepTop(c) : L.ay;
    const top = Y - h * K0, cy = Y - h * K0 * (c.def.flying ? 0.55 : 0.45);
    this.corpses.push(r.corpseOf(c, this.t));
    if (this.corpses.length > MAX_CORPSES) this.corpses.shift();
    if (e.gold) this.goldText(X, top - 2, e.gold);   // Creep Fix kills pay nothing
    if (e.fix) { this.burst(X, Y - h * K0 * 0.5, '#fff0a8', 10, 60, 0.5, 2); this.fx('burst_holy', X, Y, 0.45, { pri: 1 }); }
    const cs = L.cs;
    if (!sheet('hit_blood')) {   // procedural
      if (L.kind === 'ghost' || L.kind === 'fel') this.burst(X, Y - h * K0 * 0.5, L.kind === 'fel' ? '#6bff3a' : '#cfe8ff', 14, 70, 0.6, 2.5);
      else { this.decal(X, Y, 7 + L.fw * K0 * 0.12, 'blood', 5); this.burst(X, Y - h * K0 * 0.4, '#a01010', 6, 40, 0.4, 2, 160); }
      return;
    }
    switch (L.kind) {
      case 'ghost': this.fx('death_ghost', X, Y, cs, { pri: 1 }); this.burst(X, Y - h * K0 * 0.5, '#cfe8ff', 6, 70, 0.6, 2.5); break;
      case 'fel': this.fx('death_fel', X, Y, cs, { pri: 1 }); break;
      case 'machine': this.fx('hit_quake', X, Y, 0.8, { pri: 1 }); this.decal(X, Y, 12, 'scorch', 5, 0.6 * cs); break;
      case 'treant': this.fx('hit_quake', X, Y, 0.7, { pri: 1 }); break;
      case 'phoenix': this.fx('hit_fire', X, cy, 1.2, { pri: 1 }); break;
      default: this.fx('hit_blood', X, cy, 0.9, { pri: 1 }); this.decal(X, Y, 7, 'blood', 5, 0.6 * cs);
    }
  }

  goldText(X, Y, gold) { this.addText({ X, Y, text: '+' + gold, color: '#ffd84a', size: 13, life: 1.3, max: 1.3, coin: true }); }

  // ---------------------------------------------------------------- per-frame update
  update(dt, game, r) {
    this.t += dt;
    for (const p of this.parts) {
      p.life -= dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.size += p.grow * dt;
    }
    prune(this.parts, live);
    for (const d of this.decals) d.life -= dt;
    prune(this.decals, live);
    for (const t of this.texts) { t.life -= dt; t.Y -= 26 * dt; }
    prune(this.texts, live);
    for (const b of this.beams) b.life -= dt;
    prune(this.beams, live);
    const now = this.t;
    prune(this.corpses, (c) => c.end > now);
    // one-shot sheets past their last frame (beams: their life) go back to the pool
    for (const list of [this.sheets, this.under]) {
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i], el = now - e.t0;
        if (e.life ? el < e.life : el * e.a.fps < e.a.frames) list[n++] = e;
        else { e.a = null; FREE.push(e); ACTIVE--; }
      }
      list.length = n;
    }
    this.castleFlash = Math.max(0, this.castleFlash - dt * 1.5);
    if (this.hitFlash.size > 400) this.hitFlash.clear();

    // projectiles: screen positions and trails
    const seen = this.seen;
    seen.clear();
    for (const m of game.missiles) {
      seen.add(m.id);
      let s = this.track.get(m.id);
      if (!s || s.target !== m.target) {
        const start = s ? { X: s.X, Y: s.Y } : r.muzzle(m.tower);
        s = { X0: start.X, Y0: start.Y, X: start.X, Y: start.Y, d0: Math.max(0.05, Math.hypot(m.tx - m.x, m.ty - m.y)), target: m.target, ang: 0, id: m.id };
        this.track.set(m.id, s);
      }
      const f = m.flight ? Math.min(1, m.t / m.flight) : 1 - Math.min(1, Math.hypot(m.tx - m.x, m.ty - m.y) / s.d0);
      let TX = sx(m.tx), TY = sy(m.ty) - 6;
      if (!m.flight && m.target && !m.target.dead) { const c = r.creepCenter(m.target); TX = c.X; TY = c.Y; }
      let X = s.X0 + (TX - s.X0) * f, Y = s.Y0 + (TY - s.Y0) * f;
      if (m.flight) Y -= Math.sin(Math.PI * f) * Math.min(80, 24 + s.d0 * 9);
      if (m.def.missile === 'meteor') { X = TX + (1 - f) * 50; Y = TY - (1 - f) * 190; }
      if (Math.hypot(X - s.X, Y - s.Y) > 0.01) s.ang = Math.atan2(Y - s.Y, X - s.X);
      s.X = X; s.Y = Y;
      const kind = m.def.missile;
      if (s.kind !== kind) { s.kind = kind; s.a = sheet('fly_' + kind); }
      // trails: shell smoke and fire embers as before; the glowing missiles' motes at half the rate (their sheets carry
      // their own tails), none for the rest
      const rate = s.a ? (kind === 'shell' || kind === 'fire' || kind === 'meteor' ? 40 : MOTES.has(kind) ? 20 : 0) : 40;
      if (rate && Math.random() < dt * rate * this.density) {
        if (kind === 'shell') this.part({ x: X, y: Y, vy: -6, life: 0.5, size: 3, grow: 8, color: '#6a625a', kind: 'smoke', add: false, a: 0.5 });
        else if (kind === 'fire' || kind === 'meteor') this.part({ x: X + rnd(-2, 2), y: Y + rnd(-2, 2), vy: -10, life: 0.35, size: kind === 'meteor' ? 6 : 3.5, color: '#ff8a22' });
        else if (kind === 'frost' || kind === 'wisp' || kind === 'spore' || kind === 'moon') this.part({ x: X, y: Y, life: 0.3, size: 2.2, color: COL[kind] });
        else if (kind === 'poison' || kind === 'spirit' || kind === 'shadow') this.part({ x: X, y: Y, life: 0.3, size: 2.5, color: COL[kind] });
      }
    }
    for (const id of this.track.keys()) if (!seen.has(id)) this.track.delete(id);

    // ambient tower and portal particles
    for (const tw of game.towers) {
      if (tw.building > 0) continue;
      const m = r.man.towers[tw.def.id];
      let an;   // the frame it shows (only asked for when a particle comes): points on a swinging part move with it
      for (const f of m.fx) {
        const rate = { wisp: 6, flame: 9, bubble: 3, spores: 2.5, sparkle: 2, orb: 1.2 }[f.kind];
        if (!rate || Math.random() > rate * this.density * dt) continue;
        if (an === undefined) an = m.anims && m.anims.attack && r.towerAnim ? r.towerAnim(tw, m, game, this.t) : null;
        const d = r.fxShift ? r.fxShift(m, f, an) : null;
        if (r.fxShift && !d) continue;
        const p = r.fxPoint(tw, f), X = p.X + (d ? d[0] : 0), Y = p.Y + (d ? d[1] : 0), s = f.size || 1;
        if (f.kind === 'flame') this.part({ x: X + rnd(-4, 4) * s, y: Y - 8 * s, vx: rnd(-6, 6), vy: rnd(-40, -20), life: rnd(0.4, 0.8), size: 1.6, color: '#ffb040' });
        else if (f.kind === 'bubble') this.part({ x: X + rnd(-9, 9) * s, y: Y + rnd(-2, 2), vy: rnd(-18, -8), life: rnd(0.5, 1), size: 2.4, color: f.color });
        else if (f.kind === 'spores') this.part({ x: X + rnd(-12, 12), y: Y + rnd(-4, 4), vx: rnd(-6, 6), vy: rnd(-14, -5), life: rnd(1, 1.8), size: 2, color: f.color });
        else this.part({ x: X + rnd(-6, 6) * s, y: Y + rnd(-6, 6) * s, vy: rnd(-16, -4), life: rnd(0.4, 0.9), size: 1.8, color: f.color });
      }
    }
    if (!this.lane && Math.random() < dt * 8 * this.density) {
      const p = r.props.find(q => q.portal);
      if (p) this.part({ x: sx(p.x) + rnd(-20, 20), y: sy(p.y, p.z) - rnd(10, 70), vy: rnd(-22, -8), vx: rnd(-6, 6), life: rnd(0.6, 1.2), size: 2, color: Math.random() < 0.5 ? '#7dff5a' : '#b06bff' });
    }
  }

  // ---------------------------------------------------------------- drawing
  // view: the visible rect [x0, y0, x1, y1] in this layer's logical px, to cull by (optional)
  drawGround(ctx, view = null) {
    for (const d of this.decals) {
      const k = d.life / d.max;
      if (d.kind === 'ring') {
        const rr = d.r * (1.1 - k * 0.7);
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath(); ctx.ellipse(d.X, d.Y, rr, rr * SIN, 0, 0, Math.PI * 2);
        ctx.lineWidth = 2 * k + 0.5; ctx.strokeStyle = hexA(d.color, 0.38 * k); ctx.stroke();
        ctx.fillStyle = hexA(d.color, 0.06 * k); ctx.fill();
        ctx.restore();
        continue;
      }
      if (d.a) {   // the sheet: faded over the last 40 % of its life
        if (!inView(view, d.X - 2 * P, d.Y - P, 4 * P, 2 * P)) continue;
        ctx.globalAlpha = Math.min(1, k / 0.4);
        drawFrame(ctx, d.a, 0, d.X, d.Y, d.k);
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.save(); ctx.globalAlpha = Math.min(1, k * 2) * 0.7; ctx.translate(d.X, d.Y); ctx.scale(1, SIN); ctx.rotate(d.rot);
      if (d.kind === 'scorch') {
        const g = ctx.createRadialGradient(0, 0, 1, 0, 0, d.r);
        g.addColorStop(0, 'rgba(20,14,8,0.9)'); g.addColorStop(1, 'rgba(20,14,8,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, d.r, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = d.kind === 'poison' ? 'rgba(80,200,40,0.6)' : d.kind === 'frost' ? 'rgba(170,220,255,0.5)' : 'rgba(110,8,8,0.75)';
        for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(Math.cos(i * 1.7) * d.r * 0.5, Math.sin(i * 2.3) * d.r * 0.4, d.r * (0.35 + 0.1 * i), 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();
    }
    // one-shots on the ground (the poison cloud's murk)
    if (this.under.length) {
      for (const e of this.under) {
        ctx.globalCompositeOperation = e.a.blend === 'add' ? 'lighter' : 'source-over';
        this.drawSheet(ctx, e, view);
      }
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
  }

  drawCorpse(ctx, d, r) { r.drawCorpse(ctx, d, this.t); }

  // One sheet record: its frame now (a beam loops its frames over its life and fades over the last 40 %; a one-shot's
  // last frame fades out), culled by its box.
  drawSheet(ctx, e, view) {
    const a = e.a, el = this.t - e.t0;
    let f, fade = 1;
    if (e.life) { f = Math.floor(el * a.fps) % a.frames; fade = Math.min(1, (1 - el / e.life) / 0.4); }
    else {
      const x = el * a.fps;
      f = Math.floor(x);
      if (f >= a.frames) return;
      if (f < 0) f = 0;
      if (f === a.frames - 1 && a.frames > 1) fade = 1 - (x - f);
    }
    if (fade <= 0) return;
    const r = a.rects[f];
    if (!e.ang && !e.kx && !inView(view, e.X - r[4] * e.k, e.Y - r[5] * e.k, r[2] * e.k, r[3] * e.k)) return;
    ctx.globalAlpha = e.alpha * fade;
    drawFrame(ctx, a, f, e.X, e.Y, e.k, e.ang, e.kx, e.tint ? tintedSheetFrame(a, f, e.tint) : null);
  }
  drawFly(ctx, s, view) {
    const a = s.a;
    if (!inView(view, s.X - 40, s.Y - 40, 80, 80)) return;
    ctx.globalAlpha = 1;
    drawFrame(ctx, a, Math.floor(this.t * a.fps + s.id) % a.frames, s.X, s.Y, K, a.rotate ? s.ang : 0);
  }

  drawAir(ctx, r, view = null) {
    // castle hit flash
    if (this.castleFlash > 0) r.glow(ctx, sx(5.2), sy(14.5) - 30, 90, '#ff3020', 0.5 * this.castleFlash);
    // the alpha sheets (smoke under its blast's fire), then every additive sheet in one 'lighter' batch
    ctx.save();
    for (const e of this.sheets) if (e.a.blend !== 'add') this.drawSheet(ctx, e, view);
    for (const s of this.track.values()) if (s.a && s.a.blend !== 'add') this.drawFly(ctx, s, view);
    ctx.globalCompositeOperation = 'lighter';
    for (const e of this.sheets) if (e.a.blend === 'add') this.drawSheet(ctx, e, view);
    for (const s of this.track.values()) if (s.a && s.a.blend === 'add') this.drawFly(ctx, s, view);
    ctx.restore();
    for (const b of this.beams) this.drawBeam(ctx, b, r);
    for (const s of this.track.values()) if (!s.a) this.drawMissile(ctx, s, s.kind, r);
    if (!this.parts.length) return;
    // smoke first with normal blending, then every additive particle in one 'lighter' batch
    ctx.save();
    for (const p of this.parts) {
      if (p.kind !== 'smoke') continue;
      ctx.globalAlpha = Math.max(0, p.a * p.life / p.max); ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.parts) {
      const k = Math.max(0, p.life / p.max);
      if (p.kind === 'smoke') continue;
      if (p.kind === 'spark') {
        ctx.globalAlpha = 1; ctx.strokeStyle = hexA(p.color, k); ctx.lineWidth = p.size;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04); ctx.stroke();
      } else if (p.kind === 'flash') r.glowAdd(ctx, p.x, p.y, p.size * (1.4 - k * 0.4), p.color, 0.9 * k);
      else r.glowAdd(ctx, p.x, p.y, p.size * 2.2, p.color, 0.85 * k);
    }
    ctx.restore();
  }

  // The procedural missiles (no fly_ sheet)
  drawMissile(ctx, s, kind, r) {
    const { X, Y, ang } = s, c = Math.cos(ang), n = Math.sin(ang);
    ctx.save();
    switch (kind) {
      case 'arrow': case 'spear': {
        const L = kind === 'spear' ? 16 : 11;
        ctx.strokeStyle = kind === 'spear' ? '#6a4a2a' : '#c9b48a'; ctx.lineWidth = kind === 'spear' ? 2.6 : 1.6;
        ctx.beginPath(); ctx.moveTo(X - c * L, Y - n * L); ctx.lineTo(X, Y); ctx.stroke();
        ctx.fillStyle = '#e8eef4'; ctx.beginPath(); ctx.moveTo(X + c * 4, Y + n * 4); ctx.lineTo(X - n * 2.2, Y + c * 2.2); ctx.lineTo(X + n * 2.2, Y - c * 2.2); ctx.fill();
        break;
      }
      case 'shell': case 'quake':
        ctx.fillStyle = kind === 'shell' ? '#1a1612' : '#7a5a3a'; ctx.beginPath(); ctx.arc(X, Y, 3.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.arc(X - 1, Y - 1, 1.2, 0, Math.PI * 2); ctx.fill();
        break;
      case 'blood':
        ctx.fillStyle = '#9a0a0a'; ctx.beginPath(); ctx.arc(X, Y, 3, 0, Math.PI * 2); ctx.fill();
        break;
      case 'swarm':
        ctx.fillStyle = '#2a1a3a';
        for (let i = 0; i < 4; i++) { const a = this.t * 14 + i * 1.6; ctx.beginPath(); ctx.ellipse(X + Math.cos(a) * 5, Y + Math.sin(a) * 3, 3, 1.4, a, 0, Math.PI * 2); ctx.fill(); }
        break;
      case 'meteor':
        ctx.globalCompositeOperation = 'lighter';
        r.glowAdd(ctx, X, Y, 18, '#ff6a1a', 0.9); r.glowAdd(ctx, X, Y, 6, '#fff0c0', 1);
        break;
      default: {
        const col = COL[kind] || '#ffffff';
        ctx.globalCompositeOperation = 'lighter';
        r.glowAdd(ctx, X, Y, kind === 'wisp' || kind === 'moon' ? 11 : 9, col, 0.85);
        r.glowAdd(ctx, X, Y, 3.5, '#ffffff', 0.9);
        break;
      }
    }
    ctx.restore();
  }

  // The procedural beams: Sharp Tower's slash, and the instant weapons when their sheets are missing
  drawBeam(ctx, b, r) {
    const k = b.life / b.max;
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    if (b.kind === 'lightning') {
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass ? `rgba(255,255,255,${0.9 * k})` : `rgba(120,200,255,${0.6 * k})`;
        ctx.lineWidth = pass ? 1.5 : 4.5;
        ctx.beginPath(); ctx.moveTo(b.x0, b.y0);
        const N = 7;
        for (let i = 1; i < N; i++) {
          const f = i / N, j = Math.sin(b.seed + i * 12.9) * 9;
          ctx.lineTo(b.x0 + (b.x1 - b.x0) * f - (b.y1 - b.y0) / 60 * j, b.y0 + (b.y1 - b.y0) * f + (b.x1 - b.x0) / 60 * j);
        }
        ctx.lineTo(b.x1, b.y1); ctx.stroke();
      }
    } else if (b.kind === 'slash') {
      ctx.strokeStyle = `rgba(255,240,230,${0.9 * k})`; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(b.x1, b.y1, 9, -2.2 + b.seed % 1, -0.6 + b.seed % 1); ctx.stroke();
      ctx.strokeStyle = `rgba(200,20,20,${0.8 * k})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(b.x1, b.y1, 6, -2.0, -0.8); ctx.stroke();
    } else {
      const col = { bullet: '#ffe9a0', holy: '#fff0a8', water: '#6ab8ff', spirit: '#9dffb0' }[b.kind] || '#ffffff';
      const wdt = { bullet: 1.4, holy: 5, water: 4, spirit: 4 }[b.kind] || 2;
      ctx.strokeStyle = hexA(col, 0.85 * k); ctx.lineWidth = wdt;
      ctx.beginPath(); ctx.moveTo(b.x0, b.y0); ctx.lineTo(b.x1, b.y1); ctx.stroke();
      if (wdt > 2) { ctx.strokeStyle = `rgba(255,255,255,${0.7 * k})`; ctx.lineWidth = 1.2; ctx.stroke(); }
      r.glowAdd(ctx, b.x1, b.y1, 8, col, 0.7 * k);
    }
    ctx.restore();
  }

  // The canvas state is set once for the batch, the font only when the size changes (setting it is not cheap). A '+gold'
  // text has a spinning coin (gold_coin) before it.
  drawTexts(ctx) {
    if (!this.texts.length) return;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const coin = sheet('gold_coin');
    let size = 0;
    for (const t of this.texts) {
      const k = t.life / t.max;
      ctx.globalAlpha = Math.min(1, k * 2.2);
      if (t.size !== size) { size = t.size; ctx.font = `700 ${size}px 'Alegreya Sans', sans-serif`; }
      let x = t.X;
      if (t.coin) {
        const w = ctx.measureText(t.text).width;
        x += 6;
        const cx = x - w / 2 - 7;
        if (coin) drawFrame(ctx, coin, Math.floor(this.t * coin.fps + t.X * 0.1) % coin.frames, cx, t.Y, K * 1.2);
        else {
          const g = ctx.createRadialGradient(cx - 1.5, t.Y - 1.5, 0.5, cx, t.Y, 5);
          g.addColorStop(0, '#fff6c2'); g.addColorStop(0.5, '#f5c84a'); g.addColorStop(1, '#8a5a14');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, t.Y, 4.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(t.text, x, t.Y);
      ctx.fillStyle = t.color; ctx.fillText(t.text, x, t.Y);
    }
    ctx.restore();
  }
}

// For the console and tests: one-shot sheets alive over every layer.
export const activeSheets = () => ACTIVE;
