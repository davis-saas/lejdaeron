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
// Events: m.events holds match events (sent, stolen, eliminated, creepfix, income, message, won, over, skip, left;
// phase 3: tech, techLost, arcade, wisp, extra, extraOn, extraOff, chat, kicked; play: the build phase is over); each
// m.lanes[slot].events holds that lane's combat events (shot, impact, death, leak, build, upgrade, sell, bash, ...;
// phase 3: attack, damaged, hurt, destroyed, blast, reincarnate, reborn, evade). Consumers read and clear them
// (clearEvents() clears all).
//
// Phase 3 commands: { type: 'tech', id } spends a wisp on a tech building, { type: 'arcade', item: 'lumber' | 'wisp' }
// buys at the Arcade, { type: 'chat', text, towers?, tech? } says something and runs the map's chat commands,
// { type: 'destroy', tower | towers, tech? } kills your own towers or tech buildings. new Match({ ..., options: { extra } })
// turns '-onextra' off for a lobby (on by default, like the map).
//
// The build phase (the owner's adaptation, docs/SPEC-ltw.md): a match opens with options.prep seconds (PREP_TIME, 30, by
// default; 0 plays the map as it is) in phase 'prep', in which players build, upgrade, sell, raise tech and chat, but the
// shrines and the Arcade are shut, so no creep can come. The map's own timers (income, shop stock, Creep Fix and its
// warnings, victory checks, leaver sweeps, '-onextra') count from the end of the phase: m.playTime is the map's clock
// (negative during the phase), m.prepLeft the seconds the phase has left. m.time and m.ticks keep counting from the first
// tick (lanes, bots, events). The phase ends with a 'play' match event.
import { Lane, addGold, addLumber, requiresText, techUnlocks } from './lane.js?v=99dfd38af943';
import { LTW_RULES, LTW_UNITS, LTW_SHOPS, LTW_CREEP_FIX, LTW_COLORS, LTW_MESSAGES, LTW_TECH, LTW_TECH_ORDER, LTW_ARCADE, LTW_CHAT } from './data/ltw.js?v=99dfd38af943';
import { mulberry32 } from './rng.js?v=99dfd38af943';

export const TPS = 60;                 // fixed ticks per second
export const STEP = 1 / TPS;
export const MAX_STEP = 0.25;          // seconds of ticks one step(dt) call may run; a longer dt drops the rest
const T = (seconds) => Math.round(seconds * TPS);
const R = LTW_RULES;
const fail = (why) => ({ ok: false, why });
const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
const ARC = LTW_ARCADE;
export const PREP_TIME = 30;           // seconds of build phase before the shrines open (the owner's adaptation)
export const PREP_MAX = 300;           // the longest build phase a lobby may ask for
// "30 seconds", "1 second": a wait the build phase still has, rounded up, as the refusals and the console say it.
export function waitText(seconds) { const n = Math.max(1, Math.ceil(seconds - 1e-9)); return n + (n === 1 ? ' second' : ' seconds'); }
export const prepWhy = (left) => `The shrines open in ${waitText(left)}.`;
export const prepArcadeWhy = (left) => `The Arcade opens in ${waitText(left)}.`;

export class Match {
  constructor({ slots = [], seed = 1, rng = null, options = {} } = {}) {
    this.seed = seed;
    // Lobby options: extra (default true, like the map): whether '-onextra' works; prep: seconds of build phase.
    const prep = options && typeof options.prep === 'number' && options.prep >= 0 && options.prep <= PREP_MAX ? options.prep : PREP_TIME;
    this.options = { extra: (options && typeof options.extra === 'boolean') ? options.extra : LTW_RULES.extra, prep };
    this.prepTicks = T(prep);           // the map's clock starts when the build phase ends
    this.extra = { on: false, slot: null };   // the map's udg_cont / udg_player: one player at a time, first come
    this.rng = rng || mulberry32(seed);
    this.ticks = 0; this.time = 0; this.acc = 0;
    this.events = [];
    this.players = {}; this.lanes = {}; this.stock = {}; this.itemStock = {};
    this.ids = { next: 1 };             // one id counter for every lane of this match (ids never depend on other matches)
    const list = slots.map(s => (typeof s === 'number' ? { slot: s } : s)).sort((a, b) => a.slot - b.slot);
    for (const s of list) {
      if (!Number.isInteger(s.slot) || s.slot < 1 || s.slot > R.maxSlots) throw new Error('bad slot ' + s.slot);
      if (this.players[s.slot]) throw new Error('slot used twice: ' + s.slot);
      const color = LTW_COLORS[s.slot];
      const p = {
        slot: s.slot, name: s.name || color, color, kind: s.kind || 'human', difficulty: s.difficulty ?? null,
        gold: R.startGold, income: R.startIncome, lives: R.startLives, lumber: R.startLumber, wisps: R.startWisps,
        alive: true, left: false, leftAt: null, graceTicks: 0, kills: 0, eliminatedBy: null, eliminatedAt: null,
        tech: [],            // tech buildings owned, in purchase order (LTW_TECH ids)
        kicked: false,       // '-kick' by Red: defeated, removed at the next leaver sweep, cannot rejoin
        training: [],        // Arcade wisps in training: [{ doneAt }] (seconds of match time)
      };
      this.players[s.slot] = p;
      const lane = new Lane({ slot: s.slot, player: p, rng: this.rng, ids: this.ids });
      lane.match = this;
      this.lanes[s.slot] = lane;
      this.stock[s.slot] = {};
      this.itemStock[s.slot] = {};
    }
    // The ring: occupied slots in slot order, empty slots pruned. Eliminated players stay listed but are skipped.
    this.ring = list.map(s => s.slot);
    this.transit = [];                  // creeps stopped for 1 s at a skipped lane: { creep, lane, at }
    this.winner = null; this.phase = this.prepTicks > 0 ? 'prep' : 'playing'; this.overAt = null;
    this.timers = {
      income: T(R.incomeInterval), sweep: T(R.leaverSweep), victory: T(R.victoryInterval), victoryDelay: T(R.victoryDelay),
      skip: T(R.skipWait),
      fix: Object.fromEntries(Object.entries(LTW_CREEP_FIX.periods).map(([k, v]) => [k, T(v)])),
      warnings: LTW_CREEP_FIX.warnings.map(w => ({ every: T(w.period), text: w.text })),
      lag: LTW_CREEP_FIX.lag ? { every: T(LTW_CREEP_FIX.lag.period), text: LTW_CREEP_FIX.lag.text } : null,
    };
  }

  // ---------- queries ----------
  // The map's clock: seconds since the build phase ended (negative during it). Every map timer counts on it.
  get playTime() { return (this.ticks - this.prepTicks) / TPS; }
  get prepLeft() { return Math.max(0, this.prepTicks - this.ticks) / TPS; }
  // Seconds to the next income tick (the first comes one interval after the build phase).
  get incomeTimer() { const k = this.ticks - this.prepTicks, T = this.timers.income; return (k < 0 ? T - k : T - k % T) / TPS; }
  // The player in `slot`, or null. Slots are integers: '3' (a DOM dataset value, a JSON key) or 'toString' is not a slot,
  // because every ring check compares slots with ===.
  player(slot) { return Number.isInteger(slot) && Object.hasOwn(this.players, slot) ? this.players[slot] : null; }
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
  // The ring entry right after `slot`, living or not: where the map teleports a sent or leaked creep (depart_(N+1)).
  after(slot) {
    const ring = this.ring, n = ring.length;
    if (!n) return null;
    const i = ring.indexOf(slot);
    return ring[i >= 0 ? (i + 1) % n : Math.max(0, ring.findIndex(s => s > slot))];
  }

  // Shop stock for one player and unit, brought up to the current tick (WC3 shop rules from usma/usrg/usst). Ticks are
  // match ticks; a unit's start time counts from the end of the build phase.
  stockOf(slot, unit) {
    const u = LTW_UNITS[unit];
    let st = this.stock[slot][unit];
    if (!st) st = this.stock[slot][unit] = { count: 0, next: null, open: false, startTick: this.prepTicks + T(u.stock.start), regen: T(u.stock.replenish) };
    if (!st.open && this.ticks >= st.startTick) { st.open = true; st.count = u.stock.max; st.next = null; }
    while (st.next !== null && this.ticks >= st.next) {
      st.count++;
      st.next = st.count < u.stock.max ? st.next + st.regen : null;
    }
    return st;
  }
  // The Arcade's item stock for one player (WC3 item stock rules from isto/istr/isst, as for units).
  arcadeStock(slot) {
    const spec = ARC.lumber.stock, key = ARC.lumber.item;
    let st = this.itemStock[slot][key];
    if (!st) st = this.itemStock[slot][key] = { count: 0, next: null, open: false, startTick: this.prepTicks + T(spec.start), regen: T(spec.replenish) };
    if (!st.open && this.ticks >= st.startTick) { st.open = true; st.count = spec.max; st.next = null; }
    while (st.next !== null && this.ticks >= st.next) {
      st.count++;
      st.next = st.count < spec.max ? st.next + st.regen : null;
    }
    return st;
  }
  // What the Arcade (h02F) offers a player right now: lumber ('bois', I000) and a wisp (e005), with the training queue.
  arcade(slot) {
    const p = this.player(slot);
    if (!p) return null;
    const st = this.arcadeStock(slot), L = ARC.lumber, W = ARC.wisp;
    return {
      id: ARC.id, name: ARC.name,
      lumber: { item: L.item, name: L.name, cost: L.cost, lumber: L.lumber, stock: st.count, max: L.stock.max, available: st.open,
        opensIn: st.open ? 0 : (st.startTick - this.ticks) / TPS, restockIn: st.next === null ? null : (st.next - this.ticks) / TPS,
        why: this.whyNotArcade(slot, 'lumber') },
      wisp: { unit: W.unit, cost: W.cost, income: W.income, buildTime: W.buildTime, queue: p.training.map(q => q.doneAt - this.time),
        max: LTW_RULES.trainQueue, why: this.whyNotArcade(slot, 'wisp') },
    };
  }
  // Every tech building with what it unlocks and whether this player owns it or can raise it now.
  tech(slot) {
    const p = this.player(slot);
    return LTW_TECH_ORDER.map(id => {
      const t = LTW_TECH[id];
      return { id, name: t.name, element: t.element, tier: t.tier, requires: t.requires.slice(), unlocks: techUnlocks(id),
        description: t.description, owned: !!(p && p.tech.includes(id)), why: p ? this.whyNotTech(slot, id) : 'No such player.' };
    });
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
  //     | { type: 'leave', grace } | { type: 'tech', id } | { type: 'arcade', item: 'lumber' | 'wisp' }
  //     | { type: 'chat', text, towers?, tech? } | { type: 'destroy', tower?, towers?, tech? }.
  //     `slot` must be an integer slot of this match. `tower` is a tower id (or the tower object). A leave's grace is
  //     seconds, at most LTW_RULES.reconnectGrace (default 0). An eliminated player can only chat, and one who has left
  //     (or was kicked) can do nothing until they rejoin. During the build phase sends and the Arcade are refused
  //     ("The shrines open in 30 seconds.", "The Arcade opens in ..."). Returns { ok, why, ... }.
  command(slot, op) {
    const p = this.player(slot);
    if (!p) return fail('No such player.');
    if (!op || typeof op !== 'object') return fail('Bad command.');
    if (this.phase === 'over') return fail('The game is over.');
    if (op.type === 'chat') return this.chat(slot, op);   // eliminated players still talk (and their triggers still run)
    if (!p.alive) return fail('You have been eliminated.');
    if (p.left) return fail('You have already left.');   // gone (or kicked: CustomDefeatBJ), not yet swept
    if (op.type === 'leave') {
      const grace = op.grace ?? 0;
      if (typeof grace !== 'number' || !(grace >= 0) || grace === Infinity) return fail('Bad grace.');
      if (!this.leave(slot, { grace: Math.min(grace, R.reconnectGrace) })) return fail('You have already left.');
      return { ok: true, why: null };
    }
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
      case 'tech': return this.buyTech(slot, op.id);
      case 'arcade': return this.buyArcade(slot, op.item);
      case 'destroy': {
        const n = this.destroy(slot, op);
        return n ? { ok: true, why: null, destroyed: n } : fail('Nothing to destroy.');
      }
      default: return fail('Unknown command.');
    }
  }

  // ---------- phase 3: tech, the Arcade, chat ----------
  // A wisp walks into a tech circle (the map's fire / glace / elec / lumiere / ombre triggers and their tier-2 '1' / '2'
  // circles). A tier-2 circle does nothing without its tier-1 building (the trigger condition); a building the player
  // already owns shows "YOU HAVE ALREADY THIS TECHNOLOGIE  !!!" and the wisp survives; otherwise the wisp dies and the
  // building appears in the player's tech area.
  whyNotTech(slot, id) {
    const p = this.player(slot);
    if (!p) return 'No such player.';
    if (typeof id !== 'string' || !Object.hasOwn(LTW_TECH, id)) return 'Unknown technology.';
    const t = LTW_TECH[id];
    if (!p.alive) return 'You have been eliminated.';
    if (p.wisps < 1) return 'You have no wisp.';
    const miss = t.requires.filter(r => !p.tech.includes(r));
    if (miss.length) return requiresText(miss);
    if (p.tech.includes(id)) return t.owned;
    return null;
  }
  buyTech(slot, id) {
    const why = this.whyNotTech(slot, id);
    if (why) {
      if (LTW_TECH[id] && why === LTW_TECH[id].owned) this.message(slot, why);
      return fail(why);
    }
    const p = this.players[slot], t = LTW_TECH[id];
    if (t.consumes) p.wisps -= 1;
    p.tech.push(id);
    this.emit({ type: 'tech', slot, id, wisps: p.wisps });
    return { ok: true, why: null, id, wisps: p.wisps };
  }
  // The Arcade sells 'bois' (I000: +1 lumber, item stock) and trains e005 wisps (100000 gold; the wisp appears after
  // its build time, and the map's 'income wisp' trigger then takes 50000 income; 'wisp' moves it to the tech area).
  whyNotArcade(slot, item) {
    const p = this.player(slot);
    if (!p) return 'No such player.';
    if (!p.alive) return 'You have been eliminated.';
    if (item !== 'lumber' && item !== 'wisp') return 'Unknown item.';
    if (this.phase === 'prep') return prepArcadeWhy(this.prepLeft);
    if (item === 'lumber') {
      const st = this.arcadeStock(slot);
      if (!st.open) return 'Not available yet.';
      if (st.count < 1) return 'Out of stock.';
      if (p.gold < ARC.lumber.cost) return 'Not enough gold.';
      return null;
    }
    if (p.training.length >= LTW_RULES.trainQueue) return 'The training queue is full.';
    if (p.gold < ARC.wisp.cost) return 'Not enough gold.';
    if (p.lumber < ARC.wisp.lumber) return 'Not enough lumber.';
    return null;
  }
  buyArcade(slot, item) {
    const why = this.whyNotArcade(slot, item);
    if (why) return fail(why);
    const p = this.players[slot];
    if (item === 'lumber') {
      const st = this.arcadeStock(slot);
      p.gold -= ARC.lumber.cost;
      const got = addLumber(p, ARC.lumber.lumber);
      st.count--;
      if (st.next === null) st.next = this.ticks + st.regen;
      this.emit({ type: 'arcade', slot, item, gold: ARC.lumber.cost, lumber: got });
      return { ok: true, why: null, lumber: p.lumber };
    }
    p.gold -= ARC.wisp.cost; p.lumber -= ARC.wisp.lumber;
    const start = p.training.length ? p.training[p.training.length - 1].doneAt : this.time;
    const doneAt = start + ARC.wisp.buildTime;
    p.training.push({ doneAt });
    this.emit({ type: 'arcade', slot, item, gold: ARC.wisp.cost, lumber: ARC.wisp.lumber, doneAt });
    return { ok: true, why: null, doneAt };
  }
  // Trained wisps appear: +1 wisp and the map's income change for an e005 entering acheter_wisp.
  finishTraining() {
    for (const s of this.ring) {
      const p = this.players[s];
      while (p.training.length && p.training[0].doneAt <= this.time + 1e-9) {
        p.training.shift();
        p.wisps += 1; p.income += ARC.wisp.income;
        this.emit({ type: 'wisp', slot: s, wisps: p.wisps, income: ARC.wisp.income });
      }
    }
  }
  // Chat: everyone sees the line; exact-match commands (case does not matter in WC3 chat events) run their trigger:
  // -help, -income, -destroy (with the towers / tech buildings "selected": op.towers, op.tech), -onextra, -offextra,
  // and '-kick <colour>' for Red only. Returns { ok, why, command } (command: the trigger that ran, or null).
  chat(slot, op) {
    const p = this.players[slot];
    if (p.left) return fail('You have already left.');
    const text = typeof op.text === 'string' ? op.text.slice(0, 255) : '';
    if (!text) return fail('Nothing to say.');
    this.emit({ type: 'chat', slot, text });
    const cmd = LTW_CHAT.caseInsensitive ? text.toLowerCase() : text, C = LTW_CHAT;
    const may = (c) => c.players.includes(slot);
    let ran = null, out = {};
    if (cmd === C.help.text && may(C.help)) { ran = 'help'; this.message(slot, C.help.message, C.help.duration); }
    else if (cmd === C.income.text && may(C.income)) {
      ran = 'income';
      this.message(slot, fill(LTW_MESSAGES.yourIncome, { income: p.income }));
      this.incomeList(slot, C.income.line, C.income.duration);
    } else if (cmd === C.destroy.text && may(C.destroy)) { ran = 'destroy'; out.destroyed = p.alive ? this.destroy(slot, op) : 0; }
    else if (cmd === C.onextra.text && may(C.onextra)) {
      ran = 'onextra';
      if (this.options.extra && !this.extra.on) { this.extra = { on: true, slot }; this.emit({ type: 'extraOn', slot }); }
    } else if (cmd === C.offextra.text && may(C.offextra)) {
      ran = 'offextra';
      if (this.extra.on && this.extra.slot === slot) { this.extra.on = false; this.emit({ type: 'extraOff', slot }); }
    } else if (Object.hasOwn(C.kick, cmd)) {
      const k = C.kick[cmd];
      if (k.by.includes(slot)) { ran = 'kick'; out.kicked = this.kick(k.slot, slot, k.label); }
    }
    return { ok: true, why: null, command: ran, ...out };
  }
  // '-destroy': KillUnit on the player's own selected structures (towers in their lane and tech buildings), except the
  // shops and the Arcade. No refund. Returns how many died.
  destroy(slot, op) {
    const lane = this.lanes[slot], p = this.players[slot];
    let n = 0;
    const refs = [];
    if (op.tower !== undefined) refs.push(op.tower);
    if (Array.isArray(op.towers)) refs.push(...op.towers.slice(0, 400));
    for (const ref of refs) {
      const t = this.towerOf(slot, ref);
      if (t && lane.destroyTower(t, null, 'destroy')) n++;
    }
    if (Array.isArray(op.tech)) for (const id of op.tech.slice(0, 32)) {
      const i = typeof id === 'string' ? p.tech.indexOf(id) : -1;
      if (i < 0) continue;
      p.tech.splice(i, 1); n++;
      this.emit({ type: 'techLost', slot, id });
    }
    return n;
  }
  // '-kick <colour>' (Red only): the target's leaderboard label becomes "Kicked" and CustomDefeatBJ removes them, so
  // the next leaver sweep removes their units, as for a player who left. Returns whether anything happened.
  kick(target, by, label = 'Kicked') {
    const p = this.player(target);
    if (!p || !p.alive || p.kicked || target === by) return false;
    p.kicked = true; p.label = label;
    if (!p.left) this.leave(target, { grace: 0 });
    else p.graceTicks = 0;
    this.emit({ type: 'kicked', slot: target, by });
    return true;
  }
  send(slot, unit) {
    const u = typeof unit === 'string' && Object.hasOwn(LTW_UNITS, unit) ? LTW_UNITS[unit] : null, p = this.players[slot];
    if (!u || !u.sold) return fail('Unknown unit.');
    if (this.phase === 'prep') return fail(prepWhy(this.prepLeft));
    const st = this.stockOf(slot, unit);
    if (!st.open) return fail('Not available yet.');
    if (st.count < 1) return fail('Out of stock.');
    if (p.gold < u.cost) return fail('Not enough gold.');
    if (p.lumber < u.lumber) return fail('Not enough lumber.');
    const to = this.next(slot);   // where the creeps end up
    if (to === null || to === slot) return fail('No opponent left.');
    p.gold -= u.cost; p.lumber -= u.lumber;
    const income = u.income[String(slot)] || 0;   // the map's trigger value for this unit and buyer slot
    p.income += income;
    st.count--;
    if (st.next === null) st.next = this.ticks + st.regen;
    // The map puts them in depart_(N+1): the next lane in the ring. When that lane is dead they stop there for 1 s
    // (its 'Copier') before moving on, as they do at every dead lane on the way.
    const first = this.after(slot);
    for (let k = 0; k < u.copies; k++) {
      if (first === to) this.order(this.lanes[to].addCreep(u, { owner: slot }), to);
      else this.enter(this.lanes[first].makeCreep(u, { owner: slot }), first);
    }
    this.emit({ type: 'sent', from: slot, to, unit, n: u.copies, income });
    return { ok: true, why: null, to, n: u.copies, income };
  }
  // A player leaves: removed at the next leaver sweep once `grace` seconds have passed (0 offline, 60 online; the host
  // decides, see command() for what a player may ask). Until then creeps that enter their lane get no orders and stand
  // idle, as in the map (region_N only orders creeps while the slot is PLAYING).
  leave(slot, { grace = 0 } = {}) {
    const p = this.player(slot);
    if (!p || p.left || !p.alive) return false;
    p.left = true; p.leftAt = this.ticks; p.graceTicks = typeof grace === 'number' && grace > 0 && grace < Infinity ? T(grace) : 0;
    this.emit({ type: 'left', slot });
    return true;
  }
  // Back inside the grace (online only, an adaptation): the lane plays on and its idle creeps get their orders.
  rejoin(slot) {
    const p = this.player(slot);
    if (!p || !p.left || !p.alive || p.kicked) return false;
    p.left = false; p.leftAt = null;
    for (const c of this.lanes[slot].creeps) c.idle = false;
    this.emit({ type: 'rejoined', slot });
    return true;
  }

  // ---------- events ----------
  emit(e) { e.t = this.time; this.events.push(e); }
  // A map message to one slot (null: everyone). `duration` is the seconds the map shows a timed text for.
  message(to, text, duration) { const e = { type: 'message', to, text }; if (duration !== undefined) e.duration = duration; this.emit(e); }
  // The map's income list "1)  X" .. "11)  X", one message per slot. A slot nobody plays keeps the map's starting
  // income (Initialisation sets all 11).
  incomeList(to, line, duration) {
    for (let s = 1; s <= R.maxSlots; s++) {
      const q = this.players[s];
      this.message(to, fill(line, { slot: s, income: q ? q.income : R.startIncome }), duration);
    }
  }
  clearEvents() { this.events.length = 0; for (const s of this.ring) this.lanes[s].events.length = 0; }

  // ---------- simulation ----------
  // Runs the fixed ticks that dt covers. A bad dt (NaN, negative, Infinity) is ignored, and one call runs at most
  // MAX_STEP seconds of ticks: the rest is dropped, so a long pause (a background tab) never freezes the page.
  step(dt = STEP) {
    if (this.phase === 'over' || typeof dt !== 'number' || !(dt >= 0) || dt === Infinity) return 0;
    this.acc = Math.min(this.acc + dt, MAX_STEP);
    let n = 0;
    while (this.acc >= STEP - 1e-9 && this.phase !== 'over') { this.acc -= STEP; this.tick(); n++; }
    return n;
  }
  run(seconds) { const n = T(seconds); for (let i = 0; i < n && this.phase !== 'over'; i++) this.tick(); }
  tick() {
    this.ticks++; this.time = this.ticks / TPS;
    // k: the map's clock in ticks. The build phase ends on the tick the clock reaches 0, so with no build phase (or
    // after it) every timer fires on the same map tick as in the map.
    const k = this.ticks - this.prepTicks, tm = this.timers;
    if (this.phase === 'prep' && k >= 0) { this.phase = 'playing'; this.emit({ type: 'play' }); }
    // creeps that waited 1 s at a skipped lane move on
    if (this.transit.length) {
      const now = this.ticks, due = this.transit.filter(e => e.at <= now);
      if (due.length) {
        this.transit = this.transit.filter(e => e.at > now);
        for (const e of due) this.enter(e.creep, this.after(e.lane));
      }
    }
    for (const s of this.ring) this.lanes[s].step(STEP, this.time);
    for (const s of this.ring) {
      const lane = this.lanes[s];
      if (!lane.arrived.length) continue;
      const list = lane.arrived; lane.arrived = [];
      for (const c of list) this.leak(s, c);
    }
    if (this.ring.some(sl => this.players[sl].training.length)) this.finishTraining();
    if (k <= 0) return;   // the build phase: no map timer runs yet
    if (k % tm.income === 0) this.payIncome();
    if (k % tm.sweep === 0 && this.phase === 'playing') this.sweepLeavers();   // a declared winner is never swept
    for (const s of this.ring) {
      const every = tm.fix[String(s)];
      if (every && k % every === 0) { const killed = this.lanes[s].creepFix(); this.emit({ type: 'creepfix', lane: s, killed }); }
    }
    for (const w of tm.warnings) if (k % w.every === 0) this.message(null, w.text);
    if (tm.lag && k % tm.lag.every === 0) this.message(null, tm.lag.text);
    if (this.winner === null && this.overAt === null && k % tm.victory === 0) this.checkVictory();
    if (this.overAt !== null && this.ticks >= this.overAt) { this.phase = 'over'; this.emit({ type: 'over', winner: this.winner }); }
  }
  // A creep reaches lane `to` (the map teleports it into depart_N). The creep owner's own lane and a dead player's lane
  // stop it for 1 s (the map's 'Copier') and pass it on to the next lane in the ring, one lane at a time.
  enter(c, to) {
    if (to === null || !this.players[c.owner] || !this.players[c.owner].alive || !this.hasOpponent(c.owner)) return;
    if (to === c.owner || !this.players[to].alive) {
      this.transit.push({ creep: c, lane: to, at: this.ticks + this.timers.skip });
      this.emit({ type: 'skip', lane: to, creep: c.id, owner: c.owner });
      return;
    }
    this.order(this.lanes[to].addCreep(c.def, { owner: c.owner, from: c }), to);
  }
  // A creep now in living lane `to` gets its move order, unless that player has left and is not yet removed: then it
  // gets none and stands idle.
  order(c, to) { if (this.players[to].left) c.idle = true; return c; }
  // A creep reached the exit of lane L.
  leak(L, c) {
    const victim = this.players[L], owner = this.players[c.owner];
    // The owner was eliminated earlier in this tick, while this creep sat in a lane's arrival queue: it was removed
    // with the rest of their creeps, so it neither takes a life nor walks on.
    if (owner && !owner.alive) return;
    const before = victim.lives;
    this.enter(c, this.after(L));
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
  // Once the match is decided nobody else is eliminated.
  eliminate(slot, by = null, reason = 'lives') {
    const p = this.player(slot);
    if (!p || !p.alive || this.phase === 'won' || this.phase === 'over') return;
    p.alive = false; p.eliminatedAt = this.time; p.eliminatedBy = by;
    p.training = [];   // (an '-onextra' they turned on stays on, as the map's udg_player does: nobody else can take it)
    this.lanes[slot].clearTowers();
    for (const s of this.ring) this.lanes[s].removeOwned(slot);
    this.transit = this.transit.filter(e => e.creep.owner !== slot);
    if (by !== null) this.reward(by);
    this.emit({ type: 'eliminated', slot, by, reason });
  }
  payIncome() {
    // '-onextra': the player who turned it on gains Income / 10 (JASS integer division), compounding, before the pay
    if (this.extra.on) {
      const q = this.players[this.extra.slot];
      if (q) {
        const d = Math.trunc(q.income / LTW_CHAT.onextra.divisor);
        q.income += d;
        this.emit({ type: 'extra', slot: this.extra.slot, delta: d, income: q.income });
      }
    }
    for (const s of this.ring) {
      const p = this.players[s];
      if (p.alive) {
        addGold(p, p.income);   // documented choice: gold never goes below 0; the WC3 engine caps it at 1,000,000
        this.emit({ type: 'income', slot: s, gold: p.income, total: p.gold });
      }
      this.message(s, fill(LTW_MESSAGES.yourIncome, { income: p.income }));   // the map tells all 11 slots, the out ones too
    }
    // then everyone sees the whole list for 6 s (the map's Income trigger, as '-income' shows it on demand)
    this.incomeList(null, LTW_MESSAGES.incomeList.line, LTW_MESSAGES.incomeList.duration);
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
