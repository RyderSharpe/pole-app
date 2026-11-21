// A pad to draw on with a finger. Everything drawn is an item that can be picked up again: a
// straight line, a freehand stroke, some words, or a standard symbol (1PH transformer, street
// light and so on). A picked item can be moved, made bigger or smaller, turned, copied or
// deleted. A line also has a grab point at each end, to change its length, height and angle.
//
// The pad starts blank, or with a photo underneath so the photo can be marked up. Saving gives
// the finished picture and a description of its items, so the drawing can be opened and changed
// later. The sums (where an item is, what a finger is touching) are in scene.js.

import {
  COLOURS, SYMBOLS, symbolReach, MAX_ITEMS, drawItems, drawPick, itemAt, moveItem, handles, resizeItem, sizeFromHandle,
  snapAngle, anchors, snapToAnchor, thin,
} from './scene.js';

const BLANK = { width: 1200, height: 1500 };
const MAX_SIDE = 1600;
const MAX_LABEL = 60;
const HISTORY = 60;

let open = null; // the pad on screen, if any

/** True while the pad is on screen. */
export const sketchIsOpen = () => open !== null;

function make(tag, props, children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children || []) if (child) element.append(child);
  return element;
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        URL.revokeObjectURL(url);
        reject(new Error('The phone could not read that picture.'));
        return;
      }
      resolve({ image, release: () => URL.revokeObjectURL(url) });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The phone could not read that picture.'));
    };
    image.src = url;
  });
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Opens the pad.
 * options: {
 *   background   a picture (Blob) to draw on top of, or null for a blank white page
 *   scene        a saved sketch ({ w, h, bg, items }) to carry on with, or null to start empty
 *   bg           the id of the photo underneath, kept in the saved sketch
 *   title        the words at the top
 *   onSave(blob, scene)  called with the finished JPEG and the sketch. May return a promise; the pad
 *                        closes when it settles.
 * }
 * Resolves true when a sketch was saved, false when the pad was closed without saving.
 */
export async function openSketch(options) {
  if (open) return false;
  const o = options || {};
  let under = null;
  if (o.background) under = await loadImage(o.background);

  let width = BLANK.width;
  let height = BLANK.height;
  if (o.scene && o.scene.w > 0 && o.scene.h > 0) {
    width = o.scene.w;
    height = o.scene.h;
  } else if (under) {
    const scale = Math.min(1, MAX_SIDE / Math.max(under.image.naturalWidth, under.image.naturalHeight));
    width = Math.max(1, Math.round(under.image.naturalWidth * scale));
    height = Math.max(1, Math.round(under.image.naturalHeight * scale));
  }
  const unit = Math.max(width, height) / 300; // one "pen width" for this size of picture

  const base = make('canvas', { class: 'sk-base', width, height, 'aria-hidden': 'true' });
  const ink = make('canvas', { class: 'sk-ink', width, height, role: 'img', 'aria-label': 'Drawing area' });
  const baseContext = base.getContext('2d');
  const inkContext = ink.getContext('2d');
  if (!baseContext || !inkContext) {
    if (under) under.release();
    throw new Error('The phone is too low on memory to open the sketch pad.');
  }
  baseContext.fillStyle = '#FFFFFF';
  baseContext.fillRect(0, 0, width, height);
  if (under) baseContext.drawImage(under.image, 0, 0, width, height);

  const state = {
    tool: o.scene && o.scene.items.length ? 'select' : 'line',
    color: under ? COLOURS[1].value : COLOURS[0].value,
    items: o.scene ? clone(o.scene.items) : [],
    sel: null, // the picked item
    symbol: '',
    history: [],
    dirty: false,
    drag: null,
    pointerId: null,
    saving: false,
    asking: false,
    queued: false,
    typing: false, // words being edited: one undo step for the whole edit
  };

  const button = (label, props, text) => make('button', { type: 'button', 'aria-label': label, ...props, text: text == null ? label : text });
  const cancel = button('Close without saving', { class: 'sk-btn', 'data-sk': 'cancel' }, 'Cancel');
  const title = make('div', { class: 'sk-title', text: o.title || 'Sketch' });
  const saveButton = button('Save the sketch', { class: 'sk-btn primary', 'data-sk': 'save' }, 'Save');
  const top = make('div', { class: 'sk-top' }, [cancel, title, saveButton]);

  const hint = make('div', { class: 'sk-hint' });
  const textInput = make('input', { class: 'sk-input', type: 'text', maxlength: MAX_LABEL, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Words' });
  const actions = [
    button('Delete the picked item', { class: 'sk-mini danger', 'data-sk': 'delete' }, 'Delete'),
    button('Copy the picked item', { class: 'sk-mini', 'data-sk': 'copy' }, 'Copy'),
    button('Smaller', { class: 'sk-mini', 'data-sk': 'smaller' }, 'Smaller'),
    button('Bigger', { class: 'sk-mini', 'data-sk': 'bigger' }, 'Bigger'),
    button('Turn the symbol', { class: 'sk-mini', 'data-sk': 'turn' }, 'Turn'),
  ];
  const actionRow = make('div', { class: 'sk-row', role: 'group', 'aria-label': 'Picked item' }, actions);
  const ctxBar = make('div', { class: 'sk-labelbar' }, [hint, actionRow, textInput]);

  const askText = make('div', { class: 'sk-asktext', text: 'Close without saving these changes?' });
  const askYes = button('Close without saving', { class: 'sk-btn danger', 'data-sk': 'discard' }, 'Discard');
  const askNo = button('Keep drawing', { class: 'sk-btn', 'data-sk': 'keep' }, 'Keep drawing');
  const askBar = make('div', { class: 'sk-ask', hidden: true, role: 'alertdialog', 'aria-label': 'Close without saving?' }, [askText, askNo, askYes]);

  const stage = make('div', { class: 'sk-stage' }, [base, ink]);
  const area = make('div', { class: 'sk-area' }, [stage]);

  const tools = [
    button('Pick and move', { class: 'sk-tool', 'data-sk': 'tool', 'data-tool': 'select' }, 'Pick'),
    button('Straight line', { class: 'sk-tool', 'data-sk': 'tool', 'data-tool': 'line' }, 'Line'),
    button('Freehand pen', { class: 'sk-tool', 'data-sk': 'tool', 'data-tool': 'pen' }, 'Pen'),
    button('Words', { class: 'sk-tool', 'data-sk': 'tool', 'data-tool': 'text' }, 'Text'),
    button('Undo', { class: 'sk-tool', 'data-sk': 'undo' }),
  ];
  const symbolSelect = make('select', { class: 'sk-select', 'aria-label': 'Add a symbol', 'data-sk-select': 'symbol' }, [
    make('option', { value: '', text: 'Symbols' }),
    make('optgroup', { label: 'Side view of a pole' }, SYMBOLS.filter((s) => s.group === 'side').map((s) => make('option', { value: s.key, text: s.name }))),
    make('optgroup', { label: 'Seen from above' }, SYMBOLS.filter((s) => s.group === 'above').map((s) => make('option', { value: s.key, text: s.name }))),
  ]);
  const swatches = COLOURS.map((c) => {
    const b = button(c.name, { class: 'sk-colour', 'data-sk': 'colour', 'data-colour': c.value }, '');
    b.style.backgroundColor = c.value;
    return b;
  });
  const bottom = make('div', { class: 'sk-bottom' }, [
    make('div', { class: 'sk-tools', role: 'group', 'aria-label': 'Tools' }, tools),
    make('div', { class: 'sk-extra' }, [symbolSelect, make('div', { class: 'sk-colours', role: 'group', 'aria-label': 'Colours' }, swatches)]),
  ]);

  const pad = make('div', { class: 'sketch', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Sketch', tabindex: '-1' }, [top, ctxBar, askBar, area, bottom]);

  const app = document.getElementById('app');
  const before = document.activeElement;

  // ---- drawing -------------------------------------------------------------------------------

  const render = () => {
    state.queued = false;
    if (open !== pad) return;
    inkContext.clearRect(0, 0, width, height);
    drawItems(inkContext, state.items);
    if (state.tool === 'select' && state.sel) drawPick(inkContext, state.sel, unit);
  };
  const queueRender = () => {
    if (state.queued) return;
    state.queued = true;
    requestAnimationFrame(render);
  };

  // The drawing is shown as large as fits, keeping its shape.
  function fit() {
    const box = area.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const scale = Math.min(box.width / width, box.height / height);
    stage.style.width = Math.floor(width * scale) + 'px';
    stage.style.height = Math.floor(height * scale) + 'px';
  }

  // A finger is about this wide, whatever the size of the drawing.
  const px = (cssPixels) => {
    const rect = ink.getBoundingClientRect();
    return rect.width ? cssPixels * (width / rect.width) : cssPixels * 3;
  };
  const at = (event) => {
    const rect = ink.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * width, y: ((event.clientY - rect.top) / rect.height) * height };
  };
  const inside = (p) => [Math.max(0, Math.min(width, p.x)), Math.max(0, Math.min(height, p.y))];

  const hasText = (item) => item && (item.t === 'text' || item.t === 'sym');

  // ---- history -------------------------------------------------------------------------------

  const snap = () => {
    state.history.push(JSON.stringify(state.items));
    if (state.history.length > HISTORY) state.history.shift();
    state.dirty = true;
  };

  // ---- the bars ------------------------------------------------------------------------------

  let inputFor = null; // what the words box is showing: the picked item, or 'new'

  const sync = () => {
    for (const t of tools) {
      if (!t.hasAttribute('data-tool')) continue;
      const on = t.getAttribute('data-tool') === state.tool;
      t.classList.toggle('on', on);
      t.setAttribute('aria-pressed', String(on));
    }
    tools[4].disabled = state.history.length === 0;
    for (const s of swatches) {
      const on = s.getAttribute('data-colour') === (state.sel && state.tool === 'select' ? state.sel.c : state.color);
      s.classList.toggle('on', on);
      s.setAttribute('aria-pressed', String(on));
    }
    symbolSelect.value = state.tool === 'symbol' ? state.symbol : '';
    const picked = state.tool === 'select' ? state.sel : null;
    actionRow.hidden = !picked;
    actions[4].hidden = !picked || picked.t !== 'sym';
    const wantsInput = state.tool === 'text' || hasText(picked);
    textInput.hidden = !wantsInput;
    if (wantsInput) {
      const target = state.tool === 'text' ? 'new' : picked;
      if (inputFor !== target) {
        inputFor = target;
        textInput.value = target === 'new' ? '' : picked.text;
        textInput.placeholder = target === 'new' ? 'Type the words' : picked.t === 'sym' ? 'Words under the symbol' : 'Words';
      }
    } else inputFor = null;
    let words = '';
    if (state.tool === 'select') {
      if (!picked) words = state.items.length ? 'Tap a line, symbol or label to pick it up, then drag it to move it.' : 'Nothing drawn yet. Use Line, Pen, Text or Add a symbol.';
      else if (picked.t === 'line') words = 'Drag the line to move it. Drag a white dot to change its length, height or angle.';
      else if (picked.t === 'pen') words = 'Drag the stroke to move it.';
      else words = 'Drag to move it. Drag the white dot to change the size.';
    } else if (state.tool === 'line') words = 'Drag to draw a straight line. Lines snap level, upright and to 45 degrees.';
    else if (state.tool === 'pen') words = 'Draw freehand. Use Line for straight lines.';
    else if (state.tool === 'text') words = 'Type the words, then tap the drawing where they go.';
    else if (state.tool === 'symbol') words = 'Tap the drawing where it goes. You can move it afterwards.';
    hint.textContent = words;
    ctxBar.hidden = state.asking;
    askBar.hidden = !state.asking;
    saveButton.disabled = state.saving;
    cancel.disabled = state.saving;
    saveButton.textContent = state.saving ? 'Saving…' : 'Save';
    // Showing or hiding a bar changes how much room the drawing has.
    fit();
    queueRender();
  };

  const pick = (item) => {
    state.sel = item;
    sync();
  };

  // ---- fingers -------------------------------------------------------------------------------

  const capture = (event) => {
    state.pointerId = event.pointerId;
    try {
      ink.setPointerCapture(event.pointerId);
    } catch (e) {
      /* moves still reach the canvas while the finger is on it */
    }
  };

  // The end of a line: onto another line's end or a symbol if close, otherwise snapped straight.
  const lineEnd = (from, p, skip) => {
    const near = snapToAnchor([p.x, p.y], anchors(state.items, skip), px(14));
    if (near) return near;
    return snapAngle(from, inside(p), 5);
  };

  const place = (item) => {
    snap();
    state.items.push(item);
    state.tool = 'select';
    state.symbol = '';
    pick(item);
  };

  const onDown = (event) => {
    if (state.saving || state.asking || state.pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    if (document.activeElement === textInput || document.activeElement === symbolSelect) document.activeElement.blur();
    const p = at(event);
    if (state.items.length >= MAX_ITEMS && state.tool !== 'select') {
      hint.textContent = 'This drawing is full. Delete something to add more.';
      return;
    }
    if (state.tool === 'text') {
      const text = textInput.value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
      if (!text) {
        hint.classList.remove('nudge');
        void hint.offsetWidth; // start the nudge again from the beginning
        hint.classList.add('nudge');
        textInput.focus({ preventScroll: true });
        return;
      }
      const s = Math.round(unit * 9);
      const item = { t: 'text', c: state.color, s, x: p.x, y: p.y, text, w: 0 };
      drawItems(inkContext, [item]); // measures the words
      item.x = Math.max(s * 0.3, Math.min(width - item.w - s * 0.3, p.x - item.w / 2));
      item.y = Math.max(s * 0.7, Math.min(height - s * 0.7, p.y));
      inputFor = null;
      place(item);
      return;
    }
    if (state.tool === 'symbol') {
      const kind = SYMBOLS.find((s) => s.key === state.symbol);
      if (!kind) return;
      const s = (unit / 5) * 2.4 * (kind.size || 1);
      const r = symbolReach(kind.key) * s;
      const item = { t: 'sym', k: kind.key, c: state.color, s, r: 0, x: Math.max(r, Math.min(width - r, p.x)), y: Math.max(r, Math.min(height - r, p.y)), text: kind.text };
      inputFor = null;
      place(item);
      return;
    }
    if (state.tool === 'line') {
      capture(event);
      snap();
      const a = snapToAnchor([p.x, p.y], anchors(state.items), px(14)) || inside(p);
      const item = { t: 'line', c: state.color, w: unit * 1.6, a, b: [a[0], a[1]] };
      state.items.push(item);
      state.drag = { mode: 'draw', item };
      queueRender();
      return;
    }
    if (state.tool === 'pen') {
      capture(event);
      snap();
      const item = { t: 'pen', c: state.color, w: unit * 1.6, p: [[p.x, p.y]] };
      state.items.push(item);
      state.drag = { mode: 'pen', item };
      queueRender();
      return;
    }
    // Pick and move: a grab point of the picked item first, then any item under the finger.
    const reach = px(16);
    if (state.sel) {
      let best = null;
      let nearest = px(18);
      for (const h of handles(state.sel)) {
        const d = Math.hypot(p.x - h.x, p.y - h.y);
        if (d <= nearest) {
          best = h;
          nearest = d;
        }
      }
      if (best) {
        capture(event);
        snap();
        const item = state.sel;
        state.drag = { mode: 'handle', item, id: best.id, startSize: item.s, startDist: Math.hypot(best.x - item.x, best.y - item.y), moved: false };
        return;
      }
    }
    const found = itemAt(state.items, p, reach);
    if (!found) {
      if (state.sel) pick(null);
      return;
    }
    capture(event);
    snap();
    state.drag = { mode: 'move', item: found, last: p, moved: false };
    if (state.sel !== found) pick(found);
  };

  const onMove = (event) => {
    const d = state.drag;
    if (!d || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    if (d.mode === 'pen') {
      // A fast finger sends several positions in one event. Using all of them keeps curves smooth.
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      for (const e of events.length ? events : [event]) {
        const p = at(e);
        const last = d.item.p[d.item.p.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) < unit * 0.35) continue;
        d.item.p.push([p.x, p.y]);
      }
      queueRender();
      return;
    }
    const p = at(event);
    if (d.mode === 'draw') {
      d.item.b = lineEnd(d.item.a, p, d.item);
      queueRender();
    } else if (d.mode === 'handle') {
      const item = d.item;
      d.moved = true;
      if (item.t === 'line') {
        const fixed = d.id === 'a' ? item.b : item.a;
        const end = lineEnd(fixed, p, item);
        if (d.id === 'a') item.a = end;
        else item.b = end;
      } else {
        const size = sizeFromHandle(item, p, d.startSize, d.startDist);
        item.s = size;
      }
      queueRender();
    } else if (d.mode === 'move') {
      const dx = p.x - d.last.x;
      const dy = p.y - d.last.y;
      d.last = p;
      if (!d.moved && Math.hypot(dx, dy) < px(2)) return;
      d.moved = true;
      moveItem(d.item, dx, dy);
      queueRender();
    }
  };

  const onUp = (event) => {
    const d = state.drag;
    if (!d || event.pointerId !== state.pointerId) return;
    state.drag = null;
    state.pointerId = null;
    if (d.mode === 'draw') {
      const length = Math.hypot(d.item.b[0] - d.item.a[0], d.item.b[1] - d.item.a[1]);
      if (length < unit * 2) {
        // A tap, not a line.
        state.items.splice(state.items.indexOf(d.item), 1);
        state.history.pop();
      }
    } else if (d.mode === 'pen') {
      d.item.p = thin(d.item.p);
    } else if (!d.moved) {
      // Picked but not moved: nothing to undo.
      state.history.pop();
    }
    sync();
  };

  // ---- closing and saving --------------------------------------------------------------------

  let settle = null;
  const result = new Promise((resolve) => {
    settle = resolve;
  });

  const close = (saved) => {
    if (open !== pad) return;
    open = null;
    window.removeEventListener('resize', fit);
    document.removeEventListener('keydown', onKey, true);
    pad.remove();
    document.body.classList.remove('sketch-open');
    if (app) app.inert = false;
    if (under) under.release();
    // Giving the canvases back straight away matters on iPhones, which allow only a small total.
    for (const canvas of [base, ink]) {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (before && document.contains(before) && typeof before.focus === 'function') before.focus({ preventScroll: true });
    settle(saved);
  };

  const save = async () => {
    if (state.saving) return;
    state.saving = true;
    sync();
    const out = document.createElement('canvas');
    try {
      out.width = width;
      out.height = height;
      const context = out.getContext('2d');
      if (!context) throw new Error('The phone is too low on memory to save this sketch.');
      context.drawImage(base, 0, 0);
      drawItems(context, state.items); // without the marks that show what is picked
      const blob = await new Promise((resolve, reject) => {
        out.toBlob((b) => (b && b.size ? resolve(b) : reject(new Error('The phone could not save this sketch.'))), 'image/jpeg', 0.92);
      });
      const scene = { v: 1, w: width, h: height, bg: o.bg || (o.scene && o.scene.bg) || '', items: clone(state.items) };
      if (o.onSave) await o.onSave(blob, scene);
      close(true);
    } catch (error) {
      console.error(error);
      state.saving = false;
      sync();
      title.textContent = 'Not saved. Try again.';
    } finally {
      out.width = 0;
      out.height = 0;
    }
  };

  // ---- taps on the buttons -------------------------------------------------------------------

  const withPicked = (change) => {
    const item = state.sel;
    if (!item) return;
    snap();
    change(item);
    sync();
  };

  const onClick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-sk]') : null;
    // Taps on the pad are dealt with here and go no further.
    event.stopPropagation();
    if (!target || target.disabled) return;
    const what = target.getAttribute('data-sk');
    if (what === 'tool') {
      state.tool = target.getAttribute('data-tool');
      if (state.tool !== 'select') state.sel = null;
      sync();
      if (state.tool === 'text') textInput.focus({ preventScroll: true });
    } else if (what === 'colour') {
      const value = target.getAttribute('data-colour');
      state.color = value;
      if (state.tool === 'select' && state.sel) {
        withPicked((item) => {
          item.c = value;
        });
      } else sync();
    } else if (what === 'undo') {
      const last = state.history.pop();
      if (last) {
        state.items = JSON.parse(last);
        state.sel = null;
        inputFor = null;
      }
      sync();
    } else if (what === 'delete') {
      withPicked((item) => {
        state.items.splice(state.items.indexOf(item), 1);
        state.sel = null;
      });
    } else if (what === 'copy') {
      if (state.items.length >= MAX_ITEMS) return;
      withPicked((item) => {
        const copy = clone(item);
        moveItem(copy, unit * 8, unit * 8);
        state.items.push(copy);
        state.sel = copy;
      });
    } else if (what === 'bigger' || what === 'smaller') {
      withPicked((item) => resizeItem(item, what === 'bigger' ? 1.25 : 0.8));
    } else if (what === 'turn') {
      withPicked((item) => {
        item.r = ((item.r || 0) + 45) % 360;
      });
    } else if (what === 'save') {
      save();
    } else if (what === 'cancel') {
      if (!state.dirty) {
        close(false);
        return;
      }
      state.asking = true;
      sync();
      askNo.focus({ preventScroll: true });
    } else if (what === 'keep') {
      state.asking = false;
      sync();
    } else if (what === 'discard') {
      close(false);
    }
  };

  symbolSelect.addEventListener('change', () => {
    if (!symbolSelect.value) return;
    state.symbol = symbolSelect.value;
    state.tool = 'symbol';
    state.sel = null;
    sync();
  });

  // Editing the words on a picked item, or typing the words for a new one.
  textInput.addEventListener('input', () => {
    const item = state.tool === 'select' ? state.sel : null;
    if (!item || !hasText(item)) return;
    if (!state.typing) {
      snap();
      state.typing = true;
    }
    item.text = textInput.value.replace(/\s+/g, ' ').slice(0, MAX_LABEL);
    queueRender();
  });
  textInput.addEventListener('blur', () => {
    state.typing = false;
    const item = state.tool === 'select' ? state.sel : null;
    // Words on a plain label cannot be left empty. A symbol may have none.
    if (item && item.t === 'text' && !item.text.trim()) {
      state.items.splice(state.items.indexOf(item), 1);
      state.sel = null;
      sync();
    } else if (item && hasText(item)) {
      item.text = item.text.trim();
      queueRender();
    }
  });

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (state.asking) {
        state.asking = false;
        sync();
      } else cancel.click();
    } else if (event.key === 'Enter' && event.target === textInput) {
      event.preventDefault();
      textInput.blur();
    }
  }

  pad.addEventListener('click', onClick);
  ink.addEventListener('pointerdown', onDown);
  ink.addEventListener('pointermove', onMove);
  ink.addEventListener('pointerup', onUp);
  ink.addEventListener('pointercancel', onUp);
  // A finger on the drawing draws. It must not scroll, zoom or select anything.
  ink.addEventListener('touchstart', (event) => event.preventDefault(), { passive: false });
  ink.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', fit);

  open = pad;
  document.body.append(pad);
  document.body.classList.add('sketch-open');
  if (app) app.inert = true;
  sync();
  fit();
  render();
  pad.focus({ preventScroll: true });
  return result;
}
