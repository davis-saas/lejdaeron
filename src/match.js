// A Line Tower Wars match: one lane per player, the ring, sending, income, leaks and life theft, elimination, victory,
// Creep Fix and leavers, as docs/SPEC-ltw.md describes. Every number comes from src/data/ltw.js (generated from the map).
// Deterministic: a fixed 1/60 s step and one seeded random generator (injectable) drive everything, so the same seed and
// the same commands replay the same match.
//
//   const m = new Match({ slots: [{ slot: 1, name: 'You', kind: 'human' }, { slot: 2, kind: 'bot', difficulty: 'normal' }], seed: 7 });
//   m.command(1, { type: 'build', id: 'h003', c: 10, r: 3 });   // -> { ok, why }
//   m.command(1, { type: 'send', unit: 'n00E' });
//   m.step(dt);   // runs as many fixed 1/60 s ticks as dt covers
//
// Events: m.events holds match events (sent, stolen, eliminated, creepfix, income, message, won, over, skip, left);
// each m.lanes[slot].events holds that lane's combat events (shot, impact, death, leak, build, upgrade, sell, bash, ...).
// Consumers read and clear them (clearEvents() clears all).
import { Lane } from './lane.js';
import { LTW_RULES, LTW_UNITS, LTW_SHOPS, LTW_CREEP_FIX, LTW_COLORS, LTW_MESSAGES } from './data/ltw.js';
import { mulberry32 } from './rng.js';

export const TPS = 60;                 // fixed ticks per second
export const STEP = 1 / TPS;
const T = (seconds) => Math.round(seconds * TPS);
const R = LTW_RULES;
const fail = (why) => ({ ok: false, why });
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k]);

export class Match {
  constructor({ slots = [], seed = 1, rng = null } = {}) {
    this.seed = seed;
    this.rng = rng || mulberry32(seed);
    this.ticks = 0; this.time = 0; this.acc = 0;
    this.events = [];
    this.players = {}; this.lanes = {}; this.stock = {};
    const list = slots.map(s => (typeof s === 'number' ? { slot: s } : s)).sort((a, b) => a.slot - b.slot);
    for (const s of list) {
      if (!Number.isInteger(s.slot) || s.slot < 1 || s.slot > R.maxSlots) throw new Error('bad slot ' + s.slot);
      if (this.players[s.slot]) throw new Error('slot used twice: ' + s.slot);
      const color = LTW_COLORS[s.slot];
      const p = {
        slot: s.slot, name: s.name || color, color, kind: s.kind || 'human', difficulty: s.difficulty ?? null,
        gold: R.startGold, income: R.startIncome, lives: R.startLives, lumber: R.startLumber, wisps: R.startWisps,
        alive: true, left: false, leftAt: null, graceTicks: 0, kills: 0, eliminatedBy: null, eliminatedAt: null,
      };
      this.players[s.slot] = p;
      const lane = new Lane({ slot: s.slot, player: p, rng: this.rng });
      lane.match = this;
      this.lanes[s.slot] = lane;
      this.stock[s.slot] = {};
    }
    // The ring: occupied slots in slot order, empty slots pruned. Eliminated players stay listed but are skipped.
    this.ring = list.map(s => s.slot);
    this.transit = [];                  // creeps stopped for 1 s at a skipped lane: { creep, lane, at }
    this.winner = null; this.phase = 'playing'; this.overAt = null;
    this.timers = {
      income: T(R.incomeInterval), sweep: T(R.leaverSweep), victory: T(R.victoryInterval), victoryDelay: T(R.victoryDelay),
      skip: T(R.skipWait),
      fix: Object.fromEntries(Object.entries(LTW_CREEP_FIX.periods).map(([k, v]) => [k, T(v)])),
      warnings: LTW_CREEP_FIX.warnings.map(w => ({ every: T(w.period), text: w.text })),
      lag: LTW_CREEP_FIX.lag ? { every: T(LTW_CREEP_FIX.lag.period), text: LTW_CREEP_FIX.lag.text } : null,
    };
  }

  // ---------- queries ----------
  get incomeTimer() { return (this.timers.income - this.ticks % this.timers.income) / TPS; }
  alivePlayers() { return this.ring.filter(s => this.players[s].alive); }
  // The next living slot after `slot` in ring order (`slot` itself if it is the only one alive, null if none).
  next(slot) {
    const ring = this.ring, n = ring.length;
    if (!n) return null;
    let start = ring.indexOf(slot);
    if (start >= 0) start++;
    else { start = ring.findIndex(s => s > slot); if (start < 0) start = 0; }
    for (let k = 0; k < n; k++) { const s = ring[(start + k) % n]; if (this.players[s].alive) return s; }
    return null;
  }
  hasOpponent(slot) { return this.ring.some(s => s !== slot && this.players[s].alive); }

  // Shop stock for one player and unit, brought up to the current tick (WC3 shop rules from usma/usrg/usst).
  stockOf(slot, unit) {
    const u = LTW_UNITS[unit];
    let st = this.stock[slot][unit];
    if (!st) st = this.stock[slot][unit] = { count: 0, next: null, open: false, startTick: T(u.stock.start), regen: T(u.stock.replenish) };
    if (!st.open && this.ticks >= st.startTick) { st.open = true; st.count = u.stock.max; st.next = null; }
    while (st.next !== null && this.ticks >= st.next) {
      st.count++;
      st.next = st.count < u.stock.max ? st.next + st.regen : null;
    }
    return st;
  }
  // What a player's three shops offer right now (for the UI and bots).
  shop(slot) {
    return LTW_SHOPS.map(s => ({ id: s.id, name: s.name, units: s.units.map(id => {
      const u = LTW_UNITS[id], st = this.stockOf(slot, id);
      return { id, name: u.name, cost: u.cost, lumber: u.lumber, income: u.income[String(slot)], copies: u.copies,
        stock: st.count, max: u.stock.max, available: st.open, opensIn: st.open ? 0 : (st.startTick - this.ticks) / TPS,
        restockIn: st.next === null ? null : (st.next - this.ticks) / TPS };
    }) }));
  }
  towerOf(slot, ref) {
    const lane = this.lanes[slot];
    if (!lane) return null;
    return lane.towers.find(t => t === ref || t.id === ref) || null;
  }

  // ---------- commands ----------
  // op: { type: 'build', id, c, r } | { type: 'upgrade', tower, id } | { type: 'sell', tower } | { type: 'send', unit }
  //     | { type: 'leave', grace }. `tower` is a tower id (or the tower object). Returns { ok, why, ... }.
  command(slot, op) {
    const p = this.players[slot];
    if (!p) return fail('No such player.');
    if (!op || typeof op !== 'object') return fail('Bad command.');
    if (this.phase === 'over') return fail('The game is over.');
    if (op.type === 'leave') { this.leave(slot, op); return { ok: true, why: null }; }
    if (!p.alive) return fail('You have been eliminated.');
    const lane = this.lanes[slot];
    switch (op.type) {
      case 'build': {
        const why = lane.whyNot(op.id, op.c, op.r);
        if (why) return fail(why);
        const tower = lane.build(op.id, op.c, op.r);
        return { ok: true, why: null, tower: tower.id };
      }
      case 'upgrade': {
        const t = this.towerOf(slot, op.tower);
        if (!t) return fail('No such tower.');
        const why = lane.whyNotUpgrade(t, op.id);
        if (why) return fail(why);
        lane.upgrade(t, op.id);
        return { ok: true, why: null, tower: t.id };
      }
      case 'sell': {
        const t = this.towerOf(slot, op.tower);
        if (!t) return fail('No such tower.');
        if (!lane.sell(t)) return fail('Already selling.');
        return { ok: true, why: null, gold: lane.sellValue(t) };
      }
      case 'send': return this.send(slot, op.unit);
      default: return fail('Unknown command.');
    }
  }
  send(slot, unit) {
    const u = LTW_UNITS[unit], p = this.players[slot];
    if (!u || !u.sold) return fail('Unknown unit.');
    const st = this.stockOf(slot, unit);
    if (!st.open) return fail('Not available yet.');
    if (st.count < 1) return fail('Out of stock.');
    if (p.gold < u.cost) return fail('Not enough gold.');
    if (p.lumber < u.lumber) return fail('Not enough lumber.');
    const to = this.next(slot);
    if (to === null || to === slot) return fail('No opponent left.');
    p.gold -= u.cost; p.lumber -= u.lumber;
    const income = u.income[String(slot)] || 0;   // the map's trigger value for this unit and buyer slot
    p.income += income;
    st.count--;
    if (st.next === null) st.next = this.ticks + st.regen;
    const lane = this.lanes[to];
    for (let k = 0; k < u.copies; k++) lane.addCreep(u, { owner: slot });
    this.emit({ type: 'sent', from: slot, to, unit, n: u.copies, income });
    return { ok: true, why: null, to, n: u.copies, income };
  }
  // A player leaves: removed at the next leaver sweep once `grace` seconds have passed (0 offline, 60 online).
  leave(slot, { grace = 0 } = {}) {
    const p = this.players[slot];
    if (!p || p.left || !p.alive) return false;
    p.left = true; p.leftAt = this.ticks; p.graceTicks = T(grace);
    this.emit({ type: 'left', slot });
    return true;
  }
  rejoin(slot) {
    const p = this.players[slot];
    if (!p || !p.left || !p.alive) return false;
    p.left = false; p.leftAt = null;
    this.emit({ type: 'rejoined', slot });
    return true;
  }

  // ---------- events ----------
  emit(e) { e.t = this.time; this.events.push(e); }
  message(to, text) { this.emit({ type: 'message', to, text }); }
  clearEvents() { this.events.length = 0; for (const s of this.ring) this.lanes[s].events.length = 0; }

  // ---------- simulation ----------
  step(dt = STEP) {
    if (this.phase === 'over') return 0;
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP - 1e-9 && this.phase !== 'over') { this.acc -= STEP; this.tick(); n++; }
    return n;
  }
  run(seconds) { const n = T(seconds); for (let i = 0; i < n && this.phase !== 'over'; i++) this.tick(); }
  tick() {
    this.ticks++; this.time = this.ticks / TPS;
    const k = this.ticks, tm = this.timers;
    // creeps that waited 1 s at a skipped lane move on
    if (this.transit.length) {
      const due = this.transit.filter(e => e.at <= k);
      if (due.length) {
        this.transit = this.transit.filter(e => e.at > k);
        for (const e of due) this.enter(e.creep, this.next(e.lane));
      }
    }
    for (const s of this.ring) this.lanes[s].step(STEP, this.time);
    for (const s of this.ring) {
      const lane = this.lanes[s];
      if (!lane.arrived.length) continue;
      const list = lane.arrived; lane.arrived = [];
      for (const c of list) this.leak(s, c);
    }
    if (k % tm.income === 0) this.payIncome();
    if (k % tm.sweep === 0) this.sweepLeavers();
    for (const s of this.ring) {
      const every = tm.fix[String(s)];
      if (every && k % every === 0) { const killed = this.lanes[s].creepFix(); this.emit({ type: 'creepfix', lane: s, killed }); }
    }
    for (const w of tm.warnings) if (k % w.every === 0) this.message(null, w.text);
    if (tm.lag && k % tm.lag.every === 0) this.message(null, tm.lag.text);
    if (this.winner === null && this.overAt === null && k % tm.victory === 0) this.checkVictory();
    if (this.overAt !== null && k >= this.overAt) { this.phase = 'over'; this.emit({ type: 'over', winner: this.winner }); }
  }
  // Puts a creep into lane `to`. A lane that is the creep owner's or a dead player's makes it stop for 1 s (the map's
  // 'Copier'), then it skips on to the next living lane.
  enter(c, to) {
    if (to === null || !this.players[c.owner] || !this.players[c.owner].alive || !this.hasOpponent(c.owner)) return;
    if (to === c.owner || !this.players[to].alive) {
      this.transit.push({ creep: c, lane: to, at: this.ticks + this.timers.skip });
      this.emit({ type: 'skip', lane: to, creep: c.id, owner: c.owner });
      return;
    }
    this.lanes[to].addCreep(c.def, { owner: c.owner, from: c });
  }
  // A creep reached the exit of lane L.
  leak(L, c) {
    const victim = this.players[L], owner = this.players[c.owner];
    // The owner was eliminated earlier in this tick, while this creep sat in a lane's arrival queue: it was removed
    // with the rest of their creeps, so it neither takes a life nor walks on.
    if (owner && !owner.alive) return;
    const before = victim.lives;
    this.enter(c, this.next(L));
    const ownerName = owner ? owner.name : '?';
    this.message(L, fill(LTW_MESSAGES.stolenFromYou, { owner: ownerName }));
    if (before > 0 && owner) {
      this.message(c.owner, fill(LTW_MESSAGES.youStole, { victim: victim.name }));
      owner.lives += 1;
    }
    victim.lives -= 1;
    this.emit({ type: 'stolen', lane: L, from: L, to: c.owner, gained: before > 0 && !!owner, lives: victim.lives, unit: c.def.id });
    if (victim.lives === 0) {
      if (victim.alive) this.eliminate(L, c.owner);
      else this.reward(c.owner);   // a lane already removed (leaver) reaching 0 still pays the wisp, as in the map
    }
  }
  reward(by) {
    const p = this.players[by];
    if (!p) return;
    p.wisps += 1; p.kills += 1;
    this.message(by, LTW_MESSAGES.killedPlayer);
  }
  // Exactly 0 lives (or a leaver swept): towers and every creep the player owns are removed, the lane leaves the ring.
  eliminate(slot, by = null, reason = 'lives') {
    const p = this.players[slot];
    if (!p || !p.alive) return;
    p.alive = false; p.eliminatedAt = this.time; p.eliminatedBy = by;
    this.lanes[slot].clearTowers();
    for (const s of this.ring) this.lanes[s].removeOwned(slot);
    this.transit = this.transit.filter(e => e.creep.owner !== slot);
    if (by !== null) this.reward(by);
    this.emit({ type: 'eliminated', slot, by, reason });
  }
  payIncome() {
    for (const s of this.ring) {
      const p = this.players[s];
      if (!p.alive) continue;
      p.gold += p.income;
      if (p.gold < R.goldFloor) p.gold = R.goldFloor;   // documented choice: gold never goes below 0
      this.emit({ type: 'income', slot: s, gold: p.income, total: p.gold });
      this.message(s, fill(LTW_MESSAGES.yourIncome, { income: p.income }));
    }
  }
  sweepLeavers() {
    for (const s of this.ring) {
      const p = this.players[s];
      if (p.alive && p.left && this.ticks >= p.leftAt + p.graceTicks) this.eliminate(s, null, 'left');
    }
  }
  checkVictory() {
    const alive = this.alivePlayers();
    if (alive.length > 1) return;
    this.winner = alive.length ? alive[0] : null;
    this.phase = 'won';
    this.overAt = this.ticks + this.timers.victoryDelay;
    if (this.winner !== null) {
      const text = LTW_MESSAGES.won[String(this.winner)];
      this.emit({ type: 'won', slot: this.winner, text });
      this.message(null, text);
    }
  }
}
