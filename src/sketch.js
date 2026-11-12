// A pad to draw on with a finger: a pen in a few colours, a rubber, typed labels, and undo.
// It starts blank, or with a photo underneath so the photo can be marked up.
//
// The pad covers the whole screen and looks after its own taps. The picture underneath and the
// ink are kept on two canvases, so the rubber removes ink and never the photo.

const COLOURS = [
  { name: 'Black', value: '#14181A' },
  { name: 'Red', value: '#D42A20' },
  { name: 'Blue', value: '#1D5FD0' },
  { name: 'Green', value: '#0A7A45' },
  { name: 'Yellow', value: '#F2C40F' },
];
const BLANK = { width: 1200, height: 1500 };
const MAX_SIDE = 1600;
const MAX_LABEL = 60;

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

/** Draws everything in ops onto the ink canvas, from nothing. */
function replay(context, width, height, ops) {
  context.clearRect(0, 0, width, height);
  for (const op of ops) drawOp(context, op);
}

function drawOp(context, op) {
  if (op.type === 'text') {
    context.save();
    context.globalCompositeOperation = 'source-over';
    context.font = '600 ' + op.size + 'px "IBM Plex Sans", system-ui, -apple-system, sans-serif';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    // A light edge keeps a label readable on top of a photo or of other ink.
    context.lineWidth = Math.max(3, op.size / 5);
    context.strokeStyle = op.color === '#F2C40F' ? '#14181A' : '#FFFFFF';
    context.strokeText(op.text, op.x, op.y);
    context.fillStyle = op.color;
    context.fillText(op.text, op.x, op.y);
    context.restore();
    return;
  }
  context.save();
  context.globalCompositeOperation = op.erase ? 'destination-out' : 'source-over';
  context.strokeStyle = op.erase ? '#000000' : op.color;
  context.fillStyle = op.erase ? '#000000' : op.color;
  context.lineWidth = op.width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const points = op.points;
  if (points.length === 1) {
    context.beginPath();
    context.arc(points[0].x, points[0].y, op.width / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    // Each point is joined through the middle of the next gap, which rounds off the corners.
    for (let i = 1; i < points.length - 1; i += 1) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      context.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    }
    const last = points[points.length - 1];
    context.lineTo(last.x, last.y);
    context.stroke();
  }
  context.restore();
}

/**
 * Opens the pad.
 * options: {
 *   background   a picture (Blob) to draw on top of, or null for a blank white page
 *   title        the words at the top
 *   onSave(blob) called with the finished JPEG. May return a promise; the pad closes when it settles.
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
  if (under) {
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

  const state = { tool: 'pen', color: under ? COLOURS[1].value : COLOURS[0].value, ops: [], stroke: null, pointerId: null, saving: false, asking: false };

  const button = (label, props, text) => make('button', { type: 'button', 'aria-label': label, ...props, text: text == null ? label : text });
  const cancel = button('Close without saving', { class: 'sk-btn', 'data-sk': 'cancel' }, 'Cancel');
  const title = make('div', { class: 'sk-title', text: o.title || 'Sketch' });
  const saveButton = button('Save the sketch', { class: 'sk-btn primary', 'data-sk': 'save' }, 'Save');
  const top = make('div', { class: 'sk-top' }, [cancel, title, saveButton]);

  const labelInput = make('input', { class: 'sk-input', type: 'text', maxlength: MAX_LABEL, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Type the label', 'aria-label': 'Label text' });
  const labelHint = make('div', { class: 'sk-hint', text: 'Type the words, then tap the drawing where they go.' });
  const labelBar = make('div', { class: 'sk-labelbar', hidden: true }, [labelInput, labelHint]);

  const askText = make('div', { class: 'sk-asktext', text: 'Close without saving this sketch?' });
  const askYes = button('Close without saving', { class: 'sk-btn danger', 'data-sk': 'discard' }, 'Discard');
  const askNo = button('Keep drawing', { class: 'sk-btn', 'data-sk': 'keep' }, 'Keep drawing');
  const askBar = make('div', { class: 'sk-ask', hidden: true, role: 'alertdialog', 'aria-label': 'Close without saving?' }, [askText, askNo, askYes]);

  const stage = make('div', { class: 'sk-stage' }, [base, ink]);
  const area = make('div', { class: 'sk-area' }, [stage]);

  const tools = [
    button('Pen', { class: 'sk-tool', 'data-sk': 'tool', 'data-tool': 'pen' }),
    button('Rubber', { class: 'sk-tool', 'data-sk': 'tool', 'data-tool': 'erase' }),
    button('Label', { class: 'sk-tool', 'data-sk': 'tool', 'data-tool': 'text' }),
    button('Undo', { class: 'sk-tool', 'data-sk': 'undo' }),
  ];
  const swatches = COLOURS.map((c) => {
    const b = button(c.name, { class: 'sk-colour', 'data-sk': 'colour', 'data-colour': c.value }, '');
    b.style.backgroundColor = c.value;
    return b;
  });
  const bottom = make('div', { class: 'sk-bottom' }, [make('div', { class: 'sk-tools', role: 'group', 'aria-label': 'Tools' }, tools), make('div', { class: 'sk-colours', role: 'group', 'aria-label': 'Colours' }, swatches)]);

  const pad = make('div', { class: 'sketch', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Sketch', tabindex: '-1' }, [top, labelBar, askBar, area, bottom]);

  const app = document.getElementById('app');
  const before = document.activeElement;

  const sync = () => {
    for (const t of tools) {
      const on = t.getAttribute('data-tool') === state.tool;
      if (t.hasAttribute('data-tool')) {
        t.classList.toggle('on', on);
        t.setAttribute('aria-pressed', String(on));
      }
    }
    tools[3].disabled = state.ops.length === 0;
    for (const s of swatches) {
      const on = s.getAttribute('data-colour') === state.color;
      s.classList.toggle('on', on);
      s.setAttribute('aria-pressed', String(on));
    }
    labelBar.hidden = state.tool !== 'text' || state.asking;
    askBar.hidden = !state.asking;
    saveButton.disabled = state.saving;
    cancel.disabled = state.saving;
    saveButton.textContent = state.saving ? 'Saving…' : 'Save';
  };

  // The drawing is shown as large as fits, keeping its shape.
  const fit = () => {
    const box = area.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const scale = Math.min(box.width / width, box.height / height);
    stage.style.width = Math.floor(width * scale) + 'px';
    stage.style.height = Math.floor(height * scale) + 'px';
  };

  const at = (event) => {
    const rect = ink.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * width, y: ((event.clientY - rect.top) / rect.height) * height };
  };

  const finishStroke = () => {
    if (!state.stroke) return;
    state.ops.push(state.stroke);
    state.stroke = null;
    state.pointerId = null;
    sync();
  };

  const onDown = (event) => {
    if (state.saving || state.asking || state.pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const p = at(event);
    if (state.tool === 'text') {
      const text = labelInput.value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
      if (!text) {
        labelHint.classList.remove('nudge');
        void labelHint.offsetWidth; // start the nudge again from the beginning
        labelHint.classList.add('nudge');
        labelInput.focus({ preventScroll: true });
        return;
      }
      const size = Math.round(unit * 9);
      // The words are centred on the finger, and kept inside the picture.
      inkContext.save();
      inkContext.font = '600 ' + size + 'px "IBM Plex Sans", system-ui, -apple-system, sans-serif';
      const wide = inkContext.measureText(text).width;
      inkContext.restore();
      const x = Math.max(size * 0.3, Math.min(width - wide - size * 0.3, p.x - wide / 2));
      const y = Math.max(size * 0.7, Math.min(height - size * 0.7, p.y));
      const op = { type: 'text', text, x, y, size, color: state.color };
      state.ops.push(op);
      drawOp(inkContext, op);
      labelInput.value = '';
      labelInput.blur();
      sync();
      return;
    }
    state.pointerId = event.pointerId;
    try {
      ink.setPointerCapture(event.pointerId);
    } catch (e) {
      /* moves still reach the canvas while the finger is on it */
    }
    const erase = state.tool === 'erase';
    state.stroke = { type: 'stroke', erase, color: state.color, width: erase ? unit * 9 : unit * 1.6, points: [p] };
    drawOp(inkContext, state.stroke);
  };

  const onMove = (event) => {
    if (!state.stroke || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    const stroke = state.stroke;
    // A fast finger sends several positions in one event. Using all of them keeps curves smooth.
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const e of events.length ? events : [event]) {
      const p = at(e);
      const last = stroke.points[stroke.points.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < unit * 0.35) continue;
      stroke.points.push(p);
      inkContext.save();
      inkContext.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
      inkContext.strokeStyle = stroke.erase ? '#000000' : stroke.color;
      inkContext.lineWidth = stroke.width;
      inkContext.lineCap = 'round';
      inkContext.beginPath();
      inkContext.moveTo(last.x, last.y);
      inkContext.lineTo(p.x, p.y);
      inkContext.stroke();
      inkContext.restore();
    }
  };

  const onUp = (event) => {
    if (!state.stroke || event.pointerId !== state.pointerId) return;
    const stroke = state.stroke;
    finishStroke();
    // Drawn again in one piece, so the joins between the short pieces disappear.
    if (stroke.points.length > 2 && !stroke.erase) replay(inkContext, width, height, state.ops);
  };

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
    finishStroke();
    state.saving = true;
    sync();
    const out = document.createElement('canvas');
    try {
      out.width = width;
      out.height = height;
      const context = out.getContext('2d');
      if (!context) throw new Error('The phone is too low on memory to save this sketch.');
      context.drawImage(base, 0, 0);
      context.drawImage(ink, 0, 0);
      const blob = await new Promise((resolve, reject) => {
        out.toBlob((b) => (b && b.size ? resolve(b) : reject(new Error('The phone could not save this sketch.'))), 'image/jpeg', 0.92);
      });
      if (o.onSave) await o.onSave(blob);
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

  const onClick = (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-sk]') : null;
    // Taps on the pad are dealt with here and go no further.
    event.stopPropagation();
    if (!target || target.disabled) return;
    const what = target.getAttribute('data-sk');
    if (what === 'tool') {
      state.tool = target.getAttribute('data-tool');
      sync();
      if (state.tool === 'text') labelInput.focus({ preventScroll: true });
    } else if (what === 'colour') {
      state.color = target.getAttribute('data-colour');
      if (state.tool === 'erase') state.tool = 'pen';
      sync();
    } else if (what === 'undo') {
      state.ops.pop();
      replay(inkContext, width, height, state.ops);
      sync();
    } else if (what === 'save') {
      save();
    } else if (what === 'cancel') {
      if (!state.ops.length) {
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

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (state.asking) {
        state.asking = false;
        sync();
      } else cancel.click();
    } else if (event.key === 'Enter' && event.target === labelInput) {
      event.preventDefault();
      labelInput.blur();
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
  pad.focus({ preventScroll: true });
  return result;
}
