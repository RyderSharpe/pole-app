// Everyday use: jobs, poles, the form rules, and what survives a reload.

import assert from 'node:assert/strict';
import { startJob, gotoStep, answer, savePole } from './harness.mjs';

const seps = (page) =>
  page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.seps .row')].map((row) => [row.querySelector('.k').textContent, row.querySelector('.v').textContent])));

const blanks = (page) => page.evaluate(() => [...document.querySelectorAll('[data-act="review-goto"]')].map((b) => b.getAttribute('data-key')));

export default [
  {
    name: 'starts-clean',
    title: 'Starts clean, and stores itself for use with no signal',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      assert.equal(await page.title(), 'Pole Field Data');
      assert.equal(await h.text(page, 'h1'), 'Pole Field Data');
      assert.match(await h.text(page, '.empty'), /No jobs yet/);
      assert.ok(await page.locator('[data-act="export-all"]').isDisabled());
      assert.equal(await h.count(page, '.banner'), 0, 'an empty app shows no banner');
      await h.saved(page);
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20000 });
      await h.tap(page, '[data-act="open-settings"]');
      await page.waitForFunction(() => document.querySelector('[data-offline]') && document.querySelector('[data-offline]').textContent === 'Yes', null, { timeout: 20000 });
      const stored = await h.stored(page);
      assert.deepEqual(Object.keys(stored).sort(), ['blobs', 'jobs', 'meta', 'photos', 'poles']);
      assert.equal(stored.jobs.length, 0);
      const caches = await page.evaluate(() => caches.keys());
      assert.equal(caches.length, 1);
      assert.match(caches[0], /^polefield@\/@0\.4\.0-[0-9a-f]{12}$/);
      await h.shot(page, '10-settings');
      h.clean(page);
    },
  },

  {
    name: 'mistaken-taps',
    title: 'A job or pole opened by mistake leaves nothing behind',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);

      await h.tap(page, '[data-act="new-job"]');
      await page.waitForSelector('#f-location');
      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('[data-act="new-job"]');
      assert.equal(await h.count(page, '[data-act="open-job"]'), 0, 'the untouched job is gone from the list');
      await h.saved(page);
      assert.equal((await h.stored(page)).jobs.length, 0, 'and from the phone');

      await h.tap(page, '[data-act="new-job"]');
      await h.fill(page, '#f-location', 'Keep me');
      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('[data-act="add-pole"]');
      assert.match(await h.text(page, '.empty'), /No poles yet/);

      await h.tap(page, '[data-act="add-pole"]');
      await page.waitForSelector('#f-tagMap');
      await h.tap(page, '[data-act="step-back"]');
      await page.waitForSelector('[data-act="add-pole"]');
      assert.equal(await h.count(page, '[data-act="open-pole"]'), 0, 'the untouched pole is gone');
      await h.saved(page);
      assert.equal((await h.stored(page)).poles.length, 0);

      await h.tap(page, '[data-act="add-pole"]');
      await h.fill(page, '#f-tagMap', 'A1');
      await h.tap(page, '[data-act="step-back"]');
      await page.waitForSelector('[data-act="open-pole"]');
      assert.equal(await h.count(page, '[data-act="open-pole"]'), 1, 'a pole with an entry stays');

      // Opening it again and leaving does not remove it, even though nothing new was typed.
      await h.tap(page, '[data-act="open-pole"]');
      await h.tap(page, '[data-act="step-back"]');
      assert.equal(await h.count(page, '[data-act="open-pole"]'), 1);

      await h.tap(page, '[data-act="back"]');
      assert.equal(await h.count(page, '[data-act="open-job"]'), 1);
      assert.match(await h.text(page, '[data-act="open-job"] .name'), /Keep me/);
      await h.saved(page);
      const stored = await h.stored(page);
      assert.deepEqual([stored.jobs.length, stored.poles.length], [1, 1]);
      h.clean(page);
    },
  },

  {
    name: 'details-and-first-pole',
    title: 'Job details lead into pole 1, and the name is remembered',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await h.tap(page, '[data-act="new-job"]');
      const today = await page.evaluate(() => {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      });
      assert.equal(await page.inputValue('#f-date'), today);
      assert.equal(await page.inputValue('#f-collectedBy'), '');
      assert.equal(await h.text(page, '[data-act="details-done"]'), 'Next: Pole 1');
      await h.fill(page, '#f-location', 'Dogwood St at 5th Ave');
      assert.equal(await h.text(page, '[data-job-title]'), 'Dogwood St at 5th Ave', 'the header follows the typing');
      await h.fill(page, '#f-date', 'Oct 4, afternoon');
      await h.fill(page, '#f-collectedBy', 'R. Sharpe');
      await h.fill(page, '#f-designNo', 'DES-10442');
      await h.shot(page, '02-job-details');
      await h.tap(page, '[data-act="details-done"]');
      await page.waitForSelector('#f-tagMap');
      assert.equal(await h.text(page, '.where .t'), 'Dogwood St at 5th Ave');
      assert.equal(await h.text(page, '[data-pole-sub]'), 'Pole 1 of 1');
      assert.equal(await h.text(page, '[data-heading]'), 'STEP 1 OF 6: POLE');
      await h.fill(page, '#f-tagField', 'A1234');
      assert.equal(await h.text(page, '[data-pole-sub]'), 'Pole 1 of 1 · A1234');
      assert.equal(await page.title(), 'Pole 1: Pole · Pole Field Data');

      // Back out to the job, then its details: the date typed as free text is kept as typed.
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="edit-details"]');
      assert.equal(await page.inputValue('#f-date'), 'Oct 4, afternoon');
      assert.equal(await h.text(page, '[data-act="details-done"]'), 'Done');
      await h.tap(page, '[data-act="details-done"]');
      await page.waitForSelector('[data-act="add-pole"]');
      assert.match(await h.text(page, '.card.quiet'), /Oct 4, afternoon[\s\S]*R\. Sharpe/);
      await h.tap(page, '[data-act="back"]');

      await h.tap(page, '[data-act="new-job"]');
      assert.equal(await page.inputValue('#f-collectedBy'), 'R. Sharpe', 'the name carries over to the next job');
      await h.tap(page, '[data-act="back"]');
      assert.equal(await h.count(page, '[data-act="open-job"]'), 1, 'the second job held only the remembered name, so it was removed');
      h.clean(page);
    },
  },

  {
    name: 'tag-warnings',
    title: 'Tag warnings appear and clear while typing',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Tags' });
      await h.fill(page, '#f-tagMap', 'A1234');
      await h.fill(page, '#f-tagField', 'A1235');
      assert.equal(await h.text(page, '#h-tagField'), 'Does not match the map tag');
      assert.ok(await page.locator('#f-tagField.alert').count());
      assert.equal(await page.getAttribute('#f-tagField', 'aria-describedby'), 'h-tagField');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'f-tagField', 'the keyboard stays on the field being typed in');
      await h.fill(page, '#f-tagField', ' a1234 ');
      assert.ok(await page.locator('#h-tagField').isHidden(), 'case and spaces do not count as a mismatch');
      assert.equal(await page.locator('#f-tagField.alert').count(), 0);
      await h.fill(page, '#f-tagField', '');

      await gotoStep(h, page, 'photos');
      assert.ok((await blanks(page)).includes('tagField'));
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-choice="tagStatus"][data-v="Missing"]');
      await gotoStep(h, page, 'photos');
      assert.ok(!(await blanks(page)).includes('tagField'), 'a missing tag cannot be read, so it is not chased');
      h.clean(page);
    },
  },

  {
    name: 'choices',
    title: 'Choices select, keep a quick second tap, clear on a later one with Undo, and switch N/A',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Choices' });
      const ok = page.locator('[data-choice="tagStatus"][data-v="OK"]');
      assert.equal(await ok.getAttribute('aria-pressed'), 'false');
      await h.tap(page, ok);
      assert.equal(await ok.getAttribute('aria-pressed'), 'true');
      assert.ok(await page.locator('[data-choice="tagStatus"].on').count() === 1);
      const damaged = page.locator('[data-choice="tagStatus"][data-v="Damaged"]');
      await h.tap(page, damaged);
      assert.equal(await page.locator('[data-choice="tagStatus"].on').getAttribute('data-v'), 'Damaged');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-v')), 'Damaged', 'focus stays on the answer just chosen');
      // A gloved "did that work?" tap a moment later keeps the answer.
      await h.tap(page, damaged);
      assert.equal(await page.locator('[data-choice="tagStatus"].on').getAttribute('data-v'), 'Damaged', 'a quick second tap keeps the answer');
      // A deliberate tap later clears it, says so, and offers Undo.
      await h.pause(page, 1600);
      await h.tap(page, damaged);
      assert.equal(await page.locator('[data-choice="tagStatus"].on').count(), 0, 'a later tap on the chosen option clears it');
      assert.match(await h.text(page, '#toast'), /Answer cleared/);
      await h.tap(page, '#toast [data-toast-action]');
      assert.equal(await page.locator('[data-choice="tagStatus"].on').getAttribute('data-v'), 'Damaged', 'Undo brings it back');

      await gotoStep(h, page, 'equipment');
      assert.ok(await page.locator('[data-item="xfmr"] .seg.c4').count(), 'four options sit on one line');
      await h.shot(page, '04-equipment');

      await gotoStep(h, page, 'anchors');
      await h.tap(page, '[data-choice="powerAnchor"][data-v="Yes"]');
      await answer(h, page, { powerSlots: '2 of 3', powerPlate: '10 ft', powerRod: '3/4 in' });
      const below = page.locator('[data-item="telAnchor"]');
      const before = (await below.boundingBox()).y;
      await h.tap(page, '[data-choice="powerAnchor"][data-v="No"]');
      for (const key of ['powerSlots', 'powerPlate', 'powerRod']) {
        assert.equal(await h.text(page, '[data-item="' + key + '"] .na'), 'N/A');
        assert.equal(await h.count(page, '#f-' + key), 0);
      }
      const moved = Math.abs((await below.boundingBox()).y - before);
      assert.ok(moved <= 40, 'answering "No" moves the next question by ' + Math.round(moved) + ' px at most');
      assert.ok(await page.locator('#f-telSlots').isVisible(), 'the other anchors are not affected');
      await h.shot(page, '05-anchors');
      await h.tap(page, '[data-choice="powerAnchor"][data-v="Yes"]');
      assert.equal(await page.inputValue('#f-powerSlots'), '2 of 3', 'what was typed comes back');
      h.clean(page);
    },
  },

  {
    name: 'double-tap',
    title: 'A slip of the finger cannot skip a screen',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Slips' });
      const step = () => page.evaluate(() => location.hash.split('/').pop());
      const middle = async (selector) => {
        const box = await page.locator(selector).first().boundingBox();
        return [box.x + box.width / 2, box.y + box.height / 2];
      };
      await h.pause(page, 700);

      // Two taps 90 ms apart on "Next": one step only.
      let [x, y] = await middle('[data-act="step-next"]');
      await page.mouse.click(x, y);
      await h.pause(page, 90);
      await page.mouse.click(x, y);
      await h.pause(page, 200);
      assert.equal(await step(), 'equipment');

      // A slower second tap, 450 ms later, lands on the new screen's button in the same spot. Still ignored.
      await h.pause(page, 600);
      [x, y] = await middle('[data-act="step-next"]');
      await page.mouse.click(x, y);
      await h.pause(page, 450);
      await page.mouse.click(x, y);
      await h.pause(page, 200);
      assert.equal(await step(), 'anchors', 'only one of the two taps counted');

      // A deliberate tap after a normal pause works.
      await h.pause(page, 650);
      await page.mouse.click(x, y);
      await h.pause(page, 200);
      assert.equal(await step(), 'heights');

      // Quick taps on two different buttons both count.
      await gotoStep(h, page, 'equipment');
      await h.pause(page, 650);
      const [ax, ay] = await middle('[data-choice="xfmr"][data-v="1Ø"]');
      const [bx, by] = await middle('[data-choice="secondary"][data-v="3Ø"]');
      await page.mouse.click(ax, ay);
      await h.pause(page, 120);
      await page.mouse.click(bx, by);
      await h.pause(page, 150);
      assert.equal(await page.locator('[data-choice="xfmr"].on').getAttribute('data-v'), '1Ø');
      assert.equal(await page.locator('[data-choice="secondary"].on').getAttribute('data-v'), '3Ø');

      // The keyboard works too: Enter on a focused button.
      await page.locator('[data-act="step-next"]').focus();
      await page.keyboard.press('Enter');
      await h.pause(page, 200);
      assert.equal(await step(), 'anchors');
      h.clean(page);
    },
  },

  {
    name: 'numbers',
    title: 'Numbers, N/A and the separations card',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Numbers' });
      await gotoStep(h, page, 'equipment');
      await h.tap(page, '[data-choice="secondary"][data-v="1Ø"]');
      await gotoStep(h, page, 'heights');
      assert.deepEqual(await seps(page), { 'Neutral to primary bolt': 'not entered', 'Secondary to neutral': 'not entered', 'Telecom to lowest neutral or secondary': 'not entered', 'Lowest neutral or secondary': 'not entered' });

      await answer(h, page, { gP: '9.4', gN: '8.1', gS: '7.9', gT: '6.2' });
      assert.deepEqual(await seps(page), { 'Neutral to primary bolt': '1.30 m', 'Secondary to neutral': '0.20 m', 'Telecom to lowest neutral or secondary': '1.70 m', 'Lowest neutral or secondary': '7.90 m' });
      assert.equal(await page.getAttribute('#f-gP', 'inputmode'), 'decimal');
      await h.shot(page, '06-heights');

      // The way people really type.
      await answer(h, page, { gP: '9,4 m', gN: ' 8.1m' });
      assert.equal((await seps(page))['Neutral to primary bolt'], '1.30 m');

      // An unreadable entry.
      await h.fill(page, '#f-gN', '8.1.');
      assert.equal((await seps(page))['Neutral to primary bolt'], 'check entry');
      assert.match(await h.text(page, '#h-gN'), /Not a number the app can read/);
      assert.ok(await page.locator('#f-gN.alert').count());
      await h.fill(page, '#f-gN', '8.1');
      assert.ok(await page.locator('#h-gN').isHidden());

      // A slipped decimal point.
      await h.fill(page, '#f-gT', '62');
      assert.match(await h.text(page, '#h-gT'), /Usually 3 to 15 m/);
      assert.equal((await seps(page))['Telecom to lowest neutral or secondary'], '-54.10 m');
      assert.ok(await page.locator('.seps .v.neg').count(), 'a negative separation stands out');
      await h.fill(page, '#f-gT', '6.2');

      // Measured wire to wire.
      assert.equal(await h.count(page, '#f-mP'), 0);
      await h.tap(page, '[data-toggle="ww"]');
      assert.equal(await page.getAttribute('[data-toggle="ww"]', 'aria-pressed'), 'true');
      await answer(h, page, { mP: '1.25' });
      assert.equal((await seps(page))['Neutral to primary bolt'], '1.25 m', 'the direct measurement wins');
      assert.equal((await seps(page))['Secondary to neutral'], '0.20 m', 'rows with no direct measurement are still worked out');
      await h.shot(page, '07-wire-to-wire');
      await h.tap(page, '[data-toggle="ww"]');
      assert.equal((await seps(page))['Neutral to primary bolt'], '1.30 m', 'switched off, the measured value no longer counts');

      // No secondary on the pole.
      await gotoStep(h, page, 'equipment');
      await h.tap(page, '[data-choice="secondary"][data-v="None"]');
      await gotoStep(h, page, 'heights');
      assert.equal(await h.text(page, '[data-item="gS"] .na'), 'N/A');
      const now = await seps(page);
      assert.equal(now['Secondary to neutral'], 'not entered');
      assert.equal(now['Lowest neutral or secondary'], '8.10 m');
      assert.equal(now['Telecom to lowest neutral or secondary'], '1.90 m');

      // Other heights follow the equipment answers.
      assert.ok(await page.locator('#f-gDip').isVisible());
      await gotoStep(h, page, 'equipment');
      await h.tap(page, '[data-choice="powerDip"][data-v="No"]');
      await h.tap(page, '[data-choice="streetLight"][data-v="No"]');
      await gotoStep(h, page, 'heights');
      assert.equal(await h.text(page, '[data-item="gDip"] .na'), 'N/A');
      assert.equal(await h.text(page, '[data-item="gSL"] .na'), 'N/A');
      h.clean(page);
    },
  },

  {
    name: 'review-list',
    title: 'The "before you save" list finds blanks and warnings, and jumps to them',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Review' });
      await answer(h, page, { tagMap: 'A1', tagField: 'A2' });
      await gotoStep(h, page, 'equipment');
      await answer(h, page, { secondary: ['1Ø'], telPlant: ['Yes'] });
      await gotoStep(h, page, 'heights');
      await answer(h, page, { gP: '8.1', gN: '9.4' });
      await gotoStep(h, page, 'photos');

      const list = await blanks(page);
      for (const key of ['tagField', 'separations', 'tagStatus', 'height', 'gS', 'gT', 'span1']) assert.ok(list.includes(key), key + ' should be listed');
      for (const key of ['tagMap', 'gP', 'gN', 'secondary', 'mP']) assert.ok(!list.filter((k, i) => i >= 2).includes(key) || key === 'tagMap', key);
      assert.match(await h.text(page, '.review'), /CHECK THESE \(2\)[\s\S]*Does not match the map tag[\s\S]*below zero/);
      await h.shot(page, '09-review');

      // Jump to a blank far down another step: the field must be on screen and ready to type in.
      await h.tap(page, '[data-act="review-goto"][data-key="gT"]');
      await page.waitForFunction(() => location.hash.endsWith('/heights'));
      await h.pause(page, 150);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'f-gT');
      const box = await page.locator('#f-gT').boundingBox();
      assert.ok(box.y > 130 && box.y + box.height < 844 - 110, 'the field is in view between the header and the footer, at y=' + Math.round(box.y));

      // Jump to a field low on a long step: the page must have scrolled to it.
      await gotoStep(h, page, 'photos');
      await h.tap(page, '[data-act="review-goto"][data-key="height"]');
      await page.waitForFunction(() => location.hash.endsWith('/pole'));
      await h.pause(page, 150);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'f-height');
      assert.ok((await page.evaluate(() => window.scrollY)) > 100, 'the page scrolled down to the field instead of staying at the top');

      // Switching to "wire to wire" changes what is asked for. It does not empty the list.
      await gotoStep(h, page, 'heights');
      await h.tap(page, '[data-toggle="ww"]');
      await gotoStep(h, page, 'photos');
      const measured = await blanks(page);
      for (const key of ['mP', 'mS', 'mT']) assert.ok(measured.includes(key), key + ' should be listed once wire to wire is on');
      for (const key of ['gS', 'gT']) assert.ok(!measured.includes(key), key);

      // The job screen shows the same counts.
      await h.tap(page, '[data-act="step-next"]');
      await page.waitForSelector('[data-act="add-pole"]');
      assert.match(await h.text(page, '[data-act="open-pole"] .sub'), /0 photos · \d+ left blank · \d+ to check/);
      h.clean(page);
    },
  },

  {
    name: 'save-and-reload',
    title: 'Saving a pole, and everything surviving a reload',
    async run(h) {
      const site = await h.site();
      const { page, context } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Reload Rd', designNo: '00077' });
      await answer(h, page, { tagMap: '0042', tagField: '0042', tagStatus: ['OK'], poleType: ['Wood'], condition: ['Good'], height: '45', poleClass: '4' });
      await h.shot(page, '03-pole');
      await savePole(h, page);
      await h.shot(page, '11-job');
      assert.match(await h.text(page, '#toast'), /Pole 1 saved on this phone/);
      assert.equal(await h.text(page, '[data-act="open-pole"] .pill'), 'Done');
      assert.equal(await h.text(page, '[data-act="open-pole"] .code'), '0042');
      assert.equal(await h.text(page, '.top .pill'), 'Waiting to export');

      // One tap on the back arrow reaches the job list.
      await h.tap(page, '[data-act="back"]');
      await page.waitForSelector('[data-act="new-job"]');
      assert.match(await h.text(page, '.banner'), /Not exported yet[\s\S]*1 pole saved on this phone only/);
      assert.match(await h.text(page, '[data-act="open-job"]'), /Reload Rd[\s\S]*00077[\s\S]*1 of 1 pole done[\s\S]*Waiting to export/);
      await h.shot(page, '01-home');
      // And the phone's own Back button leaves the app rather than wandering back through the steps.
      assert.equal(await page.evaluate(() => history.state.trail.length), 1);

      await h.saved(page);
      await page.reload();
      await page.waitForSelector('[data-act="open-job"]');
      assert.match(await h.text(page, '[data-act="open-job"]'), /Reload Rd/);
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, '[data-act="open-pole"]');
      assert.equal(await page.inputValue('#f-tagMap'), '0042', 'leading zeros are kept');
      assert.equal(await page.inputValue('#f-height'), '45');
      assert.equal(await page.locator('[data-choice="condition"].on').getAttribute('data-v'), 'Good');

      // A reload in the middle of a pole returns to the same step.
      await gotoStep(h, page, 'spans');
      await h.fill(page, '#f-span1', 'North, 42 m');
      await h.saved(page);
      await page.reload();
      await page.waitForSelector('#f-span1');
      assert.equal(await page.inputValue('#f-span1'), 'North, 42 m');

      // Typing, then the app being closed within the same instant: nothing is lost.
      await h.fill(page, '#f-span2', 'typed just before the app was closed');
      const journal = await page.evaluate(() => {
        window.dispatchEvent(new Event('pagehide'));
        // Read in the same breath, before the ordinary save has had any chance to finish.
        return Object.keys(localStorage).filter((key) => key.includes('journal')).map((key) => JSON.parse(localStorage.getItem(key)));
      });
      assert.equal(journal.length, 1, 'a crash-proof copy is written the moment the app is hidden');
      assert.equal(journal[0].poles[0].f.span2, 'typed just before the app was closed');
      await page.close();
      const again = await h.newPage(context);
      await h.open(again, site.url);
      await h.tap(again, '[data-act="open-job"]');
      await h.tap(again, '[data-act="open-pole"]');
      await gotoStep(h, again, 'spans');
      assert.equal(await again.inputValue('#f-span2'), 'typed just before the app was closed');
      await h.saved(again);
      assert.equal(await again.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('journal')).length), 0, 'the copy is cleared once the database has it');
      h.clean(again);
    },
  },

  {
    name: 'second-pole',
    title: 'A second pole, a repeated tag, and the company names',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Names' });
      await answer(h, page, { tagField: 'B200' });
      await gotoStep(h, page, 'equipment');
      assert.match(await h.text(page, '[data-item="powerDip"] .label'), /^Power dip$/);
      assert.match(await h.text(page, '[data-item="telPlant"] .label'), /^Telecom plant on pole$/);
      await savePole(h, page);

      await h.tap(page, '[data-act="add-pole"]');
      await page.waitForSelector('#f-tagField');
      assert.equal(await h.text(page, '[data-pole-sub]'), 'Pole 2 of 2');
      await h.fill(page, '#f-tagField', 'b200');
      assert.equal(await h.text(page, '#h-tagField'), 'Another pole in this job has the same tag');
      await h.fill(page, '#f-tagField', 'B201');
      assert.ok(await page.locator('#h-tagField').isHidden());
      await savePole(h, page);
      assert.deepEqual(await page.locator('[data-act="open-pole"] .name').allInnerTexts(), ['Pole 1', 'Pole 2']);
      assert.deepEqual(await page.locator('[data-act="open-pole"] .code').allInnerTexts(), ['B200', 'B201']);

      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      await h.fill(page, '#set-power', 'Northern Power');
      await h.fill(page, '#set-telecom', 'Coast Tel');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'set-telecom', 'typing a name does not redraw the screen under the keyboard');
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-job"]');
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      await gotoStep(h, page, 'equipment');
      assert.equal(await h.text(page, '[data-item="powerDip"] .label'), 'Northern Power dip');
      assert.equal(await h.text(page, '[data-item="telPlant"] .label'), 'Coast Tel plant on pole');
      await gotoStep(h, page, 'heights');
      assert.equal(await h.text(page, '[data-item="gT"] label'), 'Coast Tel, top cable');
      assert.ok((await seps(page))['Coast Tel to lowest neutral or secondary']);

      // Clearing a name goes back to the plain word.
      await gotoStep(h, page, 'pole');
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="open-settings"]');
      await h.fill(page, '#set-power', '');
      await h.saved(page);
      await page.reload();
      await page.waitForSelector('#set-power');
      assert.equal(await page.inputValue('#set-power'), '');
      assert.equal(await page.getAttribute('#set-power', 'placeholder'), 'Power');
      assert.equal(await page.inputValue('#set-telecom'), 'Coast Tel');
      h.clean(page);
    },
  },
];
