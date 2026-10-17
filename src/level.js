// The battlefield: a fixed road that snakes from the dark portal (top left) to the castle (bottom left).
// Coordinates are in tiles. One tile = 128 WC3 units = one tower footprint (2x2 build cells).
export const COLS = 30, ROWS = 18, TILE = 128;

export const PATH = [
  [1.5, -0.1], [1.5, 2.5], [25.5, 2.5], [25.5, 6.5], [4.5, 6.5], [4.5, 10.5],
  [25.5, 10.5], [25.5, 14.5], [6.6, 14.5],
];

// Areas that can't be built on: forest borders, the portal, the castle.
export const CASTLE = { c0: 0, r0: 12, c1: 6, r1: 17 };   // inclusive tile rect
export const PORTAL = { x: 1.5, y: 0.35 };   // map point at the foot of the portal
export const CASTLE_AT = { x: 3.5, y: 15.0 }; // map point the castle sprite is anchored to

// Camera used by the Blender renders: orthographic, 50 degrees below the horizon, looking north.
export const ELEV = 50 * Math.PI / 180;
export const SIN = Math.sin(ELEV), COS = Math.cos(ELEV);
export const TOP = 1.5;   // tiles of screen space above the map's north edge (room for tall props)
// map (x, y, height z) in tiles -> screen position in tiles
export const project = (x, y, z = 0) => ({ x, y: y * SIN - z * COS + TOP });
export const unproject = (sx, sy) => ({ x: sx, y: (sy - TOP) / SIN });
export const SCREEN_W = COLS, SCREEN_H = ROWS * SIN + TOP;

function segTiles() {
  const set = new Set();
  for (let i = 0; i + 1 < PATH.length; i++) {
    const [x0, y0] = PATH[i], [x1, y1] = PATH[i + 1];
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 4);
    for (let k = 0; k <= n; k++) {
      const x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n;
      const c = Math.floor(x), r = Math.floor(y);
      if (c >= 0 && r >= 0 && c < COLS && r < ROWS) set.add(r * COLS + c);
    }
  }
  return set;
}
export const ROAD = segTiles();

export const BLOCKED = new Set();
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const i = r * COLS + c;
  const forest = r === 0 || c >= 28 || (r === 17 && c > CASTLE.c1) || (c === 0 && r <= 4);
  const castle = c >= CASTLE.c0 && c <= CASTLE.c1 && r >= CASTLE.r0 && r <= CASTLE.r1;
  if (forest || castle || ROAD.has(i)) BLOCKED.add(i);
}
export const buildable = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS && !BLOCKED.has(r * COLS + c);

// Cumulative path length for positioning creeps by distance travelled.
export const PATH_LEN = [];
let acc = 0;
PATH_LEN.push(0);
for (let i = 1; i < PATH.length; i++) { acc += Math.hypot(PATH[i][0] - PATH[i - 1][0], PATH[i][1] - PATH[i - 1][1]); PATH_LEN.push(acc); }
export const TOTAL_LEN = acc;

export function pointAt(d) {
  if (d <= 0) return { x: PATH[0][0], y: PATH[0][1], dx: 1, dy: 0 };
  for (let i = 1; i < PATH.length; i++) {
    if (d <= PATH_LEN[i]) {
      const [x0, y0] = PATH[i - 1], [x1, y1] = PATH[i];
      const L = PATH_LEN[i] - PATH_LEN[i - 1], t = (d - PATH_LEN[i - 1]) / L;
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, dx: (x1 - x0) / L, dy: (y1 - y0) / L };
    }
  }
  const [x, y] = PATH[PATH.length - 1];
  return { x, y, dx: -1, dy: 0 };
}
