// The vs Computer session: a Line Tower Wars Match and its Bots run right here on the main thread, following the
// session contract in docs/SPEC-client.md. The client's animation frames step the match through tick() at the fixed
// 1/60 s tick (one tick per 60 Hz frame, so movement is smooth); when frames stop (a hidden page has none) a 60 Hz
// setInterval takes over and catches up on missed time, so the match keeps going in the background.
//
//   const s = createLocalSession({ slots: [{ slot: 1, kind: 'human' }, { slot: 2, kind: 'bot', difficulty: 'hard' }], seed });
//   s.command({ type: 'send', unit: 'n00E' }).then(r => r.ok || ui.error(r.why));
//   s.command({ type: 'chat', text: '-destroy', towers: [id] });   // chat goes through match.command: 'chat' {slot, name, text}
//   s.speed = 2; s.paused = true;
import { Match, STEP } from './match.js?v=a48717ff8443';
import { Bot } from './bot.js?v=a48717ff8443';

const MAX_CATCHUP = 1.0;     // seconds of real time one timer call may make up (background tabs fire about once a second)
const BUDGET = 40;           // ms of simulation per call; beyond it the match runs slower instead of freezing the page
const MAX_EVENTS = 4000;     // events kept while nobody reads them (a hidden page has no animation frames)
const IDLE = 100;            // ms without a tick() call before the timer steps the match itself

export function createLocalSession({ slots, seed = randomSeed(), me = 1, options = {} } = {}) {
  const match = new Match({ slots, seed, options });   // options: as Match's (the build phase is on by default)
  const bots = slots.filter(s => s.kind === 'bot').map(s => new Bot(match, s.slot, s.difficulty || 'normal'));
  const handlers = {};
  const emit = (type, data) => { for (const fn of handlers[type] || []) fn(data); };
  let last = performance.now(), driven = -1e9, acc = 0, ended = false, timer = null;

  const session = {
    kind: 'local', me, seed, world: match, match, bots,
    speed: 1, paused: false,
    command(op) {
      if (!op || typeof op !== 'object') return Promise.resolve({ ok: false, why: 'Bad command.' });
      if (op.type === 'watch') return Promise.resolve({ ok: true, why: null });   // every lane is local anyway
      if (op.type === 'chat' && match.phase === 'over') {   // after the match: a plain chat line, as online
        const text = typeof op.text === 'string' ? op.text.slice(0, 255) : '';
        if (!text) return Promise.resolve({ ok: false, why: 'Nothing to say.' });
        emit('chat', { slot: me, name: match.players[me].name, text });
        return Promise.resolve({ ok: true, why: null, command: null });
      }
      // Chat runs through the match like every other op, so the map's chat commands work offline too; the line itself
      // comes back as the match's 'chat' event, passed on as the session's 'chat' (as the online session does).
      const n = match.events.length;
      const r = match.command(me, op);
      for (let i = n; i < match.events.length; i++) {
        const e = match.events[i];
        if (e.type === 'chat') emit('chat', { slot: e.slot, name: match.players[e.slot] ? match.players[e.slot].name : '', text: e.text });
      }
      return Promise.resolve(r);
    },
    tick() { driven = performance.now(); run(driven); },
    on(type, fn) {
      (handlers[type] ||= []).push(fn);
      return () => { handlers[type] = handlers[type].filter(f => f !== fn); };
    },
    close() { clearInterval(timer); timer = null; for (const k of Object.keys(handlers)) delete handlers[k]; },
  };

  function run(now) {
    const dt = Math.min(MAX_CATCHUP, (now - last) / 1000);
    last = now;
    if (session.paused || match.phase === 'over') { acc = 0; return; }
    acc += dt * session.speed;
    // a frame a little short of a whole tick still runs it (the next one makes up the difference), so 60 Hz frames
    // get exactly one tick each instead of an occasional 0 or 2
    let n = Math.floor(acc / STEP + 0.25);
    while (n-- > 0) {
      match.step(STEP);
      for (const b of bots) {
        try { b.tick(STEP); }
        catch (err) { console.error(`bot ${b.slot} stopped:`, err); b.tick = () => {}; emit('error', { message: `Computer player ${b.slot} stopped.` }); }
      }
      acc -= STEP;
      if (performance.now() - now > BUDGET) { acc = 0; break; }
    }
    trim(match.events);
    for (const s of match.ring) trim(match.lanes[s].events);
    if (match.phase === 'over' && !ended) { ended = true; emit('end', { winner: match.winner }); }
  }
  timer = setInterval(() => { const now = performance.now(); if (now - driven > IDLE) run(now); }, 1000 / 60);
  return session;
}

// While the page is hidden the client reads no events; keep only the newest so memory stays flat.
function trim(list) { if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS / 2); }

export function randomSeed() { return (Math.random() * 0x7fffffff) >>> 0 || 1; }
