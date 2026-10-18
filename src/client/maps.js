// The maps the menu offers, chosen by their pictures (the map picker in src/client/screens.js). A preview is our own
// picture of the map's layout, 2:1: classic.jpg and ltw.jpg are drawn by the game's renderers (node
// tools/make_map_previews.mjs), ttw.jpg and gemtd.jpg come from the map research (docs/maps-research.md). A map with no
// modes is not playable yet: its card is locked and starts nothing. The paths are written out in full so that
// tools/publish.mjs, which copies every assets/... path a module names, publishes the pictures.
import { BUILD } from '../assets.js?v=a48717ff8443';

const V = BUILD || String(Date.now());   // as src/assets.js versions the art: the build's stamp, or a fresh load

// modes: the ways to play a map, in the order its screen offers them (id: what src/main.js starts)
export const MAPS = [
  { id: 'classic', name: 'Classic', players: '1 player', preview: 'assets/maps/classic.jpg',
    about: 'One road from the demon portal to your castle, and 28 levels of creeps. Build beside the road, upgrade, and hold the gate.',
    modes: [{ id: 'classic', name: 'Classic Defense', text: 'One road and 28 levels of creeps. Build, upgrade and hold the castle.' }] },
  { id: 'ltw', name: 'Line Tower Wars', players: '2 to 8 players', preview: 'assets/maps/ltw.jpg',
    about: 'Every player holds a lane and mazes it with towers. Creeps you send go to the next player, and a creep that gets through steals a life for you.',
    modes: [
      { id: 'computer', name: 'vs Computer', text: 'Against 1 to 7 computer players, easy to insane. Maze your lane, send creeps, steal lives.' },
      { id: 'players', name: 'vs Players', text: 'Online with 2 to 8 players. Host a game and send the invite link; empty seats can be computers.' },
    ] },
  { id: 'ttw', name: 'Tropical Tower Wars', players: '6 players, 3 v 3', preview: 'assets/maps/ttw.jpg', modes: [] },
  { id: 'gemtd', name: 'Gem TD', players: '1 to 8 players', preview: 'assets/maps/gemtd.jpg', modes: [] },
];
export const MAP = Object.fromEntries(MAPS.map((m) => [m.id, m]));
export const playable = (m) => m.modes.length > 0;
export const previewUrl = (m) => `${m.preview}?v=${V}`;

// The pictures start loading with the page (beside the art), so the picker shows them at once.
if (typeof Image === 'function') for (const m of MAPS) new Image().src = previewUrl(m);
