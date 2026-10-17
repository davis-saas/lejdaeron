// Draws the battlefield: Blender ground and props, depth-sorted towers and creeps, overlays.
import { COLS, ROWS, SIN, COS, TOP, SCREEN_W, SCREEN_H, buildable, TILE } from './level.js';

export const P = 48;                 // logical px per tile
export const K = P / 96;             // sprites are rendered at 96 px per tile
export const TK = K * 1.12;          // towers are drawn a little larger so they fill their tile
export const CK = K * 1.15;          // creeps too, so they read clearly at game size
export const W = Math.round(SCREEN_W * P), H = Math.round(SCREEN_H * P);
export const sx = (x) => x * P;
export const sy = (y, z = 0) => (y * SIN - z * COS + TOP) * P;

const overlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

export class Renderer {
  constructor(canvas, assets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.man = assets.man;
    this.layout = assets.layout;
    this.scale = 1;
    this.props = this.buildProps();
  }

  // ---------------------------------------------------------------- setup
  buildProps() {
    const M = this.man.props, L = this.layout, list = [];
    for (const t of [...L.trees, ...L.rocks]) list.push({ m: M[t.type], x: t.x, y: t.y, flip: t.flip, key: t.y });
    list.push({ m: M.castle, x: L.castle.x, y: L.castle.y, key: L.castle.y, castle: true });
    list.push({ m: M.portal, x: L.portal.x, y: L.portal.y, key: L.portal.y, portal: true, dynamic: true });
    for (const p of list) p.box = [sx(p.x) - p.m.ax * K, sy(p.y) - p.m.ay * K, p.m.w * K, p.m.h * K];
    list.sort((a, b) => a.key - b.key);
    return list;
  }

  resize(cssW, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.scale = (cssW / W) * dpr;
    this.canvas.width = Math.round(W * this.scale);
    this.canvas.height = Math.round(H * this.scale);
    this.buildStatic();
  }

  buildStatic() {
    const c = document.createElement('canvas');
    c.width = this.canvas.width; c.height = this.canvas.height;
    const x = c.getContext('2d');
    x.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    x.imageSmoothingQuality = 'high';
    x.drawImage(this.man.ground.img, 0, 0, W, H);
    if (!this.man.shadows) for (const p of this.props) if (!p.castle && !p.portal) this.blob(x, sx(p.x) + 2, sy(p.y) + 1, p.m.w * K * 0.3, 0.32);
    for (const p of this.props) if (!p.dynamic) this.sprite(x, p.m, sx(p.x), sy(p.y), p.flip);
    // soft vignette like the in-game fog at the map edges
    const g = x.createRadialGradient(W / 2, H * 0.55, H * 0.45, W / 2, H * 0.55, W * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.38)');
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    this.static = c;
    this.mini = null;
  }

  // ---------------------------------------------------------------- primitives
  sprite(ctx, m, X, Y, flip = false, img = null, k = K) {
    const im = img || m.img;
    if (flip) {
      ctx.save(); ctx.translate(X, Y); ctx.scale(-1, 1);
      ctx.drawImage(im, m.sx, m.sy, m.w, m.h, -m.ax * k, -m.ay * k, m.w * k, m.h * k);
      ctx.restore();
    } else ctx.drawImage(im, m.sx, m.sy, m.w, m.h, X - m.ax * k, Y - m.ay * k, m.w * k, m.h * k);
  }
  frame(ctx, m, img, col, row, X, Y, flip, alpha = 1, k = CK) {
    if (alpha < 1) { ctx.save(); ctx.globalAlpha = alpha; }
    if (flip) {
      ctx.save(); ctx.translate(X, Y); ctx.scale(-1, 1);
      ctx.drawImage(img, m.sx + col * m.fw, m.sy + row * m.fh, m.fw, m.fh, -m.ax * k, -m.ay * k, m.fw * k, m.fh * k);
      ctx.restore();
    } else ctx.drawImage(img, m.sx + col * m.fw, m.sy + row * m.fh, m.fw, m.fh, X - m.ax * k, Y - m.ay * k, m.fw * k, m.fh * k);
    if (alpha < 1) ctx.restore();
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

  // ---------------------------------------------------------------- geometry helpers
  creepMeta(c) { return this.man.creeps[c.def.look]; }
  creepBox(c) {
    const m = this.creepMeta(c), X = sx(c.x), Y = sy(c.y);
    return [X - m.ax * CK, Y - m.ay * CK, m.fw * CK, m.fh * CK];
  }
  creepCenter(c) {
    const m = this.creepMeta(c);
    return { X: sx(c.x), Y: sy(c.y) - m.ay * CK * (c.def.flying ? 0.55 : 0.45) };
  }
  towerBox(t) {
    const m = this.man.towers[t.def.id], X = sx(t.x), Y = sy(t.y);
    return [X - m.ax * TK, Y - m.ay * TK, m.w * TK, m.h * TK];
  }
  fxPoint(t, f) {
    const m = this.man.towers[t.def.id];
    return { X: sx(t.x) + (f.px - m.ax) * TK, Y: sy(t.y) + (f.py - m.ay) * TK };
  }
  muzzle(t) {
    const m = this.man.towers[t.def.id];
    const f = m.fx.find(f => f.kind === 'muzzle') || m.fx.find(f => f.kind !== 'bubble' && f.kind !== 'spores');
    if (f) return this.fxPoint(t, f);
    return { X: sx(t.x), Y: sy(t.y) - m.ay * TK * 0.7 };
  }
  creepDir(c) {
    if (Math.abs(c.diry) > Math.abs(c.dirx)) return { row: 1, flip: false };
    return { row: 0, flip: c.dirx < 0 };
  }

  // ---------------------------------------------------------------- frame
  draw(game, view, fx, t) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.static) ctx.drawImage(this.static, 0, 0);
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    if (view.placing) this.drawGrid(ctx, game, view);
    fx.drawGround(ctx);
    const sel = view.selected;
    if (sel && sel.def && sel.def.range) this.ring(ctx, sx(sel.x), sy(sel.y), sel.def.range / TILE * P, 'rgba(255,255,255,0.55)', 1.5, [6, 5], 'rgba(255,255,255,0.05)');
    if (view.hoverTower && view.hoverTower !== sel) this.ring(ctx, sx(view.hoverTower.x), sy(view.hoverTower.y), view.hoverTower.def.range / TILE * P, 'rgba(255,255,255,0.25)', 1, [4, 6]);

    const baked = this.man.shadows;   // Cycles sprites carry their own cast shadows; keep only a faint contact shadow
    for (const tw of game.towers) this.blob(ctx, sx(tw.x) + 1, sy(tw.y) + 1, P * 0.42, baked ? 0.14 : 0.34);
    for (const c of game.creeps) { const m = this.creepMeta(c); this.blob(ctx, sx(c.x) + 1, sy(c.y) + 1, P * (c.def.flying ? 0.16 : 0.2), baked ? (c.def.flying ? 0.12 : 0.16) : 0.3); }
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
      else this.sprite(ctx, it.o.m, sx(it.o.x), sy(it.o.y), it.o.flip);
    }
    if (view.placing && view.hover) this.drawGhost(ctx, game, view);
    fx.drawAir(ctx, this);
    for (const c of game.creeps) this.healthBar(ctx, c, game);
    for (const tw of game.towers) if (tw.building > 0) this.buildBar(ctx, tw);
    fx.drawTexts(ctx);
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
    this.sprite(ctx, m, X, Y, false, null, TK);
    for (const f of m.fx) this.towerFx(ctx, tw, m, f, t);
    if (tw.firedAt && t - tw.firedAt < 0.08) { const p = this.muzzle(tw); this.glow(ctx, p.X, p.Y, 9, '#fff2b0', 0.7); }
  }

  towerFx(ctx, tw, m, f, t) {
    const { X, Y } = this.fxPoint(tw, f);
    const ph = t * 2.6 + tw.id * 1.7, s = f.size || 1;
    if (f.kind === 'orb') this.glow(ctx, X, Y, (9 + 2.5 * Math.sin(ph)) * s, f.color, 0.75);
    else if (f.kind === 'wisp') {
      const bob = Math.sin(ph * 0.8) * 3;
      this.glow(ctx, X, Y + bob, 18 * s, f.color, 0.6);
      this.glow(ctx, X, Y + bob, 6 * s, '#ffffff', 0.95);
    } else if (f.kind === 'flame') drawFlame(ctx, X, Y, 10 * s, 18 * s, t + tw.id);
    else if (f.kind === 'bubble') this.glow(ctx, X, Y, (14 + 2 * Math.sin(ph)) * s, f.color, 0.45);
    else if (f.kind === 'sparkle' || f.kind === 'spores') this.glow(ctx, X, Y, 10 * s, f.color, 0.3 + 0.1 * Math.sin(ph));
  }

  drawPortal(ctx, p, t) {
    this.sprite(ctx, p.m, sx(p.x), sy(p.y));
    // live swirl over the portal surface
    const X = sx(p.x), Y = sy(p.y, 1.2);
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

  drawCreep(ctx, c, game, t, fx) {
    const m = this.creepMeta(c), X = sx(c.x), Y = sy(c.y);
    const { row, flip } = this.creepDir(c);
    const col = Math.floor(c.walk * 1.7) % m.frames;
    const slowed = (c.slowUntil > game.time && c.slowPct > 0) || c.auraSlow > 0 || c.poisons.some(p => p.slow);
    const hit = fx.hitFlash.get(c.id);
    const img = hit && t - hit < 0.06 ? m.hitImg : slowed ? m.slowImg : m.img;
    const hidden = c.def.invisible && !game.visible(c);
    this.frame(ctx, m, img, col, row, X, Y, flip, hidden ? 0.28 : 1);
    if (c.stunUntil > game.time) {
      const top = Y - m.ay * CK - 4;
      for (let i = 0; i < 3; i++) {
        const a = t * 6 + i * 2.1;
        ctx.fillStyle = '#ffe36b';
        ctx.beginPath(); ctx.arc(X + Math.cos(a) * 9, top + Math.sin(a) * 3, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  healthBar(ctx, c, game) {
    const m = this.creepMeta(c), X = sx(c.x), Y = sy(c.y);
    const w = Math.max(22, Math.min(46, m.fw * CK * 0.75)), top = Y - m.ay * CK - 5;
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
      const { X, Y } = this.creepCenter(c), m = this.creepMeta(c);
      const d = Math.hypot(lx - X, ly - Y);
      if (d < Math.max(14, m.fw * CK * 0.45) && d < bd) { bd = d; best = c; }
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

export function hexA(h, a) {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function drawFlame(ctx, X, Y, w, h, t) {
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  const cols = ['rgba(210,52,12,0.75)', 'rgba(255,150,30,0.8)', 'rgba(255,240,170,0.85)'];
  for (let i = 0; i < 3; i++) {
    const k = 1 - i * 0.28, f = Math.sin(t * 11 + i * 2.1) * 0.12 + Math.sin(t * 17 + i) * 0.06;
    const ww = w * k, hh = h * k * (1 + f);
    ctx.beginPath(); ctx.moveTo(X - ww / 2, Y);
    ctx.quadraticCurveTo(X - ww * 0.6, Y - hh * 0.55, X + Math.sin(t * 6 + i) * ww * 0.25, Y - hh);
    ctx.quadraticCurveTo(X + ww * 0.6, Y - hh * 0.5, X + ww / 2, Y);
    ctx.closePath(); ctx.fillStyle = cols[i]; ctx.fill();
  }
  ctx.restore();
}
