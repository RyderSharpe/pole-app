// Small pieces used by more than one screen.

import { html, icon } from '../ui.js';
import * as store from '../store.js';
import { TEMPLATE } from '../template.js';

export const jobName = (job) => String(job.f[TEMPLATE.job.titleKey] || '').trim() || 'Untitled job';
export const jobCode = (job) => String(job.f[TEMPLATE.job.codeKey] || '').trim();
export const pillClass = (key) => (key === 'done' ? 'pill done' : key === 'wait' ? 'pill wait' : 'pill');

/** The red banner shown on every screen while the phone is refusing to save. */
export function saveProblem() {
  if (store.saveStatus() !== 'error') return '';
  return html`<div class="banner bad" role="alert">${icon.alert}
    <div class="grow">
      <div class="b-title">The phone is not saving</div>
      <div class="b-text">Your entries are still on screen. Keep the app open, free up some space, or export now to get them off the phone.</div>
      <div class="chips banner-actions"><button type="button" class="chip" data-act="save-retry">Try again</button></div>
    </div>
  </div>`;
}

/** The header used by the plain screens: a back arrow, a title and the save status. */
export function plainHeader(title, backLabel) {
  return html`<header class="top">
    <div class="bar">
      <button type="button" class="back" data-act="back" aria-label="${backLabel}">${icon.back}</button>
      <div class="where"><h1 class="t" data-heading tabindex="-1">${title}</h1><div class="s"><span class="save-status" data-save-status></span></div></div>
    </div>
  </header>`;
}
