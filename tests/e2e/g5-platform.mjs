// The phone itself: screen sizes, the keyboard, storage limits, large jobs, no signal and updates.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startJob, gotoStep, answer, savePole } from './harness.mjs';
import { makeServer } from '../../tools/serve.mjs';
import { rebuild } from '../../tools/build-sw.mjs';
import { ZipWriter } from '../../src/zip.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// Looks over the screen the way an accessibility review would. Returns a list of problems.
const AUDIT = () => {
  const problems = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[hidden]');
  };
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.getAttribute('data-act') ? '[' + el.getAttribute('data-act') + ']' : '') + ' "' + (el.textContent || '').trim().slice(0, 30) + '"';
  const nameOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) return labelled.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
    return (el.textContent || '').trim();
  };
  const modal = document.getElementById('modal');
  const scope = modal && !modal.hidden ? modal : document.getElementById('app');

  for (const el of scope.querySelectorAll('button, a[href], input:not([type="file"]), textarea, [role="group"], [role="dialog"]')) {
    if (!visible(el)) continue;
    if (!nameOf(el)) problems.push('no name: ' + describe(el));
  }
  for (const el of [...scope.querySelectorAll('button'), ...document.querySelectorAll('#toast button')]) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5) problems.push('small target (' + Math.round(r.width) + 'x' + Math.round(r.height) + '): ' + describe(el));
    if (el.getAttribute('type') !== 'button') problems.push('button without type="button": ' + describe(el));
  }
  for (const el of scope.querySelectorAll('input:not([type="file"]), textarea')) {
    if (visible(el) && parseFloat(getComputedStyle(el).fontSize) < 16) problems.push('text smaller than 16px makes iPhones zoom in: ' + describe(el));
  }
  for (const el of scope.querySelectorAll('img')) {
    if (!el.hasAttribute('alt')) problems.push('image with no alt: ' + describe(el));
  }
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push('id used twice: ' + id);
  if (scope.id === 'app') {
    const headings = document.querySelectorAll('#app h1');
    if (headings.length !== 1) problems.push('expected one main heading, found ' + headings.length);
    if (!document.querySelector('#app main')) problems.push('no <main> region');
    if (document.querySelectorAll('.progress button').length && document.querySelectorAll('.progress [aria-current="step"]').length !== 1) problems.push('the step bar does not mark the current step');
    for (const input of document.querySelectorAll('#app input[aria-describedby]')) {
      if (!document.getElementById(input.getAttribute('aria-describedby'))) problems.push('aria-describedby points nowhere: ' + describe(input));
    }
  } else {
    const dialog = modal.querySelector('[role="dialog"]');
    if (!dialog || dialog.getAttribute('aria-modal') !== 'true') problems.push('the sheet is not marked as a dialog');
    if (!document.getElementById('app').inert) problems.push('the page behind the sheet can still be reached');
  }
  if (document.documentElement.lang !== 'en') problems.push('the page language is not set');
  if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push('the page scrolls sideways: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth);
  for (const el of scope.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 1 || r.left < -1) {
      problems.push('off the side of the screen: ' + describe(el));
      break;
    }
  }
  return problems;
};

async function audit(h, page, where) {
  const problems = await page.evaluate(AUDIT);
  assert.deepEqual(problems, [], where);
}

async function thumbs(page, count) {
  await page.waitForFunction((wanted) => {
    const images = [...document.querySelectorAll('[data-part="photos"] img[data-thumb]')];
    return images.length === wanted && images.every((image) => image.complete && image.naturalWidth > 0);
  }, count, { timeout: 20000 });
}

// Visits every screen and sheet, calling check(name) on each.
async function tour(h, page, check) {
  await check('home, empty');
  await h.tap(page, '[data-act="new-job"]');
  await page.waitForSelector('#f-location');
  await check('job details');
  await h.fill(page, '#f-location', 'A long job name that will need to be cut short on a narrow phone screen');
  await h.fill(page, '#f-designNo', 'DESIGN-NUMBER-0000012345-REV-C');
  await h.tap(page, '[data-act="details-done"]');
  await page.waitForSelector('#f-tagMap');
  await answer(h, page, { tagMap: 'A1234', tagField: 'A1235-WITH-A-VERY-LONG-TAG-NUMBER', height: 'x' });
  await check('step 1, with warnings');
  await gotoStep(h, page, 'equipment');
  await answer(h, page, { secondary: ['1Ø'], streetLight: ['Yes - Bonded'] });
  await check('step 2');
  await gotoStep(h, page, 'anchors');
  await answer(h, page, { powerAnchor: ['No'] });
  await check('step 3, with N/A');
  await gotoStep(h, page, 'heights');
  await answer(h, page, { gP: '9.4', gN: '8.1', gT: '62' });
  await h.tap(page, '[data-toggle="ww"]');
  await check('step 4, wire to wire on');
  await gotoStep(h, page, 'spans');
  await answer(h, page, { midIssue: ['No'] });
  await check('step 5');
  await gotoStep(h, page, 'photos');
  await page.setInputFiles('#lib', [h.path.join(h.images, 'landscape.jpg'), h.path.join(h.images, 'portrait.jpg')]);
  await thumbs(page, 2);
  await check('step 6, with photos and the review list');
  await h.tap(page, page.locator('[data-act="photo-open"]').first());
  await page.waitForSelector('#modal .viewer img');
  await check('photo viewer');
  await h.tap(page, '#modal [data-act="photo-delete"]');
  await check('confirm sheet');
  await h.tap(page, '#modal [data-sheet="no"]');
  await h.tap(page, '[data-act="step-next"]');
  await page.waitForSelector('[data-act="add-pole"]');
  await check('job');
  await h.tap(page, '[data-act="export-job"]');
  await check('export choice');
  await h.tap(page, '#modal [data-sheet="pdf"]');
  await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
  await check('file ready');
  await h.tap(page, '#modal [data-sheet="close"]');
  await h.tap(page, '[data-act="delete-job"]');
  await h.tap(page, '#modal [data-sheet="yes"]');
  await page.waitForSelector('[data-act="new-job"]');
  await check('home, with the Undo toast');
  await h.tap(page, '[data-act="open-settings"]');
  await page.waitForSelector('#set-name');
  await check('settings');
  await h.tap(page, '[data-act="about"]');
  await check('about');
  await h.tap(page, '#modal [data-sheet="ok"]');
  await h.tap(page, '[data-act="open-trash"]');
  await check('recently deleted');
  await h.tap(page, '[data-act="trash-restore"]');
  await h.tap(page, '[data-act="back"]');
  await page.waitForSelector('#set-name');
  await h.tap(page, '[data-act="back"]');
  await page.waitForSelector('[data-act="open-job"]');
  await check('home, with a job');
}

// A backup file with many poles and photos, built outside the app.
async function bigBackup(h, poleCount, photosPerPole) {
  const full = await h.readFile(h.path.join(h.images, 'camera-full.jpg'));
  const mid = await h.readFile(h.path.join(h.images, 'camera-mid.jpg'));
  const thumb = await h.readFile(h.path.join(h.images, 'camera-thumb.jpg'));
  const now = Date.now() - 60000;
  const job = { id: randomUUID(), f: { location: 'Big job, Island Hwy', date: '2026-10-04', collectedBy: 'R. Sharpe', designNo: 'BIG-40' }, createdAt: now, updatedAt: now, exportedAt: 0 };
  const poles = [];
  const photos = [];
  const zip = new ZipWriter();
  for (let i = 0; i < poleCount; i += 1) {
    const pole = {
      id: randomUUID(), jobId: job.id, gps: { lat: 50.02 + i * 0.0004, lon: -125.24 - i * 0.0003, acc: 5 + (i % 4), at: now }, done: i % 5 !== 0, createdAt: now + i, updatedAt: now + i,
      f: {
        tagMap: 'T' + String(1000 + i), tagField: 'T' + String(1000 + i), tagStatus: 'OK', poleType: 'Wood', condition: i % 7 ? 'Good' : 'Questionable', height: String(40 + (i % 4) * 5), poleClass: String(3 + (i % 3)),
        xfmr: i % 3 ? 'None' : '1Ø', secondary: '1Ø', powerDip: 'No', streetLight: i % 4 ? 'No' : 'Yes', telPlant: 'Yes', telDip: 'No', powerAnchor: 'No', telAnchor: 'No', jointAnchor: 'No',
        gP: (9 + (i % 10) / 10).toFixed(1), gN: '8.1', gS: '7.9', gT: '6.2', span1: 'North, ' + (35 + i) + ' m', notes: 'Pole ' + (i + 1) + ' of the big job.\nSecond line of notes.',
      },
    };
    poles.push(pole);
    for (let k = 0; k < photosPerPole; k += 1) {
      const photo = { id: randomUUID(), poleId: pole.id, jobId: job.id, label: ['Whole pole', 'Pole tag', 'Pole top'][k % 3], w: 2000, h: 1500, bytes: full.length, createdAt: now + i * 10 + k, updatedAt: now + i * 10 + k };
      photos.push(photo);
      zip.add('photos/' + photo.id + '.full.jpg', full);
      zip.add('photos/' + photo.id + '.mid.jpg', mid);
      zip.add('photos/' + photo.id + '.thumb.jpg', thumb);
    }
  }
  zip.add('backup.json', JSON.stringify({ format: 'polefield-backup', formatVersion: 1, app: 'Pole Field Data', appVersion: '0.2.0', madeAt: new Date().toISOString(), jobs: [job], poles, photos, settings: { collectedBy: '', tokens: { power: 'Power', telecom: 'Telecom' } } }));
  const file = h.path.join(h.tmp, 'big-backup.zip');
  await h.writeFile(file, Buffer.from(await zip.finish().arrayBuffer()));
  return file;
}

async function downloadReady(h, page) {
  const file = await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
  await h.tap(page, '#modal [data-act="file-saved-yes"]');
  return file;
}

export default [
  {
    name: 'accessibility',
    title: 'Every screen: names, headings, target sizes and reading order',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await tour(h, page, (where) => audit(h, page, where));
      h.clean(page);
    },
  },

  {
    name: 'small-screens',
    title: 'A 320 px phone, and a phone turned on its side',
    async run(h) {
      const site = await h.site();
      const small = await h.phone({ viewport: { width: 320, height: 568 } });
      await h.open(small.page, site.url);
      await tour(h, small.page, (where) => audit(h, small.page, where + ' at 320 px'));
      h.clean(small.page);

      const side = await h.phone({ viewport: { width: 844, height: 390 } });
      await h.open(side.page, site.url);
      await startJob(h, side.page, { location: 'Sideways' });
      await gotoStep(h, side.page, 'heights');
      await side.page.evaluate(() => window.scrollTo(0, 200));
      const room = await side.page.evaluate(() => {
        const top = document.querySelector('.top').getBoundingClientRect();
        const foot = document.querySelector('.foot').getBoundingClientRect();
        return { headerBottom: top.bottom, footerTop: foot.top, height: window.innerHeight };
      });
      assert.ok(room.headerBottom <= 0, 'the header scrolls away when the phone is on its side');
      assert.ok(room.footerTop >= room.height, 'so does the footer, leaving the whole screen for the form');
      await side.page.locator('#f-gOther').fill('3.3');
      await h.tap(side.page, '[data-act="step-next"]');
      await side.page.waitForSelector('#f-span1');
      h.clean(side.page);
    },
  },

  {
    name: 'keyboard-and-addresses',
    title: 'The keyboard, the Back button, and addresses that lead nowhere',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Keys' });

      // Enter moves to the next box. After the last one, the keyboard is put away.
      await page.locator('#f-tagMap').focus();
      await page.keyboard.type('A1');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'f-tagField');
      await page.keyboard.type('A1');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'f-testTreat');
      assert.equal(await page.inputValue('#f-tagField'), 'A1');
      await page.locator('#f-angle').focus();
      await page.keyboard.press('Enter');
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'f-angle');

      // A keyboard user can see where they are.
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return { tag: document.activeElement.tagName, width: parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      assert.ok(ring.width >= 2 && ring.style !== 'none', 'the focused control has a visible ring: ' + JSON.stringify(ring));

      // A sheet keeps the keyboard inside it, closes with Escape, and gives focus back.
      await gotoStep(h, page, 'photos');
      await page.locator('[data-act="pole-delete"]').focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('#modal .sheet');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-sheet')), 'no', 'the safe answer has the focus');
      const seen = new Set();
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        seen.add(await page.evaluate(() => (document.getElementById('modal').contains(document.activeElement) ? document.activeElement.getAttribute('data-sheet') : 'OUTSIDE')));
      }
      assert.deepEqual([...seen].sort(), ['no', 'yes'], 'Tab stays inside the sheet');
      await page.keyboard.press('Shift+Tab');
      assert.ok(await page.evaluate(() => document.getElementById('modal').contains(document.activeElement)));
      await page.keyboard.press('Escape');
      assert.equal(await h.count(page, '#modal .sheet'), 0);
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-act')), 'pole-delete', 'focus returns to the button that opened the sheet');
      assert.ok(await h.count(page, '[data-act="pole-delete"]'), 'Escape answered "no"');

      // A new screen starts at its heading, so a screen reader announces it.
      await h.tap(page, '[data-act="step-back"]');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Step 5 of 6: Spans');

      // The phone's Back button walks back through the screens, and closes an open sheet on the way.
      const here = () => page.evaluate(() => location.hash);
      const poleHash = await here();
      assert.match(poleHash, /\/spans$/);
      await page.goBack();
      assert.match(await here(), /\/pole$/, 'Back returns to the screen that was open before');
      assert.equal(await h.text(page, '[data-heading]'), 'STEP 1 OF 6: POLE');
      await page.goForward();
      assert.equal(await here(), poleHash);
      assert.equal(await h.text(page, '[data-heading]'), 'STEP 5 OF 6: SPANS');
      await gotoStep(h, page, 'photos');
      await h.tap(page, '[data-act="pole-delete"]');
      await page.waitForSelector('#modal .sheet');
      await page.goBack();
      await page.waitForFunction(() => !document.querySelector('#modal .sheet'));
      assert.ok(await h.count(page, '#app [data-heading]'));

      // Addresses that lead nowhere land on a real screen.
      const poleId = poleHash.split('/')[2];
      for (const [hash, expected] of [
        ['#/nowhere', /^(#\/)?$/],
        ['#/job/no-such-job', /^(#\/)?$/],
        ['#/job/no-such-job/details', /^(#\/)?$/],
        ['#/pole/no-such-pole/heights', /^(#\/)?$/],
        ['#/job/%E0%A4%A', /^(#\/)?$/],
        ['#/settings/extra', /^(#\/)?$/],
        ['#not-even-a-path', /^(#\/)?$|^#not-even-a-path$/],
        ['#/pole/' + poleId + '/no-such-step', new RegExp('^#/pole/' + poleId + '/no-such-step$')],
      ]) {
        await page.evaluate((to) => { location.hash = to; }, hash);
        await h.pause(page, 250);
        assert.match(await here(), expected, hash);
        assert.ok(await h.count(page, '#app [data-heading]'), hash + ' shows a screen');
      }
      assert.equal(await h.text(page, '[data-heading]'), 'STEP 1 OF 6: POLE', 'an unknown step opens the first step');

      // A link to a pole that has been deleted goes to its job.
      await gotoStep(h, page, 'photos');
      await h.tap(page, '[data-act="pole-delete"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('[data-act="add-pole"]');
      const jobHash = await here();
      await page.evaluate((to) => { location.hash = to; }, poleHash);
      await h.pause(page, 300);
      assert.equal(await here(), jobHash);
      await page.reload();
      await page.waitForSelector('[data-act="add-pole"]');
      h.clean(page);
    },
  },

  {
    name: 'storage',
    title: 'Storage: nearly full, not reported, and asking the phone to protect it',
    async run(h) {
      const site = await h.site();
      const nearlyFull = await h.phone({
        initScripts: [() => {
          navigator.storage.estimate = async () => ({ usage: 850 * 1024 * 1024, quota: 1000 * 1024 * 1024 });
          navigator.storage.persisted = async () => Boolean(window.__kept);
          navigator.storage.persist = async () => {
            window.__kept = true;
            return true;
          };
        }],
      });
      await h.open(nearlyFull.page, site.url);
      await nearlyFull.page.waitForSelector('.notice.warn');
      assert.match(await h.text(nearlyFull.page, '.notice.warn'), /nearly out of space/);
      await h.tap(nearlyFull.page, '[data-act="open-settings"]');
      await nearlyFull.page.waitForFunction(() => /850 MB of 1000 MB allowed/.test(document.querySelector('#storage-box').textContent));
      assert.match(await h.text(nearlyFull.page, '#storage-box'), /Protected from clean-up\s*Yes|Protected from clean-up\s*No/);
      h.clean(nearlyFull.page);

      const silent = await h.phone({
        initScripts: [() => {
          navigator.storage.estimate = undefined;
          navigator.storage.persisted = undefined;
          navigator.storage.persist = undefined;
        }],
      });
      await h.open(silent.page, site.url);
      assert.equal(await h.count(silent.page, '.notice.warn'), 0);
      await h.tap(silent.page, '[data-act="open-settings"]');
      await silent.page.waitForFunction(() => /does not report it/.test(document.querySelector('#storage-box').textContent));
      assert.match(await h.text(silent.page, '#storage-box'), /Space used\s*This phone does not report it[\s\S]*Protected from clean-up\s*This phone does not report it/);
      h.clean(silent.page);

      const unprotected = await h.phone({
        initScripts: [() => {
          let kept = false;
          navigator.storage.persisted = async () => kept;
          navigator.storage.persist = async () => {
            window.__asked = (window.__asked || 0) + 1;
            kept = window.__asked > 1;
            return kept;
          };
        }],
      });
      await h.open(unprotected.page, site.url);
      await h.tap(unprotected.page, '[data-act="open-settings"]');
      await unprotected.page.waitForSelector('[data-act="storage-protect"]');
      assert.match(await h.text(unprotected.page, '#storage-box'), /Protected from clean-up\s*No/);
      await h.tap(unprotected.page, '[data-act="storage-protect"]');
      await unprotected.page.waitForFunction(() => /Protected from clean-up\s*Yes/.test(document.querySelector('#storage-box').textContent));
      assert.equal(await h.count(unprotected.page, '[data-act="storage-protect"]'), 0);
      h.clean(unprotected.page);
    },
  },

  {
    name: 'search-and-install',
    title: 'Finding a job, and the prompts to install the app',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      const jobs = [['Alder St', 'D-100', 'AL-1'], ['Birch Rd', 'D-200', 'BI-7'], ['Cedar Ave', 'D-300', 'CE-3'], ['Dogwood St', 'D-400', 'DO-9'], ['Elm Cres', 'D-500', 'EL-2']];
      for (const [location, designNo, tag] of jobs) {
        await startJob(h, page, { location, designNo });
        await answer(h, page, { tagField: tag });
        await h.tap(page, '[data-act="step-back"]');
        await h.tap(page, '[data-act="back"]');
        await page.waitForSelector('[data-act="new-job"]');
      }
      assert.equal(await h.count(page, '#job-search'), 0, 'five jobs need no search box');
      await startJob(h, page, { location: 'Fir Pl', designNo: 'D-600' });
      await answer(h, page, { tagField: 'FI-5' });
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('#job-search');
      const names = () => page.locator('#job-cards .name').allInnerTexts();
      assert.equal((await names()).length, 6);
      assert.equal((await names())[0], 'Fir Pl', 'the job worked on last is at the top');

      await page.locator('#job-search').fill('dog');
      assert.deepEqual(await names(), ['Dogwood St']);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'job-search');
      await page.locator('#job-search').fill('d-300');
      assert.deepEqual(await names(), ['Cedar Ave'], 'a design number finds its job');
      await page.locator('#job-search').fill('BI-7');
      assert.deepEqual(await names(), ['Birch Rd'], 'a pole tag finds its job');
      await page.locator('#job-search').fill('zzz');
      assert.match(await h.text(page, '#job-cards .empty'), /No job matches "zzz"/);
      await page.locator('#job-search').fill('');
      assert.equal((await names()).length, 6);
      h.clean(page);

      // An iPhone in Safari is told to add the app to the Home Screen first.
      const iphone = await h.phone({ userAgent: IPHONE });
      await h.open(iphone.page, site.url);
      assert.match(await h.text(iphone.page, '.notice.warn'), /First, add this app to your Home Screen/);
      await h.tap(iphone.page, '[data-act="ios-install-help"]');
      assert.match(await h.text(iphone.page, '#modal'), /Add to Home Screen[\s\S]*Share[\s\S]*Add to Home Screen[\s\S]*stays in Safari/);
      await h.shot(iphone.page, '19-iphone-install');
      await h.tap(iphone.page, '#modal [data-sheet="ok"]');
      h.clean(iphone.page);

      // Opened from the Home Screen, the reminder is gone.
      const installed = await h.phone({ userAgent: IPHONE, initScripts: [() => { Object.defineProperty(navigator, 'standalone', { value: true }); }] });
      await h.open(installed.page, site.url);
      assert.equal(await h.count(installed.page, '[data-act="ios-install-help"]'), 0);
      h.clean(installed.page);

      // On Android the browser offers an install prompt, and the app passes it on.
      const android = await h.phone();
      await h.open(android.page, site.url);
      assert.equal(await h.count(android.page, '[data-act="install-app"]'), 0);
      await android.page.evaluate(() => {
        const event = new Event('beforeinstallprompt');
        event.prompt = async () => { window.__prompted = true; };
        event.userChoice = Promise.resolve({ outcome: 'accepted' });
        window.dispatchEvent(event);
      });
      await android.page.waitForSelector('[data-act="install-app"]');
      await h.tap(android.page, '[data-act="install-app"]');
      await android.page.waitForFunction(() => window.__prompted === true);
      await android.page.waitForFunction(() => !document.querySelector('[data-act="install-app"]'));
      h.clean(android.page);
    },
  },

  {
    name: 'start-up-trouble',
    title: 'Start-up trouble: no storage, a newer version, and a file that fails to load',
    async run(h) {
      const site = await h.site();

      // The browser refuses to give the app any storage (some private modes do this).
      const blocked = await h.phone({ initScripts: [() => { IDBFactory.prototype.open = () => { throw new DOMException('Storage is disabled', 'SecurityError'); }; }] });
      await blocked.page.goto(site.url);
      await blocked.page.waitForSelector('.banner.bad');
      assert.match(await h.text(blocked.page, '.banner.bad'), /Storage is not available[\s\S]*Private Browsing/);
      assert.equal(await h.count(blocked.page, '[data-act="new-job"]'), 0, 'the app does not pretend it can record anything');
      assert.ok(await h.count(blocked.page, '[data-act="reload"]'));
      h.clean(blocked.page, ['Storage is disabled']);

      // A newer version of the app has changed the database while this copy was open.
      const { page, context } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Outdated' });
      await answer(h, page, { tagField: 'O-1' });
      await h.saved(page);
      const other = await h.newPage(context);
      await other.goto(site.url + 'fonts/LICENSE-IBM-Plex-Sans.txt');
      await other.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('polefield@/', 99);
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
      }));
      await page.waitForSelector('.banner.bad');
      assert.match(await h.text(page, '.banner.bad'), /Reload needed[\s\S]*Everything is saved/);
      await h.tap(page, '[data-act="reload"]');
      await page.waitForSelector('.banner.bad');
      assert.match(await h.text(page, '.banner.bad'), /Reload needed[\s\S]*newer version of the app has already been used/);
      assert.equal((await h.stored(other, 'polefield@/')).poles[0].f.tagField, 'O-1', 'the data is still there for the newer version');
      h.clean(page, ['VersionError', 'newer version']);

      // A file fails to load, so the app cannot start. The user is told, instead of staring at "Opening".
      const broken = await h.serve(h.ROOT, { intercept: (file) => (file === 'src/main.js' ? { status: 500, type: 'text/plain', body: 'broken' } : undefined) });
      const stuck = await h.phone({ serviceWorkers: 'block' });
      await stuck.page.goto(broken.url);
      assert.match(await h.text(stuck.page, '#boot'), /Opening Pole Field Data/);
      await stuck.page.waitForFunction(() => /did not start/.test(document.querySelector('#boot').textContent), null, { timeout: 20000 });
      assert.match(await h.text(stuck.page, '#boot'), /The app did not start\. Check that you have signal, then reload/);
    },
  },

  {
    name: 'large-job',
    title: 'A large job: 40 poles and 120 photos, restored, exported and backed up',
    async run(h) {
      const site = await h.site();
      const file = await bigBackup(h, 40, 3);
      const { page } = await h.phone();
      await h.open(page, site.url);
      await h.tap(page, '[data-act="open-settings"]');
      await page.waitForSelector('#set-name');

      const timings = {};
      const timed = async (name, work) => {
        const begun = Date.now();
        const result = await work();
        timings[name] = ((Date.now() - begun) / 1000).toFixed(1) + ' s';
        return result;
      };

      await timed('restore', async () => {
        await page.setInputFiles('#backup-file', file);
        await h.tap(page, '#modal [data-sheet="yes"]');
        await page.waitForSelector('#modal [data-sheet="ok"]', { timeout: 240000 });
      });
      assert.match(await h.text(page, '#modal'), /Added: 1 job, 40 poles, 120 photos\./);
      await h.tap(page, '#modal [data-sheet="ok"]');
      await h.saved(page);
      const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage);

      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('[data-act="open-job"]');
      assert.match(await h.text(page, '[data-act="open-job"]'), /32 of 40 poles done/);
      const drawn = await page.evaluate(async () => {
        const begun = performance.now();
        document.querySelector('[data-act="open-job"]').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { ms: performance.now() - begun, cards: document.querySelectorAll('[data-act="open-pole"]').length };
      });
      assert.equal(drawn.cards, 40);
      assert.ok(drawn.ms < 800, 'the job screen with 40 poles draws quickly: ' + Math.round(drawn.ms) + ' ms');
      timings['draw 40 poles'] = Math.round(drawn.ms) + ' ms';

      // Typing stays quick with this much on the phone.
      await h.tap(page, page.locator('[data-act="open-pole"]').nth(20));
      await page.waitForSelector('#f-testTreat');
      const typing = await page.evaluate(() => {
        const input = document.querySelector('#f-testTreat');
        const begun = performance.now();
        for (let i = 0; i < 30; i += 1) {
          input.value += 'x';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return (performance.now() - begun) / 30;
      });
      assert.ok(typing < 16, 'each keystroke is handled within one screen refresh: ' + typing.toFixed(1) + ' ms');
      timings['per keystroke'] = typing.toFixed(1) + ' ms';
      await gotoStep(h, page, 'photos');
      await thumbs(page, 3);
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-act="step-back"]');
      await page.waitForSelector('[data-act="export-job"]');

      const report = await timed('PDF report', async () => {
        await h.tap(page, '[data-act="export-job"]');
        await h.tap(page, '#modal [data-sheet="pdf"]');
        await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 240000 });
        return downloadReady(h, page);
      });
      const doc = await h.pdf(report.path);
      assert.equal(doc.images.length, 120);
      assert.ok(doc.polePages(40).length >= 1 && doc.polePages(1).length >= 1, 'every pole has its pages');
      assert.ok(doc.pageCount >= 41);
      assert.equal(await h.text(page, '.top .pill'), 'Exported');

      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      await h.fill(page, '#f-testTreat', '2021');
      await h.tap(page, '[data-act="step-back"]');
      const pack = await timed('full package', async () => {
        await h.tap(page, '[data-act="export-job"]');
        await h.tap(page, '#modal [data-sheet="package"]');
        await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 240000 });
        return downloadReady(h, page);
      });
      const zip = await h.py('zip', pack.path);
      assert.equal(zip.badEntry, null);
      assert.equal(zip.entries.filter((entry) => entry.name.startsWith('photos/')).length, 120);
      assert.ok(zip.entries.some((entry) => entry.name === 'photos/P01_T1000_1_Whole_pole.jpg'));
      assert.ok(zip.entries.some((entry) => entry.name === 'photos/P40_T1039_3_Pole_top.jpg'));

      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      const backup = await timed('backup', async () => {
        await h.tap(page, '[data-act="backup-make"]');
        await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 240000 });
        return downloadReady(h, page);
      });
      const backupZip = await h.py('zip', backup.path);
      assert.equal(backupZip.badEntry, null);
      assert.equal(backupZip.entries.length, 361);

      const size = async (f) => ((await h.readFile(f.path)).length / (1024 * 1024)).toFixed(1) + ' MB';
      console.log('       measured: storage ' + (usage / (1024 * 1024)).toFixed(0) + ' MB, ' + Object.entries(timings).map(([k, v]) => k + ' ' + v).join(', '));
      console.log('       files: PDF ' + (await size(report)) + ' (' + doc.pageCount + ' pages), package ' + (await size(pack)) + ', backup ' + (await size(backup)));
      h.clean(page);
    },
  },

  {
    name: 'no-signal-and-updates',
    title: 'No signal: the app opens and exports. Updates: only when asked, and never half-way',
    async run(h) {
      const root = await h.copyProject('site-v1');
      let wrong = null; // a file the server gets wrong, to act out a half-published update
      const options = { intercept: (file) => (wrong && wrong.file === file ? { body: wrong.body } : undefined) };
      let site = await h.serve(root, options);
      const { page, context } = await h.phone();
      await h.open(page, site.url);
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
      await startJob(h, page, { location: 'No signal Rd' });
      await answer(h, page, { tagField: 'N-1' });
      await gotoStep(h, page, 'photos');
      await page.setInputFiles('#lib', h.path.join(h.images, 'landscape.jpg'));
      await thumbs(page, 1);
      await savePole(h, page);
      await h.saved(page);
      const versionBefore = (await page.evaluate(() => caches.keys()))[0];

      // ---- The server goes away: no signal.
      const port = site.port;
      await site.close();
      await context.setOffline(true);
      await page.reload();
      await page.waitForSelector('[data-act="add-pole"]', { timeout: 15000 });
      await h.tap(page, '[data-act="back"]');
      assert.match(await h.text(page, '.banner'), /No signal[\s\S]*1 pole saved on this phone, waiting to export/);
      await h.shot(page, '20-no-signal');
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, '[data-act="add-pole"]');
      await answer(h, page, { tagField: 'N-2' });
      await savePole(h, page);
      // The first report is built only now, with no signal at all.
      await h.tap(page, '[data-act="export-job"]');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      const offlineFile = await downloadReady(h, page);
      const offlineReport = await h.pdf(offlineFile.path);
      assert.ok(offlineReport.polePages(1).length && offlineReport.polePages(2).length);
      assert.equal(offlineReport.poleImages(1).length, 1);
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      assert.equal(await h.text(page, '[data-offline]'), 'Yes');
      await h.tap(page, '[data-act="update-check"]');
      await page.waitForFunction(() => /No signal/.test(document.querySelector('#toast').textContent));
      await h.tap(page, '[data-act="about"]');
      const licence = await page.evaluate(async () => (await fetch('fonts/LICENSE-IBM-Plex-Sans.txt')).text());
      assert.match(licence, /SIL OPEN FONT LICENSE/i, 'the licence texts are stored too');
      await h.tap(page, '#modal [data-sheet="ok"]');
      h.clean(page);

      // ---- Signal returns, with a half-published update: sw.js is new, but one file is still old.
      await h.writeFile(h.path.join(root, 'styles.css'), (await h.readFile(h.path.join(root, 'styles.css'), 'utf8')) + '\n/* version two */\n');
      const built = await rebuild(root);
      assert.ok(built.changed);
      wrong = { file: 'styles.css', body: '/* a stale copy from the server */' };
      site = await h.serve(root, { ...options, port });
      await context.setOffline(false);
      await h.tap(page, '[data-act="update-check"]');
      await h.pause(page, 3500);
      assert.equal(await h.count(page, '[data-act="update-now"]'), 0, 'a download that does not match is thrown away, and no update is offered');
      assert.deepEqual(await page.evaluate(() => caches.keys()), [versionBefore], 'the copy on the phone is untouched');
      await page.reload();
      await page.waitForSelector('#set-name');
      assert.equal(await h.text(page, '[data-offline]'), 'Yes', 'and still in charge');

      // ---- The server finishes publishing. Now the update is offered, but not forced.
      wrong = null;
      await h.tap(page, '[data-act="update-check"]');
      await page.waitForSelector('[data-act="update-now"]', { timeout: 20000 });
      assert.equal((await page.evaluate(() => caches.keys())).length, 2, 'the new copy waits beside the old one');
      await h.tap(page, '[data-act="back"]');
      assert.match(await h.text(page, '.notice'), /A new version is ready/);
      // Work carries on with the old copy until the user chooses.
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      await h.fill(page, '#f-poleClass', 'typed before updating');
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="back"]');
      await Promise.all([page.waitForEvent('load'), h.tap(page, '[data-act="update-now"]')]);
      await page.waitForSelector('[data-act="open-job"]');
      await page.waitForFunction(async () => (await caches.keys()).length === 1, null, { timeout: 10000 });
      const versionAfter = (await page.evaluate(() => caches.keys()))[0];
      assert.notEqual(versionAfter, versionBefore);
      assert.ok(versionAfter.endsWith(built.version));
      assert.match(await page.evaluate(async () => (await (await fetch('styles.css')).text())), /version two/);
      assert.equal(await h.count(page, '[data-act="update-now"]'), 0);
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      assert.equal(await page.inputValue('#f-poleClass'), 'typed before updating', 'nothing was lost across the update');

      // ---- An update switched on from another tab asks this one to reload, without doing it by force.
      await h.writeFile(h.path.join(root, 'styles.css'), (await h.readFile(h.path.join(root, 'styles.css'), 'utf8')) + '\n/* version three */\n');
      await rebuild(root);
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      await h.tap(page, '[data-act="update-check"]');
      await page.waitForSelector('[data-act="update-now"]', { timeout: 20000 });
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      });
      await page.waitForSelector('[data-act="reload"]', { timeout: 10000 });
      assert.match(await h.text(page, '[data-act="reload"]'), /Reload to finish the update/);
      await h.tap(page, '[data-act="back"]');
      assert.match(await h.text(page, '.notice'), /The app was updated in another tab/);
      await Promise.all([page.waitForEvent('load'), h.tap(page, '[data-act="reload"]')]);
      await page.waitForSelector('[data-act="open-job"]');
      assert.match(await page.evaluate(async () => (await (await fetch('styles.css')).text())), /version three/);
      h.clean(page);
    },
  },

  {
    name: 'two-copies',
    title: 'Two copies of the app under one address keep to themselves',
    async run(h) {
      const rootA = await h.copyProject('copy-a');
      const rootB = await h.copyProject('copy-b');
      let aDown = false;
      const a = makeServer(rootA, { mount: '/a/', intercept: () => (aDown ? { status: 503, body: 'down' } : undefined) });
      const b = makeServer(rootB, { mount: '/b/' });
      const router = createServer((request, response) => (request.url.startsWith('/b') ? b : a).emit('request', request, response));
      const site = await h.serve(null, { server: router });
      const { page: pageA, context } = await h.phone();
      await h.open(pageA, site.origin + '/a/');
      await pageA.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
      await startJob(h, pageA, { location: 'Job in copy A' });
      await answer(h, pageA, { tagField: 'A-1' });
      await savePole(h, pageA);
      await h.saved(pageA);

      // The second copy opens in another tab at the same time: no "already open", and no shared data.
      const pageB = await h.newPage(context);
      await h.open(pageB, site.origin + '/b/');
      await pageB.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
      assert.equal(await h.count(pageB, '[data-act="take-over"]'), 0);
      assert.equal(await h.count(pageB, '[data-act="open-job"]'), 0, 'copy B does not see copy A\'s job');
      await startJob(h, pageB, { location: 'Job in copy B' });
      await answer(h, pageB, { tagField: 'B-1' });
      await savePole(h, pageB);
      await h.saved(pageB);
      assert.equal((await h.stored(pageB, 'polefield@/a/')).jobs[0].f.location, 'Job in copy A');
      assert.equal((await h.stored(pageB, 'polefield@/b/')).jobs[0].f.location, 'Job in copy B');
      const before = (await pageB.evaluate(() => caches.keys())).sort();
      assert.equal(before.length, 2);
      assert.ok(before[0].startsWith('polefield@/a/@') && before[1].startsWith('polefield@/b/@'));

      // Copy B is updated. Copy A's stored files must survive that.
      await h.writeFile(h.path.join(rootB, 'styles.css'), (await h.readFile(h.path.join(rootB, 'styles.css'), 'utf8')) + '\n/* copy B, version two */\n');
      await rebuild(rootB);
      await h.tap(pageB, '[data-act="back"]');
      await h.tap(pageB, '[data-act="open-settings"]');
      await h.tap(pageB, '[data-act="update-check"]');
      await pageB.waitForSelector('[data-act="update-now"]', { timeout: 20000 });
      await Promise.all([pageB.waitForEvent('load'), h.tap(pageB, '[data-act="update-now"]')]);
      await pageB.waitForSelector('#set-name');
      await pageB.waitForFunction(async () => (await caches.keys()).length === 2, null, { timeout: 10000 });
      const after = (await pageB.evaluate(() => caches.keys())).sort();
      assert.equal(after[0], before[0], 'copy A\'s stored files were not touched');
      assert.notEqual(after[1], before[1]);

      // With its server down, copy A still opens from its own stored files, with its own data.
      aDown = true;
      await pageA.reload();
      await pageA.waitForSelector('[data-act="add-pole"]', { timeout: 15000 });
      await h.tap(pageA, '[data-act="back"]');
      assert.deepEqual(await pageA.locator('[data-act="open-job"] .name').allInnerTexts(), ['Job in copy A']);
      h.clean(pageA);
      h.clean(pageB);
    },
  },
];
