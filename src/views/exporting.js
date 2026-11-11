// The export and backup conversations: choose a format, build the file, hand it over, and only
// then mark the work as off the phone.
//
// A job is marked "exported" only when one of these happens:
//   - the phone's share sheet reports that the file was handed over, or
//   - after a download, the user confirms that the file is really there.
// A cancelled share or an unconfirmed download marks nothing.

import { html, icon, openSheet, closeSheet, busySheet, setBusyText, messageSheet, toast, plural, formatBytes } from '../ui.js';
import * as store from '../store.js';
import { collectExport, buildPdfFile, buildPackageFile, canShareFile, shareFile, downloadFile } from '../exporter.js';
import { buildBackupFile } from '../backup.js';
import { isIOS } from '../pwa.js';

let offered = null; // { file, title, notes, onTaken, takenMessage }

function friendly(error) {
  const text = error && error.message ? String(error.message) : '';
  if (error && (error.name === 'QuotaExceededError' || /quota/i.test(text))) return 'The phone is out of space.';
  if (error && /memory|allocation/i.test(text)) return 'The phone ran out of memory. Try exporting one job at a time.';
  return text || 'Something went wrong.';
}

function readySheet(status) {
  const o = offered;
  if (!o) return;
  const share = canShareFile(o.file);
  // On an iPhone the share sheet is the dependable way to save a file ("Save to Files"). A
  // plain download can open the file over the app with no way back, so it is only offered
  // there when sharing is not possible.
  const download = !(share && isIOS());
  openSheet(
    html`<h2>${o.title}</h2>
      <p class="filename">${o.file.name}</p>
      <p class="fine">${formatBytes(o.file.size)}</p>
      ${o.notes.map((note) => html`<div class="notice warn">${icon.alert}<div class="b-text">${note}</div></div>`)}
      ${status ? html`<p class="hint" data-file-status role="status">${status}</p>` : html`<p class="hint" data-file-status role="status" hidden></p>`}
      ${share ? html`<button type="button" class="btn" data-act="file-share" data-autofocus>${icon.share}Save or share the file</button>` : ''}
      ${download ? html`<button type="button" class="btn${share ? ' ghost' : ''}" data-act="file-download"${share ? '' : html` data-autofocus`}>${icon.download}Download the file</button>` : ''}
      <button type="button" class="btn ghost" data-sheet="close">Close</button>`,
    {
      label: o.title,
      onClose: () => {
        offered = null;
      },
    },
  );
}

async function taken() {
  const o = offered;
  if (!o) return;
  offered = null;
  try {
    await o.onTaken();
  } catch (e) {
    console.error(e);
  }
  closeSheet('taken');
  toast(o.takenMessage);
}

/**
 * Offers a finished file to the user.
 * options: { title, notes: [text], onTaken (async), takenMessage }
 */
export function offerFile(file, options) {
  offered = { file, title: options.title, notes: options.notes || [], onTaken: options.onTaken, takenMessage: options.takenMessage };
  readySheet('');
}

/** Actions for the buttons in the sheets above. main.js adds them to every screen. */
export const fileActions = {
  'file-share': async () => {
    const o = offered;
    if (!o) return;
    const result = await shareFile(o.file); // must be the first thing done, while the tap still counts
    if (offered !== o) return;
    if (result === 'shared') await taken();
    else if (result === 'cancelled') readySheet('Sharing was cancelled. Nothing has been marked as done.');
    else readySheet('Sharing did not work on this phone. Use Download instead.');
  },
  'file-download': () => {
    const o = offered;
    if (!o) return;
    downloadFile(o.file);
    // Leave the sheet's onClose alone: the file is still on offer while the question is asked.
    // "No" sits where "Download" was, so a second tap on Download cannot answer "Yes".
    openSheet(
      html`<h2>Did the file save?</h2>
        <p>Look in Downloads or Files for:</p>
        <p class="filename">${o.file.name}</p>
        <p class="fine">The phone does not tell the app whether a download worked, so please check.</p>
        <button type="button" class="btn ghost" data-act="file-saved-no" data-autofocus>No, try again</button>
        <button type="button" class="btn" data-act="file-saved-yes">Yes, I have the file</button>`,
      {
        label: 'Did the file save?',
        dismissable: false,
      },
    );
  },
  'file-saved-yes': () => taken(),
  'file-saved-no': () => readySheet('Nothing has been marked as done. Try again.'),
};

function saveWarning() {
  return store.saveStatus() === 'error' ? ['The phone is refusing to save right now. This file holds everything on screen, so get it off the phone.'] : [];
}

function photoWarning(count) {
  return count > 0 ? [plural(count, 'photo') + ' could not be read from the phone and ' + (count === 1 ? 'is' : 'are') + ' not in this file.'] : [];
}

async function settle() {
  if (store.pendingWork() > 0) {
    setBusyText('Finishing ' + plural(store.pendingWork(), 'photo') + ' first.');
    await store.whenIdle();
  }
  // If the phone is refusing saves, carry on: the file is built from what is on screen.
  await store.flush().catch(() => {});
}

async function runExport(jobIds, kind) {
  busySheet('Building the file', 'Getting ready.');
  let built;
  let data;
  try {
    await settle();
    data = collectExport(jobIds);
    if (!data.poleCount) {
      await messageSheet('Nothing to export', 'There are no started poles in this job yet.');
      return;
    }
    const progress = (done, total) => setBusyText(total ? 'Adding photos: ' + done + ' of ' + total : 'Almost done.');
    setBusyText(data.photoCount ? 'Adding photos.' : 'Almost done.');
    built = kind === 'package' ? await buildPackageFile(data, progress) : await buildPdfFile(data, progress);
  } catch (error) {
    console.error(error);
    await messageSheet('The file could not be built', [friendly(error), 'Nothing was lost. Your poles are still on this phone.']);
    return;
  }
  const seenAt = data.seenAt;
  offerFile(built.file, {
    title: 'File is ready',
    notes: [...photoWarning(built.missingPhotos), ...saveWarning()],
    takenMessage: 'Marked as exported',
    onTaken: async () => {
      for (const jobId of Object.keys(seenAt)) store.markExported(jobId, seenAt[jobId]);
      await store.flush().catch(() => {});
    },
  });
}

/** Starts an export of the given jobs by asking which kind of file is wanted. */
export function startExport(jobIds) {
  const data = collectExport(jobIds);
  if (!data.poleCount) {
    messageSheet('Nothing to export', 'There are no started poles yet.');
    return;
  }
  const what = plural(data.poleCount, 'pole') + (data.photoCount ? ' and ' + plural(data.photoCount, 'photo') : '');
  openSheet(
    html`<h2>Export ${what}</h2>
      <button type="button" class="card" data-sheet="pdf" data-autofocus>
        <div class="name">PDF report</div>
        <div class="sub">One page per pole with every answer and its photos. Easy to read, print or email.</div>
      </button>
      <button type="button" class="card" data-sheet="package">
        <div class="name">Full package (ZIP)</div>
        <div class="sub">The PDF report, the data for other programs, and every photo at full size. Larger.</div>
      </button>
      <button type="button" class="btn ghost" data-sheet="cancel">Cancel</button>`,
    {
      label: 'Export',
      onClose: (value) => {
        if (value === 'pdf' || value === 'package') runExport(jobIds, value);
      },
    },
  );
}

/** Builds a backup of everything and offers it. */
export async function startBackup() {
  busySheet('Building the backup', 'Getting ready.');
  let built;
  const madeAt = Date.now();
  try {
    await settle();
    built = await buildBackupFile((done, total) => setBusyText('Adding photos: ' + done + ' of ' + total));
  } catch (error) {
    console.error(error);
    await messageSheet('The backup could not be built', [friendly(error), 'Nothing was lost. Your poles are still on this phone.']);
    return;
  }
  offerFile(built.file, {
    title: 'Backup is ready',
    notes: [...photoWarning(built.missingPhotos), ...saveWarning()],
    takenMessage: 'Backup saved',
    onTaken: async () => {
      store.setSetting('lastBackupAt', madeAt);
      await store.flush().catch(() => {});
    },
  });
}
