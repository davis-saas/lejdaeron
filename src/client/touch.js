// Touch for every mode, through Pointer Events. Only touch pointers come here, and a pen where the screen has no hover
// (an iPad's pencil): a mouse, and a computer's pen, keep the mouse handlers of each mode, so they behave exactly as
// before. On the battlefield one finger drags the camera (a finger that moves less than SLOP still taps), two fingers
// pinch to zoom around their midpoint and pan, a tap is a click and a long press is what hovering gives a mouse. The
// page itself never zooms or scrolls under a finger: the game area has touch-action: none (style.css), and the
// battlefield cancels its touch events, which also stops the mouse events and clicks a browser makes up after a touch.
export const SLOP = 10;          // css px a finger may move and still tap
export const HOLD_MS = 450;      // ms a still finger takes to long-press
export const TIP_LINGER = 1500;  // ms a long-press tooltip stays after the finger lifts (the next touch closes it at once)
const media = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
const PEN_TOUCH = media('(hover: none)');
export const isTouch = (ev) => ev.pointerType === 'touch' || (ev.pointerType === 'pen' && PEN_TOUCH);

// A touch screen first of all (a phone, a tablet), not a computer that also has one.
export const touchFirst = () => media('(hover: none) and (pointer: coarse)');
// The pointer the player used last ('mouse' or 'touch'), so hints can name a tap or a key, and a text a click or a tap.
let last = touchFirst() ? 'touch' : 'mouse';
export const lastInput = () => last;
export const clickWord = () => (last === 'touch' ? 'Tap' : 'Click');
// The compact layouts (phones, small windows, touch screens) put zoom and jump buttons over the battlefield; style.css
// uses the same query for #view-tools.
export const COMPACT = '(max-width: 900px), (max-height: 500px), (pointer: coarse)';
export const compact = () => media(COMPACT);
// The phone layouts of style.css (upright under 601 px wide, on its side under 501 px tall): the info panel opens bigger
// at a tap, the scoreboard starts folded.
export const PHONE = '(max-width: 600px), (max-height: 500px)';
export const phone = () => media(PHONE);

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (ev) => { last = isTouch(ev) ? 'touch' : 'mouse'; }, true);
  // Safari zooms the page on a pinch even where touch-action forbids it, unless its gesture events are cancelled
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (ev) => ev.preventDefault(), { passive: false });
}

const add = (t, type, fn, opts) => t.addEventListener(type, fn, opts);

// One element's finger gestures. h: { active() -> bool, down(p), tap(p), hold(p) -> 'aim' to aim with the finger,
// holdMove(p), holdEnd(), aim(p), aimEnd(p, inside), pan(dx, dy), pinch(k, mid, dx, dy), cancel(), end() }, every one
// optional but active. Points are client css px { x, y }; pinch k is the change in finger spread since the last call.
// on(target, type, fn, opts) registers a listener (a mode that unbinds passes its own). surface(target), where the
// element holds buttons of its own: whether a finger that lands on that target is the battlefield's (else it is the
// button's, and its touches are left alone).
export class Gestures {
  constructor(el, h, on = add, surface = () => true) {
    this.el = el; this.h = h; this.pts = new Map(); this.mode = null; this.timer = 0; this.pair = null;
    on(el, 'pointerdown', (ev) => { if (surface(ev.target)) this.down(ev); });
    on(el, 'pointermove', (ev) => this.move(ev));
    on(el, 'pointerup', (ev) => this.up(ev, false));
    on(el, 'pointercancel', (ev) => this.up(ev, true));
    on(el, 'lostpointercapture', (ev) => { if (this.pts.has(ev.pointerId)) this.up(ev, true); });
    for (const type of ['touchstart', 'touchmove', 'touchend']) on(el, type, (ev) => { if (ev.cancelable && surface(ev.target)) ev.preventDefault(); }, { passive: false });
  }
  call(name, ...args) { const f = this.h[name]; return f ? f(...args) : undefined; }
  down(ev) {
    if (!isTouch(ev)) return;
    ev.preventDefault();
    if (!this.h.active()) { this.reset(); return; }
    try { this.el.setPointerCapture(ev.pointerId); } catch { /* the pointer is gone already */ }
    const p = { x: ev.clientX, y: ev.clientY };
    this.pts.set(ev.pointerId, { ...p, x0: p.x, y0: p.y });
    if (this.pts.size === 1) {
      this.mode = 'press';
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.held(), HOLD_MS);
      this.call('down', p);
    } else if (this.pts.size === 2) {
      // a second finger: whatever the first one started (a tap, a long press, aiming a tower) is off; pinch instead
      clearTimeout(this.timer);
      if (this.mode === 'press' || this.mode === 'hold' || this.mode === 'aim') this.call('cancel');
      if (this.mode === 'hold') this.call('holdEnd');
      this.mode = 'pinch';
      this.pair = this.spread();
    }
  }
  held() {
    if (this.mode !== 'press' || this.pts.size !== 1) return;
    const [p] = this.pts.values();
    this.mode = this.call('hold', { x: p.x, y: p.y }) === 'aim' ? 'aim' : 'hold';
  }
  // distance and midpoint of the first two fingers
  spread() {
    const [a, b] = this.pts.values();
    return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  move(ev) {
    const pt = this.pts.get(ev.pointerId);
    if (!pt) return;
    const px = pt.x, py = pt.y;
    pt.x = ev.clientX; pt.y = ev.clientY;
    const p = { x: pt.x, y: pt.y };
    if (this.mode === 'press') {
      if (Math.hypot(pt.x - pt.x0, pt.y - pt.y0) <= SLOP) return;
      clearTimeout(this.timer);
      this.mode = 'pan';
      this.call('cancel');
      this.call('pan', pt.x - pt.x0, pt.y - pt.y0);
    } else if (this.mode === 'pan') this.call('pan', pt.x - px, pt.y - py);
    else if (this.mode === 'hold') this.call('holdMove', p);
    else if (this.mode === 'aim') this.call('aim', p);
    else if (this.mode === 'pinch' && this.pts.size >= 2) {
      const s = this.spread(), q = this.pair;
      this.pair = s;
      this.call('pinch', s.d / q.d, { x: s.x, y: s.y }, s.x - q.x, s.y - q.y);
    }
  }
  up(ev, cancelled) {
    const pt = this.pts.get(ev.pointerId);
    if (!pt) return;
    this.pts.delete(ev.pointerId);
    const p = { x: pt.x, y: pt.y }, mode = this.mode;
    if (mode === 'pinch') {
      if (this.pts.size === 1) this.mode = 'pan';   // the finger left on the glass drags on
      else if (this.pts.size === 0) { this.mode = null; this.call('end'); }
      else this.pair = this.spread();
      return;
    }
    if (this.pts.size) return;
    clearTimeout(this.timer);
    this.mode = null;
    if (mode === 'press') { if (cancelled) this.call('cancel'); else this.call('tap', p); }
    else if (mode === 'hold') this.call('holdEnd');
    else if (mode === 'aim') {
      const r = this.el.getBoundingClientRect(), inside = p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
      if (cancelled) this.call('cancel'); else this.call('aimEnd', p, inside);
    } else if (mode === 'pan') this.call('end');
  }
  // the mode stopped taking input (a dialog opened, the game ended): drop the fingers on the glass
  reset() {
    clearTimeout(this.timer);
    if (this.mode === 'hold') this.call('holdEnd');
    if (this.mode === 'pinch' || this.mode === 'pan') this.call('end');
    this.pts.clear(); this.mode = null;
  }
}

// A button with a tooltip: shown while a mouse hovers it, or after a long press of a finger, which then does not press
// the button (heldClick tells the click handler so). The tooltip a finger opened stays TIP_LINGER after it lifts.
const HELD = new WeakSet();
let fingerTip = null;            // { b, hide, linger }: the tooltip a finger opened
function closeFingerTip() {
  if (!fingerTip) return;
  clearTimeout(fingerTip.linger);
  const { hide } = fingerTip;
  fingerTip = null;
  hide();
}
// the next touch anywhere else closes it
if (typeof window !== 'undefined') window.addEventListener('pointerdown', (ev) => { if (fingerTip && !fingerTip.b.contains(ev.target)) closeFingerTip(); }, true);
export function tipButton(b, show, hide) {
  let timer = 0, start = null;
  b.addEventListener('pointerenter', (ev) => { if (!isTouch(ev)) show(); });
  b.addEventListener('pointerleave', (ev) => { if (!isTouch(ev)) hide(); });
  b.addEventListener('pointerdown', (ev) => {
    HELD.delete(b);
    if (!isTouch(ev)) return;
    if (fingerTip && fingerTip.b === b) clearTimeout(fingerTip.linger);
    start = { x: ev.clientX, y: ev.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => { closeFingerTip(); HELD.add(b); fingerTip = { b, hide, linger: 0 }; show(); }, HOLD_MS);
  });
  b.addEventListener('pointermove', (ev) => { if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > SLOP) { clearTimeout(timer); start = null; } });
  const lift = () => {
    clearTimeout(timer); start = null;
    if (fingerTip && fingerTip.b === b) fingerTip.linger = setTimeout(closeFingerTip, TIP_LINGER);
  };
  b.addEventListener('pointerup', lift); b.addEventListener('pointercancel', lift);
  b.addEventListener('contextmenu', (ev) => ev.preventDefault());   // a long press is the tooltip, not the browser's menu
}
// true once for the click that ends a long press (it only showed the tooltip)
export const heldClick = (b) => HELD.delete(b);
