// The things that must never go wrong: lost entries, two tabs, deletes, backups and hostile input.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startJob, gotoStep, answer, savePole } from './harness.mjs';

const run = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;

// Lets a test make the phone refuse every save, the way a full phone does.
const FAILING_SAVES = () => {
  const real = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function put(...args) {
    if (window.__failSaves) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return real.apply(this, args);
  };
};

async function thumbs(page, count) {
  await page.waitForFunction((wanted) => {
    const images = [...document.querySelectorAll('[data-part="photos"] img[data-thumb]')];
    return images.length === wanted && images.every((image) => image.complete && image.naturalWidth > 0);
  }, count, { timeout: 20000 });
}

const journals = (page) => page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('.journal.')).map((key) => JSON.parse(localStorage.getItem(key))));

// Changes records in the phone's database directly, behind the app's back.
// work is a function (stores, DAY) => {...}. It is sent to the page as text and run there.
const tamper = (page, work) =>
  page.evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('polefield@/');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const t = db.transaction(['jobs', 'poles', 'photos', 'blobs'], 'readwrite');
      (${work.toString()})({ jobs: t.objectStore('jobs'), poles: t.objectStore('poles'), photos: t.objectStore('photos'), blobs: t.objectStore('blobs') }, ${DAY});
      t.oncomplete = resolve;
      t.onabort = () => reject(t.error);
    });
    db.close();
  })()`);

// A job with two poles and three photos: one photo and one pole in "Recently deleted".
async function backupJob(h, page) {
  await startJob(h, page, { location: 'Backup Blvd', designNo: 'BK-1', collectedBy: 'R. Sharpe' });
  await answer(h, page, { tagField: 'K-1', height: '40' });
  await gotoStep(h, page, 'photos');
  await page.setInputFiles('#lib', ['landscape.jpg', 'portrait.jpg'].map((name) => h.path.join(h.images, name)));
  await thumbs(page, 2);
  await h.tap(page, page.locator('[data-act="photo-open"]').first());
  await h.tap(page, '#modal [data-act="photo-label"][data-label="Whole pole"]');
  await h.tap(page, '#modal [data-sheet="done"]');
  await h.tap(page, page.locator('[data-act="photo-open"]').nth(1));
  await h.tap(page, '#modal [data-act="photo-delete"]');
  await h.tap(page, '#modal [data-sheet="yes"]');
  await h.tap(page, '[data-act="step-next"]');
  await page.waitForSelector('[data-act="add-pole"]');
  await h.tap(page, '[data-act="add-pole"]');
  await answer(h, page, { tagField: 'K-2' });
  await gotoStep(h, page, 'photos');
  await page.setInputFiles('#lib', h.path.join(h.images, 'small.jpg'));
  await thumbs(page, 1);
  await h.tap(page, '[data-act="step-next"]');
  await page.waitForSelector('[data-act="add-pole"]');
  await h.tap(page, '[data-act="add-pole"]');
  await answer(h, page, { tagField: 'K-3-deleted' });
  await gotoStep(h, page, 'photos');
  await h.tap(page, '[data-act="pole-delete"]');
  await h.tap(page, '#modal [data-sheet="yes"]');
  await page.waitForSelector('[data-act="add-pole"]');
  assert.equal(await h.count(page, '[data-act="open-pole"]'), 2);
  await h.saved(page);
}

async function makeBackup(h, page) {
  await h.tap(page, '[data-act="backup-make"]');
  await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 120000 });
  const file = await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
  await h.tap(page, '#modal [data-act="file-saved-yes"]');
  return file;
}

async function restore(h, page, file) {
  await page.setInputFiles('#backup-file', file);
  await page.waitForSelector('#modal [data-sheet="yes"]');
  await h.tap(page, '#modal [data-sheet="yes"]');
  await page.waitForSelector('#modal [data-sheet="ok"]', { timeout: 120000 });
  const message = await h.text(page, '#modal');
  await h.tap(page, '#modal [data-sheet="ok"]');
  return message;
}

async function toSettings(h, page) {
  if (!(await h.count(page, '#set-name'))) {
    while (!(await h.count(page, '[data-act="open-settings"]'))) await h.tap(page, '[data-act="back"], [data-act="step-back"]');
    await h.tap(page, '[data-act="open-settings"]');
  }
  await page.waitForSelector('#set-name');
}

// Rewrites a backup file with Python's zipfile, so the test file is made by a different program.
async function rewriteBackup(h, source, name, script) {
  const target = h.path.join(h.tmp, name);
  const program = `
import json, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
data = json.loads(zin.read('backup.json'))
drop = set()
NOW = ${Date.now()}
DAY = ${DAY}
${script}
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
    zout.writestr('backup.json', json.dumps(data))
    for info in zin.infolist():
        if info.filename == 'backup.json' or info.filename in drop:
            continue
        zout.writestr(info.filename, zin.read(info.filename))
`;
  await run('python3', ['-c', program, source, target]);
  return target;
}

// Flips bytes inside stored entries of a ZIP, leaving the checksums as they were.
async function damage(h, source, name, match) {
  const target = h.path.join(h.tmp, name);
  const program = `
import sys, zipfile, struct
src, dst, match = sys.argv[1], sys.argv[2], sys.argv[3]
raw = bytearray(open(src, 'rb').read())
hits = 0
for info in zipfile.ZipFile(src).infolist():
    if match in info.filename:
        name_len, extra_len = struct.unpack('<HH', raw[info.header_offset + 26:info.header_offset + 30])
        start = info.header_offset + 30 + name_len + extra_len
        for i in range(start + 40, start + 60):
            raw[i] ^= 0xFF
        hits += 1
open(dst, 'wb').write(raw)
print(hits)
`;
  const { stdout } = await run('python3', ['-c', program, source, target, match]);
  assert.ok(Number(stdout.trim()) > 0, 'nothing matched ' + match);
  return target;
}

export default [
  {
    name: 'refused-save',
    title: 'When the phone refuses to save: loud, honest, and nothing lost',
    async run(h) {
      const site = await h.site();
      const { page, context } = await h.phone({ initScripts: [FAILING_SAVES] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Full phone' });
      await answer(h, page, { tagField: 'F-1' });
      await h.saved(page);

      await page.evaluate(() => { window.__failSaves = true; });
      await h.fill(page, '#f-poleClass', '4');
      await page.waitForSelector('.save-status.is-error');
      assert.equal(await h.text(page, '[data-save-status]'), 'Not saved');
      assert.match(await h.text(page, '#toast'), /The phone is not saving\. Your entries are still on screen\./);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'f-poleClass', 'the keyboard is not taken away');
      let copies = await journals(page);
      assert.equal(copies.length, 1, 'a crash-proof copy is written straight away, not only when the app is hidden');
      assert.equal(copies[0].poles[0].f.poleClass, '4');

      // Keep typing: the crash-proof copy keeps up.
      await h.fill(page, '#f-poleClass', '5');
      copies = await journals(page);
      assert.equal(copies[0].poles[0].f.poleClass, '5');

      // Leaving the field brings up the banner on this screen.
      await page.locator('#f-poleClass').blur();
      await page.waitForSelector('.banner.bad');
      assert.match(await h.text(page, '.banner.bad'), /The phone is not saving[\s\S]*export now/);

      // "Save pole" does not pretend.
      await gotoStep(h, page, 'photos');
      assert.ok(await h.count(page, '.banner.bad'));
      await h.tap(page, '[data-act="step-next"]');
      await page.waitForSelector('#modal [data-sheet="ok"]');
      assert.match(await h.text(page, '#modal'), /Not saved yet[\s\S]*The phone refused to store this pole/);
      await h.tap(page, '#modal [data-sheet="ok"]');
      assert.ok(await page.evaluate(() => location.hash.endsWith('/photos')), 'still on the pole, not sent back to the job as if all were well');
      assert.doesNotMatch(await h.text(page, '#toast').catch(() => ''), /saved on this phone/);

      // A photo cannot be stored either, and says so.
      await page.setInputFiles('#lib', h.path.join(h.images, 'small.jpg'));
      await page.waitForSelector('#modal [data-sheet="ok"]');
      assert.match(await h.text(page, '#modal'), /A photo was not saved[\s\S]*out of space/);
      await h.tap(page, '#modal [data-sheet="ok"]');
      assert.equal(await h.count(page, '[data-part="photos"] [data-act="photo-open"]'), 0);

      // Every screen shows the problem.
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-act="step-back"]');
      await page.waitForSelector('[data-act="add-pole"]');
      assert.ok(await h.count(page, '.banner.bad'), 'the job screen shows the banner');
      assert.equal(await h.text(page, '[data-save-status]'), 'Not saved');
      await h.shot(page, '17-not-saving');

      // Export still works, and the file holds the entries the phone refused.
      await h.tap(page, '[data-act="export-job"]');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      assert.match(await h.text(page, '#modal'), /The phone is refusing to save right now\. This file holds everything on screen/);
      const file = await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
      await h.tap(page, '#modal [data-act="file-saved-yes"]');
      assert.equal((await h.pdf(file.path)).value(1, 'Pole class'), '5');

      // So does a backup.
      await h.tap(page, '[data-act="back"]');
      assert.ok(await h.count(page, '.banner.bad'), 'the home screen shows the banner');
      await h.tap(page, '[data-act="open-settings"]');
      assert.ok(await h.count(page, '.banner.bad'), 'Settings shows the banner');
      const backup = await makeBackup(h, page);
      const json = JSON.parse(await h.readFile(await h.unzip(backup.path, 'backup.json'), 'utf8'));
      assert.equal(json.poles[0].f.poleClass, '5');

      // "Try again" while still failing says so. Once the phone has room again, it recovers.
      await h.tap(page, '[data-act="save-retry"]');
      await page.waitForFunction(() => /Still not saving/.test(document.querySelector('#toast').textContent));
      assert.equal((await h.stored(page)).poles[0].f.poleClass, undefined, 'the database really does not have it yet');
      await page.evaluate(() => { window.__failSaves = false; });
      await h.tap(page, '[data-act="save-retry"]');
      await page.waitForFunction(() => /Saved on this phone/.test(document.querySelector('#toast').textContent));
      await page.waitForFunction(() => !document.querySelector('.banner.bad'));
      assert.equal(await h.text(page, '[data-save-status]'), 'Saved on this phone');
      assert.equal((await h.stored(page)).poles[0].f.poleClass, '5');
      assert.deepEqual(await journals(page), [], 'the crash-proof copy is cleared once the database has everything');

      // The worst case: saves are failing and the app is killed. The next start puts the entries back.
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, '[data-act="open-pole"]');
      await page.evaluate(() => { window.__failSaves = true; });
      await h.fill(page, '#f-testTreat', 'typed while the phone was full');
      await page.waitForSelector('.save-status.is-error');
      await page.close();
      const again = await h.newPage(context);
      await h.open(again, site.url);
      await h.tap(again, '[data-act="open-job"]');
      await h.tap(again, '[data-act="open-pole"]');
      assert.equal(await again.inputValue('#f-testTreat'), 'typed while the phone was full');
      await h.saved(again);
      assert.equal((await h.stored(again)).poles[0].f.testTreat, 'typed while the phone was full');
      assert.deepEqual(await journals(again), []);
      h.clean(page, ['QuotaExceededError', 'quota has been exceeded']);
      h.clean(again);
    },
  },

  {
    name: 'one-tab',
    title: 'One tab at a time: a second tab asks, takes over, and nothing is lost',
    async run(h) {
      const site = await h.site();
      const { page: first, context } = await h.phone();
      await h.open(first, site.url);
      await startJob(h, first, { location: 'Two tabs' });
      await answer(h, first, { tagField: 'T-1' });
      await h.saved(first);

      const second = await h.newPage(context);
      await second.goto(site.url);
      await second.waitForSelector('[data-act="take-over"]', { timeout: 15000 });
      assert.match(await h.text(second, '.banner.bad'), /Already open[\s\S]*another tab or window/);
      assert.equal(await h.count(second, '[data-act="new-job"]'), 0, 'the second tab shows no data it could change');
      await h.shot(second, '18-already-open');

      // Type in the first tab and take over from the second in the same breath.
      await h.fill(first, '#f-tagMap', 'TYPED-LATE');
      await h.tap(second, '[data-act="take-over"]');
      await second.waitForSelector('[data-act="open-job"]', { timeout: 15000 });
      await first.waitForSelector('[data-act="reload"]');
      assert.match(await h.text(first, '.banner.bad'), /Moved to another tab[\s\S]*Everything was saved first/);
      assert.equal(await h.count(first, '#f-tagMap'), 0, 'the first tab can no longer be typed into');
      await h.tap(second, '[data-act="open-job"]');
      await h.tap(second, '[data-act="open-pole"]');
      assert.equal(await second.inputValue('#f-tagMap'), 'TYPED-LATE', 'the last thing typed in the first tab arrived');

      // Reloading the first tab does not grab the data back by itself.
      await h.tap(first, '[data-act="reload"]');
      await first.waitForSelector('[data-act="take-over"]', { timeout: 15000 });
      assert.match(await h.text(first, '.banner.bad'), /Already open/);

      h.clean(first);
      h.clean(second);
    },
  },

  {
    name: 'one-tab-frozen',
    title: 'One tab at a time: taking over from a frozen tab keeps its unsaved entry',
    async run(h) {
      const site = await h.site();
      // In this phone, a tab can be told to stop hearing other tabs, like one frozen in the background.
      const DEAF = () => {
        const Real = window.BroadcastChannel;
        window.BroadcastChannel = class extends Real {
          constructor(name) {
            super(name);
            super.addEventListener('message', (event) => {
              if (window.__deaf) event.stopImmediatePropagation();
            });
          }
        };
      };
      const { page: first, context } = await h.phone({ initScripts: [FAILING_SAVES, DEAF] });
      await h.open(first, site.url);
      await startJob(h, first, { location: 'Frozen tab' });
      await answer(h, first, { tagField: 'Z-1' });
      await h.saved(first);

      await first.evaluate(() => {
        window.__failSaves = true;
        window.__deaf = true;
      });
      await h.fill(first, '#f-poleClass', 'UNSAVED-7');
      await first.waitForSelector('.save-status.is-error');
      assert.equal((await h.stored(first)).poles[0].f.poleClass, undefined);

      const second = await h.newPage(context);
      await second.goto(site.url);
      await second.waitForSelector('[data-act="take-over"]', { timeout: 15000 });
      const began = Date.now();
      await h.tap(second, '[data-act="take-over"]');
      await second.waitForSelector('[data-act="open-job"]', { timeout: 15000 });
      assert.ok(Date.now() - began >= 2000, 'the second tab waited for an answer before taking the data by force');
      await h.tap(second, '[data-act="open-job"]');
      await h.tap(second, '[data-act="open-pole"]');
      await second.waitForFunction(() => document.querySelector('#f-poleClass') && document.querySelector('#f-poleClass').value === 'UNSAVED-7', null, { timeout: 10000 });
      await h.saved(second);
      assert.equal((await h.stored(second)).poles[0].f.poleClass, 'UNSAVED-7', 'the entry the frozen tab could not save is now in the database');

      // The frozen tab, once it wakes, has stepped aside and cannot overwrite anything.
      await first.waitForSelector('[data-act="reload"]', { timeout: 10000 });
      assert.match(await h.text(first, '.banner.bad'), /Moved to another tab/);
      await first.evaluate(() => { window.__failSaves = false; });
      await h.fill(second, '#f-poleClass', 'NEWER-8');
      await h.saved(second);
      await h.pause(first, 4500); // long enough for the old tab's retry timer, if it were still running
      assert.equal((await h.stored(second)).poles[0].f.poleClass, 'NEWER-8', 'the old tab did not write over the newer entry');
      h.clean(first, ['QuotaExceededError', 'quota has been exceeded']);
      h.clean(second);
    },
  },

  {
    name: 'delete-and-trash',
    title: 'Deleting: Undo, Recently deleted, delete forever, and the 30-day clean-up',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await backupJob(h, page);

      // The pole deleted while building the job can be undone from Recently deleted.
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      assert.match(await h.text(page, '#app'), /2 items can still be brought back/);
      await h.tap(page, '[data-act="open-trash"]');
      assert.match(await h.text(page, '[data-trash="pole"]'), /Pole K-3-deleted[\s\S]*From Backup Blvd/);
      await h.tap(page, '[data-trash="pole"] [data-act="trash-restore"]');
      assert.equal(await h.count(page, '[data-trash="pole"]'), 0);
      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('#set-name');
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-job"]');
      assert.equal(await h.count(page, '[data-act="open-pole"]'), 3);

      // Deleting the job: asked first, back on the job list, and Undo works.
      await h.tap(page, '[data-act="delete-job"]');
      assert.match(await h.text(page, '#modal'), /Delete this job\?[\s\S]*its 3 poles[\s\S]*Recently deleted, for 30 days/);
      await h.tap(page, '#modal [data-sheet="no"]');
      assert.ok(await h.count(page, '[data-act="add-pole"]'), '"Keep it" keeps it');
      await h.tap(page, '[data-act="delete-job"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('[data-act="new-job"]');
      assert.equal(await h.count(page, '[data-act="open-job"]'), 0);
      assert.match(await h.text(page, '#toast'), /Job deleted/);
      await h.tap(page, '[data-toast-action]');
      await page.waitForSelector('[data-act="open-job"]');

      // Delete it again, then for good.
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, '[data-act="delete-job"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('[data-act="new-job"]');
      await h.saved(page);
      let stored = await h.stored(page);
      assert.deepEqual([stored.jobs.length, stored.poles.length, stored.photos.length, stored.blobs.length], [1, 3, 3, 9], 'everything is still on the phone while it can be brought back');
      await h.tap(page, '[data-act="open-settings"]');
      await h.tap(page, '[data-act="open-trash"]');
      assert.match(await h.text(page, '[data-trash="job"]'), /Backup Blvd[\s\S]*BK-1[\s\S]*3 poles[\s\S]*30 days left/);
      assert.equal(await h.count(page, '[data-trash="photo"]'), 0, 'a deleted photo inside a deleted job is not listed on its own');
      await h.tap(page, '[data-trash="job"] [data-act="trash-forever"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('.empty');
      stored = await h.stored(page);
      assert.deepEqual([stored.jobs.length, stored.poles.length, stored.photos.length, stored.blobs.length], [0, 0, 0, 0], 'delete forever removes every trace, pictures included');
      h.clean(page);

      // The clean-up at start-up: only things past their 30 days, or left without a parent, are removed.
      const clean = await h.phone();
      await h.open(clean.page, site.url);
      await backupJob(h, clean.page);
      await tamper(clean.page, (stores, DAY) => {
        const now = Date.now();
        stores.poles.openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return;
          const v = c.value;
          if (v.f.tagField === 'K-3-deleted') {
            v.deletedAt = now - 31 * DAY;
            c.update(v);
          }
          c.continue();
        };
        stores.photos.openCursor().onsuccess = (e) => {
          const c = e.target.result;
          if (!c) return;
          const v = c.value;
          if (v.deletedAt) {
            v.deletedAt = now - 29 * DAY - 23 * 60 * 60 * 1000;
            c.update(v);
          }
          c.continue();
        };
        stores.poles.put({ id: 'orphan-pole', jobId: 'no-such-job', f: { tagField: 'ORPHAN' }, gps: null, done: false, createdAt: 1, updatedAt: 1 });
        stores.photos.put({ id: 'orphan-photo', poleId: 'no-such-pole', jobId: 'no-such-job', label: '', w: 1, h: 1, bytes: 1, createdAt: 1, updatedAt: 1 });
        stores.blobs.put({ key: 'orphan-photo:full', photoId: 'orphan-photo', size: 'full', type: 'image/jpeg', data: new ArrayBuffer(8) });
        stores.blobs.put({ key: 'stray:thumb', photoId: 'stray', size: 'thumb', type: 'image/jpeg', data: new ArrayBuffer(8) });
      });
      await clean.page.reload();
      await clean.page.waitForSelector('[data-act="add-pole"]');
      await h.saved(clean.page);
      stored = await h.stored(clean.page);
      assert.deepEqual(stored.poles.map((pole) => pole.f.tagField).sort(), ['K-1', 'K-2'], 'the pole past its 30 days and the pole with no job are gone');
      assert.equal(stored.photos.length, 3, 'the photo deleted 29 days ago is still kept');
      assert.deepEqual([...new Set(stored.blobs.map((blob) => blob.photoId))].length, 3, 'pictures with no photo record are gone');
      await h.tap(clean.page, '[data-act="back"]');
      await h.tap(clean.page, '[data-act="open-settings"]');
      await h.tap(clean.page, '[data-act="open-trash"]');
      assert.match(await h.text(clean.page, '[data-trash="photo"]'), /Last day/);
      h.clean(clean.page);
    },
  },

  {
    name: 'backup',
    title: 'Backup: one file with everything, and "last backup" waits for a real answer',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await backupJob(h, page);
      await toSettings(h, page);
      await h.fill(page, '#set-telecom', 'Coast Tel');
      assert.equal(await h.text(page, '[data-last-backup]'), 'never');

      // Built but not taken: nothing is recorded.
      await h.tap(page, '[data-act="backup-make"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      assert.match(await h.text(page, '#modal h2'), /Backup is ready/);
      assert.match(await h.text(page, '#modal .filename'), /^Pole_Field_Data_backup_\d{4}-\d{2}-\d{2}_\d{4}\.zip$/);
      await h.tap(page, '#modal [data-sheet="close"]');
      assert.equal(await h.text(page, '[data-last-backup]'), 'never');

      const file = await makeBackup(h, page);
      assert.match(await h.text(page, '#toast'), /Backup saved/);
      assert.match(await h.text(page, '[data-last-backup]'), /^\d{4}-\d{2}-\d{2} \d\d:\d\d$/);
      await h.shot(page, '12-settings-backup');

      const zip = await h.py('zip', file.path);
      assert.equal(zip.badEntry, null);
      assert.equal(zip.entries[0].name, 'backup.json');
      const pictures = zip.entries.slice(1).map((entry) => entry.name);
      assert.equal(pictures.length, 9, 'three sizes of each of the three photos, the deleted one included');
      assert.ok(pictures.every((name) => /^photos\/[0-9a-f-]{36}\.(full|mid|thumb)\.jpg$/.test(name)));
      const data = JSON.parse(await h.readFile(await h.unzip(file.path, 'backup.json'), 'utf8'));
      assert.equal(data.format, 'polefield-backup');
      assert.equal(data.formatVersion, 1);
      assert.equal(data.appVersion, '0.4.0');
      assert.deepEqual([data.jobs.length, data.poles.length, data.photos.length], [1, 3, 3]);
      assert.equal(data.poles.filter((pole) => pole.deletedAt).length, 1);
      assert.equal(data.photos.filter((photo) => photo.deletedAt).length, 1);
      assert.deepEqual(data.settings, { collectedBy: 'R. Sharpe', tokens: { power: 'Power', telecom: 'Coast Tel' } });
      h.backupFile = file.path;
      h.clean(page);
    },
  },

  {
    name: 'restore',
    title: 'Restore: onto a new phone, twice, and after changes on the phone',
    async run(h) {
      assert.ok(h.backupFile, 'this group needs the file made by the "backup" group');
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await toSettings(h, page);

      await page.setInputFiles('#backup-file', h.backupFile);
      await page.waitForSelector('#modal [data-sheet="yes"]');
      assert.match(await h.text(page, '#modal'), /Restore from this file\?[\s\S]*Pole_Field_Data_backup_[\s\S]*Nothing on this phone is removed/);
      await h.tap(page, '#modal [data-sheet="no"]');
      assert.equal((await h.stored(page)).jobs.length, 0, 'Cancel restores nothing');

      const message = await restore(h, page, h.backupFile);
      assert.match(message, /Restore finished[\s\S]*Added: 1 job, 3 poles, 3 photos\.[\s\S]*Nothing was removed from this phone\./);
      assert.equal(await page.inputValue('#set-name'), 'R. Sharpe', 'settings that were still blank are filled in');
      assert.equal(await page.inputValue('#set-telecom'), 'Coast Tel');
      await h.saved(page);
      let stored = await h.stored(page);
      assert.deepEqual([stored.jobs.length, stored.poles.length, stored.photos.length, stored.blobs.length], [1, 3, 3, 9]);

      await h.tap(page, '[data-act="back"]');
      assert.match(await h.text(page, '[data-act="open-job"]'), /Backup Blvd[\s\S]*BK-1[\s\S]*2 of 2 poles done/);
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      assert.equal(await page.inputValue('#f-height'), '40');
      await gotoStep(h, page, 'photos');
      await thumbs(page, 1);
      assert.equal(await h.text(page, '.photo .tag'), 'Whole pole');
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      assert.match(await h.text(page, '#app'), /2 items can still be brought back/, 'Recently deleted came across too');

      // The same file again changes nothing.
      assert.match(await restore(h, page, h.backupFile), /Everything in the file was already on this phone\./);
      stored = await h.stored(page);
      assert.deepEqual([stored.jobs.length, stored.poles.length, stored.photos.length, stored.blobs.length], [1, 3, 3, 9]);

      // A newer entry made on the phone is not overwritten by the older file.
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      await h.fill(page, '#f-height', '55');
      await h.tap(page, '[data-act="step-back"]');
      // A whole job deleted on the phone comes back from the file.
      await h.tap(page, '[data-act="delete-job"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('[data-act="new-job"]');
      assert.equal(await h.count(page, '[data-act="open-job"]'), 0);
      await h.tap(page, '[data-act="open-settings"]');
      assert.match(await restore(h, page, h.backupFile), /Updated: 1 job\./);
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      assert.equal(await page.inputValue('#f-height'), '55', 'the newer entry made on this phone was kept');
      h.clean(page);
    },
  },

  {
    name: 'restore-safety',
    title: 'Restore: never deletes, survives damaged photos, refuses the wrong file',
    async run(h) {
      assert.ok(h.backupFile, 'this group needs the file made by the "backup" group');
      const site = await h.site();

      // 1. A file that says "deleted" cannot delete what is live on the phone.
      {
        const { page } = await h.phone();
        await h.open(page, site.url);
        await toSettings(h, page);
        await restore(h, page, h.backupFile);
        const file = await rewriteBackup(h, h.backupFile, 'says-deleted.zip', `
for kind in ('jobs', 'poles', 'photos'):
    for record in data[kind]:
        record['deletedAt'] = NOW - 40 * DAY
        record['updatedAt'] = NOW + 5 * DAY
`);
        assert.match(await restore(h, page, file), /Everything in the file was already on this phone\.[\s\S]*Nothing was removed/);
        await page.reload();
        await page.waitForSelector('#set-name');
        await h.tap(page, '[data-act="back"]');
        assert.equal(await h.count(page, '[data-act="open-job"]'), 1, 'the job is still there after a restart');
        const stored = await h.stored(page);
        assert.deepEqual([stored.jobs.length, stored.poles.length, stored.photos.length, stored.blobs.length], [1, 3, 3, 9]);
        assert.ok(!stored.jobs[0].deletedAt);
        h.clean(page);
      }

      // 2. One damaged photo does not stop the others, and a photo with no picture is skipped.
      {
        const { page } = await h.phone();
        await h.open(page, site.url);
        await toSettings(h, page);
        const data = JSON.parse(await h.readFile(await h.unzip(h.backupFile, 'backup.json'), 'utf8'));
        const [first, second] = data.photos.map((photo) => photo.id);
        const damaged = await damage(h, h.backupFile, 'one-damaged.zip', 'photos/' + first + '.');
        const withGap = await rewriteBackup(h, damaged, 'damaged-and-missing.zip', `
for size in ('full', 'mid', 'thumb'):
    drop.add('photos/${second}.' + size + '.jpg')
`).catch(() => null);
        // Python refuses to copy the damaged entries, so the two faults are tested in two files.
        assert.equal(withGap, null);
        let message = await restore(h, page, damaged);
        assert.match(message, /Added: 1 job, 3 poles, 2 photos\.[\s\S]*1 photo in the file was damaged and skipped\./);
        let stored = await h.stored(page);
        assert.deepEqual([stored.photos.length, stored.blobs.length], [2, 6], 'no half-stored photo is left behind');
        assert.ok(!stored.photos.some((photo) => photo.id === first));

        const missing = await rewriteBackup(h, h.backupFile, 'one-missing.zip', `
for size in ('full', 'mid', 'thumb'):
    drop.add('photos/${first}.' + size + '.jpg')
`);
        message = await restore(h, page, missing);
        assert.match(message, /1 photo had no picture in the file and was skipped\./);
        // The good file afterwards fills the gap.
        message = await restore(h, page, h.backupFile);
        assert.match(message, /Added: 1 photo\./);
        stored = await h.stored(page);
        assert.deepEqual([stored.photos.length, stored.blobs.length], [3, 9]);

        // A photo with only its small sizes left is still restored, using what there is.
        const partial = await rewriteBackup(h, h.backupFile, 'partial.zip', `
for photo in data['photos']:
    drop.add('photos/' + photo['id'] + '.full.jpg')
`);
        const fresh = await h.phone();
        await h.open(fresh.page, site.url);
        await toSettings(h, fresh.page);
        assert.match(await restore(h, fresh.page, partial), /Added: 1 job, 3 poles, 3 photos\./);
        assert.equal((await h.stored(fresh.page)).blobs.length, 6);
        h.clean(page);
        h.clean(fresh.page);
      }

      // 3. The wrong file, in every form.
      {
        const { page } = await h.phone();
        await h.open(page, site.url);
        await toSettings(h, page);
        const textFile = h.path.join(h.tmp, 'notes.zip');
        await h.writeFile(textFile, 'this is not a zip file at all, just some text that is long enough');
        assert.match(await restore(h, page, textFile), /could not be restored[\s\S]*not a ZIP file/);
        assert.match(await restore(h, page, h.path.join(h.images, 'landscape.jpg')), /could not be restored[\s\S]*not a ZIP file/);

        const noJson = await rewriteBackup(h, h.backupFile, 'no-json.zip', '').then(async (file) => {
          await run('python3', ['-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("readme.txt","hello")\nz.close()', file]);
          return file;
        });
        assert.match(await restore(h, page, noJson), /not a backup made by this app/);

        const otherFormat = await rewriteBackup(h, h.backupFile, 'other-format.zip', "data['format'] = 'something-else'");
        assert.match(await restore(h, page, otherFormat), /not a backup made by this app/);
        const newer = await rewriteBackup(h, h.backupFile, 'newer.zip', "data['formatVersion'] = 2");
        assert.match(await restore(h, page, newer), /made by a newer version of the app/);
        const broken = h.path.join(h.tmp, 'broken-json.zip');
        await run('python3', ['-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("backup.json","{not json")\nz.close()', broken]);
        assert.match(await restore(h, page, broken), /backup file is damaged/);
        const stored = await h.stored(page);
        assert.deepEqual([stored.jobs.length, stored.poles.length, stored.photos.length], [0, 0, 0], 'none of the wrong files changed anything');
        h.clean(page, ['not a ZIP file', 'not a backup', 'newer version', 'damaged']);
      }

      // 4. A file from far in the future, or from long ago.
      {
        const { page } = await h.phone();
        await h.open(page, site.url);
        await toSettings(h, page);
        const old = await rewriteBackup(h, h.backupFile, 'long-deleted.zip', `
data['jobs'][0]['deletedAt'] = NOW - 60 * DAY
`);
        assert.match(await restore(h, page, old), /Everything in the file was already on this phone/);
        assert.equal((await h.stored(page)).jobs.length, 0, 'a job deleted 60 days ago is not brought in at all');

        const future = await rewriteBackup(h, h.backupFile, 'future.zip', `
for kind in ('jobs', 'poles', 'photos'):
    for record in data[kind]:
        record['updatedAt'] = NOW + 400 * DAY
        record['createdAt'] = NOW + 400 * DAY
data['jobs'][0]['exportedAt'] = NOW + 400 * DAY
`);
        assert.match(await restore(h, page, future), /Added: 1 job/);
        await h.saved(page);
        const stored = await h.stored(page);
        const weekAhead = Date.now() + 7 * DAY + 1000;
        assert.ok(stored.jobs.every((job) => job.updatedAt <= weekAhead && job.createdAt <= weekAhead && job.exportedAt <= weekAhead), 'no time from the file is more than a week ahead');
        // An edit made now must still count as newer than the restored copy.
        await h.tap(page, '[data-act="back"]');
        assert.match(await h.text(page, '[data-act="open-job"] .pill'), /Exported/);
        await h.tap(page, '[data-act="open-job"]');
        await h.tap(page, page.locator('[data-act="open-pole"]').first());
        await h.fill(page, '#f-poleClass', '2');
        await h.tap(page, '[data-act="step-back"]');
        assert.equal(await h.text(page, '.top .pill'), 'Changed since export');
        h.clean(page);
      }
    },
  },

  {
    name: 'first-version-data',
    title: 'Data from the first version of the app is carried over, once',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      // A plain file from the same address, so the old database can be created before the app runs.
      await page.goto(site.url + 'fonts/LICENSE-IBM-Plex-Sans.txt');
      await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 600;
        const c = canvas.getContext('2d');
        c.fillStyle = '#336699';
        c.fillRect(0, 0, 800, 600);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('polefield', 1);
          request.onupgradeneeded = () => {
            request.result.createObjectStore('jobs', { keyPath: 'id' });
            request.result.createObjectStore('photos', { keyPath: 'id' });
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const t = db.transaction(['jobs', 'photos'], 'readwrite');
          const when = Date.now() - 5 * 24 * 60 * 60 * 1000;
          t.objectStore('jobs').put({
            id: 'old-job-1', location: 'Legacy Lane', date: '2026-09-01', collectedBy: 'RS', designNo: 'OLD-9', otherId: '', createdAt: when, updatedAt: when, exportedAt: 0,
            poles: [
              { id: 'old-pole-1', done: true, photoIds: ['old-photo-1', 'missing-photo'], f: { tagMap: 'L1', tagField: 'L1', bchDip: 'Yes', telusPlant: 'No', bchAnchor: 'Yes', bchSlots: '2', bchPlate: '8 ft', bchRod: '5/8', telusAnchor: 'No', telusDip: 'No', gP: '9.4', gN: '8.1', ww: true, mP: '1.2', notes: 'from the first version' } },
              { id: 'old-pole-2', done: false, photoIds: [], f: { tagField: 'L2' } },
            ],
          });
          t.objectStore('photos').put({ id: 'old-photo-1', jobId: 'old-job-1', poleId: 'old-pole-1', blob, w: 800, h: 600, createdAt: when });
          t.oncomplete = resolve;
          t.onabort = () => reject(t.error);
        });
        db.close();
      });

      await h.open(page, site.url);
      // The photo listed on the pole but missing from the old database is reported, once.
      await page.waitForSelector('#modal .sheet');
      assert.match((await h.text(page, '#modal')).replace(/\s+/g, ' '), /Copied from the first version of the app: 1 job and 1 photo\. 1 photo could not be read, so it was left out\./);
      await h.tap(page, '#modal [data-sheet="ok"]');
      await page.waitForSelector('[data-act="open-job"]');
      assert.match(await h.text(page, '[data-act="open-job"]'), /Legacy Lane[\s\S]*OLD-9[\s\S]*1 of 2 poles done[\s\S]*Waiting to export/);
      await h.tap(page, '[data-act="open-job"]');
      assert.deepEqual(await page.locator('[data-act="open-pole"] .code').allInnerTexts(), ['L1', 'L2'], 'the poles are in their old order');
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      await gotoStep(h, page, 'equipment');
      assert.equal(await page.locator('[data-choice="powerDip"].on').getAttribute('data-v'), 'Yes');
      assert.equal(await page.locator('[data-choice="telPlant"].on').getAttribute('data-v'), 'No');
      await gotoStep(h, page, 'anchors');
      assert.equal(await page.inputValue('#f-powerSlots'), '2');
      assert.equal(await page.inputValue('#f-powerRod'), '5/8');
      assert.equal(await h.text(page, '[data-item="telSlots"] .na'), 'N/A');
      await gotoStep(h, page, 'heights');
      assert.equal(await page.inputValue('#f-mP'), '1.2');
      await gotoStep(h, page, 'photos');
      await thumbs(page, 1);
      assert.equal(await page.inputValue('#f-notes'), 'from the first version');

      await h.saved(page);
      let stored = await h.stored(page);
      assert.deepEqual([stored.jobs.length, stored.poles.length, stored.photos.length, stored.blobs.length], [1, 2, 1, 3], 'the old photo was re-saved in three sizes');
      assert.deepEqual([stored.photos[0].w, stored.photos[0].h], [800, 600]);
      assert.ok(!JSON.stringify(stored.poles).includes('bch') && !JSON.stringify(stored.poles).includes('telus'), 'the old field names are gone');
      const legacy = await h.stored(page, 'polefield');
      assert.deepEqual([legacy.jobs.length, legacy.photos.length], [1, 1], 'the old database is left exactly as it was');

      // A second start does not bring it in twice or report anything again, and a job deleted for good stays deleted.
      await page.reload();
      await page.waitForSelector('#f-notes');
      await h.pause(page, 300);
      assert.equal(await h.count(page, '#modal .sheet'), 0);
      stored = await h.stored(page);
      assert.deepEqual([stored.jobs.length, stored.poles.length, stored.photos.length], [1, 2, 1]);
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="delete-job"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await h.tap(page, '[data-act="open-settings"]');
      await h.tap(page, '[data-act="open-trash"]');
      await h.tap(page, '[data-act="trash-forever"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('.empty');
      await page.reload();
      await page.waitForSelector('[data-heading]');
      await h.pause(page, 500);
      assert.equal((await h.stored(page)).jobs.length, 0);
      h.clean(page);
    },
  },

  {
    name: 'hostile-text',
    title: 'Hostile text is shown as text, everywhere, and never runs',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      const EVIL = '<img src=x onerror="window.__xss=1">"\'><script>window.__xss=1</script>';
      await h.open(page, site.url);
      await h.tap(page, '[data-act="open-settings"]');
      await h.fill(page, '#set-name', EVIL);
      await h.fill(page, '#set-power', '{power}' + EVIL);
      await h.fill(page, '#set-telecom', EVIL);
      await h.tap(page, '[data-act="back"]');

      await startJob(h, page, { location: EVIL, designNo: EVIL, otherId: '../../etc/passwd' });
      await answer(h, page, { tagMap: EVIL, tagField: EVIL + '2', poleClass: EVIL });
      assert.match(await h.text(page, '#h-tagField'), /Does not match the map tag/);
      await gotoStep(h, page, 'equipment');
      assert.ok((await h.text(page, '[data-item="powerDip"] .label')).includes('<img src=x'), 'a company name with markup in it is shown as text');
      await gotoStep(h, page, 'photos');
      await page.setInputFiles('#lib', h.path.join(h.images, 'small.jpg'));
      await thumbs(page, 1);
      await h.tap(page, '[data-act="photo-open"]');
      await h.fill(page, '#photo-label', EVIL);
      await h.tap(page, '#modal [data-sheet="done"]');
      assert.ok((await h.text(page, '.photo .tag')).startsWith('<img src=x'));
      await h.fill(page, '#f-notes', EVIL + '\n' + EVIL);
      assert.ok((await h.text(page, '[data-part="review"]')).includes('<img src=x'), 'the review list shows it as text');
      await h.tap(page, '[data-act="step-next"]');
      await page.waitForSelector('[data-act="add-pole"]');
      assert.ok((await h.text(page, '.where .t')).includes('<img src=x'));
      assert.ok((await h.text(page, '[data-act="open-pole"] .code')).includes('<script>'));

      // The export: safe file name, and the text shown as text inside.
      await h.tap(page, '[data-act="export-job"]');
      await h.tap(page, '#modal [data-sheet="package"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      const name = await h.text(page, '#modal .filename');
      assert.match(name, /^[\w.\-#&+]+\.zip$/, 'the file name holds nothing a computer could trip over: ' + name);
      const file = await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
      await h.tap(page, '#modal [data-act="file-saved-yes"]');
      const zip = await h.py('zip', file.path);
      assert.equal(zip.badEntry, null);
      assert.ok(zip.entries.every((entry) => !entry.name.includes('..') && !entry.name.startsWith('/') && !/[<>:"|?*\\]/.test(entry.name)), zip.entries.map((e) => e.name).join(' | '));
      const report = await h.pdf(await h.unzip(file.path, zip.entries[0].name));
      // The text may wrap onto several lines, so it is compared with the spaces taken out.
      assert.ok(report.squeezed(report.pages[0].text).includes(report.squeezed(EVIL)), 'the location is printed as text');
      assert.ok(report.squeezed(report.poleText(1)).includes(report.squeezed(EVIL + EVIL)), 'and so are the notes');

      // Deleting, the trash and the home list.
      await h.tap(page, '[data-act="delete-job"]');
      assert.ok(await h.count(page, '#modal .sheet'));
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('[data-act="new-job"]');
      await h.tap(page, '[data-act="open-settings"]');
      assert.equal(await page.inputValue('#set-name'), EVIL);
      await h.tap(page, '[data-act="open-trash"]');
      assert.ok((await h.text(page, '[data-trash="job"] .name')).includes('<img src=x'));
      await h.tap(page, '[data-act="trash-restore"]');
      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('#set-name');
      await h.tap(page, '[data-act="back"]');
      assert.ok((await h.text(page, '[data-act="open-job"] .name')).includes('<img src=x'));

      // A backup carrying the same text, restored on another phone.
      await h.tap(page, '[data-act="open-settings"]');
      const backup = await makeBackup(h, page);
      const other = await h.phone();
      await h.open(other.page, site.url);
      await toSettings(h, other.page);
      const hostile = await rewriteBackup(h, backup.path, 'hostile.zip', `
data['jobs'][0]['f']['__proto__'] = {'polluted': True}
data['jobs'][0]['f']['constructor'] = 'x'
data['jobs'][0]['extra'] = '<script>window.__xss=1</script>'
data['poles'][0]['f']['onclick'] = 'window.__xss=1'
data['poles'][0]['gps'] = {'lat': '<b>', 'lon': 9e99}
data['photos'][0]['label'] = '<svg onload="window.__xss=1">'
data['settings']['tokens'] = {'power': '<b onmouseover="window.__xss=1">x</b>', 'telecom': {'nested': 1}}
`);
      assert.match(await restore(h, other.page, hostile), /Added: 1 job, 1 pole, 1 photo\./);
      await h.tap(other.page, '[data-act="back"]');
      await h.tap(other.page, '[data-act="open-job"]');
      await h.tap(other.page, '[data-act="open-pole"]');
      await gotoStep(h, other.page, 'photos');
      await thumbs(other.page, 1);
      assert.ok((await h.text(other.page, '.photo .tag')).startsWith('<svg onload'));

      for (const p of [page, other.page]) {
        assert.equal(await p.evaluate(() => window.__xss), undefined, 'no injected code ran');
        assert.equal(await p.evaluate(() => ({}).polluted), undefined);
        assert.equal(await p.locator('#app img:not([data-thumb]), #app script, #app svg[onload]').count(), 0, 'no injected element exists');
        h.clean(p);
      }
    },
  },
];
