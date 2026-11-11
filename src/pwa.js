// The parts that make the web app behave like an installed app:
// the offline copy (service worker), safe updates, and the "install" prompt.

const UPDATE_CHECK_EVERY_MS = 30 * 60 * 1000;

/** What the screens show. Read it, do not change it. */
export const pwa = {
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  offlineReady: false, // the offline copy is stored and in charge of this page
  updateReady: false, // a newer copy is stored and waiting for the user to switch
  canInstall: false, // the browser has offered to install the app
  failed: false, // the offline copy could not be stored
  reloadNeeded: false, // another tab switched to a newer copy, so this page should reload
  offlineVersion: '',
};

let registration = null;
let installEvent = null;
let notify = () => {};
let reloading = false;
let lastCheck = 0;
let beforeReload = null;

export function isStandalone() {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch (e) {
    /* not supported */
  }
  return navigator.standalone === true;
}

export function isIOS() {
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // An iPad set to "desktop website" calls itself a Mac. A real Mac has no touch screen.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

function refresh() {
  const active = registration && registration.active;
  pwa.offlineReady = Boolean(active && navigator.serviceWorker.controller);
  pwa.updateReady = Boolean(registration && registration.waiting && navigator.serviceWorker.controller);
  notify();
  if (pwa.offlineReady) askVersion();
}

function askVersion() {
  const worker = navigator.serviceWorker.controller;
  if (!worker || typeof MessageChannel === 'undefined') return;
  try {
    const pipe = new MessageChannel();
    pipe.port1.onmessage = (event) => {
      const version = event.data && event.data.version ? String(event.data.version) : '';
      if (version !== pwa.offlineVersion) {
        pwa.offlineVersion = version;
        notify();
      }
    };
    worker.postMessage({ type: 'GET_VERSION' }, [pipe.port2]);
  } catch (e) {
    /* the version is only shown in Settings */
  }
}

function watch(worker) {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (worker.state === 'redundant' && !registration.active) pwa.failed = true;
    refresh();
  });
}

/**
 * Stores the offline copy and keeps watch for updates.
 * onChange is called whenever something in "pwa" changes.
 * options.beforeReload (may be async) runs just before the page reloads onto a new version.
 */
export async function startPwa(onChange, options) {
  notify = onChange || (() => {});
  beforeReload = options && options.beforeReload;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installEvent = event;
    pwa.canInstall = true;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    pwa.canInstall = false;
    notify();
  });

  if (!pwa.supported) return;
  try {
    registration = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
  } catch (e) {
    console.warn('The offline copy could not be set up.', e);
    pwa.failed = true;
    notify();
    return;
  }
  watch(registration.installing);
  watch(registration.waiting);
  registration.addEventListener('updatefound', () => {
    pwa.failed = false;
    watch(registration.installing);
    refresh();
  });
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (!reloading) {
      // On a first visit this only means the offline copy has taken charge. Otherwise another
      // tab has switched to a newer copy, and this page should reload when the user is ready.
      if (hadController) pwa.reloadNeeded = true;
      refresh();
      return;
    }
    try {
      if (beforeReload) await beforeReload();
    } catch (e) {
      console.error(e);
    }
    location.reload();
  });
  refresh();
  lastCheck = Date.now();
}

/** Switches to the stored newer copy. The page reloads once it is in charge. */
export function applyUpdate() {
  if (!registration || !registration.waiting) return false;
  reloading = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

/**
 * Asks the server whether a newer copy exists. Quietly does nothing with no signal.
 * force: check now, even if a check was made recently.
 * Returns:
 *   'ready'        a newer copy is stored and waiting for the user
 *   'downloading'  a newer copy was found and is being stored
 *   'none'         this is the newest copy
 *   'skipped'      no check was made
 *   'failed'       the server could not be reached
 */
export async function checkForUpdate(force) {
  if (!registration) return 'skipped';
  if (!force && Date.now() - lastCheck < UPDATE_CHECK_EVERY_MS) return 'skipped';
  if (navigator.onLine === false) return 'skipped';
  lastCheck = Date.now();
  try {
    await registration.update();
  } catch (e) {
    return 'failed';
  }
  refresh();
  if (registration.waiting && navigator.serviceWorker.controller) return 'ready';
  if (registration.installing) return 'downloading';
  return 'none';
}

/** Shows the browser's own "install" prompt, where the browser offers one. */
export async function promptInstall() {
  if (!installEvent) return false;
  const event = installEvent;
  installEvent = null;
  pwa.canInstall = false;
  notify();
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return Boolean(choice && choice.outcome === 'accepted');
  } catch (e) {
    return false;
  }
}
