// The Line Tower Wars screen (vs Computer and vs Players): it runs one session (src/session_local.js, or an online one
// from src/net/session.js with the same contract), the stacked-lane renderer, an effects layer per lane, the camera,
// the console, the chat line and the input, and shows the pause and end screens. It reads the world only through the
// fields in docs/SPEC-client.md. Online there is no pause, speed or restart; the host streams the lane in the middle of
// the view at full rate (the 'watch' command follows the camera), the top bar shows the ping and who is connected, and a
// banner shows while the host doesn't answer. The lobby and the screens after a lost connection are src/client/online.js.
// A finger plays it too (src/client/touch.js): taps, long presses for what hovering shows, one finger to pan, two to
// pinch, and buttons over the view for the zoom and the jumps that F1 and F2 make.
import { createLocalSession } from '../session_local.js?v=3947ef6d39d3';
import { FX } from '../fx.js?v=3947ef6d39d3';
import { P, sx, sy } from '../render.js?v=3947ef6d39d3';
import { SIN, TOP } from '../level.js?v=3947ef6d39d3';
import { LTW_UNITS, LTW_RULES, LTW_TECH } from '../data/ltw.js?v=3947ef6d39d3';
import { Camera } from './camera.js?v=3947ef6d39d3';
import { Gestures, isTouch, lastInput, clickWord } from './touch.js?v=3947ef6d39d3';
import { LaneRenderer } from './lanes.js?v=3947ef6d39d3';
import { LtwHud, TECH_TAB, mapClock } from './hud.js?v=3947ef6d39d3';
import { screen, hideScreen, screenShown, slotsFor, settingsLine, bindSettings } from './screens.js?v=3947ef6d39d3';
import { LIGHT, pixelRatio } from '../device.js?v=3947ef6d39d3';
import { LANE_PITCH, LANE_X0, LANE_X1, LANE_Y0, LANE_Y1, laneDY, laneOrder, techArea, PLAYER_HEX, PLAYER_TEXT, DIFF_NAME, esc, ordinal, short, botNamed } from './common.js?v=3947ef6d39d3';

const $ = (id) => document.getElementById(id);
const PAN = 1100;          // css px per second for the arrow keys and the screen edges
const EDGE = 6;            // px from the window edge that pans the view
const DRAG = 4;            // px a right or middle press moves before it counts as a drag
const OUT_DELAY = 2500;    // ms between your elimination and the defeat screen
const MAX_FX_PARTS = LIGHT ? 250 : 700;  // particles per lane (the light set: phones)
const CROSSING = 3;        // seconds a selected creep that leaked is looked for in the next lane (it waits 1 s between)
const INSETS = { top: 20, bottom: 14 };   // css px of the view that the top bar and the console ornaments cover
const MSG_LEFT = 16;       // css px: the map messages' left edge, moved past the spawn waygate while it is in view
const REPEAT_EVERY = 100;  // ms between the presses a held command-card key repeats (online the host takes 12 a second)
const LOST_WAIT = 1000;    // ms a tower of mine found gone waits for its 'destroyed' event (which names the attacker)
const REPLY_WAIT = 1500;   // ms the answer to a chat command waits for the chat line itself to show (online)

// The menu's help: a touch screen shows its own lines and the ones for everyone, not the keys (style.css)
const keysHelp = (online) => `<ul class="ov-keys">
  <li class="touch-keys">On a touch screen: tap a button or a unit. To build, tap a spot in your lane, then tap it again; always leave the creeps a path. Drag to move the view, pinch to zoom, hold a button or a unit for its details. The buttons at the edge of the view zoom and show your lane and the lane your creeps go to.</li>
  <li class="mouse-keys"><b>Q</b> <b>W</b> <b>E</b> build Archer, Sharp or Elemental towers in your lane. <b>Shift</b> (or the Keep building button) keeps building. Always leave the creeps a path.</li>
  <li class="mouse-keys">Select a tower for its upgrades. <b>X</b> sells it.</li>
  <li class="mouse-keys"><b>Tab</b> switches between Build, the three shrines, Tech and the Arcade. The grid keys <b>Q W E R</b> / <b>A S D F</b> / <b>Z X C V</b> send creeps to the next player.</li>
  <li><b>Tech</b> turns a wisp into an element building, which unlocks tower upgrades. The <b>Arcade</b> sells lumber and trains more wisps.</li>
  <li class="mouse-keys">Pan with the arrow keys, the screen edges or a right or middle drag, zoom with the wheel or the <b>+</b> <b>−</b> by the minimap. <b>Home</b> or <b>F1</b> shows your lane, <b>F2</b> the lane your creeps go to.</li>
  <li class="mouse-keys"><b>Enter</b> opens the chat line. <b>-help</b> lists the chat commands: <b>-income</b>, <b>-destroy</b>, <b>-onextra</b>, <b>-offextra</b> and <b>-kick</b> <i>colour</i>.</li>
  <li class="touch-keys">The <b>Chat</b> button opens the chat line. <b>-help</b> lists the chat commands: <b>-income</b>, <b>-destroy</b>, <b>-onextra</b>, <b>-offextra</b> and <b>-kick</b> <i>colour</i>.</li>
  <li class="mouse-keys">${online ? '<b>F10</b> opens this menu. An online game has no pause.' : '<b>P</b> pauses, <b>1</b> <b>2</b> <b>3</b> set the speed, <b>F10</b> opens this menu.'}</li>
</ul>`;

export class LtwMode {
  constructor({ canvas, assets, onQuit }) {
    this.canvas = canvas; this.assets = assets; this.onQuit = onQuit;
    this.renderer = null; this.session = null; this.active = false;
    this.keys = new Set(); this.mouse = null; this.ptr = null; this.edgeOk = false; this.drag = null; this.mmDrag = false;
    this.touch = null;   // logical px under the last finger, where there is no mouse (placing: the tower's spot)
    this.armed = null;   // { X, Y, slot, c, r }: the spot a finger picked for the tower (a second tap there builds it)
    this.listeners = []; this.focus = null;
    this.actions = {
      view: () => this.view,
      place: (def) => this.place(def),
      cancel: () => { this.view.placing = null; this.armed = null; this.canvas.classList.remove('placing'); this.hud.hint(''); },
      keep: () => { this.view.keep = !this.view.keep; },   // keep building: Shift for a pointer without a keyboard
      upgrade: (t, id) => this.cmd({ type: 'upgrade', tower: t.id, id }),
      sell: (t) => this.cmd({ type: 'sell', tower: t.id }),
      send: (unit) => this.cmd({ type: 'send', unit }),
      tech: (id) => this.cmd({ type: 'tech', id }),
      arcade: (item) => this.cmd({ type: 'arcade', item }),
      destroy: (o) => this.destroy(o),
      togglePause: () => this.togglePause(),
      setSpeed: (n) => this.setSpeed(n),
      menu: () => this.pauseMenu(),
    };
  }
  get world() { return this.session.world; }

  // ---------------------------------------------------------------- lifecycle
  // setup: { bots: ['easy' | 'normal' | 'hard' | 'insane', ...] } from the vs Computer screen
  start(setup) {
    this.setup = setup;
    this.attach(createLocalSession({ slots: slotsFor(setup) }));
  }
  // Takes over the screen for a session that follows the session contract. online (vs Players, src/client/online.js):
  // { room, link, isHost, onEnd(info) }, onEnd called when the session ends for another reason than the match's end
  // (the host left, a kick, a lost connection), after this screen has stopped.
  attach(session, { online = null } = {}) {
    this.renderer ||= new LaneRenderer(this.canvas, this.assets);
    this.session = session; this.me = session.me; this.online = online;
    this.watched = null; this.netInfo = null; this.lostSince = null; this.leaving = false; this.inMenu = false;
    const w = session.world, me = this.me;
    this.order = laneOrder(w, me);
    this.index = new Map(this.order.map((s, i) => [s, i]));
    this.fxs = {};
    for (const s of this.order) this.fxs[s] = new FX({ lane: true, maxParts: MAX_FX_PARTS });
    this.inView = new Set();
    this.view = { me, target: null, feeder: null, sel: null, placing: null, hover: null, hoverTower: null, hoverSlot: null, shift: false,
      keep: false, insets: INSETS, avoid: null, timer: null };
    this.stats = { sent: 0, sentGold: 0, peakIncome: w.players[me] ? w.players[me].income : 0, out: [] };
    this.clock = 0; this.overT = 0; this.lastTime = w.time; this.outAt = null; this.shownOut = false; this.shownEnd = false;
    this.mine = new Map();        // my towers by id last frame: one that vanished destroyed is announced
    this.lost = new Map();        // id -> { t, told, at }: my towers that fell, announced once
    this.destroying = new Set();  // tower ids I asked to destroy (their loss needs no attacker)
    this.said = [];               // my chat lines on their way: { reply, at } (a command's answer shows after its line)
    this.repeatAt = 0;
    this.msgLeft = -1;
    this.cam = new Camera();
    document.body.classList.add('ltw');
    $('msgs').innerHTML = '';
    this.fit(true);
    // room above the first lane for the tree tops on its north border (the renderer fills it with a forest fringe)
    this.cam.setBounds(sx(LANE_X0) - P, sy(LANE_Y0) - P * 1.7, sx(LANE_X1) + P, laneDY(this.order.length - 1) + sy(LANE_Y1) + P * 0.5);
    this.cam.setLevel(1);
    this.zoomButtons();
    this.jumpTo(me, true);
    this.hud = new LtwHud(this);
    this.padForBoard();
    session.on('error', (e) => { if (this.active && e && e.message) this.hud.message(esc(e.message), '#ff7a6a'); });
    session.on('chat', (c) => {
      if (!this.active || !c) return;
      this.hud.chat(c);
      if (c.slot === this.me && this.said.length) { const x = this.said.shift(), f = x.reply; x.reply = null; if (f) f(); }
    });
    document.body.classList.toggle('online', !!online);
    if (online) {
      session.on('net', (n) => { if (this.active) { this.netInfo = n; this.renderNet(); } });
      session.on('end', (e) => { if (this.active && e && e.reason !== 'over') { this.stop(); online.onEnd(e); } });
      this.renderNet();
    }
    this.closeChat();
    this.bind();
    this.active = true;
    hideScreen();
    this.setSpeed(1);
    $('btn-pause').textContent = 'Pause';
    $('btn-speed').onclick = () => this.setSpeed((this.session.speed || 1) % 3 + 1);
    this.roles();
    const to = this.view.target;
    this.hud.announce('Line Tower Wars', to !== null ? `Build a maze. Your creeps go to ${w.players[to].name}.` : 'Build a maze.');
    this.hud.message(lastInput() === 'touch' ? 'The <b>Menu</b> button has the controls.' : 'Press <b>F10</b> for the menu and the keys.', '#b9ad94');
    this.hud.refresh(true);
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    this.closeChat();
    this.unbind();
    if (this.session) this.session.close();
    if (this.hud) { this.hud.hideTip(); this.hud.hint(''); }
    this.touch = null; this.armed = null;
    $('msgs').innerHTML = ''; $('msgs').style.left = ''; $('income-list').classList.remove('show');
    $('announce').classList.remove('show'); $('error').classList.remove('show'); $('net-banner').classList.remove('show');
    if ($('prep-timer')) $('prep-timer').classList.remove('show');
    document.body.classList.remove('ltw', 'online', 'prep');
    this.canvas.classList.remove('placing');
    this.keys.clear(); this.drag = null; this.mmDrag = false;
  }
  // The view fills the stage (src/main.js calls this whenever the stage changes size; force: the canvas was Classic's).
  // A new size clears the canvas, so it is drawn again at once rather than a frame later.
  fit(force = false) {
    const st = $('stage').getBoundingClientRect(), r = this.renderer;
    const resized = force || Math.floor(st.width) !== r.vw || Math.floor(st.height) !== r.vh || pixelRatio() !== r.dpr;
    if (resized) r.resize(st.width, st.height);
    this.cam.setView(r.vw, r.vh);
    if (resized && this.active) this.draw();
    if (this.hud) { this.hud.lastInfo = ''; this.padForBoard(); }   // the info panel fits its content to the new size
  }
  draw() { this.renderer.draw(this.world, this.order, this.cam, this.view, this.fxs, this.world.time + this.overT); }

  // ---------------------------------------------------------------- commands
  cmd(op) {
    return this.session.command(op).then((r) => {
      if (!r.ok && r.why) this.hud.error(r.why);
      if (this.active) this.hud.refresh(true);
      return r;
    });
  }
  place(def) {
    const p = this.world.players[this.me];
    if (!p.alive) return this.hud.error('You have been eliminated.');
    if (p.gold < def.cost) return this.hud.error('Not enough gold.');
    this.view.placing = def; this.view.sel = null; this.armed = null; this.canvas.classList.add('placing');
    if (lastInput() === 'touch') this.hud.hint('Tap a spot in your lane, then tap it again to build.');
    this.hover();
  }
  build(keep) {
    const h = this.view.hover, def = this.view.placing;
    if (!h || !def) return;
    if (h.slot !== this.me) return this.hud.error("Can't build there.");
    this.session.command({ type: 'build', id: def.id, c: h.c, r: h.r }).then((r) => {
      if (!this.active) return;
      if (!r.ok) { this.hud.error(r.why); if (r.why === 'Not enough gold.') this.actions.cancel(); return; }
      if (!(keep || this.view.shift || this.view.keep)) {
        this.actions.cancel();
        const t = this.world.lanes[this.me].towers.find(t => t.id === r.tower);
        if (t) this.view.sel = { slot: this.me, o: t };
      } else if (!this.mouse && this.touch) {   // a finger keeps building: the next tap picks the next spot
        this.touch = null; this.armed = null; this.hover();
        this.hud.hint('Tap the next spot.');
      }
      this.hud.refresh(true);
    });
  }
  // Destroy (the command card's, after its confirmation): no refund, as '-destroy'.
  destroy(o) {
    if (!o) return;
    if (o.def.tech) return this.cmd({ type: 'destroy', tech: [o.techId] });
    this.destroying.add(o.id);
    return this.cmd({ type: 'destroy', tower: o.id });
  }

  // ---------------------------------------------------------------- chat
  // WC3's chat line: Enter (or the Chat button) opens it, Enter sends, Escape cancels. A line goes through the
  // session as {type: 'chat'}, so the map's chat commands run; '-destroy' takes the current selection with it.
  openChat() {
    if (!this.active || screenShown()) return;
    const box = $('chat'), input = $('chat-in');
    box.classList.add('open'); $('msgs').classList.add('chatting');
    input.value = '';
    input.focus();
  }
  closeChat() {
    const box = $('chat'), input = $('chat-in');
    box.classList.remove('open'); $('msgs').classList.remove('chatting');
    if (document.activeElement === input) input.blur();
  }
  get chatting() { return $('chat').classList.contains('open'); }
  sendChat() {
    const text = $('chat-in').value;
    this.closeChat();
    if (!text.trim()) return;
    const op = { type: 'chat', text }, s = this.view.sel;
    if (s && s.slot === this.me && s.o.def.upgrades) op.towers = [s.o.id];
    if (s && s.slot === this.me && s.o.def.tech) op.tech = [s.o.techId];
    if (op.towers && /^-destroy$/i.test(text)) for (const id of op.towers) this.destroying.add(id);
    // The line comes back as a 'chat' event; online that is when the world clock reaches it, after the command's
    // answer, so a note about the command waits for its line (or REPLY_WAIT at most).
    const line = { reply: null, at: performance.now() };
    if (this.session.kind !== 'local') { this.said = this.said.filter(x => line.at - x.at < 3 * REPLY_WAIT); this.said.push(line); }
    this.session.command(op).then((r) => {
      if (!this.active) return;
      if (!r.ok) {   // no line comes
        const i = this.said.indexOf(line);
        if (i >= 0) this.said.splice(i, 1);
        if (r.why) this.hud.error(r.why);
        return;
      }
      const note = (html) => {
        const show = () => { if (this.active) this.hud.message(html, '#b9ad94'); };
        if (!this.said.includes(line)) return show();   // the line is already there
        line.reply = show;
        setTimeout(() => { if (line.reply) { line.reply = null; show(); } }, Math.max(0, REPLY_WAIT - (performance.now() - line.at)));
      };
      if (r.command === 'destroy' && !r.destroyed) note('-destroy destroys the tower or tech building you have selected.');
      if (r.command === 'onextra') {
        const x = this.world.extra, o = x && x.on && x.slot !== this.me ? this.world.players[x.slot] : null;
        if (o) note(`${esc(o.name)} already has -onextra.`);
        else if (this.world.options && this.world.options.extra === false) note('-onextra is off in this game.');
      }
      this.hud.refresh(true);
    });
  }

  togglePause() {
    if (!this.active || this.session.kind !== 'local' || this.world.phase === 'over') return;
    if (this.session.paused) this.resume(); else this.pauseMenu();
  }
  pauseMenu() {
    if (!this.active) return;
    if (this.world.phase === 'over') { if (this.shownEnd) this.endScreen(true); return; }   // the end screen, closed to look around
    this.closeChat();
    const local = this.session.kind === 'local', on = this.online;
    if (local) this.session.paused = true;
    $('btn-pause').textContent = 'Resume';
    const quit = !on ? 'Quit to menu' : on.isHost ? 'End the game' : 'Leave the game';
    this.inMenu = true;   // online there is no pause: Esc and F10 still close the menu
    screen({
      title: local ? 'Paused' : 'Menu', sub: `${local ? 'vs Computer' : `vs Players · Room ${on ? on.room : ''}`} · ${this.world.phase === 'prep' ? 'build phase' : mapClock(this.world)}`,
      body: `${settingsLine()}${keysHelp(!local)}${on ? `<p class="ov-note" id="ov-quit-note">${on.isHost ? 'Your browser runs this match: if you leave, it ends for everyone.' : `If you leave, your lane is out of the game. A dropped connection keeps your seat for ${LTW_RULES.reconnectGrace} seconds: open the invite link again to get back in.`}</p>` : ''}
        <div class="ov-actions">${local ? '<button class="wc-btn small" id="ov-restart">Restart</button>' : ''}<button class="wc-btn small" id="ov-quit">${quit}</button></div>`,
      primary: { label: 'Resume', run: () => this.resume() },
    });
    if (local) $('ov-restart').onclick = () => this.restart();
    bindSettings();
    // online, leaving asks again (it can't be undone)
    $('ov-quit').onclick = () => {
      if (!on || this.leaving) return this.quit();
      this.leaving = true;
      $('ov-quit').textContent = `${clickWord()} again to ${quit[0].toLowerCase() + quit.slice(1)}`;
      $('ov-quit').classList.add('armed');
    };
  }
  resume() {
    this.leaving = false; this.inMenu = false;
    if (this.session.kind === 'local') this.session.paused = false;
    $('btn-pause').textContent = 'Pause';
    hideScreen();
  }
  setSpeed(n) {
    if (this.session.kind === 'local') this.session.speed = n;
    for (const b of document.querySelectorAll('#speed button')) b.classList.toggle('on', +b.dataset.speed === n);
    $('btn-speed').textContent = n + 'x';
  }
  restart() { const setup = this.setup; this.stop(); this.start(setup); }
  quit() { this.stop(); this.onQuit(); }

  // ---------------------------------------------------------------- camera
  laneCenterY(i) { return laneDY(i) + sy(LANE_Y0 + (LANE_Y1 - LANE_Y0) / 2 - 0.3); }
  // How far the camera may pan past the lanes' east end: the scoreboard's width (as it is now, folded or not), so
  // nothing has to stay under it.
  padForBoard() {
    const view = this.canvas.getBoundingClientRect(), r = $('board').getBoundingClientRect();
    this.cam.setPadRight(r.width ? view.right - r.left + 8 : 0);
  }
  jumpTo(slot, first = false) {
    const i = this.index.get(slot);
    if (i === undefined) return;
    this.cam.center(first ? sx((LANE_X0 + LANE_X1) / 2) : this.cam.x, this.laneCenterY(i));
    this.focus = slot;   // the lane asked for, even where the camera stops short of centring it (the first lane)
    this.hover();
  }
  // The lane last jumped to until the view is moved by hand, else the lane in the middle of the view.
  viewedSlot() {
    if (this.focus !== null) return this.focus;
    const yw = (this.cam.y / P - TOP) / SIN;
    const i = Math.max(0, Math.min(this.order.length - 1, Math.floor((yw - LANE_Y0) / LANE_PITCH)));
    return this.order[i];
  }
  // Who my creeps go to and who sends to me (both change as players drop out; neither once I am out).
  roles() {
    const w = this.world, me = this.me, alive = !!(w.players[me] && w.players[me].alive), to = alive ? w.next(me) : null;
    this.view.target = to !== null && to !== me ? to : null;
    this.view.feeder = alive ? w.ring.find(s => s !== me && w.players[s].alive && w.next(s) === me) ?? null : null;
  }

  // ---------------------------------------------------------------- input
  on(target, type, fn, opts) { target.addEventListener(type, fn, opts); this.listeners.push([target, type, fn, opts]); }
  unbind() { for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts); this.listeners = []; }
  bind() {
    const c = this.canvas;
    this.on(c, 'mousemove', (ev) => { this.mouse = this.local(ev); this.touch = null; this.hover(); });
    this.on(c, 'mouseleave', () => { this.mouse = null; this.hover(); });
    this.on(c, 'mousedown', (ev) => this.down(ev));
    this.on(c, 'contextmenu', (ev) => ev.preventDefault());
    this.on(c, 'wheel', (ev) => this.wheel(ev), { passive: false });
    this.on(window, 'mousemove', (ev) => this.move(ev));
    // the screen edges pan for a mouse: never for a finger, nor for the mouse events a browser makes up after a tap
    this.on(window, 'pointermove', (ev) => { if (!isTouch(ev)) { this.ptr = { x: ev.clientX, y: ev.clientY }; this.edgeOk = true; } });
    this.on(window, 'pointerdown', (ev) => { if (isTouch(ev)) { this.ptr = null; this.edgeOk = false; } }, true);
    this.on(window, 'mouseup', (ev) => this.up(ev));
    this.on(window, 'keydown', (ev) => this.keydown(ev));
    this.on(window, 'keyup', (ev) => { this.keys.delete(ev.key); if (ev.key === 'Shift') this.view.shift = false; });
    this.on(window, 'blur', () => { this.keys.clear(); this.edgeOk = false; this.view.shift = false; });
    this.on(document.documentElement, 'mouseleave', () => { this.edgeOk = false; });
    this.on(document.documentElement, 'mouseenter', () => { this.edgeOk = true; });
    // the minimap: a press jumps the view there, a drag moves it along (a finger stays with the element it touched)
    const mm = $('minimap');
    this.on(mm, 'mousedown', (ev) => { if (ev.button === 0) { this.mmDrag = true; this.minimapJump(ev); ev.preventDefault(); } });
    this.on(mm, 'pointerdown', (ev) => { if (isTouch(ev)) { this.mmDrag = true; this.minimapJump(ev); } });
    this.on(mm, 'pointermove', (ev) => { if (isTouch(ev) && this.mmDrag) this.minimapJump(ev); });
    for (const type of ['pointerup', 'pointercancel']) this.on(mm, type, (ev) => { if (isTouch(ev)) this.mmDrag = false; });
    this.on(mm, 'touchstart', (ev) => { if (ev.cancelable) ev.preventDefault(); }, { passive: false });   // no mouse events made up after it
    this.on($('btn-chat'), 'click', () => (this.chatting ? this.sendChat() : this.openChat()));
    for (const id of ['zoom-in', 'vt-in']) this.on($(id), 'click', () => this.zoom(1));
    for (const id of ['zoom-out', 'vt-out']) this.on($(id), 'click', () => this.zoom(-1));
    this.on($('vt-home'), 'click', () => this.jumpTo(this.me));
    this.on($('vt-target'), 'click', () => { this.roles(); if (this.view.target !== null) this.jumpTo(this.view.target); });
    this.on($('chat-send'), 'click', () => this.sendChat());
    new Gestures(c, {
      active: () => this.active && !screenShown(),
      down: (p) => { if (this.view.placing) this.touchAt(p); },
      tap: (p) => this.tap(p),
      hold: (p) => {
        if (!this.view.placing) return this.holdTip(p);
        this.touchAt(p);
        this.hud.hint('Move your finger to aim, lift it to build.');
        return 'aim';
      },
      holdMove: (p) => this.holdTip(p),
      holdEnd: () => { this.touch = null; this.hover(); this.hud.hideTip(); },
      aim: (p) => this.touchAt(p),
      aimEnd: (p, inside) => {
        if (!inside || !this.view.placing) return this.disarm();
        this.touchAt(p);
        this.build(false);
      },
      cancel: () => this.disarm(),
      pan: (dx, dy) => { this.cam.pan(-dx, -dy); this.focus = null; this.hover(); },
      pinch: (k, m, dx, dy) => {
        const q = this.localXY(m.x, m.y);
        this.cam.live = true;
        this.cam.zoomBy(k, q.x, q.y); this.cam.pan(-dx, -dy); this.focus = null;
        this.zoomButtons(); this.hover();
      },
      end: () => { this.cam.live = false; },
    }, (t, type, fn, opts) => this.on(t, type, fn, opts));
  }
  local(ev) { return this.localXY(ev.clientX, ev.clientY); }
  localXY(x, y) { const r = this.canvas.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; }
  minimapJump(ev) {
    const r = $('minimap').getBoundingClientRect();
    const { X, Y } = this.hud.minimapToWorld(ev.clientX - r.left, ev.clientY - r.top);
    this.cam.center(X, Y); this.focus = null;
    this.hover();
  }
  move(ev) {
    if (this.mmDrag) { if (ev.buttons & 1) this.minimapJump(ev); else this.mmDrag = false; }
    const d = this.drag;
    if (d) {
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      if (!d.moved && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) > DRAG) d.moved = true;
      if (d.moved) { this.cam.pan(-dx, -dy); this.focus = null; this.hover(); }
      d.x = ev.clientX; d.y = ev.clientY;
    }
  }
  down(ev) {
    if (screenShown()) return;
    if (ev.button === 1 || ev.button === 2) {
      ev.preventDefault();
      this.drag = { x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY, button: ev.button, moved: false };
      return;
    }
    if (ev.button !== 0) return;
    this.mouse = this.local(ev); this.touch = null; this.hover();
    if (this.view.placing) return this.build(ev.shiftKey);
    this.select();
  }
  // a click (or a tap) on what is under the pointer
  select() {
    const hit = this.hit;
    this.view.sel = hit && hit.creep ? { slot: hit.creepSlot, o: hit.creep } : hit && hit.tower ? { slot: hit.towerSlot, o: hit.tower }
      : hit && hit.tech && hit.tech.id ? { slot: hit.techSlot, o: techObject(hit.techSlot, hit.tech) } : null;
    // a wisp of mine: the Tech card, where wisps become buildings
    if (hit && hit.tech && !hit.tech.id && hit.techSlot === this.me && this.hud.tab !== TECH_TAB) this.hud.setTab(TECH_TAB);
    this.hud.refresh(true);
  }
  // ---------------------------------------------------------------- touch
  // The finger's point (client px) is what the mouse would be pointing at.
  touchAt(p) { const q = this.localXY(p.x, p.y); this.mouse = null; this.touch = this.cam.toWorld(q.x, q.y); this.hover(); }
  // A tap: a click, but placing a tower the first tap shows it on that spot and a second tap there builds it.
  tap(p) {
    const v = this.view;
    this.touchAt(p);
    if (!v.placing) { this.select(); this.touch = null; this.hover(); return; }
    const h = v.hover, a = this.armed;
    if (h && a && a.slot === h.slot && a.c === h.c && a.r === h.r) { this.armed = null; return this.build(false); }
    this.armed = h ? { X: this.touch.X, Y: this.touch.Y, slot: h.slot, c: h.c, r: h.r } : null;
    this.hud.hint(!h ? '' : h.why || 'Tap again to build here.');
  }
  // a drag or a second finger: the tower goes back to the spot picked last
  disarm() {
    if (!this.view.placing) return;
    this.touch = this.armed ? { X: this.armed.X, Y: this.armed.Y } : null;
    this.hover();
  }
  // a long press away from placing: the range of a tower under the finger, and what it is
  holdTip(p) {
    this.touchAt(p);
    const h = this.hit, o = h && (h.creep || h.tower || (h.tech && h.tech.id ? techObject(h.techSlot, h.tech) : null));
    if (o) this.hud.objectTip(o, p.x, p.y); else this.hud.hideTip();
  }
  up(ev) {
    if (ev.button === 0) this.mmDrag = false;
    const d = this.drag;
    if (!d || ev.button !== d.button) return;
    this.drag = null;
    if (!d.moved && d.button === 2) this.back();
  }
  // right click or Esc: drop a Destroy waiting for its confirmation, stop placing, else drop the selection
  back() {
    if (this.hud.confirm) this.hud.confirm = null;
    else if (this.view.placing) this.actions.cancel();
    else this.view.sel = null;
    this.hud.refresh(true);
  }
  wheel(ev) {
    ev.preventDefault();
    if (screenShown()) return;
    const dir = this.cam.wheelDir(ev), m = this.local(ev);
    if (dir) this.zoom(dir, m.x, m.y);
  }
  // One zoom level in (dir > 0) or out: the wheel at the cursor, the buttons by the minimap at the middle of the view.
  zoom(dir, mx, my) {
    if (screenShown()) return;
    this.cam.zoomStep(dir, mx, my); this.focus = null;
    this.zoomButtons();
  }
  zoomButtons() {
    for (const id of ['zoom-in', 'vt-in']) $(id).disabled = this.cam.close;
    for (const id of ['zoom-out', 'vt-out']) $(id).disabled = this.cam.far;
  }
  keydown(ev) {
    if (!this.active) return;
    const k = ev.key, v = this.view;
    if (this.chatting) {   // the chat line has the keyboard (a click on the map took the focus: give it back)
      if (k === 'Enter') { ev.preventDefault(); this.sendChat(); }
      else if (k === 'Escape') { ev.preventDefault(); this.closeChat(); }
      else if (document.activeElement !== $('chat-in')) $('chat-in').focus();
      return;
    }
    if (k === 'Shift') v.shift = true;
    if (screenShown()) {   // pause or end screen
      // knocked out while the others play on: Enter is still the chat key
      if (k === 'Enter' && this.shownOutScreen && this.world.phase !== 'over') { ev.preventDefault(); this.shownOutScreen = false; hideScreen(); return this.openChat(); }
      if (k === 'Enter') { const b = $('ov-btn'); if (b.style.display !== 'none' && !b.disabled) b.click(); }
      else if ((k === 'Escape' || k === 'F10' || k === 'p' || k === 'P') && (this.session.paused || this.inMenu) && this.world.phase !== 'over' && !this.shownOutScreen) { ev.preventDefault(); this.resume(); }
      else if (k === 'Escape' && this.world.phase === 'over' && this.shownEnd) { ev.preventDefault(); hideScreen(); }   // look at the final board
      return;
    }
    if (k === 'F10') { ev.preventDefault(); return this.pauseMenu(); }
    if (k === 'Enter') { ev.preventDefault(); return this.openChat(); }
    if (k === 'Escape') return this.back();
    if (k === 'Home' || k === 'F1') { ev.preventDefault(); return this.jumpTo(this.me); }
    if (k === 'F2') { ev.preventDefault(); this.roles(); if (v.target !== null) this.jumpTo(v.target); return; }
    if (k.startsWith('Arrow')) { ev.preventDefault(); this.keys.add(k); return; }
    if (k === 'Tab') { ev.preventDefault(); return this.hud.setTab(this.hud.tab + (ev.shiftKey ? -1 : 1)); }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (this.session.kind === 'local') {
      if (k === 'p' || k === 'P') return this.togglePause();
      if (k === '1' || k === '2' || k === '3') return this.setSpeed(+k);
    }
    if ((k === 'Delete' || k === 'Backspace') && v.sel && v.sel.o.def.upgrades && v.sel.slot === this.me) return this.actions.sell(v.sel.o);
    if (k.length === 1) {
      // a held key presses its button again at the keyboard's repeat rate, here at most every REPEAT_EVERY ms
      if (ev.repeat) {
        const now = performance.now();
        if (now - this.repeatAt < REPEAT_EVERY) { ev.preventDefault(); return; }
        this.repeatAt = now;
      }
      if (this.hud.hotkey(k)) ev.preventDefault();
    }
  }
  // What is under the mouse: the lane tile (for placing), a tower to show the range of, the pick for clicks.
  hover() {
    const v = this.view, pt = this.mouse ? this.cam.toWorld(this.mouse.x, this.mouse.y) : this.touch;
    if (!pt || !this.session) { v.hover = null; v.hoverTower = null; this.hit = null; return; }
    const { X, Y } = pt;
    const hit = this.renderer.pickAt(this.world, this.order, X, Y);
    this.hit = hit;
    v.hoverTower = hit && hit.tower ? hit.tower : null; v.hoverSlot = hit ? hit.towerSlot : null;
    if (!hit) { v.hover = null; return; }
    const why = !v.placing ? null : hit.slot !== this.me ? "Can't build there." : this.world.lanes[this.me].whyNot(v.placing.id, hit.c, hit.r);
    v.hover = { slot: hit.slot, c: hit.c, r: hit.r, why };
  }
  // Keep the selection on the live object: towers by id in their lane, creeps by id across lanes (they keep their id
  // when they walk into the next lane).
  resolveSelection() {
    const s = this.view.sel;
    if (!s) return;
    const w = this.world;
    if (s.o.def.tech) {   // a tech building: it stays while its owner has it (its spot moves up when one before it goes)
      const spot = techArea(w.players[s.slot]).find(t => t.id === s.o.techId);
      if (spot) { s.o.x = spot.x; s.o.y = spot.y; } else this.view.sel = null;
      return;
    }
    if (s.o.def.upgrades) {
      const lane = w.lanes[s.slot], t = lane.towers.includes(s.o) ? s.o : lane.towers.find(t => t.id === s.o.id);
      if (t) s.o = t; else this.view.sel = null;
      return;
    }
    const id = s.o.id;
    let lane = w.lanes[s.slot], c = lane.creeps.includes(s.o) && !s.o.dead ? s.o : lane.creeps.find(k => k.id === id && !k.dead);
    if (!c) for (const slot of this.order) {
      c = w.lanes[slot].creeps.find(k => k.id === id && !k.dead);
      if (c) { s.slot = slot; break; }
    }
    if (c) { s.o = c; s.away = false; s.leakedAt = undefined; }
    else if (s.leakedAt !== undefined && w.time - s.leakedAt < CROSSING) s.away = true;   // on its way into the next lane
    else this.view.sel = null;
  }

  // ---------------------------------------------------------------- frame
  frame(now, dt) {
    if (!this.active) return;
    const s = this.session, w = this.world, cam = this.cam;
    s.tick(dt);
    // effects keep playing behind the end screen (the match has stopped, its clock too); a pause freezes them
    const sdt = s.paused ? 0 : dt * (s.speed || 1);
    this.clock += sdt;
    if (w.phase === 'over') this.overT += sdt;

    // camera: keys, screen edges, zoom easing
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowLeft')) dx--; if (this.keys.has('ArrowRight')) dx++;
    if (this.keys.has('ArrowUp')) dy--; if (this.keys.has('ArrowDown')) dy++;
    if (this.edgeOk && this.ptr && !this.drag && !this.mmDrag && !screenShown() && document.hasFocus()) {
      const { x, y } = this.ptr;
      if (x <= EDGE) dx = -1; else if (x >= window.innerWidth - 1 - EDGE) dx = 1;
      if (y <= EDGE) dy = -1; else if (y >= window.innerHeight - 1 - EDGE) dy = 1;
    }
    if (dx || dy) { cam.pan(dx * PAN * dt, dy * PAN * dt); this.focus = null; this.hover(); }
    if (cam.zooming) { cam.update(dt); this.hover(); }
    if (this.online) this.onlineFrame();

    // lanes in view get effects; the others just drop their events
    const [i0, i1] = this.renderer.visibleRange(cam, this.order.length);
    for (let i = 0; i < this.order.length; i++) {
      const slot = this.order[i], vis = i >= i0 && i <= i1;
      if (!vis && this.inView.has(slot)) { this.fxs[slot].clear(); this.inView.delete(slot); }
      else if (vis) this.inView.add(slot);
    }
    for (const e of w.events) { this.track(e); this.hud.handle(e); }
    w.events.length = 0;
    // after a long gap (the page was hidden, so no frames ran) the effects backlog refers to creeps that have moved on
    const stale = w.time - this.lastTime > 0.5;
    this.lastTime = w.time;
    const sel = this.view.sel, selId = sel && !sel.o.def.upgrades && !sel.o.def.tech ? sel.o.id : null;
    this.lostTowers(w.lanes[this.me]);
    for (const slot of this.order) {
      const lane = w.lanes[slot], fx = this.fxs[slot];
      // a selected creep that gets through is out of every lane for a moment before it walks into the next one
      if (selId !== null) for (const e of lane.events) if (e.type === 'leak' && e.creep.id === selId) sel.leakedAt = w.time;
      if (this.inView.has(slot)) {
        if (stale) fx.clear();
        else for (const e of lane.events) fx.handle(e, this.renderer, lane);
        fx.update(sdt, lane, this.renderer);
      }
      lane.events.length = 0;
    }
    const p = w.players[this.me];
    if (p && p.income > this.stats.peakIncome) this.stats.peakIncome = p.income;

    this.resolveSelection();
    if (this.view.placing || this.view.hoverTower) this.hover();
    this.layoutMessages();
    this.draw();
    this.hud.refresh();

    // your elimination, then the end of the match
    if (p && !p.alive && !this.shownOut && w.phase === 'playing') {
      this.outAt ??= now;
      if (now - this.outAt > OUT_DELAY) { this.shownOut = true; this.endScreen(false); }
    }
    if (w.phase === 'over' && !this.shownEnd) { this.shownEnd = true; this.endScreen(true); }
  }
  // Online: ask the host for the lane in the middle of the view at full rate (its combat events, missiles and muzzle
  // flashes; the other lanes come at 3 Hz), and show the banner while the host doesn't answer.
  onlineFrame() {
    const slot = this.viewedSlot();
    if (slot !== this.watched && slot !== undefined) { this.watched = slot; this.session.command({ type: 'watch', slot }); }
    const lost = !!this.session.hostLost, b = $('net-banner');
    if (lost && this.lostSince === null) this.lostSince = performance.now();
    if (!lost) this.lostSince = null;
    b.classList.toggle('show', lost);
    if (lost) setHtml(b, `<b>No answer from the host</b><span>Reconnecting… ${Math.floor((performance.now() - this.lostSince) / 1000)} s</span>`);
  }
  // The top bar's network line: ping to the host (the host itself plays over a local link) and the players connected.
  renderNet() {
    const el = $('net-status'), n = this.netInfo, w = this.world, on = this.online;
    if (!el || !on) return;
    const humans = (this.session.seats || []).filter(s => s.kind === 'human' && (s.connected || (w.players[s.slot] && w.players[s.slot].alive && !w.players[s.slot].kicked)));
    const peers = n ? n.peers : humans.filter(s => s.connected).length;
    const ping = on.isHost ? 'Host' : !n || n.ping === null ? '…' : n.host === false ? 'no answer' : `${n.ping} ms`;
    const cls = on.isHost || !n || n.ping === null ? '' : n.host === false || n.ping > 300 ? 'bad' : n.ping > 150 ? 'warn' : 'good';
    setHtml(el, `<i class="dot ${cls}"></i>${ping} <span>· ${peers}/${humans.length} online</span>`);
    el.title = `${on.isHost ? 'You are the host: the match runs in this browser.' : 'Your ping to the host.'} ${peers} of ${humans.length} players connected. Room ${on.room}.`;
  }
  // My towers that fell: to attackers ('destroyed' {tower, by, reason} in my lane's events), to my own Destroy or
  // '-destroy', or found gone and destroyed: online a replica drops the tower as soon as the host says so, and the
  // lane's event (with the attacker) follows when the lane's clock gets there, or never while another lane is watched.
  // Each tower is announced once: a tower found gone waits LOST_WAIT for its event while my lane is watched.
  lostTowers(lane) {
    if (!lane) return;
    const now = performance.now(), lost = this.lost;
    for (const e of lane.events) if (e.type === 'destroyed' && e.tower) {
      const x = lost.get(e.tower.id);
      if (x && x.told) continue;
      lost.set(e.tower.id, { t: e.tower, told: true, at: now });
      this.hud.towerLost(e.tower, e.by, this.destroying.delete(e.tower.id) ? 'destroy' : e.reason);
    }
    const ids = new Set(lane.towers.map(t => t.id));
    for (const [id, t] of this.mine) if (!ids.has(id) && t.destroyed && !lost.has(id)) lost.set(id, { t, told: false, at: now });
    const wait = this.online && this.watched === this.me ? LOST_WAIT : 0;
    for (const [id, x] of lost) {
      if (!x.told && now - x.at >= wait) { x.told = true; this.hud.towerLost(x.t, null, this.destroying.delete(id) ? 'destroy' : null); }
      else if (x.told && now - x.at > 10 * LOST_WAIT) lost.delete(id);
    }
    this.mine.clear();
    for (const t of lane.towers) this.mine.set(t.id, t);
    if (this.destroying.size > 64) this.destroying.clear();
  }
  // The map messages sit bottom left, as in WC3, but step past the spawn waygate (and the tech area) when that end of
  // a lane is in view; the name plates in turn keep out of the messages (view.avoid) and out from under the build
  // phase's timer window (view.timer: at the top left of an upright phone, lower down while the chat line is open).
  layoutMessages() {
    const m = $('msgs'), left = Math.round(Math.max(MSG_LEFT, Math.min(this.renderer.vw * 0.4, this.cam.toScreen(sx(0.1), 0).x)));
    if (left !== this.msgLeft) { this.msgLeft = left; m.style.left = left + 'px'; $('chat').style.left = left + 'px'; }
    this.view.avoid = m.childElementCount ? [m.offsetLeft, m.offsetTop, m.offsetLeft + m.offsetWidth, m.offsetTop + m.offsetHeight] : null;
    const t = $('prep-timer');
    if (t && t.classList.contains('show')) {   // centred by a transform on a computer, so measured on the screen
      const r = t.getBoundingClientRect(), o = this.canvas.getBoundingClientRect();
      this.view.timer = [r.left - o.left, r.top - o.top, r.right - o.left, r.bottom - o.top];
    } else this.view.timer = null;
  }
  track(e) {
    const st = this.stats, me = this.me;
    if (e.type === 'sent' && e.from === me) { st.sent += e.n; st.sentGold += LTW_UNITS[e.unit] ? LTW_UNITS[e.unit].cost : 0; }
    else if (e.type === 'eliminated') { st.out.push(e.slot); this.roles(); }
    else if (e.type === 'left') this.roles();
  }

  // ---------------------------------------------------------------- end of the game
  // Final places: the living (winner first, then by lives), then the eliminated, latest out first.
  standings() {
    const w = this.world, st = this.stats;
    const outAt = (p) => p.eliminatedAt ?? (st.out.indexOf(p.slot) >= 0 ? st.out.indexOf(p.slot) : -1);
    return w.ring.map(s => w.players[s]).sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.alive) return a.slot === w.winner ? -1 : b.slot === w.winner ? 1 : b.lives - a.lives;
      return outAt(b) - outAt(a);
    });
  }
  endScreen(final) {
    this.closeChat();
    this.inMenu = false;
    const w = this.world, me = this.me, p = w.players[me], lane = w.lanes[me], st = this.stats, online = !!this.online;
    const table = this.standings(), place = table.findIndex(q => q.slot === me) + 1, n = table.length;
    const won = w.winner === me;
    const hostLive = online && this.online.isHost && !final;   // the host's browser runs the match: leaving ends it for all
    // Lives change only by leaks (-1) and steals (+1). After an elimination at 0 lives every further leak through the
    // empty lane is -1 more, so the leaks while still in play are leaks + lives.
    const out = !p.alive && p.lives <= 0;
    const lost = out ? lane.stats.leaks + p.lives : lane.stats.leaks;
    const stolen = Math.max(0, (out ? 0 : p.lives) - LTW_RULES.startLives + lost);
    const by = p.eliminatedBy !== null && p.eliminatedBy !== undefined && w.players[p.eliminatedBy] ? w.players[p.eliminatedBy].name : null;
    const champ = w.winner !== null && w.players[w.winner] ? w.players[w.winner].name : null;
    const sub = won ? 'The last one standing' : final && champ ? `${champ} has won the game`
      : !p.alive ? (by ? `${by} took your last life` : 'Your lane has fallen') : `${ordinal(place)} of ${n}`;
    const rows = table.map((q, i) => {
      const res = q.slot === w.winner ? 'Winner' : q.alive ? `${q.lives} lives` : q.label ? esc(q.label) : q.left ? 'Left' : `Out at ${mapClock(w, q.eliminatedAt ?? w.time)}`;
      return `<div class="st-row${q.slot === me ? ' me' : ''}"><span class="st-place">${ordinal(i + 1)}</span><i class="sw" style="background:${PLAYER_HEX[q.slot]}"></i>`
        + `<b style="color:${PLAYER_TEXT[q.slot]}">${esc(q.name)}</b><em>${q.slot === me ? 'you' : q.kind === 'bot' && !botNamed(q) ? esc(DIFF_NAME[q.difficulty] || '') : ''}</em><span>${res}</span></div>`;
    }).join('');
    screen({
      title: won ? 'Victory' : 'Defeat', sub, wide: true,
      body: `<div class="end-grid"><div class="ov-stats">
          <span>Place</span><b>${ordinal(place)} of ${n}</b>
          <span>Time</span><b>${mapClock(w, p.alive ? w.time : (p.eliminatedAt ?? w.time))}</b>
          <span>Creeps killed</span><b>${lane.stats.kills}</b>
          <span>Lives lost</span><b>${lost}</b>
          <span>Lives stolen</span><b>${stolen}</b>
          <span>Creeps sent</span><b>${st.sent}</b>
          <span>Gold sent</span><b>${short(st.sentGold)}</b>
          <span>Peak income</span><b>${short(st.peakIncome)}</b>
          <span>Towers built</span><b>${lane.stats.built}</b>
          <span>Players knocked out</span><b>${p.kills}</b>
        </div><div class="standings">${rows}</div></div>
        ${hostLive ? `<p class="ov-note">Your browser runs this match: if you leave, it ends for everyone.</p>
        <div class="ov-actions"><button class="wc-btn small" id="ov-end">End the game</button></div>`
        : `<div class="ov-actions"><button class="wc-btn small" id="ov-watch" title="${final ? 'Look at the final board (F10 or Menu shows this again)' : 'Watch the others play on'}">${final ? 'Close' : 'Keep watching'}</button>${online ? '' : '<button class="wc-btn small" id="ov-menu">Menu</button>'}</div>`}`,
      primary: hostLive ? { label: 'Keep watching', run: () => { this.shownOutScreen = false; hideScreen(); } }
        : online ? { label: 'Back to menu', run: () => this.quit() } : { label: 'Play again', run: () => this.restart() },
    });
    this.shownOutScreen = !final;
    if ($('ov-watch')) $('ov-watch').onclick = () => { this.shownOutScreen = false; hideScreen(); };
    if ($('ov-menu')) $('ov-menu').onclick = () => this.quit();
    // ending the match for everyone asks again, like the menu's 'End the game'
    if ($('ov-end')) $('ov-end').onclick = (ev) => {
      const b = ev.currentTarget;
      if (b.classList.contains('armed')) return this.quit();
      b.classList.add('armed'); b.textContent = `${clickWord()} again to end the game`;
    };
  }
}

function setHtml(e, html) { if (e.dataset.v !== html) { e.dataset.v = html; e.innerHTML = html; } }

// The selection object for a tech building in a lane's tech area (the renderer rings it at x, y like a tower).
function techObject(slot, spot) {
  const t = LTW_TECH[spot.id];
  return { id: 'tech:' + spot.id, techId: spot.id, owner: slot, x: spot.x, y: spot.y, def: { id: spot.id, name: t ? t.name : spot.id, tech: true } };
}
