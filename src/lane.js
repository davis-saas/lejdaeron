// One player's Line Tower Wars lane: a straight open field of 8 x 44 tiles that the owner mazes with towers.
// Coordinates: u (x) runs along the lane from the spawn (u = 0) to the exit (u = 44), v (y) runs across it (0 to 8).
// Tiles with u < 2 are the spawn zone and tiles with u >= 42 the exit zone; neither can be built on.
// Ground creeps follow a flow field (distances to the exit over the 8-connected grid, no diagonal steps past a tower
// corner), rebuilt only when towers change. Flyers ignore towers and fly straight down the lane.
// Combat comes from src/field.js. Creeps that reach the exit are pushed to `arrived` for the match to route on.
import { TOWERS, BUILD_ROOTS } from './data/towers.js';
import { LTW_RULES, LTW_UNITS } from './data/ltw.js';
import { Field, nextId, BUILD_TIME } from './field.js';

export const LANE_COLS = LTW_RULES.laneLength;   // u: 44 tiles
export const LANE_ROWS = LTW_RULES.laneWidth;    // v: 8 tiles
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
  lumber: LTW_RULES.startLumber, wisps: LTW_RULES.startWisps, alive: true,
});

export class Lane extends Field {
  // player: the owner's state object ({gold, lives, income, alive, ...}), shared with the match.
  constructor({ slot = 1, player = null, rng = Math.random } = {}) {
    super({ rng });
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
    this.arrived = [];            // creeps that reached the exit this step (dead in this lane, routed on by the match)
    this.spawned = [];            // creeps spawned on death this step, added after the death sweep
    this.stats = { kills: 0, leaks: 0, built: 0 };
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
    const t = { id: nextId(), def, c, r, x: c + 0.5, y: r + 0.5, cd: 0, target: null, building: BUILD_TIME, buildTotal: BUILD_TIME,
      kills: 0, spent: def.cost, owner: this.slot };
    this.towers.push(t); this.occupied.set(r * COLS + c, t); this.blocked[r * COLS + c] = 1; this.stats.built++;
    this.towersChanged();
    this.emit({ type: 'build', tower: t });
    return t;
  }
  whyNotUpgrade(t, id) {
    if (!this.towers.includes(t)) return 'No such tower.';
    if (!this.alive) return 'You have been eliminated.';
    if (!t.def.upgrades.includes(id)) return "That isn't an upgrade of this tower.";
    if (t.building || t.sellAt !== undefined) return 'The tower is busy.';
    if (this.gold < TOWERS[id].cost) return 'Not enough gold.';
    return null;
  }
  canUpgrade(t, id) { return this.whyNotUpgrade(t, id) === null; }
  upgrade(t, id) {
    if (this.whyNotUpgrade(t, id)) return false;
    const def = TOWERS[id];
    this.gold -= def.cost; t.def = def; t.spent += def.cost; t.building = BUILD_TIME * 0.75; t.buildTotal = BUILD_TIME * 0.75; t.target = null;
    super.towersChanged();
    this.emit({ type: 'upgrade', tower: t });
    return true;
  }
  sellValue(t) { return Math.floor(t.spent * LTW_RULES.sellRate); }
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
      this.gold += gold;
      this.occupied.delete(t.r * COLS + t.c); this.blocked[t.r * COLS + t.c] = 0;
      this.emit({ type: 'sell', tower: t, gold });
    }
    if (changed) { this.towers = this.towers.filter(t => !t.sold); this.towersChanged(); }
  }
  // Elimination: every tower goes, with no refund.
  clearTowers() {
    for (const t of this.towers) this.emit({ type: 'remove', tower: t });
    this.towers = []; this.occupied.clear(); this.blocked.fill(0);
    this.towersChanged();
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
    const c = {
      id: from ? from.id : nextId(), def, owner, hp: hp ?? (from ? from.hp : def.hp), maxHp: from ? from.maxHp : def.hp,
      dist: 0, lane: (rng() - 0.5) * 0.5, x, y, dirx: 1, diry: 0,
      slowPct: from ? from.slowPct : 0, slowUntil: from ? from.slowUntil : 0, auraSlow: 0,
      poisons: from ? from.poisons.slice() : [], stunUntil: from ? from.stunUntil : 0, dead: false,
      walk: from ? from.walk : rng() * 10,
    };
    return c;
  }
  // Removes the creeps of one owner (elimination, leavers): no bounty, no death effects, no hatchlings.
  removeOwned(owner) {
    let n = 0;
    for (const c of this.creeps) if (c.owner === owner && !c.dead) {
      c.dead = true; c.counted = true; c.removed = true; n++;
      this.emit({ type: 'remove', creep: c });
    }
    if (n) this.creeps = this.creeps.filter(c => !c.dead);
    return n;
  }
  // The map's Creep Fix: kill every ground creep in the lane, with no bounty and no life change.
  creepFix() {
    let n = 0;
    for (const c of this.creeps) if (!c.dead && !c.def.flying) {
      c.dead = true; c.counted = true; c.fixed = true; n++;
      this.emit({ type: 'death', creep: c, gold: 0, fix: true });
      this.onDeath(c);
    }
    if (n) this.creeps = this.creeps.filter(c => !c.dead);
    this.flushSpawns();
    return n;
  }
  // Hydra: spawn its hatchlings where it died, owned by the same player.
  onDeath(c) {
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

  // ---------- field hooks ----------
  arrive(c) {
    c.dead = true; c.leaked = true; this.stats.leaks++;
    this.arrived.push(c);
    this.emit({ type: 'leak', creep: c });
  }
  kill(c) {
    const gold = c.def.bounty;
    this.gold += gold; this.stats.kills++; if (c.killer) c.killer.kills++;
    this.emit({ type: 'death', creep: c, gold });
    this.onDeath(c);
  }
  collect() { super.collect(); this.flushSpawns(); }

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
    this.finishSales();
    this.combat(dt);
  }
}
