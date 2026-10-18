// The Line Tower Wars camera: pan and zoom over the stacked lanes. It works in the logical pixels every sprite is
// placed in (src/render.js: x * P across, (y * SIN - z * COS + TOP) * P down), so the projection is exactly Classic's.
// x, y is the logical point at the centre of the view; zoom is css px per logical px.
import { P } from '../render.js?v=c7bd234229c1';

export const ZOOMS = [26, 36, 48, 62];   // css px per tile, far to close; the farthest narrows so a whole lane fits
const EASE = 14;                         // zoom easing rate (1/s)

export class Camera {
  constructor() {
    this.x = 0; this.y = 0; this.vw = 1; this.vh = 1;
    this.level = 2; this.zoom = ZOOMS[2] / P; this.goal = this.zoom; this.anchor = null;
    this.bounds = [0, 0, 1, 1];
    this.padRight = 0;                   // css px the world may be panned left past its right edge (from under the scoreboard)
    this.moved = true;                   // set whenever the view changes (the minimap redraws its frame)
  }
  levels() { return [Math.max(10, Math.min(ZOOMS[0], this.vw / 54)), ...ZOOMS.slice(1)]; }
  get zooming() { return Math.abs(this.zoom - this.goal) > 1e-4; }
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
  // Step one zoom level in (dir > 0) or out, keeping the world point under the cursor (mx, my) in place.
  zoomStep(dir, mx = this.vw / 2, my = this.vh / 2) {
    const lv = Math.max(0, Math.min(ZOOMS.length - 1, this.level + (dir > 0 ? 1 : -1)));
    if (lv === this.level) return;
    this.level = lv;
    this.goal = this.levels()[lv] / P;
    const w = this.toWorld(mx, my);
    this.anchor = { mx, my, X: w.X, Y: w.Y };
  }
  setLevel(lv) { this.level = Math.max(0, Math.min(ZOOMS.length - 1, lv)); this.goal = this.levels()[this.level] / P; this.zoom = this.goal; this.anchor = null; this.clamp(); }

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
