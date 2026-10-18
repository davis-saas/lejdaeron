// The camera of every mode: pan and zoom over the battlefield. It works in the logical pixels every sprite is placed in
// (src/render.js: x * P across, (y * SIN - z * COS + TOP) * P down), so the projection is exactly Classic's.
// x, y is the logical point at the centre of the view; zoom is css px per logical px. The wheel and the zoom buttons
// step between its levels (eased); a pinch zooms freely between the farthest and the closest.
import { P } from '../render.js?v=a48717ff8443';

export const ZOOMS = [26, 36, 48, 62];   // css px per tile, far to close; the farthest narrows so a whole lane fits
const EASE = 14;                         // zoom easing rate (1/s)
const WHEEL_STEP = 40, WHEEL_GAP = 140;  // wheel delta (px) for one zoom step, and ms between two steps

export class Camera {
  // levels(vw, vh): the zoom levels in css px per tile, far to close (the default is Line Tower Wars')
  constructor(levels = null) {
    this.x = 0; this.y = 0; this.vw = 1; this.vh = 1;
    this.level = 2; this.zoom = ZOOMS[2] / P; this.goal = this.zoom; this.anchor = null;
    this.bounds = [0, 0, 1, 1];
    this.padRight = 0;                   // css px the world may be panned left past its right edge (from under the scoreboard)
    this.moved = true;                   // set whenever the view changes (the minimap redraws its frame)
    this.live = false;                   // a pinch is under way (caches sized to the zoom wait for its end)
    this.wheelAcc = 0; this.wheelT = 0;   // wheel delta not yet stepped (px, its sign the way it turns), the last step (ms)
    this.wheelS = 0; this.wheelST = 0;    // the way of the last step (the sign of its deltas), the last turn that way (ms)
    if (levels) this.levels = () => levels(this.vw, this.vh);
  }
  levels() { return [Math.max(10, Math.min(ZOOMS[0], this.vw / 54)), ...ZOOMS.slice(1)]; }
  get zooming() { return Math.abs(this.zoom - this.goal) > 1e-4; }
  get far() { return this.goal <= this.levels()[0] / P + 1e-6; }
  get close() { const lv = this.levels(); return this.goal >= lv[lv.length - 1] / P - 1e-6; }
  setView(w, h) {
    this.vw = Math.max(1, w); this.vh = Math.max(1, h);
    this.goal = this.levels()[this.level] / P;
    if (!this.anchor) this.zoom = this.goal;
    this.clamp();
  }
  setBounds(x0, y0, x1, y1) { this.bounds = [x0, y0, x1, y1]; this.clamp(); }
  // The view's top-right corner is under the scoreboard: the world may then be panned that far left past its right
  // edge, so whatever stands under the board (the far end of a lane, the exit plaza) can be brought out from under it.
  setPadRight(cssPx) { this.padRight = Math.max(0, cssPx); this.clamp(); }

  // css px in the view <-> logical world px
  toWorld(mx, my) { return { X: this.x + (mx - this.vw / 2) / this.zoom, Y: this.y + (my - this.vh / 2) / this.zoom }; }
  toScreen(X, Y) { return { x: (X - this.x) * this.zoom + this.vw / 2, y: (Y - this.y) * this.zoom + this.vh / 2 }; }
  // visible logical rect [x0, y0, x1, y1]
  rect() {
    const hw = this.vw / 2 / this.zoom, hh = this.vh / 2 / this.zoom;
    return [this.x - hw, this.y - hh, this.x + hw, this.y + hh];
  }

  center(X, Y) { this.x = X; this.y = Y; this.anchor = null; this.clamp(); }
  pan(dxCss, dyCss) { if (!dxCss && !dyCss) return; this.x += dxCss / this.zoom; this.y += dyCss / this.zoom; this.clamp(); }
  // Step one zoom level in (dir > 0) or out, keeping the world point under the cursor (mx, my) in place. After a pinch
  // the zoom may lie between levels: the step goes to the next level past it.
  zoomStep(dir, mx = this.vw / 2, my = this.vh / 2) {
    const levels = this.levels(), g = this.goal * P;
    let lv = -1;
    if (dir > 0) lv = levels.findIndex(z => z > g * 1.001);
    else for (let i = levels.length - 1; i >= 0; i--) if (levels[i] < g * 0.999) { lv = i; break; }
    if (lv < 0) return;
    this.level = lv;
    this.goal = levels[lv] / P;
    const w = this.toWorld(mx, my);
    this.anchor = { mx, my, X: w.X, Y: w.Y };
  }
  setLevel(lv) { this.level = Math.max(0, Math.min(this.levels().length - 1, lv)); this.goal = this.levels()[this.level] / P; this.zoom = this.goal; this.anchor = null; this.clamp(); }
  // A pinch: the zoom times k about the view point (mx, my), which stays over the same world point, clamped to the
  // farthest and closest levels. The level becomes the nearest one (the wheel and the buttons step on from there).
  zoomBy(k, mx = this.vw / 2, my = this.vh / 2) {
    const levels = this.levels(), w = this.toWorld(mx, my);
    const z = Math.max(levels[0] / P, Math.min(levels[levels.length - 1] / P, this.zoom * k));
    this.zoom = this.goal = z; this.anchor = null;
    let best = 0;
    levels.forEach((l, i) => { if (Math.abs(Math.log(l / P / z)) < Math.abs(Math.log(levels[best] / P / z))) best = i; });
    this.level = best;
    this.x = w.X - (mx - this.vw / 2) / z; this.y = w.Y - (my - this.vh / 2) / z;
    this.clamp();
  }
  // A wheel event: +1 (zoom in), -1 or 0. Small deltas (a touchpad, a Mac's mouse) add up to one step, and steps come
  // at most every WHEEL_GAP ms. A step always goes the way the wheel turns now: turning it the other way drops what was
  // left of the old way (the notches of a quick spin that came during a gap, which made the next turn's first step go
  // the old way: zoomed in, turned back to zoom out, and it zoomed in once more first), and a step against the last one
  // also waits until the wheel has been still the old way for WHEEL_GAP (a wheel ticking back as it stops, a touchpad's
  // lift).
  wheelDir(ev) {
    const now = performance.now(), d = ev.deltaMode === 1 ? ev.deltaY * 40 : ev.deltaY, s = Math.sign(d);
    if (!s) return 0;
    if (s * this.wheelAcc < 0) this.wheelAcc = 0;
    if (s === this.wheelS) this.wheelST = now;
    this.wheelAcc += d;
    if (Math.abs(this.wheelAcc) < WHEEL_STEP || now - this.wheelT < WHEEL_GAP) return 0;
    if (s !== this.wheelS && now - this.wheelST < WHEEL_GAP) return 0;
    this.wheelAcc = 0; this.wheelT = this.wheelST = now; this.wheelS = s;
    return -s;
  }

  update(dt) {
    if (!this.zooming) { this.anchor = null; return; }
    const k = 1 - Math.exp(-EASE * dt);
    this.zoom += (this.goal - this.zoom) * k;
    if (Math.abs(this.zoom - this.goal) < this.goal * 0.002) this.zoom = this.goal;
    const a = this.anchor;
    if (a) { this.x = a.X - (a.mx - this.vw / 2) / this.zoom; this.y = a.Y - (a.my - this.vh / 2) / this.zoom; }
    this.clamp();
  }
  clamp() {
    const [x0, y0, b1, y1] = this.bounds, hw = this.vw / 2 / this.zoom, hh = this.vh / 2 / this.zoom;
    const x1 = b1 + this.padRight / this.zoom, ox = this.x, oy = this.y;
    this.x = x1 - x0 <= hw * 2 ? (x0 + x1) / 2 : Math.max(x0 + hw, Math.min(x1 - hw, this.x));
    this.y = y1 - y0 <= hh * 2 ? (y0 + y1) / 2 : Math.max(y0 + hh, Math.min(y1 - hh, this.y));
    this.moved = true;
    return ox !== this.x || oy !== this.y;
  }
}
