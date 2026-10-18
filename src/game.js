// Classic Warcraft TD rules. Tower, creep and economy numbers come from Line Tower Wars 45 (see tools/gen_ltw.py).
// The combat itself (towers, creeps, missiles, damage, buffs, events) is the shared core in src/field.js; this file adds
// the snake road, the level-by-level waves, the income timer, lives and the build grid.
import { TOWERS, BUILD_ROOTS } from './data/towers.js?v=a48717ff8443';
import { CREEPS } from './data/creeps.js?v=a48717ff8443';
import { RULES } from './data/rules.js?v=a48717ff8443';
import { COLS, PATH, buildable, pointAt, TOTAL_LEN } from './level.js?v=a48717ff8443';
import { Field, BUILD_TIME, SPLASH_MED, SPLASH_SMALL, typeFactor, avgDamage } from './field.js?v=a48717ff8443';

export { TOWERS, BUILD_ROOTS, CREEPS, RULES, BUILD_TIME, SPLASH_MED, SPLASH_SMALL, typeFactor, avgDamage };
export const LEVELS = CREEPS.length;
export const FIRST_DELAY = 30;     // seconds before level 1
export const BETWEEN_LEVELS = 15;  // seconds between a cleared level and the next
export const SPAWN_GAP = 1.0;      // seconds between creeps of a level

// The fixed road: creeps walk `dist` tiles along PATH, offset sideways by their `lane`.
export const roadMover = {
  advance(c, step) {
    c.dist += step;
    const p = pointAt(c.dist);
    c.x = p.x - p.dy * c.lane; c.y = p.y + p.dx * c.lane; c.dirx = p.dx; c.diry = p.dy;
    return c.dist >= TOTAL_LEN;
  },
};

export class Game extends Field {
  // opts.rng: random source (default Math.random); pass a seeded one for reproducible games.
  constructor(opts = {}) {
    super({ rng: opts.rng || Math.random, mover: roadMover });
    this.gold = RULES.startGold; this.lives = RULES.lives; this.income = RULES.income;
    this.incomeTimer = RULES.incomeInterval;
    this.level = 0; this.phase = 'countdown'; this.countdown = FIRST_DELAY;
    this.toSpawn = 0; this.spawnTimer = 0; this.paused = false;
    this.occupied = new Map(); this.stats = { kills: 0, leaks: 0, built: 0 };
  }
  nextCreep() { return CREEPS[this.level] || null; }
  currentCreep() { return CREEPS[this.level - 1] || null; }

  // ---------- building ----------
  towerAt(c, r) { return this.occupied.get(r * COLS + c) || null; }
  canBuild(id, c, r) { return buildable(c, r) && !this.towerAt(c, r) && this.gold >= TOWERS[id].cost && this.phase !== 'won' && this.phase !== 'lost'; }
  build(id, c, r) {
    if (!BUILD_ROOTS.includes(id) || !this.canBuild(id, c, r)) return null;
    const def = TOWERS[id];
    this.gold -= def.cost;
    const t = { id: this.nextId(), def, c, r, x: c + 0.5, y: r + 0.5, cd: 0, target: null, building: BUILD_TIME, buildTotal: BUILD_TIME, kills: 0, spent: def.cost };
    this.towers.push(t); this.occupied.set(r * COLS + c, t); this.stats.built++;
    this.towersChanged();
    this.emit({ type: 'build', tower: t });
    return t;
  }
  canUpgrade(t, id) { return t.def.upgrades.includes(id) && this.gold >= TOWERS[id].cost && !t.building; }
  upgrade(t, id) {
    if (!this.canUpgrade(t, id)) return false;
    const def = TOWERS[id];
    this.gold -= def.cost; t.def = def; t.spent += def.cost; t.building = BUILD_TIME * 0.75; t.buildTotal = BUILD_TIME * 0.75; t.target = null;
    this.towersChanged();
    this.emit({ type: 'upgrade', tower: t });
    return true;
  }
  sellValue(t) { return Math.floor(t.spent * RULES.sellRate); }
  sell(t) {
    this.gold += this.sellValue(t);
    this.towers.splice(this.towers.indexOf(t), 1); this.occupied.delete(t.r * COLS + t.c);
    this.towersChanged();
    this.emit({ type: 'sell', tower: t, gold: this.sellValue(t) });
  }

  // ---------- levels ----------
  callNext() { if (this.phase === 'countdown') this.countdown = 0; }
  startLevel() {
    const def = CREEPS[this.level]; if (!def) return;
    this.level++; this.phase = 'spawning'; this.toSpawn = RULES.creepsPerLevel; this.spawnTimer = 0;
    this.emit({ type: 'level', level: this.level, creep: def });
  }
  spawn() {
    const def = CREEPS[this.level - 1];
    const lane = ((this.toSpawn * 0.37) % 1 - 0.5) * 0.36;   // small sideways offset so creeps don't stack
    this.creeps.push({ id: this.nextId(), def, hp: def.hp, maxHp: def.hp, dist: 0, lane, x: PATH[0][0], y: PATH[0][1], dirx: 0, diry: 1,
      slowPct: 0, slowUntil: 0, auraSlow: 0, poisons: [], stunUntil: 0, dead: false, walk: this.rng() * 10 });
  }

  // ---------- field hooks ----------
  arrive(c) {
    c.dead = true; c.leaked = true; this.lives--; this.stats.leaks++;
    this.emit({ type: 'leak', creep: c });
    if (this.lives <= 0) { this.lives = 0; this.phase = 'lost'; this.emit({ type: 'lost' }); }
  }
  kill(c) {
    this.gold += c.def.bounty; this.stats.kills++; if (c.killer) c.killer.kills++;
    this.emit({ type: 'death', creep: c, gold: c.def.bounty });
  }

  // ---------- simulation ----------
  step(dt) {
    if (this.paused || this.phase === 'won' || this.phase === 'lost') return;
    this.time += dt;
    this.incomeTimer -= dt;
    if (this.incomeTimer <= 0) { this.incomeTimer += RULES.incomeInterval; this.gold += this.income; this.emit({ type: 'income', gold: this.income }); }

    if (this.phase === 'countdown') { this.countdown -= dt; if (this.countdown <= 0) this.startLevel(); }
    if (this.phase === 'spawning') {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.toSpawn > 0) { this.spawn(); this.toSpawn--; this.spawnTimer = SPAWN_GAP; }
      if (this.toSpawn === 0) this.phase = 'fighting';
    }
    this.combat(dt);

    if (this.phase === 'fighting' && this.creeps.length === 0) {
      const def = this.currentCreep();
      if (this.level >= LEVELS) { this.phase = 'won'; this.emit({ type: 'won' }); return; }
      this.income += Math.round(def.income * (RULES.incomeScale || 1));
      this.emit({ type: 'cleared', level: this.level, income: def.income });
      this.phase = 'countdown'; this.countdown = BETWEEN_LEVELS;
    }
  }
}
