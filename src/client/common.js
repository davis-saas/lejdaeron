// Shared bits of the Line Tower Wars client: the stacked-lane layout, player colours and number formatting.
import { SIN } from '../level.js?v=99dfd38af943';
import { P } from '../render.js?v=99dfd38af943';

// The lanes are 9 rows across (LTW_RULES.laneWidth, one more than the map's), as the lane art (manifest.lane) is drawn.
export const LANE_PITCH = 13;                  // world rows per lane band: 2 border, 9 buildable (v 0-9), 2 border
export const LANE_X0 = -4, LANE_X1 = 48;       // lane-local x covered by the lane art (spawn gate and exit portal ends)
export const LANE_Y0 = -2, LANE_Y1 = 11;       // lane-local y covered by one band
export const BAND = LANE_PITCH * SIN * P;      // logical px between two stacked lanes
export const laneDY = (i) => i * BAND;         // logical px offset of the i-th lane in the stack

// The standard WC3 player colours (swatches and minimap dots) and lighter versions that read as text on dark panels.
export const PLAYER_HEX = { 1: '#ff0303', 2: '#0042ff', 3: '#1ce6b9', 4: '#540081', 5: '#fffc01', 6: '#fe8a0e', 7: '#20c000',
  8: '#e55bb0', 9: '#959697', 10: '#7ebff1', 11: '#106246' };
export const PLAYER_TEXT = { 1: '#ff4a3a', 2: '#4f86ff', 3: '#3cf0c8', 4: '#b06bf0', 5: '#fffc4a', 6: '#ffa040', 7: '#48d838',
  8: '#f07cc4', 9: '#c0c2c4', 10: '#a6d6ff', 11: '#38b07a' };
export const DIFFICULTIES = ['easy', 'normal', 'hard', 'insane'];
export const DIFF_NAME = { easy: 'Easy', normal: 'Normal', hard: 'Hard', insane: 'Insane' };
// An online bot's name already says its difficulty ('Computer (Hard)'); vs Computer bots are named by colour.
export const botNamed = (p) => !!p.difficulty && String(p.name).toLowerCase().includes(p.difficulty);

// The tech area (phase 3): the stone plaza around the spawn waygate, then the exit plaza, west and east of the
// buildable tiles. A player's tech buildings stand there in purchase order, then their unspent wisps, one spot each
// (lane-local x, y, anchored like towers).
export const TECH_SPOTS = [
  [-3.25, 1.5], [-2.15, 1.5], [-1.05, 1.5], [-2.7, 0.55], [-1.6, 0.55],
  [-3.25, 7.6], [-2.15, 7.6], [-1.05, 7.6], [-2.7, 8.55], [-1.6, 8.55],
  [45.05, 1.5], [46.15, 1.5], [47.25, 1.5], [45.6, 0.55], [46.7, 0.55],
];
// [{ id (tech building id, or null for a wisp), x, y }] for a living player.
export function techArea(p) {
  const out = [];
  if (!p || !p.alive) return out;
  for (const id of Array.isArray(p.tech) ? p.tech : []) {
    if (out.length >= TECH_SPOTS.length) return out;
    const [x, y] = TECH_SPOTS[out.length];
    out.push({ id, x, y });
  }
  for (let k = 0; k < (p.wisps || 0) && out.length < TECH_SPOTS.length; k++) {
    const [x, y] = TECH_SPOTS[out.length];
    out.push({ id: null, x, y });
  }
  return out;
}

// Lanes top to bottom: the viewer's own lane, then the ring order from there (next(me) second). Fixed for the match.
export function laneOrder(world, me) {
  const ring = world.ring.slice();
  const k = ring.indexOf(me);
  return k < 0 ? ring : ring.slice(k).concat(ring.slice(0, k));
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
// 750 -> '750', 3500 -> '3.5k', 100000 -> '100k' (button faces have room for about five characters)
export function short(n) {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a < 1000) return s + a;
  if (a < 10000) return s + (Math.round(a / 100) / 10) + 'k';
  return s + Math.round(a / 1000) + 'k';
}
export const signed = (n) => (n > 0 ? '+' : '') + short(n);
export const ordinal = (n) => n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th');
