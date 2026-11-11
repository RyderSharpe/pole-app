// Draws form items from the template and keeps the warnings and calculated values up to date
// while the user types. The same code draws the job details and every step of a pole.
//
// ctx: {
//   template, tokens,
//   f                       the answers (the live record, not a copy)
//   set(key, value)         stores one answer
//   usedElsewhere(key, v)   true when another pole in the job has the same answer
// }

import { html, attrs, icon } from './ui.js';
import { screenLabel, applyTokens, isShown, isNA, holdsValue, fieldWarnings, computeAll } from './template-engine.js';
import { describeValue } from './compute.js';
import { MAX_TEXT } from './config.js';

const hintText = (warnings) => warnings.join(' ');

function textItem(item, ctx) {
  const key = item.key;
  const value = ctx.f[key] == null ? '' : ctx.f[key];
  const warnings = fieldWarnings(item, ctx.f, ctx.usedElsewhere);
  const numeric = item.type === 'number';
  const input = attrs({
    class: 'input' + (item.mono ? ' mono' : '') + (warnings.length ? ' alert' : ''),
    id: 'f-' + key,
    'data-k': key,
    type: 'text',
    inputmode: numeric ? 'decimal' : null,
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: item.mono ? 'characters' : 'sentences',
    spellcheck: 'false',
    enterkeyhint: 'next',
    maxlength: numeric ? 40 : 500,
    placeholder: item.placeholder || null,
    value,
    'aria-describedby': 'h-' + key,
  });
  return html`<div class="field" data-item="${key}">
    <label class="label" for="f-${key}">${screenLabel(item, ctx.tokens)}</label>
    <input${input}>
    <div class="hint" id="h-${key}"${attrs({ hidden: !warnings.length })}>${hintText(warnings)}</div>
  </div>`;
}

function rowNumberItem(item, ctx) {
  const key = item.key;
  const value = ctx.f[key] == null ? '' : ctx.f[key];
  const warnings = fieldWarnings(item, ctx.f, ctx.usedElsewhere);
  const input = attrs({
    class: 'num' + (warnings.length ? ' alert' : ''),
    id: 'f-' + key,
    'data-k': key,
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'next',
    maxlength: 40,
    value,
    'aria-describedby': 'h-' + key,
  });
  return html`<div class="numwrap" data-item="${key}">
    <div class="numrow">
      <label for="f-${key}">${screenLabel(item, ctx.tokens)}</label>
      <div class="right"><input${input}><div class="unit" aria-hidden="true">${item.unit || ''}</div></div>
    </div>
    <div class="hint end" id="h-${key}"${attrs({ hidden: !warnings.length })}>${hintText(warnings)}</div>
  </div>`;
}

// A question that does not apply is drawn at the height of the question it stands in for, so
// answering the question above it does not move everything below.
function notApplicable(item, ctx) {
  if (item.type === 'number' && item.layout === 'row') {
    return html`<div class="numrow" data-item="${item.key}">
      <div class="na-label">${screenLabel(item, ctx.tokens)}</div>
      <div class="na">N/A</div>
    </div>`;
  }
  const size = item.type === 'choice' ? 'seg-size' : item.type === 'toggle' ? 'toggle-size' : 'input-size';
  return html`<div class="field" data-item="${item.key}">
    <div class="na-label">${screenLabel(item, ctx.tokens)}</div>
    <div class="na na-box ${size}">N/A</div>
  </div>`;
}

function choiceItem(item, ctx) {
  const key = item.key;
  const value = ctx.f[key];
  const columns = item.options.length >= 4 ? 'c4' : item.options.length === 3 ? 'c3' : 'c2';
  // A long single word ("Questionable") needs two columns on a narrower phone (see styles.css).
  const long = item.options.some((option) => option.split(/\s+/).some((word) => word.length > 9));
  const buttons = item.options.map((option, i) => {
    const on = value === option;
    const classes = [on ? 'on' : '', option.length > 9 ? 'small' : ''].filter(Boolean).join(' ');
    // A fixed id lets focus stay on this button when the screen is redrawn after the tap.
    return html`<button type="button"${attrs({ class: classes || null, id: 'c-' + key + '-' + i, 'aria-pressed': String(on), 'data-choice': key, 'data-v': option })}>${option}</button>`;
  });
  return html`<div class="field" data-item="${key}">
    <div class="label" id="l-${key}">${screenLabel(item, ctx.tokens)}</div>
    <div class="seg ${columns}${long ? ' long' : ''}" role="group" aria-labelledby="l-${key}">${buttons}</div>
  </div>`;
}

function toggleItem(item, ctx) {
  const on = ctx.f[item.key] === true;
  return html`<div data-item="${item.key}">
    <button type="button"${attrs({ class: 'dashed' + (on ? ' on' : ''), id: 'f-' + item.key, 'data-toggle': item.key, 'aria-pressed': String(on) })}>${on ? icon.checkSmall : ''}${screenLabel(item, ctx.tokens)}</button>
  </div>`;
}

function noteItem(item, ctx) {
  const key = item.key;
  const value = ctx.f[key] == null ? '' : ctx.f[key];
  return html`<div class="field" data-item="${key}">
    <label class="label" for="f-${key}">${screenLabel(item, ctx.tokens)}</label>
    <textarea${attrs({ class: 'notes', id: 'f-' + key, 'data-k': key, rows: item.rows || 4, maxlength: MAX_TEXT, autocomplete: 'off' })}>${value}</textarea>
  </div>`;
}

/** The inside of a calculated card. */
export function computedInner(item, ctx) {
  const values = computeAll(ctx.template, ctx.f);
  const rows = item.rows.map((row) => {
    const shown = describeValue(values[row.key], item.unit);
    const state = shown.state === 'blank' ? ' none' : shown.state === 'ok' ? '' : ' neg';
    return html`<div class="row"><div class="k">${applyTokens(row.label, ctx.tokens)}</div><div class="v${state}">${shown.text}</div></div>`;
  });
  return html`<div class="eyebrow">${applyTokens(item.label, ctx.tokens)}</div>${rows}`;
}

function computedItem(item, ctx) {
  return html`<div class="seps" data-computed="${item.key}" role="group" aria-label="${applyTokens(item.label, ctx.tokens)}">${computedInner(item, ctx)}</div>`;
}

function renderItem(item, ctx, extra) {
  if (!isShown(item, ctx.f)) return '';
  if (item.type === 'heading') return html`<h2 class="subhead eyebrow">${applyTokens(item.label, ctx.tokens)}</h2>`;
  if (item.type === 'divider') return html`<div class="subhead" role="separator"></div>`;
  if (item.type === 'computed') return computedItem(item, ctx);
  if (holdsValue(item)) {
    if (isNA(item, ctx.f)) return notApplicable(item, ctx);
    if (item.type === 'choice') return choiceItem(item, ctx);
    if (item.type === 'toggle') return toggleItem(item, ctx);
    if (item.type === 'note') return noteItem(item, ctx);
    if (item.type === 'number' && item.layout === 'row') return rowNumberItem(item, ctx);
    return textItem(item, ctx);
  }
  const special = extra && extra[item.type];
  return special ? special(item) : '';
}

/**
 * Draws a list of items. extra maps the special item types (gps, photos, review) to functions
 * that draw them, because those belong to the pole screen.
 * Runs of short number rows are grouped so they sit closer together.
 */
export function renderItems(items, ctx, extra) {
  const out = [];
  let run = [];
  const closeRun = () => {
    if (run.length) out.push(html`<div class="stack">${run}</div>`);
    run = [];
  };
  for (const item of items) {
    const compact = isShown(item, ctx.f) && (item.layout === 'row' || item.type === 'toggle' || item.type === 'computed');
    const piece = renderItem(item, ctx, extra);
    if (piece === '') continue;
    if (compact) {
      run.push(piece);
    } else {
      closeRun();
      out.push(piece);
    }
  }
  closeRun();
  return out;
}

/** Brings the warnings and calculated cards on screen up to date, without redrawing any input. */
export function refreshLive(root, items, ctx) {
  for (const item of items) {
    if (!isShown(item, ctx.f)) continue;
    if (item.type === 'computed') {
      const card = root.querySelector('[data-computed="' + item.key + '"]');
      if (card) card.innerHTML = String(computedInner(item, ctx));
      continue;
    }
    if (!holdsValue(item) || isNA(item, ctx.f)) continue;
    const hint = root.querySelector('#h-' + item.key);
    if (!hint) continue;
    const warnings = fieldWarnings(item, ctx.f, ctx.usedElsewhere);
    const text = hintText(warnings);
    if (hint.textContent !== text) hint.textContent = text;
    hint.hidden = warnings.length === 0;
    const input = root.querySelector('#f-' + item.key);
    if (input) input.classList.toggle('alert', warnings.length > 0);
  }
}

/** Stores what was typed in an input. Returns the key, or '' if the element is not a form input. */
export function handleInput(element, ctx) {
  const key = element && element.dataset ? element.dataset.k : '';
  if (!key) return '';
  ctx.set(key, element.value);
  return key;
}

// A second tap on the answer just chosen is a "did that work?" tap, not a wish to clear it.
const KEEP_MS = 1500;
let lastChoice = { key: '', value: '', t: -Infinity };

/**
 * Handles a tap on a choice or a toggle. Tapping the chosen option again clears it, unless it
 * was chosen in the last moment. onCleared(key, value) is told about a clear, so it can offer Undo.
 * Returns the key that changed, '' when the tap was not on a choice or toggle, or null when it
 * was on a choice and nothing needed to change.
 */
export function handleTap(target, ctx, onCleared) {
  const choice = target.closest('[data-choice]');
  if (choice) {
    const key = choice.getAttribute('data-choice');
    const value = choice.getAttribute('data-v');
    const now = performance.now();
    if (ctx.f[key] === value) {
      if (lastChoice.key === key && lastChoice.value === value && now - lastChoice.t < KEEP_MS) return null;
      ctx.set(key, '');
      lastChoice = { key: '', value: '', t: -Infinity };
      if (onCleared) onCleared(key, value);
      return key;
    }
    ctx.set(key, value);
    lastChoice = { key, value, t: now };
    return key;
  }
  const toggle = target.closest('[data-toggle]');
  if (toggle) {
    const key = toggle.getAttribute('data-toggle');
    ctx.set(key, ctx.f[key] !== true);
    return key;
  }
  return '';
}

/** Moves to the next input when Enter is pressed. Hides the keyboard after the last one. */
export function focusNextField(element, root) {
  const inputs = [...root.querySelectorAll('input[data-k], textarea[data-k]')];
  const next = inputs[inputs.indexOf(element) + 1];
  if (!next) {
    element.blur();
    return;
  }
  next.focus({ preventScroll: true });
  // Clear of the sticky header and footer (see scroll-padding in styles.css).
  next.scrollIntoView({ block: 'nearest' });
}

/** Scrolls to one item and puts the cursor in it. Returns false if it is not on this screen. */
export function focusItem(root, key) {
  const safe = String(key).replace(/[^a-zA-Z0-9]/g, '');
  const box = root.querySelector('[data-item="' + safe + '"], [data-computed="' + safe + '"]');
  if (!box) return false;
  const input = box.querySelector('input, textarea, button');
  box.scrollIntoView({ block: 'center' });
  if (input) input.focus({ preventScroll: true });
  box.classList.add('flash');
  setTimeout(() => box.classList.remove('flash'), 1600);
  return true;
}
