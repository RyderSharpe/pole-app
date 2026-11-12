// The span diagram on a pole: a view from above, with this pole in the middle and a line to each
// pole it connects to. A line is turned by dragging its end, by typing an angle, or from the GPS
// positions of the two poles. The angles between the lines are worked out as it changes.

import { html, raw, esc, attrs, openSheet, closeSheet, toast } from '../ui.js';
import * as store from '../store.js';
import { TEMPLATE } from '../template.js';
import { poleTag } from '../template-engine.js';
import { parseNumber } from '../compute.js';
import { uid } from '../records.js';
import { MAX_SPANS, norm, degreesText, deflection, nextBearing, fromGps, spanName, layout, arcPoints, spanColour, between } from '../spans.js';

const SIZE = 340;
const HEIGHT = 268;
const BOX = { width: SIZE, height: HEIGHT, r: 80 };
const n1 = (value) => (Math.round(value * 10) / 10).toFixed(1);

/** Text cut to about the width given (in drawing units), for a label on the diagram. */
function clip(text, room, perChar) {
  const max = Math.max(3, Math.floor(room / perChar));
  const value = String(text);
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + '…';
}

/** The drawing itself, as SVG. */
export function diagramSvg(spans) {
  const g = layout(spans, BOX);
  const out = [];
  // The angles between neighbouring spans: an arc and a number.
  for (const a of g.angles) {
    const points = arcPoints(g.cx, g.cy, 26, a.a0, a.a1).map((p) => n1(p.x) + ',' + n1(p.y)).join(' ');
    out.push('<polyline class="arc" points="' + points + '"></polyline>');
  }
  if (g.through) out.push('<line class="through" x1="' + n1(g.cx) + '" y1="' + n1(g.cy) + '" x2="' + n1(g.through.x) + '" y2="' + n1(g.through.y) + '"></line>');
  for (const end of g.ends) {
    const colour = spanColour(end.index);
    out.push('<line class="span" stroke="' + colour + '" x1="' + n1(g.cx) + '" y1="' + n1(g.cy) + '" x2="' + n1(end.x) + '" y2="' + n1(end.y) + '"></line>');
  }
  for (const a of g.angles) {
    out.push('<text class="ang" text-anchor="middle" x="' + n1(a.x) + '" y="' + n1(a.y + 4) + '">' + esc(a.text) + '</text>');
  }
  out.push('<circle class="pole" cx="' + n1(g.cx) + '" cy="' + n1(g.cy) + '" r="7"></circle>');
  for (const end of g.ends) {
    const colour = spanColour(end.index);
    const name = clip(spanName(end.span, end.index), end.room, 6.6);
    const length = String(end.span.len || '').trim();
    // Two lines of label. Above the end they stack upward, below it downward.
    const first = end.anchor === 'middle' ? (end.up ? end.ly - (length ? 16 : 2) : end.ly + 12) : end.ly - (length ? 3 : -4);
    out.push('<text class="name" text-anchor="' + end.anchor + '" x="' + n1(end.lx) + '" y="' + n1(first) + '">' + esc(name) + '</text>');
    if (length) out.push('<text class="len" fill="' + colour + '" text-anchor="' + end.anchor + '" x="' + n1(end.lx) + '" y="' + n1(first + 14) + '">' + esc(clip(length + ' m', end.room, 6.8)) + '</text>');
  }
  // The round ends go on top of every label, so a finger always finds them.
  for (const end of g.ends) {
    const colour = spanColour(end.index);
    out.push(
      '<g class="handle">' +
        '<circle class="dot" stroke="' + colour + '" cx="' + n1(end.x) + '" cy="' + n1(end.y) + '" r="8"></circle>' +
        '<circle class="hit" data-span-handle="' + esc(end.span.id) + '" cx="' + n1(end.x) + '" cy="' + n1(end.y) + '" r="24"></circle>' +
        '</g>',
    );
  }
  out.push('<text class="north" text-anchor="middle" x="' + (SIZE - 18) + '" y="22">N</text><path class="north-arrow" d="M' + (SIZE - 18) + ' 46V28M' + (SIZE - 23) + ' 34l5-6 5 6"></path>');
  return out.join('');
}

function describe(spans) {
  if (!spans.length) return 'No spans yet';
  return 'Span diagram, seen from above. ' + spans.map((s, i) => spanName(s, i) + ' at ' + degreesText(s.brg)).join(', ') + '.';
}

function swatch(index) {
  return raw('<svg class="swatch" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="6" fill="' + spanColour(index) + '"></circle></svg>');
}

/** The inside of the span diagram part of the pole screen. */
export function spansInner(pole) {
  const spans = pole.spans || [];
  const d = deflection(spans);
  const typed = parseNumber(pole.f.angle, 'deg');
  const differs = d && !(Number.isFinite(typed) && Math.abs(typed - d.angle) < 0.005);
  return html`<div class="label" id="l-spanMap">Span diagram</div>
    <p class="fine">A view from above, with this pole in the middle. Up is north. Add a span for each pole this one connects to.</p>
    ${spans.length
      ? html`<div class="spanmap"><svg viewBox="0 0 ${SIZE} ${HEIGHT}" role="img" aria-label="${describe(spans)}" data-span-svg>${raw(diagramSvg(spans))}</svg></div>
          <p class="fine">Drag the round end of a line to turn it. Tap a span below to type its details. Lines are all drawn the same length; the real lengths are in the labels.</p>`
      : ''}
    <div class="span-list">
      ${spans.map((span, i) => {
        const bits = [String(span.len || '').trim() ? String(span.len).trim() + ' m' : 'no length', String(span.cond || '').trim(), degreesText(span.brg), span.main ? 'main line' : ''].filter(Boolean);
        return html`<button type="button" class="span-row" data-act="span-edit" data-id="${span.id}">
          ${swatch(i)}<span class="grow"><strong>${spanName(span, i)}</strong><br><span class="sub">${bits.join(' · ')}</span></span><span class="where-step">Edit</span>
        </button>`;
      })}
    </div>
    ${d
      ? html`<div class="seps defl" role="group" aria-label="Worked out from the diagram">
          <div class="eyebrow">Worked out from the diagram</div>
          <div class="row"><div class="k">Angle of deflection<br><span class="sub">between ${spanName(d.a, spans.indexOf(d.a))} and ${spanName(d.b, spans.indexOf(d.b))}</span></div><div class="v" data-deflection>${degreesText(d.angle)}</div></div>
          ${differs ? html`<button type="button" class="chip" data-act="span-use-angle">Use ${degreesText(d.angle)} as this pole's angle of deflection</button>` : html`<p class="fine">Same as the angle of deflection entered for this pole.</p>`}
        </div>`
      : ''}
    <button type="button" class="dashed" data-act="span-add"${attrs({ disabled: spans.length >= MAX_SPANS })}>${spans.length >= MAX_SPANS ? 'The diagram is full (' + MAX_SPANS + ' spans)' : spans.length ? 'Add another span' : 'Add a span'}</button>`;
}

// ---------------------------------------------------------------------------------------------
// Editing one span in a sheet

let editing = null; // { poleId, spanId, refresh }

const spansOf = (poleId) => {
  const pole = store.getPole(poleId);
  return pole ? (pole.spans || []).map((s) => ({ ...s })) : null;
};

function save(poleId, spans, refresh) {
  store.setPoleSpans(poleId, spans, true);
  if (refresh) refresh();
}

function otherPoles(poleId) {
  const pole = store.getPole(poleId);
  if (!pole) return [];
  return store.listPoles(pole.jobId).filter((other) => other.id !== poleId);
}

const poleLabel = (pole) => 'Pole ' + store.poleNumber(pole) + (poleTag(TEMPLATE, pole) ? ' · ' + poleTag(TEMPLATE, pole) : '');

function gpsNote(poleId, span) {
  const here = store.getPole(poleId);
  const there = span.toPole ? store.getPole(span.toPole) : null;
  if (!there) return { ok: false, text: 'To use GPS, pick the other pole above. Both poles need a GPS position.' };
  if (!here.gps || !there.gps) return { ok: false, text: (!here.gps ? 'This pole' : poleLabel(there)) + ' has no GPS position yet. Record it on the Pole step first.' };
  const found = fromGps(here.gps, there.gps);
  return { ok: true, found, text: 'GPS says ' + found.dist + ' m at ' + degreesText(found.brg) + '.' + (found.acc != null ? ' The two positions together may be off by about ' + found.acc + ' m, so treat this as rough.' : ' Phone GPS is often off by 3 to 10 m, so treat this as rough.') };
}

function sheetBody(poleId, span, spans) {
  const index = spans.findIndex((s) => s.id === span.id);
  const others = spans.filter((s) => s.id !== span.id && Number.isFinite(s.brg));
  const poles = otherPoles(poleId);
  const gps = gpsNote(poleId, span);
  return html`<h2>Span ${index + 1}</h2>
    <div class="field">
      <label class="label" for="sp-to">Goes to</label>
      <input${attrs({ class: 'input', id: 'sp-to', type: 'text', maxlength: 60, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Pole number, or what it is', value: span.to })}>
      ${poles.length
        ? html`<div class="chips wrap" role="group" aria-label="Poles in this job" data-span-poles>${poles.map((p) => html`<button type="button"${attrs({ class: 'chip' + (span.toPole === p.id ? ' on' : ''), 'data-act': 'span-link', 'data-id': p.id, 'aria-pressed': String(span.toPole === p.id) })}>${poleLabel(p)}</button>`)}</div>`
        : ''}
    </div>
    <div class="numrow">
      <label for="sp-len">Length</label>
      <div class="right"><input${attrs({ class: 'num', id: 'sp-len', type: 'text', inputmode: 'decimal', maxlength: 20, autocomplete: 'off', value: span.len })}><div class="unit" aria-hidden="true">m</div></div>
    </div>
    <div class="field">
      <label class="label" for="sp-cond">Wire</label>
      <input${attrs({ class: 'input', id: 'sp-cond', type: 'text', maxlength: 80, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'For example 2/0 ACSR', value: span.cond })}>
    </div>
    <h3 class="subhead eyebrow">Direction</h3>
    <div class="numrow">
      <label for="sp-brg">From north, clockwise</label>
      <div class="right"><input${attrs({ class: 'num', id: 'sp-brg', type: 'text', inputmode: 'decimal', maxlength: 8, autocomplete: 'off', value: Number.isFinite(span.brg) ? String(span.brg) : '' })}><div class="unit" aria-hidden="true">deg</div></div>
    </div>
    <p class="fine">0 is up (north), 90 is right (east), 180 is down, 270 is left. You can also close this and drag the line.</p>
    ${others.length
      ? html`<div class="field">
          <label class="label" for="sp-ref">Or type the angle from another span</label>
          <select class="input" id="sp-ref">${others.map((o) => html`<option value="${o.id}">Clockwise from ${spanName(o, spans.indexOf(o))}</option>`)}</select>
          <div class="numrow">
            <label for="sp-ang">Angle</label>
            <div class="right"><input${attrs({ class: 'num', id: 'sp-ang', type: 'text', inputmode: 'decimal', maxlength: 8, autocomplete: 'off', value: '' })}><div class="unit" aria-hidden="true">deg</div></div>
          </div>
        </div>`
      : ''}
    <div class="field" data-span-gps>
      <button type="button" class="btn ghost small" data-act="span-gps"${attrs({ disabled: !gps.ok })}>Use GPS for the direction</button>
      <p class="fine">${gps.text}</p>
    </div>
    ${spans.length > 2
      ? html`<button type="button"${attrs({ class: 'dashed' + (span.main ? ' on' : ''), 'data-act': 'span-main', 'aria-pressed': String(span.main === true) })}>Part of the main line</button>
          <p class="fine">The angle of deflection is worked out between the two spans marked as the main line. With none marked, the app uses the two closest to a straight line.</p>`
      : ''}
    <button type="button" class="btn" data-sheet="done" data-autofocus>Done</button>
    <button type="button" class="btn danger" data-act="span-delete">Remove this span</button>`;
}

function openEditor(poleId, spanId, refresh) {
  const spans = spansOf(poleId);
  const span = spans && spans.find((s) => s.id === spanId);
  if (!span) return;
  const state = { poleId, spanId, refresh };
  editing = state;
  openSheet(sheetBody(poleId, span, spans), {
    label: 'Span details',
    onClose: () => {
      if (editing === state) editing = null;
      refresh();
    },
  });
}

function redrawEditor(keepScroll) {
  if (!editing) return;
  const { poleId, spanId, refresh } = editing;
  const sheet = document.querySelector('#modal .sheet');
  const top = sheet && keepScroll ? sheet.scrollTop : 0;
  const state = editing;
  const spans = spansOf(poleId);
  const span = spans && spans.find((s) => s.id === spanId);
  if (!span) return;
  openSheet(sheetBody(poleId, span, spans), {
    label: 'Span details',
    onClose: () => {
      if (editing === state) editing = null;
      refresh();
    },
  });
  editing = state;
  const now = document.querySelector('#modal .sheet');
  if (now) now.scrollTop = top;
}

function change(mutate) {
  if (!editing) return null;
  const { poleId, spanId, refresh } = editing;
  const spans = spansOf(poleId);
  const span = spans && spans.find((s) => s.id === spanId);
  if (!span) return null;
  mutate(span, spans);
  save(poleId, spans, refresh);
  return span;
}

/** Typing in the span sheet. Returns true when the element belonged to it. */
export function spanSheetInput(element) {
  if (!editing || !element.id || !element.id.startsWith('sp-')) return false;
  const value = element.value;
  if (element.id === 'sp-to') {
    change((span) => {
      span.to = value;
      // A name typed by hand no longer points at the pole picked before.
      if (span.toPole) {
        const linked = store.getPole(span.toPole);
        if (!linked || poleLinkName(linked) !== value.trim()) span.toPole = '';
      }
    });
    syncLinkChips();
  } else if (element.id === 'sp-len') {
    change((span) => {
      span.len = value;
    });
  } else if (element.id === 'sp-cond') {
    change((span) => {
      span.cond = value;
    });
  } else if (element.id === 'sp-brg') {
    const number = parseNumber(value, 'deg');
    if (Number.isFinite(number)) {
      change((span) => {
        span.brg = norm(number);
        span.how = 'typed';
      });
    }
    const angle = document.querySelector('#modal #sp-ang');
    if (angle) angle.value = '';
  } else if (element.id === 'sp-ang' || element.id === 'sp-ref') {
    const angleBox = document.querySelector('#modal #sp-ang');
    const refBox = document.querySelector('#modal #sp-ref');
    const number = angleBox ? parseNumber(angleBox.value, 'deg') : NaN;
    if (Number.isFinite(number) && refBox) {
      const changed = change((span, spans) => {
        const ref = spans.find((s) => s.id === refBox.value);
        if (!ref || !Number.isFinite(ref.brg)) return;
        span.brg = norm(ref.brg + number);
        span.how = 'typed';
      });
      const box = document.querySelector('#modal #sp-brg');
      if (box && changed && Number.isFinite(changed.brg)) box.value = String(Math.round(changed.brg * 100) / 100);
    }
  }
  return true;
}

const poleLinkName = (pole) => poleTag(TEMPLATE, pole) || 'Pole ' + store.poleNumber(pole);

function syncLinkChips() {
  if (!editing) return;
  const spans = spansOf(editing.poleId);
  const span = spans && spans.find((s) => s.id === editing.spanId);
  if (!span) return;
  for (const chip of document.querySelectorAll('#modal [data-span-poles] [data-act="span-link"]')) {
    const on = chip.getAttribute('data-id') === span.toPole;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', String(on));
  }
  const gpsBox = document.querySelector('#modal [data-span-gps]');
  if (gpsBox) {
    const note = gpsNote(editing.poleId, span);
    const button = gpsBox.querySelector('button');
    const text = gpsBox.querySelector('p');
    if (button) button.disabled = !note.ok;
    if (text) text.textContent = note.text;
  }
}

/** The actions the pole screen adds for the span diagram. refresh() redraws the diagram part. */
export function spanActions(poleId, refresh) {
  return {
    'span-add': () => {
      const spans = spansOf(poleId);
      if (!spans || spans.length >= MAX_SPANS) return;
      const span = { id: uid(), to: '', toPole: '', cond: '', len: '', brg: nextBearing(spans), main: false, how: '' };
      spans.push(span);
      save(poleId, spans, refresh);
      openEditor(poleId, span.id, refresh);
    },
    'span-edit': (element) => {
      if (performance.now() < ignoreTapsUntil) return;
      openEditor(poleId, element.getAttribute('data-id'), refresh);
    },
    'span-link': (element) => {
      const id = element.getAttribute('data-id');
      const other = store.getPole(id);
      if (!other) return;
      change((span) => {
        if (span.toPole === id) {
          span.toPole = '';
          return;
        }
        span.toPole = id;
        span.to = poleLinkName(other);
      });
      const spans = spansOf(poleId);
      const span = spans && editing && spans.find((s) => s.id === editing.spanId);
      const box = document.querySelector('#modal #sp-to');
      if (box && span) box.value = span.to;
      syncLinkChips();
    },
    'span-gps': () => {
      if (!editing) return;
      const spans = spansOf(poleId);
      const span = spans && spans.find((s) => s.id === editing.spanId);
      if (!span) return;
      const note = gpsNote(poleId, span);
      if (!note.ok) return;
      const hadLength = String(span.len || '').trim() !== '';
      change((s) => {
        s.brg = note.found.brg;
        s.how = 'gps';
        if (!hadLength) s.len = String(note.found.dist);
      });
      redrawEditor(true);
      toast(hadLength ? 'Direction set from GPS. The length you typed was kept.' : 'Direction and length set from GPS. Check the length against your own measurement.');
    },
    'span-main': () => {
      change((span, spans) => {
        span.main = !span.main;
        // Only two spans can be the main line: marking a third lets go of the oldest mark.
        const marked = spans.filter((s) => s.main && s.id !== span.id);
        if (span.main && marked.length >= 2) marked[0].main = false;
      });
      redrawEditor(true);
    },
    'span-delete': () => {
      if (!editing) return;
      const spanId = editing.spanId;
      const before = spansOf(poleId);
      if (!before) return;
      const after = before.filter((s) => s.id !== spanId);
      closeSheet(undefined);
      store.setPoleSpans(poleId, after);
      toast('Span removed', { action: 'Undo', onAction: () => store.setPoleSpans(poleId, before) });
    },
    'span-use-angle': () => {
      const pole = store.getPole(poleId);
      const d = pole ? deflection(pole.spans || []) : null;
      if (!d) return;
      const before = pole.f.angle == null ? '' : pole.f.angle;
      store.setPoleField(poleId, 'angle', String(d.angle));
      refresh();
      toast('Angle of deflection set to ' + degreesText(d.angle), { action: 'Undo', onAction: () => { store.setPoleField(poleId, 'angle', before); refresh(); } });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Turning a line by dragging its end

let drag = null; // { poleId, spanId, pointerId, svg, spans, startX, startY, moved }
let ignoreTapsUntil = -Infinity;

/** True while a line is being dragged, so nothing else redraws the diagram under the finger. */
export const isDragging = () => drag !== null;

const SNAP_DEGREES = 3;

function bearingAt(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  if (Math.hypot(dx, dy) < 6) return null;
  return norm((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/** A dragged direction, to the whole degree, pulled onto "dead straight" with another span when close. */
function settle(brg, span, spans) {
  for (const other of spans) {
    if (other.id === span.id || !Number.isFinite(other.brg)) continue;
    if (between(brg, other.brg + 180) <= SNAP_DEGREES) return norm(other.brg + 180);
  }
  const whole = Math.round(brg);
  return whole >= 360 ? 0 : whole;
}

/**
 * Starts listening for drags on the diagram inside root. poleId is the pole on screen.
 * refresh() redraws the diagram part once a drag ends. Returns a function that stops listening.
 */
export function installDrag(root, poleId, refresh) {
  const onDown = (event) => {
    const touched = event.target instanceof Element ? event.target.closest('[data-span-handle]') : null;
    if (!touched || drag) return;
    const svg = touched.closest('svg');
    const spans = spansOf(poleId);
    if (!svg || !spans) return;
    // Two ends that sit close together overlap. The finger takes the one it is nearest to.
    let handle = touched;
    let nearest = Infinity;
    for (const candidate of svg.querySelectorAll('[data-span-handle]')) {
      const box = candidate.getBoundingClientRect();
      const away = Math.hypot(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2));
      if (away < nearest) {
        nearest = away;
        handle = candidate;
      }
    }
    drag = { poleId, spanId: handle.getAttribute('data-span-handle'), pointerId: event.pointerId, svg, spans, startX: event.clientX, startY: event.clientY, moved: false };
    try {
      svg.setPointerCapture(event.pointerId);
    } catch (e) {
      /* the browser will still send the moves to the page */
    }
  };
  const onMove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.moved = true;
    event.preventDefault();
    const span = drag.spans.find((s) => s.id === drag.spanId);
    const brg = bearingAt(drag.svg, event.clientX, event.clientY);
    if (!span || brg === null) return;
    const next = settle(brg, span, drag.spans);
    if (next === span.brg) return;
    span.brg = next;
    span.how = 'drag';
    drag.svg.innerHTML = String(html`${raw(diagramSvg(drag.spans))}`);
    const d = deflection(drag.spans);
    const live = root.querySelector('[data-deflection]');
    if (live && d) live.textContent = degreesText(d.angle);
  };
  const onUp = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const done = drag;
    drag = null;
    try {
      done.svg.releasePointerCapture(event.pointerId);
    } catch (e) {
      /* already released */
    }
    // Whatever the browser makes of the finger lifting, it must not count as a second tap.
    ignoreTapsUntil = performance.now() + 450;
    if (event.type === 'pointercancel') {
      if (done.moved) refresh();
      return;
    }
    if (!done.moved) {
      // A tap on the end of a line, with no drag: open that span's details.
      openEditor(done.poleId, done.spanId, refresh);
      return;
    }
    save(done.poleId, done.spans, refresh);
  };
  // A finger on the end of a line turns the line. It must not scroll the page as well.
  const onTouch = (event) => {
    if (event.target instanceof Element && event.target.closest('[data-span-handle]')) event.preventDefault();
  };
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);
  root.addEventListener('touchstart', onTouch, { passive: false });
  return () => {
    drag = null;
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', onUp);
    root.removeEventListener('touchstart', onTouch);
  };
}

/** Called when the pole screen goes away. */
export function closeSpanEditor() {
  editing = null;
}
