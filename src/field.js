// The combat core shared by every mode: towers, creeps and missiles, the WC3 damage and armour rules, splash, bounce,
// slow, poison, bash, the slow aura, immolation, true sight, bounty and the event stream the renderer and effects use.
// Line Tower Wars lanes (src/lane.js) add the phase-3 rules on top by overriding hooks (creep auras and regeneration,
// reincarnation, hardened skin, attackers and tower hit points); Classic Defense uses this file as it is.
// Movement is pluggable: a mover's advance(c, tiles) moves a creep `tiles` along its route and returns true when the
// creep has reached the end. Classic Defense (src/game.js) uses a fixed road; Line Tower Wars lanes (src/lane.js) use
// a flow field. Subclasses decide what an arrival or a kill means by overriding arrive(c) and kill(c).
import { DAMAGE, ARMOR } from './data/rules.js?v=91305a8026e8';

export const TILE = 128;             // WC3 units per tile (one tower footprint)
export const BUILD_TIME = 1.0;       // construction animation, seconds
export const SPLASH_MED = 0.5, SPLASH_SMALL = 0.25;  // WC3 default splash damage factors
export const MIN_SPEED = 150;        // WC3 default minimum move speed

export const armorFactor = (a) => a >= 0 ? 1 - (0.06 * a) / (1 + 0.06 * a) : 2 - Math.pow(0.94, -a);
export const typeFactor = (atk, armorType) => (DAMAGE[atk] || DAMAGE.normal)[Math.max(0, ARMOR.indexOf(armorType))];
export const avgDamage = (t) => t.dmgBase + t.dice * (t.sides + 1) / 2;

// Air or ground as a target: Line Tower Wars units carry the map's Targeted As (`air`), which can differ from how they
// move (h01M Phoenix flies but is targeted as ground); Classic creeps only have `flying`.
export const isAirTarget = (def) => def.air ?? def.flying;

export class Field {
  // ids: the id counter ({ next }). A match passes one counter to all its lanes, so ids are unique across the match and
  // a creep keeps its id when it walks into another lane; every game or match starts again at 1, whatever ran before.
  constructor({ rng = Math.random, mover = null, ids = null } = {}) {
    this.rng = rng;                  // injectable: Math.random by default, a seeded generator for tests and matches
    this.mover = mover;
    this.ids = ids || { next: 1 };
    this.towers = []; this.creeps = []; this.missiles = []; this.events = [];
    this.time = 0;
    this.visEpoch = 0;               // bumped whenever creeps move or towers change; visible() caches per epoch
  }
  emit(e) { this.events.push(e); }
  nextId() { return this.ids.next++; }
  roll(dice, sides) { let s = 0; for (let i = 0; i < dice; i++) s += 1 + Math.floor(this.rng() * sides); return s; }

  // ---------- hooks ----------
  arrive(c) { c.dead = true; c.leaked = true; }   // the creep reached the end of its route
  kill(c) { this.emit({ type: 'death', creep: c, gold: c.def.bounty }); }   // the creep died (not by leaking)
  towersChanged() { this.visEpoch++; }

  // ---------- one simulation step of combat ----------
  combat(dt) {
    for (const t of this.towers) if (t.building > 0) t.building = Math.max(0, t.building - dt);
    this.auras();
    for (const c of this.creeps) this.move(c, dt);
    this.visEpoch++;
    for (const t of this.towers) if (!t.building) this.attack(t, dt);
    for (const m of this.missiles) this.fly(m, dt);
    if (this.missiles.some(m => m.done)) this.missiles = this.missiles.filter(m => !m.done);
    for (const c of this.creeps) this.tickBuffs(c, dt);
    this.collect();
  }
  collect() {
    for (const c of this.creeps) if (c.dead && !c.counted) {
      c.counted = true;
      if (!c.leaked) this.kill(c);
    }
    if (this.creeps.some(c => c.dead)) this.creeps = this.creeps.filter(c => !c.dead);
  }

  auras() {
    for (const c of this.creeps) { c.auraSlow = 0; c.burn = 0; }
    for (const t of this.towers) {
      if (t.building) continue;
      const d = t.def;
      if (!d.auraSlow && !d.immolation) continue;
      // cheap reject before the exact distance: outside this box both rings miss (padded, so no edge case changes)
      const R = Math.max(d.auraSlow ? d.auraSlow.range : 0, d.immolation ? d.immolation.range + 64 : 0) / TILE + 1e-6;
      for (const c of this.creeps) {
        if (Math.abs(c.x - t.x) > R || Math.abs(c.y - t.y) > R) continue;
        const dist = Math.hypot(c.x - t.x, c.y - t.y) * TILE;
        if (d.auraSlow && dist <= d.auraSlow.range && !c.def.magicImmune) c.auraSlow = Math.max(c.auraSlow, d.auraSlow.pct);
        if (d.immolation && dist <= d.immolation.range + 64) c.burn += d.immolation.dps;
      }
    }
  }
  speedOf(c) {
    if (c.stunUntil > this.time) return 0;
    let slow = c.slowUntil > this.time ? c.slowPct : 0;
    if (c.auraSlow > slow) slow = c.auraSlow;
    for (const p of c.poisons) { const v = p.slow || 0; if (v > slow) slow = v; }
    const s = c.def.speed * (1 - slow / 100);
    return Math.max(Math.min(MIN_SPEED, c.def.speed), s);
  }
  move(c, dt) {
    if (c.idle) return;              // a creep with no orders stands where it is (Line Tower Wars: a leaver's lane)
    const speed = this.speedOf(c);
    if (c.speedNow !== undefined) c.walk += dt * speed / 60;
    c.speedNow = speed;
    if (this.mover.advance(c, speed / TILE * dt)) this.arrive(c);
  }
  // Invisible creeps need a finished true-sight tower in range. Cached per creep until creeps move or towers change.
  visible(c) {
    if (!c.def.invisible) return true;
    if (c.visEpoch !== this.visEpoch) {
      c.visEpoch = this.visEpoch;
      c.vis = this.towers.some(t => t.def.trueSight && !t.building && Math.hypot(c.x - t.x, c.y - t.y) * TILE <= t.def.trueSight);
    }
    return c.vis;
  }
  canHit(t, c) {
    const d = t.def;
    if (c.dead) return false;
    if (isAirTarget(c.def) ? !d.targetsAir : !d.targetsGround) return false;
    if (d.attackType === 'magic' && c.def.magicImmune) return false;
    return this.visible(c);
  }
  inRange(t, c, extra = 0) { return Math.hypot(c.x - t.x, c.y - t.y) * TILE <= t.def.range + 48 + extra; }
  attack(t, dt) {
    t.cd -= dt;
    if (t.cd > 0) return;
    if (!t.target || !this.canHit(t, t.target) || !this.inRange(t, t.target)) {
      t.target = null;
      const d = t.def, R = (d.range + 48) / TILE;
      let best = null;
      for (const c of this.creeps) {
        if (best && c.dist <= best.dist) continue;
        const dx = c.x - t.x, dy = c.y - t.y;
        if (Math.abs(dx) > R || Math.abs(dy) > R) continue;   // cheap reject before the exact checks (pure filters: order is free)
        if (c.dead || (isAirTarget(c.def) ? !d.targetsAir : !d.targetsGround)) continue;
        if (this.canHit(t, c) && this.inRange(t, c)) best = c;
      }
      t.target = best;
    }
    const c = t.target; if (!c) return;
    t.cd = t.def.cooldown;
    t.aim = Math.atan2(c.y - t.y, c.x - t.x); t.firedAt = this.time;
    const d = t.def, dmg = d.dmgBase + this.roll(d.dice, d.sides);
    this.emit({ type: 'shot', tower: t, target: c });
    if (d.weapon === 'instant' || d.weapon === 'normal') { this.impact(t, c, dmg, c.x, c.y); return; }
    const m = { id: this.nextId(), tower: t, def: d, target: c, dmg, x: t.x, y: t.y - 0.45, sx: t.x, sy: t.y - 0.45,
      tx: c.x, ty: c.y, speed: d.missileSpeed / TILE, done: false, bounces: d.bounce ? d.bounce.targets : 0, hit: new Set(), t: 0 };
    if (d.weapon === 'artillery') {   // lands where the target was, after a ballistic arc
      m.flight = Math.max(0.35, Math.hypot(m.tx - m.x, m.ty - m.y) / m.speed);
    }
    this.missiles.push(m);
  }
  fly(m, dt) {
    m.t += dt;
    if (m.flight) {
      const k = Math.min(1, m.t / m.flight);
      m.x = m.sx + (m.tx - m.sx) * k; m.y = m.sy + (m.ty - m.sy) * k; m.arc = Math.sin(Math.PI * k);
      if (k >= 1) { m.done = true; this.impact(m.tower, null, m.dmg, m.tx, m.ty, m); }
      return;
    }
    const c = m.target;
    if (!c.dead) { m.tx = c.x; m.ty = c.y; }
    const dx = m.tx - m.x, dy = m.ty - m.y, d = Math.hypot(dx, dy), s = m.speed * dt;
    m.ang = Math.atan2(dy, dx);
    if (d <= s) {
      m.x = m.tx; m.y = m.ty;
      if (c.dead && !m.def.splash) { m.done = true; return; }
      this.impact(m.tower, c.dead ? null : c, m.dmg, m.tx, m.ty, m);
      if (m.bounces > 0 && !m.done) this.bounce(m, c); else m.done = true;
      return;
    }
    m.x += dx / d * s; m.y += dy / d * s;
  }
  bounce(m, from) {
    m.hit.add(from.id); m.bounces--;
    const range = (m.def.bounce.range) / TILE;
    let next = null, bd = Infinity;
    for (const c of this.creeps) {
      if (m.hit.has(c.id) || !this.canHit(m.tower, c)) continue;
      const d = Math.hypot(c.x - from.x, c.y - from.y);
      if (d <= range && d < bd) { bd = d; next = c; }
    }
    if (!next) { m.done = true; return; }
    m.target = next; m.dmg *= 1 - m.def.bounce.loss;
  }
  damage(t, c, amount, kind) {
    if (c.dead) return;
    let dmg = amount;
    if (kind !== 'spell') dmg *= typeFactor(t.def.attackType, c.def.armorType) * armorFactor(c.def.armor);
    c.hp -= dmg;
    if (c.hp <= 0) { c.dead = true; c.killer = t; }
  }
  impact(t, c, dmg, x, y, m) {
    const d = t.def;
    this.emit({ type: 'impact', tower: t, creep: c, x, y, missile: d.missile, splash: d.splash && d.weapon !== 'mbounce' ? d.splash : null });
    // Evasion: Line Tower Wars units carry the ability's own chance (`evade`); Classic creeps keep 10%.
    if (c && !c.dead && !(c.def.evasion && this.rng() < (c.def.evade ?? 0.1))) {
      this.damage(t, c, dmg);
      this.onHit(t, c);
      if (d.bash && this.rng() * 100 < d.bash.chance) { this.damage(t, c, d.bash.dmg); c.stunUntil = this.time + d.bash.stun; this.emit({ type: 'bash', creep: c }); }
    }
    if (d.splash && d.weapon !== 'mbounce') {
      const R = Math.max(d.splash.full, d.splash.medium, d.splash.small) / TILE;
      for (const o of this.creeps) {
        if (o === c || o.dead) continue;
        if (Math.abs(o.x - x) > R || Math.abs(o.y - y) > R) continue;   // outside every splash ring
        if (!this.canHit(t, o)) continue;
        const r = Math.hypot(o.x - x, o.y - y) * TILE;
        const f = r <= d.splash.full ? 1 : r <= d.splash.medium ? SPLASH_MED : r <= d.splash.small ? SPLASH_SMALL : 0;
        if (f) { this.damage(t, o, dmg * f); this.onHit(t, o); }
      }
    }
  }
  onHit(t, c) {
    const d = t.def;
    if (c.dead || c.def.magicImmune) return;
    if (d.slow) { c.slowPct = Math.max(c.slowUntil > this.time ? c.slowPct : 0, d.slow.pct); c.slowUntil = this.time + d.slow.dur; }
    if (d.poison) { c.poisons = c.poisons.filter(p => p.src !== t); c.poisons.push({ src: t, dps: d.poison.dps, slow: d.poison.slow, until: this.time + d.poison.dur }); }
  }
  tickBuffs(c, dt) {
    if (c.dead) return;
    if (c.poisons.length && c.poisons.some(p => p.until <= this.time)) c.poisons = c.poisons.filter(p => p.until > this.time);
    for (const p of c.poisons) this.damage(p.src, c, p.dps * dt, 'spell');
    if (c.burn && !c.dead) { c.hp -= c.burn * dt; if (c.hp <= 0) { c.dead = true; } }
  }
}
