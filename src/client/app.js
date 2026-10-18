// The game as an installable web app: the service worker (sw.js, published builds only) that keeps Classic Defense and
// vs Computer playable offline after the first visit, and the mode menu's line about full screen. Safari on an iPhone
// cannot show a page full screen, but the game added to the Home Screen opens as an app without the browser's bars
// (app.webmanifest, the apple-mobile-web-app tags in index.html); Android Chrome can install it, or go full screen.
import { BUILD } from '../assets.js?v=a48717ff8443';

const HINT_KEY = 'lejdaeron.appHint';
let installPrompt = null;   // Chrome's install prompt, kept for the menu's Install button

// After the assets have loaded: a published build registers the service worker and asks it to keep what this page
// loaded (the art this device uses, the fonts), so the next visit works without a network. A working copy has no
// service worker (one left from a published build served on the same address is removed: it would keep old files).
export function startApp(urls) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const script = new URL('sw.js', location.href).href;
  if (!BUILD) {
    navigator.serviceWorker.getRegistrations().then((rs) => {
      for (const r of rs) if ((r.active || r.waiting || r.installing || {}).scriptURL === script) r.unregister();
    }).catch(() => {});
    return;
  }
  navigator.serviceWorker.register(script, { updateViaCache: 'none' }).catch((err) => console.warn('service worker:', err.message));
  Promise.all([navigator.serviceWorker.ready, document.fonts.ready]).then(([reg]) => {
    const fonts = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u));
    if (reg.active) reg.active.postMessage({ type: 'keep', urls: [...urls.map((u) => new URL(u, location.href).href), ...fonts] });
  }).catch(() => {});
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); installPrompt = ev; });
  window.addEventListener('appinstalled', () => { installPrompt = null; });
}

const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const app = () => navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
const fullscreen = () => !!document.fullscreenElement;
const canFullscreen = () => !ios() && !!document.documentElement.requestFullscreen && document.fullscreenEnabled;
const SHARE = '<svg class="ov-share" viewBox="0 0 24 24" aria-label="Share"><path d="M12 3v12M8 7l4-4 4 4M7 10H5v11h14V10h-2"/></svg>';

// The mode menu's line (empty on a computer, in the app itself, or once dismissed): on an iPhone or iPad how to add the
// game to the Home Screen; on Android Chrome an Install button (the installed game opens full screen), or where it can't
// be installed a Full screen button.
export function appHint() {
  if (!matchMedia('(pointer: coarse)').matches || app() || fullscreen()) return '';
  try { if (localStorage.getItem(HINT_KEY)) return ''; } catch { /* storage blocked: show it */ }
  let body;
  if (ios()) body = `<span>For full screen, tap ${SHARE} <b>Share</b>, then <b>Add to Home Screen</b>.</span>`;
  else if (installPrompt) body = '<span>Play full screen, like an app:</span><button class="wc-btn small" id="app-install">Install</button>';
  else if (canFullscreen()) body = '<span>Hide the browser\'s bars:</span><button class="wc-btn small" id="app-full">Full screen</button>';
  else return '';
  return `<div class="ov-app" id="ov-app">${body}<button class="ov-app-x" id="app-x" title="Don't show this again" aria-label="Don't show this again">✕</button></div>`;
}
export function bindAppHint() {
  const el = document.getElementById('ov-app');
  if (!el) return;
  const close = () => el.remove();
  document.getElementById('app-x').onclick = () => {
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* not kept */ }
    close();
  };
  const inst = document.getElementById('app-install');
  if (inst) inst.onclick = async () => {
    const p = installPrompt;
    if (!p) return close();
    installPrompt = null;
    p.prompt();
    try { if ((await p.userChoice).outcome === 'accepted') close(); } catch { /* the prompt went away */ }
  };
  const full = document.getElementById('app-full');
  if (full) full.onclick = () => {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(close, () => {});
  };
}
