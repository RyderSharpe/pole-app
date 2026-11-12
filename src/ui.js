// Small building blocks for the screens: safe HTML, icons, the bottom sheet and the toast.
//
// Safe HTML: every screen is built with the html`...` tag below. Anything dropped into it is
// escaped unless it is itself the result of html`...`, so text typed by a user (or read from a
// backup file) can never turn into markup.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

class Safe {
  constructor(text) {
    this.text = text;
  }

  toString() {
    return this.text;
  }
}

/** Marks text as already safe. Only use it for markup written in this code base. */
export const raw = (text) => new Safe(String(text));

function render(value) {
  if (value instanceof Safe) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value == null || value === false || value === true) return '';
  return esc(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += render(values[i]) + strings[i + 1];
  return new Safe(out);
}

/** attrs({ class: 'a', hidden: true, disabled: false }) gives ' class="a" hidden'. */
export function attrs(map) {
  let out = '';
  for (const [name, value] of Object.entries(map)) {
    if (value == null || value === false) continue;
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name)) continue;
    out += value === true ? ' ' + name : ' ' + name + '="' + esc(value) + '"';
  }
  return new Safe(out);
}

const svg = (size, width, body) =>
  raw('<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + width + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>');

export const icon = {
  back: svg(22, 2.2, '<path d="M15 18l-6-6 6-6"></path>'),
  next: svg(18, 2.2, '<path d="M9 6l6 6-6 6"></path>'),
  check: svg(22, 2.2, '<path d="M5 12l5 5 9-10"></path>'),
  checkSmall: svg(16, 2.6, '<path d="M5 12l5 5 9-10"></path>'),
  nosignal: svg(22, 2, '<path d="M2 20h.01"></path><path d="M7 20v-4"></path><path d="M12 20v-8" stroke-opacity="0.3"></path><path d="M17 20V8" stroke-opacity="0.3"></path><path d="M3 3l18 18"></path>'),
  phone: svg(22, 2, '<rect x="7" y="2.5" width="10" height="19" rx="2"></rect><path d="M11 18.5h2"></path>'),
  camera: svg(22, 2, '<path d="M4 8h3l2-3h6l2 3h3v11H4z"></path><circle cx="12" cy="13" r="3.5"></circle>'),
  image: svg(22, 2, '<rect x="3.5" y="4.5" width="17" height="15" rx="2"></rect><circle cx="9" cy="10" r="1.6"></circle><path d="M20.5 15.5l-5-5-8 8"></path>'),
  x: svg(18, 2.4, '<path d="M6 6l12 12M18 6L6 18"></path>'),
  settings: svg(22, 2, '<path d="M4 7h10"></path><path d="M18 7h2"></path><circle cx="16" cy="7" r="2"></circle><path d="M4 17h2"></path><path d="M10 17h10"></path><circle cx="8" cy="17" r="2"></circle>'),
  pin: svg(20, 2, '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0113 0c0 5-6.5 11-6.5 11z"></path><circle cx="12" cy="10" r="2.3"></circle>'),
  alert: svg(22, 2, '<path d="M12 4l9 15.5H3z"></path><path d="M12 10v4.5"></path><path d="M12 17.2h.01"></path>'),
  download: svg(20, 2.2, '<path d="M12 4v11"></path><path d="M7 11l5 5 5-5"></path><path d="M5 20h14"></path>'),
  share: svg(20, 2.2, '<path d="M12 15V4"></path><path d="M8 8l4-4 4 4"></path><path d="M6 12v7h12v-7"></path>'),
  search: svg(20, 2.2, '<circle cx="11" cy="11" r="6.5"></circle><path d="M16 16l4.5 4.5"></path>'),
  refresh: svg(20, 2.2, '<path d="M20 12a8 8 0 10-2.6 5.9"></path><path d="M20 5v6h-6"></path>'),
  pencil: svg(20, 2, '<path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 013 3L8 18.5z"></path><path d="M14.5 6l3 3"></path>'),
  trash: svg(20, 2, '<path d="M5 7h14"></path><path d="M10 4h4"></path><path d="M7 7l1 13h8l1-13"></path>'),
};

export function plural(count, one, many) {
  return count + ' ' + (count === 1 ? one : many || one + 's');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'not reported';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function formatDateTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'never';
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + formatTime(ms);
}

// ---------------------------------------------------------------------------------------------
// Bottom sheet

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]):not([hidden]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

let sheet = null;
let sheetChanged = -Infinity;
let watcher = null; // closes the sheet on an Android Back press, instead of leaving the screen
const modal = () => document.getElementById('modal');
const app = () => document.getElementById('app');

export const sheetIsOpen = () => sheet !== null;
/** When a sheet last opened, changed or closed. New buttons may have appeared under the finger at that moment. */
export const sheetChangedAt = () => sheetChanged;
export const sheetIsDismissable = () => sheet !== null && sheet.dismissable;

/**
 * Shows a sheet that slides over the screen.
 * options: { label, dismissable (default true), onClose(value), wide }
 * A button with data-sheet="value" closes the sheet and passes the value to onClose.
 * Opening a sheet while another is open replaces it without calling the first one's onClose.
 */
// Where focus goes back to when the sheet closes. The element itself may have been redrawn by
// then, so a way to find its replacement is kept too.
function focusReturn(element) {
  if (!element || element === document.body) return null;
  const id = element.id;
  const act = element.getAttribute && element.getAttribute('data-act');
  const dataId = element.getAttribute && element.getAttribute('data-id');
  let selector = '';
  if (id && /^[A-Za-z][\w-]*$/.test(id)) selector = '#' + id;
  else if (act && /^[\w-]+$/.test(act)) selector = '[data-act="' + act + '"]' + (dataId && /^[\w.-]+$/.test(dataId) ? '[data-id="' + dataId + '"]' : '');
  const part = element.closest && element.closest('[data-part], [data-item]');
  return { element, selector, near: part ? (part.hasAttribute('data-part') ? '[data-part="' + part.getAttribute('data-part') + '"]' : '[data-item="' + part.getAttribute('data-item') + '"]') : '' };
}

function giveFocusBack(target) {
  if (!target) return;
  const root = app();
  let element = target.element && document.contains(target.element) ? target.element : null;
  if (!element && target.selector && root) element = root.querySelector(target.selector);
  if (!element && target.near && root) {
    // The button is gone (a deleted photo, say): the nearest button in the same part, or the part itself.
    const part = root.querySelector(target.near);
    element = part ? part.querySelector('button, input, textarea') || part : null;
  }
  if (!element && root) element = root.querySelector('[data-heading]');
  if (element && typeof element.focus === 'function') {
    if (!element.matches('button, input, textarea, select, a[href], [tabindex]')) element.setAttribute('tabindex', '-1');
    element.focus({ preventScroll: true });
  }
}

function watchBack() {
  if (watcher || typeof CloseWatcher !== 'function') return;
  try {
    watcher = new CloseWatcher();
  } catch (e) {
    watcher = null;
    return;
  }
  watcher.onclose = () => {
    watcher = null;
    if (!sheet) return;
    if (sheet.dismissable) closeSheet(undefined);
    else watchBack(); // a sheet that must be answered stays, and the next Back press is caught again
  };
}

function stopWatchingBack() {
  if (!watcher) return;
  const old = watcher;
  watcher = null;
  try {
    old.destroy();
  } catch (e) {
    /* already gone */
  }
}

export function openSheet(content, options) {
  const o = options || {};
  const box = modal();
  const previous = sheet ? sheet.returnFocus : focusReturn(document.activeElement);
  sheet = { dismissable: o.dismissable !== false, onClose: o.onClose || null, returnFocus: previous };
  sheetChanged = performance.now();
  box.innerHTML = String(html`<div class="sheet${o.wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${o.label || 'Message'}" tabindex="-1">${content}</div>`);
  box.hidden = false;
  box.classList.toggle('dismissable', sheet.dismissable);
  document.body.classList.add('modal-open');
  const root = app();
  if (root) root.inert = true;
  placeToast();
  watchBack();
  const first = box.querySelector('[data-autofocus]') || box.querySelector('.sheet');
  if (first) first.focus({ preventScroll: true });
  return box.querySelector('.sheet');
}

/** Closes the sheet. value is handed to the sheet's onClose. */
export function closeSheet(value) {
  if (!sheet) return;
  const closing = sheet;
  sheet = null;
  sheetChanged = performance.now();
  const box = modal();
  box.hidden = true;
  box.innerHTML = '';
  document.body.classList.remove('modal-open');
  const root = app();
  if (root) root.inert = false;
  stopWatchingBack();
  placeToast();
  giveFocusBack(closing.returnFocus);
  if (closing.onClose) closing.onClose(value);
}

/** A sheet with a spinner that cannot be dismissed. Replace it with another sheet when the work is done. */
export function busySheet(title, text) {
  return openSheet(html`<h2 id="sheet-title">${title}</h2><div class="spinner" role="img" aria-label="Working"></div><p data-busy-text>${text || ''}</p>`, { label: title, dismissable: false });
}

export function setBusyText(text) {
  const el = modal().querySelector('[data-busy-text]');
  if (el) el.textContent = text;
}

/** Shows a message with one button. Resolves when it is closed. */
export function messageSheet(title, text, button) {
  return new Promise((resolve) => {
    const lines = Array.isArray(text) ? text : [text];
    openSheet(html`<h2>${title}</h2>${lines.filter(Boolean).map((line) => html`<p>${line}</p>`)}<button type="button" class="btn" data-sheet="ok" data-autofocus>${button || 'OK'}</button>`, {
      label: title,
      onClose: () => resolve(),
    });
  });
}

/**
 * Asks a yes or no question. Resolves true only when the "yes" button is tapped.
 * options: { title, text, yes, no, danger }
 */
export function confirmSheet(options) {
  return new Promise((resolve) => {
    const lines = Array.isArray(options.text) ? options.text : [options.text];
    openSheet(
      html`<h2>${options.title}</h2>${lines.filter(Boolean).map((line) => html`<p>${line}</p>`)}
        <button type="button" class="btn${options.danger ? ' danger' : ''}" data-sheet="yes">${options.yes || 'Yes'}</button>
        <button type="button" class="btn ghost" data-sheet="no" data-autofocus>${options.no || 'Cancel'}</button>`,
      { label: options.title, onClose: (value) => resolve(value === 'yes') },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Toast

let toastTimer = null;
let toastAction = null;

export function hideToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  toastAction = null;
  const box = document.getElementById('toast');
  if (!box) return;
  box.hidden = true;
  box.innerHTML = '';
}

// Keeps the toast clear of the buttons: just above the sticky button bar at the bottom of the
// screen, or at the top of the screen while a sheet is open.
function placeToast() {
  const box = document.getElementById('toast');
  if (!box || box.hidden) return;
  box.classList.toggle('at-top', sheet !== null);
  let gap = 16;
  const bar = document.querySelector('#app .foot');
  if (bar) {
    const edge = bar.getBoundingClientRect();
    if (edge.top < window.innerHeight && edge.bottom > 0) gap = Math.max(16, Math.round(window.innerHeight - edge.top) + 10);
  }
  box.style.bottom = gap + 'px';
}

/** A short message near the bottom of the screen. options: { action, onAction, ms } */
export function toast(message, options) {
  const o = options || {};
  const box = document.getElementById('toast');
  if (!box) return;
  clearTimeout(toastTimer);
  toastAction = o.action && o.onAction ? o.onAction : null;
  box.innerHTML = String(html`<div class="toast-in"><span>${message}</span>${toastAction ? html`<button type="button" data-toast-action>${o.action}</button>` : ''}</div>`);
  box.hidden = false;
  placeToast();
  toastTimer = setTimeout(hideToast, o.ms || (toastAction ? 8000 : 4000));
}

/** Call after the screen has been redrawn, so a toast that is showing moves with the buttons. */
export const tidyToast = () => placeToast();

// ---------------------------------------------------------------------------------------------
// Taps and keys that belong to the sheet and the toast

/** Handles a tap on the sheet or the toast. Returns true when the tap was used up. */
export function handleUiTap(event) {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const toastButton = target.closest('[data-toast-action]');
  if (toastButton) {
    const action = toastAction;
    hideToast();
    if (action) action();
    return true;
  }
  const box = modal();
  if (sheet && box.contains(target)) {
    const button = target.closest('[data-sheet]');
    if (button && !button.disabled) {
      closeSheet(button.getAttribute('data-sheet'));
      return true;
    }
    if (target === box) {
      if (sheet.dismissable) closeSheet(undefined);
      return true;
    }
  }
  return false;
}

/** Sets up the keys: Escape closes a sheet, Tab stays inside it. Call once. */
export function installUi() {
  // On a phone turned on its side the button bar scrolls with the page, so the toast follows it.
  let placing = false;
  window.addEventListener(
    'scroll',
    () => {
      const box = document.getElementById('toast');
      if (placing || !box || box.hidden) return;
      placing = true;
      requestAnimationFrame(() => {
        placing = false;
        placeToast();
      });
    },
    { passive: true },
  );
  document.addEventListener('keydown', (event) => {
    if (!sheet) return;
    if (event.key === 'Escape') {
      if (sheet.dismissable) {
        event.preventDefault();
        closeSheet(undefined);
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const box = modal();
    const items = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !box.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !box.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });
}
