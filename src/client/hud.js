// The Line Tower Wars console: resources, the scoreboard (multiboard), map messages and chat, the income list, the
// command card with its Build tab, the three shop pages of the Send tab, the Tech tab (wisps into tech buildings) and
// the Arcade (lumber and wisps), the info panel, the portrait and the minimap of every lane.
// Built on the Classic UI (tower icons, tooltips, messages, announcements); it reads only the world model fields that
// docs/SPEC-client.md lists, so it works the same on a live Match and on an online replica.
// The build phase (docs/SPEC-ltw.md): a timer window counts down to the shrines opening, the Send and Arcade buttons say
// why they wait, and every clock the console shows is the map's (match time minus the build phase).
import { UI, ARMOR_NAME, ATK_NAME, kindName, specials, mapNote, placeTip, cardTipRect, keepLine } from '../ui.js?v=3947ef6d39d3';
import { TOWERS, BUILD_ROOTS } from '../data/towers.js?v=3947ef6d39d3';
import { LTW_UNITS, LTW_SHOPS, LTW_TECH, LTW_TECH_ORDER, LTW_TOWER_STATS, LTW_CHAT, LTW_CREEP_FIX, LTW_MESSAGES, LTW_RULES } from '../data/ltw.js?v=3947ef6d39d3';
import { unitSpeed, missingTech, requiresText, techName, LANE_ROWS } from '../lane.js?v=3947ef6d39d3';
import { TPS, prepWhy } from '../match.js?v=3947ef6d39d3';
import { P, sx, sy } from '../render.js?v=3947ef6d39d3';
import { laneDY, PLAYER_HEX, PLAYER_TEXT, DIFF_NAME, esc, clock, short, signed, botNamed } from './common.js?v=3947ef6d39d3';
import { tipButton, heldClick, clickWord, phone } from './touch.js?v=3947ef6d39d3';
import { src } from '../assets.js?v=3947ef6d39d3';
import { pixelRatio } from '../device.js?v=3947ef6d39d3';

const $ = (id) => document.getElementById(id);
export const GRID_KEYS = ['Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
// The Tech tab is five columns, one per element (tier 1 on top, its two tier-2 buildings below): the grid keys plus
// the fifth column T / G / B.
export const TECH_KEYS = ['Q', 'W', 'E', 'R', 'T', 'A', 'S', 'D', 'F', 'G', 'Z', 'X', 'C', 'V', 'B'];
export const TABS = [{ id: 'build', name: 'Build', tip: 'Towers for your lane' },
  ...LTW_SHOPS.map(s => ({ id: s.id, name: s.name, tip: `Send creeps from the ${s.name}` })),
  { id: 'tech', name: 'Tech', tip: 'Spend wisps on tech buildings, which unlock tower upgrades' },
  { id: 'arcade', name: 'Arcade', tip: 'Buy lumber and train wisps' }];
export const TECH_TAB = TABS.findIndex(t => t.id === 'tech'), ARCADE_TAB = TABS.findIndex(t => t.id === 'arcade');
const ROOTS = ['h003', 'h000', 'h008'].filter(id => BUILD_ROOTS.includes(id));
const SELL_AT = 9, DESTROY_AT = 10, CANCEL_AT = 11, KEEP_AT = 8;
const SHOP_EVERY = 0.2;      // seconds between shop, tech and Arcade refreshes (stock, countdowns)
const MAX_LINES = 8;         // map messages and chat lines shown at once
// Element columns of the Tech tab, in the data's order (each element's tier-1 building first).
const ELEMENTS = [...new Set(LTW_TECH_ORDER.map(id => LTW_TECH[id].element))];
const TECH_CELL = Object.fromEntries(ELEMENTS.flatMap(el => LTW_TECH_ORDER.filter(id => LTW_TECH[id].element === el)
  .sort((a, b) => LTW_TECH[a].tier - LTW_TECH[b].tier).map((id, row) => [id, row * ELEMENTS.length + ELEMENTS.indexOf(el)])));
const LUMBER_SENDS = Object.values(LTW_UNITS).filter(u => u.sold && u.lumber > 0).sort((a, b) => a.lumber - b.lumber);
const INCOME_LINE = /^(\d+)\)\s+(-?\d+)$/;
// The map's life-steal lines, split where the template puts the player's name.
function template(t, key) {
  const [pre, post] = t.split('{' + key + '}');
  return { pre, post, test: (s) => s.length > pre.length + post.length && s.startsWith(pre) && s.endsWith(post) };
}
const STOLEN_FROM_YOU = template(LTW_MESSAGES.stolenFromYou, 'owner'), YOU_STOLE = template(LTW_MESSAGES.youStole, 'victim');
// The map's clock: match seconds since the build phase ended (the phase's own seconds are counted down instead).
const buildPhase = (w) => (w.options && w.options.prep) || 0;
export const mapTime = (w, t = w.time) => t - buildPhase(w);
export const mapClock = (w, t = w.time) => clock(Math.max(0, mapTime(w, t)));
const prepSecs = (w) => Math.max(1, Math.ceil(w.prepLeft - 1e-9));   // the build phase's seconds left, as the refusals say them
const PREP_SOON = 5;         // the last seconds of the build phase, in red

export class LtwHud extends UI {
  constructor(mode) {
    super(mode.world, mode.renderer, mode.actions);
    this.mode = mode; this.me = mode.me;
    this.tab = 0; this.shopData = null; this.shopT = -1; this.techData = null; this.arcadeData = null; this.tip = -1; this.cmdT = 0;
    this.mmBase = null; this.mmKey = ''; this.mmT = 0;
    this.confirm = null;                 // { key, name }: a Destroy waiting for its second click
    this.steals = [];                    // life-steal lines waiting for their 'stolen' event (it says whose name it is)
    this.income = { at: null, until: -1, lines: {} };   // the map's income list, shown as one panel
    this.unitIcons = new Map();
    this.prepTimer();
    $('income-list').classList.remove('show');
    $('income-list').onclick = () => { this.income.until = -1; this.renderIncome(); };   // put away until the next list
    this.buildTabs();
    this.buildBoard();
  }

  // ---------------------------------------------------------------- command card
  buildCommandGrid() {
    const root = $('ltw-commands');
    root.innerHTML = '';
    for (let i = 0; i < TECH_KEYS.length; i++) {
      const b = document.createElement('button');
      b.className = 'cmd empty';
      tipButton(b, () => this.showTip(i, b), () => this.hideTip());
      // the card may be a few frames old (gold just came in, a unit unlocked): what the click presses is what is true now
      b.onclick = () => { if (heldClick(b)) return; this.renderCommands(this.act.view()); if (this.press(this.cmds[i]) && this.tip === i) this.showTip(i, b); };
      root.appendChild(b);
    }
  }
  // A click or hotkey: a button that can't be used (greyed out, or too dear) says why instead of asking the match, so
  // a held key or a fast clicker sends nothing the host would refuse anyway.
  press(c) {
    if (!c || !c.run) return false;
    if ((c.off || c.poor) && c.why) { this.error(c.why); return false; }
    c.run();
    this.refresh(true);
    return true;
  }
  buildTabs() {
    const root = $('cmd-tabs');
    root.innerHTML = '';
    TABS.forEach((t, i) => {
      const b = document.createElement('button');
      b.className = 'cmd-tab' + (i === this.tab ? ' on' : '');
      b.innerHTML = `${esc(t.name)}<span class="tab-n"></span>`; b.title = `${t.tip} (Tab cycles)`;
      b.onclick = () => this.setTab(i);
      root.appendChild(b);
    });
  }
  setTab(i) {
    const v = this.act.view();
    if (v.sel && (v.sel.o.def.upgrades || v.sel.o.def.tech) && v.sel.slot === this.me) v.sel = null;   // my tower's card would hide the tab
    this.confirm = null;
    this.tab = (i + TABS.length) % TABS.length;
    [...$('cmd-tabs').children].forEach((b, k) => b.classList.toggle('on', k === this.tab));
    this.hideTip();
    this.refresh(true);
  }
  shop(force = false) {
    const w = this.mode.world;
    if (force || !this.shopData || Math.abs(w.time - this.shopT) >= SHOP_EVERY) {
      this.shopData = w.shop(this.me); this.techData = w.tech(this.me); this.arcadeData = w.arcade(this.me); this.shopT = w.time;
    }
    return this.shopData;
  }
  tech() { this.shop(); return this.techData; }
  arcade() { this.shop(); return this.arcadeData; }
  // Why the player can't send this unit right now (the match checks again), or null.
  sendWhy(s) {
    const w = this.mode.world, p = w.players[this.me];
    if (!p.alive) return 'You have been eliminated.';
    if (w.phase === 'prep') return prepWhy(w.prepLeft);
    if (!s.available) return 'Not available yet.';
    if (s.stock < 1) return 'Out of stock.';
    if (p.gold < s.cost) return 'Not enough gold.';
    if (p.lumber < s.lumber) return 'Not enough lumber.';
    const to = w.next(this.me);
    if (to === null || to === this.me) return 'No opponent left.';
    return null;
  }
  commandsFor(view) {
    const w = this.mode.world, p = w.players[this.me], lane = w.lanes[this.me], list = new Array(12).fill(null);
    if (view.placing) {   // Keep building: what Shift does, for a pointer without a keyboard
      list[KEEP_AT] = { sig: 'keep:' + !!view.keep, glyph: 'keep', on: !!view.keep, title: view.keep ? 'Keep building (on)' : 'Keep building',
        lines: [keepLine(view.keep)], run: () => this.act.keep() };
      list[CANCEL_AT] = { sig: 'cancel', glyph: 'cancel', key: 'Esc', title: 'Cancel', lines: ['Stop placing towers.'], run: () => this.act.cancel() };
      return list;
    }
    const sel = view.sel && view.sel.o, mine = !!sel && view.sel.slot === this.me && p.alive && !p.left;
    const target = mine && (sel.def.upgrades || sel.def.tech) ? sel.id : null;
    if (this.confirm && this.confirm.key !== target) this.confirm = null;
    if (this.confirm) {   // the second click of Destroy
      const name = this.confirm.name;
      list[DESTROY_AT] = { sig: 'confirm', glyph: 'destroy', key: GRID_KEYS[DESTROY_AT], armed: true, title: `Destroy the ${name}?`,
        lines: [`${clickWord()} again to destroy it, with no refund.`], run: () => { this.confirm = null; this.act.destroy(sel); } };
      list[CANCEL_AT] = { sig: 'cancel', glyph: 'cancel', key: 'Esc', title: 'Cancel', lines: [`Keep the ${esc(name)}.`], run: () => { this.confirm = null; } };
      return list;
    }
    const destroy = (what, lines) => ({ sig: 'destroy', glyph: 'destroy', key: GRID_KEYS[DESTROY_AT], title: `Destroy ${what}`, lines,
      run: () => { this.confirm = { key: target, name: sel.def.name }; } });
    if (mine && sel.def.upgrades) {
      if (sel.sellAt !== undefined) return list;
      sel.def.upgrades.forEach((id, i) => {
        const def = TOWERS[id], why = lane.whyNotUpgrade(sel, id), req = missingTech(p, id)[0];
        const poor = why === 'Not enough gold.';
        list[i] = { sig: 'u:' + id + (req ? '/' + req : ''), def, req, key: GRID_KEYS[i], cost: def.cost, poor, off: !!why && !poor, why, title: 'Upgrade to ' + def.name,
          upgrade: true, run: () => this.act.upgrade(sel, id) };
      });
      list[SELL_AT] = { sig: 'sell', glyph: 'sell', key: 'X', title: 'Sell tower', lines: [`Returns <b>${lane.sellValue(sel)}</b> gold after 1 second.`], run: () => this.act.sell(sel) };
      list[DESTROY_AT] = destroy('tower', ['Destroys this tower at once, with no refund (the chat command -destroy).', 'Asks again before it goes.']);
      return list;
    }
    if (mine && sel.def.tech) {
      list[DESTROY_AT] = destroy('building', ['Destroys this tech building, with no refund (the chat command -destroy).',
        'Towers already built stay; new ones need it again.']);
      return list;
    }
    const tab = TABS[this.tab].id;
    if (tab === 'build') {
      ROOTS.forEach((id, i) => {
        const def = TOWERS[id], miss = missingTech(p, id);
        const why = !p.alive ? 'You have been eliminated.' : miss.length ? requiresText(miss) : p.gold < def.cost ? 'Not enough gold.' : null;
        const poor = why === 'Not enough gold.';
        list[i] = { sig: 'b:' + id + (miss.length ? '/' + miss[0] : ''), def, req: miss[0], key: GRID_KEYS[i], cost: def.cost, poor, off: !!why && !poor, why,
          title: 'Build ' + def.name, run: () => this.act.place(def) };
      });
      return list;
    }
    if (tab === 'tech') {
      const out = new Array(TECH_KEYS.length).fill(null);
      for (const t of this.tech()) {
        const i = TECH_CELL[t.id], poor = !t.owned && t.why === 'You have no wisp.';
        const req = t.owned ? undefined : t.requires.find(r => !(p.tech || []).includes(r));
        out[i] = { sig: 'k:' + t.id + (req ? '/' + req : ''), tech: t, req, key: TECH_KEYS[i], owned: t.owned, poor, off: !t.owned && !!t.why && !poor,
          why: t.owned ? null : t.why, title: t.name, run: () => this.act.tech(t.id) };
      }
      return out;
    }
    if (tab === 'arcade') {
      const a = this.arcade();
      for (const [i, item, title] of [[0, 'lumber', 'Buy lumber'], [1, 'wisp', 'Train a wisp']]) {
        const why = a[item].why, poor = why === 'Not enough gold.' || why === 'Not enough lumber.';
        list[i] = { sig: 'a:' + item, glyph: item, arcade: item, a, key: GRID_KEYS[i], cost: a[item].cost, poor, off: !!why && !poor, why, title,
          run: () => this.act.arcade(item) };
      }
      return list;
    }
    const page = this.shop()[this.tab - 1];
    if (!page) return list;
    page.units.forEach((s, i) => {
      if (i >= 12) return;
      const why = this.sendWhy(s);
      const poor = why === 'Not enough gold.' || why === 'Not enough lumber.';
      list[i] = { sig: 's:' + s.id, unit: LTW_UNITS[s.id], s, key: GRID_KEYS[i], cost: s.cost, poor, off: !!why && !poor, why, title: s.name, run: () => this.act.send(s.id) };
    });
    return list;
  }
  renderCommands(view) {
    this.cmds = this.commandsFor(view);
    const root = $('ltw-commands'), buttons = root.children, wide = this.cmds.length > 12;
    root.classList.toggle('tech', wide);
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i], c = this.cmds[i] || null;
      const sig = c ? `${c.sig}|${c.key}` : '';
      if (b.dataset.sig !== sig) {
        b.dataset.sig = sig;
        b.innerHTML = '';
        b.className = 'cmd' + (c ? '' : ' empty');
        b.setAttribute('aria-label', c ? c.title + (c.key && c.key !== 'Esc' ? ` (${c.key})` : '') : '');
        if (c) {
          b.appendChild(c.unit ? this.unitIcon(c.unit) : c.tech ? this.techIcon(c.tech.id) : c.def ? this.icon(c.def) : this.glyph(c.glyph));
          if (c.key) b.insertAdjacentHTML('beforeend', `<span class="hk">${c.key === 'Esc' ? '' : c.key}</span>`);
          if (c.cost) b.insertAdjacentHTML('beforeend', `<span class="cost">${short(c.cost)}</span>`);
          if (c.unit) b.insertAdjacentHTML('beforeend', `<span class="inc ${c.s.income < 0 ? 'neg' : ''}">${c.s.income ? signed(c.s.income) : ''}</span>`
            + (c.s.lumber ? `<span class="lum"><i class="ico ico-lumber"></i>${c.s.lumber}</span>` : '')
            + (c.s.copies === 1 ? '<span class="one">×1</span>' : '') + '<span class="stk"></span><i class="rs"></i><i class="sweep"></i><b class="lock"></b>');
          if (c.arcade === 'lumber') b.insertAdjacentHTML('beforeend', '<span class="stk"></span><i class="rs"></i><i class="sweep"></i><b class="lock"></b>');
          if (c.arcade === 'wisp') b.insertAdjacentHTML('beforeend', `<span class="inc neg">${signed(c.a.wisp.income)}</span><span class="stk"></span><i class="rs"></i>`);
          if (c.tech) b.insertAdjacentHTML('beforeend', '<b class="own">✓</b>');
          if (c.req) {   // the tech building it waits for, in the corner (so a touch screen sees it without a tooltip)
            const r = document.createElement('canvas'); r.className = 'req'; r.width = r.height = 40;
            r.getContext('2d').drawImage(this.techIcon(c.req), 0, 0, 40, 40);
            b.appendChild(r);
          }
        }
      }
      b.classList.toggle('hidden', !wide && i >= 12);
      if (!c) continue;
      b.classList.toggle('poor', !!c.poor);
      b.classList.toggle('off', !!c.off);
      b.classList.toggle('owned', !!c.owned);
      b.classList.toggle('armed', !!c.armed);
      b.classList.toggle('active', !!(view.placing && c.def === view.placing) || !!c.on);
      if (c.unit && c.s.lumber) b.classList.toggle('poor-lumber', this.mode.world.players[this.me].lumber < c.s.lumber);
      if (c.unit || c.arcade === 'lumber') {
        const s = c.unit ? c.s : c.a.lumber, regen = c.unit ? c.unit.stock.replenish : 1, open = s.available;
        const prog = s.restockIn === null ? 1 : Math.max(0, Math.min(1, 1 - s.restockIn / regen));
        b.classList.toggle('locked', !open);
        b.classList.toggle('out', open && s.stock < 1);
        setText(b.querySelector('.stk'), open && (s.stock < s.max || s.max < 32) ? String(s.stock) : '');
        setText(b.querySelector('.lock'), open ? '' : clock(Math.ceil(s.opensIn)));
        const rs = b.querySelector('.rs'), sw = b.querySelector('.sweep');
        rs.style.setProperty('--rs', open && s.stock > 0 && s.stock < s.max ? prog.toFixed(3) : '0');
        sw.style.setProperty('--p', open && s.stock < 1 ? prog.toFixed(3) : '1');
      } else if (c.arcade === 'wisp') {   // the training queue: how many, and the first one's progress along the top
        const q = c.a.wisp.queue, bt = c.a.wisp.buildTime;
        setText(b.querySelector('.stk'), q.length ? String(q.length) : '');
        b.querySelector('.rs').style.setProperty('--rs', q.length ? Math.max(0, Math.min(1, 1 - q[0] / bt)).toFixed(3) : '0');
      }
    }
  }
  hotkey(key) {
    this.renderCommands(this.act.view());   // the card may be a few frames old (a sale finished, a unit unlocked)
    const k = key.toUpperCase();
    const c = this.cmds.find(c => c && c.key && c.key.toUpperCase() === k);
    if (!c) return false;
    this.press(c);
    return true;
  }
  // Send-button art: the unit's own icon, else a framed crop of its portrait (or of its sprite).
  unitIcon(u) {
    if (this.unitIcons.has(u.id)) return this.unitIcons.get(u.id);
    const ic = this.iconRect('u_' + u.id);
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    if (ic) {
      c.width = ic.w; c.height = ic.h;
      x.drawImage(ic.img, ...src(ic), 0, 0, ic.w, ic.h);
    } else {
      c.width = 108; c.height = 108;
      const g = x.createRadialGradient(54, 40, 4, 54, 54, 80);
      g.addColorStop(0, u.flying ? '#3a5a7a' : u.boss ? '#6a2a1a' : '#4a3a24'); g.addColorStop(1, '#050403');
      x.fillStyle = g; x.fillRect(0, 0, 108, 108);
      const p = this.man.portraits && (this.man.portraits[u.id] || this.man.portraits[u.look]);
      if (p && p.img) x.drawImage(p.img, ...src(p, p.fw * 0.08, p.fh * 0.04, p.fw * 0.84, p.fh * 0.84), 0, 0, 108, 108);
      else {
        const b = this.r.lookBox(u), s = Math.min(96 / b.fw, 96 / b.fh) * 1.25;
        this.r.drawStill(x, u, 0, 54, 100, s);
      }
      x.strokeStyle = 'rgba(0,0,0,0.8)'; x.lineWidth = 4; x.strokeRect(0, 0, 108, 108);
    }
    this.unitIcons.set(u.id, c);
    return c;
  }
  // A tech building's icon (icons tech_<id>), else its lane sprite on a dark plate.
  techIcon(id) {
    const key = 'tech:' + id;
    if (this.icons.has(key)) return this.icons.get(key);
    const ic = this.iconRect('tech_' + id), c = document.createElement('canvas'), x = c.getContext('2d');
    if (ic) { c.width = ic.w; c.height = ic.h; x.drawImage(ic.img, ...src(ic), 0, 0, ic.w, ic.h); }
    else {
      c.width = 108; c.height = 108;
      x.fillStyle = '#0b0a09'; x.fillRect(0, 0, 108, 108);
      const m = this.man.props['tech_' + id];
      if (m && m.img) { const s = Math.min(100 / m.w, 100 / m.h); x.drawImage(m.img, ...src(m), 54 - (m.w * s) / 2, 104 - m.h * s, m.w * s, m.h * s); }
    }
    this.icons.set(key, c);
    return c;
  }
  // Glyphs the Line Tower Wars card adds: lumber and a wisp (the resource icons on a framed plate) and Destroy.
  glyph(kind) {
    if (kind !== 'lumber' && kind !== 'wisp' && kind !== 'destroy') return super.glyph(kind);
    const key = 'g:' + kind;
    if (this.icons.has(key)) return this.icons.get(key);
    const c = document.createElement('canvas'); c.width = c.height = 108;
    const x = c.getContext('2d');
    const bg = x.createRadialGradient(54, 46, 4, 54, 54, 78);
    bg.addColorStop(0, { lumber: '#5a4424', wisp: '#24486a', destroy: '#7a1c10' }[kind]); bg.addColorStop(1, '#050403');
    x.fillStyle = bg; x.fillRect(0, 0, 108, 108);
    const ui = this.man.ui && this.man.ui['res_' + kind];
    if (ui && ui.img) x.drawImage(ui.img, ...src(ui), 14, 14, 80, 80);
    else if (kind === 'destroy') {   // a burst over a broken stone
      x.fillStyle = '#5a5048'; x.beginPath(); x.moveTo(30, 86); x.lineTo(38, 54); x.lineTo(52, 64); x.lineTo(60, 44); x.lineTo(78, 86); x.closePath(); x.fill();
      x.strokeStyle = '#1a1410'; x.lineWidth = 3; x.stroke();
      const g = x.createRadialGradient(56, 46, 2, 56, 46, 34);
      g.addColorStop(0, '#fff6c2'); g.addColorStop(0.35, '#ffb040'); g.addColorStop(0.7, 'rgba(220,60,20,0.75)'); g.addColorStop(1, 'rgba(120,20,10,0)');
      x.fillStyle = g; x.beginPath();
      for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8, r = k % 2 ? 14 : 34; x.lineTo(56 + Math.cos(a) * r, 46 + Math.sin(a) * r * 0.85); }
      x.closePath(); x.fill();
    }
    x.strokeStyle = 'rgba(0,0,0,0.8)'; x.lineWidth = 4; x.strokeRect(0, 0, 108, 108);
    this.icons.set(key, c);
    return c;
  }

  // ---------------------------------------------------------------- tooltips
  showTip(i, el) {
    const c = this.cmds[i]; if (!c) return;
    this.tip = i; this.tipEl = el;
    const t = $('tooltip'), p = this.mode.world.players[this.me];
    let html = `<div class="t-title">${esc(c.title)}${c.key && c.key !== 'Esc' ? ` (<u>${c.key}</u>)` : ''}</div>`;
    if (c.unit) html += this.unitTip(c);
    else if (c.tech) html += this.techTip(c);
    else if (c.arcade) html += this.arcadeTip(c);
    else {
      if (c.cost !== undefined) html += `<div class="t-cost ${p.gold < c.cost ? 'poor' : ''}"><i class="ico ico-gold"></i>${c.cost === 0 ? 'Free' : c.cost}</div>`;
      const sel = this.act.view().sel;
      const lines = c.def ? this.towerLines(c.def, c.upgrade && sel ? sel.o.def : null) : (c.lines || []);
      html += lines.map(l => `<div class="t-line">${l}</div>`).join('');
      const note = c.def ? mapNote(c.def) : '';
      if (note) html += `<div class="t-note">${esc(note)}</div>`;
      if (c.why) html += `<div class="t-why">${esc(c.why)}</div>`;
      const miss = c.def ? missingTech(p, c.def.id) : [];
      if (miss.length) html += `<div class="t-line">Raise the ${miss.map(id => `<b>${esc(techName(id))}</b>`).join(' and ')} with a wisp in the <b>Tech</b> tab.</div>`;
    }
    t.innerHTML = html;
    t.classList.add('show');
    placeTip(t, cardTipRect(el));
  }
  hideTip() { this.tip = -1; $('tooltip').classList.remove('show'); }
  // A long press on a lane: a tower (with its owner and hit points), a creep (its sender) or a tech building.
  objectTipHtml(o) {
    const w = this.mode.world, owner = w.players[o.owner];
    const by = owner && o.owner !== this.me ? `<div class="t-line"><span>${o.def.upgrades || o.def.tech ? 'Owner' : 'Sent by'}</span> <b style="color:${PLAYER_TEXT[o.owner]}">${esc(owner.name)}</b></div>` : '';
    if (o.def.tech) {
      const t = LTW_TECH[o.techId];
      return `<div class="t-title">${esc(o.def.name)}</div>${by}` + (t ? `<div class="t-line"><span>Unlocks</span> ${t.unlocks.map(id => esc(TOWERS[id] ? TOWERS[id].name : id)).join(', ')}</div>` : '');
    }
    if (o.def.upgrades) {
      return `<div class="t-title">${esc(o.def.name)}</div>${by}` + (o.maxHp ? `<div class="t-line"><span>Hit points</span> ${Math.max(0, Math.ceil(o.hp))} / ${o.maxHp}</div>` : '')
        + this.towerLines(o.def).map(l => `<div class="t-line">${l}</div>`).join('') + `<div class="t-line"><span>Kills</span> ${o.kills ?? 0}</div>`;
    }
    const d = o.def, tags = unitTags(d);
    return `<div class="t-title">${esc(d.name)}</div>${by}<div class="t-line"><span>Hit points</span> ${Math.ceil(Math.max(0, o.hp))} / ${o.maxHp}</div>`
      + `<div class="t-line"><span>Armor</span> ${d.armor} ${ARMOR_NAME[d.armorType] || d.armorType} &nbsp; <span>Speed</span> ${unitSpeed(d.speed)}</div>`
      + (tags.length ? `<div class="t-line">${tags.map(t => `<span>${t.text}</span>`).join(' · ')}</div>` : '');
  }
  unitTip(c) {
    const u = c.unit, s = c.s, w = this.mode.world, p = w.players[this.me], to = w.next(this.me);
    const target = to !== null && to !== this.me ? w.players[to] : null;
    let h = `<div class="t-cost ${p.gold < s.cost ? 'poor' : ''}"><i class="ico ico-gold"></i>${s.cost}`
      + (s.lumber ? ` <i class="ico ico-lumber"></i><span class="${p.lumber < s.lumber ? 'poor' : ''}">${s.lumber}</span>` : '') + '</div>';
    h += `<div class="t-line"><span>Sends</span> ×${s.copies}${target ? ` to <b style="color:${PLAYER_TEXT[to]}">${esc(target.name)}</b>` : ''}`
      + ` &nbsp; <span>Income</span> <b class="${s.income < 0 ? 'neg' : 'pos'}">${s.income > 0 ? '+' : ''}${s.income}</b></div>`;
    if (!s.available) h += `<div class="t-line"><span>Available in</span> ${clock(Math.ceil(s.opensIn))}</div>`;
    else h += `<div class="t-line"><span>Stock</span> ${s.stock} / ${s.max}${s.restockIn !== null ? ` &nbsp; <span>next in</span> ${Math.ceil(s.restockIn)}s` : ''}</div>`;
    h += `<div class="t-line"><span>Hit points</span> ${u.hp} &nbsp; <span>Armor</span> ${u.armor} ${ARMOR_NAME[u.armorType] || u.armorType}</div>`;
    h += `<div class="t-line"><span>Speed</span> ${unitSpeed(u.speed)} &nbsp; <span>Bounty</span> ${bountyText(u)}</div>`;
    if (u.weapon) h += `<div class="t-line"><span>Attack</span> ${weaponText(u.weapon)}</div>`;
    const tags = unitTags(u);
    if (tags.length) h += `<div class="t-line">${tags.map(t => `<span>${t.text}</span>`).join(' · ')}</div>`;
    if (c.why) h += `<div class="t-why">${esc(c.why)}</div>`;
    return h;
  }
  techTip(c) {
    const t = c.tech, p = this.mode.world.players[this.me];
    let h = `<div class="t-cost ${!t.owned && p.wisps < 1 ? 'poor' : ''}"><i class="ico ico-wisp"></i>${t.owned ? 'Built'
      : `1 wisp <span class="t-have">(you have ${p.wisps})</span>`}</div>`;
    h += `<div class="t-line"><span>${esc(t.element)}</span> · tier ${t.tier}${t.requires.length ? ` · needs the ${t.requires.map(r => esc(techName(r))).join(' and ')}` : ''}</div>`;
    h += `<div class="t-line"><span>Unlocks</span> ${t.unlocks.map(id => esc(TOWERS[id] ? TOWERS[id].name : id)).join(', ')}</div>`;
    if (t.owned) h += '<div class="t-note">Standing in your tech area. Its towers can be built and upgraded.</div>';
    else h += '<div class="t-note">A wisp walks into its circle and becomes the building.</div>';
    if (c.why) h += `<div class="t-why">${esc(c.why)}</div>`;
    return h;
  }
  arcadeTip(c) {
    const a = c.a, p = this.mode.world.players[this.me];
    let h = `<div class="t-cost ${p.gold < c.cost ? 'poor' : ''}"><i class="ico ico-gold"></i>${c.cost}</div>`;
    if (c.arcade === 'lumber') {
      const L = a.lumber;
      h += `<div class="t-line">Gives <b>${L.lumber}</b> lumber. You have ${p.lumber}.</div>`;
      if (!L.available) h += `<div class="t-line"><span>Available in</span> ${clock(Math.ceil(L.opensIn))}</div>`;
      else h += `<div class="t-line"><span>Stock</span> ${L.stock} / ${L.max}${L.restockIn !== null ? ` &nbsp; <span>next in</span> ${Math.ceil(L.restockIn)}s` : ''}</div>`;
      h += `<div class="t-line"><span>Lumber sends</span> ${LUMBER_SENDS.map(u => `${esc(u.name)} ${u.lumber}`).join(', ')}</div>`;
    } else {
      const W = a.wisp;
      h += `<div class="t-line">Trains in ${W.buildTime}s, then <b>+1 wisp</b> for a tech building.</div>`;
      h += `<div class="t-warn">Your income drops by ${Math.abs(W.income).toLocaleString('en-US')} when it arrives.</div>`;
      h += `<div class="t-line"><span>Training</span> ${W.queue.length} / ${W.max}${W.queue.length ? ` &nbsp; <span>next in</span> ${Math.ceil(W.queue[0])}s` : ''}</div>`;
    }
    if (c.why) h += `<div class="t-why">${esc(c.why)}</div>`;
    return h;
  }

  // ---------------------------------------------------------------- scoreboard
  buildBoard() {
    const w = this.mode.world, root = $('board');
    let html = '<div class="bd-title" title="Fold or unfold the scoreboard"><b>Scoreboard</b><span class="bd-clock"></span><i class="bd-fold"></i></div><div class="bd-head"><span>Player</span><span>Lives</span><span>Income</span></div>';
    for (const s of w.ring) {
      const p = w.players[s];
      html += `<div class="bd-row" data-slot="${s}" title="Show ${esc(p.name)}'s lane"><span class="nm"><i style="background:${PLAYER_HEX[s]}"></i>`
        + `<b style="color:${PLAYER_TEXT[s]}">${esc(p.name)}</b><em></em><s class="xt" title="-onextra: this player's income grows by a tenth at every income tick">extra</s></span>`
        + '<span class="lv"></span><span class="in"></span></div>';
    }
    root.innerHTML = html;
    for (const row of root.querySelectorAll('.bd-row')) row.onclick = () => this.mode.jumpTo(+row.dataset.slot);
    // as WC3's multiboard, the title folds the board away (and unfolds it again)
    // folded at first where it would cover much of a phone's view
    root.classList.toggle('folded', phone());
    root.querySelector('.bd-title').onclick = () => { root.classList.toggle('folded'); this.mode.padForBoard(); };
    this.boardRows = [...root.querySelectorAll('.bd-row')].map(row => ({ row, slot: +row.dataset.slot, em: row.querySelector('em'),
      lv: row.querySelector('.lv'), inc: row.querySelector('.in'), xt: row.querySelector('.xt') }));
  }
  renderBoard() {
    const w = this.mode.world, to = this.mode.view.target, ex = w.extra && w.extra.on ? w.extra.slot : null;   // to: null once I am out
    const bc = document.querySelector('#board .bd-clock'), prep = w.phase === 'prep';
    setText(bc, prep ? clock(prepSecs(w)) : mapClock(w));   // the build phase's countdown, in gold
    bc.classList.toggle('prep', prep);
    for (const r of this.boardRows) {
      const p = w.players[r.slot];
      const tag = r.slot === this.me ? 'you' : p.kind === 'bot' && p.difficulty && !botNamed(p) ? (DIFF_NAME[p.difficulty] || p.difficulty).toLowerCase() : '';
      setText(r.em, tag);
      setText(r.lv, p.label ? p.label.toLowerCase() : p.left ? 'left' : !p.alive ? 'out' : String(p.lives));
      setText(r.inc, p.alive && !p.kicked ? short(p.income) : '–');
      r.xt.classList.toggle('on', ex === r.slot);
      r.row.classList.toggle('me', r.slot === this.me);
      r.row.classList.toggle('dead', !p.alive || !!p.kicked);
      r.row.classList.toggle('target', p.alive && r.slot === to && r.slot !== this.me);
      r.row.classList.toggle('viewing', r.slot === this.mode.viewedSlot());
    }
  }

  // ---------------------------------------------------------------- info panel + portrait
  renderInfo(view) {
    const w = this.mode.world, sel = view.sel && view.sel.o;
    let html, key;
    if (sel && sel.def.upgrades) {
      const d = sel.def, lo = d.dmgBase + d.dice, hi = d.dmgBase + d.dice * d.sides, owner = w.players[sel.owner], st = LTW_TOWER_STATS[d.id];
      const lane = w.lanes[view.sel.slot], state = sel.sellAt !== undefined ? 'selling' : sel.building > 0 ? 'under construction' : '';
      const hp = Math.max(0, Math.ceil(sel.hp ?? 0)), max = sel.maxHp || 0, hit = lane.creeps.some(c => c.attacking === sel);
      key = `t${sel.id}:${d.id}:${sel.kills}:${state}:${hp}:${hit}`;
      // the state line says 'under attack' (it must show whatever the panel's size); damage and its type share a row
      html = `<h2>${esc(d.name)}</h2><div class="tier">Tier ${d.tier} · ${esc(kindName(d.kind))}${state ? ' · ' + state : ''}${hit ? ' · <span class="alarm">under attack</span>' : ''}`
        + `${sel.owner !== this.me && owner ? ` · <span style="color:${PLAYER_TEXT[sel.owner]}">${esc(owner.name)}</span>` : ''}</div>
        ${max ? hpBar(hp, max) : ''}
        <div class="stats">
          <div><span>Damage</span><b>${lo}${hi !== lo ? '–' + hi : ''} ${ATK_NAME[d.attackType] || ''}</b></div>
          <div><span>Cooldown</span><b>${d.cooldown}s</b></div>
          <div><span>Range</span><b>${d.range}</b></div>
          ${st ? `<div><span>Armor</span><b>${st.armor} ${ARMOR_NAME[st.armorType] || st.armorType}</b></div>` : ''}
          <div><span>Kills</span><b>${sel.kills ?? 0}</b></div>
          <div><span>Sell value</span><b>${lane.sellValue(sel)}</b></div>
        </div>
        <div class="tags">${[d.targetsGround ? 'Ground' : '', d.targetsAir ? 'Air' : 'No air'].filter(Boolean).map(t => `<span class="tag ${t === 'No air' ? 'bad' : ''}">${t}</span>`).join('')}${specials(d).map(s => `<span class="tag good">${s}</span>`).join('')}</div>`;
    } else if (sel && sel.def.tech) {
      const t = LTW_TECH[sel.techId], owner = w.players[sel.owner];
      key = `k${view.sel.slot}:${sel.techId}`;
      html = `<h2>${esc(t.name)}</h2><div class="tier">${esc(t.element)} technology · tier ${t.tier}${sel.owner !== this.me && owner ? ` · <span style="color:${PLAYER_TEXT[sel.owner]}">${esc(owner.name)}</span>` : ''}</div>
        <div class="stats wide"><div><span>Unlocks</span><b>${t.unlocks.map(id => esc(TOWERS[id] ? TOWERS[id].name : id)).join(', ')}</b></div></div>
        <div class="tags"><span class="tag">Invulnerable</span>${t.requires.length ? `<span class="tag">Needs the ${t.requires.map(r => esc(techName(r))).join(' and ')}</span>` : ''}</div>`;
    } else if (sel) {
      const d = sel.def, owner = w.players[sel.owner];
      const tg = sel.attacking, tgName = tg ? (tg.def.upgrades ? tg.def.name : `${w.players[tg.owner] ? w.players[tg.owner].name + "'s " : ''}${tg.def.name}`) : '';
      const buffs = auraEffects(sel), speed = unitSpeed(d.speed * (1 + (sel.moveBonus || 0)));
      key = `c${sel.id}:${Math.ceil(sel.hp)}:${tg ? tg.id + (tg.def.upgrades ? 't' : 'c') : ''}:${!!sel.reviving}:${buffs.join()}`;
      html = `<h2>${esc(d.name)}</h2><div class="tier">${owner ? `Sent by <span style="color:${PLAYER_TEXT[sel.owner]}">${esc(owner.name)}</span>` : 'Creep'}${d.boss ? ' · boss' : ''}${sel.reviving ? ' · rising again' : ''}</div>
        ${hpBar(Math.ceil(Math.max(0, sel.hp)), sel.maxHp)}
        <div class="stats">
          <div><span>Armor</span><b>${d.armor} ${ARMOR_NAME[d.armorType] || d.armorType}</b></div>
          <div><span>Speed</span><b class="${sel.moveBonus > 0 ? 'up' : ''}">${speed}</b></div>
          <div><span>Bounty</span><b>${bountyText(d)}</b></div>
          ${d.weapon ? `<div><span>Attack</span><b>${weaponText(d.weapon, true)}</b></div>` : ''}
          ${tg ? `<div class="attacking"><span>Attacking</span><b>${esc(tgName)}</b></div>` : ''}
        </div>
        <div class="tags">${buffs.map(b => `<span class="tag good">${b}</span>`).join('')}${unitTags(d).map(t => `<span class="tag ${t.bad ? 'bad' : ''}">${t.text}</span>`).join('')}</div>`;
    } else if (TABS[this.tab].id === 'tech') {
      const p = w.players[this.me], owned = p.tech || [];
      key = `T:${p.wisps}:${owned.join(',')}`;
      html = `<h2>Technology</h2><div class="tier">Spend wisps on the element buildings</div>
        <div class="stats">
          <div><span>Wisps</span><b>${p.wisps}</b></div>
          <div><span>Buildings</span><b>${owned.length} / ${LTW_TECH_ORDER.length}</b></div>
        </div>
        <div class="tags">${owned.length ? owned.map(id => `<span class="tag good">${esc(techName(id))}</span>`).join('') : '<span class="tag">None yet: the tier-1 buildings come first</span>'}</div>`;
    } else if (TABS[this.tab].id === 'arcade') {
      const a = this.arcade(), p = w.players[this.me], L = a.lumber, q = a.wisp.queue;
      key = `A:${L.stock}:${Math.ceil(L.restockIn ?? 0)}:${p.lumber}:${q.map(s => Math.ceil(s)).join(',')}`;
      html = `<h2>${esc(a.name)}</h2><div class="tier">Lumber and wisps for gold</div>
        <div class="stats">
          <div><span>Lumber in stock</span><b>${L.available ? `${L.stock} / ${L.max}` : 'soon'}</b></div>
          <div><span>Your lumber</span><b>${p.lumber}</b></div>
          <div><span>Next lumber</span><b>${L.restockIn !== null ? Math.ceil(L.restockIn) + 's' : '–'}</b></div>
          <div><span>Wisps training</span><b>${q.length} / ${a.wisp.max}</b></div>
        </div>
        ${q.length ? `<div class="queue">${q.map((s, i) => `<div class="q"><i style="width:${(Math.max(0, Math.min(1, 1 - s / a.wisp.buildTime)) * 100).toFixed(0)}%"></i><em>${i + 1}. ${Math.ceil(s)}s</em></div>`).join('')}</div>` : ''}`;
    } else {
      const slot = this.mode.viewedSlot(), p = w.players[slot], lane = w.lanes[slot], to = w.next(slot);
      const mine = slot === this.me, cr = lane.creeps.length;
      key = `l${slot}:${p.lives}:${p.income}:${lane.towers.length}:${cr}:${p.alive}:${to}`;
      html = `<h2>${mine ? 'Your lane' : esc(p.name) + "'s lane"}</h2>
        <div class="tier"><i class="swatch" style="background:${PLAYER_HEX[slot]}"></i>${esc(p.name)} · ${p.kind === 'bot' ? `Computer, ${DIFF_NAME[p.difficulty] || ''}` : 'Player'}${!p.alive ? (p.label ? ' · ' + esc(p.label.toLowerCase()) : p.left ? ' · left the game' : ' · eliminated') : ''}</div>
        <div class="stats">
          <div><span>Lives</span><b>${p.alive ? p.lives : 'out'}</b></div>
          <div><span>Income</span><b>${p.alive ? p.income : '–'}</b></div>
          <div><span>Towers</span><b>${lane.towers.length}</b></div>
          <div><span>Creeps in lane</span><b>${cr}</b></div>
          ${mine ? `<div><span>Gold</span><b>${Math.floor(p.gold)}</b></div>` : ''}
          <div><span>Sends to</span><b style="color:${to !== null && to !== slot ? PLAYER_TEXT[to] : 'inherit'}">${to !== null && to !== slot && p.alive ? esc(w.players[to].name) : '–'}</b></div>
        </div>`;
      if (mine) key += ':' + Math.floor(p.gold);
    }
    if (key !== this.lastInfo) { $('info').innerHTML = html; this.lastInfo = key; this.fitInfo(); }
  }
  drawPortrait(view) {
    const x = this.portrait, S = x.canvas.width;
    let sel = view.sel && view.sel.o;
    x.clearRect(0, 0, S, S);
    if (sel && sel.def.tech) { x.drawImage(this.techIcon(sel.techId), 0, 0, S, S); return; }
    if (!sel && (this.tab === TECH_TAB || this.tab === ARCADE_TAB)) { x.drawImage(this.glyph(this.tab === TECH_TAB ? 'wisp' : 'lumber'), 0, 0, S, S); return; }
    if (!sel) {   // nothing selected: the strongest creep in the lane being viewed
      let best = null;
      for (const c of this.mode.world.lanes[this.mode.viewedSlot()].creeps) if (!best || c.maxHp > best.maxHp) best = c;
      sel = best;
    }
    if (sel && sel.def.upgrades) {
      const ic = this.iconRect(sel.def.id);
      if (ic) { x.drawImage(ic.img, ...src(ic), 0, 0, S, S); return; }
      const m = this.man.towers[sel.def.id], s = Math.min((S - 10) / m.w, (S - 10) / m.h);
      if (m.img) x.drawImage(m.img, ...src(m), S / 2 - (m.w * s) / 2, S - 4 - m.h * s, m.w * s, m.h * s);
      return;
    }
    if (sel) {
      const d = sel.def, p = this.man.portraits && (this.man.portraits[d.id] || this.man.portraits[d.look]);
      if (p && p.img) {
        const t = performance.now() / 1000 * 4.5;
        const f0 = Math.floor(t) % p.frames, f1 = (f0 + 1) % p.frames, k = t - Math.floor(t);
        x.drawImage(p.img, ...src(p, f0 * p.fw, 0, p.fw, p.fh), 0, 0, S, S);
        x.globalAlpha = k; x.drawImage(p.img, ...src(p, f1 * p.fw, 0, p.fw, p.fh), 0, 0, S, S); x.globalAlpha = 1;
        return;
      }
      const b = this.r.lookBox(d), s = Math.min((S - 16) / b.fw, (S - 16) / b.fh) * 1.1;
      this.r.drawStill(x, d, Math.floor(performance.now() / 110), S / 2, S - (b.fh - b.ay) * s, s);
      return;
    }
    // an empty lane: its owner's colour
    const slot = this.mode.viewedSlot(), g = x.createRadialGradient(S / 2, S * 0.42, 4, S / 2, S / 2, S * 0.7);
    g.addColorStop(0, PLAYER_HEX[slot]); g.addColorStop(0.55, 'rgba(20,16,10,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalAlpha = 0.5; x.fillStyle = g; x.fillRect(0, 0, S, S); x.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- minimap
  // Every lane, stretched to the panel: towers in the lane owner's colour, creeps in their sender's colour, the
  // camera's view as a white frame, your lane in gold.
  drawMinimap() {
    const c = this.mm, rect = c.getBoundingClientRect();
    const dpr = pixelRatio();
    if (c.width !== Math.round(rect.width * dpr) || c.height !== Math.round(rect.height * dpr)) { c.width = Math.round(rect.width * dpr); c.height = Math.round(rect.height * dpr); }
    if (!c.width || !c.height) return;
    const w = this.mode.world, order = this.mode.order, n = order.length, x = c.getContext('2d');
    const alive = order.map(s => (w.players[s].alive ? 1 : 0)).join('');
    const key = `${c.width}x${c.height}:${alive}:${this.r.cache ? this.r.cache.version : 0}`;
    if (key !== this.mmKey) { this.mmBase = this.r.miniBase(w, order, c.width, c.height); this.mmKey = key; }
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.drawImage(this.mmBase, 0, 0);
    const [X0, Y0, X1, Y1] = this.r.worldRect(n), kx = c.width / (X1 - X0), ky = c.height / (Y1 - Y0);
    const tw = Math.max(1.5, P * kx), th = Math.max(1.5, (sy(1) - sy(0)) * ky * 0.9);
    order.forEach((slot, i) => {
      const lane = w.lanes[slot], dy = laneDY(i) - Y0;
      x.fillStyle = PLAYER_HEX[slot];
      for (const t of lane.towers) x.fillRect((sx(t.c) - X0) * kx, (dy + sy(t.r)) * ky, tw, th);
      let last = -1;
      for (const k of lane.creeps) {
        if (k.owner !== last) { x.fillStyle = PLAYER_HEX[k.owner] || '#fff'; last = k.owner; }
        x.fillRect((sx(k.x) - X0) * kx - 1.5 * dpr, (dy + sy(k.y)) * ky - 1.5 * dpr, 3 * dpr, 3 * dpr);
      }
    });
    // your lane and the camera
    const mi = order.indexOf(this.me);
    if (mi >= 0) {
      x.strokeStyle = 'rgba(255,216,74,0.85)'; x.lineWidth = dpr;
      x.strokeRect(0.5 * dpr, (laneDY(mi) + sy(-0.2) - Y0) * ky, c.width - dpr, (sy(LANE_ROWS + 0.2) - sy(-0.2)) * ky);
    }
    const [vx0, vy0, vx1, vy1] = this.mode.cam.rect();
    x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = dpr;
    x.strokeRect(Math.round((vx0 - X0) * kx) + 0.5, Math.round((vy0 - Y0) * ky) + 0.5, Math.round((vx1 - vx0) * kx) - 1, Math.round((vy1 - vy0) * ky) - 1);
  }
  // minimap css px -> logical world px
  minimapToWorld(mx, my) {
    const r = this.mm.getBoundingClientRect(), [X0, Y0, X1, Y1] = this.r.worldRect(this.mode.order.length);
    return { X: X0 + (mx / Math.max(1, r.width)) * (X1 - X0), Y: Y0 + (my / Math.max(1, r.height)) * (Y1 - Y0) };
  }

  // ---------------------------------------------------------------- messages
  // Match events: map messages for this player, eliminations, victory, Creep Fix, leavers, and the phase-3 events
  // (tech, the Arcade, wisps, -onextra, kicks). Chat lines come from the session's 'chat' (see chat()).
  handle(e) {
    const w = this.mode.world, me = this.me, name = (s) => (w.players[s] ? w.players[s].name : '?');
    const who = (s) => `<b style="color:${PLAYER_TEXT[s] || '#fff'}">${esc(name(s))}</b>`;
    const kicked = (s) => !!(w.players[s] && w.players[s].kicked);
    switch (e.type) {
      case 'message': {
        if (e.to !== null && e.to !== me) break;
        const text = String(e.text), life = typeof e.duration === 'number' && e.duration > 0 ? e.duration : undefined;
        const m = INCOME_LINE.exec(text);
        if (m) { this.incomeLine(+m[1], +m[2], e.t, life ?? 6); break; }
        if (!w.players[me].alive && e.to === me && text !== LTW_CHAT.help.message) break;   // out: creeps still cross the empty lane, nothing to report
        if (/^Your income is/.test(text)) this.message(esc(text), '#8f866f', 'quiet');
        else if (text === LTW_CHAT.help.message) this.help(life);
        else if (/^\d+$/.test(text)) this.message(this.creepFixWarning(text, e.t ?? (e.tick !== undefined ? e.tick / TPS : w.time)), '#ffd84a');
        else if (/has won the game/.test(text)) this.message(esc(text), '#ffe08a');
        else if (STOLEN_FROM_YOU.test(text)) this.stealLine(text, STOLEN_FROM_YOU, 'owner', '#ff7a6a');
        else if (YOU_STOLE.test(text)) this.stealLine(text, YOU_STOLE, 'victim', '#9dff7a');
        else for (const line of text.split('\n')) this.message(esc(line), '#ffd84a', '', life);
        break;
      }
      case 'eliminated': {
        const by = e.by !== null && e.by !== undefined ? e.by : null;
        if (e.slot === me) this.announce(kicked(me) ? 'You were kicked' : 'You are out', by !== null ? `${name(by)} took your last life` : kicked(me) ? '' : 'Your lane has fallen');
        else this.announce(`${name(e.slot)} is out`, kicked(e.slot) ? 'Kicked' : e.reason === 'left' ? 'Left the game' : by !== null ? `${by === me ? 'You' : name(by)} took the last life` : '');
        this.message(`${who(e.slot)} has been eliminated${by !== null ? ` by ${who(by)}` : ''}.`, '#e6dcc6');
        break;
      }
      case 'won': this.announce(e.slot === me ? 'Victory' : `${name(e.slot)} has won`, e.slot === me ? 'You are the last one standing' : 'The game ends in 10 seconds'); break;
      case 'play': {   // the build phase is over: the map's shop timers start, the first creeps unlock a few seconds later
        const to = w.players[me] && w.players[me].alive ? w.next(me) : null, them = to !== null && to !== me ? to : null;
        const first = Math.ceil(Math.min(...this.shop(true).flatMap(sh => sh.units).map(u => (u.available ? 0 : u.opensIn))) - 1e-9);
        this.announce('Shrines open', them !== null ? `Your creeps go to ${name(them)}` : '');
        this.message(`The build phase is over. ${first > 0 ? `The first creeps can be sent in ${first} second${first === 1 ? '' : 's'}` : 'Creeps can be sent now'}, from the <b>Shrine</b> tabs.`, '#ffd84a');
        break;
      }
      case 'stolen': {   // the slots behind the life-steal line just shown: its name takes that player's colour
        const role = e.lane === me ? 'owner' : e.to === me && e.gained ? 'victim' : null, i = role ? this.steals.findIndex(x => x.role === role) : -1;
        if (i < 0) break;
        const [x] = this.steals.splice(i, 1), slot = role === 'owner' ? e.to : e.lane;
        if (x.el.isConnected && PLAYER_TEXT[slot]) x.el.querySelector('b.nm').style.color = PLAYER_TEXT[slot];
        break;
      }
      case 'creepfix': if (e.lane === me && e.killed > 0) this.message(`Creep Fix cleared <b>${e.killed}</b> creep${e.killed === 1 ? '' : 's'} from your lane.`, '#d9c48c'); break;
      case 'left': if (!kicked(e.slot)) this.message(`${who(e.slot)} has left the game.`, '#e6dcc6'); break;
      case 'rejoined': this.message(`${who(e.slot)} is back in the game.`, '#e6dcc6'); break;
      case 'kicked': this.message(`${who(e.slot)} was kicked by ${who(e.by)}.`, '#ffb08a'); break;
      case 'tech': {
        if (e.slot !== me || !LTW_TECH[e.id]) break;
        const t = LTW_TECH[e.id];
        this.message(`<b>${esc(t.name)}</b> stands in your tech area. Unlocked: ${t.unlocks.map(id => esc(TOWERS[id] ? TOWERS[id].name : id)).join(', ')}.`, '#9dff7a');
        break;
      }
      case 'techLost': if (e.slot === me) this.message(`You destroyed your <b>${esc(techName(e.id))}</b>.`, '#ffb08a'); break;
      case 'arcade':
        if (e.slot !== me) break;
        if (e.item === 'lumber') this.repeat(`Bought <b>${e.lumber}</b> lumber for ${short(e.gold)} gold.`, '#d9c48c');
        else this.message(`A wisp is training at the Arcade, ready at ${mapClock(w, e.doneAt)}.`, '#d9c48c');
        break;
      case 'wisp': if (e.slot === me) this.message(`A wisp has joined your tech area. Income <b class="neg">${signed(e.income)}</b>.`, '#a6d6ff'); break;
      case 'extraOn': this.message(`${who(e.slot)} turned on <b>-onextra</b>: their income grows by a tenth at every income tick.`, '#ffd84a'); break;
      case 'extraOff': this.message(`${who(e.slot)} turned off <b>-onextra</b>.`, '#ffd84a'); break;
      case 'extra': if (e.slot === me) this.message(`-onextra: income <b>${signed(e.delta)}</b>`, '#8f866f', 'quiet'); break;
    }
  }
  // The map's Creep Fix warning: a bare number ('50', '10', '5') from three timers of their own (every 250, 290 and
  // 295 s). Each lane is swept on its own period (300 s for slot 1, 310 s for slot 2 ...), so the line also says when
  // the viewer's lane is next swept.
  creepFixWarning(text, at) {
    const p = this.mode.world.players[this.me], period = LTW_CREEP_FIX.periods[String(this.me)];
    if (!p || !p.alive || !period) return esc(text);
    const k = Math.round(mapTime(this.mode.world, at) * TPS), T = Math.round(period * TPS), left = Math.round(((Math.floor(k / T) + 1) * T - k) / TPS);
    return `<b>${esc(text)}</b> <span class="note">· Creep Fix clears your lane in ${left < 60 ? left + ' seconds' : clock(left)}</span>`;
  }
  // "<name> has stolen 1 life from you." / "You have stolen 1 life from <name>": the name, where the map's template puts
  // it, in its player's colour. Names need not be unique ('Computer (Hard)'), so a name that is not gets its colour
  // from the 'stolen' event that follows the line.
  stealLine(text, tpl, role, color) {
    const name = text.slice(tpl.pre.length, text.length - tpl.post.length), w = this.mode.world;
    const slots = w.ring.filter(s => w.players[s].name === name);
    const el = this.message(`${esc(tpl.pre)}<b class="nm" style="color:${slots.length === 1 ? PLAYER_TEXT[slots[0]] : 'inherit'}">${esc(name)}</b>${esc(tpl.post)}`, color);
    this.steals.push({ el, role });
    if (this.steals.length > 16) this.steals.shift();
  }
  // life: seconds the line stays (the map's duration where it gives one). Returns the line.
  message(html, color = '#f2ead8', cls = '', life) {
    const box = $('msgs');
    const d = document.createElement('div');
    d.style.color = color; d.innerHTML = html;
    if (cls) d.className = cls;
    box.appendChild(d);
    while (box.children.length > MAX_LINES) box.removeChild(box.firstChild);
    this.fadeLater(d, life !== undefined ? life * 1000 : cls === 'quiet' ? 4000 : cls === 'chat' ? 12000 : 8000);
    return d;
  }
  fadeLater(d, ms) {
    clearTimeout(d.fade); d.style.opacity = '';
    d.fade = setTimeout(() => { d.style.opacity = '0'; d.fade = setTimeout(() => d.remove(), 1000); }, ms);
  }
  // A chat line, as WC3 shows it: the speaker's name in their colour, then the text.
  chat({ slot, name, text }) {
    const w = this.mode.world, nm = name || (w.players[slot] ? w.players[slot].name : '?');
    this.message(`<b style="color:${PLAYER_TEXT[slot] || '#fff'}">${esc(nm)}:</b> <span class="say">${esc(text)}</span>`, '#fff', 'chat');
  }
  // '-help': the map points at its quest menu; here the chat commands are listed instead.
  help(life = 10) {
    for (const line of ['Chat commands (press <b>Enter</b> or the Chat button):',
      '<b>-income</b> shows every player\'s income. <b>-destroy</b> destroys your selected tower or tech building, with no refund.',
      '<b>-onextra</b> makes your income grow by a tenth at every income tick (one player at a time), <b>-offextra</b> stops it.',
      '<b>-kick</b> <i>colour</i> (Red only) removes a player. <b>F10</b> shows the keys.']) this.message(line, '#e6dcc6', 'help', life);
  }
  // The map's income list ('1)  X' .. '11)  X' to everyone after every income tick, and on '-income'): one panel
  // under the scoreboard for its duration (match seconds), instead of eleven lines in the messages.
  incomeLine(slot, value, at, duration) {
    const L = this.income;
    if (L.at !== at) { L.at = at; L.lines = {}; }
    L.lines[slot] = value;
    L.until = (at ?? this.mode.world.time) + duration;
    L.dirty = true;
  }
  renderIncome() {
    const L = this.income, el = $('income-list'), show = this.mode.world.time < L.until;
    el.classList.toggle('show', show);
    if (!show || !L.dirty) return;
    L.dirty = false;
    const w = this.mode.world, rows = Object.keys(L.lines).map(Number).sort((a, b) => a - b);
    el.innerHTML = '<div class="il-title">Income</div><div class="il-grid">' + rows.map(s => {
      const played = !!w.players[s];
      return `<span class="${played ? '' : 'idle'}"><i style="background:${PLAYER_HEX[s] || '#888'}"></i>${s})</span><b class="${played ? '' : 'idle'}">${short(L.lines[s])}</b>`;
    }).join('') + '</div>';
  }
  // A tower of mine that attackers (or my own -destroy) brought down.
  towerLost(t, by, reason) {
    const w = this.mode.world, nm = esc(t.def.name), o = by && by.def ? w.players[by.owner] : null;
    const html = reason === 'destroy' ? `You destroyed your <b>${nm}</b>.`
      : by && by.def ? `Your <b>${nm}</b> was destroyed by ${o ? `<b style="color:${PLAYER_TEXT[by.owner]}">${esc(o.name)}</b>'s ` : ''}${esc(by.def.name)}.`
        : `Your <b>${nm}</b> was destroyed.`;
    this.repeat(html, reason === 'destroy' ? '#ffb08a' : '#ff7a6a');
  }
  // One of the client's own lines: the same line again within a few seconds counts up (×3) instead of filling the
  // messages (the map's own messages are shown one by one, as in the map).
  repeat(html, color) {
    const now = performance.now(), last = this.lastLine;
    if (last && last.html === html && last.el.isConnected && now - last.at < 4000) {
      last.n++; last.at = now;
      last.el.innerHTML = `${html} <b class="times">×${last.n}</b>`;
      this.fadeLater(last.el, 8000);
      return;
    }
    this.lastLine = { html, n: 1, at: now, el: this.message(html, color) };
  }

  // ---------------------------------------------------------------- per frame
  // The top bar's gold: the whole number, or where the bar has no room for it (an upright phone with five digits or
  // more) shortened as income is, rounded down (12k); where even that does not fit, the bar closes up. Measured again
  // only when a number in the bar changes length (or the window its width).
  barGold(gold) {
    const full = String(gold), el = $('r-gold'), bar = el.closest('.tb-res'), over = () => bar.scrollWidth > bar.clientWidth + 1;
    const key = [full.length, innerWidth, $('net-status').textContent.length, ...[...bar.querySelectorAll('b')].filter(b => b !== el).map(b => b.textContent.length)].join();
    if (key !== this.barKey) {
      this.barKey = key;
      setText(el, full); bar.classList.remove('tight');
      this.barShort = gold >= 10000 && over();
      if (this.barShort) setText(el, Math.floor(gold / 1000) + 'k');
      bar.classList.toggle('tight', over());
    }
    return this.barShort ? Math.floor(gold / 1000) + 'k' : full;
  }
  // The build phase's timer window, as WC3 shows a map's timer: what to do, and the seconds before the shrines open.
  prepTimer() {
    let el = $('prep-timer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'prep-timer'; el.className = 'ltw-only'; el.setAttribute('role', 'timer');
      el.innerHTML = '<b>Build your maze</b><span>The shrines open in <em></em></span>';
      $('view-wrap').appendChild(el);
    }
    this.prepEl = el; this.prepKey = '';
    el.classList.remove('show'); document.body.classList.remove('prep');
  }
  renderPrep() {
    const w = this.mode.world, prep = w.phase === 'prep', n = prep ? prepSecs(w) : 0;
    const key = prep ? String(n) : '';
    if (key === this.prepKey) return;
    this.prepKey = key;
    const el = this.prepEl;
    el.classList.toggle('show', prep);
    document.body.classList.toggle('prep', prep);
    el.classList.toggle('soon', prep && n <= PREP_SOON);
    if (prep) { setText(el.querySelector('em'), clock(n)); el.setAttribute('aria-label', `Build your maze. The shrines open in ${n} second${n === 1 ? '' : 's'}.`); }
  }
  refresh(force = false) {
    const w = this.mode.world, view = this.act.view(), p = w.players[this.me], s = this.mode.session;
    this.renderPrep();
    setText($('r-income'), p.alive ? short(p.income) : '–');
    setText($('r-income-t'), p.alive ? Math.ceil(w.incomeTimer) + 's' : '');
    setText($('r-lives'), p.alive ? p.lives : 'out');
    setText($('r-lumber'), p.lumber);
    setText($('r-wisps'), p.wisps);
    setText($('r-gold'), this.barGold(Math.floor(p.gold)));
    const to = w.next(this.me), prep = w.phase === 'prep';   // the build phase's line has no room for the target too
    const sub = prep ? '' : w.phase !== 'playing' ? (w.winner !== null ? `${w.players[w.winner].name} has won` : 'Game over')
      : !p.alive ? 'Watching' : to !== null && to !== this.me ? `Sending to ${w.players[to].name}` : '';
    const time = prep ? `Build phase ${clock(prepSecs(w))}` : mapClock(w);
    const ttl = `<b class="gold-text">${s.kind === 'local' ? 'vs Computer' : 'vs Players'}</b><small>${time}${sub ? ' · ' + esc(sub) : ''}${s.paused ? ' · paused' : ''}</small>`;
    const tb = $('tb-title');
    if (tb.dataset.v !== ttl) { tb.innerHTML = ttl; tb.dataset.v = ttl; }
    this.cmdT -= 1;
    if (force) this.shopData = null;   // after a command: show the stock it left
    if (force || this.cmdT <= 0) {
      this.renderCommands(view);
      this.renderInfo(view);
      this.renderBoard();
      this.renderIncome();
      const tabs = $('cmd-tabs').children, a = this.arcade();
      setText(tabs[TECH_TAB].querySelector('.tab-n'), p.wisps > 0 ? String(p.wisps) : '');
      setText(tabs[ARCADE_TAB].querySelector('.tab-n'), a && a.wisp.queue.length ? String(a.wisp.queue.length) : '');
      if (this.tip >= 0 && this.cmds[this.tip] && this.tipEl) this.showTip(this.tip, this.tipEl);
      else if (this.tip >= 0) this.hideTip();
      this.cmdT = 6;
    }
    this.drawPortrait(view);
    this.mmT -= 1;
    if (this.mmT <= 0 || force || this.mode.cam.moved) { this.drawMinimap(); this.mmT = 6; this.mode.cam.moved = false; }
  }
}

function setText(e, v) { if (!e) return; const s = String(v); if (e.textContent !== s) e.textContent = s; }
function hpBar(hp, max) {
  const k = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  return `<div class="hp ${k > 0.6 ? '' : k > 0.3 ? 'mid' : 'low'}"><i style="width:${(k * 100).toFixed(1)}%"></i><em>${hp} / ${max}</em></div>`;
}
// WC3 bounty: the base plus dice (where the map leaves dice on a unit), as a range.
function bountyText(u) {
  const dice = u.bountySides > 0 ? u.bountyDice || 0 : 0;
  return dice ? `${u.bounty + dice}–${u.bounty + dice * u.bountySides}` : String(u.bounty);
}
// An attacker's weapon: damage range, attack type and what it hits.
function weaponText(wp, brief = false) {
  const lo = wp.dmgBase + wp.dice, hi = wp.dmgBase + wp.dice * wp.sides;
  const dmg = `${lo}${hi !== lo ? '–' + hi : ''}`;
  if (brief) return `${dmg} ${ATK_NAME[wp.attackType] || wp.attackType}`;
  return `${dmg} ${ATK_NAME[wp.attackType] || wp.attackType}, every ${wp.cooldown}s, ${wp.targets.includes('ground') ? 'towers and creeps' : 'towers'}`;
}
const AURA_NAME = { endurance: 'Haste aura', unholy: 'Haste and healing aura', regeneration: 'Healing aura', command: 'Damage aura' };
// What a unit is, for the send tooltip and the selected creep: [{ text, bad }] (bad: what works against a defender).
// Air means hit as air (the target class): the Phoenix flies but is hit as ground. An invisible unit bestows no auras.
function unitTags(u) {
  const t = [], tag = (text, bad = false) => t.push({ text, bad });
  const air = u.air ?? u.flying;
  if (air) tag('Air');
  else if (u.flying) tag('Flies, hit as ground');
  if (u.magicImmune) tag('Magic immune', true);
  if (u.invisible) tag('Invisible', true);
  if (u.evasion) tag('Evasion');
  if (u.armorType === 'divine') tag('Divine armor: chaos only', true);
  if (u.boss) tag('Boss');
  if (u.weapon) tag('Attacks towers', true);
  if (!u.invisible || LTW_RULES.invisibleBestowAuras) for (const a of u.auras || []) tag(AURA_NAME[a.kind] || 'Aura');
  if (u.reincarnation) tag('Rises again once');
  if (u.deathDamage) tag('Explodes when it dies', true);
  if (u.hardenedSkin) tag('Hard skin');
  if (u.onDeath) tag(`Splits into ${u.onDeath.count} on death`);
  return t;
}
// The aura bonuses a creep has this tick (from its own or a friendly carrier's aura); the attack bonuses only matter to
// a creep with a weapon.
function auraEffects(c) {
  const pct = (v) => Math.round(v * 100) + '%', out = [], armed = !!c.def.weapon;
  if (c.moveBonus > 0) out.push('+' + pct(c.moveBonus) + ' speed');
  if (armed && c.atkBonus > 0) out.push('+' + pct(c.atkBonus) + ' attack speed');
  if (armed && c.dmgBonus > 0) out.push('+' + pct(c.dmgBonus) + ' damage');
  if (c.regenBonus > 0) out.push('+' + c.regenBonus + ' HP/s');
  if (c.regenPct > 0) out.push('+' + pct(c.regenPct) + ' HP/s');
  return out;
}
