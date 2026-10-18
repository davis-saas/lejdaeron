// One player's Line Tower Wars lane: a straight open field of 9 x 44 tiles that the owner mazes with towers (one tile
// wider than the map's 8, the owner's adaptation: a wall of 8 towers fits with a one-tile gap).
// Coordinates: u (x) runs along the lane from the spawn (u = 0) to the exit (u = 44), v (y) runs across it (0 to 9).
// Tiles with u < 2 are the spawn zone and tiles with u >= 42 the exit zone; neither can be built on.
// Ground creeps follow a flow field (distances to the exit over the 8-connected grid, no diagonal steps past a tower
// corner), rebuilt only when towers change. Flyers ignore towers and fly straight down the lane.
// Combat comes from src/field.js. Creeps that reach the exit are pushed to `arrived` for the match to route on.
// Phase 3 (docs/SPEC-ltw.md): towers have hit points, armour and regeneration from the map; tower builds and upgrades
// need the owner's tech buildings; selling pays the tower's point value; the attackers (h01B, h01I, h01M, ugho, e000)
// attack-move and stop to hit towers (and, where their weapon allows, other players' creeps); creeps carry their auras,
// regeneration, reincarnation, evasion, hardened skin and the Phoenix's death damage; move speed follows the WC3
// gameplay constants (150 to 400).
import { TOWERS, BUILD_ROOTS } from './data/towers.js?v=99dfd38af943';
import { LTW_RULES, LTW_UNITS, LTW_TOWER_STATS, LTW_TECH, LTW_MESSAGES } from './data/ltw.js?v=99dfd38af943';
import { Field, BUILD_TIME, TILE, isAirTarget, typeFactor, armorFactor } from './field.js?v=99dfd38af943';

export const LANE_COLS = LTW_RULES.laneLength;   // u: 44 tiles
export const LANE_ROWS = LTW_RULES.laneWidth;    // v: 9 tiles (the map's are 8: LTW_RULES.mapLaneWidth)
export const SPAWN_U = LTW_RULES.spawnZone;      // u < 2: spawn zone (the map's 'depart')
export const EXIT_U = LTW_RULES.exitZone;        // u >= 42: exit zone (the map's 'arrivee')
const COLS = LANE_COLS, ROWS = LANE_ROWS, N = COLS * ROWS;
export const INF = 0x3fffffff;
const ORTHO = 10, DIAG = 14;                     // octile step costs, so straight runs beat zig-zags
// Neighbour order matters only for ties: straight ahead first.
const NB = [[1, 0], [1, -1], [1, 1], [0, -1], [0, 1], [-1, 0], [-1, -1], [-1, 1]];

export const tileIndex = (c, r) => r * COLS + c;
const clampC = (x) => x < 0 ? 0 : x >= COLS ? COLS - 1 : x | 0;
const clampR = (y) => y < 0 ? 0 : y >= ROWS ? ROWS - 1 : y | 0;
export const tileOf = (k) => clampR(Math.floor(k.y)) * COLS + clampC(Math.floor(k.x));

// Distance (x10) from every tile to the nearest exit tile; INF where blocked or unreachable.
const heap = new Int32Array(N * 8 + 16);
export function flowField(blocked, dist) {
  dist.fill(INF);
  let n = 0;
  const push = (v) => {
    let i = n++;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p] <= v) break; heap[i] = heap[p]; i = p; }
    heap[i] = v;
  };
  const pop = () => {
    const top = heap[0], v = heap[--n];
    let i = 0;
    for (;;) {
      let l = 2 * i + 1; if (l >= n) break;
      if (l + 1 < n && heap[l + 1] < heap[l]) l++;
      if (heap[l] >= v) break;
      heap[i] = heap[l]; i = l;
    }
    heap[i] = v;
    return top;
  };
  for (let r = 0; r < ROWS; r++) for (let c = EXIT_U; c < COLS; c++) {
    const i = r * COLS + c;
    if (!blocked[i]) { dist[i] = 0; push(i); }
  }
  while (n > 0) {
    const key = pop(), i = key % N, d = (key - i) / N;
    if (d > dist[i]) continue;
    const c = i % COLS, r = (i - c) / COLS;
    for (let k = 0; k < 8; k++) {
      const dc = NB[k][0], dr = NB[k][1], nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const j = nr * COLS + nc;
      if (blocked[j]) continue;
      if (dc && dr && (blocked[r * COLS + nc] || blocked[nr * COLS + c])) continue;   // no corner cutting
      const nd = d + (dc && dr ? DIAG : ORTHO);
      if (nd < dist[j]) { dist[j] = nd; push(nd * N + j); }
    }
  }
  return dist;
}

// Distance (x10) from every tile to the nearest of `seeds` (tile indices, free ones only); INF where unreachable. Used by
// attackers walking to a tower or a creep.
export function distanceFrom(blocked, seeds, dist) {
  dist.fill(INF);
  let n = 0;
  const push = (v) => {
    let i = n++;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p] <= v) break; heap[i] = heap[p]; i = p; }
    heap[i] = v;
  };
  const pop = () => {
    const top = heap[0], v = heap[--n];
    let i = 0;
    for (;;) {
      let l = 2 * i + 1; if (l >= n) break;
      if (l + 1 < n && heap[l + 1] < heap[l]) l++;
      if (heap[l] >= v) break;
      heap[i] = heap[l]; i = l;
    }
    heap[i] = v;
    return top;
  };
  for (const i of seeds) if (!blocked[i] && dist[i] !== 0) { dist[i] = 0; push(i); }
  while (n > 0) {
    const key = pop(), i = key % N, d = (key - i) / N;
    if (d > dist[i]) continue;
    const c = i % COLS, r = (i - c) / COLS;
    for (let k = 0; k < 8; k++) {
      const dc = NB[k][0], dr = NB[k][1], nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const j = nr * COLS + nc;
      if (blocked[j]) continue;
      if (dc && dr && (blocked[r * COLS + nc] || blocked[nr * COLS + c])) continue;
      const nd = d + (dc && dr ? DIAG : ORTHO);
      if (nd < dist[j]) { dist[j] = nd; push(nd * N + j); }
    }
  }
  return dist;
}

// ---------- phase 3 helpers (shared with src/match.js and src/bot.js) ----------
export const RESOURCE_MAX = LTW_RULES.resourceMax;   // WC3 engine: gold and lumber never exceed 1,000,000
// Adds gold to a player's state, clamped to the WC3 resource maximum (and to the 0 floor for negative amounts).
export function addGold(p, x) {
  if (!p) return 0;
  const before = p.gold;
  let g = before + x;
  if (x > 0 && g > RESOURCE_MAX) g = Math.max(before, RESOURCE_MAX);
  if (g < LTW_RULES.goldFloor && x < 0) g = LTW_RULES.goldFloor;
  p.gold = g;
  return g - before;
}
export function addLumber(p, x) {
  if (!p) return 0;
  const before = p.lumber;
  let l = before + x;
  if (x > 0 && l > RESOURCE_MAX) l = Math.max(before, RESOURCE_MAX);
  p.lumber = l;
  return l - before;
}
// The tech buildings a tower type requires (units.json 'ureq'), and those of them a player is missing. A player state
// without a tech list (a replica that does not mirror it) is not gated: the host decides.
export const towerRequires = (id) => (LTW_TOWER_STATS[id] && LTW_TOWER_STATS[id].requires) || [];
export function missingTech(player, id) {
  const req = towerRequires(id);
  if (!req.length || !player || !Array.isArray(player.tech)) return [];
  return req.filter(r => !player.tech.includes(r));
}
export const techName = (id) => (LTW_TECH[id] ? LTW_TECH[id].name : id);
export const requiresText = (ids) => `Requires ${ids.map(techName).join(' and ')}.`;
// What a tech building unlocks: the tower types that list it in their requirements.
export const techUnlocks = (id) => (LTW_TECH[id] ? LTW_TECH[id].unlocks.slice() : []);
// Move speed limits (the WC3 gameplay constants MinUnitSpeed / MaxUnitSpeed; the map keeps the stock values).
export const MIN_UNIT_SPEED = LTW_RULES.minSpeed, MAX_UNIT_SPEED = LTW_RULES.maxSpeed;
export const unitSpeed = (s) => Math.min(MAX_UNIT_SPEED, Math.max(MIN_UNIT_SPEED, s));
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
// Distance (tiles) from a point to the 1 x 1 footprint of the tower on tile (c, r).
const boxDist = (x, y, t) => Math.hypot(Math.max(t.c - x, 0, x - (t.c + 1)), Math.max(t.r - y, 0, y - (t.r + 1)));
const hasT = (list, k) => list.includes(k);

// For each tile, the neighbour a creep should head for next (-1 for exit tiles, blocked or unreachable tiles).
function nextTiles(blocked, dist, next) {
  for (let i = 0; i < N; i++) {
    next[i] = -1;
    if (blocked[i] || dist[i] >= INF || dist[i] === 0) continue;
    const c = i % COLS, r = (i - c) / COLS;
    let best = -1, bd = INF;
    for (let k = 0; k < 8; k++) {
      const dc = NB[k][0], dr = NB[k][1], nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const j = nr * COLS + nc;
      if (blocked[j] || dist[j] >= dist[i]) continue;   // only steps that get closer to the exit
      if (dc && dr && (blocked[r * COLS + nc] || blocked[nr * COLS + c])) continue;
      const v = dist[j] + (dc && dr ? DIAG : ORTHO);
      if (v < bd) { bd = v; best = j; }
    }
    next[i] = best;
  }
}

const defaultPlayer = (slot) => ({
  slot, gold: LTW_RULES.startGold, income: LTW_RULES.startIncome, lives: LTW_RULES.startLives,
  lumber: LTW_RULES.startLumber, wisps: LTW_RULES.startWisps, alive: true, tech: [],
});

export class Lane extends Field {
  // player: the owner's state object ({gold, lives, income, alive, tech, ...}), shared with the match.
  // ids: the match's id counter, shared by all its lanes (a standalone lane gets its own).
  constructor({ slot = 1, player = null, rng = Math.random, ids = null } = {}) {
    super({ rng, ids });
    this.mover = this;
    this.slot = slot;
    this.player = player || defaultPlayer(slot);
    this.cols = COLS; this.rows = ROWS;
    this.blocked = new Uint8Array(N);
    this.occupied = new Map();
    this.flow = new Int32Array(N);
    this.next = new Int16Array(N);
    this.flowVersion = 0;
    this.probes = new Map();      // tile -> flow field with that tile blocked, until towers change
    this.chases = new Map();      // attacker goals -> distance field to them, until towers change
    this.arrived = [];            // creeps that reached the exit this step (dead in this lane, routed on by the match)
    this.spawned = [];            // creeps spawned on death this step, added after the death sweep
    this.blasts = [];             // pending death damage (the Phoenix's 'Adda'): { at, x, y, owner, dd }
    this.stats = { kills: 0, leaks: 0, built: 0, destroyed: 0 };
    this.match = null;
    this.rebuildFlow();
  }
  get gold() { return this.player.gold; }
  set gold(v) { this.player.gold = v; }
  get lives() { return this.player.lives; }
  get income() { return this.player.income; }
  get alive() { return this.player.alive !== false; }
  get incomeTimer() { return this.match ? this.match.incomeTimer : 0; }

  // ---------- flow field ----------
  rebuildFlow() {
    flowField(this.blocked, this.flow);
    nextTiles(this.blocked, this.flow, this.next);
    this.flowVersion++;
    this.probes.clear();
    if (this.chases) this.chases.clear();
  }
  towersChanged() { super.towersChanged(); this.rebuildFlow(); }
  // Shortest walking distance (tiles) from the spawn zone to the exit; INF if blocked.
  pathLength() {
    let best = INF;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < SPAWN_U; c++) best = Math.min(best, this.flow[r * COLS + c]);
    return best >= INF ? Infinity : best / ORTHO;
  }
  // The tiles a ground creep standing on (c, r) will walk through, ending in the exit zone.
  route(c, r) {
    const out = [];
    let i = tileIndex(c, r);
    for (let k = 0; k < N && i >= 0; k++) { out.push([i % COLS, (i / COLS) | 0]); if (this.flow[i] === 0) break; i = this.next[i]; }
    return out;
  }

  // ---------- building ----------
  towerAt(c, r) { return this.occupied.get(r * COLS + c) || null; }
  // Why (id) can't be built at (c, r), or null if it can. c = u (along the lane), r = v (across).
  whyNot(id, c, r) {
    const def = TOWERS[id];
    if (!def || !BUILD_ROOTS.includes(id)) return 'Unknown tower.';
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < SPAWN_U || c >= EXIT_U || r < 0 || r >= ROWS) return "Can't build there.";
    if (this.towerAt(c, r)) return "Can't build there.";
    if (!this.alive) return 'You have been eliminated.';
    const miss = missingTech(this.player, id);
    if (miss.length) return requiresText(miss);
    if (this.gold < def.cost) return 'Not enough gold.';
    const i = r * COLS + c;
    for (const k of this.creeps) if (!k.dead && !k.def.flying && tileOf(k) === i) return "Can't build there, a creep is in the way.";
    if (!this.pathOk(i)) return "Can't build there, you must leave a path";
    return null;
  }
  canBuild(id, c, r) { return this.whyNot(id, c, r) === null; }
  // Would blocking tile i still leave a way from the spawn and from every ground creep to the exit?
  pathOk(i) {
    let d = this.probes.get(i);
    if (!d) {
      this.blocked[i] = 1; d = flowField(this.blocked, new Int32Array(N)); this.blocked[i] = 0;
      this.probes.set(i, d);
    }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < SPAWN_U; c++) if (d[r * COLS + c] >= INF) return false;
    for (const k of this.creeps) if (!k.dead && !k.def.flying && d[tileOf(k)] >= INF) return false;
    return true;
  }
  build(id, c, r) {
    if (this.whyNot(id, c, r)) return null;
    const def = TOWERS[id];
    this.gold -= def.cost;
    const hp = towerHp(id);
    const t = { id: this.nextId(), def, c, r, x: c + 0.5, y: r + 0.5, cd: 0, target: null, building: BUILD_TIME, buildTotal: BUILD_TIME,
      kills: 0, spent: def.cost, owner: this.slot, hp, maxHp: hp };
    this.towers.push(t); this.occupied.set(r * COLS + c, t); this.blocked[r * COLS + c] = 1; this.stats.built++;
    this.towersChanged();
    this.emit({ type: 'build', tower: t });
    return t;
  }
  whyNotUpgrade(t, id) {
    if (!this.towers.includes(t)) return 'No such tower.';
    if (!this.alive) return 'You have been eliminated.';
    if (!t.def.upgrades.includes(id)) return "That isn't an upgrade of this tower.";
    const miss = missingTech(this.player, id);
    if (miss.length) return requiresText(miss);
    if (t.building || t.sellAt !== undefined) return 'The tower is busy.';
    if (this.gold < TOWERS[id].cost) return 'Not enough gold.';
    return null;
  }
  canUpgrade(t, id) { return this.whyNotUpgrade(t, id) === null; }
  // An upgrade keeps the tower's share of hit points (a WC3 structure upgrade keeps its life percentage).
  upgrade(t, id) {
    if (this.whyNotUpgrade(t, id)) return false;
    const def = TOWERS[id];
    this.gold -= def.cost; t.def = def; t.spent += def.cost; t.building = BUILD_TIME * 0.75; t.buildTotal = BUILD_TIME * 0.75; t.target = null;
    const max = towerHp(id);
    t.hp = t.maxHp > 0 ? t.hp / t.maxHp * max : max; t.maxHp = max;
    super.towersChanged();
    this.emit({ type: 'upgrade', tower: t });
    return true;
  }
  // The map's 'sell' trigger pays the tower's point value (units.json 'upoi'; the base unit's when the map leaves it
  // blank). The project lead's decision after the phase-1 review; Classic Defense keeps 75% of what was spent.
  // A sale never pays more than the tower cost (adaptation: Poison Well, upoi 250 for 200 spent, would otherwise be an
  // endless gold loop).
  sellValue(t) {
    const s = LTW_TOWER_STATS[t.def.id];
    return s ? Math.min(s.points, t.spent) : Math.floor(t.spent * LTW_RULES.sellRate);
  }
  // Selling takes LTW_RULES.sellDelay (1 s, the map's 'Sell' unit); the tower keeps its tile until then.
  sell(t) {
    if (!this.towers.includes(t) || t.sellAt !== undefined) return false;
    t.sellAt = this.time + LTW_RULES.sellDelay;
    this.emit({ type: 'selling', tower: t, at: t.sellAt });
    return true;
  }
  finishSales() {
    let changed = false;
    for (const t of this.towers) if (t.sellAt !== undefined && this.time >= t.sellAt - 1e-9) {
      t.sold = true; changed = true;
      const gold = this.sellValue(t);
      addGold(this.player, gold);
      this.occupied.delete(t.r * COLS + t.c); this.blocked[t.r * COLS + t.c] = 0;
      this.emit({ type: 'sell', tower: t, gold });
      if (this.match) this.match.message(this.slot, fill(LTW_MESSAGES.sold, { gold, name: t.def.name }));
    }
    if (changed) { this.towers = this.towers.filter(t => !t.sold); this.towersChanged(); }
  }
  // Elimination: every tower goes, with no refund, and so do its missiles still in flight.
  clearTowers() {
    for (const t of this.towers) this.emit({ type: 'remove', tower: t });
    this.towers = []; this.occupied.clear(); this.blocked.fill(0); this.missiles = [];
    this.towersChanged();
  }
  // A tower dies: killed by an attacker or by death damage (`by`: the creep, or null), or by its owner's '-destroy'.
  // No refund; its tile frees up and the flow field is rebuilt. Missiles it already fired fly on. Emits 'destroyed',
  // then 'remove' (what the netcode and renderer already handle for a tower that is gone).
  destroyTower(t, by = null, reason = 'attack') {
    if (!this.towers.includes(t)) return false;
    t.destroyed = true; t.hp = 0; t.target = null;
    this.towers = this.towers.filter(x => x !== t);
    if (this.occupied.get(t.r * COLS + t.c) === t) { this.occupied.delete(t.r * COLS + t.c); this.blocked[t.r * COLS + t.c] = 0; }
    this.stats.destroyed++;
    this.towersChanged();
    this.emit({ type: 'destroyed', tower: t, by, reason });
    this.emit({ type: 'remove', tower: t, reason: 'destroyed' });
    return true;
  }
  // Damage to a tower: the attack type against the tower's armour type and armour (WC3 table and formula).
  // kind 'spell': the spell column of the table and no armour reduction (death damage).
  hitTower(t, amount, attackType, by, kind) {
    if (t.destroyed || !this.towers.includes(t)) return 0;
    const s = LTW_TOWER_STATS[t.def.id] || { armor: 0, armorType: 'fort' };
    const dmg = kind === 'spell' ? amount * typeFactor('spells', s.armorType) : amount * typeFactor(attackType, s.armorType) * armorFactor(s.armor);
    t.hp -= dmg;
    this.emit({ type: 'damaged', tower: t, creep: by, amount: dmg, hp: Math.max(0, t.hp) });
    if (t.hp <= 0) this.destroyTower(t, by, kind === 'spell' ? 'deathDamage' : 'attack');
    return dmg;
  }
  // Towers regenerate (units.json uhpr / uhrt: 1 hit point per second, always).
  regenTowers(dt) {
    for (const t of this.towers) {
      if (!(t.hp < t.maxHp)) continue;
      const s = LTW_TOWER_STATS[t.def.id];
      if (s && s.regen && s.regenType === 'always') t.hp = Math.min(t.maxHp, t.hp + s.regen * dt);
    }
  }

  // ---------- creeps ----------
  // Adds a creep in the spawn zone (random u in the zone, and random v unless given). `from` carries a creep over from
  // another lane with its id, HP and buffs.
  addCreep(def, opts = {}) {
    const c = this.makeCreep(def, opts);
    this.creeps.push(c);
    return c;
  }
  makeCreep(def, { owner = 0, u, v, hp, from = null } = {}) {
    const rng = this.rng;
    const x = u ?? (0.25 + rng() * (SPAWN_U - 0.5));
    const y = v ?? (0.5 + rng() * (ROWS - 1));
    // upgrades researched at the start (the map's Initialisation: Necromancer training for players 1-6) add hit points
    const max = from ? from.maxHp : def.hp + ((def.hpBonus && def.hpBonus[String(owner)]) || 0);
    const c = {
      id: from ? from.id : this.nextId(), def, owner, hp: hp ?? (from ? from.hp : max), maxHp: max,
      dist: 0, lane: (rng() - 0.5) * 0.5, x, y, dirx: 1, diry: 0,
      slowPct: from ? from.slowPct : 0, slowUntil: from ? from.slowUntil : 0, auraSlow: 0,
      poisons: from ? from.poisons.slice() : [], stunUntil: from ? from.stunUntil : 0, dead: false,
      walk: from ? from.walk : rng() * 10,
    };
    if (from && from.rebornReady !== undefined) c.rebornReady = from.rebornReady;
    return c;
  }
  // Removes the creeps of one owner (elimination, leavers): no bounty, no death effects, no hatchlings.
  removeOwned(owner) {
    let n = 0;
    for (const c of this.creeps) if (c.owner === owner && !c.dead) {
      c.dead = true; c.counted = true; c.removed = true; c.reviving = false; n++;
      this.emit({ type: 'remove', creep: c });
    }
    if (n) this.creeps = this.creeps.filter(c => !c.dead);
    this.blasts = this.blasts.filter(b => b.owner !== owner);
    return n;
  }
  // The map's Creep Fix: kill every ground creep in the lane, with no bounty and no life change. 'Ground' is the
  // map's IsUnitType(UNIT_TYPE_GROUND), which follows Targeted As: the Phoenix h01M flies but is killed too.
  creepFix() {
    let n = 0;
    for (const c of this.creeps) if (!c.dead && !isAirTarget(c.def)) {
      c.dead = true; c.counted = true; c.fixed = true; c.reviving = false; n++;
      this.emit({ type: 'death', creep: c, gold: 0, fix: true });
      this.onDeath(c);
    }
    if (n) this.creeps = this.creeps.filter(c => !c.dead);
    this.flushSpawns();
    return n;
  }
  // On death: the Hydra spawns its hatchlings where it died, owned by the same player; the Phoenix's death damage
  // ('Adda') goes off after its delay.
  onDeath(c) {
    const dd = c.def.deathDamage;
    if (dd) this.blasts.push({ at: this.time + dd.delay, x: c.x, y: c.y, owner: c.owner, dd, creep: c });
    const od = c.def.onDeath;
    if (!od) return;
    const def = LTW_UNITS[od.spawn];
    for (let k = 0; k < od.count; k++) {
      const h = this.makeCreep(def, { owner: c.owner, u: c.x, v: c.y });
      this.spawned.push(h);
      this.emit({ type: 'spawn', creep: h, from: c });
    }
  }
  flushSpawns() { if (this.spawned.length) { for (const h of this.spawned) this.creeps.push(h); this.spawned = []; } }
  // Death damage (Adda): full damage within the full radius, partial damage out to the partial radius, to enemy
  // structures (the lane's towers) and enemy ground units (other players' creeps). Spell damage: the spell column of the
  // damage table, no armour reduction. Distances to a tower are to its footprint.
  blast(b) {
    const { dd } = b, R = dd.partialRadius / TILE, F = dd.fullRadius / TILE, tg = dd.targets;
    this.emit({ type: 'blast', x: b.x, y: b.y, owner: b.owner, radius: dd.partialRadius, creep: b.creep });
    if (hasT(tg, 'structure') && b.owner !== this.slot) {
      for (const t of this.towers.slice()) {
        const d = boxDist(b.x, b.y, t);
        if (d <= R) this.hitTower(t, d <= F ? dd.full : dd.partial, null, b.creep, 'spell');
      }
    }
    if (hasT(tg, 'ground')) {
      for (const c of this.creeps) {
        if (c.dead || c.reviving || c.owner === b.owner || isAirTarget(c.def)) continue;
        const d = Math.hypot(c.x - b.x, c.y - b.y);
        if (d > R) continue;
        const dmg = (d <= F ? dd.full : dd.partial) * typeFactor('spells', c.def.armorType);
        this.hurt(c, dmg, b.owner, null);
      }
    }
  }
  // Creep-on-creep damage (an attacker's strike, death damage): the kill pays the dealer's owner. Emits 'hurt'
  // { creep (the victim), by (the attacking creep, or null for death damage), owner (the dealer's slot), amount, hp }.
  hurt(c, dmg, owner, by) {
    if (c.dead || c.reviving) return;
    c.hp -= dmg;
    this.emit({ type: 'hurt', creep: c, by, owner, amount: dmg, hp: Math.max(0, c.hp) });
    if (c.hp <= 0) { c.dead = true; c.killer = null; c.killerOwner = owner; }
  }

  // ---------- field hooks ----------
  arrive(c) {
    c.dead = true; c.leaked = true; this.stats.leaks++;
    this.arrived.push(c);
    this.emit({ type: 'leak', creep: c });
  }
  // A tower kill pays the lane owner the bounty; an eliminated owner collects nothing (a poison carried in from another
  // lane can still kill creeps in their empty lane). A creep killed by another player's creep pays that player
  // (WC3 pays the killer's owner). WC3 bounty: the base plus `bountyDice` rolls of 1..`bountySides` (units.json
  // ubba / ubdi / ubsi, or the stock values). Gold is capped at the WC3 resource maximum.
  kill(c) {
    const to = c.killerOwner ?? this.slot;
    const p = to === this.slot ? this.player : (this.match ? this.match.players[to] : null);
    const d = c.def, dice = d.bountySides > 0 ? d.bountyDice || 0 : 0;
    const gold = p && p.alive !== false ? d.bounty + this.roll(dice, d.bountySides) : 0;
    if (gold) addGold(p, gold);
    if (to === this.slot) { this.stats.kills++; if (c.killer) c.killer.kills++; }
    this.emit({ type: 'death', creep: c, gold, to });
    this.onDeath(c);
  }
  // Reincarnation (ACrn): a dying creep whose reincarnation is ready does not die; it lies there for the delay and
  // comes back with full hit points, and its cooldown starts. A creep killed by the Creep Fix or removed does not.
  collect() {
    for (const c of this.creeps) {
      if (c.dead && !c.counted && !c.leaked && c.def.reincarnation && this.time + 1e-9 >= (c.rebornReady ?? -Infinity)) this.reincarnate(c);
    }
    super.collect();
    this.flushSpawns();
  }
  reincarnate(c) {
    const r = c.def.reincarnation;
    c.dead = false; c.hp = 0; c.reviving = true; c.reviveAt = this.time + r.delay; c.rebornReady = this.time + r.cooldown;
    c.poisons = []; c.slowUntil = 0; c.slowPct = 0; c.stunUntil = 0; c.killer = null; c.killerOwner = undefined;
    c.target = null; c.swing = null; c.attacking = null;
    this.emit({ type: 'reincarnate', creep: c, at: c.reviveAt });
  }
  revive() {
    for (const c of this.creeps) if (c.reviving && this.time + 1e-9 >= c.reviveAt) {
      c.reviving = false; c.hp = c.maxHp;
      this.emit({ type: 'reborn', creep: c });
    }
  }
  // Towers never shoot a reincarnating creep; missiles already flying at it do nothing.
  canHit(t, c) { return !c.reviving && super.canHit(t, c); }
  onHit(t, c) { if (!c.reviving) super.onHit(t, c); }
  // Attack damage: the WC3 table and armour formula as in field.js, then hardened skin (e000's stock Assk: attacks lose
  // `ignore` damage, down to `min`). The killing blow decides who is paid.
  damage(t, c, amount, kind) {
    if (c.dead || c.reviving) return;
    let dmg = amount;
    if (kind !== 'spell') {
      dmg *= typeFactor(t.def.attackType, c.def.armorType) * armorFactor(c.def.armor);
      dmg = skin(c, dmg, this.rng);
    }
    c.hp -= dmg;
    if (c.hp <= 0) { c.dead = true; c.killer = t; c.killerOwner = undefined; }
  }

  // ---------- creep auras, speed and regeneration ----------
  // Tower auras come from field.js. Creep auras (Endurance, Unholy, Regeneration, Command) affect the creeps in range
  // their targets allow: 'friend'/'self' means the source owner's own units (players are not allied), no alliance flag
  // means everyone; 'organic' skips mechanical units. The same aura does not stack, and movement bonuses do not stack
  // either (MoveSpeedBonusesStack=0); invisible units bestow no auras (InvisibleUnitsBestowAuras=0), so the Ice Wyrm's
  // never apply. Dead and reincarnating creeps neither give nor take auras.
  auras() {
    super.auras();
    const list = this.creeps;
    let groups = null;
    for (const s of list) {
      s.moveBonus = 0; s.atkBonus = 0; s.dmgBonus = 0; s.regenBonus = 0; s.regenPct = 0;
      if (s.dead || s.reviving || !s.def.auras) continue;
      if (s.def.invisible && !LTW_RULES.invisibleBestowAuras) continue;
      for (const a of s.def.auras) {
        const f = auraFlags(a), key = f.friendly ? a.id + ':' + s.owner : a.id;
        groups ??= new Map();
        let g = groups.get(key);
        if (!g) { g = { a, f, owner: f.friendly ? s.owner : null, pts: [] }; groups.set(key, g); }
        g.pts.push(s.x, s.y);
      }
    }
    if (!groups) return;
    const stack = LTW_RULES.moveBonusesStack;
    for (const g of groups.values()) {
      const { a, f } = g, R = f.R, R2 = R * R, pts = g.pts, m = pts.length >> 1;
      // sources sorted by x, so each creep checks only those within R along the lane
      const xs = new Float64Array(m), ys = new Float64Array(m), idx = Array.from({ length: m }, (_, i) => i).sort((i, j) => pts[2 * i] - pts[2 * j]);
      for (let k = 0; k < m; k++) { xs[k] = pts[2 * idx[k]]; ys[k] = pts[2 * idx[k] + 1]; }
      for (const c of list) {
        if (c.dead || c.reviving) continue;
        if (g.owner !== null && c.owner !== g.owner) continue;
        if (f.organic && c.def.mechanical) continue;
        if (isAirTarget(c.def) ? !f.air : !f.ground) continue;
        const x0 = c.x - R;
        let lo = 0, hi = m;
        while (lo < hi) { const q = (lo + hi) >> 1; if (xs[q] < x0) lo = q + 1; else hi = q; }
        let hit = false;
        for (let k = lo; k < m && xs[k] <= c.x + R; k++) { const dx = xs[k] - c.x, dy = ys[k] - c.y; if (dx * dx + dy * dy <= R2) { hit = true; break; } }
        if (!hit) continue;
        if (a.move) c.moveBonus = stack ? c.moveBonus + a.move : Math.max(c.moveBonus, a.move);
        if (a.attack) c.atkBonus = Math.max(c.atkBonus, a.attack);
        if (a.damage) c.dmgBonus = Math.max(c.dmgBonus, a.damage);
        if (a.regen) c.regenBonus = Math.max(c.regenBonus, a.regen);
        if (a.regenPct) c.regenPct = Math.max(c.regenPct, a.regenPct);
      }
    }
  }
  // Movement speed: the base speed with aura bonuses and slows, kept between the gameplay constants MinUnitSpeed and
  // MaxUnitSpeed (150 and 400: the map does not change them, so 522-speed units run at 400 and the Mountain Giant's 5
  // becomes 150).
  speedOf(c) {
    if (c.stunUntil > this.time || !(c.def.speed > 0)) return 0;   // a unit with no move speed never moves
    let slow = c.slowUntil > this.time ? c.slowPct : 0;
    if (c.auraSlow > slow) slow = c.auraSlow;
    for (const p of c.poisons) { const v = p.slow || 0; if (v > slow) slow = v; }
    return unitSpeed(c.def.speed * (1 + (c.moveBonus || 0) - slow / 100));
  }
  // Regeneration: the unit's own (uhpr when its regeneration type is 'always'; 'blight' needs blight, which the lanes
  // never have, and 'night' is not modelled), plus Unholy Aura and Regeneration Aura.
  tickBuffs(c, dt) {
    if (c.reviving) return;
    super.tickBuffs(c, dt);
    if (c.dead) return;
    const r = c.def.regen;
    const hps = (r && r.type === 'always' ? r.hp : 0) + (c.regenBonus || 0) + (c.regenPct || 0) * c.maxHp;
    if (hps > 0 && c.hp < c.maxHp) c.hp = Math.min(c.maxHp, c.hp + hps * dt);
    else if (hps < 0) { c.hp += hps * dt; if (c.hp <= 0) c.dead = true; }
  }

  // ---------- attackers ----------
  // The region triggers give the attackers an 'attack' order to the lane's exit (attack-move): they walk their route,
  // acquire the nearest enemy target their weapon allows within acquisition range (towers; other players' creeps for a
  // weapon that targets ground or air units), walk up to it, stop and hit it with their weapon (cooldown, damage point,
  // dice, attack type against armour type), and walk on when it is gone. Idle creeps (a leaver's lane) take no orders.
  move(c, dt) {
    if (c.reviving) return;
    if (!c.def.weapon || c.idle) { super.move(c, dt); return; }
    this.fight(c, dt);
  }
  fight(c, dt) {
    const w = c.def.weapon;
    c.cd = (c.cd ?? 0) - dt;
    if (c.swing && c.stunUntil > this.time) c.swing = null;   // a stun interrupts the swing
    if (c.swing && this.time + 1e-9 >= c.swing.at) { const s = c.swing; c.swing = null; this.strike(c, s.target, s.dmg); }
    if (c.ignoreV !== this.flowVersion) { c.ignore = null; c.ignoreV = this.flowVersion; }
    let T = c.target;
    if (T && !this.validTarget(c, T, true)) T = c.target = null;
    if (!T) T = c.target = this.acquire(c);
    if (!T) { c.attacking = null; super.move(c, dt); return; }
    if (this.inReach(c, T)) {
      c.attacking = T; c.speedNow = 0;
      const tx = T.def.upgrades ? Math.max(T.c, Math.min(T.c + 1, c.x)) : T.x, ty = T.def.upgrades ? Math.max(T.r, Math.min(T.r + 1, c.y)) : T.y;
      const d = Math.hypot(tx - c.x, ty - c.y);
      if (d > 1e-9) { c.dirx = (tx - c.x) / d; c.diry = (ty - c.y) / d; }
      if (c.cd <= 0 && !c.swing && !(c.stunUntil > this.time)) {
        c.cd = w.cooldown / (1 + (c.atkBonus || 0));
        const dmg = (w.dmgBase + this.roll(w.dice, w.sides)) * (1 + (c.dmgBonus || 0));
        c.swing = { at: this.time + (w.damagePoint || 0) / (1 + (c.atkBonus || 0)), target: T, dmg };
        c.firedAt = this.time;
        this.emit({ type: 'attack', creep: c, target: T, tower: T.def.upgrades ? T : null });
      }
      return;
    }
    c.attacking = null;
    if (c.swing) return;   // finishing the swing
    this.chase(c, T, dt);
  }
  // Can creep c attack T at all (alive, an enemy, a target type its weapon allows, visible)? `held` keeps a creep
  // target it is already chasing until it gets out of acquisition range.
  validTarget(c, T, held = false) {
    const w = c.def.weapon;
    if (T.def.upgrades) {
      return !T.destroyed && !T.sold && this.occupied.get(T.r * COLS + T.c) === T && this.slot !== c.owner && hasT(w.targets, 'structure')
        && !(c.ignore && c.ignore.has(T.id));
    }
    if (T.dead || T.reviving || T.owner === c.owner) return false;
    if (isAirTarget(T.def) ? !hasT(w.targets, 'air') : !hasT(w.targets, 'ground')) return false;
    if (T.def.invisible) return false;   // the attacker's owner has no detection here
    if (c.ignore && c.ignore.has(-T.id)) return false;
    if (held && Math.hypot(T.x - c.x, T.y - c.y) * TILE > w.acquire) return false;
    return true;
  }
  // The nearest valid target within acquisition range: towers measured to their footprint, creeps to their centre.
  acquire(c) {
    const w = c.def.weapon, R = w.acquire / TILE;
    let best = null, bd = Infinity;
    if (hasT(w.targets, 'structure') && this.slot !== c.owner && this.towers.length) {
      const c0 = Math.max(0, Math.floor(c.x - R) - 1), c1 = Math.min(COLS - 1, Math.floor(c.x + R) + 1);
      const r0 = Math.max(0, Math.floor(c.y - R) - 1), r1 = Math.min(ROWS - 1, Math.floor(c.y + R) + 1);
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
        const t = this.occupied.get(r * COLS + cc);
        if (!t || (c.ignore && c.ignore.has(t.id))) continue;
        const d = boxDist(c.x, c.y, t);
        if (d <= R && (d < bd || (d === bd && t.id < best.id))) { best = t; bd = d; }
      }
    }
    if (hasT(w.targets, 'ground') || hasT(w.targets, 'air')) {
      for (const k of this.creeps) {
        if (k === c || !this.validTarget(c, k)) continue;
        const d = Math.hypot(k.x - c.x, k.y - c.y);
        if (d <= R && (d < bd || (d === bd && best && k.id < best.id))) { best = k; bd = d; }
      }
    }
    return best;
  }
  // Weapon range: to a tower's footprint, or to a creep's centre.
  inReach(c, T) {
    const r = c.def.weapon.range / TILE;
    return (T.def.upgrades ? boxDist(c.x, c.y, T) : Math.hypot(T.x - c.x, T.y - c.y)) <= r + 1e-9;
  }
  // The damage point: the blow lands on a target that is still there.
  strike(c, T, dmg) {
    if (c.dead || c.reviving) return;
    const w = c.def.weapon;
    if (T.def.upgrades) { this.hitTower(T, dmg, w.attackType, c); return; }
    if (T.dead || T.reviving) return;
    if (T.def.evasion && this.rng() < (T.def.evade ?? 0.1)) { this.emit({ type: 'evade', creep: T, by: c }); return; }
    this.hurt(T, skin(T, dmg * typeFactor(w.attackType, T.def.armorType) * armorFactor(T.def.armor), this.rng), c.owner, c);
  }
  // Walking up to a target: flyers fly straight at it; ground attackers follow a distance field to the free tiles next
  // to the tower (or to the creep's tile), then step straight toward it. An unreachable target is dropped until towers
  // change.
  chase(c, T, dt) {
    const speed = this.speedOf(c);
    if (c.speedNow !== undefined) c.walk += dt * speed / 60;
    c.speedNow = speed;
    let left = speed / TILE * dt;
    const goal = () => T.def.upgrades ? [Math.max(T.c, Math.min(T.c + 1, c.x)), Math.max(T.r, Math.min(T.r + 1, c.y))] : [T.x, T.y];
    const reach = c.def.weapon.range / TILE;
    if (c.def.flying) {
      const [gx, gy] = goal(), dx = gx - c.x, dy = gy - c.y, d = Math.hypot(dx, dy), go = Math.min(left, Math.max(0, d - reach + 1e-6));
      if (d > 1e-9) { c.dirx = dx / d; c.diry = dy / d; c.x += c.dirx * go; c.y += c.diry * go; c.dist += go; }
      return;
    }
    const field = this.chaseField(T);
    for (let k = 0; k < 4 && left > 1e-9 && !this.inReach(c, T); k++) {
      const tc = clampC(Math.floor(c.x)), tr = clampR(Math.floor(c.y)), i = tr * COLS + tc;
      if (field[i] >= INF) { (c.ignore ??= new Set()).add(T.def.upgrades ? T.id : -T.id); c.target = null; return; }
      let tx, ty;
      if (field[i] === 0) {
        [tx, ty] = goal();
        const d = Math.hypot(tx - c.x, ty - c.y), go = Math.min(left, Math.max(0, d - reach + 1e-6));
        if (d < 1e-9 || go <= 0) break;
        const nx = c.x + (tx - c.x) / d * go, ny = c.y + (ty - c.y) / d * go;
        if (this.blocked[clampR(Math.floor(ny)) * COLS + clampC(Math.floor(nx))]) break;   // never step into a tower
        c.dirx = (tx - c.x) / d; c.diry = (ty - c.y) / d; c.x = nx; c.y = ny; c.dist += go; left -= go;
        continue;
      }
      let best = -1, bd = field[i];
      for (let q = 0; q < 8; q++) {
        const dc = NB[q][0], dr = NB[q][1], nc = tc + dc, nr = tr + dr;
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
        const j = nr * COLS + nc;
        if (this.blocked[j] || field[j] >= bd) continue;
        if (dc && dr && (this.blocked[tr * COLS + nc] || this.blocked[nr * COLS + tc])) continue;
        bd = field[j]; best = j;
      }
      if (best < 0) break;
      tx = best % COLS + 0.5; ty = Math.floor(best / COLS) + 0.5;
      const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
      if (d < 1e-9) break;
      c.dirx = dx / d; c.diry = dy / d;
      const go = Math.min(d, left);
      c.x += c.dirx * go; c.y += c.diry * go; c.dist += go; left -= go;
    }
  }
  // Distance field to the free tiles from which a target can be hit: the 8 tiles around a tower, or a creep's tile.
  chaseField(T) {
    const key = T.def.upgrades ? 't' + T.id : 'c' + tileOf(T);
    let f = this.chases.get(key);
    if (f) return f;
    const seeds = [];
    if (T.def.upgrades) {
      for (const [dc, dr] of NB) { const nc = T.c + dc, nr = T.r + dr; if (nc >= 0 && nr >= 0 && nc < COLS && nr < ROWS) seeds.push(nr * COLS + nc); }
    } else seeds.push(tileOf(T));
    f = distanceFrom(this.blocked, seeds, new Int32Array(N));
    if (this.chases.size > 64) this.chases.clear();
    this.chases.set(key, f);
    return f;
  }

  // Mover: flyers go straight down the lane; ground creeps head for the next tile of the flow field, offset sideways
  // by their own `lane` value so they spread across the tile.
  advance(c, step) {
    c.dist += step;
    if (c.def.flying) {
      c.x += step; c.dirx = 1; c.diry = 0;
      return c.x >= EXIT_U;
    }
    let left = step;
    for (let k = 0; k < 4 && left > 1e-9; k++) {
      const tc = clampC(Math.floor(c.x)), tr = clampR(Math.floor(c.y));
      if (tc >= EXIT_U) return true;
      const i = tr * COLS + tc;
      let n = this.next[i];
      if (n < 0 && this.blocked[i]) n = this.escape(tc, tr);   // safety net: never stay inside a tower
      let tx, ty;
      if (n < 0) { tx = EXIT_U + 0.5; ty = c.y; }
      else {
        const nc = n % COLS, nr = (n - nc) / COLS, dc = nc - tc, dr = nr - tr, s = dc && dr ? Math.SQRT1_2 : 1;
        tx = nc + 0.5 - dr * s * c.lane; ty = nr + 0.5 + dc * s * c.lane;
      }
      const dx = tx - c.x, dy = ty - c.y, d = Math.hypot(dx, dy);
      if (d < 1e-9) break;
      c.dirx = dx / d; c.diry = dy / d;
      if (d <= left) { c.x = tx; c.y = ty; left -= d; }
      else { c.x += c.dirx * left; c.y += c.diry * left; left = 0; }
    }
    return c.x >= EXIT_U;
  }
  escape(tc, tr) {
    let best = -1, bd = INF;
    for (const [dc, dr] of NB) {
      const nc = tc + dc, nr = tr + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const j = nr * COLS + nc;
      if (!this.blocked[j] && this.flow[j] < bd) { bd = this.flow[j]; best = j; }
    }
    return best;
  }

  // ---------- simulation ----------
  // `now` lets a match keep every lane on its exact clock; standalone lanes just add dt.
  step(dt, now) {
    this.time = now !== undefined ? now : this.time + dt;
    this.revive();
    if (this.blasts.length) {
      const due = this.blasts.filter(b => b.at <= this.time + 1e-9);
      if (due.length) { this.blasts = this.blasts.filter(b => b.at > this.time + 1e-9); for (const b of due) this.blast(b); this.collect(); }
    }
    this.finishSales();
    this.combat(dt);
    this.regenTowers(dt);
  }
}

// An aura's target flags, worked out once per aura record: 'friend' / 'self' / 'player' mean the source owner's units
// (players are not allied), no alliance flag means everyone.
const AURA_FLAGS = new Map();
function auraFlags(a) {
  let f = AURA_FLAGS.get(a);
  if (!f) {
    const t = a.targets;
    f = { friendly: t.includes('friend') || t.includes('self') || t.includes('player'), air: t.includes('air'), ground: t.includes('ground'),
      organic: t.includes('organic'), R: a.range / TILE };
    AURA_FLAGS.set(a, f);
  }
  return f;
}
// Hit points of a tower type (units.json uhpm, or the base unit's).
function towerHp(id) { const s = LTW_TOWER_STATS[id]; return s ? s.hp : 100; }
// Hardened skin (e000's stock Assk): an attack loses `ignore` damage but never drops below `min` (and is never raised).
function skin(c, dmg, rng) {
  const hs = c.def.hardenedSkin;
  if (!hs || dmg <= hs.min) return dmg;
  if (hs.chance < 1 && !(rng() < hs.chance)) return dmg;
  return Math.max(hs.min, dmg - hs.ignore);
}
