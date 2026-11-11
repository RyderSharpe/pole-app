// The details of a job: location, date, who collected it, and so on.

import { html, icon } from '../ui.js';
import * as store from '../store.js';
import { TEMPLATE } from '../template.js';
import { renderItems, refreshLive, handleInput } from '../form.js';
import { paths, goVia, backTo } from '../nav.js';
import { today } from '../records.js';
import { jobName, saveProblem } from './shared.js';
import { markFresh } from './pole.js';

// True when a job holds nothing beyond what the app filled in by itself. A job with a pole in
// Recently deleted is not untouched, because that pole can still be brought back.
function untouched(job) {
  if (!store.jobHasNoPoles(job.id) || job.exportedAt > 0) return false;
  const defaults = { date: today(), collectedBy: store.settings().collectedBy };
  return Object.keys(job.f).every((key) => key in defaults && job.f[key] === defaults[key]);
}

// The first name typed under "Collected by" becomes the default for later jobs.
function rememberName(job) {
  const name = String(job.f.collectedBy || '').trim();
  if (name && !store.settings().collectedBy) store.setSetting('collectedBy', name, true);
}

export function open(route) {
  const jobId = route.id;
  if (!store.getJob(jobId)) return null;

  const context = () => {
    const job = store.getJob(jobId);
    return { template: TEMPLATE, tokens: store.tokens(), f: job ? job.f : {}, set: (key, value) => store.setJobField(jobId, key, value), usedElsewhere: null };
  };

  return {
    title: 'Job details',
    render() {
      const job = store.getJob(jobId);
      if (!job) return html``;
      const first = !store.hasAnyPole(jobId);
      return html`<header class="top">
          <div class="bar">
            <button type="button" class="back" data-act="back" aria-label="Back">${icon.back}</button>
            <div class="where"><div class="t" data-job-title>${jobName(job)}</div><div class="s">Job details</div></div>
          </div>
          <div class="bar"><h1 class="eyebrow" data-heading tabindex="-1">Job details</h1><span class="save-status" data-save-status="short"></span></div>
        </header>
        <main class="body">${saveProblem()}${renderItems(TEMPLATE.job.items, context(), null)}</main>
        <div class="foot"><button type="button" class="btn" data-act="details-done">${first ? 'Next: Pole 1' : 'Done'}</button></div>`;
    },
    input(element, root) {
      const c = context();
      const key = handleInput(element, c);
      if (!key) return;
      refreshLive(root, TEMPLATE.job.items, c);
      if (key === TEMPLATE.job.titleKey) {
        const title = root.querySelector('[data-job-title]');
        const job = store.getJob(jobId);
        if (title && job) title.textContent = jobName(job);
      }
    },
    actions: {
      back: () => {
        const job = store.getJob(jobId);
        backTo(job && untouched(job) ? paths.home() : paths.job(jobId));
      },
      'details-done': () => {
        const job = store.getJob(jobId);
        if (!job) return;
        rememberName(job);
        if (store.hasAnyPole(jobId)) {
          backTo(paths.job(jobId));
          return;
        }
        const pole = store.createPole(jobId);
        if (!pole) return;
        markFresh(pole.id);
        // In the history this screen becomes the job, so the phone's Back button returns to the
        // job (not to these details) from the first pole, and after "Save pole".
        goVia(paths.job(jobId), paths.pole(pole.id, TEMPLATE.pole.steps[0].key));
      },
    },
    // Called when the user moves to another screen.
    leave() {
      const job = store.getJob(jobId);
      if (!job) return;
      rememberName(job);
      // A job opened by mistake and left empty is removed, so it does not clutter the list.
      if (untouched(job)) store.purge({ jobs: [jobId] }).catch((e) => console.warn(e));
    },
  };
}
