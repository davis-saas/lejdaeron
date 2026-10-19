// The overlay dialogs: the map picker (the start screen: the maps as pictures), a map's screen with the ways to play
// it, the vs Computer setup and a helper every mode uses for its pause and end screens. They all reuse the one dialog
// in index.html (#overlay: crest, h1, .ov-sub, #ov-body and #ov-foot with the main #ov-btn). The body scrolls when the
// window is too short for it; the dialog's own buttons stay in view under it. On the menu screens the arrow keys move
// between the cards and the mode buttons, Enter presses the one in focus and Esc goes back.
import { PLAYER_HEX, PLAYER_TEXT, DIFFICULTIES, DIFF_NAME } from './common.js?v=3947ef6d39d3';
import { LTW_COLORS, LTW_RULES } from '../data/ltw.js?v=3947ef6d39d3';
import { LIGHT, capped, setCapped } from '../device.js?v=3947ef6d39d3';
import { appHint, bindAppHint } from './app.js?v=3947ef6d39d3';
import { MAPS, MAP, playable, previewUrl } from './maps.js?v=3947ef6d39d3';

const $ = (id) => document.getElementById(id);
const box = () => document.querySelector('.ov-box');
// The page's own title and credit line (tools/publish.mjs swaps in the public name and adds the credits).
export const TITLE = document.querySelector('.ov-box h1').textContent;
const CREDIT = document.querySelector('.ov-credit') ? document.querySelector('.ov-credit').outerHTML : '';
const SETUP_KEY = 'lejdaeron.vsComputer';
const MAX_BOTS = 7;

// screen({ title, sub, body, primary: { label, run, disabled }, wide, cls, back }) shows the dialog; buttons in `body`
// are wired by the caller after it returns. cls: an extra class for the box (the lobby's is wider still). back: what Esc
// does (the screen's Back button), on screens that have a way back.
let onEsc = null;
export function screen({ title, sub = '', body = '', primary = null, wide = false, cls = '', back = null }) {
  onEsc = back;
  $('overlay').classList.add('show');
  box().className = 'ov-box' + (wide ? ' wide' : '') + (cls ? ' ' + cls : '');
  box().querySelector('h1').textContent = title;
  box().querySelector('.ov-sub').textContent = sub;
  $('ov-body').innerHTML = body;
  // the body's own row of buttons (its last .ov-actions) and the lobby's .ov-foot go into the foot, above #ov-btn
  const foot = $('ov-foot'), b = $('ov-btn');
  for (const e of [...foot.children]) if (e !== b) e.remove();
  for (const e of $('ov-body').querySelectorAll(':scope > .ov-actions:last-child, .ov-foot')) foot.insertBefore(e, b);
  b.style.display = primary ? '' : 'none';
  if (primary) { b.textContent = primary.label; b.disabled = !!primary.disabled; b.onclick = primary.run; }
  else b.onclick = null;
  if (keyboard) navFocus();
}
export function hideScreen() { $('overlay').classList.remove('show'); onEsc = null; }
export const screenShown = () => $('overlay').classList.contains('show');

// ---------------------------------------------------------------- keys on the menu screens
// The arrow keys move the focus to the nearest card or mode button ([data-nav]) that way; the first press, or a new
// screen while the keys are in use, puts it on the screen's first one (or the map or the way to play picked last, so
// Esc and Enter go back and forth). Enter presses it, as it presses any button; Esc does what the screen's Back does. A
// press of the mouse or a finger ends the keys' turn.
let keyboard = false, lastMap = null, lastMode = null;
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const typing = (t) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
function navItems() { return [...$('ov-body').querySelectorAll('[data-nav]')].filter(b => !b.disabled); }
const pickedLast = (b) => (b.dataset.map ? b.dataset.map === lastMap : b.dataset.mode === lastMode);
function navFocus() {
  const items = navItems(), b = items.find(pickedLast) || items[0];
  if (b && !items.includes(document.activeElement)) b.focus({ preventScroll: true });
}
function navStep([dx, dy]) {
  const items = navItems(), cur = document.activeElement;
  if (!items.includes(cur)) return navFocus();
  const r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bestD = Infinity;
  for (const b of items) {
    const q = b.getBoundingClientRect(), x = q.left + q.width / 2 - cx, y = q.top + q.height / 2 - cy;
    const along = x * dx + y * dy, across = Math.abs(x * dy - y * dx);
    if (b === cur || along < 8) continue;
    if (along + 2 * across < bestD) { bestD = along + 2 * across; best = b; }
  }
  if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
}
window.addEventListener('pointerdown', () => { keyboard = false; }, true);
window.addEventListener('keydown', (ev) => {
  if (!screenShown() || ev.defaultPrevented) return;
  if (ev.key === 'Escape' && onEsc) { ev.preventDefault(); onEsc(); return; }
  if (ev.key === 'Tab' || ev.key === 'Enter') keyboard = true;
  const d = ARROWS[ev.key];
  if (!d || typing(ev.target) || !navItems().length) return;
  ev.preventDefault();
  keyboard = true;
  navStep(d);
});

// The pause menus' settings, at the top of the menu (above the help, which may scroll): the frame rate (src/device.js;
// 30 saves battery, the default on a phone), where the light set is loaded (phones, tablets, computers with little
// memory) or 30 is on; a computer's menus stay as they were. bindSettings() wires it after screen().
const fpsLabel = () => `Frame rate: ${capped() ? '30 (saves battery)' : '60'}`;
export const settingsLine = () => (!LIGHT && !capped() ? ''
  : `<div class="ov-settings"><button class="wc-btn small" id="ov-fps" aria-pressed="${capped()}" title="30 frames a second save battery and heat on a phone">${fpsLabel()}</button></div>`);
export function bindSettings() {
  const b = $('ov-fps');
  if (b) b.onclick = () => { setCapped(!capped()); b.textContent = fpsLabel(); b.setAttribute('aria-pressed', String(capped())); };
}

// ---------------------------------------------------------------- the map picker
// The start screen: one card per map (src/client/maps.js), its picture first, its name and players under it. A playable
// map's card leads to the ways to play it (pick(map)); a locked one says "Coming later", can't be pressed and starts
// nothing.
export function mapPicker({ pick }) {
  screen({
    title: TITLE, sub: 'Choose a map', cls: 'picker',
    body: `<div class="maps">${MAPS.map(mapCard).join('')}</div>${appHint()}${CREDIT}`,
  });
  bindAppHint();
  bindPictures();
  for (const b of document.querySelectorAll('#ov-body .map-card')) {
    const m = MAP[b.dataset.map];
    if (playable(m)) b.onclick = () => { lastMap = m.id; pick(m); };
  }
}
function mapCard(m) {
  const open = playable(m);
  return `<button class="map-card${open ? '' : ' locked'}" data-map="${m.id}" data-nav ${open ? '' : 'disabled'} aria-label="${m.name}, ${m.players}${open ? '' : ', coming later'}">
    ${mapPicture(m)}<span class="map-cap"><b>${m.name}</b><em>${m.players}</em></span></button>`;
}
// A map's picture in the minimap's frame; until it exists (or if it fails to load) an empty map. A picture of another
// shape than the frame's 2:1 is shown whole (bindPictures, after screen()). cls: 'big' on a map's own screen, 'thumb'
// on the join screen and in the lobby.
export function mapPicture(m, cls = '') {
  return `<span class="map-pic${cls ? ' ' + cls : ''}"><img src="${previewUrl(m)}" alt="" draggable="false">${playable(m) ? '' : '<span class="map-lock">Coming later</span>'}</span>`;
}
export function bindPictures(root = $('ov-body')) {
  for (const img of root.querySelectorAll('.map-pic img')) {
    const pic = img.parentElement;
    const shown = () => {
      pic.classList.toggle('none', !img.naturalWidth);
      pic.classList.toggle('fit', !!img.naturalWidth && Math.abs(img.naturalWidth / img.naturalHeight - 2) > 0.2);
    };
    if (img.complete) shown();
    else { img.onload = shown; img.onerror = shown; }
  }
}

// A map's screen: its picture and what it is, then one button per way to play it (run[mode id]; a mode without one
// shows disabled). Back and Esc call back (the picker).
export function mapScreen(m, { run, back }) {
  screen({
    title: m.name, sub: 'Choose how to play', wide: true, cls: 'map-box', back,
    body: `<div class="map-ways">${mapPicture(m, 'big')}
        <div class="map-side"><p class="map-about">${m.about}</p>
          <div class="modes">${m.modes.map(d => `<button class="mode" data-mode="${d.id}" data-nav ${run[d.id] ? '' : 'disabled'}><b>${d.name}</b><span>${d.text}</span></button>`).join('')}</div></div>
      </div>
      <div class="ov-actions"><button class="wc-btn small" id="ov-back">Back</button></div>`,
  });
  bindPictures();
  for (const b of document.querySelectorAll('#ov-body .mode')) b.onclick = () => { const f = run[b.dataset.mode]; if (f) { lastMode = b.dataset.mode; f(); } };
  $('ov-back').onclick = back;
}

// ---------------------------------------------------------------- vs Computer setup
export function loadSetup() {
  try {
    const s = JSON.parse(localStorage.getItem(SETUP_KEY) || 'null');
    if (s && Array.isArray(s.bots) && s.bots.length >= 1 && s.bots.length <= MAX_BOTS) return { bots: s.bots.map(d => (DIFFICULTIES.includes(d) ? d : 'normal')) };
  } catch { /* storage blocked: use the default */ }
  return { bots: ['normal'] };
}
function saveSetup(setup) { try { localStorage.setItem(SETUP_KEY, JSON.stringify(setup)); } catch { /* not kept */ } }

// The human is Red (slot 1); bots take slots 2, 3 and so on.
export function slotsFor(setup) {
  return [{ slot: 1, name: LTW_COLORS[1], kind: 'human' },
    ...setup.bots.map((d, i) => ({ slot: i + 2, name: LTW_COLORS[i + 2], kind: 'bot', difficulty: d }))];
}

export function setupScreen({ start, back }) {
  const setup = loadSetup();
  let shown = false;
  const render = () => {
    const top = shown ? $('ov-body').scrollTop : 0;   // a change keeps the list where it was (it scrolls on a phone)
    shown = true;
    let rows = `<div class="seat"><i class="sw" style="background:${PLAYER_HEX[1]}"></i><b style="color:${PLAYER_TEXT[1]}">${LTW_COLORS[1]}</b><span class="who">You</span></div>`;
    setup.bots.forEach((d, i) => {
      const slot = i + 2;
      rows += `<div class="seat" data-i="${i}"><i class="sw" style="background:${PLAYER_HEX[slot]}"></i><b style="color:${PLAYER_TEXT[slot]}">${LTW_COLORS[slot]}</b>
        <span class="diffs">${DIFFICULTIES.map(k => `<button data-d="${k}" class="${k === d ? 'on' : ''}">${DIFF_NAME[k]}</button>`).join('')}</span>
        <button class="rm" title="Remove this computer" ${setup.bots.length <= 1 ? 'disabled' : ''}>✕</button></div>`;
    });
    screen({
      title: 'vs Computer', sub: 'Line Tower Wars', wide: true,
      body: `<div class="setup">${rows}
          <div class="seat-tools">
            <button class="wc-btn small" id="su-add" ${setup.bots.length >= MAX_BOTS ? 'disabled' : ''}>Add computer</button>
            <span class="diffs all"><em>All</em>${DIFFICULTIES.map(k => `<button data-d="${k}">${DIFF_NAME[k]}</button>`).join('')}</span>
          </div>
        </div>
        <p class="setup-note">Everyone starts with ${LTW_RULES.startGold} gold, ${LTW_RULES.startIncome} income and ${LTW_RULES.startLives} lives, and income is paid every
          ${LTW_RULES.incomeInterval} seconds. Sending creeps to the next player raises your income (a few of the strongest lower it). A creep
          that gets through steals a life for its sender, then walks on into the next lane. The last player standing wins.</p>
        <div class="ov-actions"><button class="wc-btn small" id="su-back">Back</button></div>`,
      primary: { label: 'Start', run: () => { saveSetup(setup); start({ bots: setup.bots.slice() }); } }, back,
    });
    $('ov-body').scrollTop = top;
    for (const row of document.querySelectorAll('#ov-body .seat[data-i]')) {
      const i = +row.dataset.i;
      for (const b of row.querySelectorAll('.diffs button')) b.onclick = () => { setup.bots[i] = b.dataset.d; render(); };
      row.querySelector('.rm').onclick = () => { if (setup.bots.length > 1) { setup.bots.splice(i, 1); render(); } };
    }
    for (const b of document.querySelectorAll('#ov-body .diffs.all button')) b.onclick = () => { setup.bots = setup.bots.map(() => b.dataset.d); render(); };
    $('su-add').onclick = () => { if (setup.bots.length < MAX_BOTS) { setup.bots.push(setup.bots[setup.bots.length - 1] || 'normal'); render(); } };
    $('su-back').onclick = back;
  };
  render();
}

