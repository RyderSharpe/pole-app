// Getting data off the phone, and being honest about whether it really left.

import assert from 'node:assert/strict';
import { startJob, gotoStep, answer, savePole } from './harness.mjs';
import { TEMPLATE } from '../../src/template.js';
import { exportColumns } from '../../src/template-engine.js';

const HOME = { latitude: 50.0244, longitude: -125.2475, accuracy: 6 };
const LABELS = exportColumns(TEMPLATE, { power: 'Power', telecom: 'Telecom' }).map((column) => column.label);
const NOTES = 'Leaning 5° toward the road.\nSays "DANGER", in red; see photo 2';

const SLOW_PHOTOS = () => {
  const real = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function slow(callback, ...rest) {
    const delay = window.__photoDelay || 0;
    return real.call(this, (blob) => (delay ? setTimeout(() => callback(blob), delay) : callback(blob)), ...rest);
  };
};

// Stands in for the phone's share sheet, which a test cannot tap.
const FAKE_SHARE = () => {
  window.__shares = [];
  navigator.canShare = (data) => Boolean(data && data.files && data.files.length);
  navigator.share = async (data) => {
    const file = data.files[0];
    window.__shares.push({ name: file.name, type: file.type, size: file.size });
    if (window.__shareMode === 'cancel') throw new DOMException('The user closed the share sheet', 'AbortError');
    if (window.__shareMode === 'fail') throw new DOMException('Sharing is not allowed here', 'NotAllowedError');
  };
};

async function thumbs(page, count) {
  await page.waitForFunction((wanted) => {
    const images = [...document.querySelectorAll('[data-part="photos"] img[data-thumb]')];
    return images.length === wanted && images.every((image) => image.complete && image.naturalWidth > 0);
  }, count, { timeout: 20000 });
}

// A job with two poles: one filled in properly with two photos, one with awkward entries.
async function twoPoleJob(h, page) {
  await startJob(h, page, { location: 'Dogwood St at 5th Ave', collectedBy: 'R. Sharpe', designNo: '00077' });
  await answer(h, page, { tagMap: '0042', tagField: '0042', tagStatus: ['OK'], poleType: ['Wood'], condition: ['Good'], testTreat: '2019', height: '45', poleClass: '4', angle: '12' });
  await h.tap(page, '[data-act="gps-get"]');
  await page.waitForSelector('.coords');
  await gotoStep(h, page, 'equipment');
  await answer(h, page, { xfmr: ['1Ø'], secondary: ['1Ø'], powerDip: ['No'], streetLight: ['Yes - Bonded'], telPlant: ['Yes'], telDip: ['No'] });
  await gotoStep(h, page, 'anchors');
  await answer(h, page, { powerAnchor: ['No'], telAnchor: ['Yes'], telSlots: '2', jointAnchor: ['No'] });
  await gotoStep(h, page, 'heights');
  await answer(h, page, { gP: '9.4', gN: '8.1', gS: '7.9', gT: '6.2', gSL: '7.0' });
  await gotoStep(h, page, 'spans');
  await answer(h, page, { span1: 'North, 42 m', span2: '=HYPERLINK("http://example.com","click")', midIssue: ['No'], sag: '0,8' });
  await gotoStep(h, page, 'photos');
  await page.setInputFiles('#cam', h.path.join(h.images, 'landscape.jpg'));
  await h.tap(page, '#modal [data-sheet="label:Pole tag"]');
  await page.setInputFiles('#lib', h.path.join(h.images, 'portrait.jpg'));
  await thumbs(page, 2);
  await h.fill(page, '#f-notes', NOTES);
  await h.tap(page, '[data-act="step-next"]');
  await page.waitForSelector('[data-act="add-pole"]');

  await h.tap(page, '[data-act="add-pole"]');
  await answer(h, page, { tagField: 'B-17' });
  await gotoStep(h, page, 'heights');
  await answer(h, page, { gP: 'about 9', gN: '8.0' });
  await h.tap(page, '[data-toggle="ww"]');
  await answer(h, page, { mT: '1.25' });
  await gotoStep(h, page, 'pole');
  await h.tap(page, '[data-act="step-back"]');
  await page.waitForSelector('[data-act="add-pole"]');
}

async function exportFile(h, page, kind) {
  await h.tap(page, '[data-act="export-job"], [data-act="export-all"]');
  await h.tap(page, '#modal [data-sheet="' + kind + '"]');
  await page.waitForSelector('#modal [data-act="file-download"], #modal [data-act="file-share"]', { timeout: 120000 });
}

async function downloadAndConfirm(h, page) {
  const file = await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
  await h.tap(page, '#modal [data-act="file-saved-yes"]');
  return file;
}

// The first page of a report lists the poles: number, tag, status, left blank, to check, photos, GPS.
const poleList = (doc) => doc.pages[0].lines.filter((line) => /^\d+$/.test(line[0]) && line.length >= 6);

export default [
  {
    name: 'pdf-export',
    title: 'PDF report: the file is right, and "exported" waits for a real answer',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ permissions: ['geolocation'], geolocation: HOME });
      await h.open(page, site.url);
      await twoPoleJob(h, page);
      assert.equal(await h.text(page, '.top .pill'), 'Waiting to export');

      await h.tap(page, '[data-act="export-job"]');
      assert.match(await h.text(page, '#modal h2'), /^Export 2 poles and 2 photos$/);
      await h.shot(page, '14-export-choice');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      assert.match(await h.text(page, '#modal .filename'), /^Dogwood_St_at_5th_Ave_00077_\d{4}-\d{2}-\d{2}\.pdf$/);
      assert.equal(await h.count(page, '#modal [data-act="file-share"]'), 0, 'this browser has no share sheet, so only Download is offered');
      await h.shot(page, '15-file-ready');

      // Download with a double tap. The second tap lands where "Yes, I have the file" appears, and
      // must not answer the question by accident.
      const spot = await page.locator('#modal [data-act="file-download"]').boundingBox();
      const first = await h.download(page, async () => {
        await page.mouse.click(spot.x + spot.width / 2, spot.y + spot.height / 2);
        await h.pause(page, 150);
        await page.mouse.click(spot.x + spot.width / 2, spot.y + spot.height / 2);
        await h.pause(page, 300); // and a third, slower one, 450 ms after the first
        await page.mouse.click(spot.x + spot.width / 2, spot.y + spot.height / 2);
      });
      await h.pause(page, 300);
      assert.match(await h.text(page, '#modal h2'), /Did the file save\?/, 'the slips did not answer "yes"');
      await h.shot(page, '16-did-it-save');
      await page.keyboard.press('Escape');
      assert.match(await h.text(page, '#modal h2'), /Did the file save\?/, 'the question cannot be skipped by accident');
      await h.tap(page, '#modal [data-act="file-saved-no"]');
      assert.match(await h.text(page, '#modal [data-file-status]'), /Nothing has been marked as done/);
      await h.tap(page, '#modal [data-sheet="close"]');
      assert.equal(await h.text(page, '.top .pill'), 'Waiting to export');

      // Closing the sheet without taking the file marks nothing either.
      await exportFile(h, page, 'pdf');
      await page.keyboard.press('Escape');
      assert.equal(await h.count(page, '#modal .sheet'), 0);
      assert.equal(await h.text(page, '.top .pill'), 'Waiting to export');

      // Download and confirm.
      await exportFile(h, page, 'pdf');
      const file = await downloadAndConfirm(h, page);
      assert.match(await h.text(page, '#toast'), /Marked as exported/);
      assert.equal(await h.text(page, '.top .pill'), 'Exported');
      await h.tap(page, '[data-act="back"]');
      assert.match(await h.text(page, '.banner'), /Nothing waiting/);
      assert.match(await h.text(page, '[data-act="open-job"] .pill'), /Exported/);

      // ---- The file, read with poppler, qpdf and pypdf.
      const doc = await h.pdf(file.path);
      assert.equal(doc.producer, 'Pole Field Data');
      assert.match(doc.title, /Dogwood St at 5th Ave/);
      assert.match(doc.pageSize, /612 x 792 pts \(letter\)/);
      const cover = doc.pages[0].text;
      for (const words of ['POLE FIELD DATA REPORT', 'Dogwood St at 5th Ave', 'Collected by R. Sharpe', 'Design # / Job 00077', '2 poles and 2 photos. 1 done, 1 in progress.', 'Page 1 of ' + doc.pageCount]) {
        assert.ok(cover.includes(words), 'the first page says: ' + words);
      }
      assert.deepEqual(poleList(doc), [
        ['1', '0042', 'Done', '0', '0', '2', 'Yes'],
        ['2', 'B-17', 'In progress', String(poleList(doc)[1][3]), String(poleList(doc)[1][4]), '0', 'No'],
      ]);
      assert.ok(Number(poleList(doc)[1][4]) >= 1, 'pole 2 has something to check');

      // Pole 1: every answer, as typed or as worked out.
      const one = (label) => doc.value(1, label);
      assert.equal(one('Pole tag # (map)'), '0042', 'a tag keeps its leading zeros');
      assert.equal(one('Pole tag # (field)'), '0042');
      assert.equal(one('Pole height (ft)'), '45');
      assert.equal(one('Angle of deflection (deg)'), '12');
      assert.equal(one('Pole test & treat date'), '2019');
      assert.equal(one('GPS position'), '50.024400, -125.247500');
      assert.equal(one('GPS accuracy (m)'), '6');
      assert.equal(one('Secondary on pole'), '1Ø');
      assert.equal(one('Street light'), 'Yes - Bonded');
      assert.equal(one('Power anchor'), 'No');
      assert.equal(one('Power anchor eye slots'), 'N/A');
      assert.equal(one('Telecom anchor eye slots'), '2');
      assert.equal(one('Ground to primary bolt (m)'), '9.4');
      assert.equal(one('Ground to lowest secondary (m)'), '7.9');
      assert.equal(one('Ground to street light lowest conductive part (m)'), '7');
      assert.equal(one('Ground to top of Power dip cable cover (m)'), 'N/A');
      assert.equal(one('Measured wire to wire'), undefined, 'a question left blank is not listed');
      assert.equal(one('Separation: neutral to primary bolt (m)'), '1.30');
      assert.equal(one('Separation: secondary to neutral (m)'), '0.20');
      assert.equal(one('Separation: Telecom to lowest neutral or secondary (m)'), '1.70');
      assert.equal(one('Lowest neutral or secondary height (m)'), '7.90');
      assert.equal(one('Span 1 : To pole located'), 'North, 42 m');
      assert.equal(one('Span 2 : To pole located'), '=HYPERLINK("http://example.com","click")', 'text is printed as typed');
      assert.equal(one('Sag (m)'), '0.8');
      const poleOne = doc.poleText(1);
      for (const words of ['Pole 1 0042', 'Done', 'Leaning 5° toward the road.', 'Says "DANGER", in red; see photo 2', 'PHOTOS (2)', 'Photo 1 of 2: Pole tag', 'Photo 2 of 2']) assert.ok(poleOne.includes(words), 'pole 1 says: ' + words);
      assert.ok(!poleOne.includes('CHECK THESE'), 'nothing to check on pole 1');
      assert.deepEqual(doc.poleImages(1).map((i) => [i.width, i.height, i.encoding]), [[900, 675, 'jpeg'], [675, 900, 'jpeg']], 'medium-size photos keep the file easy to email');

      // Pole 2: an entry the app could not read is printed as typed, and is listed to check.
      const two = (label) => doc.value(2, label);
      assert.equal(two('Pole tag # (field)'), 'B-17');
      assert.equal(two('Ground to primary bolt (m)'), 'about 9');
      assert.equal(two('Ground to neutral (m)'), '8');
      assert.equal(two('Measured wire to wire'), 'Yes');
      assert.equal(two('Measured: Telecom to lowest neutral or secondary (m)'), '1.25');
      assert.equal(two('Separation: neutral to primary bolt (m)'), 'check entry');
      assert.equal(two('Separation: Telecom to lowest neutral or secondary (m)'), '1.25');
      const poleTwo = doc.poleText(2);
      for (const words of ['In progress', 'CHECK THESE', 'Left blank:']) assert.ok(poleTwo.includes(words), 'pole 2 says: ' + words);
      assert.deepEqual(doc.poleImages(2), []);
      assert.ok(doc.polePages(1)[0].number < doc.polePages(2)[0].number, 'poles are in order, each starting a page');

      // The first download, before confirming, was the same report.
      assert.equal((await h.pdf(first.path)).pageCount, doc.pageCount);
      h.clean(page);
    },
  },

  {
    name: 'export-then-edit',
    title: 'A change after, or during, an export puts the job back to waiting',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Edits' });
      await answer(h, page, { tagField: 'E-1' });
      await savePole(h, page);
      await h.tap(page, '[data-act="add-pole"]');
      await answer(h, page, { tagField: 'E-2' });
      await savePole(h, page);
      await exportFile(h, page, 'pdf');
      await downloadAndConfirm(h, page);
      assert.equal(await h.text(page, '.top .pill'), 'Exported');

      // A change after the export.
      await h.tap(page, page.locator('[data-act="open-pole"]').first());
      await h.fill(page, '#f-poleClass', '5');
      await h.tap(page, '[data-act="step-back"]');
      assert.equal(await h.text(page, '.top .pill'), 'Changed since export');
      await h.tap(page, '[data-act="back"]');
      assert.match(await h.text(page, '.banner'), /Not exported yet[\s\S]*2 poles saved on this phone only/);
      await h.tap(page, '[data-act="open-job"]');
      await exportFile(h, page, 'pdf');
      await downloadAndConfirm(h, page);
      assert.equal(await h.text(page, '.top .pill'), 'Exported');

      // A change while the finished file is waiting to be taken: the file does not hold it, so
      // confirming the download must not mark the job as exported.
      await h.tap(page, page.locator('[data-act="open-pole"]').nth(1));
      await gotoStep(h, page, 'photos');
      await h.tap(page, '[data-act="pole-delete"]');
      await h.tap(page, '#modal [data-sheet="yes"]');
      await page.waitForSelector('[data-act="add-pole"]');
      assert.equal(await h.count(page, '[data-act="open-pole"]'), 1);
      await exportFile(h, page, 'pdf'); // built with one pole
      await h.tap(page, '[data-toast-action]'); // Undo: the deleted pole comes back, behind the sheet
      const file = await downloadAndConfirm(h, page);
      assert.equal(await h.count(page, '[data-act="open-pole"]'), 2);
      assert.equal(await h.text(page, '.top .pill'), 'Changed since export', 'the file was built before the pole came back');
      const doc = await h.pdf(file.path);
      assert.deepEqual(poleList(doc).map((line) => line[1]), ['E-1'], 'the report holds the one pole there was when it was built');
      assert.equal(doc.polePages(2).length, 0);
      h.clean(page);
    },
  },

  {
    name: 'full-package',
    title: 'Full package: the PDF report, CSV, raw data and full-size photos in one ZIP',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ permissions: ['geolocation'], geolocation: HOME });
      await h.open(page, site.url);
      await twoPoleJob(h, page);
      await exportFile(h, page, 'package');
      assert.match(await h.text(page, '#modal .filename'), /^Dogwood_St_at_5th_Ave_00077_\d{4}-\d{2}-\d{2}\.zip$/);
      const file = await downloadAndConfirm(h, page);
      assert.equal(await h.text(page, '.top .pill'), 'Exported');

      const zip = await h.py('zip', file.path);
      assert.equal(zip.badEntry, null, 'every checksum in the ZIP is right');
      const stem = file.name.replace(/\.zip$/, '');
      assert.deepEqual(zip.entries.map((entry) => entry.name), [stem + '.pdf', stem + '.csv', 'photos/P01_0042_1_Pole_tag.jpg', 'photos/P01_0042_2.jpg', 'data.json']);
      assert.ok(zip.entries.every((entry) => entry.method === 0 && entry.utf8 && entry.size === entry.packed));

      const photo = await h.py('image', await h.unzip(file.path, 'photos/P01_0042_1_Pole_tag.jpg'));
      assert.deepEqual([photo.format, photo.width, photo.height], ['JPEG', 1600, 1200], 'photos in the package are full size');
      const report = await h.pdf(await h.unzip(file.path, stem + '.pdf'));
      assert.deepEqual(poleList(report).map((line) => line[1]), ['0042', 'B-17']);
      assert.equal(report.images.length, 2);

      const csv = await h.py('csv', await h.unzip(file.path, stem + '.csv'));
      assert.ok(csv.bom && csv.crlf);
      assert.deepEqual(csv.rows[0], LABELS);
      assert.equal(csv.rows.length, 3);
      const one = Object.fromEntries(LABELS.map((label, i) => [label, csv.rows[1][i]]));
      assert.equal(one['Design # / Job'], '00077');
      assert.equal(one['Pole tag # (map)'], '0042');
      assert.equal(one['Ground to primary bolt (m)'], '9.4');
      assert.equal(one['Separation: neutral to primary bolt (m)'], '1.3');
      assert.equal(one.Notes, NOTES, 'line breaks, quotes and semicolons stay in one cell');
      assert.equal(one['Span 2 : To pole located'], '\'=HYPERLINK("http://example.com","click")', 'text that a spreadsheet could run as a formula is defused');
      assert.equal(one['Power anchor eye slots'], 'N/A');
      const rawCsv = (await h.readFile(await h.unzip(file.path, stem + '.csv'), 'utf8'));
      assert.ok(rawCsv.includes(',"0042",'), 'tags are quoted, so careful importers keep the leading zeros');
      assert.ok(rawCsv.includes(',9.4,'), 'numbers are bare');

      const data = JSON.parse(await h.readFile(await h.unzip(file.path, 'data.json'), 'utf8'));
      assert.equal(data.format, 'polefield-export');
      assert.equal(data.appVersion, '0.3.0');
      assert.deepEqual(data.names, { power: 'Power', telecom: 'Telecom' });
      assert.equal(data.jobs.length, 1);
      assert.equal(data.jobs[0].job.f.designNo, '00077');
      assert.deepEqual(data.jobs[0].poles.map((item) => item.number), [1, 2]);
      assert.deepEqual(data.jobs[0].poles[0].calculated, { neuPri: 1.3, secNeu: 0.2, telLow: 1.7, low: 7.9 });
      assert.equal(data.jobs[0].poles[1].calculated.neuPri, 'check entry');
      assert.equal(data.jobs[0].poles[0].pole.gps.lat, 50.0244);
      assert.deepEqual(data.photoFiles.map((entry) => entry.file), ['photos/P01_0042_1_Pole_tag.jpg', 'photos/P01_0042_2.jpg']);
      h.clean(page);
    },
  },

  {
    name: 'export-all',
    title: 'Export all jobs: one file, every job marked',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      for (const [location, tag] of [['First St', 'F-1'], ['Second Ave', 'S-1']]) {
        await startJob(h, page, { location });
        await answer(h, page, { tagField: tag });
        await gotoStep(h, page, 'photos');
        await page.setInputFiles('#lib', h.path.join(h.images, 'small.jpg'));
        await thumbs(page, 1);
        await savePole(h, page);
        await h.tap(page, '[data-act="back"]');
        await page.waitForSelector('[data-act="new-job"]');
      }
      // A third job with nothing in it is left out, and does not block the export.
      await h.tap(page, '[data-act="new-job"]');
      await h.fill(page, '#f-location', 'Empty job');
      await h.tap(page, '[data-act="back"]');
      await h.tap(page, '[data-act="back"]');
      assert.match(await h.text(page, '.banner'), /2 poles saved on this phone only/);

      await exportFile(h, page, 'package');
      assert.match(await h.text(page, '#modal .filename'), /^Pole_Field_Data_\d{4}-\d{2}-\d{2}\.zip$/);
      const file = await downloadAndConfirm(h, page);
      assert.match(await h.text(page, '.banner'), /Nothing waiting/);
      assert.deepEqual((await page.locator('[data-act="open-job"] .pill').allInnerTexts()).sort(), ['Exported', 'Exported', 'Not started']);

      const zip = await h.py('zip', file.path);
      const names = zip.entries.map((entry) => entry.name);
      assert.ok(names.includes('photos/J1_Second_Ave/P01_S-1_1.jpg') || names.includes('photos/J1_First_St/P01_F-1_1.jpg'), names.join(', '));
      assert.equal(names.filter((name) => name.startsWith('photos/')).length, 2);
      const stem = file.name.replace(/\.zip$/, '');
      const report = await h.pdf(await h.unzip(file.path, stem + '.pdf'));
      const firstPages = report.pages.filter((page) => page.text.includes('POLE FIELD DATA REPORT'));
      assert.equal(firstPages.length, 2, 'each job starts with its own first page');
      assert.deepEqual(firstPages.map((page) => (page.text.includes('First St') ? 'First St' : 'Second Ave')).sort(), ['First St', 'Second Ave']);
      assert.equal(report.images.length, 2);
      h.clean(page);
    },
  },

  {
    name: 'sharing',
    title: 'Sharing: only a completed share marks the job as exported',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [FAKE_SHARE] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Share St' });
      await answer(h, page, { tagField: 'S-1' });
      await savePole(h, page);

      await exportFile(h, page, 'pdf');
      assert.match(await h.text(page, '#modal [data-act="file-share"]'), /Save or share the file/);
      assert.ok(await h.count(page, '#modal [data-act="file-download"].ghost'), 'Download is still offered, as the second choice');

      await page.evaluate(() => { window.__shareMode = 'cancel'; });
      await h.tap(page, '#modal [data-act="file-share"]');
      await page.waitForFunction(() => /cancelled/.test(document.querySelector('#modal [data-file-status]').textContent));
      assert.match(await h.text(page, '#modal [data-file-status]'), /Sharing was cancelled\. Nothing has been marked as done\./);

      await page.evaluate(() => { window.__shareMode = 'fail'; });
      await h.tap(page, '#modal [data-act="file-share"]');
      await page.waitForFunction(() => /did not work/.test(document.querySelector('#modal [data-file-status]').textContent));
      await h.tap(page, '#modal [data-sheet="close"]');
      assert.equal(await h.text(page, '.top .pill'), 'Waiting to export', 'a cancelled and a failed share marked nothing');

      await exportFile(h, page, 'pdf');
      await page.evaluate(() => { window.__shareMode = 'ok'; });
      await h.tap(page, '#modal [data-act="file-share"]');
      await page.waitForFunction(() => !document.querySelector('#modal .sheet'));
      assert.match(await h.text(page, '#toast'), /Marked as exported/);
      assert.equal(await h.text(page, '.top .pill'), 'Exported');

      const shares = await page.evaluate(() => window.__shares);
      assert.equal(shares.length, 3);
      assert.match(shares[2].name, /^Share_St_\d{4}-\d{2}-\d{2}\.pdf$/);
      assert.equal(shares[2].type, 'application/pdf');
      assert.ok(shares[2].size > 2000);

      // The toast moves to the top while a sheet is open, so it never covers the sheet's buttons.
      await h.tap(page, '[data-act="open-pole"]');
      await gotoStep(h, page, 'photos');
      await h.tap(page, '[data-act="step-next"]');
      await page.waitForSelector('[data-act="add-pole"]');
      await exportFile(h, page, 'pdf');
      const overlap = await page.evaluate(() => {
        const toast = document.querySelector('#toast .toast-in');
        if (!toast) return 'no toast';
        const t = toast.getBoundingClientRect();
        const s = document.querySelector('#modal .sheet').getBoundingClientRect();
        return t.bottom <= s.top ? 'clear' : 'covering the sheet';
      });
      assert.equal(overlap, 'clear', 'the "pole saved" toast must not sit on top of the export buttons');
      await h.tap(page, '#modal [data-sheet="close"]');

      // A tap on the dimmed area closes the sheet, and marks nothing.
      await h.tap(page, '[data-act="open-pole"]');
      await h.fill(page, '#f-poleClass', '3');
      await h.tap(page, '[data-act="step-back"]');
      await exportFile(h, page, 'pdf');
      await page.mouse.click(195, 40);
      await page.waitForFunction(() => !document.querySelector('#modal .sheet'));
      assert.equal(await h.text(page, '.top .pill'), 'Changed since export');
      h.clean(page);
    },
  },

  {
    name: 'sharing-iphone',
    title: 'Sharing on an iPhone: the share sheet is the only way offered',
    async run(h) {
      const site = await h.site();
      const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
      const { page } = await h.phone({ userAgent: IPHONE, initScripts: [FAKE_SHARE] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'iPhone St' });
      await answer(h, page, { tagField: 'I-1' });
      await savePole(h, page);
      await exportFile(h, page, 'pdf');
      assert.equal(await h.count(page, '#modal [data-act="file-download"]'), 0, 'a plain download can strand an iPhone app on a preview page, so it is not offered when sharing works');
      await h.tap(page, '#modal [data-act="file-share"]');
      await page.waitForFunction(() => !document.querySelector('#modal .sheet'));
      assert.equal(await h.text(page, '.top .pill'), 'Exported');
      h.clean(page);

      // An older iPhone with no file sharing still gets a way out.
      const old = await h.phone({ userAgent: IPHONE });
      await h.open(old.page, site.url);
      await startJob(h, old.page, { location: 'Old iPhone' });
      await answer(h, old.page, { tagField: 'I-2' });
      await savePole(h, old.page);
      await exportFile(h, old.page, 'pdf');
      assert.equal(await h.count(old.page, '#modal [data-act="file-share"]'), 0);
      assert.equal(await h.count(old.page, '#modal [data-act="file-download"]'), 1);
      h.clean(old.page);
    },
  },

  {
    name: 'export-unreadable-photo',
    title: 'A photo the phone can no longer read is reported, not silently left out',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Lost picture' });
      await answer(h, page, { tagField: 'L-1' });
      await gotoStep(h, page, 'photos');
      await page.setInputFiles('#lib', [h.path.join(h.images, 'landscape.jpg'), h.path.join(h.images, 'portrait.jpg')]);
      await thumbs(page, 2);
      await savePole(h, page);
      await h.saved(page);
      // Remove every size of the first picture behind the app's back, as a damaged phone might.
      await page.evaluate(async () => {
        const db = await new Promise((resolve) => { const r = indexedDB.open('polefield@/'); r.onsuccess = () => resolve(r.result); });
        await new Promise((resolve) => {
          const t = db.transaction(['photos', 'blobs'], 'readwrite');
          const all = t.objectStore('photos').getAll();
          all.onsuccess = () => {
            const first = all.result.sort((a, b) => a.createdAt - b.createdAt)[0];
            for (const size of ['full', 'mid', 'thumb']) t.objectStore('blobs').delete(first.id + ':' + size);
          };
          t.oncomplete = resolve;
        });
        db.close();
      });

      await exportFile(h, page, 'package');
      assert.match(await h.text(page, '#modal .notice.warn'), /1 photo could not be read from the phone and is not in this file\./);
      const file = await downloadAndConfirm(h, page);
      const zip = await h.py('zip', file.path);
      assert.deepEqual(zip.entries.filter((entry) => entry.name.startsWith('photos/')).map((entry) => entry.name), ['photos/P01_L-1_2.jpg']);
      const stem = file.name.replace(/\.zip$/, '');
      const report = await h.pdf(await h.unzip(file.path, stem + '.pdf'));
      assert.equal(report.images.length, 1);
      const text = report.poleText(1);
      assert.ok(text.includes('This photo could not be read from the phone.'), 'the report says so in the place where the photo would be');
      assert.ok(text.includes('Photo 1 of 2') && text.includes('Photo 2 of 2'));
      const data = JSON.parse(await h.readFile(await h.unzip(file.path, 'data.json'), 'utf8'));
      assert.deepEqual(data.photoFiles.map((entry) => entry.file), [null, 'photos/P01_L-1_2.jpg']);

      // On the pole itself, the gap is visible too.
      await h.tap(page, '[data-act="open-pole"]');
      await gotoStep(h, page, 'photos');
      await page.waitForSelector('.photo .broken');
      assert.match(await h.text(page, '.photo .broken'), /Cannot read photo/);
      h.clean(page);
    },
  },

  {
    name: 'export-waits',
    title: 'An export waits for a photo that is still being stored',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone({ initScripts: [SLOW_PHOTOS] });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Waiting' });
      await answer(h, page, { tagField: 'W-1' });
      await gotoStep(h, page, 'photos');
      await page.evaluate(() => { window.__photoDelay = 1200; });
      await page.setInputFiles('#lib', h.path.join(h.images, 'landscape.jpg'));
      await page.waitForSelector('.photo.busy');
      await h.tap(page, '[data-act="step-next"]');
      await page.waitForSelector('[data-act="add-pole"]');
      await h.tap(page, '[data-act="export-job"]');
      assert.match(await h.text(page, '#modal h2'), /^Export 1 pole$/, 'the photo has not arrived yet');
      await h.tap(page, '#modal [data-sheet="pdf"]');
      await page.waitForFunction(() => /Finishing 1 photo first/.test(document.querySelector('#modal').textContent), null, { timeout: 5000 });
      await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
      const file = await downloadAndConfirm(h, page);
      const doc = await h.pdf(file.path);
      assert.equal(doc.images.length, 1, 'the photo made it into the file');
      assert.equal(poleList(doc)[0][5], '1');
      assert.equal(await h.text(page, '.top .pill'), 'Exported');
      assert.match(await h.text(page, '[data-act="open-pole"] .sub'), /^1 photo/);
      h.clean(page);
    },
  },
];
