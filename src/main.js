// Entry point: loads the Blender sprites and shows the mode menu. Classic Defense runs its simulation on a timer and
// draws with requestAnimationFrame; vs Computer and vs Players (Line Tower Wars) are the LtwMode in src/client/ltw.js,
// and src/client/online.js holds the vs Players menu, join screens and lobby (an invite link #room=... opens it).
import { Game, TOWERS, LEVELS } from './game.js?v=c7bd234229c1';
import { buildable } from './level.js?v=c7bd234229c1';
import { loadAssets } from './assets.js?v=c7bd234229c1';
import { Renderer, W, H, P } from './render.js?v=c7bd234229c1';
import { FX } from './fx.js?v=c7bd234229c1';
import { UI } from './ui.js?v=c7bd234229c1';
import { SIN, TOP } from './level.js?v=c7bd234229c1';
import { LtwMode } from './client/ltw.js?v=c7bd234229c1';
import { Online } from './client/online.js?v=c7bd234229c1';
import { screen, hideScreen, modeMenu, setupScreen, TITLE } from './client/screens.js?v=c7bd234229c1';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const view = { selected: null, placing: null, hover: null, hoverTower: null, shift: false };
let game = new Game();
let fx = new FX();
let renderer, ui, ltw = null, online = null;
let mode = 'menu';   // 'menu' | 'classic' | 'ltw'
let speed = 1, paused = false, started = false, over = false, clock = 0;
// the start screen's text and key list (not the progress bar or the credit line), shown again before Classic begins
const CLASSIC_INTRO = [...$('ov-body').children].filter(e => (e.tagName === 'P' && !e.classList.contains('ov-credit')) || e.classList.contains('ov-keys'))
  .map(e => e.outerHTML).join('');

const actions = {
  view: () => view,
  place(def) {
    if (game.gold < def.cost) return ui.error('Not enough gold.');
    view.placing = def; view.selected = null; canvas.classList.add('placing');
  },
  cancel() { view.placing = null; canvas.classList.remove('placing'); },
  upgrade(t, id) {
    const def = TOWERS[id];
    if (t.building > 0) return ui.error('That tower is still being built.');
    if (game.gold < def.cost) return ui.error('Not enough gold.');
    game.upgrade(t, id);
  },
  sell(t) { game.sell(t); view.selected = null; },
  callNext() { if (game.phase === 'countdown') game.callNext(); },
  togglePause() { if (!started || over) return; paused = !paused; $('btn-pause').textContent = paused ? 'Resume' : 'Pause'; if (paused) showMenu(); else hideOverlay(); },
  setSpeed(n) { speed = n; for (const b of document.querySelectorAll('#speed button')) b.classList.toggle('on', +b.dataset.speed === n); },
  menu() { if (!started || over) return; paused = true; $('btn-pause').textContent = 'Resume'; showMenu(); },
};

// ---------------------------------------------------------------- layout
function fit() {
  if (mode === 'ltw') return ltw.fit();
  const st = $('stage').getBoundingClientRect();
  const k = Math.min(st.width / W, st.height / H);
  renderer.resize(Math.floor(W * k), Math.floor(H * k));
}

function toLogical(ev) {
  const r = canvas.getBoundingClientRect();
  return { lx: (ev.clientX - r.left) * W / r.width, ly: (ev.clientY - r.top) * H / r.height };
}

// ---------------------------------------------------------------- input (Classic; vs Computer binds its own)
canvas.addEventListener('mousemove', (ev) => {
  if (mode === 'ltw' || !renderer) return;
  const { lx, ly } = toLogical(ev);
  const c = Math.floor(lx / P), r = Math.floor((ly / P - TOP) / SIN);
  view.hover = { c, r };
  const hit = renderer.pick(game, lx, ly);
  view.hoverTower = hit.tower || null;
});
canvas.addEventListener('mouseleave', () => { view.hover = null; view.hoverTower = null; });
canvas.addEventListener('mousedown', (ev) => {
  if (mode !== 'classic' || !started || over) return;
  if (ev.button === 2) { if (view.placing) actions.cancel(); else view.selected = null; return; }
  const { lx, ly } = toLogical(ev);
  if (view.placing) {
    // the tile under this press (a press can arrive without a mousemove before it, e.g. a tap)
    const h = view.hover = { c: Math.floor(lx / P), r: Math.floor((ly / P - TOP) / SIN) };
    if (!buildable(h.c, h.r) || game.towerAt(h.c, h.r)) return ui.error("Can't build there.");
    if (game.gold < view.placing.cost) { ui.error('Not enough gold.'); return actions.cancel(); }
    const t = game.build(view.placing.id, h.c, h.r);
    if (t && !(ev.shiftKey || view.shift)) { actions.cancel(); view.selected = t; }
    ui.refresh(true);
    return;
  }
  const hit = renderer.pick(game, lx, ly);
  view.selected = hit.tower || hit.creep || null;
  ui.refresh(true);
});
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
window.addEventListener('keydown', (ev) => {
  if (mode === 'ltw') return;
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement) return;   // typing a name, a link, lobby chat
  if (ev.key === 'Shift') view.shift = true;
  if (!started) { if (ev.key === 'Enter' && $('ov-btn').style.display !== 'none' && !$('ov-btn').disabled) $('ov-btn').click(); return; }
  if (over) { if (ev.key === 'Enter') $('ov-btn').click(); return; }
  if (ev.key === 'F10' || (ev.key === 'Escape' && paused)) { ev.preventDefault(); return paused ? actions.togglePause() : actions.menu(); }
  if (paused) return;
  if (ev.key === 'Escape') { if (view.placing) actions.cancel(); else view.selected = null; return; }
  if (ev.key === 'p' || ev.key === 'P') return actions.togglePause();
  if (ev.key === '1' || ev.key === '2' || ev.key === '3') return actions.setSpeed(+ev.key);
  if (ev.key === ' ' || ((ev.key === 'n' || ev.key === 'N') && !view.placing)) { ev.preventDefault(); return actions.callNext(); }
  if (ev.key === 'Delete' && view.selected && view.selected.upgrades === undefined && view.selected.def.upgrades) return actions.sell(view.selected);
  if (ev.key.length === 1 && ui.hotkey(ev.key, view)) ev.preventDefault();
});
window.addEventListener('keyup', (ev) => { if (ev.key === 'Shift') view.shift = false; });
window.addEventListener('resize', () => { if (renderer) fit(); });

// ---------------------------------------------------------------- overlay screens
function hideOverlay() { hideScreen(); }
function showMenu() {
  screen({
    title: 'Paused', sub: `Level ${game.level} of ${LEVELS}`,
    body: `<ul class="ov-keys"><li><b>A</b> / <b>S</b> / <b>E</b> build towers. <b>Shift</b>-click keeps building.</li>
    <li>Select a tower for its upgrades (<b>Q W E R T</b>). <b>X</b> sells it.</li><li><b>N</b> or <b>Space</b> calls the next level. <b>1 2 3</b> set the speed.</li></ul>
    <div class="ov-actions"><button class="wc-btn small" id="ov-restart">Restart</button><button class="wc-btn small" id="ov-quit">Main menu</button></div>`,
    primary: { label: 'Resume', run: () => actions.togglePause() },
  });
  $('ov-restart').onclick = () => restart();
  $('ov-quit').onclick = () => toMenu();
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
  game = new Game(); fx = new FX(); ui.g = game; view.selected = null; actions.cancel();
  over = false; paused = false; started = true; clock = 0;
  $('btn-pause').textContent = 'Pause';
  hideOverlay(); ui.lastInfo = ''; ui.refresh(true);
}

// ---------------------------------------------------------------- modes
// The topbar buttons belong to whichever mode is running.
function bindClassicTopbar() {
  $('btn-pause').onclick = () => actions.togglePause();
  $('btn-menu').onclick = () => actions.menu();
  for (const b of document.querySelectorAll('#speed button')) b.onclick = () => actions.setSpeed(+b.dataset.speed);
  actions.setSpeed(speed);
}
function toMenu() {
  if (mode === 'ltw') ltw.stop();
  mode = 'menu';
  game = new Game(); fx = new FX(); ui.g = game; view.selected = null; actions.cancel();
  over = false; paused = false; started = false; clock = 0;
  $('btn-pause').textContent = 'Pause'; $('msgs').innerHTML = '';
  bindClassicTopbar();
  fit();
  ui.lastInfo = ''; ui.refresh(true);
  modeMenu({ classic: classicIntro, computer: computerSetup, players: () => online.menu() });
  online.resume();   // an invite link opened during the game that just ended
}
function classicIntro() {
  screen({ title: TITLE, sub: 'Classic Defense', body: CLASSIC_INTRO + '<div class="ov-actions"><button class="wc-btn small" id="ov-back">Back</button></div>',
    primary: { label: 'Begin', run: beginClassic } });
  $('ov-back').onclick = () => toMenu();
}
function beginClassic() {
  mode = 'classic'; started = true;
  hideOverlay();
  ui.announce('Defend the castle', 'The first level arrives in 30 seconds');
}
function computerSetup() {
  setupScreen({
    start: (setup) => { mode = 'ltw'; ltw.start(setup); },
    back: () => toMenu(),
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

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (mode === 'ltw') { ltw.frame(now, dt); requestAnimationFrame(frame); return; }
  const running = started && !paused && !over;
  const sdt = running ? dt * speed : 0;
  clock += sdt;
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
  renderer.draw(game, view, fx, clock);
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
    online = new Online({ ltw, menu: () => toMenu(), enterGame: () => { mode = 'ltw'; },
      playing: () => (mode === 'classic' ? started && !over : mode === 'ltw' && ltw.active) });
    fit();
    ui.refresh(true);
    toMenu();
    online.boot();
    requestAnimationFrame(frame);
  } catch (err) {
    console.error(err);
    $('ov-btn').textContent = 'Failed to load';
    $('ov-body').insertAdjacentHTML('beforeend', `<p style="color:#ff7a6a">${err.message}</p>`);
  }
})();

window.wc = { get game() { return mode === 'ltw' ? ltw.world : game; }, get view() { return mode === 'ltw' ? ltw.view : view; }, get fx() { return mode === 'ltw' ? ltw.fxs : fx; },
  get renderer() { return mode === 'ltw' ? ltw.renderer : renderer; }, get ui() { return mode === 'ltw' ? ltw.hud : ui; }, get actions() { return mode === 'ltw' ? ltw.actions : actions; },
  get mode() { return mode; }, get ltw() { return ltw; }, get session() { return ltw && ltw.session; }, get online() { return online; } };
