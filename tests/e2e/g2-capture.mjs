// GPS and photos: the two things that take time, and so the two that can go astray.

import assert from 'node:assert/strict';
import { startJob, gotoStep, savePole } from './harness.mjs';

const CAMPBELL_RIVER = { latitude: 50.0244, longitude: -125.2475, accuracy: 6 };

// Lets a test hold back the phone's position readings, to act out a slow GPS.
const SLOW_GPS = () => {
  const real = navigator.geolocation.watchPosition.bind(navigator.geolocation);
  navigator.geolocation.watchPosition = (ok, bad, options) => real((position) => setTimeout(() => ok(position), window.__gpsDelay || 0), bad, options);
};

// Lets a test slow down the shrinking of a photo, to act out a slow phone.
const SLOW_PHOTOS = () => {
  const real = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function slow(callback, ...rest) {
    const delay = window.__photoDelay || 0;
    return real.call(this, (blob) => (delay ? setTimeout(() => callback(blob), delay) : callback(blob)), ...rest);
  };
};

const photoCount = (page) => page.locator('[data-part="photos"] [data-act="photo-open"]').count();

async function waitForThumbs(page, count) {
  await page.waitForFunction(
    (wanted) => {
      const images = [...document.querySelectorAll('[data-part="photos"] img[data-thumb]')];
      return images.length === wanted && images.every((image) => image.complete && image.naturalWidth > 0);
    },
    count,
    { timeout: 20000 },
  );
}

export default [
  {
    name: 'gps',
    title: 'GPS: recording, low accuracy, clearing, and a refusal',
    async run(h) {
      const site = await h.site();
      const { page, context } = await h.phone({ permissions: ['geolocation'], geolocation: CAMPBELL_RIVER });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'GPS' });
      assert.match(await h.text(page, '[data-part="gps"]'), /Record this pole's position/);
      await h.tap(page, '[data-act="gps-get"]');
      await page.waitForSelector('.coords');
      assert.equal(await h.text(page, '.coords'), '50.024400, -125.247500');
      assert.match(await h.text(page, '.gps .sub'), /^Accurate to about 6 m · \d\d:\d\d$/);
      assert.equal(await h.count(page, '[data-part="gps"] .hint'), 0);
      await h.saved(page);
      let stored = await h.stored(page);
      assert.equal(stored.poles[0].gps.lat, 50.0244);
      assert.equal(stored.poles[0].gps.acc, 6);

      // A poor reading is kept, but flagged, here and in the review list. The app listens for a
      // while first in case a better one arrives.
      await context.setGeolocation({ ...CAMPBELL_RIVER, latitude: 50.03, accuracy: 85 });
      await h.tap(page, '[data-act="gps-get"]');
      await page.waitForSelector('[data-gps-progress]');
      assert.match(await h.text(page, '[data-gps-progress]'), /Within about 85 m so far|Looking for the position/);
      await page.waitForFunction(() => document.querySelector('.coords') && document.querySelector('.coords').textContent.startsWith('50.030000'), null, { timeout: 20000 });
      assert.match(await h.text(page, '[data-part="gps"] .hint'), /Low accuracy/);
      await gotoStep(h, page, 'photos');
      assert.match(await h.text(page, '.review'), /GPS position[\s\S]*Only accurate to about 85 m/);
      await h.tap(page, '[data-act="review-goto"][data-key="gps"]');
      await page.waitForFunction(() => location.hash.endsWith('/pole'));

      // Clearing asks first, and can be undone.
      await h.tap(page, '[data-act="gps-clear"]');
      assert.match(await h.text(page, '#modal'), /Clear this position\?/);
      await h.tap(page, '#modal [data-sheet="no"]');
      assert.equal(await h.count(page, '.coords'), 1, '"Keep it" keeps it');
      await h.tap(page, '[data-act="gps-clear"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      assert.equal(await h.count(page, '.coords'), 0);
      await h.tap(page, '[data-toast-action]');
      assert.equal(await h.text(page, '.coords'), '50.030000, -125.247500', 'Undo puts the position back');
      h.clean(page);

      // Location switched off for the app.
      const refused = await h.phone();
      await h.open(refused.page, site.url);
      await startJob(h, refused.page, { location: 'No GPS' });
      await h.tap(refused.page, '[data-act="gps-get"]');
      await refused.page.waitForSelector('[data-part="gps"] .hint');
      assert.match(await h.text(refused.page, '[data-part="gps"] .hint'), /Location is turned off for this app/);
      assert.equal(await h.count(refused.page, '.coords'), 0);
      assert.ok(await refused.page.locator('[data-act="gps-get"]').isEnabled(), 'the button is ready for another try');
      h.clean(refused.page);
    },
  },

  {
    name: 'gps-late',
    title: 'GPS: a slow reading never lands on another pole',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ permissions: ['geolocation'], geolocation: CAMPBELL_RIVER, initScripts: [SLOW_GPS] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Late GPS' });
      await h.fill(page, '#f-tagField', 'POLE-A');

      // Start looking on pole A, then leave for pole B before the reading arrives.
      await page.evaluate(() => { window.__gpsDelay = 2500; });
      await h.tap(page, '[data-act="gps-get"]');
      await page.waitForSelector('[data-act="gps-cancel"]');
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="add-pole"]');
      await page.waitForSelector('#f-tagField');
      await h.fill(page, '#f-tagField', 'POLE-B');
      await h.pause(page, 3200);
      assert.equal(await h.count(page, '.coords'), 0, 'pole B shows no position');
      assert.equal(await h.count(page, '[data-act="gps-cancel"]'), 0, 'pole B is not shown as busy');
      await h.saved(page);
      let stored = await h.stored(page);
      assert.deepEqual(stored.poles.map((pole) => [pole.f.tagField, pole.gps]).sort(), [['POLE-A', null], ['POLE-B', null]], 'the late reading was thrown away, because the phone had moved on');

      // Pole B's own button works straight away. It is not held up by pole A's request.
      await page.evaluate(() => { window.__gpsDelay = 0; });
      await h.tap(page, '[data-act="gps-get"]');
      await page.waitForSelector('.coords', { timeout: 5000 });
      await h.saved(page);
      stored = await h.stored(page);
      assert.deepEqual(stored.poles.map((pole) => [pole.f.tagField, Boolean(pole.gps)]).sort(), [['POLE-A', false], ['POLE-B', true]]);

      // Cancel stops the search, and a reading that arrives afterwards is ignored.
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      await page.evaluate(() => { window.__gpsDelay = 1500; });
      await h.tap(page, '[data-act="gps-get"]');
      await h.tap(page, '[data-act="gps-cancel"]');
      assert.match(await h.text(page, '[data-part="gps"]'), /Record this pole's position/);
      await h.pause(page, 2000);
      assert.equal(await h.count(page, '.coords'), 0);

      // Moving between steps of the same pole keeps the search going.
      await page.evaluate(() => { window.__gpsDelay = 1200; });
      await h.tap(page, '[data-act="gps-get"]');
      await gotoStep(h, page, 'equipment');
      await h.pause(page, 1800);
      await gotoStep(h, page, 'pole');
      assert.equal(await h.text(page, '.coords'), '50.024400, -125.247500');
      h.clean(page);
    },
  },

  {
    name: 'photos',
    title: 'Photos: taking, choosing, labelling, sizes and odd files',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Photos' });
      await gotoStep(h, page, 'photos');
      assert.equal(await h.text(page, '.nophotos'), 'No photos yet');
      assert.equal(await page.getAttribute('#cam', 'capture'), 'environment');
      assert.equal(await page.getAttribute('#cam', 'accept'), 'image/*');

      // One shot from the camera: a label is offered straight away.
      await page.setInputFiles('#cam', h.path.join(h.images, 'landscape.jpg'));
      await page.waitForSelector('#modal [data-sheet="label:Pole tag"]');
      await h.tap(page, '#modal [data-sheet="label:Pole tag"]');
      await waitForThumbs(page, 1);
      assert.equal(await h.text(page, '.photo .tag'), 'Pole tag');
      assert.equal(await h.count(page, '.nophotos'), 0);

      // Several from the library: no questions asked.
      await page.setInputFiles('#lib', ['portrait.jpg', 'big.jpg', 'sideways.jpg', 'transparent.png'].map((name) => h.path.join(h.images, name)));
      await waitForThumbs(page, 5);
      assert.equal(await h.count(page, '#modal .sheet'), 0);
      await h.shot(page, '08-photos');
      await h.saved(page);

      const stored = await h.stored(page);
      assert.equal(stored.photos.length, 5);
      assert.equal(stored.blobs.length, 15, 'three sizes of each photo');
      const sizes = stored.photos.sort((a, b) => a.createdAt - b.createdAt).map((photo) => photo.w + 'x' + photo.h);
      assert.deepEqual(sizes, ['1600x1200', '1200x1600', '2000x1500', '1200x1600', '800x600'], 'the big one is shrunk, the sideways one is turned upright');
      const ordered = stored.photos.sort((a, b) => a.createdAt - b.createdAt);
      for (const photo of ordered) {
        const kinds = stored.blobs.filter((blob) => blob.photoId === photo.id);
        assert.deepEqual(kinds.map((blob) => blob.size).sort(), ['full', 'mid', 'thumb']);
        const bytes = Object.fromEntries(kinds.map((blob) => [blob.size, blob.data]));
        assert.ok(bytes.full > bytes.mid && bytes.mid > bytes.thumb && bytes.thumb > 500, JSON.stringify(bytes));
        assert.equal(photo.bytes, bytes.full);
      }

      // The stored pictures, opened by another program.
      const big = await h.py('image', await h.pictureFile(page, ordered[2].id, 'full'));
      assert.deepEqual([big.format, big.width, big.height], ['JPEG', 2000, 1500]);
      const mid = await h.py('image', await h.pictureFile(page, ordered[2].id, 'mid'));
      assert.deepEqual([mid.width, mid.height], [900, 675]);
      const thumb = await h.py('image', await h.pictureFile(page, ordered[2].id, 'thumb'));
      assert.deepEqual([thumb.width, thumb.height], [320, 240]);
      const sideways = await h.py('image', await h.pictureFile(page, ordered[3].id, 'full'));
      assert.deepEqual([sideways.width, sideways.height], [1200, 1600]);
      assert.ok(sideways.points.topRight[0] > 180 && sideways.points.topRight[1] < 90, 'the red corner has moved to the top right, so the picture is upright: ' + JSON.stringify(sideways.points));
      assert.ok(!sideways.orientation || sideways.orientation === 1, 'no "rotate me" tag is left to turn it a second time');
      const clear = await h.py('image', await h.pictureFile(page, ordered[4].id, 'full'));
      assert.ok(clear.points.topLeft.every((v) => v > 245), 'see-through areas become white, not black: ' + JSON.stringify(clear.points.topLeft));

      // Files that are not pictures are refused with a plain message, and nothing is half-saved.
      await page.setInputFiles('#lib', h.path.join(h.images, 'not-a-picture.jpg'));
      await page.waitForSelector('#modal .sheet');
      assert.match(await h.text(page, '#modal'), /A photo was not saved[\s\S]*could not read that picture/);
      await h.tap(page, '#modal [data-sheet="ok"]');
      await page.setInputFiles('#lib', [h.path.join(h.images, 'empty.jpg'), h.path.join(h.images, 'small.jpg')]);
      await page.waitForSelector('#modal .sheet');
      assert.match(await h.text(page, '#modal'), /A photo was not saved[\s\S]*The other 1 photo saved normally/);
      await h.tap(page, '#modal [data-sheet="ok"]');
      await waitForThumbs(page, 6);
      assert.equal((await h.stored(page)).blobs.length, 18);

      // The viewer: a bigger picture, labels, and a label of your own.
      await h.tap(page, page.locator('[data-act="photo-open"]').nth(1));
      await page.waitForFunction(() => {
        const image = document.querySelector('#modal .viewer img');
        return image && image.complete && image.naturalWidth === 675;
      });
      await h.tap(page, '#modal [data-act="photo-label"][data-label="Anchor"]');
      assert.equal(await page.getAttribute('#modal [data-label="Anchor"]', 'aria-pressed'), 'true');
      assert.equal(await h.text(page, page.locator('[data-act="photo-open"]').nth(1).locator('.tag')), 'Anchor', 'the label shows on the small picture behind the sheet');
      await h.tap(page, '#modal [data-act="photo-label"][data-label="Anchor"]');
      assert.equal(await page.locator('[data-act="photo-open"]').nth(1).locator('.tag').count(), 0, 'tapping the label again removes it');
      await h.fill(page, '#photo-label', 'Cracked crossarm');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'photo-label');
      await h.tap(page, '#modal [data-sheet="done"]');
      assert.equal(await h.text(page, page.locator('[data-act="photo-open"]').nth(1).locator('.tag')), 'Cracked crossarm');
      await h.tap(page, page.locator('[data-act="photo-open"]').nth(1));
      assert.equal(await page.inputValue('#photo-label'), 'Cracked crossarm');
      await h.tap(page, '#modal [data-sheet="done"]');

      h.clean(page, ['could not read that picture']);
    },
  },

  {
    name: 'photo-delete',
    title: 'Photos: deleting asks first, and Recently deleted can bring one back',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Photo delete' });
      await h.fill(page, '#f-tagField', 'T-9');
      await gotoStep(h, page, 'photos');
      await page.setInputFiles('#lib', [h.path.join(h.images, 'landscape.jpg'), h.path.join(h.images, 'portrait.jpg')]);
      await waitForThumbs(page, 2);

      await h.tap(page, page.locator('[data-act="photo-open"]').first());
      await h.tap(page, '#modal [data-act="photo-delete"]');
      assert.match(await h.text(page, '#modal'), /Delete this photo\?[\s\S]*Recently deleted/);
      await h.tap(page, '#modal [data-sheet="no"]');
      assert.equal(await photoCount(page), 2, '"Keep it" keeps it');

      await h.tap(page, page.locator('[data-act="photo-open"]').first());
      await h.tap(page, '#modal [data-act="photo-delete"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      assert.equal(await photoCount(page), 1);
      await h.tap(page, '[data-toast-action]');
      await waitForThumbs(page, 2);

      await h.tap(page, page.locator('[data-act="photo-open"]').first());
      await h.tap(page, '#modal [data-act="photo-delete"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      assert.equal(await photoCount(page), 1);
      await h.saved(page);
      let stored = await h.stored(page);
      assert.equal(stored.blobs.length, 6, 'the picture is kept while it can still be brought back');

      await savePole(h, page);
      assert.match(await h.text(page, '[data-act="open-pole"] .sub'), /^1 photo/);
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      assert.match(await h.text(page, '#app'), /1 item can still be brought back/);
      await h.tap(page, '[data-act="open-trash"]');
      await page.waitForFunction(() => {
        const image = document.querySelector('[data-trash="photo"] img');
        return image && image.complete && image.naturalWidth > 0;
      });
      assert.match(await h.text(page, '[data-trash="photo"]'), /From Pole T-9, Photo delete[\s\S]*30 days left/);
      await h.shot(page, '13-recently-deleted');
      await h.tap(page, '[data-act="trash-restore"]');
      assert.match(await h.text(page, '.empty'), /Nothing here/);
      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('#set-name');
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-job"]');
      assert.match(await h.text(page, '[data-act="open-pole"] .sub'), /^2 photos/);

      // Delete forever really removes the pictures from the phone.
      await h.tap(page, '[data-act="open-pole"]');
      await gotoStep(h, page, 'photos');
      await waitForThumbs(page, 2);
      await h.tap(page, page.locator('[data-act="photo-open"]').first());
      await h.tap(page, '#modal [data-act="photo-delete"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await h.tap(page, '[data-act="step-back"]');
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      await h.tap(page, '[data-act="open-trash"]');
      await h.tap(page, '[data-act="trash-forever"]');
      assert.match(await h.text(page, '#modal'), /Delete forever\?[\s\S]*cannot be undone/);
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('.empty');
      stored = await h.stored(page);
      assert.equal(stored.photos.length, 1);
      assert.equal(stored.blobs.length, 3);
      h.clean(page);
    },
  },

  {
    name: 'photo-late',
    title: 'Photos: a slow photo lands on its own pole, and never steals the keyboard',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [SLOW_PHOTOS] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Slow photos' });
      await h.fill(page, '#f-tagField', 'POLE-A');
      await gotoStep(h, page, 'photos');

      // Choose a photo on pole A, then move to pole B while it is still being shrunk.
      await page.evaluate(() => { window.__photoDelay = 900; });
      await page.setInputFiles('#lib', h.path.join(h.images, 'landscape.jpg'));
      await page.waitForSelector('.photo.busy');
      await h.tap(page, '[data-act="step-next"]');
      await page.waitForSelector('[data-act="add-pole"]');
      await h.tap(page, '[data-act="add-pole"]');
      await h.fill(page, '#f-tagField', 'POLE-B');
      await gotoStep(h, page, 'photos');
      await h.pause(page, 3500);
      assert.equal(await photoCount(page), 0, 'pole B shows no photo');
      assert.equal(await h.count(page, '.photo.busy'), 0);
      await h.saved(page);
      const stored = await h.stored(page);
      assert.equal(stored.photos.length, 1);
      const owner = stored.poles.find((pole) => pole.id === stored.photos[0].poleId);
      assert.equal(owner.f.tagField, 'POLE-A', 'the photo was stored on the pole it was chosen for');

      // Two camera shots in quick succession: both are kept.
      await page.evaluate(() => { window.__photoDelay = 500; });
      await page.setInputFiles('#cam', h.path.join(h.images, 'small.jpg'));
      await page.waitForSelector('.photo.busy');
      await page.setInputFiles('#cam', h.path.join(h.images, 'portrait.jpg'));
      await page.waitForFunction(() => document.querySelectorAll('[data-part="photos"] [data-act="photo-open"]').length === 2, null, { timeout: 20000 });
      if (await h.count(page, '#modal .sheet')) await h.tap(page, '#modal [data-sheet="skip"]');
      await waitForThumbs(page, 2);

      // Typing notes while a photo is still being stored: the keyboard is left alone.
      await page.evaluate(() => { window.__photoDelay = 700; });
      await page.setInputFiles('#cam', h.path.join(h.images, 'small.jpg'));
      await page.locator('#f-notes').focus();
      await page.keyboard.type('Leaning toward the road', { delay: 25 });
      await page.waitForFunction(() => document.querySelectorAll('[data-part="photos"] [data-act="photo-open"]').length === 3, null, { timeout: 20000 });
      await page.keyboard.type(', guy wire slack');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'f-notes', 'the cursor never left the notes box');
      assert.equal(await page.inputValue('#f-notes'), 'Leaning toward the road, guy wire slack');
      assert.equal(await h.count(page, '#modal .sheet'), 0, 'no label question popped up over the keyboard');
      await waitForThumbs(page, 3);
      h.clean(page);
    },
  },
];
