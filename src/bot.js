// Line Tower Wars computer players. new Bot(match, slot, difficulty) plays one slot of a src/match.js Match; call
// bot.tick(dt) after every match.step(dt). A bot only reads state (its own lane, the lanes next to it in the ring and
// the leaderboard: lives and income) and acts only through match.command, exactly like a human at the console.
//
// How it plays:
// - Maze. It builds a serpentine of tower walls across its lane. Walls are candidates scored by how much they lengthen
//   the creep path (a flow-field probe with the wall's missing tiles blocked) per tower still needed, so it finishes
//   the wall that pays off most and never closes the path.
// - Defence. Every tower, upgrade and replacement is scored by the damage it adds per pass against the creeps the bot
//   expects (what it has seen in its lane plus what the player feeding it can afford), weighted toward the creep types
//   it is weakest against: air, magic immune, Divine armour (chaos damage) and invisible creeps (true sight). Upgrades
//   look ahead through the build tree, so it saves for strong lines instead of stopping at cheap tiers. Selling is rare:
//   only to swap a cheap maze tower for a stronger line late in the game, when no creep is near.
// - Sending. Gold is split between defence and sending by how threatened the lane is. Sends are scored by income
//   payback (the map's per-slot income value against cost and the bounty the target collects) and by how many creeps
//   would get through the target's defence; stronger bots save up for one big send of the unit the next opponent is
//   weakest against and time it away from that lane's Creep Fix. Sends that lower income are only used far ahead.
// - Technology (phase 3). Wisps go into tech buildings at once: hard and insane bots plan the set of buildings whose
//   Elemental lines are worth most against the strong late creeps (tier 2 with its tier 1, two elements deep), normal
//   bots take the best building one at a time, easy bots pick at random. Upgrades and swaps only look at towers whose
//   requirements the bot owns. Rich hard and insane bots also train an Arcade wisp when a building still adds value.
// - Lumber (phase 3). Far ahead, hard and insane bots buy the Arcade's lumber for a lumber send the next opponent cannot
//   kill, then send it. Towers that attackers destroy leave holes in the maze walls, which the wall logic rebuilds.
// - The build phase (docs/SPEC-ltw.md). The bot thinks as usual (its decisions follow match.time), puts all its gold
//   into the maze and raises its tech, and sends nothing until the shrines open. Shop unlocks, Creep Fix and the late
//   game are read on the map's clock (match.playTime).
// - Difficulty sets the reaction delay, how often it thinks, how noisy and short-sighted its choices are, the maze it
//   aims for, how much it saves and how aggressive it is. Decisions run a few times per second on cached evaluations
//   (flow probes and coverage are recomputed only when towers change), so ten bots fit in a browser frame budget.
import { TOWERS, BUILD_ROOTS } from './data/towers.js?v=3947ef6d39d3';
import { LTW_UNITS, LTW_SHOPS, LTW_RULES, LTW_CREEP_FIX, LTW_TECH, LTW_TECH_ORDER, LTW_TOWER_STATS, LTW_ARCADE } from './data/ltw.js?v=3947ef6d39d3';
import { typeFactor, armorFactor, avgDamage, TILE } from './field.js?v=3947ef6d39d3';
import { flowField, INF, LANE_COLS, LANE_ROWS, SPAWN_U, EXIT_U, tileOf, unitSpeed, RESOURCE_MAX } from './lane.js?v=3947ef6d39d3';
import { mulberry32 } from './rng.js?v=3947ef6d39d3';

const COLS = LANE_COLS, ROWS = LANE_ROWS, N = COLS * ROWS;
const SOLD = LTW_SHOPS.flatMap(s => s.units);
const UNIT_IDS = [...SOLD, ...Object.keys(LTW_UNITS).filter(id => !SOLD.includes(id))];   // the 36 sold + hatchlings
const UNITS = UNIT_IDS.map(id => LTW_UNITS[id]);
const NU = UNITS.length;
const UIDX = Object.fromEntries(UNIT_IDS.map((id, i) => [id, i]));
export const UNIT_INDEX = UIDX;
const DEF_IDS = Object.keys(TOWERS);
const DIDX = Object.fromEntries(DEF_IDS.map((id, i) => [id, i]));
const ARCHER = BUILD_ROOTS.find(id => TOWERS[id].name.startsWith('Archer')) || BUILD_ROOTS[0];
const ELEMENTAL = BUILD_ROOTS.find(id => TOWERS[id].name.startsWith('Elemental')) || ARCHER;
const SIGHT_R = (() => { const r = DEF_IDS.map(id => TOWERS[id].trueSight || 0).filter(Boolean); return (r.length ? Math.max(...r) : 900) / TILE; })();
const TT = UNITS.map(u => TILE / Math.max(1, unitSpeed(u.speed)));   // seconds a creep needs per tile (WC3 speed limits)
const FIX = LTW_CREEP_FIX.periods;

// ---------------------------------------------------------------------------------------------------- difficulty
// think       seconds between decisions (jittered +-25%)          lag        seconds before a new creep is noticed
// noise       log-normal error on every score                     pick       picks one of the best `pick` options
// depth       build-tree lookahead for upgrades                   maze       wall template ('serpentine' or 'loose')
// eslots      Elemental slot by each wall's gap                    mazeShare  extra weight on finishing the maze
// defBase/defGain/defMin   defence share of income, how fast threat raises it, and its floor
// forecast    ticks of the feeder's income it prepares for         panic      share of send money moved on danger
// leakShare/leakMemory     defence share for `leakMemory` seconds after losing a life
// horizon     ticks of income a send is valued over               roiMin     lowest payback ratio it sends at
// burst       saves for big sends that push `leakGoal` creeps through, for up to `saveTicks` ticks of income
// weak        reads the next opponent's defence to pick units      prior      weight of what the feeder can afford
// foresight   seconds ahead it expects new shop units               afford     ticks of feeder income a send may cost
// farAhead    income ratio over every opponent that allows income-losing sends
// replace     late swaps of cheap maze towers into the Elemental lines   fixAware  avoids sends the Creep Fix eats
// maxActions/maxSends      commands per decision                  alpha      share of the kill estimate it trusts
// tech        how wisps are spent: 'random', 'greedy' (best building now) or 'plan' (the best set of buildings)
// lumber      buys Arcade lumber for a lumber send when far ahead     arcadeWisp trains Arcade wisps when rich
export const DIFFICULTY = {
  easy: {
    think: 2.0, lag: 7, noise: 0.45, pick: 3, depth: 1, maze: 'loose', eslots: false, mazeShare: 0.75,
    defBase: 0.5, defGain: 0.25, defMin: 0.35, forecast: 0, panic: 0.4, leakShare: 0.75, leakMemory: 20,
    horizon: 15, roiMin: 0.15, burst: false, leakGoal: 0, saveTicks: 0, weak: false, prior: 0.1, foresight: 0,
    afford: 2, farAhead: Infinity, replace: false, fixAware: false, maxActions: 4, maxSends: 6, alpha: 0.6,
    tech: 'random', lumber: false, arcadeWisp: false,
  },
  normal: {
    think: 1.0, lag: 2.5, noise: 0.18, pick: 2, depth: 3, maze: 'serpentine', eslots: false, mazeShare: 0.85,
    defBase: 0.35, defGain: 0.35, defMin: 0.22, forecast: 1, panic: 0.7, leakShare: 0.85, leakMemory: 15,
    horizon: 16, roiMin: 0.25, burst: true, leakGoal: 3, saveTicks: 2, weak: true, prior: 0.3, foresight: 30,
    afford: 3, farAhead: 4, replace: false, fixAware: false, maxActions: 8, maxSends: 16, alpha: 0.6,
    tech: 'greedy', lumber: false, arcadeWisp: false,
  },
  hard: {
    think: 0.5, lag: 0.8, noise: 0.04, pick: 1, depth: 8, maze: 'serpentine', eslots: true, mazeShare: 0.95,
    defBase: 0.25, defGain: 0.4, defMin: 0.12, forecast: 0.6, panic: 1, leakShare: 0.9, leakMemory: 12,
    horizon: 20, roiMin: 0.2, burst: true, leakGoal: 4, saveTicks: 3, weak: true, prior: 0.45, foresight: 90,
    afford: 4, farAhead: 2.5, replace: true, fixAware: true, maxActions: 14, maxSends: 40, alpha: 0.6,
    tech: 'plan', lumber: true, arcadeWisp: true,
  },
  insane: {
    think: 0.25, lag: 0, noise: 0, pick: 1, depth: 8, maze: 'serpentine', eslots: true, mazeShare: 1,
    defBase: 0.22, defGain: 0.45, defMin: 0.1, forecast: 0.6, panic: 1, leakShare: 0.9, leakMemory: 12,
    horizon: 22, roiMin: 0.2, burst: true, leakGoal: 5, saveTicks: 3.5, weak: true, prior: 0.5, foresight: 120,
    afford: 4, farAhead: 2.2, replace: true, fixAware: true, maxActions: 20, maxSends: 64, alpha: 0.6,
    tech: 'plan', lumber: true, arcadeWisp: true,
  },
};
export const DIFFICULTIES = Object.keys(DIFFICULTY);

// ---------------------------------------------------------------------------------------------------- static tables
// Expected damage per second of a tower against one unit type: the WC3 attack/armour table and armour formula,
// targeting (air/ground, magic vs magic immune), splash and bounce against groups, poison, bash, slows and evasion.
// Invisibility and coverage depend on the lane and are applied later.
const SPLASH_K = 1.6, BOUNCE_K = 2.4;
// `u.air` is how the unit is targeted (the map's Targeted As), `u.flying` how it moves: the Phoenix flies over the
// maze but ground-only towers can hit it and the Creep Fix kills it.
function effOf(d, u) {
  if (u.air ? !d.targetsAir : !d.targetsGround) return 0;
  if (d.attackType === 'magic' && u.magicImmune) return 0;
  const hitF = typeFactor(d.attackType, u.armorType) * armorFactor(u.armor);
  const crowd = (u.copies ?? 3) >= 3 ? 1 : 0.4;
  let e = avgDamage(d) / d.cooldown * hitF;
  // shots wasted on overkill: a 2 HP creep takes a whole 3-damage arrow
  const x = u.hp / Math.max(1e-9, avgDamage(d) * hitF);
  if (x < 6) e *= x < 1 ? x : x / Math.ceil(x);
  if (d.bounce) e *= 1 + (BOUNCE_K - 1) * crowd;
  else if (d.splash) e *= 1 + (SPLASH_K - 1) * crowd;
  if (d.bash) e += d.bash.chance / 100 * d.bash.dmg / d.cooldown * hitF;
  if (!u.magicImmune) {
    if (d.poison) e += d.poison.dps;   // spell damage ignores armour
    const slow = Math.max(d.slow ? d.slow.pct : 0, d.poison && d.poison.slow ? d.poison.slow : 0, d.auraSlow ? d.auraSlow.pct : 0);
    if (slow) e *= 1 + slow / 200;     // slowed creeps stay longer in range of every tower
  }
  if (d.immolation && !u.flying) e += d.immolation.dps * 0.5;
  if (u.evasion) e *= 0.9;
  return e;
}
const EFF = DEF_IDS.map(id => Float64Array.from(UNITS, u => effOf(TOWERS[id], u)));
// Tech planning: what each tower type is worth against the strong creeps of the late game (sold units from 2000 gold
// that need no lumber, weighted by the HP a purchase sends), per gold of its whole build chain.
const LATE = UNITS.map(u => (u.sold && u.cost >= 2000 && !u.lumber ? u.hp * (u.copies ?? 3) : 0));
const LATE_SUM = LATE.reduce((a, b) => a + b, 0) || 1;
const POWER = DEF_IDS.map((id, d) => {
  const t = TOWERS[id]; let s = 0;
  for (let i = 0; i < NU; i++) if (LATE[i]) s += LATE[i] / LATE_SUM * EFF[d][i];
  return s * (t.range + 48) / TILE / Math.max(1, t.value) * (1 + 0.15 * t.tier);
});
// Tech requirements as bit masks over the tech buildings (LTW_TECH_ORDER).
const TECH_BIT = Object.fromEntries(LTW_TECH_ORDER.map((id, i) => [id, 1 << i]));
const REQ = DEF_IDS.map(id => ((LTW_TOWER_STATS[id] && LTW_TOWER_STATS[id].requires) || []).reduce((m, r) => m | (TECH_BIT[r] || 0), 0));
const techMaskOf = (list) => (list || []).reduce((m, id) => m | (TECH_BIT[id] || 0), 0);
// Every node of the build tree below a tower type (itself included), with its depth and the tech it needs on the way.
const rootOf = (id) => { let k = id; while (TOWERS[k].from) k = TOWERS[k].from; return k; };
const SUBTREE = DEF_IDS.map(id => {
  const out = [];
  const walk = (k, depth, need) => { const m = need | REQ[DIDX[k]]; out.push([DIDX[k], depth, m]); for (const n of TOWERS[k].upgrades) walk(n, depth + 1, m); };
  walk(id, 0, 0);
  return out;
});
// The Elemental tower's five element branches, each as [node, tech needed] pairs.
const BRANCHES = TOWERS[ELEMENTAL].upgrades.map(k => SUBTREE[DIDX[k]].map(([n, , need]) => [n, need]));
// What a set of tech buildings is worth: the best reachable node of the best branch, plus half the second best.
function techValue(mask) {
  let b1 = 0, b2 = 0;
  for (const br of BRANCHES) {
    let best = 0;
    for (const [n, need] of br) if (!(need & ~mask) && POWER[n] > best) best = POWER[n];
    if (best > b1) { b2 = b1; b1 = best; } else if (best > b2) b2 = best;
  }
  return b1 + 0.5 * b2;
}
const TECH_REQ = LTW_TECH_ORDER.map(id => techMaskOf(LTW_TECH[id].requires));
// Buildings a player owning `mask` can raise now (their tier-1 building owned).
const techOpen = (mask) => LTW_TECH_ORDER.filter((id, i) => !(mask & TECH_BIT[id]) && !(TECH_REQ[i] & ~mask));
// The best set of up to `k` more buildings (each tier 2 with its tier 1), in an order that can be bought.
function planTech(mask, k) {
  const ids = LTW_TECH_ORDER.filter(id => !(mask & TECH_BIT[id]));
  let best = { v: techValue(mask), set: [] };
  const pick = [];
  const rec = (from, m) => {
    if (pick.length) {
      const ok = pick.every(id => !(TECH_REQ[LTW_TECH_ORDER.indexOf(id)] & ~m));
      if (ok) { const v = techValue(m); if (v > best.v + 1e-12) best = { v, set: pick.slice() }; }
    }
    if (pick.length >= k) return;
    for (let i = from; i < ids.length; i++) { pick.push(ids[i]); rec(i + 1, m | TECH_BIT[ids[i]]); pick.pop(); }
  };
  rec(0, mask);
  return best.set.sort((a, b) => LTW_TECH[a].tier - LTW_TECH[b].tier);
}
const RANGES = [...new Set(DEF_IDS.map(id => TOWERS[id].range))].sort((a, b) => a - b);
const RIDX = Object.fromEntries(RANGES.map((r, i) => [r, i]));
const NR = RANGES.length;
const REACH = RANGES.map(r => (r + 48) / TILE);                 // field.js inRange: range + 48

// Average length of a flyer's straight flight inside a tower's range, over the spawn band of v (static).
const AIR_Y = Array.from({ length: 15 }, (_, i) => 0.5 + (ROWS - 1) * i / 14);
const AIR = new Float64Array(N * NR).fill(-1);
function airCov(i, ri) {
  const k = i * NR + ri;
  if (AIR[k] >= 0) return AIR[k];
  const c = i % COLS, r = (i - c) / COLS, R = REACH[ri], xc = c + 0.5, yc = r + 0.5;
  let s = 0;
  for (const y of AIR_Y) {
    const dy = y - yc; if (Math.abs(dy) >= R) continue;
    const h = Math.sqrt(R * R - dy * dy), a = Math.max(1, xc - h), b = Math.min(EXIT_U, xc + h);
    if (b > a) s += b - a;
  }
  return (AIR[k] = s / AIR_Y.length);
}

// Maze templates: walls across the lane, gaps alternating between the two edges.
//   serpentine: an 8-tile wall (a one-tile gap) every 2 columns (20 walls, 160 towers, ~193-tile path against 41 open)
//   loose:      a 6-tile wall (a three-tile gap) every 3 columns (13 walls, 78 towers, ~82-tile path), the easy bots'.
//               78 towers is what it had on the map's 8-row lanes; walls of 7 (91 towers, ~106 tiles) made easy bots
//               so hard to break that in 4-bot rings they often outlived the normal ones
function makeTemplate(kind, flip) {
  const [first, step, span] = kind === 'loose' ? [3, 3, ROWS - 3] : [3, 2, ROWS - 1];
  const walls = [];
  for (let c = first, w = 0; c < EXIT_U; c += step, w++) {
    const gapLow = (w % 2 === 0) !== flip;          // the gap is at v = 0 (and the wall at the high v side)
    const tiles = [];
    for (let r = 0; r < ROWS; r++) if (gapLow ? r >= ROWS - span : r < span) tiles.push(r * COLS + c);
    // gap-side end last: an unfinished wall then still forces most of the detour
    if (gapLow) tiles.reverse();
    walls.push({ c, tiles, gapTile: gapLow ? (ROWS - span) * COLS + c : (span - 1) * COLS + c });
  }
  return walls;
}

const hashTowers = (towers) => {
  let h = towers.length | 0;
  for (const t of towers) h = Math.imul(h ^ (t.id * 97 + DIDX[t.def.id] * 7 + (t.sellAt !== undefined ? 3 : 0)), 16777619) >>> 0;
  return h;
};
// Average walk (tiles) from the spawn zone to the exit over the spawn rows: creeps spawn at a random v, so a single
// wall already lengthens the average walk even though the creeps spawning by its gap skip it. Infinity if blocked.
const spawnPath = (dist) => {
  let s = 0;
  for (let r = 0; r < ROWS; r++) { const v = dist[r * COLS + SPAWN_U - 1]; if (v >= INF) return Infinity; s += v; }
  return s / ROWS / 10;
};

// ---------------------------------------------------------------------------------------------------- lane view
// What a bot knows about one lane: the creep route, how much of it each spot covers at each range, true-sight
// coverage, and per unit type the HP the lane's towers can take off a group in one pass. Recomputed only when the
// lane's towers change.
export class LaneView {
  constructor(lane) {
    this.lane = lane; this.fv = -1; this.sig = -1;
    this.gc = new Float64Array(N * NR);
    this.routeX = new Float64Array(0); this.routeY = new Float64Array(0); this.routeW = new Float64Array(0);
    this.routeLen = 1; this.path = 41; this.sighted = new Uint8Array(0); this.sight = 1;
    this.kp = new Float64Array(NU); this.kpNon = new Float64Array(NU); this.kpOk = new Uint8Array(NU);
    this.live = [];
  }
  update() {
    const L = this.lane;
    if (L.flowVersion !== this.fv) {
      this.fv = L.flowVersion;
      const route = L.route(1, ROWS >> 1);
      const n = route.length;
      this.routeX = new Float64Array(n); this.routeY = new Float64Array(n); this.routeW = new Float64Array(n);
      let len = 0;
      for (let k = 0; k < n; k++) {
        const [c, r] = route[k];
        this.routeX[k] = c + 0.5; this.routeY[k] = r + 0.5;
        const w = k + 1 < n ? Math.hypot(route[k + 1][0] - c, route[k + 1][1] - r) : 1;
        this.routeW[k] = w; len += w;
      }
      this.routeLen = Math.max(1, len);
      this.path = spawnPath(L.flow);
      this.gc.fill(-1);
      this.sig = -1;
    }
    const sig = hashTowers(L.towers);
    if (sig !== this.sig) {
      this.sig = sig;
      this.live = L.towers.filter(t => t.sellAt === undefined);
      this.kpOk.fill(0);
      // true-sight coverage of the route
      const n = this.routeX.length, seen = new Uint8Array(n);
      let w = 0;
      for (const t of this.live) {
        if (!t.def.trueSight) continue;
        const R = t.def.trueSight / TILE;
        for (let k = 0; k < n; k++) if (!seen[k] && Math.hypot(this.routeX[k] - t.x, this.routeY[k] - t.y) <= R) { seen[k] = 1; w += this.routeW[k]; }
      }
      this.sighted = seen; this.sight = w / this.routeLen;
    }
  }
  // Route length within reach of tile i at range index ri.
  ground(i, ri) {
    const k = i * NR + ri;
    let v = this.gc[k];
    if (v >= 0) return v;
    const c = i % COLS, r = (i - c) / COLS, x = c + 0.5, y = r + 0.5, R = REACH[ri], R2 = R * R;
    const X = this.routeX, Y = this.routeY, W = this.routeW;
    v = 0;
    for (let j = 0; j < X.length; j++) { const dx = X[j] - x, dy = Y[j] - y; if (dx * dx + dy * dy <= R2) v += W[j]; }
    return (this.gc[k] = v);
  }
  cov(i, ri, flying) { return flying ? airCov(i, ri) : this.ground(i, ri); }
  // HP of unit type ui the lane can take off a group in one pass (towers busy while the group is in range).
  kpOf(ui) {
    if (this.kpOk[ui]) return this.kp[ui];
    const u = UNITS[ui], fly = !!u.flying;
    let all = 0, ts = 0;
    for (const t of this.live) {
      const e = EFF[DIDX[t.def.id]][ui];
      if (!e) continue;
      const v = e * this.cov(t.r * COLS + t.c, RIDX[t.def.range], fly);
      if (t.def.trueSight) ts += v; else all += v;
    }
    this.kpNon[ui] = all * TT[ui];                  // from towers that need another tower's true sight
    const total = u.invisible ? ts + all * this.sight : ts + all;
    this.kp[ui] = total * TT[ui]; this.kpOk[ui] = 1;
    return this.kp[ui];
  }
  // How much of the route (fraction) is still ahead of a creep; 1 at the spawn.
  remaining(c) {
    if (c.def.flying) return Math.max(0.05, (EXIT_U - c.x) / (EXIT_U - 1));
    const d = this.lane.flow[tileOf(c)];
    return d >= INF ? 1 : Math.max(0.05, Math.min(1, d / 10 / Math.max(1, this.path)));
  }
  // Load: the creeps in the lane as a multiple of what the lane can kill in the rest of their walk (>1: leaks likely).
  // The per-pass capacity is for one group; creeps strung out along the route meet the towers one after another.
  load(alpha, filter = null) {
    let rho = 0, lo = 1, hi = 0, n = 0;
    for (const c of this.lane.creeps) {
      if (c.dead || (filter && !filter(c))) continue;
      const ui = UIDX[c.def.id]; if (ui === undefined) continue;
      const rem = this.remaining(c);
      if (rem < lo) lo = rem; if (rem > hi) hi = rem; n++;
      rho += c.hp / (alpha * this.kpOf(ui) * rem + 1);
    }
    if (n > 1) rho /= Math.min(3, 1 + (hi - lo) * this.path / 40);
    return rho;
  }
  // How much of the towers' time the creeps already in the lane take up, for ground and for air (0..1 each).
  // Creeps the towers cannot hit at all take none of it (they leak, but leave the towers free for other creeps).
  busy(alpha) {
    let g = 0, a = 0;
    for (const c of this.lane.creeps) {
      if (c.dead) continue;
      const ui = UIDX[c.def.id]; if (ui === undefined) continue;
      const kp = this.kpOf(ui);
      if (!(kp > 0)) continue;
      const f = Math.min(1, c.hp / (alpha * kp * this.remaining(c)));
      if (UNITS[ui].air) a += f; else g += f;   // by target class: what ties up anti-air towers
    }
    return { ground: Math.min(1, g / 3), air: Math.min(1, a / 3) };
  }
}

// ---------------------------------------------------------------------------------------------------- the bot
const clock = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();   // timing stats only
export class Bot {
  constructor(match, slot, difficulty = 'normal', { seed } = {}) {
    if (!match.player(slot)) throw new Error(`Bot: no player in slot ${JSON.stringify(slot)} (slots are integers)`);
    this.m = match; this.slot = slot;
    this.level = DIFFICULTY[difficulty] ? difficulty : 'normal';
    this.cfg = DIFFICULTY[this.level];
    const s = (seed ?? match.seed ?? 1) >>> 0;
    this.rng = mulberry32((Math.imul(s, 2654435761) ^ Math.imul(slot + 1, 40503) ^ (DIFFICULTIES.indexOf(this.level) + 1) * 977) >>> 0);
    this.walls = makeTemplate(this.cfg.maze, this.rng() < 0.5);
    this.templateTiles = new Set(this.walls.flatMap(w => w.tiles));
    // Elemental slots: the tile by each wall's gap, built last and straight as an Elemental (the strong lines start
    // there), so the maze needs no sells to get them; until then the gap is just one tile wider
    this.eslots = new Set(this.cfg.eslots ? this.walls.map(w => w.gapTile) : []);
    this.views = new Map();
    this.nextThink = this.cfg.think * this.rng();
    this.defAcc = 0; this.sendAcc = 0; this.lastGold = null;
    this.seen = new Map(); this.obs = new Float64Array(NU); this.obsT = 0;
    this.lastLives = null; this.leakT = -1e9; this.share = 0.8;
    this.retry = new Map();      // tile -> time before which a refused build is not retried
    this.prefer = new Map();     // tile -> root to build there (after a swap sale)
    this.wallCache = { fv: -1, gains: null };
    this.lastSwap = -1e9; this.lastSwapLook = -1e9; this.saving = null; this.saveBlock = 0; this.refund = 0; this.sightMemo = new Map();
    this.sale = null;            // the swap sale in its 1 s delay: { t, gold }
    this.W = new Float64Array(NU); this.G = new Float64Array(DEF_IDS.length); this.A = new Float64Array(DEF_IDS.length);
    this.kpMix = 0; this.need = 0; this.danger = 0;
    this.techMask = 0; this.lumberGoal = null;
    this.stats = { thinks: 0, commands: 0, failed: 0, builds: 0, upgrades: 0, sells: 0, sends: 0, sendGold: 0,
      defGold: 0, bursts: 0, pushes: 0, lastOk: 0, ms: 0, maxMs: 0, why: {}, tech: 0, lumber: 0, lumberSends: 0, wisps: 0 };
  }

  // ---------- driving ----------
  // Call after every match.step(dt). Decisions follow the match clock, so a replay with the same calls is identical.
  tick(dt = 0) {
    const m = this.m, p = m.players[this.slot];
    if (!p || !p.alive || p.left || (m.phase !== 'playing' && m.phase !== 'prep')) return;   // a kicked bot gives no more orders
    if (m.time + 1e-9 < this.nextThink) return;
    this.nextThink = m.time + this.cfg.think * (0.75 + 0.5 * this.rng());
    this.think();
  }
  cmd(op) {
    const r = this.m.command(this.slot, op);
    this.stats.commands++;
    if (r.ok) this.stats.lastOk = this.m.time;
    else { this.stats.failed++; this.stats.why[r.why] = (this.stats.why[r.why] || 0) + 1; }
    return r;
  }
  view(slot) {
    let v = this.views.get(slot);
    if (!v || v.lane !== this.m.lanes[slot]) { v = new LaneView(this.m.lanes[slot]); this.views.set(slot, v); }
    v.update();
    return v;
  }
  noise() {   // log-normal score error
    const s = this.cfg.noise; if (!s) return 1;
    const u = Math.max(1e-9, this.rng()), v = this.rng();
    return Math.exp(s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  // The living slot that sends into this lane (the previous one in the ring).
  feeder() {
    const m = this.m;
    for (const s of m.ring) if (s !== this.slot && m.players[s].alive && m.next(s) === this.slot) return s;
    return null;
  }

  think() {
    const t0 = clock();
    this.stats.thinks++;
    const m = this.m, p = m.players[this.slot];
    this.me = this.view(this.slot);
    this.techMask = techMaskOf(p.tech);
    this.technology(p);
    this.observe(p);
    this.accounts(p);
    this.defend(p);
    this.attack(p);
    this.arcadeWisp(p);
    this.lastGold = p.gold;
    const dt = clock() - t0;
    this.stats.ms += dt; if (dt > this.stats.maxMs) this.stats.maxMs = dt;
  }

  // ---------- technology ----------
  // Spends every wisp on a tech building: hard and insane follow a plan, normal takes the best one now, easy any.
  technology(p) {
    if (!(p.wisps > 0) || !Array.isArray(p.tech)) return;
    const cfg = this.cfg;
    let n = 0;
    while (p.wisps > 0 && n < 8) {
      n++;
      const open = techOpen(this.techMask);
      if (!open.length) return;
      let id;
      if (cfg.tech === 'random') id = open[Math.floor(this.rng() * open.length)];
      else if (cfg.tech === 'greedy') {
        const v0 = techValue(this.techMask);
        let best = -Infinity;
        for (const o of open) { const g = (techValue(this.techMask | TECH_BIT[o]) - v0) * this.noise(); if (g > best) { best = g; id = o; } }
      } else {
        const plan = planTech(this.techMask, Math.min(4, p.wisps));
        id = plan.length ? plan[0] : open.slice().sort((a, b) => techValue(this.techMask | TECH_BIT[b]) - techValue(this.techMask | TECH_BIT[a]))[0];
      }
      const r = this.cmd({ type: 'tech', id });
      if (!r.ok) return;
      this.stats.tech++;
      this.techMask = techMaskOf(p.tech);
    }
  }
  // Rich hard and insane bots train an Arcade wisp (100000 gold, -50000 income) when another building still adds value
  // and their gold sits near the 1,000,000 cap.
  arcadeWisp(p) {
    const cfg = this.cfg;
    if (!cfg.arcadeWisp || !Array.isArray(p.training) || p.training.length || p.wisps > 0) return;
    if (p.gold < 0.9 * RESOURCE_MAX || p.income < 150000 || p.gold < LTW_ARCADE.wisp.cost) return;
    const v0 = techValue(this.techMask);
    if (!techOpen(this.techMask).some(o => techValue(this.techMask | TECH_BIT[o]) > v0 + 1e-12)) return;
    const r = this.cmd({ type: 'arcade', item: 'wisp' });
    if (r.ok) { this.stats.wisps++; this.sendAcc = Math.max(0, this.sendAcc - LTW_ARCADE.wisp.cost); }
  }
  // Far ahead, hard and insane bots save lumber for the lumber send the next opponent is least able to kill.
  lumberPlan(p, tv, myInc, farAhead) {
    const m = this.m, cfg = this.cfg, slot = this.slot, mapT = m.playTime, LC = LTW_ARCADE.lumber.cost;
    if (!farAhead) { this.lumberGoal = null; return; }
    if (!this.lumberGoal) {
      let best = null;
      for (const id of SOLD) {
        const u = LTW_UNITS[id], ui = UIDX[id];
        if (!u.lumber || mapT < u.stock.start) continue;
        const st = m.stockOf(slot, id);
        if (st.count < 1) continue;
        const inc = u.income[String(slot)] || 0;
        if (myInc + inc < myInc * 0.5) continue;
        const one = u.hp * u.copies, kp = cfg.alpha * tv.kpOf(ui);
        if (kp >= one * 0.7) continue;   // the target would kill it
        const total = u.cost + Math.max(0, u.lumber - p.lumber) * LC;
        const score = (one - kp) / total;
        if (!best || score > best.score) best = { id, need: u.lumber, score };
      }
      this.lumberGoal = best;
    }
    const g = this.lumberGoal;
    if (!g) return;
    let n = 0;
    while (p.lumber < g.need && this.sendAcc >= LC && p.gold >= LC && n < 30) {
      const r = this.cmd({ type: 'arcade', item: 'lumber' });
      if (!r.ok) break;
      n++; this.sendAcc -= LC; this.stats.lumber++;
    }
    const u = LTW_UNITS[g.id];
    if (p.lumber >= g.need && p.gold >= u.cost && this.sendAcc >= u.cost * 0.5) {
      const r = this.cmd({ type: 'send', unit: g.id });
      if (r.ok) { this.sendAcc = Math.max(0, this.sendAcc - u.cost); this.stats.sends++; this.stats.sendGold += u.cost; this.stats.lumberSends++; }
      this.lumberGoal = null;
    }
  }

  // ---------- perception ----------
  observe(p) {
    const m = this.m, cfg = this.cfg, now = m.time, lane = m.lanes[this.slot], mapT = m.playTime;
    if (this.lastLives !== null && p.lives < this.lastLives) this.leakT = now;
    this.lastLives = p.lives;
    // creeps entering the lane, noticed after the reaction delay; old sightings fade (90 s)
    const k = Math.exp(-(now - this.obsT) / 90); this.obsT = now;
    for (let i = 0; i < NU; i++) this.obs[i] *= k;
    const seen = this.seen, gen = this.stats.thinks;
    for (const c of lane.creeps) {
      let e = seen.get(c.id);
      if (!e) { e = { t: now, done: false, gen }; seen.set(c.id, e); }
      e.gen = gen;
      if (!e.done && now - e.t >= cfg.lag) { e.done = true; const ui = UIDX[c.def.id]; if (ui !== undefined) this.obs[ui] += c.hp; }
    }
    if (seen.size > lane.creeps.length + 64) for (const [id, e] of seen) if (e.gen !== gen) seen.delete(id);
    // what the feeder can afford soon (the prior)
    const f = this.feeder(), fInc = f !== null ? Math.max(25, m.players[f].income) : 25, fLumber = f !== null ? m.players[f].lumber : 0;
    const prior = new Float64Array(NU);
    let ps = 0, hpg = 0, hpgW = 0;
    for (const id of SOLD) {
      const u = LTW_UNITS[id];
      if (u.lumber > fLumber || u.stock.start > mapT + cfg.foresight) continue;
      if (u.cost > fInc * cfg.afford) continue;   // more than a few ticks of the feeder's income
      const hp = u.hp * u.copies;
      let w = hp * (u.cost >= fInc * 0.1 ? 1 : 0.15);
      if (cfg.weak && (u.air || u.divine || u.invisible || u.magicImmune)) w *= 1.5;
      prior[UIDX[id]] = w; ps += w; hpg += w * hp / u.cost; hpgW += w;
    }
    let os = 0; for (let i = 0; i < NU; i++) os += this.obs[i];
    const M = new Float64Array(NU);
    const wPrior = os > 0 ? cfg.prior : 1;
    for (let i = 0; i < NU; i++) M[i] = (os > 0 ? (1 - wPrior) * this.obs[i] / os : 0) + (ps > 0 ? wPrior * prior[i] / ps : 0);
    if (!(ps > 0) && !(os > 0)) M[UIDX[SOLD[0]]] = 1;
    // marginal weights: d(KPmix)/d(KP_u) for the harmonic mix, so the weakest matchups count most
    const v = this.me;
    let inv = 0, ref = 0;
    for (let i = 0; i < NU; i++) if (M[i] > 0) ref += M[i] * v.kpOf(i);
    const floor = Math.max(5, 0.02 * ref);
    for (let i = 0; i < NU; i++) if (M[i] > 0) inv += M[i] / (v.kpOf(i) + floor);
    const kpMix = inv > 0 ? 1 / inv : 0;
    this.kpMix = kpMix;
    for (let i = 0; i < NU; i++) {
      if (!(M[i] > 0)) { this.W[i] = 0; continue; }
      const q = kpMix / (v.kpOf(i) + floor);
      this.W[i] = M[i] * Math.min(25, q * q);
    }
    // per tower type: damage per pass per tile of coverage, ground and air
    this.G.fill(0); this.A.fill(0);
    for (let i = 0; i < NU; i++) {
      const w = this.W[i]; if (!w) continue;
      const u = UNITS[i], tt = TT[i] * w;
      for (let d = 0; d < DEF_IDS.length; d++) {
        let e = EFF[d][i]; if (!e) continue;
        if (u.invisible && !TOWERS[DEF_IDS[d]].trueSight) e *= v.sight;
        if (u.flying) this.A[d] += e * tt; else this.G[d] += e * tt;
      }
    }
    this.invW = 0; for (let i = 0; i < NU; i++) if (UNITS[i].invisible && this.W[i]) { v.kpOf(i); this.invW += this.W[i] * v.kpNon[i]; }
    this.sightMemo.clear();
    // threat: what is in the lane now, and what the feeder could send at once
    this.danger = v.load(cfg.alpha, c => now - (seen.get(c.id)?.t ?? now) >= cfg.lag);
    const hpPerGold = hpgW > 0 ? hpg / hpgW : 1.5;
    this.forecastHP = cfg.forecast * fInc * hpPerGold;
    this.risk = this.forecastHP / (cfg.alpha * kpMix + 1);
    this.need = Math.max(this.danger, this.risk);
  }

  // ---------- gold: a defence account and a sending account ----------
  accounts(p) {
    const cfg = this.cfg, now = this.m.time;
    // what could come (forecast) moves the share up to 0.75; creeps actually in the lane and leaks move it further;
    // in the build phase nothing can be sent, so all of it goes into the maze
    let s = Math.min(0.75, cfg.defBase + cfg.defGain * (this.risk - 1));
    s = Math.max(s, cfg.defBase + cfg.defGain * (this.danger - 1));
    if (this.danger > 1.4) s = Math.max(s, 0.85);
    if (now - this.leakT < cfg.leakMemory) s = Math.max(s, cfg.leakShare);
    s = Math.min(0.97, Math.max(cfg.defMin, s));
    if (this.m.phase === 'prep') s = 1;
    this.share = s;
    const g = p.gold;
    if (this.lastGold === null) { this.defAcc = g * s; this.sendAcc = g - this.defAcc; }
    else {
      let d = g - this.lastGold;
      if (d > 0 && this.refund > 0) { const r = Math.min(d, this.refund); this.refund -= r; this.defAcc += r; d -= r; }
      if (d > 0) { this.defAcc += d * s; this.sendAcc += d * (1 - s); }
    }
    let tot = this.defAcc + this.sendAcc;
    if (tot > g + 1e-6 || tot < g - 1e-6) {
      if (tot <= 0) { this.defAcc = g * s; this.sendAcc = g - this.defAcc; }
      else { const k = g / tot; this.defAcc *= k; this.sendAcc *= k; }
    }
    // emergency: move sending money to defence
    if (this.danger > 1.2 || now - this.leakT < cfg.leakMemory * 0.5) {
      const moved = this.sendAcc * cfg.panic * (this.saving && this.need < 2 ? 0.5 : 1);
      this.sendAcc -= moved; this.defAcc += moved;
    }
  }

  // ---------- defence ----------
  value(d, i) {   // damage per pass a tower of type d at tile i adds against the expected creeps
    const ri = RIDX[TOWERS[DEF_IDS[d]].range];
    const g = this.G[d], a = this.A[d];
    return (g ? g * this.me.ground(i, ri) : 0) + (a ? a * airCov(i, ri) : 0);
  }
  sightGain(i) {   // extra damage from revealing more of the route to the towers without true sight
    if (!(this.invW > 0)) return 0;
    let g = this.sightMemo.get(i);
    if (g !== undefined) return g;
    const v = this.me, X = v.routeX, Y = v.routeY, Wt = v.routeW, x = i % COLS + 0.5, y = Math.floor(i / COLS) + 0.5;
    let w = 0;
    for (let k = 0; k < X.length; k++) { const dx = X[k] - x, dy = Y[k] - y; if (!v.sighted[k] && dx * dx + dy * dy <= SIGHT_R * SIGHT_R) w += Wt[k]; }
    g = this.invW * w / v.routeLen;
    this.sightMemo.set(i, g);
    return g;
  }
  // Best (damage gained / gold) over the build tree below `start` (within the lookahead), measured from a tower of
  // type `cur` at tile i that has cost `paid` so far. Only nodes whose tech requirements the bot owns count.
  treeScore(start, i, cur, paid, hasTS, minValue = 0) {
    const v0 = this.value(cur, i), depth = this.cfg.depth, mask = this.techMask;
    let top = -Infinity;
    for (const [n, dep, need] of SUBTREE[start]) {
      if (dep >= depth || (need & ~mask)) continue;
      const def = TOWERS[DEF_IDS[n]];
      if (def.value < minValue) continue;
      let dv = this.value(n, i) - v0;
      if (def.trueSight && !hasTS) dv += this.sightGain(i);
      const r = dv / Math.max(1, def.value - paid);
      if (r > top) top = r;
    }
    return top;
  }
  // The upgrade of tower t that leads toward the best node.
  bestStep(t, i) {
    const cur = DIDX[t.def.id], ts = !!t.def.trueSight;
    let best = null;
    for (const k of t.def.upgrades) {
      if (REQ[DIDX[k]] & ~this.techMask) continue;   // the upgrade needs a tech building the bot lacks
      const s = this.treeScore(DIDX[k], i, cur, t.def.value, ts);
      if (!best || s > best.score) best = { score: s, id: k, cost: TOWERS[k].cost };
    }
    return best;
  }
  wallGains() {
    const lane = this.m.lanes[this.slot];
    if (this.wallCache.fv === lane.flowVersion) return this.wallCache.gains;
    const base = spawnPath(lane.flow), blocked = lane.blocked.slice(), dist = new Int32Array(N);
    const gains = this.walls.map(w => {
      const left = w.tiles.filter(i => !blocked[i]);
      if (!left.length) return { left, gain: 0 };
      for (const i of left) blocked[i] = 1;
      const p = spawnPath(flowField(blocked, dist));
      for (const i of left) blocked[i] = 0;
      return { left, gain: p === Infinity ? -1 : p - base };
    });
    this.wallCache = { fv: lane.flowVersion, gains };
    return gains;
  }
  defenseCandidates(p) {
    const m = this.m, cfg = this.cfg, lane = m.lanes[this.slot], v = this.me, now = m.time, out = [];
    // creep tiles (no building on a ground creep)
    const busy = new Set();
    for (const c of lane.creeps) if (!c.dead && !c.def.flying) busy.add(tileOf(c));
    // maze walls: damage gained from a longer path, shared over the wall's missing towers, plus the tower itself
    const gains = this.wallGains();
    let kpGround = 0;
    for (let i = 0; i < NU; i++) if (this.W[i] && !UNITS[i].flying) kpGround += this.W[i] * v.kpOf(i);
    let built = 0, total = 0;
    this.walls.forEach((w, wi) => {
      const g = gains[wi]; total += w.tiles.length; built += w.tiles.length - g.left.length;
      if (!g.left.length || g.gain < 0) return;
      const pathValue = kpGround * g.gain / Math.max(1, v.path) / g.left.length;
      for (const i of g.left) {
        if (busy.has(i) || (this.retry.get(i) || 0) > now) continue;
        const root = this.prefer.get(i) || (this.eslots.has(i) ? ELEMENTAL : ARCHER), d = DIDX[root];
        const cost = TOWERS[root].cost;
        const score = (pathValue + this.value(d, i)) / cost * (1 + cfg.mazeShare * 2) * (i === w.gapTile ? 0.97 : 1) * (1 - wi * 1e-4);
        out.push({ kind: 'build', id: root, i, cost, score });
      }
    });
    this.mazeDone = total ? built / total : 1;
    // upgrades
    let bestUp = 0;
    for (const t of lane.towers) {
      if (t.building || t.sellAt !== undefined || !t.def.upgrades.length) continue;
      const i = t.r * COLS + t.c, s = this.bestStep(t, i);
      if (!s || !(s.score > 0)) continue;
      out.push({ kind: 'upgrade', t, id: s.id, cost: s.cost, score: s.score });
      if (s.score > bestUp) bestUp = s.score;
    }
    // swaps: sell a cheap maze tower and start a strong line on its tile (rare). Only toward nodes worth several times
    // what the tower cost, so the sale refund never makes a sideways move look cheap.
    if (cfg.replace && m.playTime > 300 && this.mazeDone > 0.97 && now - this.lastSwap > 6 && now - this.lastSwapLook > 3 && this.prefer.size === 0) {
      this.lastSwapLook = now;
      let best = null;
      for (const t of lane.towers) {
        if (t.building || t.sellAt !== undefined || t.def.value > 1200 || !this.templateTiles.has(t.r * COLS + t.c)) continue;
        if (rootOf(t.def.id) === ELEMENTAL) continue;
        const i = t.r * COLS + t.c, x = t.x, y = t.y;
        let near = false;
        for (const c of lane.creeps) if (!c.def.flying && Math.abs(c.x - x) < 3 && Math.abs(c.y - y) < 3) { near = true; break; }
        if (near) continue;
        const back = lane.sellValue(t);   // the tower's point value (the map's sell trigger)
        const s = this.treeScore(DIDX[ELEMENTAL], i, DIDX[t.def.id], back, !!t.def.trueSight, t.spent * 4) * 0.8;   // 0.8: the hole costs path for a moment
        if (s > 0 && (!best || s > best.score)) best = { t, i, root: ELEMENTAL, score: s };
      }
      if (best && best.score > bestUp * 1.25) out.push({ kind: 'swap', ...best, cost: TOWERS[best.root].cost });
    }
    for (const c of out) c.score *= this.noise();
    out.sort((a, b) => b.score - a.score);
    if (cfg.pick > 1 && out.length > 1) {   // weaker bots grab one of the top few
      const k = Math.min(cfg.pick, out.length), j = Math.floor(this.rng() * k);
      const [x] = out.splice(j, 1); out.unshift(x);
    }
    return out;
  }
  defend(p) {
    const cfg = this.cfg, m = this.m, lane = m.lanes[this.slot];
    // an attacker destroyed the tower during the sell delay: no gold comes back (the tile is rebuilt all the same)
    if (this.sale && (this.sale.t.sold || this.sale.t.destroyed)) {
      if (this.sale.t.destroyed) this.refund = Math.max(0, this.refund - this.sale.gold);
      this.sale = null;
    }
    // a swap sale finished: its tile is a hole in a wall now and the maze rebuilds it first
    for (const [i, root] of this.prefer) {
      const t = lane.occupied.get(i);
      if (t && t.sellAt === undefined) this.prefer.delete(i);
    }
    const reserve = [...this.prefer.values()].reduce((s, r) => s + TOWERS[r].cost, 0);
    const list = this.defenseCandidates(p);
    if (!list.length) {
      // nothing worth buying: release most of the defence account to sending
      if (this.defAcc > 50) { const x = this.defAcc * 0.5; this.defAcc -= x; this.sendAcc += x; }
      return;
    }
    const top = list[0].score, defIncome = Math.max(25, p.income) * this.share;
    let acts = 0, saving = false;
    const usedTowers = new Set();
    for (const c of list) {
      if (acts >= cfg.maxActions) break;
      if (c.t && usedTowers.has(c.t)) continue;
      if (saving && c.score < top * 0.6) break;
      const avail = this.defAcc - (c.kind === 'build' && this.prefer.has(c.i) ? 0 : reserve);
      if (c.cost > avail || c.cost > p.gold) {
        // worth saving for the best one if it is within reach of a few ticks of defence income
        if (c === list[0] && c.cost <= avail + defIncome * (2 + cfg.saveTicks)) saving = true;
        continue;
      }
      let r;
      if (c.kind === 'build') {
        r = this.cmd({ type: 'build', id: c.id, c: c.i % COLS, r: Math.floor(c.i / COLS) });
        if (!r.ok) { this.retry.set(c.i, m.time + (r.why && r.why.includes('creep') ? 1.5 : 10)); continue; }
        this.stats.builds++; this.prefer.delete(c.i);
      } else if (c.kind === 'upgrade') {
        r = this.cmd({ type: 'upgrade', tower: c.t.id, id: c.id });
        if (!r.ok) continue;
        this.stats.upgrades++; usedTowers.add(c.t);
      } else {
        r = this.cmd({ type: 'sell', tower: c.t.id });
        if (!r.ok) continue;
        this.stats.sells++; this.lastSwap = m.time; this.prefer.set(c.i, c.root); usedTowers.add(c.t);
        this.refund += r.gold; this.sale = { t: c.t, gold: r.gold };   // arrives in 1 s and goes to the rebuild
        acts++;
        continue;
      }
      this.defAcc -= c.cost; this.stats.defGold += c.cost; acts++;
    }
    // a defence account that keeps growing with nothing to buy feeds the sends
    if (!saving && acts === 0 && this.defAcc > Math.max(200, p.income * 6) && this.need < 0.8) {
      const x = (this.defAcc - p.income * 3) * 0.5; if (x > 0) { this.defAcc -= x; this.sendAcc += x; }
    }
  }

  // ---------- sending ----------
  attack(p) {
    const m = this.m, cfg = this.cfg, now = m.time, slot = this.slot, mapT = m.playTime;
    if (m.phase === 'prep') return;   // the shrines and the Arcade are shut
    const T = m.next(slot);
    if (T === null || T === slot) return;
    const tv = this.view(T), tp = m.players[T];
    const myInc = p.income, H = cfg.horizon;
    let maxOther = 0; for (const s of m.ring) if (s !== slot && m.players[s].alive) maxOther = Math.max(maxOther, m.players[s].income);
    const farAhead = myInc >= cfg.farAhead * Math.max(1, maxOther);
    if (cfg.lumber) this.lumberPlan(p, tv, myInc, farAhead);
    const tBusy = cfg.weak ? tv.busy(cfg.alpha) : { ground: 0, air: 0 };
    const lifeVal = 20 * Math.max(50, myInc) / Math.max(1, tp.lives);
    const fixIn = (() => { const per = FIX[String(T)]; return per ? per - (mapT % per) : Infinity; })();
    const opts = [];
    for (const id of SOLD) {
      const u = LTW_UNITS[id], ui = UIDX[id];
      if (u.lumber > p.lumber || mapT < u.stock.start) continue;
      const st = m.stockOf(slot, id);
      if (st.count < 1) continue;
      const inc = u.income[String(slot)] || 0;
      if (inc < 0 && !farAhead) continue;
      if (inc < 0 && myInc + inc < myInc * 0.5) continue;
      const kp = cfg.weak ? cfg.alpha * tv.kpOf(ui) * (1 - (u.air ? tBusy.air : tBusy.ground)) : Infinity;   // easy bots don't look
      const one = u.hp * u.copies;
      const pKill = cfg.weak ? Math.min(1, kp / one) : 1;
      const roi = (inc * H - u.cost - u.copies * u.bounty * pKill) / u.cost;
      // ground creeps sent now would still be walking when the target's Creep Fix sweeps them
      const walk = (u.flying ? EXIT_U : tv.path) * TT[ui];
      const fixed = cfg.fixAware && !u.air && fixIn < walk + 4;   // the Creep Fix kills what is targeted as ground
      opts.push({ id, u, ui, inc, kp, one, roi, st, fixed });
    }
    if (!opts.length) return;
    // a big send: enough copies to push leakGoal creeps through the target's defence
    let burst = null;
    if (cfg.burst && cfg.weak) {
      const budget = this.sendAcc + Math.max(0, myInc) * (1 - this.share) * cfg.saveTicks;
      for (const o of opts) {
        if (o.fixed || o.kp === Infinity) continue;
        if (o.roi < cfg.roiMin * 0.5 && !(farAhead || o.inc >= 0 && tp.lives <= 6)) continue;
        const kills = o.kp / o.u.hp;                                   // creeps of this type the target kills per pass
        const goal = Math.min(cfg.leakGoal, Math.max(1, tp.lives));
        const n = Math.ceil((goal + kills) / o.u.copies);
        const nMax = Math.min(o.st.count, Math.floor(budget / o.u.cost));
        if (n > o.st.count || n * o.u.cost > budget) continue;
        const k = Math.max(n, Math.min(nMax, Math.floor(this.sendAcc / o.u.cost)));
        const leaks = Math.max(0, k * o.u.copies - kills);
        const gold = k * o.u.cost;
        const value = (o.inc * H * k - gold - (k * o.u.copies - leaks) * o.u.bounty) + Math.min(leaks, tp.lives + 3) * lifeVal;
        const score = value / gold * this.noise();
        if (!burst || score > burst.score) burst = { ...o, n, k, gold: n * o.u.cost, score, leaks };
      }
    }
    // trickle: the best payback
    let trickle = null;
    for (const o of opts) {
      if (o.inc <= 0) continue;
      const s = o.roi * this.noise();
      if (s >= cfg.roiMin && (!trickle || s > trickle.score)) trickle = { ...o, score: s };
    }
    if (burst && (!trickle || burst.score >= trickle.score * 0.8 || burst.leaks >= tp.lives)) {
      if (burst.gold <= this.sendAcc) {
        let n = 0;
        while (burst.st.count > 0 && this.sendAcc >= burst.u.cost && p.gold >= burst.u.cost && n < 64) {
          const r = this.cmd({ type: 'send', unit: burst.id });
          if (!r.ok) break;
          n++; this.sendAcc -= burst.u.cost; this.stats.sends++; this.stats.sendGold += burst.u.cost;
        }
        if (n) this.stats.bursts++;
        this.saving = null;
        return;
      }
      if (now >= this.saveBlock) {
        if (!this.saving || this.saving.id !== burst.id) this.saving = { id: burst.id, since: now };
        if (now - this.saving.since < 15 * (cfg.saveTicks + 1)) return;   // keep saving
        this.saveBlock = now + 30;                                        // saved long enough: trickle for a while
      }
      this.saving = null;
    } else this.saving = null;
    // spend on payback sends
    let sends = 0;
    while (trickle && sends < cfg.maxSends) {
      const u = trickle.u;
      if (this.sendAcc < u.cost || p.gold < u.cost) break;
      const r = this.cmd({ type: 'send', unit: trickle.id });
      if (!r.ok) break;
      sends++; this.sendAcc -= u.cost; this.stats.sends++; this.stats.sendGold += u.cost;
      if (trickle.st.count < 1) {
        // out of stock: next best
        let nb = null;
        for (const o of opts) {
          if (o.inc <= 0 || o.st.count < 1) continue;
          const s = o.roi;
          if (s >= cfg.roiMin && (!nb || s > nb.score)) nb = { ...o, score: s };
        }
        trickle = nb;
      }
    }
    // gold piling up with no payback send left in stock: put it into the most HP per gold that doesn't cost income,
    // so two careful players can't sit behind their mazes forever
    const bank = Math.max(500, myInc) * 6;
    if (!this.saving && this.sendAcc > bank) {
      let push = null;
      for (const o of opts) {
        if (o.inc < 0 || o.st.count < 1 || o.u.cost > this.sendAcc) continue;
        const s = o.one / o.u.cost * (1 + Math.max(0, o.roi));
        if (!push || s > push.score) push = { ...o, score: s };
      }
      let n = 0;
      while (push && push.st.count > 0 && this.sendAcc > bank * 0.5 && this.sendAcc >= push.u.cost && p.gold >= push.u.cost && n < cfg.maxSends) {
        const r = this.cmd({ type: 'send', unit: push.id });
        if (!r.ok) break;
        n++; this.sendAcc -= push.u.cost; this.stats.sends++; this.stats.sendGold += push.u.cost;
      }
      if (n) this.stats.pushes++;
    }
  }

  // A short summary for reports and debugging.
  summary() {
    const p = this.m.players[this.slot], lane = this.m.lanes[this.slot];
    return { slot: this.slot, level: this.level, gold: p.gold, income: p.income, lives: p.lives, towers: lane.towers.length,
      path: lane.pathLength(), share: +this.share.toFixed(2), need: +this.need.toFixed(2), kpMix: Math.round(this.kpMix),
      techOwned: Array.isArray(p.tech) ? p.tech.slice() : [], lumber: p.lumber, wisps: p.wisps, ...this.stats };
  }
}
