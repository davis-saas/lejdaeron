// The client's copy of a vs Players match, rebuilt from the host's frames (src/net/host.js, bytes in protocol.js).
// `replica.world` has exactly the shape of the world model in docs/SPEC-client.md, so the renderer, the effects and
// the UI read it like a live Match:
// - Every lane is a real Lane (src/lane.js) whose towers mirror the host's, so towerAt, whyNot, whyNotUpgrade,
//   sellValue and the flow field answer exactly as the host's lane would. Its creeps are the replica's creeps.
// - Tower and creep objects keep their identity for as long as they exist, so renderer caches keep working.
// - Creep positions are interpolated between the host's samples, a little behind the host (one update interval plus
//   jitter), and world.time moves smoothly on the same clock. A creep appears and disappears on that clock too, so a
//   death effect plays where the creep was drawn.
// - Combat events (watched lane only) and match events are released when the clock reaches them, carrying replica
//   objects; missiles are flown locally from shot events with the engine's own flight rules and end on impact.
// Towers, gold, lives, income, tech and shop and Arcade stock are applied as soon as they arrive (they decide what the
// player may do). world.tech(slot) and world.arcade(slot) run the engine's own Match code on the mirrored state, so their
// reasons read exactly as the host's. The build phase: the phase comes in the frames and its length in START's options;
// world.prepLeft and the shop and Arcade countdowns run on the host's clock, playTime and incomeTimer on world.time.
import { Lane, tileIndex } from '../lane.js?v=a48717ff8443';
import { TOWERS } from '../data/towers.js?v=a48717ff8443';
import { LTW_UNITS, LTW_SHOPS, LTW_RULES, LTW_ARCADE } from '../data/ltw.js?v=a48717ff8443';
import { TILE } from '../field.js?v=a48717ff8443';
import { Match, TPS, PREP_TIME, PREP_MAX } from '../match.js?v=a48717ff8443';
import * as P from './protocol.js?v=a48717ff8443';
import { NET_TICKS, OTHER_TICKS } from './config.js?v=a48717ff8443';

const { F, LB, CM, CF, EV } = P;
const FAR = 1e9;                          // "until further notice" for slowUntil and stunUntil
const NO_POISON = Object.freeze([]), POISONED = Object.freeze([Object.freeze({ slow: 0 })]), POISON_SLOW = Object.freeze([Object.freeze({ slow: 1 })]);
const MAX_EXTRAP = 0.2 * TPS;             // ticks a creep may run on past its last sample
const SAMPLES = 12;                       // creep samples kept: 0.8 s of the watched lane, 4 s of the others
const MAX_SPIKE = 0.3;                    // the most extra distance (s) the clocks keep for a lossy link
const GRAVE = 3 * TPS;                    // removed towers stay resolvable for late events this long
const MAX_MISSILES = 800;
// The creep aura bonuses a flag stands for: each bonus has one value in the data (the same aura never stacks).
const BONUS = { moveBonus: 0, atkBonus: 0, dmgBonus: 0, regenBonus: 0, regenPct: 0 };
for (const u of Object.values(LTW_UNITS)) for (const a of u.auras || []) {
  BONUS.moveBonus = Math.max(BONUS.moveBonus, a.move || 0); BONUS.atkBonus = Math.max(BONUS.atkBonus, a.attack || 0);
  BONUS.dmgBonus = Math.max(BONUS.dmgBonus, a.damage || 0); BONUS.regenBonus = Math.max(BONUS.regenBonus, a.regen || 0);
  BONUS.regenPct = Math.max(BONUS.regenPct, a.regenPct || 0);
}
export class Resync extends Error {}

export class Replica {
  // start: the host's START message ({ you, ring, players: [{ slot, name, color, kind, difficulty }] })
  constructor(start, { now = () => performance.now() / 1000, onMatchEvent = () => {} } = {}) {
    this.me = start.you;
    this.now = now; this.onMatchEvent = onMatchEvent;
    this.seq = 0; this.synced = false; this.lastTick = 0;
    this.clock = { samples: [], offset: null, jitter: 0.01, spike: 0 };
    this.missileId = 0;
    this.world = new World(start);
    for (const s of this.world.ring) { const l = this.world.lanes[s]; l.interval = l.period = (s === this.me ? NET_TICKS : OTHER_TICKS) / TPS; }
    this.watching = this.world.lanes[this.me] ? this.me : this.world.ring[0];
    this.stats = { frames: 0, bytes: 0, resyncs: 0 };
  }
  watch(slot) {
    if (!this.world.lanes[slot] || slot === this.watching) return;
    const old = this.world.lanes[this.watching];
    if (old) { old.missiles.length = 0; old.pending.length = 0; }
    this.watching = slot;
  }

  // ---------------------------------------------------------------------------------------------------- frames
  // Applies one FRAME (r positioned after the type byte). Returns false if the client must ask for a full frame.
  frame(r, size = 0) {
    const flags = r.u8(), seq = r.uv(), tick = r.u32();
    const full = !!(flags & F.FULL);
    if (!full && (!this.synced || seq !== this.seq + 1)) return false;
    this.seq = seq; this.synced = true; this.lastTick = tick;
    this.stats.frames++; this.stats.bytes += size;
    const w = this.world, now = this.now();
    this.sample(tick, now);
    w.tick = Math.max(w.tick, tick);
    if (flags & F.PHASE) {
      w.phase = P.PHASES[r.u8()] || 'playing'; const win = r.u8(); w.winner = win || null;
      const on = r.u8(), by = r.u8(); w.extra.on = !!on; w.extra.slot = by || null;
    }
    if (flags & F.BOARD) {
      for (let n = r.u8(); n > 0; n--) {
        const slot = r.u8(), p = w.players[slot] || {}, ls = w.lanes[slot] ? w.lanes[slot].stats : {};
        const bits = r.u8();
        p.alive = !!(bits & 1); p.left = !!(bits & 2); p.kicked = !!(bits & 4);
        p.gold = r.num(); p.income = r.num(); p.lives = r.num(); p.lumber = r.num(); p.wisps = r.num(); p.kills = r.num();
        const by = r.u8(); p.eliminatedBy = by || null;
        ls.kills = r.num(); ls.leaks = r.num(); ls.built = r.num(); ls.destroyed = r.num();
      }
    }
    if (flags & F.TECH) {
      for (let n = r.u8(); n > 0; n--) {
        const slot = r.u8(), p = w.players[slot] || {}, bits = r.u8();
        p.eliminatedAt = bits & 1 ? r.num() : null;
        if (bits & 2) p.label = r.str(64); else delete p.label;
        const tech = [];
        for (let k = r.u8(); k > 0; k--) { const id = P.TECH_IDS[r.u8()]; if (id) tech.push(id); }
        const training = [];
        for (let k = r.u8(); k > 0; k--) training.push({ doneAt: r.num() });
        p.tech = tech; p.training = training;
      }
    }
    if (flags & F.SHOP) {
      for (let n = r.u8(); n > 0; n--) {
        const i = r.u8(), count = r.u8(), bits = r.u8(), next = bits & 2 ? r.u32() : null;
        const id = P.SOLD[i];
        if (id) w.stock[id] = { count, open: !!(bits & 1), next };
      }
    }
    if (flags & F.ARCADE) { const count = r.u8(), bits = r.u8(), next = bits & 2 ? r.u32() : null; w.lumberStock = { count, open: !!(bits & 1), next }; }
    const seen = new Set();
    for (let n = r.u8(); n > 0; n--) {
      const slot = r.u8(), bits = r.u8(), lane = w.lanes[slot];
      if (!lane) throw new Resync('unknown lane');
      seen.add(slot);
      if (bits & LB.TOWERS) this.towers(lane, r, tick, full);
      else if (full) this.clearTowers(lane);
      if (bits & LB.CREEPS) this.creeps(lane, r, tick);
      else if (full) this.clearCreeps(lane, tick);
      if (bits & LB.TSTATS) this.towerStats(lane, r, tick);
      if (bits & LB.EVENTS) this.events(lane, r, tick);
    }
    if (full) for (const s of w.ring) if (!seen.has(s)) { this.clearTowers(w.lanes[s]); this.clearCreeps(w.lanes[s], tick); }
    if (flags & F.MEVENTS) {
      let list = [];
      try { list = JSON.parse(r.str()); } catch { list = []; }
      if (Array.isArray(list)) for (const e of list) if (e && typeof e === 'object' && typeof e.type === 'string') w.pending.push(e);
    }
    return true;
  }
  towers(lane, r, tick, full) {
    const base = r.uv(), ver = r.uv();
    if (base !== 0 && base !== lane.towerVer) throw new Resync('tower version');
    const list = base === 0, keep = list ? new Set() : null;
    const hostTime = tick / TPS;
    for (let n = r.uv(); n > 0; n--) {
      const id = r.uv(), def = TOWERS[P.TOWER_IDS[r.u8()]], c = r.u8(), row = r.u8(), bits = r.u8();
      const building = bits & 2 ? r.u8() / P.BT : 0, total = bits & 2 ? r.u8() / P.BT : 0;
      const sellIn = bits & 1 ? r.u8() / P.BT : null;
      const spent = r.num(), hp = r.uv(), maxHp = r.uv(), kills = r.uv();
      if (!def) throw new Resync('unknown tower');
      let t = lane.byId.get(id);
      if (!t) {
        t = { id, def, c, r: row, x: c + 0.5, y: row + 0.5, building: 0, buildTotal: 1, sold: false, spent, owner: lane.slot,
          kills: 0, hp, maxHp, cd: 0, target: null, aim: 0, firedAt: 0 };
        lane.byId.set(id, t);
      }
      t.def = def; t.c = c; t.r = row; t.x = c + 0.5; t.y = row + 0.5; t.spent = spent; t.hp = hp; t.maxHp = maxHp; t.kills = kills; t.statTick = tick;
      t.doneAt = hostTime + building; t.building = building; if (total) t.buildTotal = total;
      if (sellIn !== null) t.sellAt = hostTime + sellIn; else delete t.sellAt;
      if (keep) keep.add(id);
    }
    for (const [id, g] of lane.grave) if (g.at < hostTime - GRAVE / TPS) lane.grave.delete(id);
    for (let n = r.uv(); n > 0; n--) { const v = r.uv(); this.dropTower(lane, Math.floor(v / 2), hostTime, v % 2 === 1); }
    if (keep) for (const id of [...lane.byId.keys()]) if (!keep.has(id)) this.dropTower(lane, id, hostTime);
    lane.towerVer = ver;
    this.mirror(lane);
  }
  dropTower(lane, id, hostTime, destroyed = false) {
    const t = lane.byId.get(id);
    if (!t) return;
    lane.byId.delete(id); t.sold = true;
    if (destroyed) { t.destroyed = true; t.hp = 0; }
    lane.grave.set(id, { t, at: hostTime });
  }
  // Hit points and kills of towers that changed (they arrive with the lane's creep updates). statTick: the host tick of
  // a tower's latest numbers.
  towerStats(lane, r, tick) {
    for (let n = r.uv(); n > 0; n--) {
      const id = r.uv(), hp = r.uv(), kills = r.uv(), t = lane.byId.get(id);
      if (t) { t.hp = hp; t.kills = kills; t.statTick = tick; }
    }
  }
  clearTowers(lane) {
    if (!lane.byId.size && !lane.towerVer) return;
    for (const id of [...lane.byId.keys()]) this.dropTower(lane, id, this.world.tick / TPS);
    lane.towerVer = 0;
    this.mirror(lane);
  }
  // Puts the mirrored towers into the lane's grid and rebuilds its flow field (what Lane.build and sell do).
  mirror(lane) {
    lane.towers = [...lane.byId.values()].sort((a, b) => a.id - b.id);
    lane.occupied.clear(); lane.blocked.fill(0);
    for (const t of lane.towers) { const i = tileIndex(t.c, t.r); lane.occupied.set(i, t); lane.blocked[i] = 1; }
    lane.towersChanged();
  }
  creeps(lane, r, tick) {
    lane.period = r.u8() / TPS;
    const old = lane.tracked, out = [];
    let oi = 0, id = 0;
    for (let n = r.uv(); n > 0; n--) {
      id += r.uv();
      const mask = r.u8();
      while (oi < old.length && old[oi].id < id) this.creepGone(lane, old[oi++], tick);
      let c = oi < old.length && old[oi].id === id ? old[oi++] : null;
      if (mask & CM.NEW) {
        const def = LTW_UNITS[P.UNIT_IDS[r.u8()]], owner = r.u8(), maxHp = r.num();
        const qx = r.u16(), qy = r.u16(), hp = r.u16(), fl = r.uv(), ta = mask & CM.TARGET ? r.uv() : 0;
        if (!def) throw new Resync('unknown unit');
        if (!c || c.def !== def) c = lane.creepById.get(id);
        if (!c || c.def !== def) c = newCreep(id, def, owner, tick);
        else if (c.goneTick !== null) { c._n = 0; c.bornTick = tick; }   // the same creep back in this lane: start over
        c.owner = owner; c.maxHp = maxHp; c.qx = qx; c.qy = qy; c.qh = hp; c.qf = fl; c.qa = ta; c.goneTick = null; c.dead = false;
        if (c._n === 0) { c.x = qx / P.Q; c.y = qy / P.Q; }
        lane.creepById.set(id, c);
      } else {
        if (!c) throw new Resync('unknown creep');
        if (mask & CM.DELTA) { c.qx += r.sv(); c.qy += r.sv(); }
        if (mask & CM.ABS) { c.qx = r.u16(); c.qy = r.u16(); }
        if (mask & CM.HP) c.qh = r.u16();
        if (mask & CM.FLAGS) c.qf = r.uv();
        if (mask & CM.TARGET) c.qa = r.uv();
      }
      push(c, tick);
      out.push(c);
    }
    while (oi < old.length) this.creepGone(lane, old[oi++], tick);
    lane.tracked = out; lane.lastUpdate = tick;
  }
  creepGone(lane, c, tick) { if (c.goneTick === null || c.goneTick > tick) c.goneTick = tick; }
  clearCreeps(lane, tick) { for (const c of lane.tracked) this.creepGone(lane, c, tick); lane.tracked = []; }

  events(lane, r, tick) {
    const tower = (id) => lane.byId.get(id) || lane.grave.get(id)?.t || null;
    const creep = () => {
      const v = r.uv();
      if (v === 0) return null;
      const id = Math.floor(v / 2);
      if (v % 2) {   // a creep the client never had: drawn from what the event carries
        const def = LTW_UNITS[P.UNIT_IDS[r.u8()]], owner = r.u8(), x = r.u16() / P.Q, y = r.u16() / P.Q;
        if (!def) return null;
        const c = newCreep(id, def, owner, tick);
        c.x = x; c.y = y; c.dead = true; c.hp = 0;
        return c;
      }
      return lane.creepById.get(id) || null;
    };
    const what = () => { const k = r.u8(); return k === 1 ? tower(r.uv()) : k === 2 ? creep() : null; };
    for (let n = r.uv(); n > 0; n--) {
      const at = tick - r.u8(), code = r.u8();
      let e = null;
      switch (code) {
        case EV.shot: { const t = tower(r.uv()), c = creep(); if (t && c) e = { type: 'shot', tower: t, target: c }; break; }
        case EV.impact: {
          const t = tower(r.uv()), c = creep(), x = r.u16() / P.Q, y = r.u16() / P.Q;
          if (t) e = { type: 'impact', tower: t, creep: c, x, y, missile: t.def.missile, splash: t.def.splash && t.def.weapon !== 'mbounce' ? t.def.splash : null };
          break;
        }
        case EV.death: {
          const c = creep(), gold = r.num(), fix = r.u8(), to = r.u8();
          if (c) { e = { type: 'death', creep: c, gold, to: to || null }; if (fix) e.fix = true; this.endsAt(c, at); }
          break;
        }
        case EV.leak: { const c = creep(); if (c) { e = { type: 'leak', creep: c }; this.endsAt(c, at); } break; }
        case EV.bash: { const c = creep(); if (c) e = { type: 'bash', creep: c }; break; }
        case EV.spawn: { const c = creep(), from = creep(); if (c) e = { type: 'spawn', creep: c, from }; break; }
        case EV.build: case EV.upgrade: case EV.selling: {
          const t = tower(r.uv());
          if (t) e = { type: code === EV.build ? 'build' : code === EV.upgrade ? 'upgrade' : 'selling', tower: t };
          if (t && code === EV.selling) e.at = t.sellAt;
          break;
        }
        case EV.sell: { const t = tower(r.uv()), gold = r.num(); if (t) e = { type: 'sell', tower: t, gold }; break; }
        case EV.removeTower: {
          const t = tower(r.uv()), destroyed = r.u8();
          if (t) { e = { type: 'remove', tower: t }; if (destroyed) e.reason = 'destroyed'; }
          break;
        }
        case EV.removeCreep: { const c = creep(); if (c) { e = { type: 'remove', creep: c }; this.endsAt(c, at); } break; }
        case EV.attack: { const c = creep(), T = what(); if (c) e = { type: 'attack', creep: c, target: T, tower: T && T.def.upgrades ? T : null }; break; }
        case EV.damaged: { const t = tower(r.uv()), c = creep(), amount = r.fix(), hp = r.fix(); if (t) e = { type: 'damaged', tower: t, creep: c, amount, hp }; break; }
        case EV.hurt: {
          const c = creep(), by = creep(), owner = r.u8(), amount = r.fix(), hp = r.fix();
          if (c) e = { type: 'hurt', creep: c, by, owner, amount, hp };
          break;
        }
        case EV.destroyed: {
          const t = tower(r.uv()), by = creep(), reason = P.DESTROY_REASONS[r.u8()] || 'attack';
          if (t) { t.destroyed = true; t.hp = 0; e = { type: 'destroyed', tower: t, by, reason }; }
          break;
        }
        case EV.blast: {
          const x = r.u16() / P.Q, y = r.u16() / P.Q, owner = r.u8(), radius = r.num(), c = creep();
          e = { type: 'blast', x, y, owner, radius, creep: c };
          break;
        }
        case EV.reincarnate: { const c = creep(), t = r.num(); if (c) { c.reviveAt = t; e = { type: 'reincarnate', creep: c, at: t }; } break; }
        case EV.reborn: { const c = creep(); if (c) e = { type: 'reborn', creep: c }; break; }
        case EV.evade: { const c = creep(), by = creep(); if (c) e = { type: 'evade', creep: c, by }; break; }
        case EV.other: {
          let o = null;
          try { o = JSON.parse(r.str()); } catch { o = null; }
          if (o && typeof o.type === 'string') {
            for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object' && typeof v.id === 'number') o[k] = v.kind === 'tower' ? tower(v.id) : lane.creepById.get(v.id) || null;
            e = o;
          }
          break;
        }
        default: throw new Resync('unknown event');
      }
      if (e && lane.slot === this.watching) lane.pending.push({ at, e });
    }
  }
  endsAt(c, tick) { if (c.goneTick !== null && tick < c.goneTick) c.goneTick = Math.max(tick, c._t[0]); }

  // ---------------------------------------------------------------------------------------------------- clock
  // The host's clock, estimated from frame arrivals: host time minus local time, taken as the best (largest) recent
  // sample, which is the one that travelled fastest. Jitter is how far typical samples fall behind it; spike is the
  // worst recent lateness (a resent packet on a lossy link), remembered for a few seconds, so the clocks keep enough
  // distance from the newest data on a bad link and close in again on a good one.
  sample(tick, now) {
    const k = this.clock, o = tick / TPS - now;
    k.samples.push([now, o]);
    while (k.samples.length > 1 && k.samples[0][0] < now - 3) k.samples.shift();
    let best = -Infinity;
    for (const s of k.samples) if (s[1] > best) best = s[1];
    if (k.offset === null || Math.abs(best - k.offset) > 1) k.offset = best;
    else k.offset += (best - k.offset) * 0.2;
    const late = Math.max(0, k.offset - o);
    k.jitter += (late - k.jitter) * 0.05;
    k.spike = Math.min(MAX_SPIKE, Math.max(k.spike * 0.99, late));
  }
  hostNow() { return this.clock.offset === null ? 0 : this.now() + this.clock.offset; }

  // ---------------------------------------------------------------------------------------------------- per frame
  tick(realDt = 1 / 60) {
    const w = this.world;
    if (!this.synced) return;
    const host = this.hostNow(), dt = Math.max(0, Math.min(0.25, realDt));
    w.tick = Math.max(w.tick, host * TPS);
    const margin = 0.02 + Math.max(2 * this.clock.jitter, this.clock.spike);
    for (const s of w.ring) {
      const lane = w.lanes[s];
      lane.interval += (lane.period - lane.interval) * Math.min(1, dt * 3);   // eases a rate change (a new watch)
      const target = lane.interval + margin;
      lane.delay = lane.delay === null ? target : lane.delay + (target - lane.delay) * Math.min(1, dt * 2);
      const rt = (host - lane.delay) * TPS;
      lane.rt = rt - lane.rt > 2 * TPS || lane.rt === 0 ? rt : Math.max(lane.rt, rt);
      lane.time = lane.rt / TPS;
      this.place(lane, dt);
      if (s === this.watching) this.release(lane);
      this.fly(lane, dt);
      for (const t of lane.towers) if (t.building > 0) t.building = Math.max(0, t.doneAt - host);
    }
    const wl = w.lanes[this.watching];
    const wt = wl ? wl.time : host - 0.1;
    w.time = wt - w.time > 2 || w.time === 0 ? wt : Math.max(w.time, wt);
    while (w.pending.length && Math.round(w.pending[0].tick) <= w.time * TPS + 1e-6) {
      const e = w.pending.shift();
      w.events.push(e);
      this.onMatchEvent(e);
    }
    if (w.events.length > 2000) w.events.splice(0, w.events.length - 1000);
  }
  // Moves every creep of a lane to the lane's clock and rebuilds the list the client sees.
  place(lane, dt) {
    const rt = lane.rt, list = lane.creeps;
    list.length = 0;
    for (const c of lane.tracked) if (c.bornTick <= rt) { interp(c, rt); list.push(c); }
    for (const [id, c] of lane.creepById) {   // creeps the host has removed, still shown until the clock gets there
      if (c.goneTick === null) continue;
      if (rt >= c.goneTick) { c.dead = true; c.attacking = null; lane.creepById.delete(id); }
      else if (c.bornTick <= rt) { interp(c, rt); list.push(c); }
    }
    for (const c of list) {   // what an attacker is hitting: a tower (odd ref) or a creep of this lane
      const a = c.ta;
      c.attacking = !a ? null : a % 2 ? lane.byId.get((a - 1) / 2) || null : lane.creepById.get(a / 2) || null;
    }
    lane.visEpoch++;
  }
  release(lane) {
    const rt = lane.rt;
    while (lane.pending.length && lane.pending[0].at <= rt) {
      const { e } = lane.pending.shift();
      lane.events.push(e);
      if (e.type === 'shot') this.shoot(lane, e.tower, e.target);
      else if (e.type === 'impact') this.land(lane, e.tower, e.creep);
      else if (e.type === 'attack') e.creep.firedAt = lane.time;
    }
    if (lane.events.length > 3000) lane.events.splice(0, lane.events.length - 1500);
  }
  // A shot: the tower turns and flashes, and missile weapons get a missile, flown like Field.fly flies it.
  shoot(lane, t, c) {
    t.aim = Math.atan2(c.y - t.y, c.x - t.x); t.firedAt = lane.time; t.target = c;
    const d = t.def;
    if (d.weapon === 'instant' || d.weapon === 'normal' || lane.missiles.length >= MAX_MISSILES) return;
    const m = { id: -(++this.missileId), tower: t, def: d, target: c, x: t.x, y: t.y - 0.45, sx: t.x, sy: t.y - 0.45,
      tx: c.x, ty: c.y, speed: d.missileSpeed / TILE, done: false, t: 0 };
    if (d.weapon === 'artillery') m.flight = Math.max(0.35, Math.hypot(m.tx - m.x, m.ty - m.y) / m.speed);
    lane.missiles.push(m);
  }
  land(lane, t, c) {
    for (const m of lane.missiles) if (!m.done && m.tower === t && (c ? m.target === c : !!m.flight)) { m.done = true; break; }
  }
  fly(lane, dt) {
    const list = lane.missiles;
    if (!list.length) return;
    for (const m of list) {
      if (m.done) continue;
      m.t += dt;
      if (m.flight) {
        const k = Math.min(1, m.t / m.flight);
        m.x = m.sx + (m.tx - m.sx) * k; m.y = m.sy + (m.ty - m.sy) * k; m.arc = Math.sin(Math.PI * k);
        if (k >= 1 && m.t > m.flight + 0.25) m.done = true;   // the impact event normally ends it first
        continue;
      }
      const c = m.target;
      if (!c.dead) { m.tx = c.x; m.ty = c.y; }
      const dx = m.tx - m.x, dy = m.ty - m.y, d = Math.hypot(dx, dy), s = m.speed * dt;
      m.ang = Math.atan2(dy, dx);
      if (d <= s) { m.x = m.tx; m.y = m.ty; m.done = true; continue; }
      m.x += dx / d * s; m.y += dy / d * s;
      if (m.t > 6) m.done = true;
    }
    if (list.some(m => m.done)) lane.missiles = list.filter(m => !m.done);
  }
}

// ---------------------------------------------------------------------------------------------------- the world
class World {
  constructor(start) {
    this.time = 0; this.tick = 0; this.me = start.you;
    const o = start.options && typeof start.options === 'object' ? start.options : {};
    const prep = typeof o.prep === 'number' && o.prep >= 0 && o.prep <= PREP_MAX ? o.prep : PREP_TIME;
    this.options = { extra: typeof o.extra === 'boolean' ? o.extra : LTW_RULES.extra, prep };
    this.prepTicks = Math.round(prep * TPS);
    this.phase = this.prepTicks > 0 ? 'prep' : 'playing'; this.winner = null;   // until the first frame says
    this.ring = start.ring.slice();
    this.extra = { on: false, slot: null };
    this.players = {}; this.lanes = {}; this.events = []; this.pending = []; this.stock = {}; this.lumberStock = null;
    for (const q of start.players) {
      this.players[q.slot] = { slot: q.slot, name: q.name, color: q.color, kind: q.kind, difficulty: q.difficulty ?? null,
        gold: LTW_RULES.startGold, income: LTW_RULES.startIncome, lives: LTW_RULES.startLives, lumber: LTW_RULES.startLumber,
        wisps: LTW_RULES.startWisps, alive: true, left: false, kills: 0, eliminatedBy: null, eliminatedAt: null,
        tech: [], kicked: false, training: [] };
    }
    for (const s of this.ring) this.lanes[s] = replicaLane(s, this.players[s]);
  }
  get ticks() { return Math.floor(this.tick); }
  // As the Match's: the map's clock (on world.time, negative in the build phase), and what the phase has left on the
  // host's clock, as the shop's countdowns (the phase ends when the host's frame says so).
  get playTime() { return this.time - this.prepTicks / TPS; }
  get prepLeft() { return this.phase === 'prep' ? Math.max(0, this.prepTicks - this.tick) / TPS : 0; }
  get incomeTimer() {
    const T = Math.round(LTW_RULES.incomeInterval * TPS), k = Math.round(this.time * TPS) - this.prepTicks;
    return (k < 0 ? T - k : T - k % T) / TPS;
  }
  // As Match.tech, whyNotTech, arcade and whyNotArcade: the engine's own code on the mirrored players and stock.
  player(slot) { return Match.prototype.player.call(this, slot); }
  tech(slot) { return Match.prototype.tech.call(this, slot); }
  whyNotTech(slot, id) { return Match.prototype.whyNotTech.call(this, slot, id); }
  arcade(slot) { return Match.prototype.arcade.call(this, slot); }
  whyNotArcade(slot, item) { return Match.prototype.whyNotArcade.call(this, slot, item); }
  // The Arcade's lumber stock: streamed for your own slot; other slots show it as it opens by the clock.
  arcadeStock(slot) {
    const spec = LTW_ARCADE.lumber.stock, startTick = this.prepTicks + Math.round(spec.start * TPS), regen = Math.round(spec.replenish * TPS);
    const own = slot === this.me && this.lumberStock;
    const st = own || { count: this.ticks >= startTick ? spec.max : 0, open: this.ticks >= startTick, next: null };
    return { count: st.count, next: st.next, open: st.open, startTick, regen };
  }
  // The next living slot after `slot` in ring order, as Match.next.
  next(slot) {
    const ring = this.ring, n = ring.length;
    if (!n) return null;
    let start = ring.indexOf(slot);
    if (start >= 0) start++;
    else { start = ring.findIndex(s => s > slot); if (start < 0) start = 0; }
    for (let k = 0; k < n; k++) { const s = ring[(start + k) % n]; if (this.players[s].alive) return s; }
    return null;
  }
  // As Match.shop. Stock is streamed for your own slot only; other slots show the shop as it opens by the clock.
  shop(slot) {
    const tick = this.tick;
    return LTW_SHOPS.map(s => ({ id: s.id, name: s.name, units: s.units.map(id => {
      const u = LTW_UNITS[id], start = this.prepTicks + Math.round(u.stock.start * TPS);
      const st = this.stock[id] && slot === this.me ? this.stock[id] : { count: tick >= start ? u.stock.max : 0, open: tick >= start, next: null };
      return { id, name: u.name, cost: u.cost, lumber: u.lumber, income: u.income[String(slot)], copies: u.copies,
        stock: st.count, max: u.stock.max, available: st.open, opensIn: st.open ? 0 : Math.max(0, (start - tick) / TPS),
        restockIn: st.next === null ? null : Math.max(0, (st.next - tick) / TPS) };
    }) }));
  }
}

// A real Lane, used as the mirror of the host's: its towers are set by the replica, never built here.
function replicaLane(slot, player) {
  const lane = new Lane({ slot, player });
  // period: seconds between this lane's creep updates, as the host last said; the lane's clock stays that far (plus
  // jitter) behind the host so there is always a newer sample to move towards
  Object.assign(lane, { byId: new Map(), grave: new Map(), towerVer: 0, tracked: [], creepById: new Map(), pending: [],
    rt: 0, delay: null, interval: 4 / TPS, period: 4 / TPS, lastUpdate: null });
  lane.visible = (c) => !c.def.invisible || !!c.seen;   // the host's true-sight answer travels with each creep
  return lane;
}

function newCreep(id, def, owner, tick) {
  return { id, def, owner, x: 0, y: 0, dirx: 1, diry: 0, hp: def.hp, maxHp: def.hp, slowPct: 0, slowUntil: 0, auraSlow: 0,
    poisons: NO_POISON, stunUntil: 0, walk: Math.random() * 10, dead: false, seen: true,
    attacking: null, firedAt: 0, reviving: false, reviveAt: null, moveBonus: 0, atkBonus: 0, dmgBonus: 0, regenBonus: 0, regenPct: 0,
    qx: 0, qy: 0, qh: P.HPQ, qf: CF.SEEN, qa: 0, ta: 0, bornTick: tick, goneTick: null,
    _n: 0, _t: new Float64Array(SAMPLES), _x: new Float32Array(SAMPLES), _y: new Float32Array(SAMPLES), _h: new Uint16Array(SAMPLES),
    _f: new Uint16Array(SAMPLES), _a: new Float64Array(SAMPLES) };
}
// Adds the creep's newest sample (keeps the last SAMPLES, enough to cover the clock's distance behind the host).
function push(c, tick) {
  let n = c._n;
  if (n && c._t[n - 1] >= tick) n--;          // the same tick twice (a full frame after a delta): replace it
  if (n === SAMPLES) { for (const a of [c._t, c._x, c._y, c._h, c._f, c._a]) a.copyWithin(0, 1); n--; }
  c._t[n] = tick; c._x[n] = c.qx / P.Q; c._y[n] = c.qy / P.Q; c._h[n] = c.qh; c._f[n] = c.qf; c._a[n] = c.qa;
  c._n = n + 1;
}
// The creep at render tick rt: position interpolated between samples (or run on briefly past the last one), hp and
// flags from the latest sample at or before rt.
function interp(c, rt) {
  const n = c._n, T = c._t, X = c._x, Y = c._y;
  if (!n) return;
  let x, y, k, vx = 0, vy = 0;
  if (n === 1 || rt <= T[0]) { x = X[0]; y = Y[0]; k = 0; if (n > 1) { vx = X[1] - X[0]; vy = Y[1] - Y[0]; } }
  else if (rt >= T[n - 1]) {
    k = n - 1; vx = X[k] - X[k - 1]; vy = Y[k] - Y[k - 1];
    const span = T[k] - T[k - 1], run = Math.min(rt - T[k], span, MAX_EXTRAP);
    const stunned = c._f[k] & CF.STUN;
    x = X[k] + (stunned ? 0 : vx * run / span); y = Y[k] + (stunned ? 0 : vy * run / span);
  } else {
    k = 0; while (k < n - 2 && rt >= T[k + 1]) k++;
    const f = (rt - T[k]) / (T[k + 1] - T[k]);
    vx = X[k + 1] - X[k]; vy = Y[k + 1] - Y[k];
    x = X[k] + vx * f; y = Y[k] + vy * f;
  }
  const moved = Math.hypot(x - c.x, y - c.y);
  if (moved < 2) c.walk += moved * TILE / 60;
  c.x = x; c.y = y;
  const v = Math.hypot(vx, vy);
  if (v > 0.02) { c.dirx = vx / v; c.diry = vy / v; }
  const fl = c._f[k];
  c.hp = c._h[k] / P.HPQ * c.maxHp;
  c.slowPct = fl & CF.SLOW ? 1 : 0; c.slowUntil = fl & CF.SLOW ? FAR : 0;
  c.stunUntil = fl & CF.STUN ? FAR : 0;
  c.auraSlow = fl & CF.AURA ? 1 : 0;
  c.poisons = fl & CF.POISON ? (fl & CF.PSLOW ? POISON_SLOW : POISONED) : NO_POISON;
  c.seen = !!(fl & CF.SEEN);
  const reviving = !!(fl & CF.REVIVE);
  // reincarnation: the watched lane's event says when it ends; elsewhere the first flagged sample is close enough
  if (reviving && !c.reviving && !(c.reviveAt > T[k] / TPS - 1)) c.reviveAt = T[k] / TPS + (c.def.reincarnation ? c.def.reincarnation.delay : 0);
  c.reviving = reviving;
  c.moveBonus = fl & CF.MOVE ? BONUS.moveBonus : 0; c.atkBonus = fl & CF.ATK ? BONUS.atkBonus : 0;
  c.dmgBonus = fl & CF.DMG ? BONUS.dmgBonus : 0; c.regenBonus = fl & CF.REGEN ? BONUS.regenBonus : 0;
  c.regenPct = fl & CF.RPCT ? BONUS.regenPct : 0;
  c.ta = c._a[k];
}
