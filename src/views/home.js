// The first screen: what is waiting to be exported, and the list of jobs.

import { html, attrs, icon, plural, openSheet } from '../ui.js';
import * as store from '../store.js';
import { TEMPLATE } from '../template.js';
import { poleTag } from '../template-engine.js';
import { paths, go } from '../nav.js';
import { pwa, isIOS, isStandalone } from '../pwa.js';
import { startExport } from './exporting.js';
import { jobName, jobCode, pillClass, saveProblem } from './shared.js';
import { APP_NAME } from '../config.js';

const SEARCH_FROM = 6;
let searchText = '';

function banner() {
  const waiting = store.waitingPoleCount();
  const poles = plural(waiting, 'pole');
  if (navigator.onLine === false) {
    return html`<div class="banner">${icon.nosignal}<div><div class="b-title">No signal</div>
      <div class="b-text">${waiting ? poles + ' saved on this phone, waiting to export' : 'The app still works. Everything saves on this phone.'}</div></div></div>`;
  }
  if (waiting) {
    return html`<div class="banner">${icon.phone}<div><div class="b-title">Not exported yet</div>
      <div class="b-text">${poles} saved on this phone only</div></div></div>`;
  }
  if (!store.listJobs().length) return '';
  return html`<div class="banner ok">${icon.check}<div><div class="b-title">Nothing waiting</div>
    <div class="b-text">Every saved pole has been exported</div></div></div>`;
}

function notices() {
  const out = [];
  if (store.isSpaceLow()) {
    out.push(html`<div class="notice warn">${icon.alert}<div class="b-text grow">The phone is nearly out of space for this app. Export your jobs, then delete the ones you no longer need.</div></div>`);
  }
  if (pwa.reloadNeeded) {
    out.push(html`<div class="notice"><div class="b-text">The app was updated in another tab.</div>
      <div class="chips"><button type="button" class="chip" data-act="reload">Reload</button></div></div>`);
  } else if (pwa.updateReady) {
    out.push(html`<div class="notice"><div class="b-text">A new version is ready.</div>
      <div class="chips"><button type="button" class="chip" data-act="update-now">Update</button></div></div>`);
  }
  if (isIOS() && !isStandalone()) {
    out.push(html`<div class="notice warn"><div class="b-text grow"><strong>First, add this app to your Home Screen.</strong> Poles saved in Safari can be cleared by the phone after a week.</div>
      <div class="chips"><button type="button" class="chip" data-act="ios-install-help">How</button></div></div>`);
  } else if (pwa.canInstall && !isStandalone()) {
    out.push(html`<div class="notice"><div class="b-text">Install the app on this phone.</div>
      <div class="chips"><button type="button" class="chip" data-act="install-app">Install</button></div></div>`);
  }
  if (pwa.failed || !pwa.supported) {
    out.push(html`<div class="notice warn">${icon.nosignal}<div class="b-text grow">The app is not stored on this phone yet, so it will not open with no signal. Open it once with signal. Check Settings to see when it is ready.</div></div>`);
  }
  return out;
}

function matches(job, wanted) {
  if (!wanted) return true;
  const hay = [jobName(job), jobCode(job), ...Object.values(job.f)];
  for (const pole of store.listPoles(job.id)) hay.push(poleTag(TEMPLATE, pole));
  return hay.join('\n').toLowerCase().includes(wanted);
}

function cards(jobs) {
  const wanted = searchText.trim().toLowerCase();
  const shown = jobs.filter((job) => matches(job, wanted));
  if (!jobs.length) return html`<div class="empty">No jobs yet. Tap New job to record your first pole.</div>`;
  if (!shown.length) return html`<div class="empty">No job matches "${searchText.trim()}".</div>`;
  return shown.map((job) => {
    const status = store.jobStatus(job);
    const poles = store.listPoles(job.id);
    const done = poles.filter((pole) => pole.done).length;
    return html`<button type="button" class="card" data-act="open-job" data-id="${job.id}">
      <div class="row"><div class="name">${jobName(job)}</div><div class="code">${jobCode(job)}</div></div>
      <div class="row center"><div class="sub">${done} of ${plural(poles.length, 'pole')} done</div><div class="${pillClass(status.key)}">${status.text}</div></div>
    </button>`;
  });
}

export function showIosInstallHelp() {
  openSheet(
    html`<h2>Add to Home Screen</h2>
      <p>Do this before recording real poles. It keeps your data safe and lets the app open with no signal.</p>
      <ol class="steps">
        <li>Open this page in <strong>Safari</strong>.</li>
        <li>Tap the <strong>Share</strong> button (the square with an arrow).</li>
        <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
        <li>Open the app from the new icon while you still have signal.</li>
      </ol>
      <p class="fine">Anything already saved in Safari stays in Safari. Use Settings, then Save a backup file, to move it across.</p>
      <button type="button" class="btn" data-sheet="ok" data-autofocus>OK</button>`,
    { label: 'Add to Home Screen' },
  );
}

export function open() {
  return {
    title: APP_NAME,
    render() {
      const jobs = store.listJobs();
      const canExport = jobs.some((job) => store.listPoles(job.id).some(store.poleStarted));
      if (jobs.length < SEARCH_FROM) searchText = '';
      return html`<header class="home-top">
          <div class="title-row">
            <h1 data-heading tabindex="-1">${APP_NAME}</h1>
            <button type="button" class="back" data-act="open-settings" aria-label="Settings">${icon.settings}</button>
          </div>
          ${saveProblem()}${banner()}${notices()}
        </header>
        <main class="list">
          <div class="title-row"><h2 class="eyebrow">My jobs</h2><span class="save-status" data-save-status></span></div>
          ${jobs.length >= SEARCH_FROM
            ? html`<div class="search">${icon.search}<input${attrs({ class: 'input', id: 'job-search', type: 'search', placeholder: 'Find a job or pole tag', autocomplete: 'off', 'aria-label': 'Find a job or pole tag', value: searchText })}></div>`
            : ''}
          <div class="cards" id="job-cards">${cards(jobs)}</div>
          <div class="more">
            <button type="button" class="btn ghost" data-act="export-all"${attrs({ disabled: !canExport })}>Export all jobs</button>
          </div>
        </main>
        <div class="foot"><button type="button" class="btn" data-act="new-job">New job</button></div>`;
    },
    input(element, root) {
      if (element.id !== 'job-search') return;
      searchText = element.value;
      const box = root.querySelector('#job-cards');
      if (box) box.innerHTML = String(html`${cards(store.listJobs())}`);
    },
    actions: {
      'new-job': () => {
        searchText = '';
        const job = store.createJob();
        go(paths.jobDetails(job.id));
      },
      'open-job': (element) => go(paths.job(element.getAttribute('data-id'))),
      'open-settings': () => go(paths.settings()),
      'export-all': () => startExport(store.listJobs().map((job) => job.id)),
    },
  };
}
