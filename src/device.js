// What this device can afford. Phones and tablets (a small screen or a finger for a pointer) and computers with little
// memory get the light set: the half-size art in assets/light (tools/light_art.mjs, loaded by src/assets.js), smaller
// offscreen canvases, half the particles and, unless the player turns it off in the menu, 30 frames a second. Computers
// keep the full art and everything as it was. ?art=light or ?art=full in the page's URL overrides the choice (testing).
const web = typeof window !== 'undefined';
const media = (q) => web && typeof matchMedia === 'function' && matchMedia(q).matches;
const forced = web ? new URLSearchParams(location.search).get('art') : null;
const lowMemory = web && navigator.deviceMemory > 0 && navigator.deviceMemory <= 2;   // GB (Chrome only reports it)
const small = web && Math.min(screen.width, screen.height) < 600;                     // css px: phones (tablets are 744 and up)
export const LIGHT = forced === 'light' || (forced !== 'full' && (small || media('(pointer: coarse)') || lowMemory));

// Canvas pixels per css pixel. A phone's 3x screen is drawn at 2x (the light art has no more detail than that), 1.5x
// with little memory.
const DPR_CAP = LIGHT && lowMemory ? 1.5 : 2;
export const pixelRatio = () => Math.min(DPR_CAP, (web && window.devicePixelRatio) || 1);

// The most pixels one offscreen canvas (a ground cache, a buffer) may have at the scale asked for: iOS Safari refuses
// canvases over 16.7 million pixels, and with the light art 4 million (16 MB) is plenty.
const CANVAS_PX = LIGHT ? 4194304 : 16777216;
export const canvasScale = (w, h, scale) => Math.min(scale, Math.sqrt(CANVAS_PX / Math.max(1, w * h)));

// The share of the particles an effect spawns (src/fx.js; its layers also keep fewer of them, and fewer floating numbers).
export const FX_DENSITY = LIGHT ? 0.5 : 1;

// The 30 fps cap: a setting in the menus, on by default with the light set (it saves battery and heat on a phone).
const FPS_KEY = 'lejdaeron.fps30';
let fps30 = LIGHT;
try { const v = web && localStorage.getItem(FPS_KEY); if (v === '1' || v === '0') fps30 = v === '1'; } catch { /* storage blocked: the default */ }
export const capped = () => fps30;
export function setCapped(on) {
  fps30 = !!on;
  try { localStorage.setItem(FPS_KEY, fps30 ? '1' : '0'); } catch { /* not kept */ }
}
// Whether the animation frame at `now` (ms) should be drawn, `last` the one drawn before. Capped, every other frame of
// a 60 Hz screen (every fourth at 120 Hz): a frame comes at least a 30th of a second minus a little after the last.
export const frameDue = (now, last) => !fps30 || now - last >= 1000 / 30 - 6;
