// Moving between screens.
//
// Each screen has an address after the # sign, for example #/job/abc or #/pole/xyz/heights.
// The phone's own Back button therefore works, and a reload returns to the same screen.
//
// The app also keeps the list of screens passed through on this visit (the "trail") inside the
// browser's history entry. The in-app back arrow uses it to return to the right place in one
// tap, instead of stepping back through every screen that was visited on the way.

const MAX_TRAIL = 60;

let onRoute = null;
let trail = ['/'];
let shown = '';
let waitingForPop = false;
let waitTimer = null;
let intent = null;

const encode = encodeURIComponent;

export const paths = {
  home: () => '/',
  job: (id) => '/job/' + encode(id),
  jobDetails: (id) => '/job/' + encode(id) + '/details',
  pole: (id, step) => '/pole/' + encode(id) + (step ? '/' + encode(step) : ''),
  settings: () => '/settings',
  trash: () => '/trash',
};

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch (e) {
    return '';
  }
}

/** Turns an address into { name, id, step }. Anything unknown gives { name: 'unknown' }. */
export function parseRoute(path) {
  const text = String(path == null ? '' : path).replace(/^#/, '').split('?')[0];
  const parts = text.split('/').filter((part) => part !== '').map(decode);
  if (parts.some((part) => part === '')) return { name: 'unknown' };
  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'job' && parts.length === 2) return { name: 'job', id: parts[1] };
  if (parts[0] === 'job' && parts.length === 3 && parts[2] === 'details') return { name: 'jobdetails', id: parts[1] };
  if (parts[0] === 'pole' && (parts.length === 2 || parts.length === 3)) return { name: 'pole', id: parts[1], step: parts[2] || '' };
  if (parts[0] === 'settings' && parts.length === 1) return { name: 'settings' };
  if (parts[0] === 'trash' && parts.length === 1) return { name: 'trash' };
  return { name: 'unknown' };
}

function here() {
  const hash = location.hash.replace(/^#/, '');
  return hash.startsWith('/') ? hash : '/';
}

function savedTrail() {
  const state = history.state;
  if (!state || !Array.isArray(state.trail) || !state.trail.length) return null;
  if (!state.trail.every((entry) => typeof entry === 'string')) return null;
  return state.trail[state.trail.length - 1] === here() ? state.trail : null;
}

const cap = (list) => (list.length > MAX_TRAIL ? list.slice(list.length - MAX_TRAIL) : list);

function show(fresh) {
  shown = JSON.stringify(trail);
  if (onRoute) onRoute(parseRoute(here()), { fresh });
}

function onHistoryMove() {
  waitingForPop = false;
  clearTimeout(waitTimer);
  const saved = savedTrail();
  if (saved) {
    trail = saved;
  } else {
    // An address typed by hand, or opened from a link.
    const path = here();
    if (trail[trail.length - 1] !== path) trail = cap([...trail, path]);
    history.replaceState({ trail }, '');
  }
  if (JSON.stringify(trail) === shown) return; // "popstate" and "hashchange" both report the same move
  show(true);
}

/** Starts listening and shows the first screen. handler(route, { fresh }) draws a screen. */
export function startNav(handler) {
  onRoute = handler;
  try {
    history.scrollRestoration = 'manual';
  } catch (e) {
    /* not supported */
  }
  trail = savedTrail() || [here()];
  history.replaceState({ trail }, '');
  window.addEventListener('popstate', onHistoryMove);
  window.addEventListener('hashchange', onHistoryMove);
  show(true);
}

export const currentPath = () => here();
export const currentRoute = () => parseRoute(here());

/** True for a moment after the in-app back arrow is used, until the browser has caught up. */
export const isMoving = () => waitingForPop;

/** Goes forward to a screen. options.focus names a field to scroll to and focus when it opens. */
export function go(path, options) {
  intent = options && options.focus ? { focus: options.focus } : null;
  if (path === here()) {
    show(false);
    return;
  }
  trail = cap([...trail, path]);
  history.pushState({ trail }, '', '#' + path);
  show(true);
}

/**
 * Swaps the current screen for `instead`, then goes forward to `path`. Used when a screen only
 * leads into the next one: going back from `path` then returns to `instead`, not to it.
 */
export function goVia(instead, path, options) {
  intent = options && options.focus ? { focus: options.focus } : null;
  const before = [...trail.slice(0, -1), instead];
  trail = cap([...before, path]);
  history.replaceState({ trail: cap(before) }, '', '#' + instead);
  history.pushState({ trail }, '', '#' + path);
  show(true);
}

/** Swaps the current screen for another, without adding a step to go back through. */
export function replace(path) {
  intent = null;
  trail = [...trail.slice(0, -1), path];
  history.replaceState({ trail }, '', '#' + path);
  show(true);
}

/**
 * Goes back to a screen. If that screen was passed through on the way here, the history is
 * rewound to it. Otherwise the current screen is swapped for it.
 */
export function backTo(path) {
  intent = null;
  for (let i = trail.length - 2; i >= 0; i -= 1) {
    if (trail[i] === path) {
      waitingForPop = true;
      clearTimeout(waitTimer);
      waitTimer = setTimeout(() => {
        waitingForPop = false;
      }, 1500);
      history.go(i - (trail.length - 1));
      return;
    }
  }
  replace(path);
}

/** Draws the current screen again, keeping the scroll position. */
export function redraw() {
  show(false);
}

/** Reads, once, what the last go() asked the new screen to do. */
export function takeIntent() {
  const out = intent;
  intent = null;
  return out;
}
