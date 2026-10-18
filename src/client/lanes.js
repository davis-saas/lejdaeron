// Draws the Line Tower Wars world. Every lane is horizontal (creeps enter on the left at u = 0 and leave on the right
// at u = 44) and the lanes are stacked top to bottom in ring order from the viewer's own lane, LANE_PITCH rows apart.
// Lane-local x, y (u, v) are drawn through a per-lane translation, so every sprite helper of the Classic Renderer works
// unchanged. Per frame: the lane ground (cached at the current zoom, one canvas shared by every lane) for each lane in
// view, then each lane's depth-sorted props, towers, creeps and tech area, then missiles, particles and bars, then the
// name plates.
import { Renderer, P, K, TK, sx, sy, hexA, drawFlame } from '../render.js?v=a48717ff8443';
import { SIN, TOP, TILE } from '../level.js?v=a48717ff8443';
import { SPAWN_U, EXIT_U, LANE_ROWS } from '../lane.js?v=a48717ff8443';
import { mulberry32 } from '../rng.js?v=a48717ff8443';
import { tinted } from '../assets.js?v=a48717ff8443';
import { pixelRatio, canvasScale } from '../device.js?v=a48717ff8443';
import { LANE_PITCH, LANE_X0, LANE_X1, LANE_Y0, LANE_Y1, BAND, laneDY, PLAYER_HEX, PLAYER_TEXT, techArea, botNamed } from './common.js?v=a48717ff8443';

const GX0 = sx(LANE_X0), GX1 = sx(LANE_X1), GY0 = sy(LANE_Y0), GY1 = sy(LANE_Y1);   // one band, logical px
const REACH = 3.2 * P;              // how far tall sprites reach above their tile (logical px), for culling
const DARK = '#070906';             // the world beyond the lane art (the map's black boundary, a touch of forest green)
const FRINGE = LANE_ROWS + 0.25;    // the forest floor past the south kerb, which tiles onto the next lane's north edge
const FADE = 0.6 * P;               // how far the lane art fades into the dark at its west and east ends
const SHADOWS_FROM = 30;            // css px per tile: the light set leaves out the contact shadows when the view is farther
const byKey = (a, b) => a.key - b.key;
// The ring an aura's bonus puts at the feet of every creep that has it this tick (WC3's aura target art), one colour per
// kind of bonus: haste (Endurance and Unholy Aura), healing (Unholy), healing in percent (Regeneration), damage (Command).
const AURA_RINGS = [['moveBonus', '#ffb84a'], ['regenBonus', '#7dff5a'], ['regenPct', '#4affd0'], ['dmgBonus', '#ff6a4a']];
const overlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
let BLOB = null;                    // pre-rendered contact shadow

export class LaneRenderer extends Renderer {
  constructor(canvas, assets) {
    super(canvas, assets);
    const L = this.man.lane;
    this.spawnAt = (L && L.spawn) || { x: 1, y: LANE_ROWS / 2 };
    this.exitAt = (L && L.exit) || { x: EXIT_U + 1, y: LANE_ROWS / 2 };
    // gate glows after the art (a blue waygate, a red portal); the fallback lane has the Classic violet portal
    this.gateGlow = L && L.layout ? [['#62c8ff', '#d4f4ff'], ['#ff5a4a', '#ffc4a8']] : [['#b06bff', '#7dff5a'], ['#5ab8ff', '#c8f0ff']];
    this.cache = null; this.dpr = 1; this.vw = 1; this.vh = 1;
    this.pool = []; this.items = [];   // reused depth-sort records
    this.banners = new Map();          // slot (+ 'd' when out) -> banner sprite in that player's colour
  }

  // ---------------------------------------------------------------- props
  // manifest.lane.layout (lane-local {type, x, y, flip}) or, until the lane art exists, a border of the Classic props.
  // Still props north of the lane (y < 0) that stay inside the band are baked into the cached ground; the rest (and
  // every prop with effect points: braziers, the gates, and the banners, which take each lane owner's colour) are
  // depth-sorted with the towers and creeps every frame. The lane art is never mirrored: its shadows are baked in.
  buildProps() {
    const L = this.man.lane, M = this.man.props, art = !!(L && Array.isArray(L.layout));
    const layout = art ? L.layout : fallbackLayout(M);
    const cloth = M.lane_banner_cloth && M.lane_banner_cloth.img ? M.lane_banner_cloth : null;
    const list = [];
    const darks = new Map();
    for (const p of layout) {
      const m = M[p.type];
      if (!m || !m.img) continue;
      if (!darks.has(m)) darks.set(m, darkened(m));
      const box = [sx(p.x) - m.ax * K, sy(p.y) - m.ay * K, m.w * K, m.h * K];
      const animated = !!(m.fx && m.fx.length), banner = !!cloth && p.type === 'lane_banner';
      list.push({ m, dark: darks.get(m), x: p.x, y: p.y, flip: !art && !!p.flip, key: p.y, box, animated, banner,
        baked: !animated && !banner && p.y < 0 && box[1] >= GY0 - 1 });
    }
    list.sort(byKey);
    return list;
  }
  // The banner in a player's colour: the white cloth (lane_banner_cloth, the same frame as lane_banner) multiplied by
  // the colour and masked to the cloth's own alpha, over the pole with its gold band and emblem. Darkened when out.
  banner(slot, out) {
    const key = out ? slot + 'd' : slot;
    let b = this.banners.get(key);
    if (!b) {
      if (out) b = darkened(this.banner(slot, false));
      else {
        const M = this.man.props, m = M.lane_banner, cl = M.lane_banner_cloth, q = m.ss, w = m.w * q, h = m.h * q;
        const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h);
        const x = c.getContext('2d');
        x.drawImage(cl.img, cl.sx, cl.sy, cl.w * cl.ss, cl.h * cl.ss, 0, 0, w, h);
        x.globalCompositeOperation = 'multiply'; x.fillStyle = PLAYER_HEX[slot] || '#ffffff'; x.fillRect(0, 0, w, h);
        x.globalCompositeOperation = 'destination-in'; x.drawImage(cl.img, cl.sx, cl.sy, cl.w * cl.ss, cl.h * cl.ss, 0, 0, w, h);
        x.globalCompositeOperation = 'destination-over'; x.drawImage(m.img, m.sx, m.sy, w, h, 0, 0, w, h);
        b = { img: c, sx: 0, sy: 0, w: m.w, h: m.h, ax: m.ax, ay: m.ay, ss: q };
      }
      this.banners.set(key, b);
    }
    return b;
  }

  resize(cssW, cssH) {
    this.dpr = pixelRatio();
    this.vw = Math.max(0, Math.floor(cssW)); this.vh = Math.max(0, Math.floor(cssH));
    this.canvas.style.width = this.vw + 'px';
    this.canvas.style.height = this.vh + 'px';
    this.canvas.width = Math.round(this.vw * this.dpr);
    this.canvas.height = Math.round(this.vh * this.dpr);
    this.scale = this.dpr;
  }

  // ---------------------------------------------------------------- the cached ground
  // Device px per logical px of the cache: the view's, capped at the art's own (96 px per tile, the light art's 48) and
  // the device's canvas budget.
  groundCache(s, zooming) {
    const cs = canvasScale(GX1 - GX0, GY1 - GY0, Math.min(this.res, s));
    if (this.cache && (Math.abs(this.cache.cs - cs) < 1e-6 || zooming)) return this.cache;
    const c = document.createElement('canvas');
    c.width = Math.ceil((GX1 - GX0) * cs); c.height = Math.ceil((GY1 - GY0) * cs);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.setTransform(cs, 0, 0, cs, -GX0 * cs, -GY0 * cs);
    const L = this.man.lane;
    if (L && L.ground && L.ground.img) {
      x.drawImage(L.ground.img, sx(L.x0 ?? LANE_X0), sy(L.y0 ?? LANE_Y0), ((L.x1 ?? LANE_X1) - (L.x0 ?? LANE_X0)) * P, sy(L.y1 ?? LANE_Y1) - sy(L.y0 ?? LANE_Y0));
    } else this.paintFallback(x, cs);
    for (const p of this.props) if (p.baked) this.sprite(x, p.m, sx(p.x), sy(p.y), p.flip);
    this.cache = { canvas: c, cs, dark: null, version: (this.cache ? this.cache.version : 0) + 1 };
    return this.cache;
  }
  // The same ground greyed and darkened for eliminated lanes, composed once per zoom instead of blended every frame.
  darkGround(cache) {
    if (!cache.dark) {
      const c = document.createElement('canvas'); c.width = cache.canvas.width; c.height = cache.canvas.height;
      const x = c.getContext('2d');
      x.drawImage(cache.canvas, 0, 0);
      x.globalCompositeOperation = 'saturation'; x.fillStyle = '#808080'; x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'source-over'; x.fillStyle = 'rgba(6,8,12,0.5)'; x.fillRect(0, 0, c.width, c.height);
      cache.dark = c;
    }
    return cache.dark;
  }

  // A stand-in lane from Classic ground cut-outs: forest floor borders, a grass field with a faint tile grid, stone
  // kerbs, and stone platforms with rune circles in the spawn and exit zones.
  paintFallback(x, cs) {
    const ground = this.man.ground;
    const forest = mirrorPattern(x, ground, 420, 12, 1300, 180), grass = mirrorPattern(x, ground, 480, 380, 960, 190);
    x.fillStyle = forest; x.fillRect(GX0, GY0, GX1 - GX0, GY1 - GY0);
    const fx0 = sx(SPAWN_U), fx1 = sx(EXIT_U), fy0 = sy(0), fy1 = sy(LANE_ROWS);
    x.fillStyle = grass; x.fillRect(fx0, fy0, fx1 - fx0, fy1 - fy0);
    // lighter grass towards the middle of the field, darker at the kerbs
    let g = x.createLinearGradient(0, fy0, 0, fy1);
    g.addColorStop(0, 'rgba(0,0,0,0.22)'); g.addColorStop(0.18, 'rgba(0,0,0,0)'); g.addColorStop(0.82, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
    x.fillStyle = g; x.fillRect(fx0, fy0, fx1 - fx0, fy1 - fy0);
    // the tile grid
    x.lineWidth = 1 / cs;
    x.strokeStyle = 'rgba(10,22,4,0.22)';
    x.beginPath();
    for (let c = SPAWN_U + 1; c < EXIT_U; c++) { x.moveTo(sx(c), fy0); x.lineTo(sx(c), fy1); }
    for (let r = 1; r < LANE_ROWS; r++) { x.moveTo(fx0, sy(r)); x.lineTo(fx1, sy(r)); }
    x.stroke();
    x.strokeStyle = 'rgba(220,255,170,0.07)';
    x.beginPath();
    for (let c = SPAWN_U + 1; c < EXIT_U; c++) { x.moveTo(sx(c) + 1 / cs, fy0); x.lineTo(sx(c) + 1 / cs, fy1); }
    for (let r = 1; r < LANE_ROWS; r++) { x.moveTo(fx0, sy(r) + 1 / cs); x.lineTo(fx1, sy(r) + 1 / cs); }
    x.stroke();
    // stone platforms: spawn (u 0-2) and exit (u 42-44)
    const rnd = mulberry32(77);
    for (const [u0, u1, rune] of [[0, SPAWN_U, '#b06bff'], [EXIT_U, EXIT_U + 2, '#5ab8ff']]) {
      for (let r = 0; r < LANE_ROWS; r++) for (let c = u0; c < u1; c++) {
        const v = 78 + Math.floor(rnd() * 16);
        x.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
        x.fillRect(sx(c), sy(r), P, sy(r + 1) - sy(r));
        x.fillStyle = 'rgba(255,245,220,0.10)'; x.fillRect(sx(c), sy(r), P, 2);
        x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(sx(c), sy(r + 1) - 2, P, 2); x.fillRect(sx(c + 1) - 2, sy(r), 2, sy(r + 1) - sy(r));
      }
      const cx = sx((u0 + u1) / 2), cy = sy(LANE_ROWS / 2);
      x.save(); x.translate(cx, cy); x.scale(1, SIN);
      for (const [rad, w, a] of [[0.95, 3, 0.55], [0.72, 1.5, 0.4], [0.35, 1.5, 0.3]]) {
        x.beginPath(); x.arc(0, 0, rad * P, 0, Math.PI * 2); x.lineWidth = w; x.strokeStyle = hexA(rune, a); x.stroke();
      }
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        x.fillStyle = hexA(rune, 0.6);
        x.fillRect(Math.cos(a) * 0.84 * P - 2, Math.sin(a) * 0.84 * P - 2, 4, 4);
      }
      x.restore();
    }
    // kerbs along both edges of the lane and the band edges that separate stacked lanes
    for (const r of [0, LANE_ROWS]) {
      const Y = sy(r);
      x.fillStyle = '#3a352c'; x.fillRect(sx(0), Y - 4, sx(EXIT_U + 2) - sx(0), 8);
      x.fillStyle = 'rgba(255,240,200,0.18)'; x.fillRect(sx(0), Y - 4, sx(EXIT_U + 2) - sx(0), 1.5);
      x.fillStyle = 'rgba(0,0,0,0.45)'; x.fillRect(sx(0), Y + 3, sx(EXIT_U + 2) - sx(0), 1.5);
    }
    for (const [Y0, Y1] of [[GY0, GY0 + P * 0.6], [GY1, GY1 - P * 0.6]]) {
      g = x.createLinearGradient(0, Y0, 0, Y1);
      g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(GX0, Math.min(Y0, Y1), GX1 - GX0, Math.abs(Y1 - Y0));
    }
  }

  // ---------------------------------------------------------------- cheap primitives for crowded lanes
  blob(ctx, X, Y, rx, a = 0.3) {
    BLOB ||= makeBlob();
    const ry = rx * SIN * 0.75;
    ctx.globalAlpha = a;
    ctx.drawImage(BLOB, X - rx, Y - ry, rx * 2, ry * 2);
    ctx.globalAlpha = 1;
  }
  glow(ctx, X, Y, r, color, a = 0.7) {
    const op = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    this.glowAdd(ctx, X, Y, r, color, a);
    ctx.globalCompositeOperation = op; ctx.globalAlpha = 1;
  }
  healthBar(ctx, c) {
    const { m, k: ck } = this.look(c.def), X = sx(c.x), Y = sy(c.y);
    this.hpBar(ctx, X, Y - m.ay * ck - 5, Math.max(22, Math.min(46, m.fw * ck * 0.75)), Math.max(0, c.hp / c.maxHp));
  }
  // a tower that attackers have hurt (phase 3), over its roof
  towerBar(ctx, tw) {
    const m = this.man.towers[tw.def.id];
    this.hpBar(ctx, sx(tw.x), sy(tw.y) - m.ay * TK - 2, P * 0.7, Math.max(0, tw.hp / tw.maxHp));
  }
  hpBar(ctx, X, top, w, k) {
    ctx.fillStyle = 'rgba(8,6,4,0.9)'; ctx.fillRect(X - w / 2 - 1.5, top - 1.5, w + 3, 6);
    ctx.fillStyle = 'rgba(60,20,16,0.85)'; ctx.fillRect(X - w / 2, top, w, 3);
    ctx.fillStyle = k > 0.6 ? '#3cc02a' : k > 0.3 ? '#d8b020' : '#d03a20'; ctx.fillRect(X - w / 2, top, w * k, 3);
    ctx.fillStyle = k > 0.6 ? '#9cff7a' : k > 0.3 ? '#fff08a' : '#ff9a7a'; ctx.fillRect(X - w / 2, top, w * k, 1);
  }
  timeBar(ctx, tw, k, color) {
    const X = sx(tw.x), Y = sy(tw.y) + 6, w = P * 0.7;
    ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(X - w / 2 - 1, Y - 1, w + 2, 5);
    ctx.fillStyle = color; ctx.fillRect(X - w / 2, Y, w * Math.max(0, Math.min(1, k)), 3);
  }
  drawCreep(ctx, c, lane, t, fx) {
    const { m, k } = this.look(c.def), X = sx(c.x), Y = sy(c.y);
    const { row, flip } = this.creepDir(c);
    const hidden = c.def.invisible && !lane.visible(c);
    if (c.reviving) {   // lying dead until it reincarnates: a faded, still body that firms up as the time comes
      const left = Math.max(0, Math.min(1, (c.reviveAt - lane.time) / ((c.def.reincarnation && c.def.reincarnation.delay) || 7)));
      this.frame(ctx, m, m.img, 0, row, X, Y, flip, (0.3 + 0.4 * (1 - left)) * (hidden ? 0.4 : 1), k);
      return;
    }
    const col = Math.floor(c.walk * 1.7) % m.frames;
    let slowed = (c.slowUntil > lane.time && c.slowPct > 0) || c.auraSlow > 0;
    if (!slowed) for (const p of c.poisons) if (p.slow) { slowed = true; break; }
    const hit = fx.hitFlash.get(c.id);
    const look = hit !== undefined && fx.t - hit < 0.06 ? tinted(m, 'hit') : slowed ? tinted(m, 'slow') : m;
    this.frame(ctx, look, look.img, col, row, X, Y, flip, hidden ? 0.28 : 1, k);
    if (c.stunUntil > lane.time) {
      const top = Y - m.ay * k - 4;
      ctx.fillStyle = '#ffe36b';
      for (let i = 0; i < 3; i++) {
        const a = t * 6 + i * 2.1;
        ctx.beginPath(); ctx.arc(X + Math.cos(a) * 9, top + Math.sin(a) * 3, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // ---------------------------------------------------------------- frame
  // Which stacked lanes (indices) the camera can see, sprites reaching up from the lane below included.
  visibleRange(cam, n) {
    const [, ry0, , ry1] = cam.rect();
    const i0 = Math.max(0, Math.floor((ry0 - GY1) / BAND) + 1);
    const i1 = Math.min(n - 1, Math.floor((ry1 + REACH - GY0) / BAND));
    return [i0, i1];
  }

  // world: the session's world model; order: lane slots top to bottom; view: selection, hover and placement state;
  // fxs: slot -> FX; t: animation clock.
  draw(world, order, cam, view, fxs, t) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = DARK; ctx.fillRect(0, 0, W, H);
    if (!W || !H) return;
    const s = cam.zoom * this.dpr;
    const tx = Math.round(W / 2 - cam.x * s), ty = Math.round(H / 2 - cam.y * s);
    const [i0, i1] = this.visibleRange(cam, order.length);
    const rect = cam.rect();
    const cache = this.groundCache(s, cam.zooming || cam.live);
    const k = s / cache.cs;
    // 1. ground of every lane in view, and the world around them
    for (let i = i0; i <= i1; i++) {
      const X = Math.round(tx + GX0 * s), Y = Math.round(ty + (laneDY(i) + GY0) * s);
      const p = world.players[order[i]];
      ctx.drawImage(p.alive ? cache.canvas : this.darkGround(cache), X, Y, cache.canvas.width * k, cache.canvas.height * k);
      if (i === 0) {   // the forest floor past a south kerb, once more above the first lane (the art tiles there)
        const y0 = (sy(FRINGE) - GY0) * cache.cs, h = cache.canvas.height - y0;
        ctx.drawImage(p.alive ? cache.canvas : this.darkGround(cache), 0, y0, cache.canvas.width, h, X, Y - h * k, cache.canvas.width * k, h * k);
      }
      ctx.setTransform(s, 0, 0, s, tx, ty + laneDY(i) * s);
      this.gates(ctx, t, p.alive, false);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.setTransform(s, 0, 0, s, tx, ty);
    this.edges(ctx, order.length, rect);
    // 2. each lane's ground marks and depth-sorted sprites, north to south
    const shadows = !this.man.light || cam.zoom * P >= SHADOWS_FROM;
    for (let i = i0; i <= i1; i++) {
      ctx.setTransform(s, 0, 0, s, tx, ty + laneDY(i) * s);
      this.drawLane(ctx, world, order[i], i, rect, view, fxs[order[i]], t, shadows);
    }
    // 3. missiles, particles, health and progress bars, floating text
    for (let i = i0; i <= i1; i++) {
      ctx.setTransform(s, 0, 0, s, tx, ty + laneDY(i) * s);
      if (world.players[order[i]].alive) this.gates(ctx, t, true, true);
      this.drawAirLane(ctx, world.lanes[order[i]], i, rect, fxs[order[i]], cam.level === 0);
    }
    // 4. name plates, in screen space so they stay readable at every zoom
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (let i = i0; i <= i1; i++) this.plate(ctx, world, order[i], i, cam, view);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // The lane art fades into the dark at its west and east ends, north of the first lane's fringe and south of the
  // last lane, as the map's boundary does (props drawn later stand over it). Gradients are in world px, so they are
  // made once per stack height.
  edges(ctx, n, rect) {
    let f = this.fades;
    if (!f || f.n !== n) {
      const top = GY0 - (GY1 - sy(FRINGE)), bot = laneDY(n - 1) + GY1, x = this.ctx;
      const grad = (x0, y0, x1, y1) => { const g = x.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, hexA(DARK, 1)); g.addColorStop(1, hexA(DARK, 0)); return g; };
      f = this.fades = { n, top, bot, north: grad(0, top, 0, GY0 - P * 0.2), south: grad(0, bot, 0, bot - P * 0.7), west: grad(GX0, 0, GX0 + FADE, 0), east: grad(GX1, 0, GX1 - FADE, 0) };
    }
    const [x0, y0, x1, y1] = rect, ya = Math.max(y0, f.top), yb = Math.min(y1, f.bot);
    if (y0 < GY0) { ctx.fillStyle = f.north; ctx.fillRect(x0, f.top, x1 - x0, GY0 - f.top); }
    if (y1 > f.bot - P) { ctx.fillStyle = f.south; ctx.fillRect(x0, f.bot - P * 0.7, x1 - x0, P * 0.7); }
    if (yb <= ya) return;
    if (x0 < GX0 + FADE) { ctx.fillStyle = f.west; ctx.fillRect(GX0, ya, FADE, yb - ya); }
    if (x1 > GX1 - FADE) { ctx.fillStyle = f.east; ctx.fillRect(GX1 - FADE, ya, FADE, yb - ya); }
  }

  // Waygate and portal glows: a pool of light on the ground under them, and (air pass) a pulse in the gate itself
  // at the height manifest.lane gives (`z`), drawn over the gate sprite.
  gates(ctx, t, alive, air) {
    const a = alive ? 1 : 0.35, [[s1, s2], [e1, e2]] = this.gateGlow;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [p, c1, c2, ph] of [[this.spawnAt, s1, s2, 0], [this.exitAt, e1, e2, 1.7]]) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 + ph);
      if (air) {
        if (!p.z) continue;
        const X = sx(p.x), Y = sy(p.y, p.z);
        this.glowAdd(ctx, X, Y, P * 0.95, c1, (0.22 + 0.1 * pulse) * a);
        this.glowAdd(ctx, X, Y, P * 0.4, c2, (0.18 + 0.12 * pulse) * a);
        continue;
      }
      ctx.save(); ctx.translate(sx(p.x), sy(p.y)); ctx.scale(1, SIN);
      this.glowAdd(ctx, 0, 0, P * 1.5, c1, (0.32 + 0.12 * pulse) * a);
      this.glowAdd(ctx, 0, 0, P * 0.7, c2, (0.16 + 0.1 * pulse) * a);
      ctx.restore();
    }
    ctx.restore();
  }
  // a prop's effect points (braziers, gate orbs), animated like tower effects
  propFx(ctx, p, t) {
    const m = p.m, X0 = sx(p.x), Y0 = sy(p.y), dir = p.flip ? -1 : 1;
    for (const f of m.fx) {
      const X = X0 + dir * (f.px - m.ax) * K, Y = Y0 + (f.py - m.ay) * K;
      const ph = t * 2.6 + p.x * 1.7, s = f.size || 1;
      if (f.kind === 'flame') drawFlame(ctx, X, Y, 10 * s, 18 * s, t + p.x);
      else if (f.kind === 'orb') this.glow(ctx, X, Y, (9 + 2.5 * Math.sin(ph)) * s, f.color, 0.75);
      else if (f.kind === 'wisp') { const bob = Math.sin(ph * 0.8) * 3; this.glow(ctx, X, Y + bob, 18 * s, f.color, 0.6); this.glow(ctx, X, Y + bob, 6 * s, '#ffffff', 0.95); }
      else if (f.kind !== 'muzzle') this.glow(ctx, X, Y, 10 * s, f.color, 0.3 + 0.1 * Math.sin(ph));
    }
  }

  addItem(n, key, kind, o) {
    let it = this.pool[n];
    if (!it) it = this.pool[n] = { key: 0, kind: 0, o: null };
    it.key = key; it.kind = kind; it.o = o;
    return n + 1;
  }

  // shadows: the contact shadows under towers and creeps (the light set leaves them out in a far view)
  drawLane(ctx, world, slot, i, rect, view, fx, t, shadows = true) {
    const lane = world.lanes[slot];
    const dy = laneDY(i);
    // visible lane-local window (tiles), padded for sprite overhang
    const ux0 = rect[0] / P - 2, ux1 = rect[2] / P + 2;
    const vy0 = ((rect[1] - dy) / P - TOP) / SIN - 0.6, vy1 = ((rect[3] - dy + REACH) / P - TOP) / SIN + 0.6;
    const vis = (o) => o.x >= ux0 && o.x <= ux1 && o.y >= vy0 && o.y <= vy1;
    const box = [rect[0], rect[1] - dy, rect[2] - rect[0], rect[3] - rect[1] + REACH];

    const mine = slot === view.me;
    if (mine && view.placing) this.drawGrid(ctx, lane, view);
    if (fx) fx.drawGround(ctx);

    const sel = view.sel && view.sel.slot === slot && !view.sel.away ? view.sel.o : null;   // away: between two lanes
    const hov = view.hoverTower && view.hoverSlot === slot ? view.hoverTower : null;
    if (sel && sel.def.range) this.ring(ctx, sx(sel.x), sy(sel.y), sel.def.range / TILE * P, 'rgba(255,255,255,0.55)', 1.5, [6, 5], 'rgba(255,255,255,0.05)');
    if (hov && hov !== sel) this.ring(ctx, sx(hov.x), sy(hov.y), hov.def.range / TILE * P, 'rgba(255,255,255,0.25)', 1, [4, 6]);

    if (shadows) {
      for (const tw of lane.towers) if (vis(tw)) this.blob(ctx, sx(tw.x) + 1, sy(tw.y) + 1, P * 0.42, 0.14);
      for (const c of lane.creeps) if (vis(c)) this.blob(ctx, sx(c.x) + 1, sy(c.y) + 1, P * (c.def.flying ? 0.16 : 0.2), c.def.flying ? 0.12 : 0.16);
    }
    this.auraRings(ctx, lane, vis, t);
    if (sel) {
      if (sel.def.upgrades || sel.def.tech) this.selection(ctx, sx(sel.x), sy(sel.y), P * 0.5, sel.owner === view.me ? '#5aff4a' : '#ffd84a');
      else this.selection(ctx, sx(sel.x), sy(sel.y), P * (sel.def.flying ? 0.3 : 0.34), '#ff4a3a');
      // what a selected attacker is hitting (phase 3): a tower in this lane, or another player's creep, ringed in
      // broken orange so it reads apart from the attacker's own red ring
      const tg = sel.attacking;
      if (tg && !tg.dead && !tg.destroyed && (lane.towers.includes(tg) || lane.creeps.includes(tg))) {
        this.selection(ctx, sx(tg.x), sy(tg.y), P * (tg.def.upgrades ? 0.46 : 0.3), '#ff9a2a', [5, 4]);
      }
    }

    let n = 0;
    for (const tw of lane.towers) if (vis(tw)) n = this.addItem(n, tw.y, 1, tw);
    for (const c of lane.creeps) if (vis(c)) n = this.addItem(n, c.y + 0.001, 2, c);
    if (fx) for (const d of fx.corpses) if (vis(d)) n = this.addItem(n, d.y, 3, d);
    for (const s of techArea(world.players[slot])) if (vis(s)) n = this.addItem(n, s.y, s.id ? 5 : 6, s);
    const out = !world.players[slot].alive;
    for (const p of this.props) if (!p.baked && overlap(p.box, box)) n = this.addItem(n, p.key, out ? 4 : 0, p);
    const items = this.items;
    items.length = 0;
    for (let k = 0; k < n; k++) items.push(this.pool[k]);
    items.sort(byKey);
    for (const it of items) {
      if (it.kind === 1) this.drawTowerLtw(ctx, it.o, lane, t);
      else if (it.kind === 2) this.drawCreep(ctx, it.o, lane, t, fx);
      else if (it.kind === 3) fx.drawCorpse(ctx, it.o, this);
      else if (it.kind === 5 || it.kind === 6) this.drawTech(ctx, it.o, t);
      else if (it.o.banner) this.sprite(ctx, this.banner(slot, it.kind === 4), sx(it.o.x), sy(it.o.y));
      else if (it.kind === 4) this.sprite(ctx, it.o.dark, sx(it.o.x), sy(it.o.y), it.o.flip);
      else { this.sprite(ctx, it.o.m, sx(it.o.x), sy(it.o.y), it.o.flip); if (it.o.animated) this.propFx(ctx, it.o, t); }
    }
    if (mine && view.placing && view.hover && view.hover.slot === slot) this.drawGhost(ctx, lane, view);
  }

  // WC3's selection circle: a solid ring in the selection's own colour (green yours, red an enemy creep, yellow another
  // player's tower) over a dark edge, blended normally so red stays red on the green lane (an additive blend turns it
  // orange). dash: a broken ring (an attacker's target).
  selection(ctx, X, Y, r, color, dash = null) {
    ctx.save();
    if (dash) ctx.setLineDash(dash);
    for (const [w, c] of [[4.2, 'rgba(0,0,0,0.45)'], [3.2, hexA(color, 0.35)], [1.7, hexA(color, 0.95)]]) {
      ctx.beginPath(); ctx.ellipse(X, Y, r, r * SIN, 0, 0, Math.PI * 2);
      ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke();
    }
    ctx.restore();
  }
  // The aura rings of a lane's creeps in view (one path per colour), breathing slowly.
  auraRings(ctx, lane, vis, t) {
    let paths = null;
    for (const c of lane.creeps) {
      if (c.reviving || !vis(c) || !(c.moveBonus > 0 || c.regenBonus > 0 || c.regenPct > 0 || c.dmgBonus > 0)) continue;
      if (c.def.invisible && !lane.visible(c)) continue;
      paths ||= AURA_RINGS.map(() => new Path2D());
      const X = sx(c.x), Y = sy(c.y), r0 = P * (c.def.flying ? 0.2 : 0.26);
      let k = 0;
      AURA_RINGS.forEach(([field], i) => {
        if (!(c[field] > 0)) return;
        const r = r0 + k++ * P * 0.06;
        paths[i].moveTo(X + r, Y); paths[i].ellipse(X, Y, r, r * SIN, 0, 0, Math.PI * 2);
      });
    }
    if (!paths) return;
    ctx.save();
    ctx.lineWidth = 1.6; ctx.globalAlpha = 0.6 + 0.2 * Math.sin(t * 2.2);
    AURA_RINGS.forEach(([, color], i) => { ctx.strokeStyle = color; ctx.stroke(paths[i]); });
    ctx.restore();
  }

  // A tech building (props tech_<id>) or an unspent wisp (lane_wisp, floating) in the tech area.
  drawTech(ctx, s, t) {
    const M = this.man.props, m = s.id ? M['tech_' + s.id] : M.lane_wisp;
    if (!m || !m.img) return;
    const X = sx(s.x), Y = sy(s.y);
    if (s.id) {
      this.blob(ctx, X + 1, Y + 1, P * 0.4, 0.16);
      this.sprite(ctx, m, X, Y);
      if (m.fx && m.fx.length) this.propFx(ctx, { m, x: s.x, y: s.y, flip: false }, t);
      return;
    }
    // the wisp hovers with the bob propFx gives its glow
    const bob = Math.sin((t * 2.6 + s.x * 1.7) * 0.8) * 3;
    this.blob(ctx, X, Y + 1, P * 0.18, 0.12);
    this.sprite(ctx, m, X, Y + bob - 4);
    if (m.fx && m.fx.length) this.propFx(ctx, { m, x: s.x, y: s.y - 4 / (P * SIN), flip: false }, t);
  }
  // The sprite box of a tech area spot (logical px, lane-local), for picking.
  techBox(s) {
    const M = this.man.props, m = s.id ? M['tech_' + s.id] : M.lane_wisp;
    if (!m) return [sx(s.x) - P / 2, sy(s.y) - P, P, P];
    return [sx(s.x) - m.ax * K, sy(s.y) - m.ay * K, m.w * K, m.h * K];
  }

  drawTowerLtw(ctx, tw, lane, t) {
    if (tw.sellAt !== undefined) {   // being sold: fades out over the sell delay
      ctx.save(); ctx.globalAlpha = 0.45 + 0.4 * Math.max(0, Math.min(1, (tw.sellAt - lane.time)));
      this.drawTower(ctx, tw, lane, t); ctx.restore();
      return;
    }
    this.drawTower(ctx, tw, lane, t);
  }

  // far: the farthest zoom, where only damaged creeps get a health bar (full bars over a crowd are just noise)
  drawAirLane(ctx, lane, i, rect, fx, far = false) {
    const dy = laneDY(i);
    const ux0 = rect[0] / P - 2, ux1 = rect[2] / P + 2;
    const vy0 = ((rect[1] - dy) / P - TOP) / SIN - 0.6, vy1 = ((rect[3] - dy + REACH) / P - TOP) / SIN + 0.6;
    if (fx) fx.drawAir(ctx, this);
    for (const c of lane.creeps) {
      if (c.x < ux0 || c.x > ux1 || c.y < vy0 || c.y > vy1) continue;
      if ((far && c.hp >= c.maxHp) || c.reviving || (c.def.invisible && !lane.visible(c))) continue;
      this.healthBar(ctx, c);
    }
    for (const tw of lane.towers) {
      if (tw.x < ux0 || tw.x > ux1 || tw.y < vy0 || tw.y > vy1) continue;
      if (tw.sellAt !== undefined) this.timeBar(ctx, tw, (tw.sellAt - lane.time), '#ff9a4a');
      else if (tw.building > 0) this.timeBar(ctx, tw, 1 - tw.building / (tw.buildTotal || 1), '#e8c05a');
      else if (tw.hp < tw.maxHp) this.towerBar(ctx, tw);
    }
    if (fx) fx.drawTexts(ctx);
  }

  drawGrid(ctx, lane, view) {
    const h = view.hover;
    if (!h || h.slot !== view.me) return;
    for (let r = 0; r < LANE_ROWS; r++) for (let c = SPAWN_U; c < EXIT_U; c++) {
      const near = Math.max(Math.abs(c - h.c), Math.abs(r - h.r));
      if (near > 4) continue;
      const ok = !lane.towerAt(c, r);
      const a = near === 0 ? 0.42 : 0.16 * (1 - near / 5);
      ctx.fillStyle = ok ? `rgba(90,255,80,${a})` : `rgba(255,70,50,${a})`;
      const Y0 = sy(r), Y1 = sy(r + 1);
      ctx.fillRect(c * P + 1, Y0 + 1, P - 2, Y1 - Y0 - 2);
    }
  }

  drawGhost(ctx, lane, view) {
    const def = view.placing, h = view.hover;
    const m = this.man.towers[def.id];
    const X = sx(h.c + 0.5), Y = sy(h.r + 0.5);
    const ok = h.why === null;
    this.ring(ctx, X, Y, def.range / TILE * P, ok ? 'rgba(160,255,140,0.8)' : 'rgba(255,120,100,0.8)', 1.5, [6, 5], ok ? 'rgba(120,255,100,0.06)' : 'rgba(255,80,60,0.06)');
    ctx.save(); ctx.globalAlpha = 0.6; this.sprite(ctx, m, X, Y, false, null, TK); ctx.restore();
    if (!ok) { ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = '#ff3020'; ctx.fillRect(h.c * P + 2, sy(h.r) + 2, P - 4, sy(h.r + 1) - sy(h.r) - 4); ctx.restore(); }
  }

  // The lane owner's name plate at the spawn end (kept inside the view while any of the lane shows), and a banner
  // over eliminated lanes. view.insets keeps it clear of the top bar and the console ornaments that overlap the view's
  // edges, view.avoid (css px rect, the map messages) is stepped around to the right, and the build phase's timer
  // window (view.timer, css px rect) by going under it, or past it where the lane has no room below it.
  plate(ctx, world, slot, i, cam, view) {
    const p = world.players[slot];
    const at = cam.toScreen(sx(LANE_X0 + 0.15), laneDY(i) + sy(LANE_Y0 + 0.3));
    const bottom = cam.toScreen(0, laneDY(i) + sy(LANE_ROWS)).y;
    const role = slot === view.me ? 'Your lane' : slot === view.target ? 'Your creeps go here' : slot === view.feeder ? 'Sends creeps to you' : '';
    const name = p.name + (p.kind === 'bot' && p.difficulty && !botNamed(p) ? ` · ${p.difficulty[0].toUpperCase()}${p.difficulty.slice(1)}` : '');
    const hgt = role ? 34 : 22;
    const top = view.insets ? view.insets.top : 6, floor = this.vh - (view.insets ? view.insets.bottom : 6);
    ctx.font = "800 13px 'Alegreya Sans', sans-serif";
    let w = ctx.measureText(name).width;
    ctx.font = "600 11px 'Alegreya Sans', sans-serif";
    if (role) w = Math.max(w, ctx.measureText(role).width);
    w += 30;
    let x = Math.max(6, at.x), y = Math.min(Math.max(top, at.y), bottom - hgt);
    const t = view.timer;
    if (t && x < t[2] && t[0] < x + w && y < t[3] && t[1] < y + hgt) {
      if (t[3] + 4 + hgt <= bottom) y = t[3] + 4; else x = t[2] + 8;
    }
    if (y + hgt <= floor) {   // only the lane's north border shows: no plate under the console
      const a = view.avoid;
      if (a && x < a[2] && a[0] < x + w && y < a[3] && a[1] < y + hgt) x = a[2] + 8;
      this.namePlate(ctx, slot, name, role, x, y, w, hgt);
    }
    if (!p.alive) {
      const c = cam.toScreen(sx(22), laneDY(i) + sy(LANE_ROWS / 2));
      const text = p.label ? `${p.name} was ${p.label.toLowerCase()}` : p.left ? `${p.name} has left` : `${p.name} is out`;
      ctx.textAlign = 'center'; ctx.font = "900 26px 'Cinzel', serif";
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(text, c.x, c.y);
      ctx.fillStyle = 'rgba(220,206,180,0.75)'; ctx.fillText(text, c.x, c.y);
      ctx.textAlign = 'left';
    }
  }
  namePlate(ctx, slot, name, role, x, y, w, hgt) {
    ctx.fillStyle = 'rgba(8,7,5,0.72)'; ctx.fillRect(x, y, w, hgt);
    ctx.fillStyle = 'rgba(232,192,90,0.5)'; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y + hgt - 1, w, 1);
    ctx.fillStyle = PLAYER_HEX[slot]; ctx.fillRect(x + 7, y + 6, 10, 10);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(x + 7.5, y + 6.5, 9, 9);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = "800 13px 'Alegreya Sans', sans-serif"; ctx.fillStyle = PLAYER_TEXT[slot];
    ctx.fillText(name, x + 23, y + 11.5);
    if (role) { ctx.font = "600 11px 'Alegreya Sans', sans-serif"; ctx.fillStyle = '#b9ad94'; ctx.fillText(role, x + 23, y + 25); }
  }

  // ---------------------------------------------------------------- picking
  // X, Y: logical world px. Returns { slot, i, c, r, creep, tower, tech } for the lane under the point (tech: a spot of
  // the tech area, { id (null for a wisp), x, y }).
  pickAt(world, order, X, Y) {
    const yw = (Y / P - TOP) / SIN, i = Math.floor((yw - LANE_Y0) / LANE_PITCH);
    if (i < 0 || i >= order.length) return null;
    const slot = order[i], lane = world.lanes[slot];
    const lv = yw - i * LANE_PITCH, c = Math.floor(X / P), r = Math.floor(lv);
    const out = { slot, i, c, r, creep: null, tower: null };
    // creeps of this lane and of the lane below (their sprites reach up into this band)
    let bd = 1e9;
    for (let j = i; j <= Math.min(order.length - 1, i + 1); j++) {
      const L = world.lanes[order[j]], ly = Y - laneDY(j);
      for (const k of L.creeps) {
        if (k.def.invisible && !L.visible(k)) continue;
        const { X: cx, Y: cy } = this.creepCenter(k), { m, k: ck } = this.look(k.def);
        const d = Math.hypot(X - cx, ly - cy);
        if (d < Math.max(14, m.fw * ck * 0.45) && d < bd) { bd = d; out.creep = k; out.creepSlot = order[j]; }
      }
    }
    if (out.creep) return out;
    if (r >= 0 && r < LANE_ROWS) { const tw = lane.towerAt(c, r); if (tw) { out.tower = tw; out.towerSlot = slot; return out; } }
    // the body of a tall tower standing a row or two south of the cursor, possibly in the next lane
    for (let dr = 1; dr <= 3; dr++) {
      const wy = Math.floor(yw) + dr, j = Math.floor((wy - LANE_Y0) / LANE_PITCH);
      if (j < 0 || j >= order.length) continue;
      const v = wy - j * LANE_PITCH;
      if (v < 0 || v >= LANE_ROWS) continue;
      const tw = world.lanes[order[j]].towerAt(c, v);
      if (tw && overlap([X, Y - laneDY(j), 1, 1], this.towerBox(tw))) { out.tower = tw; out.towerSlot = order[j]; return out; }
    }
    // the tech area at the lane ends: the front-most building or wisp under the point
    const pt = [X, Y - laneDY(i), 1, 1];
    for (const s of techArea(world.players[slot])) if (overlap(pt, this.techBox(s)) && (!out.tech || s.y > out.tech.y)) out.tech = s;
    if (out.tech) out.techSlot = slot;
    return out;
  }

  // ---------------------------------------------------------------- minimap
  // logical world rect the minimap shows: every lane band
  worldRect(n) { return [GX0, GY0, GX1, laneDY(n - 1) + GY1]; }
  // Paints the lanes (ground, darkened when out) into a w x h canvas for the minimap background.
  miniBase(world, order, w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    const cache = this.cache || this.groundCache(Math.min(1, this.dpr), false);
    const [X0, Y0, X1, Y1] = this.worldRect(order.length), kx = w / (X1 - X0), ky = h / (Y1 - Y0);
    order.forEach((slot, i) => {
      const y = (laneDY(i) + GY0 - Y0) * ky, hh = (GY1 - GY0) * ky;
      x.drawImage(cache.canvas, 0, y, w, hh);
      if (!world.players[slot].alive) { x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(0, y, w, hh); }
      x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(0, Math.round(y), w, 1);
    });
    return c;
  }
}

// A canvas pattern from a rectangle (in the full art's pixels) of the Classic ground, mirrored both ways so its repeats
// have no seams, mapped from the ground's 96 px per tile to logical px.
function mirrorPattern(ctx, ground, x, y, w, h) {
  const q = ground.ss;
  x *= q; y *= q; w = Math.round(w * q); h = Math.round(h * q);
  const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2;
  const g = c.getContext('2d');
  for (const [fx, fy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    g.setTransform(fx, 0, 0, fy, fx < 0 ? w * 2 : 0, fy < 0 ? h * 2 : 0);
    g.drawImage(ground.img, x, y, w, h, 0, 0, w, h);
  }
  const p = ctx.createPattern(c, 'repeat');
  if (p.setTransform) p.setTransform(new DOMMatrix().scaleSelf(K / q, K / q));
  return p;
}

// A grey, darkened copy of one prop sprite for eliminated lanes (matches the darkened ground), as a sprite entry.
function darkened(m) {
  const q = m.ss, w = m.w * q, h = m.h * q;
  const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h);
  const x = c.getContext('2d');
  x.drawImage(m.img, m.sx, m.sy, w, h, 0, 0, w, h);
  x.globalCompositeOperation = 'saturation'; x.fillStyle = '#808080'; x.fillRect(0, 0, w, h);
  x.globalCompositeOperation = 'source-over'; x.fillStyle = 'rgba(6,8,12,0.5)'; x.fillRect(0, 0, w, h);
  x.globalCompositeOperation = 'destination-in'; x.drawImage(m.img, m.sx, m.sy, w, h, 0, 0, w, h);
  return { img: c, sx: 0, sy: 0, w: m.w, h: m.h, ax: m.ax, ay: m.ay, ss: q };
}

function makeBlob() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 3.2, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.6, 'rgba(0,0,0,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return c;
}

// Until manifest.lane exists: trees along the north border, low growth and fences on the south border, the Classic
// portal at the spawn end and ruins with lamps at the exit end. Deterministic, lane-local, never on buildable tiles.
function fallbackLayout(M) {
  const rnd = mulberry32(4242), L = [];
  const has = (k) => M[k] && M[k].img;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const trees = ['oak1', 'oak2', 'oak3', 'oak4', 'pine1', 'pine2', 'pine3', 'birch1', 'birch2'].filter(has);
  const low = ['bush1', 'bush2', 'bush3', 'rock1', 'rock2', 'rock3', 'flowers', 'shrooms', 'stump', 'logs'].filter(has);
  const small = ['bush1', 'bush2', 'bush3', 'rock1', 'rock2', 'rock3', 'flowers', 'shrooms', 'stump'].filter(has);
  if (trees.length) for (let x = -3.4; x < 47.6; x += 1.15 + rnd() * 0.75) L.push({ type: pick(trees), x, y: -1.25 - rnd() * 0.45, flip: rnd() < 0.5 });
  if (low.length) for (let x = -3.2; x < 47.6; x += 1.6 + rnd() * 2.2) L.push({ type: pick(low), x, y: -0.3 - rnd() * 0.25, flip: rnd() < 0.5 });
  if (has('fence1')) for (let x = SPAWN_U + 1; x < EXIT_U - 0.5; x += 2.0) L.push({ type: rnd() < 0.8 ? 'fence1' : 'fence2', x, y: LANE_ROWS + 0.42, flip: rnd() < 0.5 });
  if (small.length) for (let x = -3.4; x < 47.6; x += 1.3 + rnd() * 1.8) L.push({ type: pick(small), x, y: LANE_ROWS + 1.05 + rnd() * 0.75, flip: rnd() < 0.5 });
  if (has('portal')) L.push({ type: 'portal', x: -2.05, y: LANE_ROWS / 2 + 0.4, flip: false });
  if (has('ruin1')) L.push({ type: 'ruin1', x: 46.2, y: 3.2, flip: true });
  if (has('ruin2')) L.push({ type: 'ruin2', x: 46.4, y: 6.6, flip: false });
  if (has('lamp')) { L.push({ type: 'lamp', x: 44.4, y: 0.35, flip: false }); L.push({ type: 'lamp', x: 44.4, y: LANE_ROWS - 0.2, flip: false }); }
  for (const [x, y] of [[-3.3, 1.2], [-3.4, 7.3], [-0.9, 0.6], [-0.7, 7.6], [47.3, 1.0], [47.2, 5.0], [47.4, 8.0]]) if (small.length) L.push({ type: pick(small), x, y, flip: rnd() < 0.5 });
  return L;
}
