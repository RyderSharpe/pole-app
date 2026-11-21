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

// The bars above and below the drawing change height as tools change, so the drawing is measured afresh.
const fresh = (page) => page.locator('.sk-ink').boundingBox();
async function clickAt(page, fx, fy) {
  const box = await fresh(page);
  await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height);
}

async function stroke(page, box, points) {
  await page.mouse.move(box.x + points[0][0] * box.width, box.y + points[0][1] * box.height);
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(box.x + p[0] * box.width, box.y + p[1] * box.height, { steps: 5 });
  await page.mouse.up();
}

// How much ink is on the drawing: the number of pixels that are not see-through.
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const inkAmount = async (page) =>
  (await frames(page), page).evaluate(() => {
    const canvas = document.querySelector('.sk-ink');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count;
  });

// Ink inside part of the drawing, given as fractions of its width and height.
const inkIn = async (page, x0, y0, x1, y1) =>
  (await frames(page), page).evaluate(([a, b, c, d]) => {
    const canvas = document.querySelector('.sk-ink');
    const w = canvas.width;
    const h = canvas.height;
    const data = canvas.getContext('2d').getImageData(Math.round(a * w), Math.round(b * h), Math.round((c - a) * w), Math.round((d - b) * h)).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count;
  }, [x0, y0, x1, y1]);

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
      await gotoStep(h, page, 'notes');
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
    title: 'Sketch pad: straight lines, symbols, picking things up and moving them, and one drawing that is changed in place',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Sketch Ave' });
      await answer(h, page, { tagMap: 'S-1' });
      await gotoStep(h, page, 'pole');

      await h.tap(page, '[data-act="sketch-new"]');
      await page.waitForSelector('.sketch .sk-ink');
      assert.equal(await page.evaluate(() => document.getElementById('app').inert), true, 'the screen behind cannot be tapped');
      assert.equal(await page.isDisabled('.sketch [data-sk="undo"]'), true);
      assert.equal(await page.getAttribute('.sketch [data-tool="line"]', 'aria-pressed'), 'true', 'it opens ready to draw a straight line');
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

      // A line dragged a few degrees off level comes out dead level, like a ruler.
      await stroke(page, await fresh(page), [[0.2, 0.3], [0.8, 0.3 + 0.6 * 0.8 * Math.tan((3 * Math.PI) / 180)]]);
      assert.ok((await inkIn(page, 0.2, 0.28, 0.8, 0.32)) > 720 * 8 * 0.85, 'the line is flat');
      // Each stroke of the finger is one line. A tap is not a line.
      await clickAt(page, 0.5, 0.9);
      assert.equal(await inkIn(page, 0.4, 0.85, 0.6, 0.95), 0);
      // A line drawn from the end of another joins it exactly, and a steep one comes out upright.
      await stroke(page, await fresh(page), [[0.8, 0.31], [0.805, 0.62]]);
      assert.ok((await inkIn(page, 0.79, 0.4, 0.82, 0.6)) > 100 * 8 * 0.5);
      assert.equal(await inkIn(page, 0.84, 0.4, 0.95, 0.6), 0);
      // The pen is still there for freehand.
      await page.click('.sketch [data-tool="pen"]');
      await stroke(page, await fresh(page), [[0.1, 0.7], [0.3, 0.8], [0.15, 0.9]]);
      assert.ok((await inkIn(page, 0.05, 0.65, 0.35, 0.95)) > 1000);

      // A standard symbol: choose it from the list, then tap where it goes.
      await page.selectOption('.sketch .sk-select', 'tx1');
      assert.match(await h.text(page, '.sketch .sk-hint'), /Tap the drawing where it goes/);
      const spot = [0.5, 0.6];
      assert.equal(await inkIn(page, 0.35, 0.5, 0.65, 0.7), 0);
      await clickAt(page, spot[0], spot[1]);
      { const n = await inkIn(page, 0.35, 0.5, 0.65, 0.7); assert.ok(n > 1500, 'the transformer is drawn: ' + n + ' ' + (await h.text(page, '.sketch .sk-hint'))); }
      assert.equal(await page.getAttribute('.sketch [data-tool="select"]', 'aria-pressed'), 'true', 'it is picked up straight away, ready to move');
      assert.equal(await page.inputValue('.sketch .sk-input'), '1PH TX');
      await page.fill('.sketch .sk-input', '1PH TX 25 kVA');
      await page.keyboard.press('Enter');

      // It can be moved by grabbing it.
      await stroke(page, await fresh(page), [[0.5, 0.6], [0.5, 0.7], [0.45, 0.75]]);
      assert.equal(await inkIn(page, 0.4, 0.5, 0.6, 0.62), 0, 'it has left its old place');
      assert.ok((await inkIn(page, 0.3, 0.68, 0.6, 0.85)) > 1500, 'and is where the finger let go');

      // A line is picked by touching it. Its ends and its whole body can be dragged.
      await clickAt(page, 0.4, 0.3);
      assert.equal(await h.count(page, '.sketch .sk-row:not([hidden]) [data-sk="delete"]'), 1, 'Delete shows for the picked line');
      await stroke(page, await fresh(page), [[0.4, 0.3], [0.4, 0.2]]);
      assert.ok((await inkIn(page, 0.25, 0.18, 0.6, 0.22)) > 720 * 8 * 0.3 * 0.9, 'the whole line moved up');
      await page.click('.sketch [data-sk="undo"]');
      assert.ok((await inkIn(page, 0.25, 0.28, 0.6, 0.32)) > 720 * 8 * 0.3 * 0.9, 'undo put it back');
      await clickAt(page, 0.4, 0.3);
      // The white dot at the end drags the end: the line gets longer and changes angle.
      await stroke(page, await fresh(page), [[0.2, 0.3], [0.1, 0.4]]);
      await clickAt(page, 0.5, 0.96); // empty space puts it down
      assert.ok((await inkIn(page, 0.08, 0.3, 0.2, 0.42)) > 400, 'the end moved to where the finger went');

      // Copy, resize and delete work on the picked item.
      await clickAt(page, 0.45, 0.35);
      await page.click('.sketch [data-sk="copy"]');
      assert.equal(await h.count(page, '.sketch .sk-row:not([hidden]) [data-sk="delete"]'), 1);
      await page.click('.sketch [data-sk="delete"]');
      assert.equal(await h.count(page, '.sketch .sk-row:not([hidden]) [data-sk="delete"]'), 0, 'nothing is picked once it is deleted');

      // Colour changes the picked item.
      await clickAt(page, 0.45, 0.35);
      await page.click('.sketch [data-colour="#D42A20"]');
      await clickAt(page, 0.5, 0.96);
      await frames(page);
      const red = await page.evaluate(() => {
        const canvas = document.querySelector('.sk-ink');
        const w = canvas.width;
        const h = canvas.height;
        const data = canvas.getContext('2d').getImageData(Math.round(0.45 * w) - 30, Math.round(0.35 * h) - 30, 60, 60).data;
        for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && data[i] > 180 && data[i + 1] < 80) return [data[i], data[i + 1], data[i + 2]];
        return [0, 0, 0];
      });
      assert.ok(red[0] > 180 && red[1] < 80, 'the line is red now: ' + red);
      await h.shot(page, '41-sketch-pad');

      // Cancel with changes asks first. "Keep drawing" keeps everything.
      await page.click('.sketch [data-sk="cancel"]');
      assert.match(await h.text(page, '.sk-ask'), /Close without saving these changes\?/);
      await page.click('.sketch [data-sk="keep"]');
      assert.equal(await h.count(page, '.sketch'), 1);

      await page.click('.sketch [data-sk="save"]');
      await page.waitForSelector('.sketch', { state: 'detached', timeout: 20000 });
      await thumbs(page, 1);
      assert.match(await h.text(page, '#toast'), /Sketch saved with this pole's photos/);
      assert.equal(await h.text(page, '[data-part="photos"] .tag'), 'Sketch');
      await h.saved(page);
      let stored = await h.stored(page);
      assert.equal(stored.photos.length, 1);
      assert.deepEqual([stored.photos[0].label, stored.photos[0].w, stored.photos[0].h], ['Sketch', 1200, 1500]);
      const scene = stored.photos[0].sketch;
      assert.ok(scene && scene.v === 1 && scene.items.length >= 4, 'the drawing is kept as items: ' + (scene && scene.items.length));
      const symbol = scene.items.find((item) => item.t === 'sym');
      assert.equal(symbol.k, 'tx1');
      assert.equal(symbol.text, '1PH TX 25 kVA');
      const lines = scene.items.filter((item) => item.t === 'line');
      assert.ok(lines.length >= 2, 'the lines are kept as lines');
      assert.ok(lines.some((item) => item.a[0] === item.b[0]), 'an upright line is exactly upright');
      const firstTime = stored.photos[0].updatedAt;

      // Changing the drawing replaces it. The pole does not get a second drawing.
      await h.tap(page, '[data-act="photo-open"]');
      assert.equal(await h.count(page, '#modal [data-act="sketch-photo"]'), 0, 'a drawing is changed, not drawn over');
      await h.pause(page, 800);
      await h.tap(page, '#modal [data-act="sketch-edit"]');
      await page.waitForSelector('.sketch .sk-ink');
      assert.equal(await h.text(page, '.sk-title'), 'Change the drawing');
      assert.equal(await page.getAttribute('.sketch [data-tool="select"]', 'aria-pressed'), 'true', 'it opens ready to pick and move');
      assert.ok((await inkIn(page, 0.2, 0.0, 0.8, 1.0)) > 3000, 'the drawing is there to change');
      await page.click('.sketch [data-tool="line"]');
      await stroke(page, await fresh(page), [[0.1, 0.95], [0.9, 0.95]]);
      await page.click('.sketch [data-sk="save"]');
      await page.waitForSelector('.sketch', { state: 'detached', timeout: 20000 });
      await thumbs(page, 1);
      assert.match(await h.text(page, '#toast'), /Drawing changed/);
      await h.saved(page);
      stored = await h.stored(page);
      assert.equal(stored.photos.length, 1, 'still one drawing');
      assert.equal(stored.photos[0].label, 'Sketch');
      assert.equal(stored.photos[0].sketch.items.length, scene.items.length + 1);
      assert.ok(stored.photos[0].updatedAt > firstTime);

      // Drawing on a photo saves a marked-up copy and leaves the photo alone. The markup is changed in place too.
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
      assert.equal(marked.sketch.bg, original.id, 'the markup remembers the photo under it');
      assert.equal(original.sketch, undefined);

      await h.pause(page, 800);
      await h.tap(page, '[data-act="photo-open"] >> nth=2');
      await h.tap(page, '#modal [data-act="sketch-edit"]');
      await page.waitForSelector('.sketch .sk-ink');
      await page.click('.sketch [data-tool="line"]');
      await stroke(page, await page.locator('.sk-ink').boundingBox(), [[0.2, 0.8], [0.8, 0.8]]);
      await page.click('.sketch [data-sk="save"]');
      await page.waitForSelector('.sketch', { state: 'detached', timeout: 20000 });
      await thumbs(page, 3);
      await h.saved(page);
      stored = await h.stored(page);
      assert.equal(stored.photos.length, 3, 'changing the markup added nothing');

      // The drawing and the marked-up copy are in the report with the photos, once each.
      await gotoStep(h, page, 'notes');
      await savePole(h, page);
      const file = await exportPdf(h, page);
      const doc = await h.pdf(file.path);
      assert.equal(doc.poleImages(1).length, 3);
      for (const words of ['Photo 1 of 3: Sketch', 'Photo 2 of 3: Pole top', 'Photo 3 of 3: Pole top, marked up']) assert.ok(doc.poleText(1).includes(words), words);
      h.clean(page);
    },
  },

  {
    name: 'other-heights',
    title: 'Heights: asked bottom to top, "Add other height" makes a list, and each one is one line in the report',
    async run(h) {
      const site = await h.site();
      const { page } = await h.phone();
      await h.open(page, site.url);
      await startJob(h, page, { location: 'Heights Rd' });
      await answer(h, page, { tagMap: 'H-1' });
      await gotoStep(h, page, 'equipment');
      await answer(h, page, { xfmr: ['1Ø'], secondary: ['1Ø'] });
      await gotoStep(h, page, 'heights');

      const order = await page.evaluate(() => [...document.querySelectorAll('.body [data-item]')].map((e) => e.getAttribute('data-item')));
      const wanted = ['gT2', 'gT', 'gS', 'gN', 'gSL', 'gXB', 'gXT', 'gP', 'gTop', 'extras'];
      assert.deepEqual(order.filter((k) => wanted.includes(k)), wanted, 'bottom to top');
      assert.equal(await h.count(page, '#f-gOther'), 0, 'no single Other box any more');
      await answer(h, page, { gT2: '3.4', gT: '4.1', gS: '5.0', gN: '6.2', gXB: '6.6', gXT: '7.9', gP: '8.8', gTop: '11.3' });

      // Add other height: a line appears with the cursor in "what is it".
      await h.tap(page, '[data-act="extra-add"]');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-xf')), 'what');
      await page.keyboard.type('Cable riser');
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-xf')), 'h', 'Enter moves on to the height');
      await page.keyboard.type('4,2');
      await h.pause(page, 800);
      await h.tap(page, '[data-act="extra-add"]');
      await page.keyboard.type('Fibre box');
      await page.locator('[data-xf="h"]').nth(1).fill('3.1');
      assert.equal(await h.count(page, '[data-xid]'), 2);
      // Removing one can be undone.
      await h.pause(page, 800);
      await h.tap(page, '[data-xid] [data-act="extra-del"] >> nth=1');
      assert.equal(await h.count(page, '[data-xid]'), 1);
      await h.tap(page, '#toast [data-toast-action]').catch(async () => h.tap(page, '#toast button'));
      assert.equal(await h.count(page, '[data-xid]'), 2);
      await h.saved(page);
      const stored = await h.stored(page);
      const pole = stored.poles[0];
      assert.deepEqual(pole.extras.map((x) => [x.what, x.h]), [['Cable riser', '4,2'], ['Fibre box', '3.1']]);

      await page.evaluate(() => window.scrollTo(0, 0));
      await h.shot(page, '42-heights');
      await gotoStep(h, page, 'notes');
      await savePole(h, page);
      const file = await exportPdf(h, page);
      const doc = await h.pdf(file.path);
      const text = doc.poleText(1);
      for (const words of ['Cable riser (m)', 'Fibre box (m)', 'Ground to Telecom lower cable (m)', 'Ground to transformer bottom (m)', 'Measured pole height, ground to top (m)']) assert.ok(text.includes(words), words);
      assert.ok(!/what is it/i.test(text), 'one line for each other height, no second line');
      assert.ok(text.indexOf('lower cable') > -1 && text.indexOf('lower cable') < text.indexOf('primary bolt'), 'the report is bottom to top as well');
      h.clean(page);
    },
  },
];
