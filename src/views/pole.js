// One pole, filled in over a few short steps.
//
// Slow work (finding a GPS position, shrinking a photo) is always tied to the pole it was started
// on. If the user has moved on by the time it finishes, the result is either stored on the right
// pole (photos) or thrown away (a position, because the phone may have moved). It is never drawn
// on whatever pole happens to be showing.

import { html, attrs, icon, plural, formatTime, openSheet, closeSheet, sheetIsOpen, confirmSheet, messageSheet, toast } from '../ui.js';
import * as store from '../store.js';
import { TEMPLATE } from '../template.js';
import { poleTag, poleProgress, poleWarnings, gpsText } from '../template-engine.js';
import { renderItems, refreshLive, handleInput, handleTap, focusItem } from '../form.js';
import { paths, go, backTo, redraw, takeIntent } from '../nav.js';
import { makeRenditions } from '../photos.js';
import { gpsAvailable, getPosition } from '../geo.js';
import { jobName, saveProblem } from './shared.js';
import { GPS_POOR_ACCURACY_M } from '../config.js';
import { spansInner, spanActions, spanSheetInput, installDrag, isDragging, closeSpanEditor } from './spanmap.js';
import { openSketch } from '../sketch.js';

const steps = TEMPLATE.pole.steps;

// What is on screen right now, so late results know whether they may touch the page.
let showing = null; // { poleId, stepKey, root }

// Poles added during this visit. One that is left without a single entry is removed again.
const fresh = new Set();
export const markFresh = (poleId) => fresh.add(poleId);

// Set when an item in the "Before you save" list is tapped: { poleId, from, to } (step keys).
// On the step it leads to, the back arrow returns to the list, as the phone's Back button does.
let jumped = null;

// ---------------------------------------------------------------------------------------------
// GPS

const gps = { poleId: null, controller: null, best: null, errorPoleId: null, error: '' };

function stopGps() {
  const controller = gps.controller;
  gps.controller = null;
  gps.poleId = null;
  gps.best = null;
  if (controller) controller.abort();
}

function gpsProgress() {
  if (!gps.best) return 'Looking for the position. This can take a minute with no signal.';
  if (gps.best.acc == null) return 'Position found. Checking it.';
  return 'Within about ' + Math.round(gps.best.acc) + ' m so far. Getting closer.';
}

function gpsInner(pole) {
  const busy = gps.controller !== null && gps.poleId === pole.id;
  const g = pole.gps;
  const poor = g && g.acc != null && g.acc > GPS_POOR_ACCURACY_M;
  const error = gps.errorPoleId === pole.id ? gps.error : '';
  let controls;
  if (busy) {
    controls = html`<div class="gps-busy" role="status">
      <div class="spinner small" aria-hidden="true"></div>
      <div class="sub grow" data-gps-progress>${gpsProgress()}</div>
      <button type="button" class="chip plain" data-act="gps-cancel">Cancel</button>
    </div>`;
  } else if (g) {
    controls = html`<div class="pair">
      <button type="button" class="btn ghost small white" data-act="gps-get">${icon.pin}Update position</button>
      <button type="button" class="btn danger small narrow" data-act="gps-clear">Clear</button>
    </div>`;
  } else {
    controls = html`<button type="button" class="dashed" data-act="gps-get"${attrs({ disabled: !gpsAvailable() })}>${icon.pin}Record this pole's position</button>`;
  }
  return html`<div class="label" id="l-gps">GPS position</div>
    ${g
      ? html`<div class="gps">
          <div class="coords">${gpsText(g)}</div>
          <div class="sub">${g.acc != null ? 'Accurate to about ' + Math.round(g.acc) + ' m' : 'Accuracy not reported'}${g.at ? ' · ' + formatTime(g.at) : ''}</div>
        </div>`
      : ''}
    ${poor && !busy ? html`<div class="hint">Low accuracy. Stand in the open at the pole and tap Update position.</div>` : ''}
    ${error ? html`<div class="hint" role="alert">${error}</div>` : ''}
    ${controls}
    <p class="fine">${gpsAvailable() ? 'Works with no signal. Stand at the pole, under open sky.' : 'This phone does not share its position with the browser.'}</p>`;
}

// ---------------------------------------------------------------------------------------------
// Photos

const thumbs = new Map(); // photo id -> address of the small picture, for the pole on screen
let thumbsFor = null;
const pending = new Map(); // pole id -> photos still being shrunk and stored
let viewer = null; // { photoId, url }

function dropThumbs() {
  for (const url of thumbs.values()) URL.revokeObjectURL(url);
  thumbs.clear();
  thumbsFor = null;
}

function photosInner(pole) {
  const list = store.listPhotos(pole.id);
  const waiting = pending.get(pole.id) || 0;
  return html`<div class="label" id="l-photos">Photos for this pole</div>
    <div class="photos">
      ${list.map((photo, i) => {
        const url = thumbsFor === pole.id ? thumbs.get(photo.id) : null;
        return html`<button type="button" class="photo" data-act="photo-open" data-id="${photo.id}" aria-label="Photo ${i + 1}${photo.label ? ': ' + photo.label : ''}. Tap to label or delete.">
          <img alt="" data-thumb="${photo.id}"${url ? attrs({ src: url }) : ''}>
          ${photo.label ? html`<span class="tag">${photo.label}</span>` : ''}
        </button>`;
      })}
      ${Array.from({ length: waiting }, () => html`<div class="photo busy" role="img" aria-label="Saving a photo"><div class="spinner small"></div></div>`)}
    </div>
    ${!list.length && !waiting ? html`<div class="nophotos">No photos yet</div>` : ''}`;
}

async function loadThumbs(poleId) {
  if (thumbsFor !== poleId) {
    dropThumbs();
    thumbsFor = poleId;
  }
  for (const photo of store.listPhotos(poleId)) {
    if (!thumbs.has(photo.id)) {
      const blob = await store.getPhotoBlob(photo.id, 'thumb');
      // While the picture was being read, the user may have left this pole.
      if (thumbsFor !== poleId) return;
      if (blob && !thumbs.has(photo.id)) thumbs.set(photo.id, URL.createObjectURL(blob));
    }
    if (!showing || showing.poleId !== poleId) continue;
    const image = showing.root.querySelector('img[data-thumb="' + photo.id + '"]');
    if (!image) continue;
    const url = thumbs.get(photo.id);
    if (url) {
      if (image.getAttribute('src') !== url) image.src = url;
    } else if (!image.dataset.broken) {
      image.dataset.broken = '1';
      image.replaceWith(Object.assign(document.createElement('span'), { className: 'broken', textContent: 'Cannot read photo' }));
    }
  }
}

function bump(poleId, by) {
  const next = (pending.get(poleId) || 0) + by;
  if (next > 0) pending.set(poleId, next);
  else pending.delete(poleId);
}

function askLabel(photoId) {
  openSheet(
    html`<h2>What is this photo?</h2>
      <div class="chips wrap">${TEMPLATE.photoLabels.map((label) => html`<button type="button" class="chip" data-sheet="label:${label}">${label}</button>`)}</div>
      <button type="button" class="btn ghost" data-sheet="skip" data-autofocus>No label</button>`,
    {
      label: 'Photo label',
      onClose: (value) => {
        if (typeof value === 'string' && value.startsWith('label:')) store.setPhotoLabel(photoId, value.slice(6));
      },
    },
  );
}

function photoProblem(error) {
  const text = error && error.message ? String(error.message) : '';
  if (error && (error.name === 'QuotaExceededError' || /quota/i.test(text))) return 'The phone is out of space. Export your jobs, delete what you no longer need, then try again.';
  return text || 'The phone could not store this photo.';
}

// Shrinks and stores the chosen pictures on the pole they were taken for, one at a time.
async function addFiles(poleId, files, fromCamera) {
  const list = files.filter(Boolean);
  if (!list.length) return;
  bump(poleId, list.length);
  refreshPart(poleId, 'photos');
  const added = [];
  let failure = null;
  for (const file of list) {
    try {
      const renditions = await makeRenditions(file);
      added.push(await store.addPhoto(poleId, renditions));
    } catch (error) {
      console.error(error);
      failure = failure || error;
    }
    bump(poleId, -1);
    refreshPart(poleId, 'photos');
  }
  if (failure) {
    const failed = list.length - added.length;
    await messageSheet(failed === 1 ? 'A photo was not saved' : failed + ' photos were not saved', [photoProblem(failure), added.length ? 'The other ' + plural(added.length, 'photo') + ' saved normally.' : '']);
    return;
  }
  // Offer a label straight after a single camera shot, unless the user has already moved on to
  // typing or to another screen. A sheet popping up would take the keyboard away.
  const onPhotoStep = showing && showing.poleId === poleId && showing.stepKey === 'photos';
  const active = document.activeElement;
  const typing = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;
  if (fromCamera && added.length === 1 && onPhotoStep && !sheetIsOpen() && !typing) askLabel(added[0].id);
}

// Stores a finished sketch with the pole's photos, under the label given.
async function saveSketch(poleId, blob, label) {
  bump(poleId, 1);
  refreshPart(poleId, 'photos');
  try {
    const photo = await store.addPhoto(poleId, await makeRenditions(blob));
    store.setPhotoLabel(photo.id, label);
  } finally {
    bump(poleId, -1);
    refreshPart(poleId, 'photos');
  }
}

function closeViewer() {
  if (viewer && viewer.url) URL.revokeObjectURL(viewer.url);
  viewer = null;
}

function viewerChips(photo) {
  return TEMPLATE.photoLabels.map((label) => html`<button type="button"${attrs({ class: 'chip' + (photo.label === label ? ' on' : ''), 'data-act': 'photo-label', 'data-label': label, 'aria-pressed': String(photo.label === label) })}>${label}</button>`);
}

async function openViewer(photoId) {
  const photo = store.getPhoto(photoId);
  if (!photo) return;
  closeViewer();
  const state = { photoId, url: '' };
  viewer = state;
  const custom = photo.label && !TEMPLATE.photoLabels.includes(photo.label) ? photo.label : '';
  openSheet(
    html`<h2>Photo</h2>
      <div class="viewer" data-viewer><div class="spinner" role="img" aria-label="Loading"></div></div>
      <div class="label" id="l-photo-label">Label</div>
      <div class="chips wrap" role="group" aria-labelledby="l-photo-label" data-label-chips>${viewerChips(photo)}</div>
      <input${attrs({ class: 'input', id: 'photo-label', type: 'text', maxlength: 60, autocomplete: 'off', placeholder: 'Or type your own label', 'aria-label': 'Your own label', value: custom })}>
      <button type="button" class="btn" data-sheet="done" data-autofocus>Done</button>
      <button type="button" class="btn ghost" data-act="sketch-photo">${icon.pencil}Draw on this photo</button>
      <button type="button" class="btn danger" data-act="photo-delete">Delete this photo</button>`,
    {
      label: 'Photo',
      wide: true,
      onClose: () => {
        if (viewer === state) closeViewer();
      },
    },
  );
  const blob = await store.getPhotoBlob(photoId, 'mid');
  if (viewer !== state) return; // the sheet was closed, or shows another photo by now
  const box = document.querySelector('#modal [data-viewer]');
  if (!box) return;
  if (!blob) {
    box.innerHTML = String(html`<p>This photo could not be read from the phone.</p>`);
    return;
  }
  state.url = URL.createObjectURL(blob);
  const image = document.createElement('img');
  image.alt = photo.label ? 'Photo: ' + photo.label : 'Photo';
  image.src = state.url;
  box.replaceChildren(image);
}

// ---------------------------------------------------------------------------------------------
// The "before you save" list

function reviewInner(pole) {
  const tokens = store.tokens();
  const blank = poleProgress(TEMPLATE, pole, tokens).blank;
  const warnings = poleWarnings(TEMPLATE, pole, tokens, {
    usedElsewhere: (key, value) => store.valueUsedElsewhere(pole, key, value),
    poorGpsMetres: GPS_POOR_ACCURACY_M,
  });
  const saveNote = 'Saves to this phone as you type. Use Export to get the file off the phone.';
  if (!blank.length && !warnings.length) {
    return html`<div class="saved">${icon.check}<div><strong>Nothing left blank.</strong> ${saveNote}</div></div>`;
  }
  return html`
    ${warnings.length
      ? html`<div class="review">
          <h2 class="eyebrow">Check these (${warnings.length})</h2>
          <div class="blanks">${warnings.map((w) => html`<button type="button" class="blank" data-act="review-goto" data-step="${w.stepKey}" data-key="${w.key}">
            <span><strong>${w.label}</strong><br>${w.text}</span><span class="where-step">${w.stepTitle}</span>
          </button>`)}</div>
        </div>`
      : ''}
    ${blank.length
      ? html`<div class="review">
          <h2 class="eyebrow">Left blank (${blank.length})</h2>
          <p class="fine">Tap one to fill it in, or save the pole as it is.</p>
          <div class="blanks">${blank.map((b) => html`<button type="button" class="blank" data-act="review-goto" data-step="${b.stepKey}" data-key="${b.key}">
            <span>${b.label}</span><span class="where-step">${b.stepTitle}</span>
          </button>`)}</div>
        </div>`
      : ''}
    <div class="saved">${icon.check}<div>${saveNote}</div></div>`;
}

// ---------------------------------------------------------------------------------------------
// Redrawing one part of the screen

const parts = { gps: gpsInner, photos: photosInner, review: reviewInner, spans: spansInner };

// Redraws one part, but only if that pole is the one on screen.
function refreshPart(poleId, name) {
  if (!showing || showing.poleId !== poleId) return;
  const box = showing.root.querySelector('[data-part="' + name + '"]');
  const pole = store.getPole(poleId);
  if (!box || !pole) return;
  // A line being dragged is drawn by the drag itself. Redrawing under the finger would drop it.
  if (name === 'spans' && isDragging()) return;
  box.innerHTML = String(parts[name](pole));
  if (name === 'photos') loadThumbs(poleId).catch((e) => console.warn(e));
}

function subLine(pole) {
  const tag = poleTag(TEMPLATE, pole);
  return 'Pole ' + store.poleNumber(pole) + ' of ' + store.listPoles(pole.jobId).length + (tag ? ' · ' + tag : '');
}

// ---------------------------------------------------------------------------------------------

export function open(route) {
  const first = store.getPole(route.id);
  if (!first) return null;
  const poleId = first.id;
  const jobId = first.jobId;
  let stepIndex = steps.findIndex((s) => s.key === route.step);
  if (stepIndex < 0) stepIndex = 0;
  const step = steps[stepIndex];
  const last = stepIndex === steps.length - 1;

  const context = () => {
    const pole = store.getPole(poleId);
    return {
      template: TEMPLATE,
      tokens: store.tokens(),
      f: pole ? pole.f : {},
      set: (key, value) => store.setPoleField(poleId, key, value),
      usedElsewhere: (key, value) => (pole ? store.valueUsedElsewhere(pole, key, value) : false),
    };
  };

  // The back arrow goes to the step before, or to the job from the first step. After a jump from
  // the "Before you save" list it goes back to the list instead.
  const backTarget = () => {
    if (jumped && jumped.poleId === poleId && jumped.to === step.key) return { path: paths.pole(poleId, jumped.from), label: 'Back to the list' };
    if (stepIndex > 0) return { path: paths.pole(poleId, steps[stepIndex - 1].key), label: 'Back to ' + steps[stepIndex - 1].title };
    return { path: paths.job(jobId), label: 'Back to the job' };
  };

  const extra = {
    gps: () => {
      const pole = store.getPole(poleId);
      return html`<div class="field" data-item="gps" data-part="gps">${gpsInner(pole)}</div>`;
    },
    photos: () => {
      const pole = store.getPole(poleId);
      // The two file inputs sit outside the part that gets redrawn, so an open camera never loses its way back.
      return html`<div class="field" data-item="photos">
        <div class="field" data-part="photos">${photosInner(pole)}</div>
        <div class="pair">
          <button type="button" class="btn ghost white" data-act="photo-take">${icon.camera}Take photo</button>
          <button type="button" class="btn ghost white" data-act="photo-pick">${icon.image}Choose</button>
        </div>
        <button type="button" class="btn ghost white" data-act="sketch-new">${icon.pencil}Draw a sketch</button>
        <p class="fine">For a pole the questions do not cover: draw it with your finger and label each wire. The sketch is kept with the photos.</p>
        <input id="cam" class="file-input" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true">
        <input id="lib" class="file-input" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true">
      </div>`;
    },
    review: () => html`<div class="stack" data-item="review" data-part="review">${reviewInner(store.getPole(poleId))}</div>`,
    spanmap: () => html`<div class="field" data-item="spanMap" data-part="spans">${spansInner(store.getPole(poleId))}</div>`,
  };
  let stopDrag = null;

  return {
    get title() {
      const pole = store.getPole(poleId);
      return pole ? 'Pole ' + store.poleNumber(pole) + ': ' + step.title : 'Pole';
    },

    render() {
      const pole = store.getPole(poleId);
      const job = store.getJob(jobId);
      if (!pole || !job) return html``;
      const backLabel = backTarget().label;
      // The step title and the save status can take focus (tabindex -1, not in the Tab order). A
      // phone moves a tap that lands on plain text to the nearest button, which here would be a
      // step in the bar just above. Text that can take focus keeps the tap for itself.
      return html`<header class="top">
          <div class="bar">
            <button type="button" class="back" data-act="step-back" aria-label="${backLabel}">${icon.back}</button>
            <div class="where"><div class="t">${jobName(job)}</div><div class="s" data-pole-sub>${subLine(pole)}</div></div>
          </div>
          <div class="progress" role="group" aria-label="Steps">
            ${steps.map((s, i) => html`<button type="button"${attrs({ class: i <= stepIndex ? 'on' : null, 'data-act': 'step-goto', 'data-step': s.key, 'aria-label': 'Step ' + (i + 1) + ': ' + s.title, 'aria-current': i === stepIndex ? 'step' : null })}><span></span></button>`)}
          </div>
          <div class="bar"><h1 class="eyebrow" data-heading tabindex="-1">Step ${stepIndex + 1} of ${steps.length}: ${step.title}</h1><span class="save-status" data-save-status="short" tabindex="-1"></span></div>
        </header>
        <main class="body">
          ${saveProblem()}
          ${renderItems(step.items, context(), extra)}
          ${last ? html`<button type="button" class="btn danger" data-act="pole-delete">Delete this pole</button>` : ''}
        </main>
        <div class="foot"><button type="button" class="btn" data-act="step-next">${last ? 'Save pole' : 'Next: ' + steps[stepIndex + 1].title}</button></div>`;
    },

    mounted(root) {
      showing = { poleId, stepKey: step.key, root };
      if (thumbsFor !== null && thumbsFor !== poleId) dropThumbs();
      if (step.items.some((item) => item.type === 'photos')) loadThumbs(poleId).catch((e) => console.warn(e));
      for (const id of ['cam', 'lib']) {
        const input = root.querySelector('#' + id);
        if (!input) continue;
        input.addEventListener('change', () => {
          const files = [...(input.files || [])];
          input.value = '';
          store.track(addFiles(poleId, files, id === 'cam')).catch((e) => console.error(e));
        });
      }
      if (step.items.some((item) => item.type === 'spanmap')) stopDrag = installDrag(root, poleId, () => refreshPart(poleId, 'spans'));
      const intent = takeIntent();
      if (intent && intent.focus) focusItem(root, intent.focus);
    },

    unmount() {
      showing = null;
      if (stopDrag) stopDrag();
      stopDrag = null;
    },

    // Called when the user moves to another screen. next is where they are going.
    leave(next) {
      if (next && next.name === 'pole' && next.id === poleId) return;
      jumped = null;
      closeSpanEditor();
      stopGps();
      gps.error = '';
      gps.errorPoleId = null;
      dropThumbs();
      const pole = store.getPole(poleId);
      // A new pole left with nothing on it is removed, so it does not clutter the job. One that ever
      // had a photo is kept, even if the photo was deleted, so the photo can still be brought back.
      const untouched = pole && fresh.has(poleId) && store.poleNeverUsed(pole) && !pending.has(poleId);
      fresh.delete(poleId);
      if (untouched) store.purge({ poles: [poleId] }).catch((e) => console.warn(e));
    },

    // Called when stored data changes. Returns true when this screen has dealt with it.
    changed(detail) {
      if (!showing || showing.poleId !== poleId) return false;
      if (!store.getPole(poleId)) return false; // the pole is gone, so the app must leave this screen
      if (detail.kind === 'photo') {
        if (detail.poleId === poleId) {
          refreshPart(poleId, 'photos');
          refreshPart(poleId, 'review');
        }
        return true;
      }
      if (detail.kind === 'pole') {
        if (detail.id === poleId) {
          refreshPart(poleId, 'gps');
          refreshPart(poleId, 'spans');
          refreshPart(poleId, 'review');
        }
        return true;
      }
      // Nothing else that can change while a pole is open is shown on this screen.
      return detail.kind === 'job' || detail.kind === 'space';
    },

    input(element, root) {
      const c = context();
      const key = handleInput(element, c);
      if (!key) return;
      refreshLive(root, step.items, c);
      if (TEMPLATE.pole.tagKeys.includes(key)) {
        const sub = root.querySelector('[data-pole-sub]');
        const pole = store.getPole(poleId);
        if (sub && pole) sub.textContent = subLine(pole);
      }
    },

    tap(target) {
      const changed = handleTap(target, context(), (key, value) => {
        toast('Answer cleared', {
          action: 'Undo',
          onAction: () => {
            store.setPoleField(poleId, key, value);
            redraw();
          },
        });
      });
      if (changed === null) return true; // a second tap on the answer just chosen: nothing to do
      if (!changed) return false;
      redraw();
      return true;
    },

    actions: {
      ...spanActions(poleId, () => refreshPart(poleId, 'spans')),
      'step-back': () => {
        const target = backTarget().path;
        jumped = null;
        backTo(target);
      },
      'step-goto': (element) => {
        jumped = null;
        go(paths.pole(poleId, element.getAttribute('data-step')));
      },
      'review-goto': (element) => {
        const to = element.getAttribute('data-step');
        jumped = { poleId, from: step.key, to };
        go(paths.pole(poleId, to), { focus: element.getAttribute('data-key') });
      },
      'step-next': async () => {
        jumped = null;
        if (!last) {
          go(paths.pole(poleId, steps[stepIndex + 1].key));
          return;
        }
        const pole = store.getPole(poleId);
        if (!pole) return;
        const number = store.poleNumber(pole);
        store.setPoleDone(poleId, true);
        try {
          await store.flush();
        } catch (error) {
          await messageSheet('Not saved yet', [
            'The phone refused to store this pole.',
            'It is still on screen, and the app keeps trying. Do not close the app. Free up some space, or export the job now to get it off the phone.',
          ]);
          return;
        }
        fresh.delete(poleId);
        backTo(paths.job(jobId));
        toast('Pole ' + number + ' saved on this phone');
      },

      'gps-get': async () => {
        if (gps.controller) return;
        const controller = new AbortController();
        gps.controller = controller;
        gps.poleId = poleId;
        gps.best = null;
        gps.error = '';
        gps.errorPoleId = null;
        refreshPart(poleId, 'gps');
        try {
          const fix = await getPosition({
            signal: controller.signal,
            onProgress: (best) => {
              if (gps.controller !== controller) return;
              gps.best = best;
              const line = showing && showing.poleId === poleId ? showing.root.querySelector('[data-gps-progress]') : null;
              if (line) line.textContent = gpsProgress();
            },
          });
          // The user left this pole, or cancelled, while the phone was still looking.
          if (gps.controller !== controller) return;
          gps.controller = null;
          gps.poleId = null;
          gps.best = null;
          store.setPoleGps(poleId, fix);
        } catch (error) {
          if (gps.controller !== controller) return;
          gps.controller = null;
          gps.poleId = null;
          gps.best = null;
          if (error && error.code !== 'cancelled') {
            gps.error = error.message || 'The phone could not find its position.';
            gps.errorPoleId = poleId;
          }
          refreshPart(poleId, 'gps');
        }
      },
      'gps-cancel': () => {
        stopGps();
        refreshPart(poleId, 'gps');
      },
      'gps-clear': async () => {
        const pole = store.getPole(poleId);
        if (!pole || !pole.gps) return;
        const before = { ...pole.gps };
        const yes = await confirmSheet({ title: 'Clear this position?', text: 'The saved position for this pole will be removed.', yes: 'Clear position', no: 'Keep it', danger: true });
        if (!yes) return;
        store.setPoleGps(poleId, null);
        toast('Position cleared', { action: 'Undo', onAction: () => store.setPoleGps(poleId, before) });
      },

      'photo-take': () => {
        const input = showing && showing.root.querySelector('#cam');
        if (input) input.click();
      },
      'photo-pick': () => {
        const input = showing && showing.root.querySelector('#lib');
        if (input) input.click();
      },
      'photo-open': (element) => openViewer(element.getAttribute('data-id')),
      'sketch-new': async () => {
        const saved = await openSketch({ title: 'Sketch', onSave: (blob) => store.track(saveSketch(poleId, blob, 'Sketch')) });
        if (saved) toast("Sketch saved with this pole's photos");
      },
      'sketch-photo': async () => {
        if (!viewer) return;
        const photo = store.getPhoto(viewer.photoId);
        const blob = photo ? await store.getPhotoBlob(photo.id, 'full') : null;
        if (!blob) {
          toast('This photo could not be read from the phone.');
          return;
        }
        closeSheet(undefined);
        // The photo itself is left as it is. The marked-up copy is saved beside it.
        const label = (photo.label ? photo.label + ', marked up' : 'Marked up').slice(0, 60);
        const saved = await openSketch({ background: blob, title: 'Draw on the photo', onSave: (out) => store.track(saveSketch(poleId, out, label)) });
        if (saved) toast('Marked-up copy saved. The original photo is unchanged.');
      },
      'photo-label': (element) => {
        if (!viewer) return;
        const photo = store.getPhoto(viewer.photoId);
        if (!photo) return;
        const label = element.getAttribute('data-label');
        store.setPhotoLabel(photo.id, photo.label === label ? '' : label);
        const chips = document.querySelector('#modal [data-label-chips]');
        const typed = document.querySelector('#modal #photo-label');
        const now = store.getPhoto(photo.id);
        if (chips && now) chips.innerHTML = String(html`${viewerChips(now)}`);
        if (typed) typed.value = '';
      },
      'photo-delete': async () => {
        if (!viewer) return;
        const photoId = viewer.photoId;
        closeViewer(); // the question below takes the viewer's place
        const yes = await confirmSheet({
          title: 'Delete this photo?',
          text: 'You can bring it back from Settings, Recently deleted, for 30 days.',
          yes: 'Delete photo',
          no: 'Keep it',
          danger: true,
        });
        if (!yes) return;
        // Focus moves to the photo that takes this one's place, so it is not lost with the button.
        const before = [...document.querySelectorAll('#app [data-part="photos"] [data-act="photo-open"]')].map((b) => b.getAttribute('data-id'));
        const index = before.indexOf(photoId);
        store.deletePhoto(photoId);
        const after = [...document.querySelectorAll('#app [data-part="photos"] [data-act="photo-open"]')];
        const next = after[index] || after[index - 1] || document.querySelector('#app [data-act="photo-take"]');
        if (next) next.focus({ preventScroll: true });
        const url = thumbs.get(photoId);
        if (url) {
          URL.revokeObjectURL(url);
          thumbs.delete(photoId);
        }
        toast('Photo deleted', { action: 'Undo', onAction: () => store.restorePhoto(photoId) });
      },

      'pole-delete': async () => {
        const pole = store.getPole(poleId);
        if (!pole) return;
        const yes = await confirmSheet({
          title: 'Delete this pole?',
          text: ['This removes the pole and its photos from the job.', 'You can bring it back from Settings, Recently deleted, for 30 days.'],
          yes: 'Delete pole',
          no: 'Keep it',
          danger: true,
        });
        if (!yes) return;
        fresh.delete(poleId);
        // Once the pole is gone this screen has nothing to show, and the app returns to the job by itself.
        store.deletePole(poleId);
        toast('Pole deleted', { action: 'Undo', onAction: () => store.restorePole(poleId) });
      },
    },

    // Typing in the photo viewer's own label box.
    sheetInput(element) {
      if (spanSheetInput(element)) return;
      if (element.id !== 'photo-label' || !viewer) return;
      store.setPhotoLabel(viewer.photoId, element.value);
      const now = store.getPhoto(viewer.photoId);
      const chips = document.querySelector('#modal [data-label-chips]');
      if (chips && now) chips.innerHTML = String(html`${viewerChips(now)}`);
    },
  };
}
