// Starts the app and connects taps, typing and navigation to the screens.

import { installUi, handleUiTap, sheetIsOpen, sheetIsDismissable, sheetChangedAt, closeSheet, html, icon, toast, hideToast, tidyToast, messageSheet } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import * as nav from './nav.js';
import { TEMPLATE } from './template.js';
import { validateTemplate } from './template-engine.js';
import { focusNextField } from './form.js';
import { makeRenditions } from './photos.js';
import { acquire, takeOver, announceJournal } from './lock.js';
import { startPwa, applyUpdate, promptInstall, checkForUpdate } from './pwa.js';
import { fileActions } from './views/exporting.js';
import * as home from './views/home.js';
import * as job from './views/job.js';
import * as jobdetails from './views/jobdetails.js';
import * as pole from './views/pole.js';
import * as settings from './views/settings.js';
import * as trash from './views/trash.js';
import { APP_NAME } from './config.js';

const appEl = document.getElementById('app');
const modalEl = document.getElementById('modal');

const views = { home: home.open, job: job.open, jobdetails: jobdetails.open, pole: pole.open, settings: settings.open, trash: trash.open };

let current = null; // { route, view }
let stopped = false; // a full-screen notice has replaced the app
let screenChangedAt = -Infinity;
let redrawQueued = false;
let redrawWhenIdle = false;
let errorShown = false;

// ---------------------------------------------------------------------------------------------
// Full-screen notices

function notice(title, text, button) {
  stopped = true;
  if (current && current.view.unmount) current.view.unmount();
  current = null;
  if (sheetIsOpen()) closeSheet(undefined);
  appEl.innerHTML = String(html`<div class="home-top">
    <h1 data-heading tabindex="-1">${APP_NAME}</h1>
    <div class="banner bad" role="alert">${icon.alert}<div><div class="b-title">${title}</div><div class="b-text">${text}</div></div></div>
    ${button && button.href ? html`<a class="btn" href="${button.href}" target="_top">${button.label}</a>` : ''}
    ${button && button.act ? html`<button type="button" class="btn" data-act="${button.act}">${button.label}</button>` : ''}
  </div>`);
  document.title = APP_NAME;
}

function storageProblem(error) {
  console.error(error);
  if (error && error.name === 'VersionError') {
    notice('Reload needed', 'A newer version of the app has already been used on this phone. Reload to switch to it.', { act: 'reload', label: 'Reload' });
    return;
  }
  notice(
    'Storage is not available',
    'This browser is blocking on-phone storage, so the app cannot save anything. Turn off Private Browsing, make sure the phone is not out of space, then reload.',
    { act: 'reload', label: 'Reload' },
  );
}

// ---------------------------------------------------------------------------------------------
// Drawing

const STATUS_TEXT = { saved: 'Saved on this phone', saving: 'Saving', error: 'Not saved' };
// The form screens have little room beside the step title, so they use one word.
const STATUS_SHORT = { saved: 'Saved', saving: 'Saving', error: 'Not saved' };

function showSaveStatus() {
  const status = store.saveStatus();
  for (const element of document.querySelectorAll('[data-save-status]')) {
    const text = (element.getAttribute('data-save-status') === 'short' ? STATUS_SHORT : STATUS_TEXT)[status];
    if (element.textContent !== text) element.textContent = text;
    element.className = 'save-status is-' + status;
  }
}

function fallbackFor(route) {
  if (route.name === 'pole') {
    const gone = store.findPole(route.id);
    if (gone && store.getJob(gone.jobId)) return nav.paths.job(gone.jobId);
  }
  if (route.name === 'trash') return nav.paths.settings();
  return nav.paths.home();
}

const isTextBox = (element) =>
  element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !['file', 'checkbox', 'radio', 'button', 'submit'].includes(element.type));

const isTyping = () => isTextBox(document.activeElement) && appEl.contains(document.activeElement);

function capture() {
  const active = document.activeElement;
  const out = { y: window.scrollY, id: '', start: null, end: null };
  if (active && active.id && appEl.contains(active)) {
    out.id = active.id;
    if (isTextBox(active)) {
      try {
        out.start = active.selectionStart;
        out.end = active.selectionEnd;
      } catch (e) {
        /* this kind of input has no selection */
      }
    }
  }
  return out;
}

function restore(kept) {
  window.scrollTo(0, kept.y);
  if (!kept.id || sheetIsOpen()) return;
  const element = document.getElementById(kept.id);
  if (!element || !appEl.contains(element)) return;
  element.focus({ preventScroll: true });
  if (kept.start != null) {
    try {
      element.setSelectionRange(kept.start, kept.end);
    } catch (e) {
      /* this kind of input has no selection */
    }
  }
}

function draw(route, info) {
  if (stopped) return;
  const opener = views[route.name];
  const view = opener ? opener(route) : null;
  if (!view) {
    // The address points at something that is not on this phone (deleted, or a mistyped link).
    nav.backTo(fallbackFor(route));
    return;
  }
  const fresh = Boolean(info && info.fresh);
  if (current) {
    if (fresh && current.view.leave) current.view.leave(route);
    if (current.view.unmount) current.view.unmount();
  }
  if (fresh && sheetIsDismissable()) closeSheet(undefined);
  const kept = fresh ? null : capture();
  appEl.innerHTML = String(view.render());
  current = { route, view };
  const title = view.title;
  document.title = title && title !== APP_NAME ? title + ' · ' + APP_NAME : APP_NAME;
  showSaveStatus();
  if (fresh) {
    screenChangedAt = performance.now();
    window.scrollTo(0, 0);
    if (!sheetIsOpen()) {
      const heading = appEl.querySelector('[data-heading]') || appEl;
      heading.focus({ preventScroll: true });
    }
  } else {
    restore(kept);
  }
  // Last, so that a screen asked to jump to one field can scroll to it.
  if (view.mounted) view.mounted(appEl, { fresh });
  tidyToast();
}

// Draws the current screen again soon. While the user is typing the redraw waits, because
// replacing the page under the keyboard would close it.
function requestRedraw() {
  if (redrawQueued || stopped) return;
  redrawQueued = true;
  queueMicrotask(() => {
    redrawQueued = false;
    if (stopped) return;
    if (isTyping()) {
      redrawWhenIdle = true;
      return;
    }
    redrawWhenIdle = false;
    nav.redraw();
  });
}

// Signal, storage space and the offline copy are only shown on the job list and in Settings.
// A change in any of them leaves every other screen alone, so nothing shifts under a finger.
const showsPhoneState = () => Boolean(current) && (current.route.name === 'home' || current.route.name === 'settings');

function redrawPhoneState() {
  if (showsPhoneState()) requestRedraw();
}

// ---------------------------------------------------------------------------------------------
// Taps

// A second tap in the same spot soon after the first is almost always a slip of the finger, or a
// gloved "did that work?" tap. It is ignored, so it cannot press a button that has just appeared
// under the finger. The wait is longer when something new has appeared there: longest after a
// sheet, because a sheet asks a question that has to be read first.
const REPEAT_MS = 350; // nothing changed since the last tap
const REPEAT_AFTER_NEW_SCREEN_MS = 700;
const REPEAT_AFTER_SHEET_MS = 1000;
const REPEAT_PX = 24;
let lastTap = { t: -Infinity, x: 0, y: 0 };
let lastKey = { t: -Infinity, target: null };
let pressedAt = -Infinity;

document.addEventListener(
  'pointerdown',
  () => {
    pressedAt = performance.now();
  },
  true,
);

function isAccidentalRepeat(event) {
  const now = performance.now();
  if (event.detail === 0) {
    // From the keyboard, or made by the app itself. There is no position to compare.
    const repeat = event.target === lastKey.target && now - lastKey.t < REPEAT_MS;
    lastKey = { t: now, target: event.target };
    return repeat && event.isTrusted;
  }
  const sheetAt = sheetChangedAt();
  // The finger went down before this screen or sheet appeared, so it was aimed at what was there before.
  if (Number.isFinite(pressedAt) && pressedAt < Math.max(screenChangedAt, sheetAt) && now - pressedAt < 2000) return true;
  const near = Math.abs(event.clientX - lastTap.x) < REPEAT_PX && Math.abs(event.clientY - lastTap.y) < REPEAT_PX;
  let limit = REPEAT_MS;
  if (sheetAt > lastTap.t) limit = REPEAT_AFTER_SHEET_MS;
  else if (screenChangedAt > lastTap.t) limit = REPEAT_AFTER_NEW_SCREEN_MS;
  const repeat = near && now - lastTap.t < limit;
  if (!repeat) lastTap = { t: now, x: event.clientX, y: event.clientY };
  return repeat;
}

const running = new Set();

async function runAction(name, element, event) {
  const local = current && current.view.actions ? current.view.actions[name] : null;
  const handler = local || globalActions[name];
  if (!handler) return;
  // One action at a time per screen: a second tap while the first is still working is ignored.
  const key = name + '|' + nav.currentPath();
  if (running.has(key)) return;
  running.add(key);
  try {
    await handler(element, event);
  } catch (error) {
    console.error(error);
    toast('That did not work. Nothing was lost.');
  } finally {
    running.delete(key);
  }
}

// Photos still being shrunk are stored before the page goes away. A photo that never finishes
// does not hold the page for more than this.
const PHOTO_WAIT_MS = 20000;

async function saveEverything() {
  await store.whenIdle(PHOTO_WAIT_MS);
  await store.saveBeforeLeaving();
}

const globalActions = {
  ...fileActions,
  reload: async () => {
    if (!store.isRetired()) await saveEverything();
    location.reload();
  },
  'take-over': async () => {
    toast('Moving the app here. If the other tab is still storing photos, this waits for them.', { ms: 10000 });
    const result = await takeOver();
    hideToast();
    if (result === 'busy') {
      toast('The other tab is still busy. Close it, then try again.');
      return;
    }
    stopped = false;
    await boot();
  },
  'update-now': async () => {
    await saveEverything();
    if (!applyUpdate()) location.reload();
  },
  'install-app': () => promptInstall(),
  'ios-install-help': () => home.showIosInstallHelp(),
  'save-retry': async () => {
    try {
      await store.flush();
      toast('Saved on this phone');
    } catch (e) {
      toast('Still not saving. Free up some space on the phone.');
    }
  },
};

function onClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  // File inputs are opened by the app itself. Those clicks are never slips.
  if (target instanceof HTMLInputElement && target.type === 'file') return;
  if (isAccidentalRepeat(event)) {
    event.preventDefault();
    return;
  }
  if (nav.isMoving()) return;
  if (handleUiTap(event)) return;
  if (current && current.view.tap && appEl.contains(target) && current.view.tap(target)) return;
  const button = target.closest('[data-act]');
  if (!button || button.disabled) return;
  runAction(button.getAttribute('data-act'), button, event);
}

// ---------------------------------------------------------------------------------------------
// One tab at a time

function showElsewhere() {
  notice('Already open', 'The app is open in another tab or window on this phone. Use that one, or move it here. Nothing will be lost.', { act: 'take-over', label: 'Use it here' });
}

function showMoved() {
  notice('Moved to another tab', 'The app is now open in another tab or window. Everything was saved first. To use it here again, reload.', { act: 'reload', label: 'Reload' });
}

const lockHandlers = {
  // Another tab took over while this one could not answer (it was frozen in the background).
  onLost: () => {
    store.retire();
    announceJournal();
    showMoved();
  },
  // Another tab asked politely. Finish storing photos and save everything, then step aside.
  onYield: async () => {
    await saveEverything();
    store.retire();
    showMoved();
  },
  // A tab that stepped aside has written its journal. It may also have saved straight to the
  // database after this tab loaded, so newer copies are read from there too.
  onJournal: () => {
    store
      .takeNewerFromDb()
      .catch((e) => console.warn(e))
      .then(() => store.replayJournals());
  },
};

// ---------------------------------------------------------------------------------------------
// Start-up

// The app never runs inside another page. A page that showed it in a frame could lay its own
// buttons over the app's and trick a tap onto "Delete forever".
function isFramed() {
  try {
    return window.top !== window.self;
  } catch (e) {
    return true;
  }
}

function showFramed() {
  notice('Open the app on its own', 'This page is showing the app inside another page. For safety it will not run there.', {
    href: location.href.split('#')[0],
    label: 'Open the app',
  });
}

// Shown on the start-up screen while photos from the first version are being copied.
function showImportProgress(done, total) {
  const box = document.getElementById('boot');
  if (!box || !total) return;
  box.textContent = 'Copying photos from the first version of the app: ' + Math.min(done + 1, total) + ' of ' + total + '. Keep the app open.';
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

function reportImport(result) {
  if (!result) return;
  const copied = [];
  if (result.jobs) copied.push(plural(result.jobs, 'job', 'jobs'));
  if (result.photos) copied.push(plural(result.photos, 'photo', 'photos'));
  const problems = [];
  // Told once. A second attempt (for photos that met a full phone) does not repeat it.
  if (result.unreadable && !result.again) {
    problems.push(plural(result.unreadable, 'photo', 'photos') + ' could not be read, so ' + (result.unreadable === 1 ? 'it was' : 'they were') + ' left out. Nothing was removed from the first version\'s storage.');
  }
  if (result.retry) {
    problems.push(plural(result.retry, 'photo', 'photos') + ' could not be saved because the phone is short of space. Free up some space, then close and reopen the app to finish.');
  }
  if (!copied.length && !problems.length) return;
  const intro = copied.length ? 'Copied from the first version of the app: ' + copied.join(' and ') + '.' : '';
  if (problems.length) messageSheet('Copying from the first version', [intro, ...problems]);
  else toast(intro, { ms: 6000 });
}

// 'moved' is shown by the lock handlers. 'stale' means another tab saved newer copies of entries
// this tab still had open, so this tab has stopped before it could overwrite them.
let watchingRetired = false;
function watchRetired() {
  if (watchingRetired) return;
  watchingRetired = true;
  store.subscribe('retired', (detail) => {
    if (detail.reason !== 'stale' || stopped) return;
    announceJournal();
    notice('Changed in another tab', 'Newer entries were saved in another tab or window on this phone. This tab has stopped saving so it cannot overwrite them. Reload to see the newest entries.', {
      act: 'reload',
      label: 'Reload',
    });
  });
}

let wired = false;

function wire() {
  if (wired) return;
  wired = true;

  store.subscribe('status', () => {
    showSaveStatus();
    const failing = store.saveStatus() === 'error';
    if (failing === errorShown) return;
    errorShown = failing;
    if (failing) toast('The phone is not saving. Your entries are still on screen.', { ms: 8000 });
    requestRedraw();
  });

  store.subscribe('change', (detail) => {
    if (stopped || detail.quiet) return;
    if (detail.kind === 'space' && !showsPhoneState()) return;
    const view = current && current.view;
    if (view && view.changed && view.changed(detail) === true) return;
    requestRedraw();
  });

  document.addEventListener('input', (event) => {
    const element = event.target;
    if (!(element instanceof HTMLElement) || !current) return;
    if (appEl.contains(element)) {
      if (current.view.input) current.view.input(element, appEl);
    } else if (modalEl.contains(element) && current.view.sheetInput) {
      current.view.sheetInput(element);
    }
  });

  document.addEventListener('keydown', (event) => {
    const element = event.target;
    if (event.key !== 'Enter' || event.isComposing) return;
    if (element instanceof HTMLInputElement && element.dataset.k && appEl.contains(element)) {
      event.preventDefault();
      focusNextField(element, appEl);
    }
  });

  document.addEventListener('focusout', () => {
    if (!redrawWhenIdle) return;
    setTimeout(() => {
      if (redrawWhenIdle && !isTyping()) requestRedraw();
    }, 0);
  });

  document.addEventListener('visibilitychange', () => {
    if (stopped) return;
    if (document.visibilityState === 'hidden') {
      store.saveBeforeLeaving();
    } else {
      checkForUpdate(false);
      store.checkSpace().catch(() => {});
      if (store.hasUnsavedChanges()) store.flush().catch(() => {});
    }
  });
  window.addEventListener('pagehide', () => {
    if (!stopped) store.saveBeforeLeaving();
  });
  window.addEventListener('online', redrawPhoneState);
  window.addEventListener('offline', redrawPhoneState);

  db.onDbEvent('outdated', () => {
    store.retire();
    notice('Reload needed', 'A newer version of the app has opened in another tab. Reload this one to keep going. Everything is saved.', { act: 'reload', label: 'Reload' });
  });
  db.onDbEvent('blocked', () => {
    messageSheet('Close the other tabs', 'An older copy of the app is open in another tab and is in the way. Close it, then reload this one.');
  });
}

async function boot() {
  watchRetired();
  let loaded;
  try {
    loaded = await store.init({ makeRenditions, onProgress: showImportProgress });
  } catch (error) {
    storageProblem(error);
    return;
  }
  if (stopped) return; // another tab saved over this one while it was starting
  wire();
  nav.startNav(draw);
  reportImport(loaded && loaded.legacy);
  startPwa(redrawPhoneState, { beforeReload: saveEverything });
  // Firefox asks the user a question for this, so there it is left to the button in Settings.
  if (!/firefox/i.test(navigator.userAgent)) store.requestPersistence();
}

async function start() {
  window.__appStarted = true;
  if (isFramed()) {
    // Before the lock is taken, so a framed copy can never block the real one.
    showFramed();
    return;
  }
  installUi();
  document.addEventListener('click', onClick);
  const mistakes = validateTemplate(TEMPLATE);
  if (mistakes.length) {
    notice('The form has a mistake', mistakes.slice(0, 4).join(' '));
    return;
  }
  const lock = await acquire(lockHandlers);
  if (lock === 'busy') {
    showElsewhere();
    return;
  }
  await boot();
}

start().catch((error) => {
  console.error(error);
  notice('The app could not start', 'Reload to try again. If this keeps happening, your saved poles are still on the phone.', { act: 'reload', label: 'Reload' });
});
