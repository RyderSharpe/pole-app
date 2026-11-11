// Problems found by the second independent review, each acted out the way it was found.
// Screens: slips of the finger on sheets, the Back button and sheets, the way back from the
// "Before you save" list, taps near the step bar, focus, long jobs, narrow screens.
// Data: removing for good while saves fail, a resumed copy from the first version, impossible
// numbers and odd text in the PDF report, moving tabs while photos are stored, a clock far ahead, an
// export confirmed while saves fail, and a photo saved by a tab that had stepped aside.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { startJob, gotoStep, answer, savePole } from './harness.mjs';
import { ZipWriter } from '../../src/zip.js';

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;

// Taps with a fingertip at a point, without the test finger's usual wait for the slip guard.
const center = (page, selector) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);

// Every save fails while localStorage "failSaves" is "1". Deletes still work, as on a full phone.
const FAILING_PUTS = () => {
  const real = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function put(...args) {
    if (localStorage.getItem('failSaves') === '1') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return real.apply(this, args);
  };
};

const SLOW_PICTURES = () => {
  const real = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function slow(callback, ...rest) {
    const delay = Number(sessionStorage.getItem('photoDelay') || 0);
    return real.call(this, (blob) => (delay ? setTimeout(() => callback(blob), delay) : callback(blob)), ...rest);
  };
};

const SHIFTED_CLOCK = () => {
  const real = Date.now.bind(Date);
  const RealDate = Date;
  const offset = () => Number(sessionStorage.getItem('clockOffset') || 0);
  window.Date = new Proxy(RealDate, {
    construct(target, args) {
      return args.length ? new target(...args) : new target(real() + offset());
    },
  });
  window.Date.now = () => real() + offset();
};

// Keeps every close watcher the app makes, so a test can send it what Android's Back sends.
const WATCHERS = () => {
  window.__watchers = [];
  if (typeof window.CloseWatcher !== 'function') return;
  const Real = window.CloseWatcher;
  window.CloseWatcher = class extends Real {
    constructor(...args) {
      super(...args);
      window.__watchers.push(this);
    }
  };
};

/** A backup file built from records, with one small picture in three sizes for each photo. */
async function backupFile(h, name, records) {
  const thumb = await h.readFile(h.path.join(h.images, 'camera-thumb.jpg'));
  const zip = new ZipWriter();
  for (const photo of records.photos || []) for (const size of ['full', 'mid', 'thumb']) zip.add('photos/' + photo.id + '.' + size + '.jpg', thumb);
  zip.add(
    'backup.json',
    JSON.stringify({ format: 'polefield-backup', formatVersion: 1, app: 'Pole Field Data', appVersion: '0.2.0', madeAt: new Date().toISOString(), jobs: records.jobs, poles: records.poles || [], photos: records.photos || [], settings: {} }),
  );
  const file = h.path.join(h.tmp, name);
  await h.writeFile(file, Buffer.from(await zip.finish().arrayBuffer()));
  return file;
}

async function restoreFile(h, page, file) {
  if (!(await h.count(page, '#backup-file'))) {
    await page.evaluate(() => {
      location.hash = '#/settings';
    });
    await page.waitForSelector('#backup-file', { state: 'attached' });
  }
  await page.setInputFiles('#backup-file', file);
  await h.tap(page, '#modal [data-sheet="yes"]');
  await page.waitForSelector('#modal [data-sheet="ok"]', { timeout: 60000 });
  const message = await h.text(page, '#modal');
  await h.tap(page, '#modal [data-sheet="ok"]');
  return message;
}

const counts = (stored) => [stored.jobs.length, stored.poles.length, stored.photos.length, stored.blobs.length];

export default [
  {
    name: 'sheet-slips',
    title: 'A second tap a moment later cannot answer a sheet: download, delete forever, delete pole',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Slip Rd' });
      await answer(h, page, { tagField: 'S-1' });
      await savePole(h, page);

      // 1. "Download the file", and the same spot 0.6 s later: the job must not be marked exported.
      await h.tap(page, '[data-act="export-job"]');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      await h.pause(page, 1100);
      const spot = await center(page, '#modal [data-act="file-download"]');
      const began = Date.now();
      const download = page.waitForEvent('download', { timeout: 15000 });
      await page.touchscreen.tap(spot.x, spot.y);
      await download;
      await page.waitForSelector('#modal [data-act="file-saved-yes"]');
      assert.notDeepEqual(await center(page, '#modal [data-act="file-saved-yes"]'), spot, '"Yes, I have the file" is not where "Download" was');
      await h.pause(page, Math.max(0, 600 - (Date.now() - began)));
      await page.touchscreen.tap(spot.x, spot.y);
      await h.pause(page, 400);
      assert.notEqual(await h.text(page, '.top .pill'), 'Exported', 'a second tap did not mark the job exported');
      assert.ok(await h.count(page, '#modal [data-act="file-saved-yes"], #modal [data-act="file-download"]'), 'the question is still open');
      if (await h.count(page, '#modal [data-act="file-saved-yes"]')) {
        await h.tap(page, '#modal [data-act="file-saved-yes"]');
        await page.waitForFunction(() => document.querySelector('.top .pill').textContent === 'Exported', null, { timeout: 5000 });
      } else {
        await h.tap(page, '#modal [data-sheet="close"]');
      }

      // 2. "Delete this pole", and the same spot 0.6 s later: the pole must still be there.
      await h.tap(page, '[data-act="open-pole"]');
      await gotoStep(h, page, 'photos');
      await page.locator('[data-act="pole-delete"]').scrollIntoViewIfNeeded();
      await h.pause(page, 800);
      const deleteSpot = await center(page, '[data-act="pole-delete"]');
      await page.touchscreen.tap(deleteSpot.x, deleteSpot.y);
      await page.waitForSelector('#modal [data-sheet="yes"]');
      await h.pause(page, 450);
      await page.touchscreen.tap(deleteSpot.x, deleteSpot.y);
      await h.pause(page, 400);
      assert.ok(await h.count(page, '#modal [data-sheet="yes"]'), 'the question is still open');
      await h.tap(page, '#modal [data-sheet="no"]');
      assert.equal((await h.stored(page)).poles.filter((p) => !p.deletedAt).length, 1, 'the pole was not deleted');

      // 3. Recently deleted, "Delete forever", and the same spot 0.6 s later: the item stays.
      await h.tap(page, '[data-act="pole-delete"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('[data-act="add-pole"]');
      await page.evaluate(() => {
        location.hash = '#/trash';
      });
      await page.waitForSelector('[data-act="trash-forever"]');
      await h.pause(page, 800);
      const foreverSpot = await center(page, '[data-act="trash-forever"]');
      await page.touchscreen.tap(foreverSpot.x, foreverSpot.y);
      await page.waitForSelector('#modal [data-sheet="yes"]');
      await h.pause(page, 450);
      await page.touchscreen.tap(foreverSpot.x, foreverSpot.y);
      await h.pause(page, 400);
      assert.ok(await h.count(page, '#modal [data-sheet="yes"]'), 'the question is still open');
      await h.tap(page, '#modal [data-sheet="no"]');
      assert.equal(await h.count(page, '[data-trash]'), 1, 'nothing was deleted for good');
      h.clean(page);
    },
  },

  {
    name: 'back-closes-sheet',
    title: "Android's Back closes an open sheet and stays on the screen; a sheet that must be answered stays",
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [WATCHERS] });
      await h.open(page, site.url);
      assert.ok(await page.evaluate(() => typeof window.CloseWatcher === 'function'), 'this browser has close watchers');
      await startJob(h, page, { location: 'Back Ln' });
      await answer(h, page, { tagField: 'BK-1' });
      await savePole(h, page);
      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('[data-act="export-all"]');
      const before = await page.evaluate(() => location.hash);

      await h.tap(page, '[data-act="export-all"]');
      await page.waitForSelector('#modal .sheet');
      await page.evaluate(() => window.__watchers[window.__watchers.length - 1].requestClose());
      await page.waitForFunction(() => !document.querySelector('#modal .sheet'));
      assert.equal(await page.evaluate(() => location.hash), before, 'still on the job list');
      assert.ok(await h.count(page, '[data-act="new-job"]'));

      // "Did the file save?" must be answered. Back leaves it open.
      await h.tap(page, '[data-act="export-all"]');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
      await page.waitForSelector('#modal [data-act="file-saved-yes"]');
      const made = await page.evaluate(() => window.__watchers.length);
      await page.evaluate(() => window.__watchers[window.__watchers.length - 1].requestClose());
      await h.pause(page, 300);
      assert.ok(await h.count(page, '#modal [data-act="file-saved-yes"]'), 'the question is still there');
      assert.ok((await page.evaluate(() => window.__watchers.length)) > made, 'the next Back press is caught again');
      await h.tap(page, '#modal [data-act="file-saved-no"]');
      await h.tap(page, '#modal [data-sheet="close"]');
      assert.notEqual(await h.text(page, '[data-act="open-job"] .pill'), 'Exported');
      h.clean(page);
    },
  },

  {
    name: 'back-to-the-list',
    title: 'After a jump from the "Before you save" list, the back arrow returns to the list',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'List St' });
      await answer(h, page, { tagField: 'L-1' });
      await gotoStep(h, page, 'photos');
      await h.tap(page, '[data-act="review-goto"][data-step="equipment"]');
      await page.waitForFunction(() => location.hash.endsWith('/equipment'));
      assert.equal(await page.getAttribute('[data-act="step-back"]', 'aria-label'), 'Back to the list');
      await h.tap(page, '[data-act="step-back"]');
      await page.waitForFunction(() => location.hash.endsWith('/photos'));
      assert.ok(await h.count(page, '[data-act="review-goto"]'), 'the list is back on screen');
      // Elsewhere the arrow keeps its usual meaning.
      assert.equal(await page.getAttribute('[data-act="step-back"]', 'aria-label'), 'Back to Spans');
      await gotoStep(h, page, 'equipment');
      assert.equal(await page.getAttribute('[data-act="step-back"]', 'aria-label'), 'Back to Pole');
      h.clean(page);
    },
  },

  {
    name: 'step-title-tap',
    title: 'A tap on the step title or the save status does not change the step',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Title Tap' });
      await gotoStep(h, page, 'heights');
      const title = await page.locator('h1[data-heading]').boundingBox();
      const status = await page.locator('[data-save-status]').boundingBox();
      const bar = await page.locator('.progress button').first().boundingBox();
      assert.ok(bar.y + bar.height <= title.y + 0.5, 'the step targets end above the title');
      for (const [x, y] of [
        [title.x + 12, title.y + title.height / 2],
        [title.x + title.width / 2, title.y + title.height / 2],
        [status.x + status.width / 2, status.y + status.height / 2],
      ]) {
        await h.pause(page, 800);
        await page.touchscreen.tap(x, y);
        await h.pause(page, 300);
        assert.ok(await page.evaluate(() => location.hash.endsWith('/heights')), 'still on the same step after a tap at ' + Math.round(x) + ',' + Math.round(y));
      }
      h.clean(page);
    },
  },

  {
    name: 'focus-kept',
    title: 'Focus stays somewhere sensible after deleting a photo and after "Bring back"',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Focus Ave' });
      await answer(h, page, { tagField: 'F-1' });
      await gotoStep(h, page, 'photos');
      await page.setInputFiles('#lib', ['landscape.jpg', 'portrait.jpg'].map((n) => h.path.join(h.images, n)));
      await page.waitForFunction(() => document.querySelectorAll('[data-part="photos"] [data-act="photo-open"]').length === 2);
      const focused = () => page.evaluate(() => [document.activeElement.getAttribute('data-act'), document.activeElement.getAttribute('data-id')]);
      const ids = await page.locator('[data-part="photos"] [data-act="photo-open"]').evaluateAll((list) => list.map((b) => b.getAttribute('data-id')));

      await h.tap(page, page.locator('[data-act="photo-open"]').first());
      await h.tap(page, '#modal [data-act="photo-delete"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      assert.deepEqual(await focused(), ['photo-open', ids[1]], 'focus moves to the photo that took its place');
      await h.pause(page, 300);
      await h.tap(page, '[data-act="photo-open"]');
      await h.tap(page, '#modal [data-act="photo-delete"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      assert.deepEqual(await focused(), ['photo-take', null], 'with no photo left, focus moves to "Take photo"');

      // Recently deleted: after "Bring back" focus moves to the next card.
      await page.evaluate(() => {
        location.hash = '#/trash';
      });
      await page.waitForFunction(() => document.querySelectorAll('[data-trash]').length === 2);
      await h.tap(page, page.locator('[data-act="trash-restore"]').first());
      await page.waitForFunction(() => document.querySelectorAll('[data-trash]').length === 1);
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-act')), 'trash-restore');
      await h.tap(page, '[data-act="trash-restore"]');
      await page.waitForSelector('.empty');
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-heading')), true, 'with nothing left, focus moves to the heading');
      h.clean(page);
    },
  },

  {
    name: 'long-job-reach',
    title: 'On a long job "Add pole" is always in reach, and the Undo toast never covers it',
    async run(h) {
      const site = await h.site();
      const now = Date.now() - 60000;
      const job = { id: 'long-job', f: { location: 'Twelve Poles Rd', date: '2026-10-20', designNo: 'DES-2026-0042-LONG' }, createdAt: now, updatedAt: now, exportedAt: 0 };
      const poles = Array.from({ length: 12 }, (_, i) => ({ id: 'lp-' + i, jobId: job.id, f: { tagField: 'T' + (100 + i) }, gps: null, done: true, createdAt: now + i, updatedAt: now + i }));
      const file = await backupFile(h, 'twelve.zip', { jobs: [job], poles });
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
        const { page, context } = await h.phone({ viewport });
        await h.open(page, site.url);
        await restoreFile(h, page, file);
        await page.evaluate(() => {
          location.hash = '#/job/long-job';
        });
        await page.waitForSelector('[data-act="add-pole"]');
        const inView = () =>
          page.evaluate(() => {
            const r = document.querySelector('[data-act="add-pole"]').getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight;
          });
        if (viewport.height > 520) assert.ok(await inView(), '"Add pole" is on screen without scrolling');
        assert.equal(await h.count(page, '[data-act="open-pole"]'), 12);

        // Delete a pole, then scroll to the end while the Undo toast shows.
        await h.tap(page, page.locator('[data-act="open-pole"]').nth(3));
        await gotoStep(h, page, 'photos');
        await h.tap(page, '[data-act="pole-delete"]');
        await h.tap(page, '#modal [data-sheet="yes"]');
        await page.waitForSelector('[data-act="add-pole"]');
        await page.waitForSelector('#toast [data-toast-action]');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await h.pause(page, 300);
        const overlap = await page.evaluate(() => {
          const a = document.querySelector('#toast .toast-in').getBoundingClientRect();
          const b = document.querySelector('[data-act="add-pole"]').getBoundingClientRect();
          return !(a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left);
        });
        assert.equal(overlap, false, 'the toast does not cover "Add pole" (' + viewport.width + ' px wide)');
        // The design number is shown in full on the job list.
        await page.evaluate(() => {
          location.hash = '#/';
        });
        await page.waitForSelector('[data-act="open-job"] .code');
        const code = await page.locator('[data-act="open-job"] .code').evaluate((el) => ({ text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1 }));
        assert.deepEqual(code, { text: 'DES-2026-0042-LONG', clipped: false });
        h.clean(page);
        await h.closeContext(context);
      }
    },
  },

  {
    name: 'narrow-screens',
    title: 'Long answers stay on one line, and a zoomed screen never scrolls sideways',
    async run(h) {
      const site = await h.site();
      for (const width of [260, 320, 360, 390]) {
        const { page, context } = await h.phone({ viewport: { width, height: 700 } });
        await h.open(page, site.url);
        await startJob(h, page, { location: 'Narrow' });
        await answer(h, page, { condition: ['Questionable'] });
        const lines = await page.locator('[data-choice="condition"][data-v="Questionable"]').evaluate((button) => {
          const range = document.createRange();
          range.selectNodeContents(button);
          return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
        });
        if (width >= 320) assert.equal(lines, 1, '"Questionable" on one line at ' + width + ' px');
        assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= width, 'no sideways scroll at ' + width + ' px');
        h.clean(page);
        await h.closeContext(context);
      }
    },
  },

  {
    name: 'quiet-status-and-names',
    title: 'The save status is not read out at every pause, and the name box has a plain name',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Quiet' });
      for (const screen of ['', '#/', '#/job/' + (await h.stored(page)).jobs[0].id, '#/settings']) {
        if (screen) {
          await page.evaluate((to) => {
            location.hash = to;
          }, screen);
          await page.waitForFunction((to) => location.hash === to, screen);
          await page.waitForSelector('#app [data-heading]');
        }
        assert.ok(await h.count(page, '[data-save-status]'), 'the save status is shown on ' + (screen || 'the pole'));
        assert.equal(await h.count(page, '[data-save-status][role], [data-save-status][aria-live]'), 0, 'and is not read out at every change on ' + (screen || 'the pole'));
      }
      assert.equal(await page.getByRole('textbox', { name: 'Your name', exact: true }).count(), 1);
      h.clean(page);
    },
  },

  {
    name: 'purge-while-failing',
    title: '"Delete forever" while saves fail: the job stays gone after a restart, and "Not saved" clears',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [FAILING_PUTS] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Purge Lane' });
      await answer(h, page, { tagField: 'PURGE-ME' });
      await savePole(h, page);
      await h.saved(page);
      const jobId = (await h.stored(page)).jobs[0].id;
      await page.evaluate(() => localStorage.setItem('failSaves', '1'));
      await h.tap(page, '[data-act="delete-job"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('.save-status.is-error');
      await page.evaluate(() => {
        location.hash = '#/trash';
      });
      await h.tap(page, '[data-act="trash-forever"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('.empty');
      await h.saved(page);
      const journals = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('.journal.')).map((key) => localStorage.getItem(key)).join(''));
      assert.ok(!journals.includes(jobId), 'the journal no longer holds the job');
      await page.evaluate(() => localStorage.setItem('failSaves', '0'));
      await page.reload();
      await page.waitForSelector('#app [data-heading]');
      await h.pause(page, 500);
      assert.ok(!(await h.stored(page)).jobs.some((job) => job.id === jobId), 'the job did not come back');
      h.clean(page, ['QuotaExceededError', 'quota has been exceeded']);
    },
  },

  {
    name: 'first-version-renamed-pole',
    title: 'A resumed copy from the first version finds a renamed pole even after the job it clashed with is gone',
    async run(h) {
      const site = await h.site();
      const NO_ROOM_FOR_PICTURES = () => {
        const real = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function put(...args) {
          if (this.name === 'blobs' && sessionStorage.getItem('full') === '1') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          return real.apply(this, args);
        };
      };
      const { page } = await h.phone({ initScripts: [NO_ROOM_FOR_PICTURES] });
      await page.goto(site.url + 'fonts/LICENSE-IBM-Plex-Sans.txt');
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        canvas.getContext('2d').fillRect(0, 0, 640, 480);
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.8));
        const db = await new Promise((resolve, reject) => {
          const rq = indexedDB.open('polefield', 1);
          rq.onupgradeneeded = () => {
            rq.result.createObjectStore('jobs', { keyPath: 'id' });
            rq.result.createObjectStore('photos', { keyPath: 'id' });
          };
          rq.onsuccess = () => resolve(rq.result);
          rq.onerror = () => reject(rq.error);
        });
        await new Promise((resolve, reject) => {
          const t = db.transaction(['jobs', 'photos'], 'readwrite');
          const when = Date.now() - 3 * 86400000;
          // Two copies of a job in the first version: the same pole id in both.
          t.objectStore('jobs').put({ id: 'old-job-1', location: 'First copy', createdAt: when, updatedAt: when, exportedAt: 0, poles: [{ id: 'dup-pole', done: true, photoIds: ['pa'], f: { tagField: 'A1' } }] });
          t.objectStore('jobs').put({ id: 'old-job-2', location: 'Second copy', createdAt: when + 1, updatedAt: when + 1, exportedAt: 0, poles: [{ id: 'dup-pole', done: true, photoIds: ['pb1', 'pb2'], f: { tagField: 'B1' } }] });
          for (const [id, jobId] of [['pa', 'old-job-1'], ['pb1', 'old-job-2'], ['pb2', 'old-job-2']]) t.objectStore('photos').put({ id, jobId, poleId: 'dup-pole', blob, w: 640, h: 480, createdAt: when });
          t.oncomplete = resolve;
          t.onabort = () => reject(t.error);
        });
        db.close();
        sessionStorage.setItem('full', '1');
      });
      await h.open(page, site.url);
      await page.waitForSelector('#modal .sheet');
      await h.tap(page, '#modal [data-sheet="ok"]');
      await h.saved(page);
      assert.deepEqual((await h.stored(page)).poles.map((p) => p.id).sort(), ['dup-pole', 'v1-old-job-2-1']);

      // The first copy is deleted for good. Then there is room again.
      await page.evaluate(() => {
        location.hash = '#/job/old-job-1';
      });
      await h.tap(page, '[data-act="delete-job"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.evaluate(() => {
        location.hash = '#/trash';
      });
      await h.tap(page, '[data-act="trash-forever"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('.empty');
      await h.saved(page);
      await page.evaluate(() => sessionStorage.setItem('full', '0'));
      await page.reload();
      await page.waitForSelector('#app [data-heading]');
      await h.saved(page);
      const stored = await h.stored(page);
      assert.deepEqual(stored.photos.map((p) => p.id + '@' + p.poleId).sort(), ['pb1@v1-old-job-2-1', 'pb2@v1-old-job-2-1']);
      assert.equal(stored.meta.find((m) => m.key === 'settings').value.legacyPhotosLeft, false);
      h.clean(page);
    },
  },

  {
    name: 'pdf-values',
    title: 'Impossible numbers, accents, brackets and emoji cannot spoil a PDF report',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Île-à-la-Crosse (old road) \\ 5°', designNo: 'ÉSC-1' });
      await answer(h, page, { tagField: 'T-\u{1F600}-1', poleClass: 'class (3) \\ €' });
      await savePole(h, page);
      const now = Date.now() - 60000;
      const big = '1' + '0'.repeat(308);
      const file = await backupFile(h, 'huge.zip', {
        jobs: [{ id: 'job-inf', f: { location: 'Huge Numbers Rd' }, createdAt: now, updatedAt: now, exportedAt: 0 }],
        poles: [{ id: 'pole-inf', jobId: 'job-inf', f: { tagField: 'INF-1', gP: big, gN: '-' + big }, gps: null, done: true, createdAt: now, updatedAt: now }],
      });
      await restoreFile(h, page, file);
      await page.evaluate(() => {
        location.hash = '#/pole/pole-inf/heights';
      });
      await page.waitForSelector('.seps');
      assert.ok(!(await h.text(page, '.seps')).includes('Infinity'), 'the screen says "check entry", not "Infinity"');
      await page.evaluate(() => {
        location.hash = '#/';
      });
      await h.tap(page, '[data-act="export-all"]');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      const pdf = await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
      await h.tap(page, '#modal [data-act="file-saved-yes"]');
      const doc = await h.pdf(pdf.path);
      const all = doc.pages.map((p) => p.text).join(' ');
      assert.ok(all.includes('Île-à-la-Crosse (old road) \\ 5°'), 'accents, brackets and a backslash print as typed');
      assert.ok(all.includes('ÉSC-1') && all.includes('class (3) \\ €'));
      assert.ok(all.includes('T-?-1'), 'an emoji, which the PDF fonts do not have, prints as a question mark');
      assert.ok(!/Infinity|NaN/.test(all), 'no impossible number in the file');
      assert.ok(all.includes('check entry'));
      h.clean(page);
    },
  },

  {
    name: 'take-over-waits-for-photos',
    title: '"Use it here" while the other tab is still storing photos waits for them',
    async run(h) {
      const site = await h.site();
      const { page: first, context } = await h.phone({ initScripts: [SLOW_PICTURES] });
      await h.open(first, site.url);
      await startJob(h, first, { location: 'Photo hand-over' });
      await answer(h, first, { tagField: 'PH-1' });
      await gotoStep(h, first, 'photos');
      await h.saved(first);
      await first.evaluate(() => sessionStorage.setItem('photoDelay', '1200')); // about 3.6 s a photo
      await first.setInputFiles('#lib', ['landscape.jpg', 'portrait.jpg', 'small.jpg'].map((n) => h.path.join(h.images, n)));
      await first.waitForSelector('.photo.busy');
      const second = await h.newPage(context);
      await second.goto(site.url);
      await second.waitForSelector('[data-act="take-over"]', { timeout: 15000 });
      await h.tap(second, '[data-act="take-over"]');
      await second.waitForSelector('[data-act="open-job"]', { timeout: 60000 });
      const stored = await h.stored(second);
      assert.deepEqual([stored.photos.length, stored.blobs.length], [3, 9], 'every chosen photo was stored before the move');
      assert.match(await h.text(second, '[data-act="open-job"]'), /1 pole/);
      assert.match(await h.text(first, '.banner.bad'), /Moved to another tab/);
      h.clean(second);
    },
  },

  {
    name: 'clock-ahead-clean-up',
    title: 'One start with the date far ahead does not empty Recently deleted',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [SHIFTED_CLOCK] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Deleted a minute ago' });
      await answer(h, page, { tagField: 'CLK-1' });
      await savePole(h, page);
      await h.tap(page, '[data-act="delete-job"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('[data-act="new-job"]');
      await h.saved(page);
      await page.evaluate((ms) => sessionStorage.setItem('clockOffset', String(ms)), 40 * DAY);
      await page.reload();
      await page.waitForSelector('#app [data-heading]');
      await h.pause(page, 500);
      await page.evaluate(() => sessionStorage.setItem('clockOffset', '0'));
      await page.reload();
      await page.waitForSelector('#app [data-heading]');
      await h.pause(page, 500);
      assert.deepEqual(counts(await h.stored(page)).slice(0, 2), [1, 1], 'the job and its pole are still in Recently deleted');
      h.clean(page);
    },
  },

  {
    name: 'export-mark-while-failing',
    title: 'An export confirmed while saves fail is still marked after a restart',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [FAILING_PUTS] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Full phone export' });
      await answer(h, page, { tagField: 'FP-1' });
      await savePole(h, page);
      await h.saved(page);
      await page.evaluate(() => localStorage.setItem('failSaves', '1'));
      await h.tap(page, '[data-act="export-job"]');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
      await h.tap(page, '#modal [data-act="file-saved-yes"]');
      await page.waitForFunction(() => document.querySelector('.top .pill').textContent === 'Exported', null, { timeout: 5000 });
      await page.evaluate(() => localStorage.setItem('failSaves', '0'));
      await page.reload();
      await page.waitForSelector('#app [data-heading]');
      await page.evaluate(() => {
        location.hash = '#/';
      });
      await page.waitForSelector('[data-act="open-job"]');
      assert.equal(await h.text(page, '[data-act="open-job"] .pill'), 'Exported');
      h.clean(page, ['QuotaExceededError', 'quota has been exceeded']);
    },
  },

  {
    name: 'woken-tab-photo',
    title: 'A photo saved by a tab that stepped aside shows up in the tab in charge once it announces itself',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Late photo' });
      await answer(h, page, { tagField: 'LP-1' });
      await savePole(h, page);
      await h.saved(page);
      const pole = (await h.stored(page)).poles[0];
      // What a frozen tab does when it wakes: a photo goes straight into the database, then the
      // tab tells the others that it has written its journal.
      const picture = [...(await h.readFile(h.path.join(h.images, 'camera-thumb.jpg')))];
      await page.evaluate(
        async ([poleId, jobId, bytes]) => {
          const data = new Uint8Array(bytes).buffer;
          const db = await new Promise((resolve, reject) => {
            const rq = indexedDB.open('polefield@/');
            rq.onsuccess = () => resolve(rq.result);
            rq.onerror = () => reject(rq.error);
          });
          await new Promise((resolve, reject) => {
            const t = db.transaction(['photos', 'blobs'], 'readwrite');
            const now = Date.now();
            for (const size of ['full', 'mid', 'thumb']) t.objectStore('blobs').put({ key: 'late-photo:' + size, photoId: 'late-photo', size, type: 'image/jpeg', data });
            t.objectStore('photos').put({ id: 'late-photo', poleId, jobId, label: '', w: 320, h: 240, bytes: data.byteLength, createdAt: now, updatedAt: now });
            t.oncomplete = resolve;
            t.onabort = () => reject(t.error);
          });
          db.close();
          new BroadcastChannel('polefield@/').postMessage({ type: 'journal' });
        },
        [pole.id, pole.jobId, picture],
      );
      await page.waitForFunction(() => /1 photo/.test(document.querySelector('[data-act="open-pole"]').innerText), null, { timeout: 5000 });
      h.clean(page);
    },
  },
];
