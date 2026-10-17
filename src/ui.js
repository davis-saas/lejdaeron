// Warcraft III Reforged-style console: resources, minimap, animated portrait + info, command card, tooltips, messages.
// The chrome itself (frames, plates, buttons) is CSS over Blender-rendered images in assets/ui/ (see style.css).
import { TOWERS, BUILD_ROOTS, CREEPS, RULES, LEVELS, avgDamage, typeFactor } from './game.js';
import { TILE, COLS, ROWS, SCREEN_W, SCREEN_H } from './level.js';
import { W, H, K, sx, sy } from './render.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ARMOR_NAME = { small: 'Light', medium: 'Medium', large: 'Heavy', fort: 'Fortified', normal: 'Normal', hero: 'Hero', divine: 'Divine', none: 'Unarmored' };
const ATK_NAME = { normal: 'Normal', pierce: 'Pierce', siege: 'Siege', magic: 'Magic', chaos: 'Chaos', hero: 'Hero', spells: 'Spells' };
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
      x.drawImage(ic.img, ic.sx, ic.sy, ic.w, ic.h, 0, 0, ic.w, ic.h);
    } else {
      const m = this.man.towers[def.id];
      c.width = 108; c.height = 108;
      const acc = ACCENT[def.kind] || '#555555';
      const g = x.createRadialGradient(54, 44, 4, 54, 54, 76);
      g.addColorStop(0, acc); g.addColorStop(1, '#050403');
      x.fillStyle = g; x.fillRect(0, 0, 108, 108);
      const s = Math.min(100 / m.w, 102 / m.h);
      x.drawImage(m.img, m.sx, m.sy, m.w, m.h, 54 - (m.w * s) / 2, 106 - m.h * s, m.w * s, m.h * s);
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
      x.drawImage(ic.img, ic.sx, ic.sy, ic.w, ic.h, 0, 0, ic.w, ic.h);
      this.icons.set(key, c);
      return c;
    }
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

  // ---------------------------------------------------------------- command card
  buildCommandGrid() {
    const root = $('commands');
    root.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const b = document.createElement('button');
      b.className = 'cmd empty';
      b.onmouseenter = () => this.showTip(i, b);
      b.onmouseleave = () => this.hideTip();
      b.onclick = () => { const c = this.cmds[i]; if (c && c.run) { c.run(); this.hideTip(); this.refresh(true); } };
      root.appendChild(b);
    }
  }
  commandsFor(view) {
    const g = this.g, list = new Array(12).fill(null);
    const sel = view.selected;
    if (view.placing) {
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
      const sig = c ? `${c.def ? c.def.id : c.glyph}|${c.key}|${c.cost !== undefined && this.g.gold < c.cost}` : '';
      if (b.dataset.sig === sig) return;
      b.dataset.sig = sig;
      b.innerHTML = '';
      b.className = 'cmd' + (c ? '' : ' empty') + (c && c.cost !== undefined && this.g.gold < c.cost ? ' poor' : '') + (c && view.placing && c.def === view.placing ? ' active' : '');
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
    if (c.def && c.def.tooltip && c.def.tooltip.length) html += `<div class="t-note">${esc(c.def.tooltip.join(' · '))}</div>`;
    t.innerHTML = html;
    t.classList.add('show');
    const rect = el.getBoundingClientRect();
    const tw = t.offsetWidth, th = t.offsetHeight;
    t.style.left = Math.max(8, Math.min(window.innerWidth - tw - 8, rect.right - tw)) + 'px';
    t.style.top = Math.max(8, rect.top - th - 10) + 'px';
  }
  hideTip() { $('tooltip').classList.remove('show'); }

  // ---------------------------------------------------------------- info panel + portrait
  renderInfo(view) {
    const g = this.g, sel = view.selected;
    let html, key;
    if (sel && sel.def && sel.def.upgrades) {
      const d = sel.def, lo = d.dmgBase + d.dice, hi = d.dmgBase + d.dice * d.sides;
      key = `t${sel.id}:${d.id}:${sel.kills}:${g.gold >= 0}`;
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
        ${d.tooltip && d.tooltip.length ? `<div class="lore">${esc(d.tooltip.join(' · '))}</div>` : ''}`;
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
    if (key !== this.lastInfo) { $('info').innerHTML = html; this.lastInfo = key; }
    this.drawPortrait(view);
  }
  drawPortrait(view) {
    const x = this.portrait, sel = view.selected, S = x.canvas.width;
    x.clearRect(0, 0, S, S);
    if (sel && sel.def && sel.def.upgrades) {
      const ic = this.iconRect(sel.def.id);
      if (ic) { x.drawImage(ic.img, ic.sx, ic.sy, ic.w, ic.h, 0, 0, S, S); return; }
      const m = this.man.towers[sel.def.id];
      const s = Math.min((S - 10) / m.w, (S - 10) / m.h);
      x.drawImage(m.img, m.sx, m.sy, m.w, m.h, S / 2 - (m.w * s) / 2, S - 4 - m.h * s, m.w * s, m.h * s);
      return;
    }
    const d = sel && sel.hp !== undefined ? sel.def : (this.g.phase === 'countdown' ? this.g.nextCreep() : this.g.currentCreep());
    if (!d) return;
    const p = this.man.portraits && this.man.portraits[d.look];
    if (p && p.img) {
      // slow idle loop, cross-faded between frames so the breathing reads smooth
      const t = performance.now() / 1000 * 4.5;
      const f0 = Math.floor(t) % p.frames, f1 = (f0 + 1) % p.frames, k = t - Math.floor(t);
      x.drawImage(p.img, p.sx + f0 * p.fw, p.sy, p.fw, p.fh, 0, 0, S, S);
      x.globalAlpha = k;
      x.drawImage(p.img, p.sx + f1 * p.fw, p.sy, p.fw, p.fh, 0, 0, S, S);
      x.globalAlpha = 1;
      return;
    }
    const m = this.man.creeps[d.look];
    const col = Math.floor(performance.now() / 110) % m.frames;
    const s = Math.min((S - 16) / m.fw, (S - 16) / m.fh) * 1.1;
    x.drawImage(m.img, m.sx + col * m.fw, m.sy + m.fh, m.fw, m.fh, S / 2 - m.ax * s, S - 6 - m.fh * s + 6, m.fw * s, m.fh * s);
  }

  // ---------------------------------------------------------------- minimap
  drawMinimap() {
    const c = this.mm, rect = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(rect.width * dpr)) { c.width = Math.round(rect.width * dpr); c.height = Math.round(rect.height * dpr); }
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / W, c.height / H);
    const ox = (c.width - W * s) / 2, oy = (c.height - H * s) / 2;
    x.setTransform(s, 0, 0, s, ox, oy);
    if (this.r.static) x.drawImage(this.r.static, 0, 0, W, H);
    for (const t of this.g.towers) { x.fillStyle = '#5aa0ff'; x.fillRect(sx(t.x) - 9, sy(t.y) - 7, 18, 14); }
    for (const cr of this.g.creeps) { x.fillStyle = '#ff3b2b'; x.beginPath(); x.arc(sx(cr.x), sy(cr.y), 9, 0, Math.PI * 2); x.fill(); }
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.strokeStyle = 'rgba(255,255,255,0.6)'; x.lineWidth = 1; x.strokeRect(ox + 0.5, oy + 0.5, W * s - 1, H * s - 1);
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
    if (g.phase === 'countdown' && g.nextCreep()) wtxt = `Level ${g.level + 1} in ${Math.ceil(g.countdown)}s<small>${esc(g.nextCreep().name)} · press N to call it now</small>`;
    else if (g.phase === 'spawning' || g.phase === 'fighting') wtxt = `Level ${g.level} · ${g.creeps.length + g.toSpawn} left<small>${esc(g.currentCreep().name)}</small>`;
    if (wt.dataset.v !== wtxt) { wt.innerHTML = wtxt; wt.dataset.v = wtxt; }
    this.renderCommands(view);
    this.renderInfo(view);
    this.mmTimer -= 1;
    if (this.mmTimer <= 0 || force) { this.drawMinimap(); this.mmTimer = 12; }
  }
}

function setText(id, v) { const e = $(id); const s = String(v); if (e.textContent !== s) e.textContent = s; }
function kindName(k) {
  return { archer: 'Archery', rifle: 'Rifle', guard: 'Guard', ballista: 'Ballista', cannon: 'Cannon', blade: 'Blades', ogre: 'Ogre', wisp: 'Elemental', fire: 'Fire',
    frost: 'Frost', water: 'Water', arcane: 'Lightning', light: 'Light', shroom: 'Nature', poison: 'Shadow', artillery: 'Artillery', moon: 'Moon', flame: 'Fire' }[k] || k;
}
function specials(d) {
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
function creepTags(d) {
  const t = [];
  if (d.flying) t.push('<span class="tag">Air</span>');
  if (d.magicImmune) t.push('<span class="tag bad">Magic immune</span>');
  if (d.invisible) t.push('<span class="tag bad">Invisible</span>');
  if (d.evasion) t.push('<span class="tag">Evasion</span>');
  if (d.armorType === 'divine') t.push('<span class="tag bad">Divine armor · chaos only</span>');
  return t.length ? `<div class="tags">${t.join('')}</div>` : '';
}
