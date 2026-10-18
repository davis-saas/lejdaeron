// Entry point: loads the Blender sprites and shows the map picker (src/client/screens.js): the Classic map is Classic
// Defense, Line Tower Wars is played vs Computer or vs Players. Classic Defense runs its simulation on a timer and draws
// with requestAnimationFrame; vs Computer and vs Players are the LtwMode in src/client/ltw.js, and src/client/online.js
// holds the vs Players menu, join screens and lobby (an invite link #room=... opens it, past the picker).
// Classic's camera starts on the whole map (on a touch screen: the map filling the stage, from its west end); the wheel,
// the + and - buttons and a pinch zoom it up to about 2.5 times closer, and a right or middle drag, the arrow keys or a
// finger pan it, anywhere on the stage (also on the bands beside a map zoomed out).
import { Game, TOWERS, LEVELS } from './game.js?v=99dfd38af943';
import { buildable } from './level.js?v=99dfd38af943';
import { loadAssets } from './assets.js?v=99dfd38af943';
import { Renderer, W, H, P } from './render.js?v=99dfd38af943';
import { FX } from './fx.js?v=99dfd38af943';
import { UI } from './ui.js?v=99dfd38af943';
import { SIN, TOP } from './level.js?v=99dfd38af943';
import { LtwMode } from './client/ltw.js?v=99dfd38af943';
import { Online } from './client/online.js?v=99dfd38af943';
import { Camera } from './client/camera.js?v=99dfd38af943';
import { Gestures, isTouch, lastInput, phone, touchFirst } from './client/touch.js?v=99dfd38af943';
import { screen, hideScreen, screenShown, mapPicker, mapScreen, mapPicture, bindPictures, setupScreen, settingsLine, bindSettings } from './client/screens.js?v=99dfd38af943';
import { MAP } from './client/maps.js?v=99dfd38af943';
import { startApp } from './client/app.js?v=99dfd38af943';
import { frameDue } from './device.js?v=99dfd38af943';

const $ = (id) => document.getElementById(id);
const canvas = $('view'), stage = $('stage');
// armed: the tile a finger picked for the tower being placed (a second tap there builds it)
const view = { selected: null, placing: null, hover: null, hoverTower: null, shift: false, keep: false, armed: null };
let game = new Game();
let fx = new FX();
let renderer, ui, ltw = null, online = null;
let mode = 'menu';   // 'menu' | 'classic' | 'ltw'
let speed = 1, paused = false, started = false, over = false, clock = 0;
const PAN = 1100;          // css px per second for the arrow keys
const DRAG = 4;            // px a right or middle press moves before it counts as a drag
const CLOSEST = 56;        // css px per tile Classic zooms to at least (a finger's width), however small the screen
const ZOOM_IN = 2.5;       // and at least this many times the whole-map view
const cam = new Camera(classicLevels);
let mouse = null;          // the mouse over the battlefield (client px): the hover tile follows the camera under it
let drag = null;           // a right or middle drag that pans
const keys = new Set();    // arrow keys held
// the start screen's text and key list (not the progress bar or the credit line), shown again before Classic begins
const CLASSIC_INTRO = [...$('ov-body').children].filter(e => (e.tagName === 'P' && !e.classList.contains('ov-credit')) || e.classList.contains('ov-keys'))
  .map(e => e.outerHTML).join('');

const actions = {
  view: () => view,
  cam: () => cam,
  place(def) {
    if (game.gold < def.cost) return ui.error('Not enough gold.');
    view.placing = def; view.selected = null; view.armed = null; canvas.classList.add('placing');
    if (lastInput() === 'touch') ui.hint('Tap a spot, then tap it again to build.');
  },
  cancel() { view.placing = null; view.armed = null; canvas.classList.remove('placing'); ui.hint(''); },
  keep() { view.keep = !view.keep; },   // keep building: Shift for a pointer without a keyboard
  upgrade(t, id) {
    const def = TOWERS[id];
    if (t.building > 0) return ui.error('That tower is still being built.');
    if (game.gold < def.cost) return ui.error('Not enough gold.');
    game.upgrade(t, id);
  },
  sell(t) { game.sell(t); view.selected = null; },
  callNext() { if (game.phase === 'countdown') game.callNext(); },
  togglePause() { if (!started || over) return; paused = !paused; $('btn-pause').textContent = paused ? 'Resume' : 'Pause'; if (paused) showMenu(); else hideOverlay(); },
  setSpeed(n) {
    speed = n;
    for (const b of document.querySelectorAll('#speed button')) b.classList.toggle('on', +b.dataset.speed === n);
    $('btn-speed').textContent = n + 'x';
  },
  menu() { if (!started || over) return; paused = true; $('btn-pause').textContent = 'Resume'; showMenu(); },
};

// ---------------------------------------------------------------- layout
// The camera's view is the whole stage; the renderer's canvas covers the part of it the map fills. A view still at its
// start (a phone turned on its side) takes the new start view. Called whenever the stage changes size (a window
// resized, a phone turned, its browser's bars), and the info panel lays its content out again for its size.
function fit() {
  if (mode === 'ltw') return ltw.fit();
  const st = stage.getBoundingClientRect();
  const k = Math.min(st.width / W, st.height / H), start = cam.level === defaultLevel();
  renderer.resize(Math.floor(W * k), Math.floor(H * k));
  cam.setView(st.width, st.height);
  cam.setBounds(0, 0, W, H);
  if (start) cam.setLevel(defaultLevel());
  zoomButtons();
  ui.lastInfo = '';
}
// Classic zoom levels in css px per tile: the whole map fitted to the stage, the map covering the stage, and on to the
// closest, ZOOM_IN times the fitted view or a finger's width per tile, whichever is closer.
function classicLevels(vw, vh) {
  const fit = Math.floor(W * Math.min(vw / W, vh / H)) / W * P, cover = Math.max(vw / W, vh / H) * P;
  const close = Math.max(fit * ZOOM_IN, cover, CLOSEST);
  const steps = (a, b, n) => Array.from({ length: n }, (_, i) => a * (b / a) ** ((i + 1) / n));
  return cover > fit * 1.05 ? [fit, ...steps(fit, cover, 2), ...steps(cover, close, 3)] : [fit, ...steps(fit, close, 4)];
}
// The view a game starts with: the whole map, or on a touch screen (a phone, a tablet) the map filling the stage, at
// its west end: the portal, the castle and both ends of the road.
function defaultLevel() {
  if (!touchFirst()) return 0;
  const lv = cam.levels(), cover = Math.max(cam.vw / W, cam.vh / H) * P;
  return Math.max(0, lv.findIndex(z => z >= cover * 0.999));
}
function resetView() {
  const lv = defaultLevel();
  cam.setLevel(lv);
  cam.center(lv ? 0 : W / 2, H / 2);
  zoomButtons();
}
function zoom(dir, mx, my) {
  if (mode !== 'classic' || screenShown()) return;
  cam.zoomStep(dir, mx, my);
  zoomButtons();
}
function zoomButtons() {
  if (mode === 'ltw') return;
  for (const id of ['zoom-in', 'vt-in']) $(id).disabled = cam.close;
  for (const id of ['zoom-out', 'vt-out']) $(id).disabled = cam.far;
}

// client px -> stage px (the camera's view) -> logical px, and the tile there
function stageXY(x, y) { const r = stage.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; }
function worldAt(x, y) { const p = stageXY(x, y); return cam.toWorld(p.x, p.y); }
const tileAt = ({ X, Y }) => ({ c: Math.floor(X / P), r: Math.floor((Y / P - TOP) / SIN) });

// ---------------------------------------------------------------- input (Classic; vs Computer binds its own)
// The mouse: hover, left click (select, build), right click (cancel), right or middle drag (pan), the wheel (zoom).
function hoverMouse() {
  if (!mouse) return;
  const w = worldAt(mouse.x, mouse.y);
  view.hover = tileAt(w);
  const hit = renderer.pick(game, w.X, w.Y);
  view.hoverTower = hit.tower || null;
}
// A click or a tap at logical px X, Y: place the tower being placed (keep: go on placing), else select. Returns the
// tower it built.
function classicClick(X, Y, keep) {
  if (view.placing) {
    // the tile under this press (a press can arrive without a mousemove before it, e.g. a tap)
    const h = view.hover = tileAt({ X, Y });
    if (!buildable(h.c, h.r) || game.towerAt(h.c, h.r)) return ui.error("Can't build there.");
    if (game.gold < view.placing.cost) { ui.error('Not enough gold.'); return actions.cancel(); }
    const t = game.build(view.placing.id, h.c, h.r);
    if (t && !(keep || view.shift || view.keep)) { actions.cancel(); view.selected = t; }
    ui.refresh(true);
    return t;
  }
  const hit = renderer.pick(game, X, Y);
  view.selected = hit.tower || hit.creep || null;
  ui.refresh(true);
}
const playing = () => mode === 'classic' && started && !over;
canvas.addEventListener('mousemove', (ev) => {
  if (mode === 'ltw' || !renderer) return;
  mouse = { x: ev.clientX, y: ev.clientY };
  hoverMouse();
});
canvas.addEventListener('mouseleave', () => { mouse = null; view.hover = null; view.hoverTower = null; });
canvas.addEventListener('mousedown', (ev) => {
  if (!playing()) return;
  if (ev.button === 1 || ev.button === 2) {
    ev.preventDefault();
    drag = { x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY, button: ev.button, moved: false };
    return;
  }
  const { X, Y } = worldAt(ev.clientX, ev.clientY);
  classicClick(X, Y, ev.shiftKey);
});
window.addEventListener('mousemove', (ev) => {
  const d = drag;
  if (!d) return;
  if (!d.moved && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) > DRAG) d.moved = true;
  if (d.moved) cam.pan(d.x - ev.clientX, d.y - ev.clientY);
  d.x = ev.clientX; d.y = ev.clientY;
});
window.addEventListener('mouseup', (ev) => {
  const d = drag;
  if (!d || ev.button !== d.button) return;
  drag = null;
  if (!d.moved && d.button === 2 && playing()) { if (view.placing) actions.cancel(); else view.selected = null; }
});
stage.addEventListener('wheel', (ev) => {
  if (mode === 'ltw') return;
  ev.preventDefault();
  if (!playing() || screenShown()) return;
  const dir = cam.wheelDir(ev), m = stageXY(ev.clientX, ev.clientY);
  if (dir) zoom(dir, m.x, m.y);
}, { passive: false });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

// A finger: a tap selects; placing a tower, the first tap shows it there and a second tap on that tile builds it (or a
// long press, then the finger aims it and builds where it lifts). A long press elsewhere shows what a mouse hover
// would; one finger drags the map, two pinch it, on the map or on the stage around it (not on the buttons there).
function touchHover(p) { mouse = null; view.hover = tileAt(worldAt(p.x, p.y)); }
function holdTip(p) {
  const w = worldAt(p.x, p.y), hit = renderer.pick(game, w.X, w.Y), o = hit.tower || hit.creep || null;
  view.hoverTower = hit.tower || null;
  if (o) ui.objectTip(o, p.x, p.y); else ui.hideTip();
}
new Gestures(stage, {
  active: () => playing() && !paused && !screenShown(),
  down: (p) => { if (view.placing) touchHover(p); },
  tap: (p) => {
    const { X, Y } = worldAt(p.x, p.y);
    mouse = null;
    if (!view.placing) { view.hoverTower = null; return classicClick(X, Y); }
    const h = tileAt({ X, Y }), a = view.armed;
    if (a && a.c === h.c && a.r === h.r) {
      view.armed = null;
      if (classicClick(X, Y) && view.placing) { view.hover = null; ui.hint('Tap the next spot.'); }   // keep building
      return;
    }
    view.armed = view.hover = h;
    const ok = buildable(h.c, h.r) && !game.towerAt(h.c, h.r);
    ui.hint(ok ? 'Tap again to build here.' : "Can't build there.");
  },
  hold: (p) => {
    if (!view.placing) return holdTip(p);
    touchHover(p);
    ui.hint('Move your finger to aim, lift it to build.');
    return 'aim';
  },
  holdMove: holdTip,
  holdEnd: () => { view.hoverTower = null; ui.hideTip(); },
  aim: touchHover,
  aimEnd: (p, inside) => {
    const { X, Y } = worldAt(p.x, p.y);
    if (!inside || !view.placing) { view.hover = view.armed; return; }
    view.armed = tileAt({ X, Y });
    if (classicClick(X, Y)) { view.armed = null; if (view.placing) { view.hover = null; ui.hint('Tap the next spot.'); } }
  },
  cancel: () => { if (view.placing) view.hover = view.armed; },
  pan: (dx, dy) => cam.pan(-dx, -dy),
  pinch: (k, m, dx, dy) => {
    const q = stageXY(m.x, m.y);
    cam.live = true;
    cam.zoomBy(k, q.x, q.y); cam.pan(-dx, -dy);
    zoomButtons();
  },
  end: () => { cam.live = false; },
}, undefined, (t) => t === canvas || t === stage || t === $('view-wrap'));
// the zoom buttons: on the minimap's frame, and over the battlefield in the compact layouts
for (const [id, run] of [['zoom-in', () => zoom(1)], ['zoom-out', () => zoom(-1)], ['zoom-reset', resetView], ['vt-in', () => zoom(1)], ['vt-out', () => zoom(-1)], ['vt-fit', resetView]]) {
  $(id).addEventListener('click', () => { if (mode === 'classic') run(); });
}
// a finger calls the next level by tapping the level timer (UI.refresh makes it tappable after a touch)
$('wave-timer').addEventListener('click', () => { if (playing() && $('wave-timer').classList.contains('tap')) { actions.callNext(); ui.refresh(true); } });
// clicking or dragging on the minimap moves the view there (a finger stays with the element it touched)
let mmDrag = false;
$('minimap').addEventListener('mousedown', (ev) => { if (mode === 'classic' && ev.button === 0) { mmDrag = true; minimapJump(ev); ev.preventDefault(); } });
window.addEventListener('mousemove', (ev) => { if (mmDrag) { if (ev.buttons & 1) minimapJump(ev); else mmDrag = false; } });
window.addEventListener('mouseup', (ev) => { if (ev.button === 0) mmDrag = false; });
$('minimap').addEventListener('pointermove', (ev) => { if (mode === 'classic' && isTouch(ev)) minimapJump(ev); });
$('minimap').addEventListener('pointerdown', (ev) => { if (mode === 'classic' && isTouch(ev)) minimapJump(ev); });
$('minimap').addEventListener('touchstart', (ev) => { if (ev.cancelable) ev.preventDefault(); }, { passive: false });
function minimapJump(ev) {
  const r = $('minimap').getBoundingClientRect(), w = ui.minimapToWorld(ev.clientX - r.left, ev.clientY - r.top);
  cam.center(w.X, w.Y);
}

// ---------------------------------------------------------------- compact layouts (style.css)
// The minimap opens over the battlefield from its button where the console has none; on a phone the info panel opens
// over it from a tap, and an upright phone gets a hint to turn it (once dismissed, or once the phone was turned, it
// stays away).
const ROTATE_KEY = 'lejdaeron.rotateHint';
$('vt-map').addEventListener('click', () => { $('vt-map').setAttribute('aria-pressed', String(document.body.classList.toggle('mm-open'))); });
$('info-panel').addEventListener('click', () => {
  if (!phone() && !document.body.classList.contains('info-open')) return;
  document.body.classList.toggle('info-open');
  const u = mode === 'ltw' ? ltw.hud : ui;
  if (u) { u.lastInfo = ''; u.refresh(true); }   // laid out again for its new size
});
try { if (localStorage.getItem(ROTATE_KEY)) document.body.classList.add('rotate-ok'); } catch { /* storage blocked: the hint shows */ }
function rotateOk() {
  document.body.classList.add('rotate-ok');
  try { localStorage.setItem(ROTATE_KEY, '1'); } catch { /* not kept */ }
}
$('rotate-hint').querySelector('button').addEventListener('click', rotateOk);
const turned = matchMedia('(orientation: landscape) and (pointer: coarse)');
if (turned.matches) rotateOk(); else turned.addEventListener('change', () => { if (turned.matches) rotateOk(); });

window.addEventListener('keydown', (ev) => {
  if (mode === 'ltw') return;
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;   // typing a name, a link, lobby chat
  if (ev.key === 'Shift') view.shift = true;
  // Enter on the menus presses the dialog's main button, unless one of the dialog's buttons has the focus (a card, Back,
  // the main button itself: Enter presses that one)
  const enter = ev.key === 'Enter' && !(ev.target instanceof HTMLButtonElement && $('overlay').contains(ev.target));
  if (!started) { if (enter && $('ov-btn').style.display !== 'none' && !$('ov-btn').disabled) $('ov-btn').click(); return; }
  if (over) { if (enter) $('ov-btn').click(); return; }
  if (ev.key === 'F10' || (ev.key === 'Escape' && paused)) { ev.preventDefault(); return paused ? actions.togglePause() : actions.menu(); }
  if (paused) return;
  if (ev.key === 'Escape') { if (view.placing) actions.cancel(); else view.selected = null; return; }
  if (ev.key.startsWith('Arrow')) { ev.preventDefault(); keys.add(ev.key); return; }
  if (ev.key === 'p' || ev.key === 'P') return actions.togglePause();
  if (ev.key === '1' || ev.key === '2' || ev.key === '3') return actions.setSpeed(+ev.key);
  if (ev.key === ' ' || ((ev.key === 'n' || ev.key === 'N') && !view.placing)) { ev.preventDefault(); return actions.callNext(); }
  if (ev.key === 'Delete' && view.selected && view.selected.upgrades === undefined && view.selected.def.upgrades) return actions.sell(view.selected);
  if (ev.key.length === 1 && ui.hotkey(ev.key, view)) ev.preventDefault();
});
window.addEventListener('keyup', (ev) => { keys.delete(ev.key); if (ev.key === 'Shift') view.shift = false; });
window.addEventListener('blur', () => { keys.clear(); view.shift = false; });
new ResizeObserver(() => { if (renderer) fit(); }).observe(stage);

// ---------------------------------------------------------------- overlay screens
function hideOverlay() { hideScreen(); }
function showMenu() {
  screen({
    title: 'Paused', sub: `Level ${game.level} of ${LEVELS}`,
    body: `${settingsLine()}<ul class="ov-keys">
    <li class="touch-keys">On a touch screen, tap a tower button, then tap a spot twice to build there. Tap a tower for its upgrades, and the level timer to call the next level. Drag to move the map, pinch to zoom, hold a button or a unit for its details.</li>
    <li class="mouse-keys"><b>A</b> / <b>S</b> / <b>E</b> build towers. <b>Shift</b>-click keeps building.</li>
    <li class="mouse-keys">Select a tower for its upgrades (<b>Q W E R T</b>). <b>X</b> sells it.</li><li class="mouse-keys"><b>N</b> or <b>Space</b> calls the next level. <b>1 2 3</b> set the speed.</li>
    <li class="mouse-keys">The wheel or <b>+</b> <b>−</b> zoom, the arrow keys or a right drag move the map.</li></ul>
    <div class="ov-actions"><button class="wc-btn small" id="ov-restart">Restart</button><button class="wc-btn small" id="ov-quit">Main menu</button></div>`,
    primary: { label: 'Resume', run: () => actions.togglePause() },
  });
  $('ov-restart').onclick = () => restart();
  $('ov-quit').onclick = () => toMenu();
  bindSettings();
}
function showEnd(won) {
  over = true;
  screen({
    title: won ? 'Victory' : 'Defeat', sub: won ? 'The castle stands' : 'The castle has fallen',
    body: `<div class="ov-stats">
    <span>Level reached</span><b>${game.level} / ${LEVELS}</b><span>Creeps slain</span><b>${game.stats.kills}</b>
    <span>Creeps leaked</span><b>${game.stats.leaks}</b><span>Towers built</span><b>${game.stats.built}</b>
    <span>Time</span><b>${Math.floor(game.time / 60)}:${String(Math.floor(game.time % 60)).padStart(2, '0')}</b></div>
    <div class="ov-actions"><button class="wc-btn small" id="ov-quit">Main menu</button></div>`,
    primary: { label: 'Play again', run: () => restart() },
  });
  $('ov-quit').onclick = () => toMenu();
}
function restart() {
  game = new Game(); fx = new FX(); ui.g = game; view.selected = null; view.keep = false; actions.cancel();
  over = false; paused = false; started = true; clock = 0;
  $('btn-pause').textContent = 'Pause';
  resetView();
  hideOverlay(); ui.lastInfo = ''; ui.refresh(true);
}

// ---------------------------------------------------------------- modes
// The topbar buttons belong to whichever mode is running.
function bindClassicTopbar() {
  $('btn-pause').onclick = () => actions.togglePause();
  $('btn-menu').onclick = () => actions.menu();
  for (const b of document.querySelectorAll('#speed button')) b.onclick = () => actions.setSpeed(+b.dataset.speed);
  $('btn-speed').onclick = () => actions.setSpeed(speed % 3 + 1);
  actions.setSpeed(speed);
}
function toMenu() {
  if (mode === 'ltw') ltw.stop();
  mode = 'menu';
  game = new Game(); fx = new FX(); ui.g = game; view.selected = null; view.keep = false; actions.cancel();
  over = false; paused = false; started = false; clock = 0;
  $('btn-pause').textContent = 'Pause'; $('msgs').innerHTML = '';
  document.body.classList.remove('info-open');
  bindClassicTopbar();
  fit();
  resetView();
  ui.lastInfo = ''; ui.refresh(true);
  mapMenu();
  online.resume();   // an invite link opened during the game that just ended
}
// The map picker, and what each map leads to: the Classic map's intro (Classic Defense), Line Tower Wars' screen with
// vs Computer and vs Players. Every Back goes one screen back, to the picker in the end.
function mapMenu() { mapPicker({ pick: (m) => ({ classic: classicIntro, ltw: ltwScreen })[m.id]() }); }
function ltwScreen() { mapScreen(MAP.ltw, { run: { computer: computerSetup, players: () => online.menu({ back: ltwScreen }) }, back: mapMenu }); }
function classicIntro() {
  screen({ title: 'Classic Defense', sub: MAP.classic.name, wide: true, cls: 'map-box', back: mapMenu,
    body: `<div class="map-ways">${mapPicture(MAP.classic, 'big')}<div class="map-side">${CLASSIC_INTRO}</div></div>`
      + '<div class="ov-actions"><button class="wc-btn small" id="ov-back">Back</button></div>',
    primary: { label: 'Begin', run: beginClassic } });
  bindPictures();
  $('ov-back').onclick = mapMenu;
}
function beginClassic() {
  mode = 'classic'; started = true;
  resetView();
  hideOverlay();
  ui.announce('Defend the castle', 'The first level arrives in 30 seconds');
}
// Line Tower Wars takes the canvas; Classic's ground layer is made again when the menu comes back.
function enterLtw() { mode = 'ltw'; renderer.static = null; }
function computerSetup() {
  setupScreen({
    start: (setup) => { enterLtw(); ltw.start(setup); },
    back: ltwScreen,
  });
}

// ---------------------------------------------------------------- loops
let lastSim = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastSim) / 1000);
  lastSim = now;
  if (mode !== 'classic' || !started || paused || over) return;
  let left = dt * speed;
  while (left > 1e-6) { const h = Math.min(1 / 60, left); game.step(h); left -= h; }
}, 1000 / 60);

// Nothing is drawn while the page is hidden, and with the 30 fps cap (src/device.js, the menus' Frame rate) every other
// frame of a 60 Hz screen is skipped.
let lastFrame = performance.now();
function frame(now) {
  if (document.hidden || !frameDue(now, lastFrame)) { requestAnimationFrame(frame); return; }
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (mode === 'ltw') { ltw.frame(now, dt); requestAnimationFrame(frame); return; }
  const running = started && !paused && !over;
  const sdt = running ? dt * speed : 0;
  clock += sdt;
  // camera: arrow keys, zoom easing; the hover tile under a still mouse follows the map
  let dx = 0, dy = 0;
  if (keys.has('ArrowLeft')) dx--; if (keys.has('ArrowRight')) dx++;
  if (keys.has('ArrowUp')) dy--; if (keys.has('ArrowDown')) dy++;
  if ((dx || dy) && playing() && !screenShown()) cam.pan(dx * PAN * dt, dy * PAN * dt);
  if (cam.zooming) { cam.update(dt); zoomButtons(); }
  if (mouse) hoverMouse();
  for (const e of game.events) {
    fx.handle(e, renderer, game);
    ui.handle(e);
    if (e.type === 'won') showEnd(true);
    if (e.type === 'lost') showEnd(false);
  }
  game.events.length = 0;
  if (view.selected && view.selected.hp !== undefined && !game.creeps.includes(view.selected)) view.selected = null;
  if (view.selected && view.selected.def && view.selected.def.upgrades && !game.towers.includes(view.selected)) view.selected = null;
  fx.update(sdt, game, renderer);
  renderer.view(cam);
  renderer.draw(game, view, fx, clock, cam);
  ui.refresh();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    const assets = await loadAssets((k) => { $('ov-progress').firstElementChild.style.width = (k * 100).toFixed(0) + '%'; });
    renderer = new Renderer(canvas, assets);
    ui = new UI(game, renderer, actions);
    ltw = new LtwMode({ canvas, assets, onQuit: () => toMenu() });
    online = new Online({ ltw, menu: () => toMenu(), enterGame: enterLtw,
      playing: () => (mode === 'classic' ? started && !over : mode === 'ltw' && ltw.active) });
    fit();
    resetView();
    ui.refresh(true);
    toMenu();
    online.boot();
    requestAnimationFrame(frame);
    startApp(assets.urls);
  } catch (err) {
    console.error(err);
    $('ov-btn').textContent = 'Failed to load';
    $('ov-body').insertAdjacentHTML('beforeend', `<p style="color:#ff7a6a">${err.message}</p>`);
  }
})();

window.wc = { get game() { return mode === 'ltw' ? ltw.world : game; }, get view() { return mode === 'ltw' ? ltw.view : view; }, get fx() { return mode === 'ltw' ? ltw.fxs : fx; },
  get renderer() { return mode === 'ltw' ? ltw.renderer : renderer; }, get ui() { return mode === 'ltw' ? ltw.hud : ui; }, get actions() { return mode === 'ltw' ? ltw.actions : actions; },
  get mode() { return mode; }, get ltw() { return ltw; }, get session() { return ltw && ltw.session; }, get online() { return online; },
  get cam() { return mode === 'ltw' ? ltw.cam : cam; } };
