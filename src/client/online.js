// vs Players: the screens around an online game. The vs Players menu (host a game, or join one with an invite link),
// the join screen an invite link opens (#room=CODE&key=..., on page load or pasted into an open tab), the lobby
// (seats, the -onextra option, chat, Ready and Start) and what follows a lost connection: rejoining (the seat is kept
// for 60 seconds) and clear screens for a host who left, a kick, a full or already started game. The match itself is
// LtwMode.attach(session, { online }) with the online differences (src/client/ltw.js). The netcode (src/net/session.js)
// is loaded the first time vs Players is used, so Classic Defense and vs Computer never load it. The map is Line Tower
// Wars, the one map online: the join screen and the lobby show its picture to the host and to every joiner.
// Every name and chat line comes from other players: it is escaped before it goes into the page.
import { screen, hideScreen, mapPicture, bindPictures } from './screens.js?v=99dfd38af943';
import { MAP } from './maps.js?v=99dfd38af943';
import { PLAYER_HEX, PLAYER_TEXT, DIFFICULTIES, DIFF_NAME, esc } from './common.js?v=99dfd38af943';
import { LTW_COLORS, LTW_RULES } from '../data/ltw.js?v=99dfd38af943';
import { clickWord } from './touch.js?v=99dfd38af943';

const $ = (id) => document.getElementById(id);
const NAME_KEY = 'lejdaeron.name';
const MAX_LOG = 60;          // lobby chat lines kept
const KICK_ARM = 3000;       // ms a Kick button waits for its second click
const GRACE = LTW_RULES.reconnectGrace;
const REJOIN_WAIT = 15;      // seconds a rejoin after a lost connection looks for the host (it answers at once if it is there)
const MAP_ONLINE = MAP.ltw;   // the lobby carries no map: vs Players has the one
const TRY_OTHER_NETWORK = 'Some school, office and mobile networks block direct connections between browsers. If it keeps failing, try another network (a phone hotspot works).';
let net = null;
const loadNet = async () => (net ||= await import('../net/session.js?v=99dfd38af943'));

export class Online {
  // ltw: the LtwMode; menu(): back to the map picker; enterGame(): main's mode switch before the game screen takes over;
  // playing(): whether a Classic or vs Computer game is running
  constructor({ ltw, menu, enterGame, playing }) {
    this.ltw = ltw; this.toMenu = menu; this.enterGame = enterGame; this.playing = playing;
    this.lobby = null; this.invite = null; this.pending = null;
    this.attempt = null;      // the host or join that is running: { poll, abort }; Back drops it, and a later one may start
    this.seatSig = new Map(); this.prevSeats = null; this.kickArmed = null;
    window.addEventListener('hashchange', () => this.hashChanged());
  }
  inGame() { return this.ltw.active && !!this.ltw.online; }
  name() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
  saveName(v) { try { localStorage.setItem(NAME_KEY, v); } catch { /* not kept */ } }
  // the invite in the address bar stays while a joiner is in that room (a reload rejoins); replaceState fires no
  // hashchange, so the page never reacts to its own changes
  setHash(inv) { history.replaceState(null, '', location.pathname + location.search + (inv ? `#room=${inv.room}${inv.key ? '&key=' + inv.key : ''}` : '')); }
  hasInvite() { return /room=/i.test(location.hash); }

  // ---------------------------------------------------------------- entry points
  // Page load: an invite link opens its join screen (and rejoins at once if this browser holds a seat there).
  async boot() {
    if (!this.hasInvite()) return;
    const inv = await this.parse(location.hash);
    if (inv) this.joinScreen(inv);
  }
  // An invite link pasted into this tab: open it, unless a game or another lobby is in the way (then once it's over).
  async hashChanged() {
    if (!this.hasInvite()) return;
    const inv = await this.parse(location.hash);
    if (!inv || (this.invite && inv.room === this.invite.room && (this.lobby || this.attempt))) return;
    if (this.lobby || this.attempt || this.playing()) {
      this.pending = inv;
      const text = `Leave this game to join room <b>${esc(inv.room)}</b> (the link you opened).`;
      if (this.ltw.active) this.ltw.hud.message(text, '#ffd84a');
      else this.status(text, 'warn');
      return;
    }
    this.joinScreen(inv);
  }
  // After the map picker came back: an invite that waited for the game to end.
  resume() {
    const inv = this.pending;
    this.pending = null;
    if (inv) this.joinScreen(inv);
  }
  async parse(text) {
    const n = await loadNet(), inv = n.parseInvite(text);
    return inv ? { ...inv, link: n.inviteLink(inv.room, location, inv.key) } : null;
  }

  // ---------------------------------------------------------------- the vs Players menu
  // back: where Back (and Esc) go: Line Tower Wars' screen (the map picker by default)
  menu({ back = this.toMenu } = {}) {
    const leave = () => { this.cancel(); back(); };
    this.setHash(null);
    screen({
      title: 'vs Players', sub: 'Line Tower Wars online', wide: true, back: leave,
      body: `<div class="on-wrap">
          <label class="on-field"><span>Your name</span><input id="on-name" maxlength="16" autocomplete="nickname" spellcheck="false" placeholder="Player"></label>
          <div class="on-cards">
            <section class="on-card"><h3>Host a game</h3>
              <p>Open a lobby and send your friends the invite link. Empty seats can be computer players. The match runs in your browser, so keep this tab open until it is over (it may be in the background).</p>
              <button class="wc-btn small" id="on-host">Host a game</button></section>
            <section class="on-card"><h3>Join a game</h3>
              <p>Paste the invite link the host sent you, or just open it.</p>
              <input id="on-link" class="on-input" placeholder="https://…#room=…&amp;key=…" spellcheck="false" autocomplete="off">
              <button class="wc-btn small" id="on-join">Join</button></section>
          </div>
          <p class="on-status" id="on-status"></p>
        </div>
        <div class="ov-actions"><button class="wc-btn small" id="on-back">Back</button></div>`,
    });
    const nm = $('on-name');
    nm.value = this.name();
    nm.oninput = () => this.saveName(nm.value.trim());
    $('on-host').onclick = () => this.host();
    $('on-join').onclick = () => this.joinTyped();
    $('on-link').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.joinTyped(); } };
    $('on-back').onclick = leave;
  }
  // Gives up the host or join that is running (Back): its progress stops, and what it brings later is left at once.
  cancel() {
    const a = this.attempt;
    this.attempt = null;
    if (!a) return;
    clearInterval(a.poll);
    if (a.abort) a.abort.abort();
  }
  async joinTyped() {
    const text = $('on-link').value.trim();
    const inv = text ? await this.parse(text) : null;
    if (!inv) return this.status('That is not an invite link. Ask the host to copy it from their lobby.', 'bad');
    if (inv.key === null) return this.status(`That is only the room code. Paste the whole invite link: its key proves the lobby you reach is the host's.`, 'bad');
    if (inv.key === '') return this.status('That invite link is cut short. Copy the whole link from the host again.', 'bad');
    this.join(inv);
  }
  status(html, cls = '') {
    const el = $('on-status') || $('lb-status');
    if (!el) return;
    el.innerHTML = html; el.className = 'on-status ' + cls;
  }

  // ---------------------------------------------------------------- hosting
  async host() {
    if (this.attempt || this.lobby) return;
    const attempt = this.attempt = { poll: null, abort: null };
    for (const id of ['on-host', 'on-join']) $(id).disabled = true;
    this.status('<i class="spin"></i>Opening a room…');
    try {
      const n = await loadNet();
      const lobby = await n.hostLobby({ name: this.name() || 'Host' });
      if (this.attempt !== attempt) return lobby.leave();   // Back was pressed meanwhile
      this.attempt = null;
      this.enter(lobby, { room: lobby.room, key: lobby.key, link: lobby.link });
    } catch (e) {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      this.status(esc(e.message || String(e)), 'bad');
      for (const id of ['on-host', 'on-join']) if ($(id)) $(id).disabled = false;
    }
  }

  // ---------------------------------------------------------------- joining
  // The screen an invite link opens: a name, then Join. With a seat token for the room in this browser (a reopened
  // link, a reload) it joins at once.
  async joinScreen(inv, { again = false } = {}) {
    const back = () => { this.cancel(); this.setHash(null); this.toMenu(); };   // also gives up a join that runs
    screen({
      title: again ? 'Rejoin game' : 'Join game', sub: `Room ${inv.room}`, wide: true, back,
      body: `<div class="on-wrap narrow">
          ${mapRow()}
          <label class="on-field"><span>Your name</span><input id="on-name" maxlength="16" autocomplete="nickname" spellcheck="false" placeholder="Player"></label>
          <p class="on-note">${again ? `Your seat is kept for ${GRACE} seconds after the connection dropped.` : 'You were invited to a game of Line Tower Wars. The host picks the seats and starts the game; press Ready in the lobby when you are.'}</p>
          <p class="on-status" id="on-status"></p>
        </div>
        <div class="ov-actions"><button class="wc-btn small" id="on-back">Back</button></div>`,
      primary: { label: again ? 'Rejoin' : 'Join', run: () => this.join(inv) },
    });
    bindPictures();
    const nm = $('on-name');
    nm.value = this.name();
    nm.oninput = () => this.saveName(nm.value.trim());
    nm.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.join(inv); } };
    $('on-back').onclick = back;
    if (inv.key === null || inv.key === '') {
      $('ov-btn').disabled = true;
      return this.status(inv.key === null ? 'This link has no host key. Ask the host for the whole invite link.' : 'This invite link is cut short. Copy the whole link from the host again.', 'bad');
    }
    const n = await loadNet();
    if (again || n.browserStorage().load(inv.room)) this.join(inv, { again });
  }
  // again: a rejoin after the connection to the host was lost (a host that doesn't answer has most likely left)
  async join(inv, { again = false } = {}) {
    if (this.attempt || this.lobby) return;
    this.invite = inv;
    this.setHash(inv);
    const btn = $('ov-btn'), nm = $('on-name');
    if (btn) btn.disabled = true;
    if (nm) nm.disabled = true;
    // Back on the join screen cancels it (cancel()): the join gives up, and a lobby that still comes is left at once
    const attempt = this.attempt = { poll: null, abort: typeof AbortController === 'function' ? new AbortController() : null };
    let transport = null, seen = null;   // seen: the transport's diagnostics while it was up (for the failure screen)
    const progress = () => {
      if (this.attempt !== attempt) return;
      if (transport && transport.diagnostics) seen = transport.diagnostics();
      this.status('<i class="spin"></i>' + joinStage(seen, inv.room));
    };
    progress();
    attempt.poll = setInterval(progress, 400);
    try {
      const n = await loadNet();
      const lobby = await n.joinLobby(inv.link, { name: this.name() || 'Player', onTransport: (t) => { transport = t; },
        signal: attempt.abort && attempt.abort.signal, ...(again ? { timeout: REJOIN_WAIT } : {}) });
      clearInterval(attempt.poll);
      if (this.attempt !== attempt) return lobby.leave();
      this.attempt = null;
      this.enter(lobby, inv);
    } catch (e) {
      clearInterval(attempt.poll);
      if (this.attempt !== attempt) return;
      this.attempt = null;
      this.joinFailed(inv, e, seen, again);
    }
  }
  joinFailed(inv, e, d, again = false) {
    const msg = String(e && e.message || e);
    const open = d ? [...d.nostr, ...d.torrent].filter(r => r[1] === 'open').length : 0;
    let title = 'Could not join', text = esc(msg), tip = '', retry = true;
    if (/full/i.test(msg)) { title = 'Game full'; text = 'Every seat in this game is taken. Ask the host to open a seat, then try again.'; }
    else if (/already started/i.test(msg)) { title = 'Game already started'; text = 'The match started without you, and new players can\'t join a match that is running. Ask the host for the next game.'; retry = false; }
    else if (/version differs/i.test(msg)) { title = 'Different versions'; text = esc(msg); }
    else if (/host's key/i.test(msg)) { title = 'Not the host'; text = esc(msg); }
    else if (/removed from this game/i.test(msg)) { title = 'Removed'; text = 'You were removed from this game, so you can\'t join it again.'; retry = false; }
    else if (/Couldn't reach the host/i.test(msg) && again && d && d.peers.length === 0 && [...d.nostr, ...d.torrent].some(r => r[1] === 'open')) {
      title = 'The host is gone';
      text = `The connection to the host dropped, and nobody answers in room <b>${esc(inv.room)}</b> any more: the host has most likely closed the game, so it is over.`;
    } else if (/Couldn't reach the host/i.test(msg)) {
      title = 'Host not found';
      text = !d ? esc(msg)
        : !open ? 'Could not connect to any signalling relay, so the host can\'t be found. Check your internet connection; an ad or tracker blocker, or a firewall, can block the relays.'
          : !d.peers.length ? `Nobody answered in room <b>${esc(inv.room)}</b>. Make sure the host still has the lobby open (the room closes when the host leaves) and that the link is complete.`
            : 'Found the host, but could not finish joining.';
      tip = TRY_OTHER_NETWORK;
    }
    const back = () => { this.setHash(null); this.invite = null; this.toMenu(); };
    screen({
      title, sub: `Room ${inv.room}`, wide: true, back,
      body: `<div class="on-wrap narrow"><p class="on-text">${text}</p>${tip ? `<p class="on-note">${tip}</p>` : ''}</div>
        ${retry ? '<div class="ov-actions"><button class="wc-btn small" id="on-back">Back to menu</button></div>' : ''}`,
      primary: retry ? { label: 'Try again', run: () => this.joinScreen(inv, { again }) } : { label: 'Back to menu', run: back },
    });
    if (retry) $('on-back').onclick = back;
  }

  // ---------------------------------------------------------------- the lobby
  enter(lobby, inv) {
    this.lobby = lobby; this.invite = inv;
    this.seatSig.clear(); this.prevSeats = null; this.kickArmed = null; this.log = [];
    lobby.on('change', () => { if (this.lobby === lobby && !this.inGame()) this.renderLobby(); });
    lobby.on('chat', (c) => { if (this.lobby === lobby && !this.inGame()) this.addLine(c); });
    lobby.on('error', (e) => { if (this.lobby === lobby && !this.inGame()) this.status(esc(e.message), 'bad'); });
    lobby.on('hostlost', () => { if (this.lobby === lobby && !this.inGame()) this.status('<i class="spin"></i>Lost contact with the host. Reconnecting…', 'warn'); });
    lobby.on('hostback', () => { if (this.lobby === lobby && !this.inGame()) this.renderLobby(true); });
    lobby.on('closed', (e) => this.closed(lobby, e));
    lobby.on('start', (session) => this.started(lobby, session));
    if (lobby.phase === 'playing') {   // a rejoin into a running match: the session comes with the first frame
      screen({ title: 'Rejoining', sub: `Room ${inv.room}`, body: '<div class="on-wrap narrow"><p class="on-status" id="on-status"><i class="spin"></i>Getting the match from the host…</p></div>' });
      return;
    }
    this.lobbyScreen();
  }
  lobbyScreen() {
    const l = this.lobby, inv = this.invite;
    screen({
      title: 'Lobby', sub: `Line Tower Wars · Room ${l.room}`, wide: true,
      body: `<div class="lobby">
          <div class="lb-seats" id="lb-seats"></div>
          <div class="lb-side">
            ${mapRow()}
            <div class="lb-invite">
              <span class="lb-label">Invite link</span>
              <div class="lb-linkrow"><input id="lb-link" class="on-input" readonly value="${esc(inv.link || l.link)}"><button class="lb-btn" id="lb-copy">Copy</button></div>
              <span class="lb-room">Room code <b>${esc(l.room)}</b></span>
            </div>
            <div class="lb-net" id="lb-net"></div>
            <div class="lb-opt" id="lb-opt"></div>
            <p class="lb-rules">Everyone starts with ${LTW_RULES.startGold} gold, ${LTW_RULES.startIncome} income and ${LTW_RULES.startLives} lives. Send creeps to the next player, steal their lives, be the last one standing.</p>
          </div>
          <div class="lb-chat">
            <div class="lb-log" id="lb-log"></div>
            <div class="lb-say"><input id="lb-in" class="on-input" maxlength="255" placeholder="Say something to the lobby" autocomplete="off" spellcheck="false" enterkeyhint="send"><button class="lb-btn" id="lb-send">Send</button></div>
          </div>
          <div class="lb-foot ov-foot"><p class="on-status" id="lb-status"></p><button class="wc-btn small" id="lb-leave">${l.isHost ? 'Close lobby' : 'Leave'}</button></div>
        </div>`,
      primary: l.isHost ? { label: 'Start game', run: () => this.start() } : { label: 'Ready', run: () => this.toggleReady() }, cls: 'lobby-box',
    });
    bindPictures();
    $('lb-copy').onclick = () => this.copyLink();
    $('lb-link').onclick = () => $('lb-link').select();
    const say = () => { const v = $('lb-in').value.trim(); if (v) { this.lobby.chat(v); $('lb-in').value = ''; } };
    $('lb-send').onclick = say;
    $('lb-in').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); say(); } };
    $('lb-leave').onclick = () => this.leave();
    for (const line of this.log) this.renderLine(line);
    this.renderLobby(true);
    clearInterval(this.netTimer);
    this.netTimer = setInterval(() => { if (this.lobby && !this.inGame() && $('lb-net')) this.renderNet(); else clearInterval(this.netTimer); }, 1000);
  }
  copyLink() {
    const input = $('lb-link'), done = () => { $('lb-copy').textContent = 'Copied'; setTimeout(() => { if ($('lb-copy')) $('lb-copy').textContent = 'Copy'; }, 1500); };
    const fallback = () => { input.select(); try { document.execCommand('copy'); done(); } catch { /* the field stays selected */ } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, fallback);
    else fallback();
  }
  renderLobby(force = false) {
    const l = this.lobby;
    if (!l || !$('lb-seats')) return;
    if (force) this.seatSig.clear();
    this.seatChanges(l.seats);
    const root = $('lb-seats');
    for (const s of l.seats) {
      const sig = JSON.stringify([s.kind, s.name, s.difficulty, s.ready, s.connected, s.me, l.isHost, this.kickArmed === s.slot]);
      if (this.seatSig.get(s.slot) === sig) continue;
      this.seatSig.set(s.slot, sig);
      let row = root.querySelector(`.seat[data-slot="${s.slot}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'seat lb-seat'; row.dataset.slot = s.slot;
        const before = [...root.children].find(r => +r.dataset.slot > s.slot);
        root.insertBefore(row, before || null);
      }
      row.innerHTML = this.seatHtml(s);
      row.classList.toggle('me', !!s.me);
      row.classList.toggle('human', s.kind === 'human');   // a phone gives a player's name a line of its own (style.css)
      const sel = row.querySelector('select');
      if (sel) sel.onchange = () => { const [kind, difficulty] = sel.value.split(':'); l.setSeat(s.slot, { kind, difficulty }); };
      const kick = row.querySelector('.rm');
      if (kick) kick.onclick = () => this.kick(s.slot);
    }
    // options
    const opt = $('lb-opt'), extra = l.options.extra !== false;
    const optHtml = l.isHost
      ? `<button class="lb-toggle${extra ? ' on' : ''}" id="lb-extra" aria-pressed="${extra}">${extra ? 'On' : 'Off'}</button><span>Allow <b>-onextra</b>: a player's income grows by a tenth at every income tick (one player at a time).</span>`
      : `<span class="lb-flag${extra ? ' on' : ''}">${extra ? 'On' : 'Off'}</span><span><b>-onextra</b> ${extra ? 'is allowed in this game' : 'is off in this game'}.</span>`;
    if (opt.dataset.v !== optHtml) {
      opt.dataset.v = optHtml; opt.innerHTML = optHtml;
      if (l.isHost) $('lb-extra').onclick = () => l.setOptions({ extra: !(l.options.extra !== false) });
    }
    // start / ready
    const b = $('ov-btn'), mine = l.seats.find(s => s.me);
    if (l.isHost) {
      const why = startWhy(l.seats);
      b.disabled = !!why;
      this.status(why ? esc(why) : 'Everyone is ready. Start the game when you like.', why ? '' : 'good');
    } else if (mine) {
      b.textContent = mine.ready ? 'Not ready' : 'Ready';
      b.disabled = false;
      this.status(mine.ready ? 'You are ready. Waiting for the host to start the game.' : 'Press Ready when you are.', mine.ready ? 'good' : '');
    }
    this.renderNet();
  }
  seatHtml(s) {
    const l = this.lobby, color = `<i class="sw" style="background:${PLAYER_HEX[s.slot]}"></i><b style="color:${PLAYER_TEXT[s.slot]}">${esc(LTW_COLORS[s.slot] || s.color || '')}</b>`;
    if (s.kind === 'human') {
      const tag = s.slot === 1 ? '<span class="lb-tag host">Host</span>' : !s.connected ? '<span class="lb-tag warn">Reconnecting…</span>'
        : s.ready ? '<span class="lb-tag good">Ready</span>' : '<span class="lb-tag">Not ready</span>';
      const kick = l.isHost && s.slot !== 1 ? `<button class="rm${this.kickArmed === s.slot ? ' armed' : ''}" title="${this.kickArmed === s.slot ? `${clickWord()} again to kick` : 'Kick this player'}" aria-label="Kick ${esc(s.name)}">${this.kickArmed === s.slot ? '?' : '✕'}</button>` : '<span></span>';
      return `${color}<span class="lb-who"><b class="nm">${esc(s.name)}</b>${s.me ? '<em>you</em>' : ''}${tag}</span>${kick}`;
    }
    const label = s.kind === 'bot' ? `Computer (${DIFF_NAME[s.difficulty] || 'Normal'})` : s.kind === 'closed' ? 'Closed' : 'Open';
    if (!l.isHost) return `${color}<span class="lb-who ${s.kind}">${esc(label)}</span><span></span>`;
    const value = s.kind === 'bot' ? 'bot:' + s.difficulty : s.kind;
    const opts = [['open', 'Open'], ['closed', 'Closed'], ...DIFFICULTIES.map(d => ['bot:' + d, `Computer (${DIFF_NAME[d]})`])]
      .map(([v, t]) => `<option value="${v}"${v === value ? ' selected' : ''}>${t}</option>`).join('');
    return `${color}<span class="lb-who"><select class="lb-select" aria-label="${esc(LTW_COLORS[s.slot])} seat">${opts}</select></span><span></span>`;
  }
  // Who came, went, dropped or came back since the last lobby update: a line in the lobby chat, as WC3 does.
  seatChanges(seats) {
    const prev = this.prevSeats;
    this.prevSeats = new Map(seats.map(s => [s.slot, { ...s }]));
    if (!prev || !prev.size) return;   // the first lobby state: everyone was here before me
    for (const s of seats) {
      const p = prev.get(s.slot), was = p && p.kind === 'human' ? p : null, is = s.kind === 'human' ? s : null;
      if (is && (!was || was.name !== is.name) && !is.me) this.addLine({ slot: s.slot, sys: `${is.name} has joined the game.` });
      else if (was && !is) this.addLine({ slot: s.slot, sys: `${was.name} has left the game.` });
      else if (was && is && was.connected && !is.connected) this.addLine({ slot: s.slot, sys: `${is.name} lost the connection. The seat is kept for ${GRACE} seconds.` });
      else if (was && is && !was.connected && is.connected) this.addLine({ slot: s.slot, sys: `${is.name} is back.` });
    }
  }
  addLine(line) {
    this.log.push(line);
    if (this.log.length > MAX_LOG) this.log.shift();
    this.renderLine(line);
  }
  renderLine({ slot, name, text, sys }) {
    const box = $('lb-log');
    if (!box) return;
    const d = document.createElement('div');
    if (sys) { d.className = 'sys'; d.innerHTML = `<span style="color:${PLAYER_TEXT[slot] || '#fff'}">${esc(sys)}</span>`; }
    else d.innerHTML = `<b style="color:${PLAYER_TEXT[slot] || '#fff'}">${esc(name)}:</b> ${esc(text)}`;
    box.appendChild(d);
    while (box.children.length > MAX_LOG) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  renderNet() {
    const l = this.lobby, el = $('lb-net');
    if (!l || !el) return;
    let html;
    if (l.isHost) {
      const d = l.diagnostics ? l.diagnostics() : null;
      const relays = d ? [...d.nostr, ...d.torrent] : [], open = relays.filter(r => r[1] === 'open').length;
      const humans = l.seats.filter(s => s.kind === 'human' && s.slot !== 1), on = humans.filter(s => s.connected).length;
      html = !d ? '' : open ? `<i class="dot good"></i>Reachable: ${open} signalling relay${open === 1 ? '' : 's'} connected.${humans.length ? ` ${on} of ${humans.length} player${humans.length === 1 ? '' : 's'} connected.` : ' Friends can join with the link now.'}`
        : relays.length ? '<i class="dot warn"></i>Connecting to the signalling relays…' : '<i class="dot bad"></i>No signalling relay answers yet: friends can\'t find this room. Check your internet connection.';
    } else {
      const ping = l.conn && l.conn.ping !== null ? Math.round(l.conn.ping * 1000) : null;
      html = l.hostLost ? '<i class="dot bad"></i>No answer from the host…' : `<i class="dot good"></i>Connected to the host${ping !== null ? ` · ping ${ping} ms` : ''}.`;
    }
    if (el.dataset.v !== html) { el.dataset.v = html; el.innerHTML = html; }
  }
  toggleReady() {
    const mine = this.lobby && this.lobby.seats.find(s => s.me);
    if (mine) this.lobby.setReady(!mine.ready);
  }
  start() {
    const why = startWhy(this.lobby.seats);
    if (why) return this.status(esc(why), 'bad');
    $('ov-btn').disabled = true;
    this.status('<i class="spin"></i>Starting…');
    this.lobby.start();
  }
  kick(slot) {
    if (this.kickArmed !== slot) {
      this.kickArmed = slot;
      clearTimeout(this.kickTimer);
      this.kickTimer = setTimeout(() => { this.kickArmed = null; this.renderLobby(); }, KICK_ARM);
      return this.renderLobby();
    }
    this.kickArmed = null;
    this.lobby.kick(slot);
    this.renderLobby();
  }
  leave() {
    const l = this.lobby;
    this.lobby = null; this.invite = null;
    this.setHash(null);
    if (l) l.leave();
    this.toMenu();
  }

  // ---------------------------------------------------------------- the match
  started(lobby, session) {
    if (this.lobby !== lobby) return;
    clearInterval(this.netTimer);
    hideScreen();
    this.enterGame();
    this.ltw.attach(session, { online: { room: lobby.room, link: this.invite.link, isHost: lobby.isHost, onEnd: (e) => this.gameEnded(lobby, e) } });
  }
  // The session ended for a reason other than the end of the match (the game screen has stopped): back to the menu's
  // scene, with the screen that says what happened on top.
  gameEnded(lobby, e) {
    if (this.lobby === lobby) this.lobby = null;
    this.toMenu();
    if (e.reason === 'lost' && !lobby.isHost && this.invite) return this.joinScreen(this.invite, { again: true });
    this.closedScreen(e);
  }
  // The lobby closed: in the lobby phase that is this screen's business; in a match the game screen has its own (and
  // after the end of the match a closing host is just a message).
  closed(lobby, e) {
    clearInterval(this.netTimer);
    if (this.lobby !== lobby) return;
    this.lobby = null;
    if (this.inGame()) {   // after the end of the match: the room is gone, so is its link in the address bar
      this.setHash(null); this.invite = null;
      if (e.reason === 'host-left') this.ltw.hud.message('The host has left. The game is over.', '#ffd84a');
      return;
    }
    if (e.reason === 'left') { this.setHash(null); this.invite = null; return; }   // left on purpose (the seat is gone)
    if (e.reason === 'lost' && !lobby.isHost && this.invite) return this.joinScreen(this.invite, { again: true });
    this.closedScreen(e);
  }
  closedScreen(e) {
    const what = {
      'host-left': ['The host left', 'The game is over', 'The host closed the game, so it has ended for everyone.'],
      kicked: ['Removed', 'You are out of this game', esc(e.message || 'The host removed you from the game.')],
      replaced: ['Joined elsewhere', 'This tab is out of the game', 'You joined this game from another tab, which has your seat now.'],
      lost: ['Connection lost', 'The game is over', 'Lost the connection to the host.'],
    }[e.reason] || ['Disconnected', 'The game is over', esc(e.message || 'The connection to the game closed.')];
    this.setHash(null); this.invite = null;
    screen({
      title: what[0], sub: what[1], wide: true,
      body: `<div class="on-wrap narrow"><p class="on-text">${what[2]}</p></div>`,
      primary: { label: 'Back to menu', run: () => this.toMenu() }, back: () => this.toMenu(),
    });
  }
}

// The game's map on the join screen and in the lobby: its picture, its name and how many play it.
function mapRow(m = MAP_ONLINE) {
  return `<div class="lb-map">${mapPicture(m, 'thumb')}<span class="lb-mapinfo"><span class="lb-label">Map</span><b>${m.name}</b><em>${m.players}</em></span></div>`;
}

// What the join screen says while joinLobby runs, from the transport's own diagnostics.
function joinStage(d, room) {
  if (!d) return 'Loading the network code…';
  const open = [...d.nostr, ...d.torrent].filter(r => r[1] === 'open').length;
  if (!open) return 'Connecting to the signalling relays…';
  if (!d.peers.length) return `Looking for the host of room <b>${esc(room)}</b>… <span class="dim">(${open} relay${open === 1 ? '' : 's'})</span>`;
  return 'Found the host. Joining the lobby…';
}
// Why the host can't start yet, or null.
function startWhy(seats) {
  const filled = seats.filter(s => s.kind === 'human' || s.kind === 'bot');
  if (filled.length < 2) return 'You need at least two players: open a seat for a friend, or add a computer.';
  const away = seats.filter(s => s.kind === 'human' && !s.connected);
  if (away.length) return `Waiting for ${away.map(s => s.name).join(', ')} to reconnect.`;
  const waiting = seats.filter(s => s.kind === 'human' && s.slot !== 1 && !s.ready);
  if (waiting.length) return `Waiting for ${waiting.map(s => s.name).join(', ')} to be ready.`;
  return null;
}
