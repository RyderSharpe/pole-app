// Settings: names, backup, storage, updates and details for troubleshooting.

import { html, attrs, icon, plural, formatBytes, formatDateTime, openSheet, busySheet, setBusyText, messageSheet, confirmSheet, toast } from '../ui.js';
import * as store from '../store.js';
import { paths, go, backTo, redraw } from '../nav.js';
import { pwa, isIOS, isStandalone, checkForUpdate } from '../pwa.js';
import { restoreBackupFile } from '../backup.js';
import { startBackup } from './exporting.js';
import { saveProblem, plainHeader } from './shared.js';
import { APP_NAME, APP_VERSION, DB_NAME, DEFAULT_TOKENS, SCOPE } from '../config.js';

let storage = null; // the last storage report, kept so the screen does not flicker when it redraws
let mountedNow = false;

function offlineLine() {
  if (!pwa.supported) return { text: 'No. This browser cannot store the app.', ok: false };
  if (pwa.offlineReady) return { text: 'Yes', ok: true };
  if (pwa.failed) return { text: 'Not yet. Open the app with signal, then tap Check for update.', ok: false };
  return { text: 'Not yet. Getting ready, keep the app open for a moment.', ok: false };
}

function storageInner() {
  const c = store.counts();
  const rows = [['On this phone', plural(c.jobs, 'job') + ', ' + plural(c.poles, 'pole') + ', ' + plural(c.photos, 'photo')]];
  if (storage) {
    if (storage.usage != null) rows.push(['Space used', formatBytes(storage.usage) + (storage.quota ? ' of ' + formatBytes(storage.quota) + ' allowed' : '')]);
    else rows.push(['Space used', 'This phone does not report it']);
    rows.push(['Protected from clean-up', storage.persisted === true ? 'Yes' : storage.persisted === false ? 'No' : 'This phone does not report it']);
  } else {
    rows.push(['Space used', 'Checking']);
  }
  return html`<div class="kvs">${rows.map(([k, v]) => html`<div class="kv"><div class="k">${k}</div><div class="v">${v}</div></div>`)}</div>
    ${storage && storage.persisted === false
      ? html`<p class="fine">${isIOS() && !isStandalone() ? 'Add the app to your Home Screen to protect its data.' : 'The phone may clear this app\'s data if it runs very low on space. Export and back up often.'}</p>
          <button type="button" class="btn ghost small" data-act="storage-protect">Ask the phone to protect it</button>`
      : ''}`;
}

function details() {
  const c = store.counts();
  const lines = [
    APP_NAME + ' ' + APP_VERSION,
    'Offline copy: ' + (pwa.offlineReady ? pwa.offlineVersion || 'ready' : pwa.failed ? 'failed' : 'not ready'),
    'Opened from Home Screen: ' + (isStandalone() ? 'yes' : 'no'),
    'Address folder: ' + SCOPE,
    'Storage name: ' + DB_NAME,
    'Jobs ' + c.jobs + ', poles ' + c.poles + ', photos ' + c.photos + ', recently deleted ' + store.trashCount(),
    'Save status: ' + store.saveStatus() + (store.saveError() ? ' (' + String(store.saveError().message || store.saveError()) + ')' : ''),
    'Space: ' + (storage && storage.usage != null ? formatBytes(storage.usage) + ' of ' + (storage.quota ? formatBytes(storage.quota) : '?') : 'not reported'),
    'Protected: ' + (storage ? String(storage.persisted) : 'unknown'),
    'Signal: ' + (navigator.onLine === false ? 'offline' : 'online'),
    'Browser: ' + navigator.userAgent,
  ];
  return lines.join('\n');
}

function licences() {
  openSheet(
    html`<h2>About</h2>
      <p>${APP_NAME} ${APP_VERSION}. Everything you record stays on this phone until you export it.</p>
      <p>The app includes these parts written by others:</p>
      <div class="kvs">
        <div class="kv"><div class="k">IBM Plex Sans</div><div class="v"><a href="fonts/LICENSE-IBM-Plex-Sans.txt" target="_blank" rel="noopener">Open Font Licence</a></div></div>
        <div class="kv"><div class="k">IBM Plex Mono</div><div class="v"><a href="fonts/LICENSE-IBM-Plex-Mono.txt" target="_blank" rel="noopener">Open Font Licence</a></div></div>
      </div>
      <button type="button" class="btn" data-sheet="ok" data-autofocus>OK</button>`,
    { label: 'About' },
  );
}

function restoreSummary(result) {
  const lines = [];
  const added = [];
  if (result.added.jobs) added.push(plural(result.added.jobs, 'job'));
  if (result.added.poles) added.push(plural(result.added.poles, 'pole'));
  if (result.added.photos) added.push(plural(result.added.photos, 'photo'));
  const updated = [];
  if (result.updated.jobs) updated.push(plural(result.updated.jobs, 'job'));
  if (result.updated.poles) updated.push(plural(result.updated.poles, 'pole'));
  if (result.updated.photos) updated.push(plural(result.updated.photos, 'photo'));
  if (added.length) lines.push('Added: ' + added.join(', ') + '.');
  if (updated.length) lines.push('Updated: ' + updated.join(', ') + '.');
  if (!added.length && !updated.length) lines.push('Everything in the file was already on this phone.');
  if (result.missingPhotos) lines.push(plural(result.missingPhotos, 'photo') + ' had no picture in the file and ' + (result.missingPhotos === 1 ? 'was' : 'were') + ' skipped.');
  if (result.damagedPhotos) lines.push(plural(result.damagedPhotos, 'photo') + ' in the file ' + (result.damagedPhotos === 1 ? 'was' : 'were') + ' damaged and skipped.');
  if (result.outOfSpace) lines.push('The phone ran out of space, so the rest of the photos were not restored. Free up space and restore the same file again.');
  lines.push('Nothing was removed from this phone.');
  return lines;
}

async function restoreFrom(file) {
  const yes = await confirmSheet({
    title: 'Restore from this file?',
    text: [file.name, 'It adds what is missing and updates what is older. Nothing on this phone is removed.'],
    yes: 'Restore',
    no: 'Cancel',
  });
  if (!yes) return;
  busySheet('Restoring', 'Reading the file.');
  try {
    await store.whenIdle();
    const result = await restoreBackupFile(file, (done, total) => setBusyText('Photos: ' + done + ' of ' + total));
    await messageSheet(result.outOfSpace ? 'Partly restored' : 'Restore finished', restoreSummary(result));
  } catch (error) {
    console.error(error);
    await messageSheet('The file could not be restored', [error && error.message ? error.message : 'Something went wrong.', 'Nothing on this phone was removed.']);
  }
}

export function open() {
  return {
    title: 'Settings',
    render() {
      const s = store.settings();
      const offline = offlineLine();
      const deleted = store.trashCount();
      const power = s.tokens.power === DEFAULT_TOKENS.power ? '' : s.tokens.power;
      const telecom = s.tokens.telecom === DEFAULT_TOKENS.telecom ? '' : s.tokens.telecom;
      return html`${plainHeader('Settings', 'Back to jobs')}
        <main class="body">
          ${saveProblem()}
          <section class="card static">
            <h2 class="eyebrow">Your name</h2>
            <div class="field">
              <p class="fine" id="set-name-help">Fills in "Collected by" on new jobs.</p>
              <input${attrs({ class: 'input', id: 'set-name', type: 'text', maxlength: 80, autocomplete: 'name', autocapitalize: 'words', 'aria-label': 'Your name', 'aria-describedby': 'set-name-help', value: s.collectedBy })}>
            </div>
          </section>

          <section class="card static">
            <h2 class="eyebrow">Company names</h2>
            <p class="fine">The questions say "${DEFAULT_TOKENS.power}" and "${DEFAULT_TOKENS.telecom}" until you type the real names here. They stay on this phone.</p>
            <div class="field">
              <label class="label" for="set-power">Power company</label>
              <input${attrs({ class: 'input', id: 'set-power', type: 'text', maxlength: 40, autocomplete: 'off', placeholder: DEFAULT_TOKENS.power, value: power })}>
            </div>
            <div class="field">
              <label class="label" for="set-telecom">Telecom company</label>
              <input${attrs({ class: 'input', id: 'set-telecom', type: 'text', maxlength: 40, autocomplete: 'off', placeholder: DEFAULT_TOKENS.telecom, value: telecom })}>
            </div>
          </section>

          <section class="card static">
            <h2 class="eyebrow">Backup</h2>
            <p class="fine">One file holds every job, pole and photo. Keep a copy somewhere other than this phone.</p>
            <div class="kvs"><div class="kv"><div class="k">Last backup</div><div class="v" data-last-backup>${formatDateTime(s.lastBackupAt)}</div></div></div>
            <button type="button" class="btn ghost" data-act="backup-make">Save a backup file</button>
            <button type="button" class="btn ghost" data-act="backup-restore">Restore from a backup file</button>
            <input id="backup-file" class="file-input" type="file" accept=".zip,application/zip,application/x-zip-compressed" tabindex="-1" aria-hidden="true">
          </section>

          <section class="card static">
            <h2 class="eyebrow">Storage</h2>
            <div class="stack" id="storage-box">${storageInner()}</div>
          </section>

          <section class="card static">
            <h2 class="eyebrow">Recently deleted</h2>
            <p class="fine">${deleted ? plural(deleted, 'item') + ' can still be brought back.' : 'Nothing has been deleted in the last 30 days.'}</p>
            <button type="button" class="btn ghost" data-act="open-trash"${attrs({ disabled: !deleted })}>Open Recently deleted</button>
          </section>

          <section class="card static">
            <h2 class="eyebrow">App</h2>
            <div class="kvs">
              <div class="kv"><div class="k">Version</div><div class="v">${APP_VERSION}</div></div>
              <div class="kv"><div class="k">Works with no signal</div><div class="v${offline.ok ? '' : ' warn-text'}" data-offline>${offline.text}</div></div>
              <div class="kv"><div class="k">On the Home Screen</div><div class="v">${isStandalone() ? 'Yes' : 'No'}</div></div>
            </div>
            ${pwa.reloadNeeded
              ? html`<button type="button" class="btn" data-act="reload">Reload to finish the update</button>`
              : pwa.updateReady
                ? html`<button type="button" class="btn" data-act="update-now">Update now</button>`
                : html`<button type="button" class="btn ghost" data-act="update-check">${icon.refresh}Check for update</button>`}
            ${pwa.canInstall && !isStandalone() ? html`<button type="button" class="btn ghost" data-act="install-app">Install the app</button>` : ''}
            ${isIOS() && !isStandalone() ? html`<button type="button" class="btn ghost" data-act="ios-install-help">How to add it to the Home Screen</button>` : ''}
            <button type="button" class="btn ghost" data-act="about">About and licences</button>
          </section>

          <section class="card static">
            <h2 class="eyebrow">If something goes wrong</h2>
            <p class="fine">These details help whoever looks after the app. They hold no pole data.</p>
            <button type="button" class="btn ghost" data-act="details-copy">Copy details</button>
          </section>
        </main>`;
    },

    mounted(root) {
      mountedNow = true;
      const input = root.querySelector('#backup-file');
      if (input) {
        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          input.value = '';
          if (file) restoreFrom(file);
        });
      }
      store.checkSpace().then((info) => {
        storage = info;
        const box = mountedNow ? document.querySelector('#app #storage-box') : null;
        if (box) box.innerHTML = String(storageInner());
      }, () => {});
    },

    unmount() {
      mountedNow = false;
    },

    input(element) {
      if (element.id === 'set-name') store.setSetting('collectedBy', element.value, true);
      else if (element.id === 'set-power') store.setToken('power', element.value, true);
      else if (element.id === 'set-telecom') store.setToken('telecom', element.value, true);
    },

    actions: {
      back: () => backTo(paths.home()),
      'open-trash': () => go(paths.trash()),
      'backup-make': () => startBackup(),
      'backup-restore': () => {
        const input = document.querySelector('#app #backup-file');
        if (input) input.click();
      },
      'storage-protect': async () => {
        const granted = await store.requestPersistence();
        storage = await store.checkSpace();
        redraw();
        toast(granted ? 'The phone will keep this app\'s data' : 'The phone did not agree. Export and back up often.');
      },
      'update-check': async () => {
        if (navigator.onLine === false) {
          toast('No signal. Try again when you have signal.');
          return;
        }
        toast('Checking for an update');
        const result = await checkForUpdate(true);
        if (result === 'failed') toast('Could not check. Try again with better signal.');
        else if (result === 'ready') toast('A new version is ready');
        else if (result === 'downloading') toast('Downloading the new version. The Update button appears when it is ready.', { ms: 6000 });
        else if (result === 'none') toast('You have the latest version');
      },
      about: () => licences(),
      'details-copy': async () => {
        const text = details();
        let copied = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            copied = true;
          }
        } catch (e) {
          copied = false;
        }
        if (copied) {
          toast('Details copied');
          return;
        }
        openSheet(
          html`<h2>Details</h2><textarea class="notes" readonly rows="9" aria-label="Details" data-autofocus>${text}</textarea>
            <p class="fine">Press and hold the text to copy it.</p>
            <button type="button" class="btn" data-sheet="ok">OK</button>`,
          { label: 'Details' },
        );
      },
    },
  };
}
