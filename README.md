# Lejdaeron

A tower defense for the browser, after the classic custom maps. **Playtest build.** No install, no account: everything runs in the page.

Play: https://davis-saas.github.io/lejdaeron/

## Modes

- **Classic Defense**: one road and 28 levels of creeps. Build towers beside the road, upgrade them and hold the castle.
- **vs Computer**: Line Tower Wars against 1 to 7 computer players (easy, normal, hard or insane). Build a maze in your lane, send creeps to the next player to raise your income, and steal their lives. The last player standing wins.
- **vs Players**: the same match online with 2 to 8 friends, browser to browser. Host a game, send the invite link, and everyone presses Ready; empty seats can be computer players. The host's browser runs the match, so the game ends if the host leaves. A player whose connection drops can open the link again within 60 seconds to get their seat back.

## Controls

| Key | Action |
| --- | --- |
| Q W E R / A S D F / Z X C V | The command card's grid (Line Tower Wars). Classic: A / S / E build, Q W E R T upgrade, X sells. |
| Shift | Keep placing towers. |
| Tab | Switch between Build, the three shrines (send creeps), Tech and the Arcade. |
| Home / F1, F2 | Show your lane, show the lane your creeps go to. |
| Mouse wheel | Zoom. Pan with the arrow keys, the screen edges, or a right or middle drag. |
| P, 1 2 3 | Pause and game speed (Classic and vs Computer; an online game has none). |
| Enter | Chat (also the Chat button). Enter sends, Escape cancels. |
| F10, Esc | Menu, cancel or deselect. |

Chat commands, as in the map: `-help`, `-income`, `-destroy` (your selected tower or tech building, no refund), `-onextra` / `-offextra`, and `-kick <colour>` (Red only).

On a phone or tablet everything works by touch: tap to select and build, drag to move the map, pinch to zoom, hold a button or a unit for its details. For full screen on an iPhone or iPad, tap Share, then Add to Home Screen; Android Chrome offers Install. After the first visit Classic Defense and vs Computer also play offline.

## Credits

Rules, towers, creeps and numbers come from the custom map Line Tower Wars 45 by Loss05, Nob, Trymio and t3tr1s. This is an unofficial fan project. All art is original, modelled and rendered in Blender. Online play uses Trystero (MIT licence, `src/net/vendor/`).
