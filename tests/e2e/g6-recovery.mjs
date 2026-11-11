// Recovering from the unusual: a wrong clock, a tab frozen by the phone, an interrupted copy
// from the first version, a phone with no room, the app shown inside another page, and the
// phone's own Back button after the first pole.

import assert from 'node:assert/strict';
import { startJob, gotoStep, answer, savePole } from './harness.mjs';

const HOUR = 60 * 60 * 1000;

// Makes the phone's clock run ahead by the number of milliseconds in sessionStorage "clockOffset".
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

// Makes every save fail while localStorage "failSaves" is "1". localStorage is shared by every
// tab, so one tab can switch it off while another tab is frozen.
const SHARED_FAILING_SAVES = () => {
  const real = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function put(...args) {
    if (localStorage.getItem('failSaves') === '1') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return real.apply(this, args);
  };
};

// Makes the phone too full for pictures (but not for small records) while sessionStorage "full" is "1".
const NO_ROOM_FOR_PICTURES = () => {
  const real = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function put(...args) {
    if (this.name === 'blobs' && sessionStorage.getItem('full') === '1') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return real.apply(this, args);
  };
};

// Makes each picture take sessionStorage "photoDelay" milliseconds longer to shrink.
const SLOW_PICTURES = () => {
  const real = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function slow(callback, ...rest) {
    const delay = Number(sessionStorage.getItem('photoDelay') || 0);
    return real.call(this, (blob) => (delay ? setTimeout(() => callback(blob), delay) : callback(blob)), ...rest);
  };
};

/** Writes a database the way the first version of the app did: one job, one pole, some photos. */
async function makeFirstVersionData(page, photoIds, extra) {
  await page.evaluate(
    async ([ids, more]) => {
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
          poles: [{ id: 'old-pole-1', done: true, photoIds: ids, f: { tagMap: 'L1', tagField: 'L1' } }],
          ...more,
        });
        for (const id of ids) t.objectStore('photos').put({ id, jobId: 'old-job-1', poleId: 'old-pole-1', blob, w: 800, h: 600, createdAt: when });
        t.oncomplete = resolve;
        t.onabort = () => reject(t.error);
      });
      db.close();
    },
    [photoIds, extra || {}],
  );
}

const counts = (stored) => [stored.jobs.length, stored.poles.length, stored.photos.length, stored.blobs.length];
const legacyFlags = (stored) => {
  const settings = stored.meta.find((row) => row.key === 'settings');
  return settings ? [settings.value.legacyChecked, settings.value.legacyPhotosLeft] : null;
};

export default [
  {
    name: 'clock-correction',
    title: 'A clock that was fast and is put right keeps the pole order and the "changed since export" mark',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [SHIFTED_CLOCK] });
      await page.goto(site.url + 'fonts/LICENSE-IBM-Plex-Sans.txt');
      await page.evaluate((ms) => sessionStorage.setItem('clockOffset', String(ms)), 2 * HOUR);
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Clock St' });
      for (const tag of ['FIRST', 'SECOND', 'THIRD']) {
        await answer(h, page, { tagField: tag });
        await savePole(h, page);
        if (tag !== 'THIRD') {
          await h.tap(page, '[data-act="add-pole"]');
          await page.waitForSelector('#f-tagMap');
        }
      }
      await h.tap(page, '[data-act="export-job"]');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
      await h.tap(page, '#modal [data-act="file-saved-yes"]');
      assert.equal(await h.text(page, '.top .pill'), 'Exported');

      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      await h.fill(page, '#f-poleClass', 'CHANGED AFTER EXPORT');
      await h.tap(page, '[data-act="step-back"]');
      await page.waitForSelector('[data-act="add-pole"]');
      await h.saved(page);
      assert.equal(await h.text(page, '.top .pill'), 'Changed since export');
      const order = () => page.locator('[data-act="open-pole"] .code').allInnerTexts();
      assert.deepEqual(await order(), ['FIRST', 'SECOND', 'THIRD']);

      // The clock is put right (two hours back) and the app starts again.
      await page.evaluate(() => sessionStorage.setItem('clockOffset', '0'));
      await page.reload();
      await page.waitForSelector('[data-act="add-pole"]');
      assert.equal(await h.text(page, '.top .pill'), 'Changed since export', 'the change made after the export is still waiting');
      assert.deepEqual(await order(), ['FIRST', 'SECOND', 'THIRD'], 'the poles keep the order they were made in');
      const stored = await h.stored(page);
      assert.ok(stored.jobs[0].updatedAt > stored.jobs[0].exportedAt);

      // A change made now still moves its pole's time forward, past the times set while the clock was fast.
      const before = stored.poles.find((p) => p.f.tagField === 'SECOND');
      await h.tap(page, page.locator('[data-act="open-pole"]').nth(1));
      await h.fill(page, '#f-poleClass', 'AFTER THE CLOCK WAS FIXED');
      await h.tap(page, '[data-act="step-back"]');
      await page.waitForSelector('[data-act="add-pole"]');
      await h.saved(page);
      const after = (await h.stored(page)).poles.find((p) => p.id === before.id);
      assert.equal(after.f.poleClass, 'AFTER THE CLOCK WAS FIXED');
      assert.ok(after.updatedAt > before.updatedAt);
      assert.equal(await h.text(page, '.top .pill'), 'Changed since export');
      h.clean(page);
    },
  },

  {
    name: 'frozen-tab-wakes',
    title: 'A tab frozen by the phone wakes after another tab saved newer work, and cannot overwrite it',
    async run(h) {
      const site = await h.site();
      const { page: first, context } = await h.phone({ initScripts: [SHARED_FAILING_SAVES] });
      await h.open(first, site.url);
      await startJob(h, first, { location: 'Frozen for real' });
      await answer(h, first, { tagField: 'Z-1' });
      await h.saved(first);

      // Saves start failing, and an entry is only in memory and in the crash-proof journal.
      await first.evaluate(() => localStorage.setItem('failSaves', '1'));
      await h.fill(first, '#f-poleClass', 'A-OLD');
      await first.waitForSelector('.save-status.is-error');

      // The phone freezes the tab, the way it does with one left in the background.
      const cdp = await context.newCDPSession(first);
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });

      const second = await h.newPage(context);
      await second.goto(site.url + 'fonts/LICENSE-IBM-Plex-Sans.txt');
      await second.evaluate(() => localStorage.setItem('failSaves', '0')); // the phone has room again
      await second.goto(site.url);
      await second.waitForSelector('[data-act="take-over"]', { timeout: 15000 });
      await h.tap(second, '[data-act="take-over"]');
      await second.waitForSelector('[data-act="open-job"]', { timeout: 15000 });
      await h.tap(second, '[data-act="open-job"]');
      await h.tap(second, '[data-act="open-pole"]');
      await second.waitForFunction(() => document.querySelector('#f-poleClass') && document.querySelector('#f-poleClass').value === 'A-OLD', null, { timeout: 10000 });
      await h.fill(second, '#f-poleClass', 'B-NEWER');
      await h.fill(second, '#f-testTreat', 'typed in tab B');
      await h.saved(second);

      // The frozen tab wakes up and its retry timer fires.
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await first.waitForSelector('.banner.bad', { timeout: 10000 });
      assert.match(await h.text(first, '.banner.bad'), /Moved to another tab|Changed in another tab/);
      await h.pause(second, 5000);
      let stored = await h.stored(second);
      assert.equal(stored.poles[0].f.poleClass, 'B-NEWER', 'the woken tab did not write its older copy over the newer one');
      assert.equal(stored.poles[0].f.testTreat, 'typed in tab B');
      assert.equal(await second.inputValue('#f-poleClass'), 'B-NEWER');
      assert.equal(await h.text(second, '[data-save-status]'), 'Saved');

      // Everything is closed and opened again.
      await first.close();
      await second.reload();
      await second.waitForSelector('#f-poleClass');
      assert.equal(await second.inputValue('#f-poleClass'), 'B-NEWER');
      assert.equal(await second.inputValue('#f-testTreat'), 'typed in tab B');
      stored = await h.stored(second);
      assert.equal(stored.poles.length, 1);
      h.clean(second);
    },
  },

  {
    name: 'kept-for-undo',
    title: 'Leaving a new pole or a job never removes something that is waiting in Recently deleted',
    async run(h) {
      const site = await h.site();

      // 1. A new pole whose only photo was deleted is kept, so the photo can be brought back.
      {
        const { page } = await h.phone();
        await h.open(page, site.url);
        await startJob(h, page, { location: 'Undo Ave' });
        await answer(h, page, { tagField: 'U-1' });
        await savePole(h, page);
        await h.tap(page, '[data-act="add-pole"]');
        await page.waitForSelector('#f-tagMap');
        await gotoStep(h, page, 'photos');
        await page.setInputFiles('#lib', h.path.join(h.images, 'landscape.jpg'));
        await page.waitForSelector('[data-part="photos"] [data-act="photo-open"]');
        await h.tap(page, '[data-act="photo-open"]');
        await h.tap(page, '#modal [data-act="photo-delete"]');
        await h.tap(page, '#modal [data-sheet="yes"]');
        await gotoStep(h, page, 'pole');
        await h.tap(page, '[data-act="step-back"]');
        await page.waitForSelector('[data-act="add-pole"]');
        await h.saved(page);
        assert.equal(await h.count(page, '[data-act="open-pole"]'), 2, 'the pole that held the photo is still in the job');
        assert.deepEqual(counts(await h.stored(page)).slice(1), [2, 1, 3], 'the deleted photo and its picture are still on the phone');

        await h.tap(page, '[data-act="back"]');
        await h.tap(page, '[data-act="open-settings"]');
        await h.tap(page, '[data-act="open-trash"]');
        await h.tap(page, '[data-trash="photo"] [data-act="trash-restore"]');
        await h.tap(page, '[data-act="back"]');
        await h.tap(page, '[data-act="back"]');
        await h.tap(page, '[data-act="open-job"]');
        await h.tap(page, page.locator('[data-act="open-pole"]').nth(1));
        await gotoStep(h, page, 'photos');
        await page.waitForFunction(() => {
          const image = document.querySelector('[data-part="photos"] img[data-thumb]');
          return image && image.complete && image.naturalWidth > 0;
        });
        h.clean(page);
      }

      // 2. A job whose only pole is in Recently deleted is kept when Job details is opened and left.
      {
        const { page } = await h.phone();
        await h.open(page, site.url);
        await h.tap(page, '[data-act="new-job"]');
        await h.tap(page, '[data-act="details-done"]');
        await page.waitForSelector('#f-tagMap');
        await answer(h, page, { tagField: 'ONLY-POLE', height: '45' });
        await gotoStep(h, page, 'photos');
        await page.setInputFiles('#lib', h.path.join(h.images, 'landscape.jpg'));
        await page.waitForSelector('[data-part="photos"] [data-act="photo-open"]');
        await h.tap(page, '[data-act="pole-delete"]');
        await h.tap(page, '#modal [data-sheet="yes"]');
        await page.waitForSelector('[data-act="add-pole"]');
        await h.tap(page, '[data-act="edit-details"]');
        await page.waitForSelector('#f-location');
        await h.tap(page, '[data-act="back"]');
        await page.waitForSelector('[data-act="add-pole"]');
        await h.saved(page);
        assert.deepEqual(counts(await h.stored(page)), [1, 1, 1, 3], 'the job, its deleted pole and the photo are all still there');
        await h.tap(page, '[data-act="back"]');
        await h.tap(page, '[data-act="open-settings"]');
        await h.tap(page, '[data-act="open-trash"]');
        assert.match(await h.text(page, '[data-trash="pole"]'), /ONLY-POLE/);
        h.clean(page);
      }
    },
  },

  {
    name: 'first-version-interrupted',
    title: 'Copying from the first version picks up where it stopped, and never copies a job twice',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [SLOW_PICTURES] });
      await page.goto(site.url + 'fonts/LICENSE-IBM-Plex-Sans.txt');
      const ids = ['ph1', 'ph2', 'ph3', 'ph4', 'ph5', 'ph6'];
      await makeFirstVersionData(page, ids);
      await page.evaluate(() => sessionStorage.setItem('photoDelay', '700')); // about 2 s a photo

      // First start. The app is closed part way through the photos.
      await page.goto(site.url, { waitUntil: 'commit' });
      await page.waitForFunction(() => /Copying photos from the first version of the app: \d of 6/.test(document.getElementById('app').innerText), null, { timeout: 15000 });
      await h.pause(page, 4500);
      const middle = await h.stored(page);
      assert.deepEqual(counts(middle).slice(0, 2), [1, 1], 'the job and its pole are saved before the photos');
      assert.ok(middle.photos.length >= 1 && middle.photos.length < 6, 'only some photos were done: ' + middle.photos.length);
      assert.deepEqual(legacyFlags(middle), [true, true]);

      // Second start finishes the photos.
      await page.evaluate(() => sessionStorage.setItem('photoDelay', '0'));
      await page.reload();
      await page.waitForSelector('#app [data-heading]', { timeout: 30000 });
      await h.saved(page);
      let stored = await h.stored(page);
      assert.deepEqual(counts(stored), [1, 1, 6, 18], 'every photo arrived, in three sizes, and nothing is doubled');
      assert.deepEqual(legacyFlags(stored), [true, false]);
      await page.waitForFunction(() => /Copied from the first version of the app: \d photos?\./.test(document.getElementById('toast').innerText));

      // A job deleted for good after that is not brought back by a later start.
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, '[data-act="delete-job"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await h.tap(page, '[data-act="open-settings"]');
      await h.tap(page, '[data-act="open-trash"]');
      await h.tap(page, '[data-act="trash-forever"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('.empty');
      await page.reload();
      await page.waitForSelector('#app [data-heading]');
      await h.pause(page, 500);
      stored = await h.stored(page);
      assert.deepEqual(counts(stored), [0, 0, 0, 0]);
      assert.equal((await h.stored(page, 'polefield')).photos.length, 6, 'the old database is left exactly as it was');
      h.clean(page);
    },
  },

  {
    name: 'first-version-no-room',
    title: 'Copying from the first version on a full phone says so, and finishes once there is room',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [NO_ROOM_FOR_PICTURES] });
      await page.goto(site.url + 'fonts/LICENSE-IBM-Plex-Sans.txt');
      await makeFirstVersionData(page, ['ph1', 'ph2', 'ph3', 'ph4', 'gone'], { exportedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 });
      // "gone" is listed on the pole but has no record, the way an old crash could leave it.
      await page.evaluate(async () => {
        const db = await new Promise((resolve) => {
          const request = indexedDB.open('polefield');
          request.onsuccess = () => resolve(request.result);
        });
        await new Promise((resolve) => {
          const t = db.transaction('photos', 'readwrite');
          t.objectStore('photos').delete('gone');
          t.oncomplete = resolve;
        });
        db.close();
        sessionStorage.setItem('full', '1');
      });

      await h.open(page, site.url);
      await page.waitForSelector('#modal .sheet');
      const message = (await h.text(page, '#modal')).replace(/\s+/g, ' ');
      assert.match(message, /Copied from the first version of the app: 1 job\./);
      assert.match(message, /1 photo could not be read, so it was left out\. Nothing was removed from the first version's storage\./);
      assert.match(message, /4 photos could not be saved because the phone is short of space\. Free up some space, then close and reopen the app to finish\./);
      await h.tap(page, '#modal [data-sheet="ok"]');
      await h.saved(page);
      let stored = await h.stored(page);
      assert.deepEqual(counts(stored), [1, 1, 0, 0]);
      assert.deepEqual(legacyFlags(stored), [true, true]);

      // There is room again. The next start finishes the job and says so briefly.
      await page.evaluate(() => sessionStorage.setItem('full', '0'));
      await page.reload();
      await page.waitForSelector('[data-act="open-job"]');
      await page.waitForFunction(() => /4 photos/.test(document.getElementById('toast').innerText));
      await h.saved(page);
      stored = await h.stored(page);
      assert.deepEqual(counts(stored), [1, 1, 4, 12]);
      assert.deepEqual(legacyFlags(stored), [true, false]);
      assert.equal(await h.count(page, '#modal .sheet'), 0, 'the unreadable photo is not reported again');

      // And the next start after that has nothing more to do.
      await page.reload();
      await page.waitForSelector('[data-act="open-job"]');
      await h.pause(page, 800);
      assert.equal(await h.count(page, '#modal .sheet'), 0);
      assert.deepEqual(counts(await h.stored(page)), [1, 1, 4, 12]);
      h.clean(page);
    },
  },

  {
    name: 'framed',
    title: 'The app will not run inside another page, and a framed copy never blocks the real one',
    async run(h) {
      const site = await h.site();
      const frame = (src) => '<!doctype html><title>Frame</title><iframe id="f" src="' + src + '" width="390" height="700"></iframe>';
      // A page on the same address as the app, and one on another site, both showing it in a frame.
      const same = await h.serve(h.ROOT, { intercept: (inside) => (inside === 'frame-test.html' ? { type: 'text/html; charset=utf-8', body: frame('./') } : undefined) });
      const other = await h.serve(h.tmp, { intercept: (inside) => (inside === 'frame.html' ? { type: 'text/html; charset=utf-8', body: frame(site.url) } : undefined) });

      const { page, context } = await h.phone();
      for (const url of [same.url + 'frame-test.html', other.origin.replace('localhost', '127.0.0.1') + '/frame.html']) {
        await page.goto(url);
        const app = page.frameLocator('#f');
        await app.locator('.banner.bad').waitFor({ timeout: 15000 });
        assert.match(await app.locator('.banner.bad').innerText(), /Open the app on its own[\s\S]*will not run there/);
        assert.equal(await app.locator('[data-act="new-job"]').count(), 0, 'nothing in the frame can be tapped to change data');
        assert.equal(await app.locator('a.btn[target="_top"]').count(), 1);
      }

      // The framed copy on the same address did not take the one-tab lock.
      await page.goto(same.url + 'frame-test.html');
      await page.frameLocator('#f').locator('.banner.bad').waitFor();
      const real = await h.newPage(context);
      await h.open(real, same.url);
      assert.equal(await h.count(real, '[data-act="take-over"]'), 0);
      assert.ok(await h.count(real, '[data-act="new-job"]'));

      // The link opens the app in the whole window.
      await page.frameLocator('#f').locator('a.btn').click();
      await page.waitForSelector('#app [data-heading]', { timeout: 15000 });
      assert.equal(new URL(page.url()).pathname, '/');
      h.clean(real);
    },
  },

  {
    name: 'phone-back-first-pole',
    title: "The phone's Back button after the first pole of a new job goes to the job, then the job list",
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      const hash = () => page.evaluate(() => location.hash);

      // Back from the first step of the first pole goes to the job, not to its details.
      await startJob(h, page, { location: 'Back Rd' });
      await page.goBack();
      await page.waitForSelector('[data-act="add-pole"]');
      assert.match(await hash(), /^#\/job\/[^/]+$/);
      await page.goBack();
      await page.waitForSelector('[data-act="new-job"]');

      // After "Save pole", Back goes straight to the job list. (The empty pole was removed when it was left.)
      await h.tap(page, '[data-act="open-job"]');
      assert.equal(await h.count(page, '[data-act="open-pole"]'), 0);
      await h.tap(page, '[data-act="add-pole"]');
      await answer(h, page, { tagField: 'B-1' });
      await gotoStep(h, page, 'spans');
      await savePole(h, page);
      await page.goBack();
      await page.waitForSelector('[data-act="new-job"]');
      assert.match(await hash(), /^(#\/)?$/);

      // The same for a brand-new job whose first pole is saved straight away.
      await startJob(h, page, { location: 'Second Rd' });
      await answer(h, page, { tagField: 'B-2' });
      await savePole(h, page);
      await page.goBack();
      await page.waitForSelector('[data-act="new-job"]');
      assert.equal(await h.count(page, '[data-act="open-job"]'), 2);
      h.clean(page);
    },
  },
];
