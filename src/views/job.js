// One job: its details and its poles.

import { html, attrs, icon, plural, confirmSheet, toast } from '../ui.js';
import * as store from '../store.js';
import { TEMPLATE } from '../template.js';
import { poleTag, poleProgress, poleWarnings, columnLabel } from '../template-engine.js';
import { paths, go, backTo } from '../nav.js';
import { startExport } from './exporting.js';
import { jobName, jobCode, pillClass, saveProblem } from './shared.js';
import { markFresh } from './pole.js';
import { GPS_POOR_ACCURACY_M } from '../config.js';

function poleCard(pole, index) {
  const tokens = store.tokens();
  const started = store.poleStarted(pole);
  const photos = store.photoCount(pole.id);
  const parts = [plural(photos, 'photo')];
  if (started) {
    const blank = poleProgress(TEMPLATE, pole, tokens).blank.length;
    const check = poleWarnings(TEMPLATE, pole, tokens, { usedElsewhere: (key, value) => store.valueUsedElsewhere(pole, key, value), poorGpsMetres: GPS_POOR_ACCURACY_M }).length;
    if (blank) parts.push(blank + ' left blank');
    if (check) parts.push(check + ' to check');
  }
  const state = pole.done ? { key: 'done', text: 'Done' } : started ? { key: 'wait', text: 'In progress' } : { key: 'new', text: 'Not started' };
  return html`<button type="button" class="card" data-act="open-pole" data-id="${pole.id}">
    <div class="row"><div class="name">Pole ${index + 1}</div><div class="code">${poleTag(TEMPLATE, pole)}</div></div>
    <div class="row center"><div class="sub">${parts.join(' · ')}</div><div class="${pillClass(state.key)}">${state.text}</div></div>
  </button>`;
}

function detailsCard(job) {
  const tokens = store.tokens();
  const rows = TEMPLATE.job.items
    .filter((item) => item.key !== TEMPLATE.job.titleKey && item.key !== TEMPLATE.job.codeKey)
    .map((item) => ({ label: columnLabel(item, tokens), value: String(job.f[item.key] || '').trim() }))
    .filter((row) => row.value !== '');
  return html`<button type="button" class="card quiet" data-act="edit-details">
    <div class="row center"><div class="eyebrow">Job details</div><div class="link">Edit</div></div>
    ${rows.length ? html`<div class="kvs">${rows.map((row) => html`<div class="kv"><div class="k">${row.label}</div><div class="v">${row.value}</div></div>`)}</div>` : ''}
  </button>`;
}

export function open(route) {
  const jobId = route.id;
  if (!store.getJob(jobId)) return null;
  return {
    get title() {
      const job = store.getJob(jobId);
      return job ? jobName(job) : 'Job';
    },
    render() {
      const job = store.getJob(jobId);
      if (!job) return html``;
      const status = store.jobStatus(job);
      const poles = store.listPoles(jobId);
      const canExport = poles.some(store.poleStarted);
      return html`<header class="top">
          <div class="bar">
            <button type="button" class="back" data-act="back" aria-label="Back to jobs">${icon.back}</button>
            <div class="where"><h1 class="t" data-heading tabindex="-1">${jobName(job)}</h1><div class="s">${jobCode(job) || 'No design #'}</div></div>
          </div>
          <div class="bar"><h2 class="eyebrow">Poles in this job</h2><div class="${pillClass(status.key)}">${status.text}</div></div>
        </header>
        <main class="list padded">
          ${saveProblem()}
          ${detailsCard(job)}
          <div class="cards">${poles.length ? poles.map(poleCard) : html`<div class="empty">No poles yet. Tap Add pole.</div>`}</div>
          <div class="more">
            <button type="button" class="btn ghost" data-act="export-job"${attrs({ disabled: !canExport })}>Export this job</button>
            <button type="button" class="btn danger" data-act="delete-job">Delete job</button>
            <div class="save-line"><span class="save-status" data-save-status></span></div>
          </div>
        </main>
        <div class="foot"><button type="button" class="btn" data-act="add-pole">Add pole</button></div>`;
    },
    actions: {
      back: () => backTo(paths.home()),
      'edit-details': () => go(paths.jobDetails(jobId)),
      'open-pole': (element) => go(paths.pole(element.getAttribute('data-id'), TEMPLATE.pole.steps[0].key)),
      'add-pole': () => {
        const pole = store.createPole(jobId);
        if (!pole) return;
        markFresh(pole.id);
        go(paths.pole(pole.id, TEMPLATE.pole.steps[0].key));
      },
      'export-job': () => startExport([jobId]),
      'delete-job': async () => {
        const job = store.getJob(jobId);
        if (!job) return;
        const poles = store.listPoles(jobId).length;
        const yes = await confirmSheet({
          title: 'Delete this job?',
          text: [
            poles ? 'This removes the job and its ' + plural(poles, 'pole') + ' from your list.' : 'This removes the job from your list.',
            'You can bring it back from Settings, Recently deleted, for 30 days.',
          ],
          yes: 'Delete job',
          no: 'Keep it',
          danger: true,
        });
        if (!yes) return;
        // Once the job is gone this screen has nothing to show, and the app returns to the job list by itself.
        store.deleteJob(jobId);
        toast('Job deleted', { action: 'Undo', onAction: () => store.restoreJob(jobId) });
      },
    },
  };
}
