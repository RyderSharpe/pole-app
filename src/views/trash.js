// Recently deleted: jobs, poles and photos that can still be brought back.

import { html, plural, confirmSheet, messageSheet, toast } from '../ui.js';
import * as store from '../store.js';
import { TEMPLATE } from '../template.js';
import { poleTag } from '../template-engine.js';
import { paths, backTo } from '../nav.js';
import { jobName, jobCode, saveProblem, plainHeader } from './shared.js';
import { TRASH_DAYS } from '../config.js';

const urls = new Map(); // photo id -> address of its small picture
let mountedNow = false;
// After "Bring back" or "Delete forever" the card is gone, so focus moves to the next card's
// first button (or the heading), not to nowhere.
let focusAfter = '';

function nextFocus(element) {
  const cards = [...document.querySelectorAll('#app [data-trash]')];
  const card = element.closest('[data-trash]');
  const i = cards.indexOf(card);
  const other = cards[i + 1] || cards[i - 1];
  const button = other && other.querySelector('[data-act="trash-restore"]');
  return button && button.id ? button.id : 'heading';
}

function dropUrls() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

const left = (days) => (days <= 1 ? 'Last day' : days + ' days left');

function buttons(kind, id) {
  return html`<div class="pair">
    <button type="button" class="btn ghost small white" id="t-${kind}-restore-${id}" data-act="trash-restore" data-kind="${kind}" data-id="${id}">Bring back</button>
    <button type="button" class="btn danger small" id="t-${kind}-forever-${id}" data-act="trash-forever" data-kind="${kind}" data-id="${id}">Delete forever</button>
  </div>`;
}

function poleLabel(pole) {
  const tag = poleTag(TEMPLATE, pole);
  return tag ? 'Pole ' + tag : 'Pole with no tag';
}

async function loadPictures(root, list) {
  for (const { photo } of list) {
    if (!urls.has(photo.id)) {
      const blob = await store.getPhotoBlob(photo.id, 'thumb');
      if (!mountedNow) return;
      if (blob) urls.set(photo.id, URL.createObjectURL(blob));
    }
    const image = root.querySelector('img[data-thumb="' + photo.id + '"]');
    if (image && urls.has(photo.id)) image.src = urls.get(photo.id);
  }
}

export function open() {
  return {
    title: 'Recently deleted',
    render() {
      const t = store.trash();
      const empty = !t.jobs.length && !t.poles.length && !t.photos.length;
      return html`${plainHeader('Recently deleted', 'Back to Settings')}
        <main class="list padded">
          ${saveProblem()}
          <p class="fine">Deleted jobs, poles and photos stay here for ${TRASH_DAYS} days. After that they are removed for good.</p>
          ${empty ? html`<div class="empty">Nothing here.</div>` : ''}
          ${t.jobs.length ? html`<h2 class="eyebrow">Jobs</h2>` : ''}
          ${t.jobs.map(({ job, daysLeft, poleCount }) => html`<div class="card static" data-trash="job">
            <div class="row"><div class="name">${jobName(job)}</div><div class="code">${jobCode(job)}</div></div>
            <div class="row center"><div class="sub">${plural(poleCount, 'pole')}</div><div class="pill wait">${left(daysLeft)}</div></div>
            ${buttons('job', job.id)}
          </div>`)}
          ${t.poles.length ? html`<h2 class="eyebrow">Poles</h2>` : ''}
          ${t.poles.map(({ pole, job, daysLeft }) => html`<div class="card static" data-trash="pole">
            <div class="row"><div class="name">${poleLabel(pole)}</div></div>
            <div class="row center"><div class="sub">From ${jobName(job)}</div><div class="pill wait">${left(daysLeft)}</div></div>
            ${buttons('pole', pole.id)}
          </div>`)}
          ${t.photos.length ? html`<h2 class="eyebrow">Photos</h2>` : ''}
          ${t.photos.map(({ photo, pole, job, daysLeft }) => html`<div class="card static" data-trash="photo">
            <div class="trash-photo">
              <div class="photo static"><img alt="" data-thumb="${photo.id}"></div>
              <div class="grow">
                <div class="name">${photo.label || 'Photo'}</div>
                <div class="sub">From ${poleLabel(pole)}, ${jobName(job)}</div>
                <div class="pill wait">${left(daysLeft)}</div>
              </div>
            </div>
            ${buttons('photo', photo.id)}
          </div>`)}
        </main>`;
    },

    mounted(root) {
      mountedNow = true;
      loadPictures(root, store.trash().photos).catch((e) => console.warn(e));
      if (focusAfter) {
        const target = (focusAfter !== 'heading' && root.querySelector('#' + focusAfter)) || root.querySelector('[data-heading]');
        focusAfter = '';
        if (target) target.focus({ preventScroll: false });
      }
    },

    unmount() {
      mountedNow = false;
    },

    leave() {
      dropUrls();
    },

    actions: {
      back: () => backTo(paths.settings()),
      'trash-restore': (element) => {
        const kind = element.getAttribute('data-kind');
        const id = element.getAttribute('data-id');
        focusAfter = nextFocus(element);
        if (kind === 'job') store.restoreJob(id);
        else if (kind === 'pole') store.restorePole(id);
        else store.restorePhoto(id);
        toast(kind === 'job' ? 'Job brought back' : kind === 'pole' ? 'Pole brought back' : 'Photo brought back');
      },
      'trash-forever': async (element) => {
        const kind = element.getAttribute('data-kind');
        const id = element.getAttribute('data-id');
        const what = kind === 'job' ? 'this job, its poles and its photos' : kind === 'pole' ? 'this pole and its photos' : 'this photo';
        const next = nextFocus(element);
        const yes = await confirmSheet({ title: 'Delete forever?', text: 'This removes ' + what + ' from the phone for good. It cannot be undone.', yes: 'Delete forever', no: 'Keep it', danger: true });
        if (!yes) return;
        focusAfter = next;
        try {
          await store.purge(kind === 'job' ? { jobs: [id] } : kind === 'pole' ? { poles: [id] } : { photos: [id] });
          toast('Deleted for good');
        } catch (error) {
          console.error(error);
          await messageSheet('Could not delete', 'The phone refused. Nothing was removed. Try again in a moment.');
        }
      },
    },
  };
}
