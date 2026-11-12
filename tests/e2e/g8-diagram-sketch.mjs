// The span diagram (a view from above, with angles worked out) and the sketch pad.

import assert from 'node:assert/strict';
import { startJob, gotoStep, answer, savePole } from './harness.mjs';

const HOME = { latitude: 50.0244, longitude: -125.2475, accuracy: 5 };
// About 70 m east and 12 m north of HOME.
const EAST = { latitude: 50.02451, longitude: -125.24652, accuracy: 7 };

async function addSpan(h, page, details) {
  await h.tap(page, '[data-act="span-add"]');
  await page.waitForSelector('#modal #sp-to');
  if (details.to != null) await h.fill(page, '#sp-to', details.to);
  if (details.len != null) await h.fill(page, '#sp-len', details.len);
  if (details.cond != null) await h.fill(page, '#sp-cond', details.cond);
  if (details.brg != null) await h.fill(page, '#sp-brg', String(details.brg));
  if (details.close !== false) await h.tap(page, '#modal [data-sheet="done"]');
}

const rows = (page) => page.locator('.span-row').allInnerTexts();
const spansOf = async (h, page, index) => (await h.stored(page)).poles.sort((a, b) => a.createdAt - b.createdAt)[index || 0].spans;

async function exportPdf(h, page) {
  await h.tap(page, '[data-act="export-job"]');
  await h.tap(page, '#modal [data-sheet="pdf"]');
  await page.waitForSelector('#modal [data-act="file-download"]', { timeout: 60000 });
  const file = await h.download(page, () => h.tap(page, '#modal [data-act="file-download"]'));
  await h.tap(page, '#modal [data-act="file-saved-yes"]');
  return file;
}

async function stroke(page, box, points) {
  await page.mouse.move(box.x + points[0][0] * box.width, box.y + points[0][1] * box.height);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(box.x + p[0] * box.width, box.y + p[1] * box.height, { steps: 5 });
  await page.mouse.up();
}

// How much ink is on the drawing: the number of pixels that are not see-through.
const inkAmount = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('.sk-ink');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count;
  });

async function thumbs(page, count) {
  await page.waitForFunction((wanted) => {
    const images = [...document.querySelectorAll('[data-part="photos"] img[data-thumb]')];
    return images.length === wanted && images.every((image) => image.complete && image.naturalWidth > 0);
  }, count, { timeout: 20000 });
}

export default [
  {
    name: 'span-diagram',
    title: 'Span diagram: spans are typed, dragged and removed, and the angles are worked out',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Dogwood St at 5th Ave' });
      await answer(h, page, { tagMap: 'T-100' });
      await gotoStep(h, page, 'spans');
      assert.equal(await h.count(page, '[data-span-svg]'), 0, 'no drawing until there is a span');
      assert.match(await h.text(page, '[data-act="span-add"]'), /^Add a span$/);

      // The numbers from a worked example: three spans, a 13.59 degree turn in the main line.
      await addSpan(h, page, { to: 'A-059', len: '72.80', cond: '2/0 ACSR', brg: 258.59 });
      await addSpan(h, page, { to: 'REGULATOR', len: '34.16', cond: '336.4 ACSR', brg: 65 });
      await addSpan(h, page, { to: 'B-677', len: '77.92', cond: '#2 ACSR 1PH + N', brg: 126.84 });
      await h.shot(page, '40-span-diagram');
      assert.deepEqual(await rows(page), ['A-059\n72.80 m · 2/0 ACSR · 258.59°\nEdit', 'REGULATOR\n34.16 m · 336.4 ACSR · 65°\nEdit', 'B-677\n77.92 m · #2 ACSR 1PH + N · 126.84°\nEdit']);
      assert.equal(await h.text(page, '[data-deflection]'), '13.59°');
      assert.match(await h.text(page, '.defl'), /between A-059 and REGULATOR/i);
      const angles = (await page.locator('[data-span-svg] .ang').allTextContents()).sort();
      assert.deepEqual(angles, ['131.75°', '166.41°', '61.84°'], 'the three angles between neighbours, which add up to 360');
      assert.match(await page.locator('[data-span-svg]').getAttribute('aria-label'), /A-059 at 258.59°, REGULATOR at 65°, B-677 at 126.84°/);

      // The angle can be copied to the pole's own "Angle of deflection" answer, and undone.
      await h.tap(page, '[data-act="span-use-angle"]');
      assert.match(await h.text(page, '#toast'), /Angle of deflection set to 13.59°/);
      assert.equal(await h.count(page, '[data-act="span-use-angle"]'), 0);
      await h.saved(page);
      assert.equal((await h.stored(page)).poles[0].f.angle, '13.59');

      // Typing the angle from another span: 90 degrees clockwise from A-059 is 348.59.
      await h.tap(page, '.span-row >> nth=2');
      await page.selectOption('#modal #sp-ref', { label: 'Clockwise from A-059' });
      await h.fill(page, '#sp-ang', '90');
      assert.equal(await page.inputValue('#modal #sp-brg'), '348.59');
      // Nonsense in the box changes nothing.
      await h.fill(page, '#sp-brg', 'abc');
      await h.tap(page, '#modal [data-sheet="done"]');
      assert.match((await rows(page))[2], /348\.59°/);

      // Marking two spans as the main line decides which pair the deflection is worked out from.
      await h.tap(page, '.span-row >> nth=2');
      await h.tap(page, '#modal [data-act="span-main"]');
      assert.equal(await page.getAttribute('#modal [data-act="span-main"]', 'aria-pressed'), 'true');
      await h.tap(page, '#modal [data-sheet="done"]');
      await h.tap(page, '.span-row >> nth=0');
      await h.tap(page, '#modal [data-act="span-main"]');
      await h.tap(page, '#modal [data-sheet="done"]');
      assert.equal(await h.text(page, '[data-deflection]'), '90°');
      assert.match(await h.text(page, '.defl'), /between A-059 and B-677/i);

      // Dragging the round end of a line turns it. Pulled straight up, it points north.
      const svg = await page.locator('[data-span-svg]').boundingBox();
      const handle = await page.locator('[data-span-handle]').nth(1).boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(svg.x + svg.width / 2 + 40, svg.y + 40, { steps: 6 });
      await page.mouse.move(svg.x + svg.width / 2, svg.y + 20, { steps: 6 });
      assert.equal(await h.count(page, '#modal .sheet'), 0);
      await page.mouse.up();
      await h.pause(page, 600);
      assert.equal(await h.count(page, '#modal .sheet'), 0, 'letting go after a drag does not open the details');
      assert.match((await rows(page))[1], /REGULATOR\n34\.16 m · 336\.4 ACSR · 0°/);

      // Dragged to within a few degrees of dead straight with another span, it settles on straight.
      await page.locator('[data-span-svg]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const placed = await page.locator('[data-span-svg]').boundingBox();
      const end = await page.locator('[data-span-handle]').nth(1).boundingBox();
      const cx = placed.x + placed.width / 2;
      const cy = placed.y + placed.height / 2;
      const aim = ((258.59 + 180 + 2) * Math.PI) / 180; // two degrees off the far side of A-059
      await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
      await page.mouse.down();
      await page.mouse.move(cx + 90 * Math.sin(aim), cy - 90 * Math.cos(aim), { steps: 10 });
      await page.mouse.up();
      await h.pause(page, 600);
      assert.match((await rows(page))[1], /· 78\.59°/);

      // A tap on the round end, with no drag, opens that span.
      const tapEnd = await page.locator('[data-span-handle]').nth(0).boundingBox();
      await page.mouse.click(tapEnd.x + tapEnd.width / 2, tapEnd.y + tapEnd.height / 2);
      await page.waitForSelector('#modal #sp-to');
      assert.equal(await page.inputValue('#modal #sp-to'), 'A-059');

      // Removing a span can be undone.
      await h.pause(page, 1100);
      await h.tap(page, '#modal [data-act="span-delete"]');
      assert.equal((await rows(page)).length, 2);
      await h.tap(page, '#toast [data-toast-action]');
      assert.equal((await rows(page)).length, 3);

      // What is stored on the phone.
      await h.saved(page);
      const stored = await spansOf(h, page);
      assert.deepEqual(stored.map((s) => [s.to, s.len, s.cond, s.brg, s.main, s.how]), [
        ['A-059', '72.80', '2/0 ACSR', 258.59, true, 'typed'],
        ['REGULATOR', '34.16', '336.4 ACSR', 78.59, false, 'drag'],
        ['B-677', '77.92', '#2 ACSR 1PH + N', 348.59, true, 'typed'],
      ]);

      // A span with no length is named in "Check these", and "Span 1" in words is no longer asked for.
      await addSpan(h, page, { to: 'STUB' });
      await gotoStep(h, page, 'photos');
      const review = await h.text(page, '[data-part="review"]');
      assert.match(review, /Span diagram\s*No length for the span to STUB/);
      assert.doesNotMatch(review, /Span 1 : To pole located/);
      await h.tap(page, '[data-act="review-goto"][data-key="spanMap"]');
      await page.waitForSelector('[data-span-svg]');

      // The diagram survives a reload: it is read back from the phone's storage.
      await h.saved(page);
      await page.reload();
      await page.waitForSelector('[data-span-svg]');
      assert.equal((await rows(page)).length, 4);

      // The report draws the diagram and lists the spans and angles.
      await savePole(h, page);
      const file = await exportPdf(h, page);
      const doc = await h.pdf(file.path);
      const text = doc.poleText(1);
      for (const words of ['A-059', 'REGULATOR', 'B-677', '72.80 m', '2/0 ACSR', 'Seen from above, with this pole in the middle', 'To A-059, 72.80 m, 2/0 ACSR, direction 258.59°, main line', 'Angle of deflection, from the diagram', '90° (between A-059 and B-677)']) {
        assert.ok(doc.squeezed(text).includes(doc.squeezed(words)), 'the report says: ' + words);
      }
      assert.match(text, /No length for the span to STUB/);
      h.clean(page);
    },
  },

  {
    name: 'span-gps',
    title: 'Span diagram: direction and length from the GPS positions of two poles',
    async run(h) {
      const site = await h.site();
      const { page, context } = await h.phone({ permissions: ['geolocation'], geolocation: HOME });
      await h.open(page, site.url);
      await startJob(h, page, { location: 'GPS Rd' });
      await answer(h, page, { tagMap: 'WEST-1' });
      await h.tap(page, '[data-act="gps-get"]');
      await page.waitForSelector('.coords');
      await savePole(h, page);
      await context.setGeolocation(EAST);
      await h.tap(page, '[data-act="add-pole"]');
      await answer(h, page, { tagMap: 'EAST-2' });
      await savePole(h, page);

      // Pole 2 has no position yet, so GPS cannot be used, and the sheet says why.
      await h.tap(page, '[data-act="open-pole"] >> nth=0');
      await gotoStep(h, page, 'spans');
      await addSpan(h, page, { close: false });
      assert.equal(await page.isDisabled('#modal [data-act="span-gps"]'), true);
      await h.tap(page, '#modal [data-act="span-link"]');
      assert.equal(await page.inputValue('#modal #sp-to'), 'EAST-2');
      assert.match(await h.text(page, '#modal [data-span-gps]'), /Pole 2 · EAST-2 has no GPS position yet/);
      await h.tap(page, '#modal [data-sheet="done"]');

      await h.tap(page, '[data-act="step-goto"][data-step="pole"]');
      await h.tap(page, '[data-act="step-back"]');
      await h.tap(page, '[data-act="open-pole"] >> nth=1');
      await h.tap(page, '[data-act="gps-get"]');
      await page.waitForSelector('.coords');
      await h.tap(page, '[data-act="step-back"]');

      await h.tap(page, '[data-act="open-pole"] >> nth=0');
      await gotoStep(h, page, 'spans');
      await h.tap(page, '.span-row');
      assert.match(await h.text(page, '#modal [data-span-gps]'), /GPS says 7\d(\.\d)? m at [78]\d(\.\d+)?°\. The two positions together may be off by about 12 m/);
      await h.tap(page, '#modal [data-act="span-gps"]');
      assert.match(await h.text(page, '#toast'), /Direction and length set from GPS/);
      await h.pause(page, 1100);
      await h.tap(page, '#modal [data-sheet="done"]');
      await h.saved(page);
      const [span] = await spansOf(h, page, 0);
      assert.equal(span.how, 'gps');
      assert.ok(span.brg > 76 && span.brg < 83, 'east and a little north: ' + span.brg);
      assert.ok(Number(span.len) > 68 && Number(span.len) < 73, 'about 70 m: ' + span.len);
      assert.ok(span.toPole, 'the span remembers which pole it goes to');

      // A length typed by hand is kept when GPS is used again.
      await h.tap(page, '.span-row');
      await h.fill(page, '#sp-len', '69.5');
      await h.pause(page, 1100);
      await h.tap(page, '#modal [data-act="span-gps"]');
      assert.match(await h.text(page, '#toast'), /The length you typed was kept/);
      assert.equal(await page.inputValue('#modal #sp-len'), '69.5');
    },
  },

  {
    name: 'sketch-pad',
    title: 'Sketch pad: draw, label, rub out, undo, and save beside the photos',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Sketch Ave' });
      await answer(h, page, { tagMap: 'S-1' });
      await gotoStep(h, page, 'photos');

      await h.tap(page, '[data-act="sketch-new"]');
      await page.waitForSelector('.sketch .sk-ink');
      assert.equal(await page.evaluate(() => document.getElementById('app').inert), true, 'the screen behind cannot be tapped');
      assert.equal(await page.isDisabled('.sketch [data-sk="undo"]'), true);
      const box = await page.locator('.sk-ink').boundingBox();
      assert.ok(box.width > 300 && box.height > 380, 'the drawing fills the screen: ' + JSON.stringify(box));
      assert.equal(await inkAmount(page), 0);

      // With nothing drawn, Cancel closes at once.
      await page.click('.sketch [data-sk="cancel"]');
      assert.equal(await h.count(page, '.sketch'), 0);
      assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);

      // The button is in the same spot as a moment ago, so a finger's pace is kept (see the slip guard).
      await h.pause(page, 800);
      await h.tap(page, '[data-act="sketch-new"]');
      await page.waitForSelector('.sketch .sk-ink');
      await stroke(page, box, [[0.5, 0.1], [0.5, 0.9]]);
      await stroke(page, box, [[0.2, 0.2], [0.8, 0.2]]);
      const twoLines = await inkAmount(page);
      assert.ok(twoLines > 5000, 'two lines of ink: ' + twoLines);

      // A label: type it, then tap where it goes. With nothing typed, a tap places nothing.
      await page.click('.sketch [data-tool="text"]');
      await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.5);
      assert.equal(await inkAmount(page), twoLines);
      await page.fill('.sk-input', 'PRIMARY 25 KV');
      await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.15);
      const withLabel = await inkAmount(page);
      assert.ok(withLabel > twoLines + 1500, 'the label is drawn');
      assert.equal(await page.inputValue('.sk-input'), '');

      // The rubber takes ink away. Undo brings it back, then takes the label off again.
      await page.click('.sketch [data-tool="erase"]');
      await stroke(page, box, [[0.1, 0.2], [0.9, 0.2]]);
      const rubbed = await inkAmount(page);
      assert.ok(rubbed < withLabel - 1500, 'the crossarm is rubbed out');
      await page.click('.sketch [data-sk="undo"]');
      assert.equal(await inkAmount(page), withLabel);
      await page.click('.sketch [data-sk="undo"]');
      await h.pause(page, 50);
      assert.equal(await inkAmount(page), twoLines);

      // Picking a colour goes back to the pen.
      await page.click('.sketch [data-tool="erase"]');
      await page.click('.sketch [data-colour="#D42A20"]');
      assert.equal(await page.getAttribute('.sketch [data-tool="pen"]', 'aria-pressed'), 'true');
      await stroke(page, box, [[0.2, 0.2], [0.05, 0.5]]);
      await h.shot(page, '41-sketch-pad');

      // Cancel with ink on the page asks first. "Keep drawing" keeps everything.
      await page.click('.sketch [data-sk="cancel"]');
      assert.match(await h.text(page, '.sk-ask'), /Close without saving this sketch\?/);
      await page.click('.sketch [data-sk="keep"]');
      assert.equal(await h.count(page, '.sketch'), 1);
      assert.ok((await inkAmount(page)) > twoLines);

      await page.click('.sketch [data-sk="save"]');
      await page.waitForSelector('.sketch', { state: 'detached', timeout: 20000 });
      await thumbs(page, 1);
      assert.match(await h.text(page, '#toast'), /Sketch saved with this pole's photos/);
      assert.equal(await h.text(page, '[data-part="photos"] .tag'), 'Sketch');
      await h.saved(page);
      let stored = await h.stored(page);
      assert.equal(stored.photos.length, 1);
      assert.deepEqual([stored.photos[0].label, stored.photos[0].w, stored.photos[0].h], ['Sketch', 1200, 1500]);

      // Drawing on a photo saves a marked-up copy and leaves the photo alone.
      await page.setInputFiles('#lib', h.path.join(h.images, 'landscape.jpg'));
      await thumbs(page, 2);
      await h.tap(page, '[data-act="photo-open"] >> nth=1');
      await h.tap(page, '#modal [data-label-chips] [data-label="Pole top"]');
      await h.pause(page, 1100);
      await h.tap(page, '#modal [data-act="sketch-photo"]');
      await page.waitForSelector('.sketch .sk-ink');
      assert.equal(await h.count(page, '#modal .sheet'), 0);
      assert.equal(await h.text(page, '.sk-title'), 'Draw on the photo');
      const photoBox = await page.locator('.sk-ink').boundingBox();
      assert.ok(photoBox.width > photoBox.height, 'the pad takes the shape of the photo');
      assert.equal(await page.getAttribute('.sketch [data-colour="#D42A20"]', 'aria-pressed'), 'true', 'red shows up best on a photo');
      await stroke(page, photoBox, [[0.2, 0.2], [0.8, 0.8]]);
      await page.keyboard.press('Escape');
      assert.match(await h.text(page, '.sk-ask'), /Close without saving/);
      await page.keyboard.press('Escape');
      await page.click('.sketch [data-sk="save"]');
      await page.waitForSelector('.sketch', { state: 'detached', timeout: 20000 });
      await thumbs(page, 3);
      assert.match(await h.text(page, '#toast'), /The original photo is unchanged/);
      await h.saved(page);
      stored = await h.stored(page);
      const labels = stored.photos.sort((a, b) => a.createdAt - b.createdAt).map((p) => p.label);
      assert.deepEqual(labels, ['Sketch', 'Pole top', 'Pole top, marked up']);
      const [original, marked] = [stored.photos[1], stored.photos[2]];
      assert.ok(marked.w / marked.h > 1.2 && Math.abs(marked.w / marked.h - original.w / original.h) < 0.02, 'the copy keeps the photo shape');

      // The sketch and the marked-up copy are in the report with the photos.
      await savePole(h, page);
      const file = await exportPdf(h, page);
      const doc = await h.pdf(file.path);
      assert.equal(doc.poleImages(1).length, 3);
      for (const words of ['Photo 1 of 3: Sketch', 'Photo 2 of 3: Pole top', 'Photo 3 of 3: Pole top, marked up']) assert.ok(doc.poleText(1).includes(words), words);
      h.clean(page);
    },
  },
];
