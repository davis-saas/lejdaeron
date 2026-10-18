// Visual effects: projectiles, impacts, beams, corpses, floating text and ambient particles.
import { P, sx, sy, hexA, drawFlame } from './render.js?v=a48717ff8443';
import { SIN, TILE } from './level.js?v=a48717ff8443';
import { LIGHT, FX_DENSITY } from './device.js?v=a48717ff8443';

const COL = {
  arrow: '#e8d8b0', spear: '#d8c8a0', bullet: '#ffe9a0', blood: '#c01818', quake: '#b08a5a', wisp: '#bfe8ff', frost: '#8fe0ff',
  water: '#4aa6ff', spark: '#9ff0ff', shell: '#ffb040', shadow: '#b06bff', lightning: '#cfefff', fire: '#ff8a22', meteor: '#ff6a1a',
  poison: '#7dff4a', spirit: '#9dffb0', holy: '#fff0a8', swarm: '#9a7aba', spore: '#bfe8ff', moon: '#cfe8ff',
};
const rnd = (a, b) => a + Math.random() * (b - a);
// particles and floating numbers one layer keeps (the light set: fewer, and every effect spawns FX_DENSITY of its particles)
const MAX_PARTS = LIGHT ? 500 : 1400, MAX_TEXTS = LIGHT ? 40 : Infinity, MAX_DECALS = LIGHT ? 40 : 90;
// Drops the finished entries of a list in place (no new array every frame).
function prune(list, alive) {
  let n = 0;
  for (let i = 0; i < list.length; i++) if (alive(list[i])) list[n++] = list[i];
  list.length = n;
}
const live = (o) => o.life > 0;

export class FX {
  // opts.lane: a Line Tower Wars lane (leaks show at the exit, there is no castle). opts.maxParts caps the particles.
  constructor(opts = {}) {
    this.lane = !!opts.lane; this.maxParts = opts.maxParts || MAX_PARTS; this.density = FX_DENSITY;
    this.parts = []; this.decals = []; this.texts = []; this.beams = []; this.corpses = [];
    this.track = new Map(); this.hitFlash = new Map(); this.emitters = new Map(); this.seen = new Set();
    this.castleFlash = 0; this.t = 0;
  }
  clear() {
    this.parts.length = 0; this.decals.length = 0; this.texts.length = 0; this.beams.length = 0; this.corpses.length = 0;
    this.track.clear(); this.hitFlash.clear(); this.castleFlash = 0;
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
  decal(X, Y, r, kind, life = 4) { this.decals.push({ X, Y, r, kind, life, max: life, rot: Math.random() * 6 }); if (this.decals.length > MAX_DECALS) this.decals.shift(); }

  // ---------------------------------------------------------------- events
  handle(e, r, game) {
    switch (e.type) {
      case 'shot': {
        const tw = e.tower, d = tw.def;
        if (d.weapon === 'instant' || d.weapon === 'normal') {
          const a = r.muzzle(tw), b = r.creepCenter(e.target);
          const kind = d.weapon === 'normal' ? 'slash' : d.missile;
          this.beams.push({ x0: a.X, y0: a.Y, x1: b.X, y1: b.Y, kind, life: kind === 'lightning' ? 0.16 : 0.1, max: kind === 'lightning' ? 0.16 : 0.1, seed: Math.random() * 99 });
        }
        break;
      }
      case 'impact': {
        let X = sx(e.x), Y = sy(e.y) - 6;
        if (e.creep) { const c = r.creepCenter(e.creep); X = c.X; Y = c.Y; this.hitFlash.set(e.creep.id, this.t); }
        this.impact(e.missile, X, Y, e.splash, sx(e.x), sy(e.y));
        break;
      }
      case 'death': {
        const c = e.creep, m = r.creepMeta(c), K = r.creepK(c), { row, flip } = r.creepDir(c);
        const X = sx(c.x), Y = sy(c.y);
        this.corpses.push({ m, k: K, x: c.x, y: c.y, row, flip, col: Math.floor(c.walk * 1.7) % m.frames, life: 1.1, max: 1.1, fly: c.def.flying,
          box: [X - m.ax * K, Y - m.ay * K, m.fw * K, m.fh * K] });
        const top = Y - m.ay * K;
        if (e.gold) this.goldText(X, top - 2, e.gold);   // Creep Fix kills pay nothing
        if (e.fix) this.burst(X, Y - m.ay * K * 0.5, '#fff0a8', 10, 60, 0.5, 2);
        if (c.def.look === 'infernal' || c.def.look === 'shade' || c.def.look === 'wraith' || c.def.look === 'banshee') this.burst(X, Y - m.ay * K * 0.5, c.def.look === 'infernal' ? '#6bff3a' : '#cfe8ff', 14, 70, 0.6, 2.5);
        else { this.decal(X, Y, 7 + m.fw * K * 0.12, 'blood', 5); this.burst(X, Y - m.ay * K * 0.4, '#a01010', 6, 40, 0.4, 2, 160); }
        break;
      }
      case 'leak': {
        if (this.lane) { const c = e.creep; this.text(sx(Math.min(c.x, 43.5)), sy(c.y) - 40, '-1 life', '#ff5a48', 16, 1.4); break; }
        this.castleFlash = 1;
        this.text(sx(6.6), sy(14.5) - 46, '-1 life', '#ff5a48', 16, 1.4);
        break;
      }
      case 'build': case 'upgrade': {
        const X = sx(e.tower.x), Y = sy(e.tower.y);
        this.smoke(X, Y, 8, 7, '#8a7a62');
        if (e.type === 'upgrade') for (let i = 0; i < 14 * this.density; i++) this.part({ x: X + rnd(-16, 16), y: Y - rnd(0, 40), vy: rnd(-40, -15), life: rnd(0.5, 1), size: 2.5, color: '#ffe39a' });
        break;
      }
      case 'sell': this.goldText(sx(e.tower.x), sy(e.tower.y) - 30, e.gold); this.smoke(sx(e.tower.x), sy(e.tower.y), 8, 8, '#8a7a62'); break;
      case 'bash': { const c = r.creepCenter(e.creep); this.burst(c.X, c.Y, '#ffe36b', 6, 50, 0.3, 2); break; }
      // Line Tower Wars attackers (phase 3): towers that take blows and fall, death damage, reincarnation
      case 'damaged': if (e.tower) this.burst(sx(e.tower.x), sy(e.tower.y) - 22, '#c8b48a', 3, 45, 0.3, 1.8, 180); break;
      case 'destroyed': {
        const X = sx(e.tower.x), Y = sy(e.tower.y);
        this.part({ x: X, y: Y - 20, life: 0.35, size: 30, color: '#ffb040', kind: 'flash' });
        this.burst(X, Y - 18, '#8a7458', 16, 110, 0.6, 3, 260);
        this.smoke(X, Y - 8, 10, 10, '#5a5048');
        this.decal(X, Y, 14, 'scorch', 8);
        break;
      }
      case 'blast': {
        const X = sx(e.x), Y = sy(e.y);
        this.decals.push({ X, Y, r: Math.max(0.5, (e.radius || 100) / TILE) * P, kind: 'ring', color: '#ff7a2a', life: 0.5, max: 0.5 });
        this.part({ x: X, y: Y - 10, life: 0.4, size: 34, color: '#ff8a22', kind: 'flash' });
        this.burst(X, Y - 10, '#ffcf60', 14, 120, 0.5, 2.5, 120);
        break;
      }
      case 'hurt': if (e.creep) this.hitFlash.set(e.creep.id, this.t); break;
      case 'reincarnate': case 'reborn': {
        const c = r.creepCenter(e.creep);
        this.burst(c.X, c.Y, e.type === 'reborn' ? '#dff6ff' : '#8fd0ff', e.type === 'reborn' ? 16 : 8, 70, 0.6, 2.2, -40);
        if (e.type === 'reborn') this.part({ x: c.X, y: c.Y, life: 0.4, size: 26, color: '#bfe8ff', kind: 'flash' });
        break;
      }
    }
  }

  goldText(X, Y, gold) { this.addText({ X, Y, text: '+' + gold, color: '#ffd84a', size: 13, life: 1.3, max: 1.3, coin: true }); }

  impact(kind, X, Y, splash, GX, GY) {
    const col = COL[kind] || '#ffffff';
    if (splash) {
      const rr = Math.max(0.35, (splash.full || splash.medium || 100) / TILE) * P;
      this.decals.push({ X: GX, Y: GY, r: rr, kind: 'ring', color: col, life: 0.35, max: 0.35 });
    }
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
    for (const c of this.corpses) c.life -= dt;
    prune(this.corpses, live);
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
        s = { X0: start.X, Y0: start.Y, X: start.X, Y: start.Y, d0: Math.max(0.05, Math.hypot(m.tx - m.x, m.ty - m.y)), target: m.target, ang: 0 };
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
      s.kind = kind;
      if (Math.random() < dt * 40 * this.density) {
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
      for (const f of m.fx) {
        const rate = { wisp: 6, flame: 9, bubble: 3, spores: 2.5, sparkle: 2, orb: 1.2 }[f.kind];
        if (!rate || Math.random() > rate * this.density * dt) continue;
        const { X, Y } = r.fxPoint(tw, f), s = f.size || 1;
        if (f.kind === 'flame') this.part({ x: X + rnd(-4, 4) * s, y: Y - 8 * s, vx: rnd(-6, 6), vy: rnd(-40, -20), life: rnd(0.4, 0.8), size: 1.6, color: '#ffb040' });
        else if (f.kind === 'bubble') this.part({ x: X + rnd(-9, 9) * s, y: Y + rnd(-2, 2), vy: rnd(-18, -8), life: rnd(0.5, 1), size: 2.4, color: f.color });
        else if (f.kind === 'spores') this.part({ x: X + rnd(-12, 12), y: Y + rnd(-4, 4), vx: rnd(-6, 6), vy: rnd(-14, -5), life: rnd(1, 1.8), size: 2, color: f.color });
        else this.part({ x: X + rnd(-6, 6) * s, y: Y + rnd(-6, 6) * s, vy: rnd(-16, -4), life: rnd(0.4, 0.9), size: 1.8, color: f.color });
      }
    }
    if (!this.lane && Math.random() < dt * 8 * this.density) {
      const p = r.props.find(q => q.portal);
      if (p) this.part({ x: sx(p.x) + rnd(-20, 20), y: sy(p.y) - rnd(10, 70), vy: rnd(-22, -8), vx: rnd(-6, 6), life: rnd(0.6, 1.2), size: 2, color: Math.random() < 0.5 ? '#7dff5a' : '#b06bff' });
    }
  }

  // ---------------------------------------------------------------- drawing
  drawGround(ctx) {
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
      ctx.save(); ctx.globalAlpha = Math.min(1, k * 2) * 0.7; ctx.translate(d.X, d.Y); ctx.scale(1, SIN); ctx.rotate(d.rot);
      if (d.kind === 'scorch') {
        const g = ctx.createRadialGradient(0, 0, 1, 0, 0, d.r);
        g.addColorStop(0, 'rgba(20,14,8,0.9)'); g.addColorStop(1, 'rgba(20,14,8,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, d.r, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = d.kind === 'poison' ? 'rgba(80,200,40,0.6)' : 'rgba(110,8,8,0.75)';
        for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(Math.cos(i * 1.7) * d.r * 0.5, Math.sin(i * 2.3) * d.r * 0.4, d.r * (0.35 + 0.1 * i), 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();
    }
  }

  drawCorpse(ctx, d, r) {
    const k = d.life / d.max;
    const X = sx(d.x), Y = sy(d.y) + (1 - k) * (d.fly ? 14 : 6);
    r.frame(ctx, d.m, d.m.img, d.col, d.row, X, Y, d.flip, Math.min(1, k * 1.6) * 0.95, d.k);
  }

  drawAir(ctx, r) {
    // castle hit flash
    if (this.castleFlash > 0) r.glow(ctx, sx(5.2), sy(14.5) - 30, 90, '#ff3020', 0.5 * this.castleFlash);
    for (const b of this.beams) this.drawBeam(ctx, b, r);
    for (const s of this.track.values()) this.drawMissile(ctx, s, s.kind, r);
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

  // The canvas state is set once for the batch, the font only when the size changes (setting it is not cheap).
  drawTexts(ctx) {
    if (!this.texts.length) return;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
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
        const g = ctx.createRadialGradient(cx - 1.5, t.Y - 1.5, 0.5, cx, t.Y, 5);
        g.addColorStop(0, '#fff6c2'); g.addColorStop(0.5, '#f5c84a'); g.addColorStop(1, '#8a5a14');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, t.Y, 4.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(t.text, x, t.Y);
      ctx.fillStyle = t.color; ctx.fillText(t.text, x, t.Y);
    }
    ctx.restore();
  }
}
