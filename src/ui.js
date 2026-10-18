// Warcraft III Reforged-style console: resources, minimap, animated portrait + info, command card, tooltips, messages.
// The chrome itself (frames, plates, buttons) is CSS over Blender-rendered images in assets/ui/ (see style.css).
import { TOWERS, BUILD_ROOTS, CREEPS, RULES, LEVELS, avgDamage, typeFactor } from './game.js?v=a48717ff8443';
import { TILE, COLS, ROWS, SCREEN_W, SCREEN_H } from './level.js?v=a48717ff8443';
import { W, H, K, sx, sy } from './render.js?v=a48717ff8443';
import { tipButton, heldClick, lastInput, clickWord, phone } from './client/touch.js?v=a48717ff8443';
import { src } from './assets.js?v=a48717ff8443';
import { pixelRatio } from './device.js?v=a48717ff8443';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const ARMOR_NAME = { small: 'Light', medium: 'Medium', large: 'Heavy', fort: 'Fortified', normal: 'Normal', hero: 'Hero', divine: 'Divine', none: 'Unarmored' };
export const ATK_NAME = { normal: 'Normal', pierce: 'Pierce', siege: 'Siege', magic: 'Magic', chaos: 'Chaos', hero: 'Hero', spells: 'Spells' };
const ACCENT = { archer: '#3f7a2c', rifle: '#9a7a4a', guard: '#2c5fbe', ballista: '#6a6a72', cannon: '#6b5a3a', blade: '#8e1212', ogre: '#b0703a', wisp: '#5fb6e8',
  fire: '#d2501a', frost: '#7cc8f0', water: '#2a7fd0', arcane: '#6a4ab0', light: '#c9a43a', shroom: '#3e6fe0', poison: '#3f9a2a', artillery: '#7a5a34', moon: '#8aa8d8', flame: '#c4581f' };
const UPGRADE_KEYS = ['Q', 'W', 'E', 'R', 'T'];
const BUILD_KEYS = { h003: 'A', h000: 'S', h008: 'E' };

export class UI {
  constructor(game, renderer, actions) {
    this.g = game; this.r = renderer; this.act = actions; this.man = renderer.man;
    this.icons = new Map(); this.cmds = []; this.msgs = []; this.lastInfo = ''; this.mmTimer = 0;
    this.portrait = $('portrait').getContext('2d');
    this.mm = $('minimap');
    this.buildCommandGrid();
    $('btn-pause').onclick = () => actions.togglePause();
    $('btn-menu').onclick = () => actions.menu();
    for (const b of document.querySelectorAll('#speed button')) b.onclick = () => actions.setSpeed(+b.dataset.speed);
  }

  // ---------------------------------------------------------------- icons
  // Command-card icons come from the Blender-rendered 'icons' manifest section (possibly packed into an atlas,
  // so always drawn with their source rect). A tower without one falls back to a framed shot of its map sprite.
  iconRect(key) {
    const m = this.man.icons && this.man.icons[key];
    return m && m.img ? m : null;
  }
  icon(def) {
    if (this.icons.has(def.id)) return this.icons.get(def.id);
    const ic = this.iconRect(def.id);
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    if (ic) {
      c.width = ic.w; c.height = ic.h;
      x.drawImage(ic.img, ...src(ic), 0, 0, ic.w, ic.h);
    } else {
      const m = this.man.towers[def.id];
      c.width = 108; c.height = 108;
      const acc = ACCENT[def.kind] || '#555555';
      const g = x.createRadialGradient(54, 44, 4, 54, 54, 76);
      g.addColorStop(0, acc); g.addColorStop(1, '#050403');
      x.fillStyle = g; x.fillRect(0, 0, 108, 108);
      const s = Math.min(100 / m.w, 102 / m.h);
      x.drawImage(m.img, ...src(m), 54 - (m.w * s) / 2, 106 - m.h * s, m.w * s, m.h * s);
    }
    this.icons.set(def.id, c);
    return c;
  }
  glyph(kind) {
    const key = 'g:' + kind;
    if (this.icons.has(key)) return this.icons.get(key);
    const ic = this.iconRect('cmd_' + kind);
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    if (ic) {
      c.width = ic.w; c.height = ic.h;
      x.drawImage(ic.img, ...src(ic), 0, 0, ic.w, ic.h);
      this.icons.set(key, c);
      return c;
    }
    if (kind === 'keep') return this.keepGlyph(c, x, key);
    c.width = 108; c.height = 108;
    const bg = x.createRadialGradient(54, 48, 4, 54, 54, 76);
    bg.addColorStop(0, { next: '#7a1a12', sell: '#7a5a14', cancel: '#5a1010' }[kind] || '#333'); bg.addColorStop(1, '#050403');
    x.fillStyle = bg; x.fillRect(0, 0, 108, 108);
    x.lineCap = 'round'; x.lineJoin = 'round';
    if (kind === 'next') {
      x.translate(54, 54); x.rotate(-0.7);
      x.fillStyle = '#d8dee6'; x.beginPath(); x.moveTo(-5, -30); x.lineTo(5, -30); x.lineTo(5, 14); x.lineTo(0, 22); x.lineTo(-5, 14); x.closePath(); x.fill();
      x.fillStyle = '#e8c05a'; x.fillRect(-16, -34, 32, 7); x.fillStyle = '#5a3a1a'; x.fillRect(-4, -48, 8, 15);
      x.setTransform(1, 0, 0, 1, 0, 0);
    } else if (kind === 'sell') {
      for (const [cx, cy] of [[40, 64], [62, 68], [52, 48]]) {
        const g = x.createRadialGradient(cx - 5, cy - 5, 2, cx, cy, 16);
        g.addColorStop(0, '#fff6c2'); g.addColorStop(0.45, '#f5c84a'); g.addColorStop(1, '#7a4a10');
        x.fillStyle = g; x.beginPath(); x.ellipse(cx, cy, 16, 11, 0, 0, Math.PI * 2); x.fill();
        x.strokeStyle = '#4a2a08'; x.lineWidth = 2; x.stroke();
      }
    } else if (kind === 'cancel') {
      x.strokeStyle = '#ff5a48'; x.lineWidth = 12;
      x.beginPath(); x.moveTo(32, 32); x.lineTo(76, 76); x.moveTo(76, 32); x.lineTo(32, 76); x.stroke();
    }
    this.icons.set(key, c);
    return c;
  }
  // Keep building: three stone blocks in a row, the next one ghosted, under a gold arrow.
  keepGlyph(c, x, key) {
    c.width = 108; c.height = 108;
    const bg = x.createRadialGradient(54, 46, 4, 54, 54, 78);
    bg.addColorStop(0, '#2c5a1e'); bg.addColorStop(1, '#050403');
    x.fillStyle = bg; x.fillRect(0, 0, 108, 108);
    for (const [bx, a] of [[18, 1], [44, 1], [70, 0.4]]) {
      x.globalAlpha = a;
      const g = x.createLinearGradient(0, 58, 0, 84);
      g.addColorStop(0, '#b8ab94'); g.addColorStop(1, '#5a5048');
      x.fillStyle = g; x.fillRect(bx, 58, 20, 26);
      x.strokeStyle = '#1a1410'; x.lineWidth = 2.5; x.strokeRect(bx, 58, 20, 26);
    }
    x.globalAlpha = 1;
    x.strokeStyle = '#f0c860'; x.lineWidth = 6; x.lineCap = 'round'; x.lineJoin = 'round';
    x.beginPath(); x.moveTo(24, 42); x.quadraticCurveTo(54, 18, 80, 38); x.stroke();
    x.fillStyle = '#f0c860'; x.beginPath(); x.moveTo(90, 46); x.lineTo(70, 44); x.lineTo(84, 28); x.closePath(); x.fill();
    x.strokeStyle = 'rgba(0,0,0,0.8)'; x.lineWidth = 4; x.strokeRect(0, 0, 108, 108);
    this.icons.set(key, c);
    return c;
  }

  // ---------------------------------------------------------------- command card
  // Each button shows its tooltip on hover, or after a long press of a finger (src/client/touch.js).
  buildCommandGrid() {
    const root = $('commands');
    root.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const b = document.createElement('button');
      b.className = 'cmd empty';
      tipButton(b, () => this.showTip(i, b), () => this.hideTip());
      b.onclick = () => { const c = this.cmds[i]; if (heldClick(b)) return; if (c && c.run) { c.run(); this.hideTip(); this.refresh(true); } };
      root.appendChild(b);
    }
  }
  commandsFor(view) {
    const g = this.g, list = new Array(12).fill(null);
    const sel = view.selected;
    if (view.placing) {   // Keep building: what Shift does, for a pointer without a keyboard
      list[8] = { sig: 'keep:' + !!view.keep, glyph: 'keep', on: !!view.keep, title: view.keep ? 'Keep building (on)' : 'Keep building',
        lines: [keepLine(view.keep)], run: () => this.act.keep() };
      list[11] = { glyph: 'cancel', key: 'Esc', title: 'Cancel', lines: ['Stop placing towers.'], run: () => this.act.cancel() };
      return list;
    }
    if (sel && sel.def && sel.def.upgrades) {
      sel.def.upgrades.forEach((id, i) => {
        const def = TOWERS[id];
        list[i] = { def, key: UPGRADE_KEYS[i], cost: def.cost, title: 'Upgrade to ' + def.name, upgrade: true, run: () => this.act.upgrade(sel, id) };
      });
      list[11] = { glyph: 'sell', key: 'X', title: 'Sell tower', lines: [`Returns <b>${g.sellValue(sel)}</b> gold (75% of what you spent).`], run: () => this.act.sell(sel) };
      return list;
    }
    if (sel) return list;   // enemy unit: no commands
    ['h003', 'h000', 'h008'].filter(id => BUILD_ROOTS.includes(id)).forEach((id, i) => {
      const def = TOWERS[id];
      list[i] = { def, key: BUILD_KEYS[id], cost: def.cost, title: 'Build ' + def.name, run: () => this.act.place(def) };
    });
    if (g.phase === 'countdown') {
      const next = g.nextCreep();
      list[8] = { glyph: 'next', key: 'N', title: 'Call the next level now', lines: next ? [`Level ${g.level + 1}: <b>${esc(next.name)}</b>`] : [], run: () => this.act.callNext() };
    }
    return list;
  }
  renderCommands(view) {
    this.cmds = this.commandsFor(view);
    const buttons = $('commands').children;
    this.cmds.forEach((c, i) => {
      const b = buttons[i];
      const sig = c ? `${c.sig || (c.def ? c.def.id : c.glyph)}|${c.key}|${c.cost !== undefined && this.g.gold < c.cost}` : '';
      if (b.dataset.sig === sig) return;
      b.dataset.sig = sig;
      b.innerHTML = '';
      b.className = 'cmd' + (c ? '' : ' empty') + (c && c.cost !== undefined && this.g.gold < c.cost ? ' poor' : '') + (c && ((view.placing && c.def === view.placing) || c.on) ? ' active' : '');
      if (!c) return;
      b.appendChild(c.def ? this.icon(c.def) : this.glyph(c.glyph));
      if (c.key) b.insertAdjacentHTML('beforeend', `<span class="hk">${c.key === 'Esc' ? '' : c.key}</span>`);
      if (c.cost) b.insertAdjacentHTML('beforeend', `<span class="cost">${c.cost}</span>`);
    });
  }
  hotkey(key, view) {
    const k = key.toUpperCase();
    const c = this.cmds.find(c => c && c.key && c.key.toUpperCase() === k);
    if (c) { c.run(); this.refresh(true); return true; }
    return false;
  }

  // ---------------------------------------------------------------- tooltips
  towerLines(def, compare) {
    const lo = def.dmgBase + def.dice, hi = def.dmgBase + def.dice * def.sides;
    const dps = avgDamage(def) / def.cooldown;
    const lines = [];
    lines.push(`<span>Damage</span> ${lo}${hi !== lo ? '–' + hi : ''} ${ATK_NAME[def.attackType] || def.attackType}`);
    lines.push(`<span>Cooldown</span> ${def.cooldown}s &nbsp; <span>DPS</span> ${dps.toFixed(1)}`);
    lines.push(`<span>Range</span> ${def.range} &nbsp; <span>Targets</span> ${[def.targetsGround && 'ground', def.targetsAir && 'air'].filter(Boolean).join(' & ')}`);
    const sp = specials(def);
    if (sp.length) lines.push(sp.map(s => `<span>${s}</span>`).join(' · '));
    if (compare) {
      const d0 = avgDamage(compare) / compare.cooldown;
      lines.push(`<span>DPS change</span> ${dps >= d0 ? '+' : ''}${(dps - d0).toFixed(1)}`);
    }
    return lines;
  }
  showTip(i, el) {
    const c = this.cmds[i]; if (!c) return;
    const t = $('tooltip');
    let html = `<div class="t-title">${esc(c.title)}${c.key && c.key !== 'Esc' ? ` (<u>${c.key}</u>)` : ''}</div>`;
    if (c.cost !== undefined) html += `<div class="t-cost ${this.g.gold < c.cost ? 'poor' : ''}"><i class="ico ico-gold"></i>${c.cost === 0 ? 'Free' : c.cost}</div>`;
    const lines = c.def ? this.towerLines(c.def, c.upgrade ? this.act.view().selected.def : null) : (c.lines || []);
    html += lines.map(l => `<div class="t-line">${l}</div>`).join('');
    const note = c.def ? mapNote(c.def) : '';
    if (note) html += `<div class="t-note">${esc(note)}</div>`;
    t.innerHTML = html;
    t.classList.add('show');
    placeTip(t, el.getBoundingClientRect());
  }
  hideTip() { $('tooltip').classList.remove('show'); }
  // A long press on the battlefield: what the unit under the finger is, over the finger (client px x, y).
  objectTip(o, x, y) {
    const t = $('tooltip');
    t.innerHTML = this.objectTipHtml(o);
    t.classList.add('show');
    placeTip(t, { left: x - 1, right: x + 1, top: y - 36, bottom: y + 36 });
  }
  objectTipHtml(o) {
    if (o.def.upgrades) {
      return `<div class="t-title">${esc(o.def.name)}</div>` + this.towerLines(o.def).map(l => `<div class="t-line">${l}</div>`).join('')
        + `<div class="t-line"><span>Kills</span> ${o.kills ?? 0}${o.building > 0 ? ' &nbsp; <span>under construction</span>' : ''}</div>`;
    }
    const d = o.def;
    return `<div class="t-title">${esc(d.name)}</div><div class="t-line"><span>Hit points</span> ${Math.ceil(Math.max(0, o.hp))} / ${o.maxHp}</div>`
      + `<div class="t-line"><span>Armor</span> ${d.armor} ${ARMOR_NAME[d.armorType] || d.armorType} &nbsp; <span>Speed</span> ${d.speed}</div>`;
  }
  // A line over the battlefield that says what a finger does next (placing a tower); '' hides it.
  hint(text) {
    const h = $('hint');
    if (h.textContent !== text) h.textContent = text;
    h.classList.toggle('show', !!text);
    $('msgs').classList.toggle('hinted', !!text);   // the map messages step up over it
  }

  // ---------------------------------------------------------------- info panel + portrait
  renderInfo(view) {
    const g = this.g, sel = view.selected;
    let html, key;
    if (sel && sel.def && sel.def.upgrades) {
      const d = sel.def, lo = d.dmgBase + d.dice, hi = d.dmgBase + d.dice * d.sides;
      key = `t${sel.id}:${d.id}:${sel.kills}:${sel.building > 0}`;
      html = `<h2>${esc(d.name)}</h2><div class="tier">Tier ${d.tier} · ${esc(kindName(d.kind))}${sel.building > 0 ? ' · under construction' : ''}</div>
        <div class="stats">
          <div><span>Damage</span><b>${lo}${hi !== lo ? '–' + hi : ''}</b></div>
          <div><span>Attack</span><b>${ATK_NAME[d.attackType]}</b></div>
          <div><span>Cooldown</span><b>${d.cooldown}s</b></div>
          <div><span>Range</span><b>${d.range}</b></div>
          <div><span>Kills</span><b>${sel.kills}</b></div>
          <div><span>Sell value</span><b>${g.sellValue(sel)}</b></div>
        </div>
        <div class="tags">${[d.targetsGround ? 'Ground' : '', d.targetsAir ? 'Air' : 'No air'].filter(Boolean).map(t => `<span class="tag ${t === 'No air' ? 'bad' : ''}">${t}</span>`).join('')}${specials(d).map(s => `<span class="tag good">${s}</span>`).join('')}</div>
        ${mapNote(d) ? `<div class="lore">${esc(mapNote(d))}</div>` : ''}`;
    } else if (sel && sel.hp !== undefined) {
      const d = sel.def;
      key = `c${sel.id}:${Math.ceil(sel.hp)}`;
      const k = Math.max(0, sel.hp / sel.maxHp);
      html = `<h2>${esc(d.name)}</h2><div class="tier">Level ${CREEPS.indexOf(d) + 1} creep</div>
        <div class="hp"><i style="width:${(k * 100).toFixed(1)}%"></i><em>${Math.ceil(sel.hp)} / ${sel.maxHp}</em></div>
        <div class="stats">
          <div><span>Armor</span><b>${d.armor} ${ARMOR_NAME[d.armorType] || d.armorType}</b></div>
          <div><span>Speed</span><b>${d.speed}</b></div>
          <div><span>Bounty</span><b>${d.bounty}</b></div>
          <div><span>Income</span><b>+${Math.round(d.income * (RULES.incomeScale || 1))}</b></div>
        </div>${creepTags(d)}`;
    } else {
      const upcoming = g.phase === 'countdown';
      const d = upcoming ? g.nextCreep() : g.currentCreep();
      const lvl = upcoming ? g.level + 1 : g.level;
      key = `n${lvl}:${g.phase}`;
      html = d ? `<h2>${g.phase === 'countdown' ? 'Next: ' : ''}${esc(d.name)}</h2><div class="tier">Level ${lvl} of ${LEVELS} · ${RULES.creepsPerLevel} units</div>
        <div class="stats">
          <div><span>Hit points</span><b>${d.hp}</b></div>
          <div><span>Armor</span><b>${d.armor} ${ARMOR_NAME[d.armorType] || d.armorType}</b></div>
          <div><span>Speed</span><b>${d.speed}</b></div>
          <div><span>Bounty</span><b>${d.bounty} each</b></div>
        </div>${creepTags(d)}` : '<h2>Victory</h2>';
    }
    if (key !== this.lastInfo) { $('info').innerHTML = html; this.lastInfo = key; this.fitInfo(); }
    this.drawPortrait(view);
  }
  // The panel keeps the console's size: what would not fit (a tower's hit points, armour and tags at 1280 x 800, most
  // things on a phone) gets the compact layout, then the most compact one, which scrolls as a last resort, so nothing
  // is cut off unseen. On a phone, where a tap opens the panel bigger, the last resort is the lines that fit whole
  // instead (the title always), with no scrollbar.
  fitInfo() {
    const el = $('info'), fits = () => el.scrollHeight <= el.clientHeight + 1;
    el.classList.remove('fit1', 'fit2', 'fit3');
    if (fits()) return;
    el.classList.add('fit1');
    if (fits()) return;
    el.classList.replace('fit1', 'fit2');
    if (fits() || !phone() || document.body.classList.contains('info-open')) return;
    el.classList.add('fit3');
    const lines = [...el.children].filter(e => e.tagName !== 'H2').flatMap(e => (e.classList.contains('stats') ? [e, ...e.children] : [e]));
    for (let i = lines.length - 1; i >= 0 && !fits(); i--) lines[i].classList.add('cut');
  }
  drawPortrait(view) {
    const x = this.portrait, sel = view.selected, S = x.canvas.width;
    x.clearRect(0, 0, S, S);
    if (sel && sel.def && sel.def.upgrades) {
      const ic = this.iconRect(sel.def.id);
      if (ic) { x.drawImage(ic.img, ...src(ic), 0, 0, S, S); return; }
      const m = this.man.towers[sel.def.id];
      const s = Math.min((S - 10) / m.w, (S - 10) / m.h);
      x.drawImage(m.img, ...src(m), S / 2 - (m.w * s) / 2, S - 4 - m.h * s, m.w * s, m.h * s);
      return;
    }
    const d = sel && sel.hp !== undefined ? sel.def : (this.g.phase === 'countdown' ? this.g.nextCreep() : this.g.currentCreep());
    if (!d) return;
    const p = this.man.portraits && (this.man.portraits[d.id] || this.man.portraits[d.look]);
    if (p && p.img) {
      // slow idle loop, cross-faded between frames so the breathing reads smooth
      const t = performance.now() / 1000 * 4.5;
      const f0 = Math.floor(t) % p.frames, f1 = (f0 + 1) % p.frames, k = t - Math.floor(t);
      x.drawImage(p.img, ...src(p, f0 * p.fw, 0, p.fw, p.fh), 0, 0, S, S);
      x.globalAlpha = k;
      x.drawImage(p.img, ...src(p, f1 * p.fw, 0, p.fw, p.fh), 0, 0, S, S);
      x.globalAlpha = 1;
      return;
    }
    const m = this.r.creepMeta({ def: d });
    const col = Math.floor(performance.now() / 110) % m.frames;
    const s = Math.min((S - 16) / m.fw, (S - 16) / m.fh) * 1.1;
    x.drawImage(m.img, ...src(m, col * m.fw, m.fh, m.fw, m.fh), S / 2 - m.ax * s, S - 6 - m.fh * s + 6, m.fw * s, m.fh * s);
  }

  // ---------------------------------------------------------------- minimap
  drawMinimap() {
    const c = this.mm, rect = c.getBoundingClientRect();
    const dpr = pixelRatio();
    if (c.width !== Math.round(rect.width * dpr)) { c.width = Math.round(rect.width * dpr); c.height = Math.round(rect.height * dpr); }
    if (!c.width || !c.height) return;   // zero-size viewport (hidden pane): nothing to draw into
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / W, c.height / H);
    const ox = (c.width - W * s) / 2, oy = (c.height - H * s) / 2;
    x.setTransform(s, 0, 0, s, ox, oy);
    if (this.r.static && this.r.static.width && this.r.static.height) x.drawImage(this.r.static, 0, 0, W, H);
    for (const t of this.g.towers) { x.fillStyle = '#5aa0ff'; x.fillRect(sx(t.x) - 9, sy(t.y) - 7, 18, 14); }
    for (const cr of this.g.creeps) { x.fillStyle = '#ff3b2b'; x.beginPath(); x.arc(sx(cr.x), sy(cr.y), 9, 0, Math.PI * 2); x.fill(); }
    x.setTransform(1, 0, 0, 1, 0, 0);
    // the camera's view, while it shows less than the whole map
    const [vx0, vy0, vx1, vy1] = this.act.cam().rect();
    if (vx0 > 1 || vy0 > 1 || vx1 < W - 1 || vy1 < H - 1) {
      const fx0 = Math.max(0, vx0), fy0 = Math.max(0, vy0), fx1 = Math.min(W, vx1), fy1 = Math.min(H, vy1);
      x.strokeStyle = 'rgba(255,255,255,0.9)'; x.lineWidth = dpr;
      x.strokeRect(Math.round(ox + fx0 * s) + 0.5, Math.round(oy + fy0 * s) + 0.5, Math.round((fx1 - fx0) * s) - 1, Math.round((fy1 - fy0) * s) - 1);
    } else { x.strokeStyle = 'rgba(255,255,255,0.6)'; x.lineWidth = 1; x.strokeRect(ox + 0.5, oy + 0.5, W * s - 1, H * s - 1); }
  }
  // minimap css px -> logical px (the map is fitted into the minimap, centred)
  minimapToWorld(mx, my) {
    const r = this.mm.getBoundingClientRect(), s = Math.min(r.width / W, r.height / H) || 1;
    return { X: (mx - (r.width - W * s) / 2) / s, Y: (my - (r.height - H * s) / 2) / s };
  }

  // ---------------------------------------------------------------- messages
  message(html, color = '#f2ead8') {
    const box = $('msgs');
    const d = document.createElement('div');
    d.style.color = color; d.innerHTML = html;
    box.appendChild(d);
    while (box.children.length > 6) box.removeChild(box.firstChild);
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 1000); }, 7000);
  }
  announce(title, sub) {
    const a = $('announce');
    a.querySelector('.a-title').textContent = title;
    a.querySelector('.a-sub').textContent = sub || '';
    a.classList.add('show');
    clearTimeout(this.annT);
    this.annT = setTimeout(() => a.classList.remove('show'), 3200);
  }
  error(text) {
    const e = $('error');
    e.textContent = text; e.classList.add('show');
    clearTimeout(this.errT);
    this.errT = setTimeout(() => e.classList.remove('show'), 1600);
  }
  handle(e) {
    const g = this.g;
    if (e.type === 'level') this.announce(`Level ${e.level}`, `${e.creep.name}${e.creep.flying ? ' · Air' : ''}${e.creep.magicImmune ? ' · Magic immune' : ''}${e.creep.invisible ? ' · Invisible' : ''}`);
    if (e.type === 'cleared') this.message(`Level ${e.level} cleared. Income <b style="color:#ffd84a">+${Math.round(e.income * (RULES.incomeScale || 1))}</b>.`);
    if (e.type === 'income') this.message(`<b style="color:#ffd84a">+${e.gold}</b> gold income`, '#e6dcc6');
    if (e.type === 'leak') this.message(`${esc(e.creep.def.name)} reached the castle! <b>${g.lives}</b> lives left.`, '#ff7a6a');
  }

  // ---------------------------------------------------------------- per frame
  refresh(force = false) {
    const g = this.g, view = this.act.view();
    setText('r-gold', Math.floor(g.gold));
    setText('r-income', g.income);
    setText('r-income-t', Math.ceil(g.incomeTimer) + 's');
    setText('r-lives', g.lives);
    setText('r-level', `${g.level}/${LEVELS}`);
    const up = g.phase === 'countdown';
    const cur = up ? g.nextCreep() : g.currentCreep();
    const lvl = Math.max(1, Math.min(LEVELS, up ? g.level + 1 : g.level));
    const ttl = `<b class="gold-text">Level ${lvl} / ${LEVELS}</b><small>${cur ? (up ? 'Next: ' : '') + esc(cur.name) : (g.phase === 'won' ? 'Victory' : '')}</small>`;
    const tb = $('tb-title');
    if (tb.dataset.v !== ttl) { tb.innerHTML = ttl; tb.dataset.v = ttl; }
    const wt = $('wave-timer');
    let wtxt = '';
    const tap = lastInput() === 'touch';   // a finger calls the level by tapping this box (a click on it stays a click on the map)
    if (g.phase === 'countdown' && g.nextCreep()) wtxt = `Level ${g.level + 1} in ${Math.ceil(g.countdown)}s<small>${esc(g.nextCreep().name)} · ${tap ? 'tap here' : 'press N'} to call it now</small>`;
    else if (g.phase === 'spawning' || g.phase === 'fighting') wtxt = `Level ${g.level} · ${g.creeps.length + g.toSpawn} left<small>${esc(g.currentCreep().name)}</small>`;
    if (wt.dataset.v !== wtxt) { wt.innerHTML = wtxt; wt.dataset.v = wtxt; }
    wt.classList.toggle('tap', tap && g.phase === 'countdown');
    this.renderCommands(view);
    this.renderInfo(view);
    this.mmTimer -= 1;
    if (this.mmTimer <= 0 || force) { this.drawMinimap(); this.mmTimer = 12; }
  }
}

function setText(id, v) { const e = $(id); const s = String(v); if (e.textContent !== s) e.textContent = s; }
// The Keep building button's tooltip (Classic's and Line Tower Wars'), in the words of the pointer the player uses.
export function keepLine(on) {
  const w = clickWord();
  return on ? `Each ${w.toLowerCase()} places another tower until you cancel. ${w} to turn it off.`
    : `Place one tower after another until you cancel${lastInput() === 'touch' ? '' : ' (as holding <b>Shift</b> does)'}.`;
}
// A tooltip next to a rect (client px): above it, else to its left (the console on the side of a landscape phone),
// else below, always inside the window.
export function placeTip(t, rect) {
  const tw = t.offsetWidth, th = t.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let left = rect.right - tw, top = rect.top - th - 10;
  if (top < 8 && rect.left - tw - 10 >= 8) { left = rect.left - tw - 10; top = (rect.top + rect.bottom) / 2 - th / 2; }
  else if (top < 8) top = rect.bottom + 10;
  t.style.left = Math.max(8, Math.min(vw - tw - 8, left)) + 'px';
  t.style.top = Math.max(8, Math.min(vh - th - 8, top)) + 'px';
}
export function kindName(k) {
  return { archer: 'Archery', rifle: 'Rifle', guard: 'Guard', ballista: 'Ballista', cannon: 'Cannon', blade: 'Blades', ogre: 'Ogre', wisp: 'Elemental', fire: 'Fire',
    frost: 'Frost', water: 'Water', arcane: 'Lightning', light: 'Light', shroom: 'Nature', poison: 'Shadow', artillery: 'Artillery', moon: 'Moon', flame: 'Fire' }[k] || k;
}
export function specials(d) {
  const s = [];
  if (d.splash && d.weapon !== 'mbounce') s.push(`Splash ${d.splash.full}`);
  if (d.bounce) s.push(`Bounces ×${d.bounce.targets}`);
  if (d.slow) s.push(`Slow ${d.slow.pct}%`);
  if (d.poison) s.push(`Poison ${d.poison.dps}/s`);
  if (d.bash) s.push(`Stun ${d.bash.chance}%`);
  if (d.auraSlow) s.push(`Slow aura ${d.auraSlow.pct}%`);
  if (d.immolation) s.push(`Immolation ${d.immolation.dps}/s`);
  if (d.trueSight) s.push('True sight');
  return s;
}
// The map's own tooltip text under a tower's real stats: what it says about the tower ('Medium splash', 'Ground Only').
// Its numbers (damage, range, shots a minute) are left out: the stats above are the real ones, and the map's text is
// often out of date. The data splits '60 shots / minute' at the slash; what follows 'minute' on such a line stays.
export function mapNote(def) {
  const out = [];
  for (const line of def.tooltip || []) {
    const s = String(line).trim();
    if (/^(Damage: *)?\d+$/.test(s) || /^Range: *\d+$/.test(s) || /^\d+ shots( per minute)?$/.test(s)) continue;
    const rest = s.replace(/^minute\b\s*/, '');
    if (rest) out.push(rest);
  }
  return out.join(' · ');
}
// Air: hit as air (the target class, where the data has one apart from how the unit moves).
export function creepTags(d) {
  const t = [];
  if (d.air ?? d.flying) t.push('<span class="tag">Air</span>');
  if (d.magicImmune) t.push('<span class="tag bad">Magic immune</span>');
  if (d.invisible) t.push('<span class="tag bad">Invisible</span>');
  if (d.evasion) t.push('<span class="tag">Evasion</span>');
  if (d.armorType === 'divine') t.push('<span class="tag bad">Divine armor · chaos only</span>');
  return t.length ? `<div class="tags">${t.join('')}</div>` : '';
}
