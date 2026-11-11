import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { planRestore, photoEntryName } from '../../src/backup.js';
import { parseRoute, paths } from '../../src/nav.js';
import { html, raw, esc, attrs, plural, formatBytes, formatDateTime } from '../../src/ui.js';
import { photoFileName, fileStem } from '../../src/exporter.js';
import { TEMPLATE } from '../../src/template.js';
import { APP_VERSION, TRASH_DAYS, DB_NAME, STORAGE_PREFIX } from '../../src/config.js';
import { listFiles, generatedBlock, rebuild } from '../../tools/build-sw.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFile(path.join(ROOT, file), 'utf8');
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const maps = (jobs = [], poles = [], photos = []) => ({
  jobs: new Map(jobs.map((r) => [r.id, r])),
  poles: new Map(poles.map((r) => [r.id, r])),
  photos: new Map(photos.map((r) => [r.id, r])),
});
const job = (id, extra = {}) => ({ id, f: { location: id }, createdAt: 100, updatedAt: 100, exportedAt: 0, ...extra });
const pole = (id, jobId, extra = {}) => ({ id, jobId, f: { tagMap: id }, gps: null, done: false, createdAt: 100, updatedAt: 100, ...extra });
const photo = (id, poleId, jobId, extra = {}) => ({ id, poleId, jobId, label: '', w: 10, h: 10, bytes: 5, createdAt: 100, updatedAt: 100, ...extra });
const ids = (list) => list.map((r) => r.id).sort();

// ---------------------------------------------------------------------------------------------
// Restore

test('restore onto an empty phone takes everything, statuses included', () => {
  const data = { jobs: [job('j1', { exportedAt: 100 })], poles: [pole('p1', 'j1')], photos: [photo('f1', 'p1', 'j1')] };
  const plan = planRestore(data, maps(), NOW);
  assert.deepEqual(ids(plan.jobs), ['j1']);
  assert.deepEqual(ids(plan.poles), ['p1']);
  assert.deepEqual(ids(plan.photos), ['f1']);
  assert.deepEqual(plan.photoDetails, []);
  assert.equal(plan.jobs[0].exportedAt, 100);
  assert.equal(plan.jobs[0].updatedAt, 100, 'a job new to this phone keeps its "exported" status');
  assert.deepEqual(plan.added, { jobs: 1, poles: 1, photos: 1 });
  assert.deepEqual(plan.updated, { jobs: 0, poles: 0, photos: 0 });
});

test('restoring the same file twice changes nothing the second time', () => {
  const data = { jobs: [job('j1')], poles: [pole('p1', 'j1')], photos: [photo('f1', 'p1', 'j1')] };
  const plan = planRestore(data, maps(data.jobs, data.poles, data.photos), NOW);
  assert.deepEqual([plan.jobs, plan.poles, plan.photos, plan.photoDetails], [[], [], [], []]);
});

test('the newer copy wins, and a tie keeps the phone copy', () => {
  const local = maps([job('j1')], [pole('older', 'j1', { updatedAt: 50, f: { tagMap: 'phone' } }), pole('newer', 'j1', { updatedAt: 500, f: { tagMap: 'phone' } }), pole('same', 'j1', { f: { tagMap: 'phone' } })]);
  const data = { jobs: [job('j1')], poles: [pole('older', 'j1', { updatedAt: 300, f: { tagMap: 'file' } }), pole('newer', 'j1', { updatedAt: 300, f: { tagMap: 'file' } }), pole('same', 'j1', { f: { tagMap: 'file' } })] };
  const plan = planRestore(data, local, NOW);
  assert.deepEqual(ids(plan.poles), ['older']);
  assert.equal(plan.poles[0].f.tagMap, 'file');
  assert.deepEqual(plan.updated, { jobs: 1, poles: 1, photos: 0 });
});

test('a restore never deletes: a live record on the phone beats a deleted copy in the file', () => {
  const local = maps([job('j1')], [pole('p1', 'j1')], [photo('f1', 'p1', 'j1')]);
  const data = {
    jobs: [job('j1', { updatedAt: 900, deletedAt: 900 })],
    poles: [pole('p1', 'j1', { updatedAt: 900, deletedAt: 900 })],
    photos: [photo('f1', 'p1', 'j1', { updatedAt: 900, deletedAt: 900 })],
  };
  const plan = planRestore(data, local, NOW);
  assert.deepEqual([plan.jobs, plan.poles, plan.photos, plan.photoDetails], [[], [], [], []]);
});

test('a record deleted on the phone but live in the file is brought back', () => {
  const local = maps([job('j1', { updatedAt: 500, deletedAt: 500 })], [pole('p1', 'j1', { updatedAt: 500, deletedAt: 500, f: { tagMap: 'phone' } })], [photo('f1', 'p1', 'j1', { updatedAt: 500, deletedAt: 500 })]);
  const data = { jobs: [job('j1', { updatedAt: 200 })], poles: [pole('p1', 'j1', { updatedAt: 200, f: { tagMap: 'file' } })], photos: [photo('f1', 'p1', 'j1', { updatedAt: 200, label: 'from file' })] };
  const plan = planRestore(data, local, NOW);
  assert.equal(plan.jobs.length, 1);
  assert.ok(!('deletedAt' in plan.jobs[0]));
  assert.ok(!('deletedAt' in plan.poles[0]));
  assert.equal(plan.poles[0].f.tagMap, 'phone', 'the phone copy was changed later, so its content is kept');
  assert.ok(plan.poles[0].updatedAt > 500);
  assert.equal(plan.photoDetails.length, 1);
  assert.ok(!('deletedAt' in plan.photoDetails[0]));
  assert.deepEqual(plan.photos, [], 'the picture is already on the phone, so it is not read again');
});

test('things deleted in the file go to Recently deleted, unless their 30 days are up', () => {
  const recent = NOW - 2 * DAY;
  const old = NOW - (TRASH_DAYS + 2) * DAY;
  const data = {
    jobs: [job('recent', { deletedAt: recent, updatedAt: recent }), job('old', { deletedAt: old, updatedAt: old }), job('live')],
    poles: [pole('p-of-old', 'old'), pole('p-old', 'live', { deletedAt: old, updatedAt: old }), pole('p-live', 'live')],
    photos: [photo('f-of-old', 'p-of-old', 'old'), photo('f-on-old-pole', 'p-old', 'live'), photo('f-old', 'p-live', 'live', { deletedAt: old, updatedAt: old }), photo('f-live', 'p-live', 'live')],
  };
  const plan = planRestore(data, maps(), NOW);
  assert.deepEqual(ids(plan.jobs), ['live', 'recent']);
  assert.equal(plan.jobs.find((j) => j.id === 'recent').deletedAt, recent);
  assert.deepEqual(ids(plan.poles), ['p-live']);
  assert.deepEqual(ids(plan.photos), ['f-live']);
});

test('poles and photos whose parent is nowhere to be found are left out', () => {
  const data = { jobs: [job('j1')], poles: [pole('p1', 'j1'), pole('lost', 'no-job')], photos: [photo('f1', 'p1', 'j1'), photo('lost-photo', 'no-pole', 'j1')] };
  const plan = planRestore(data, maps(), NOW);
  assert.deepEqual(ids(plan.poles), ['p1']);
  assert.deepEqual(ids(plan.photos), ['f1']);
  const local = maps([job('here')], [pole('here-pole', 'here')]);
  const adds = planRestore({ jobs: [], poles: [pole('extra', 'here')], photos: [photo('f2', 'here-pole', 'wrong-job')] }, local, NOW);
  assert.deepEqual(ids(adds.poles), ['extra'], 'a pole can join a job that is only on the phone');
  assert.equal(adds.photos[0].jobId, 'here', 'a photo always takes the job of its pole');
});

test('a job already on the phone that a restore changes is no longer "exported"', () => {
  const local = maps([job('j1', { updatedAt: 400, exportedAt: 400 })], [pole('p1', 'j1', { updatedAt: 400 })]);
  const newPole = planRestore({ jobs: [job('j1', { updatedAt: 400, exportedAt: 400 })], poles: [pole('p1', 'j1', { updatedAt: 400 }), pole('p2', 'j1')] }, local, NOW);
  assert.deepEqual(ids(newPole.poles), ['p2']);
  assert.equal(newPole.jobs.length, 1);
  assert.ok(newPole.jobs[0].updatedAt > newPole.jobs[0].exportedAt, 'the job now holds a pole that was not in the exported file');

  const newPhoto = planRestore({ jobs: [], poles: [], photos: [photo('f9', 'p1', 'j1')] }, local, NOW);
  assert.ok(newPhoto.jobs[0].updatedAt > newPhoto.jobs[0].exportedAt);

  const newerJob = planRestore({ jobs: [job('j1', { updatedAt: 800, exportedAt: 800 })] }, local, NOW);
  assert.ok(newerJob.jobs[0].updatedAt > newerJob.jobs[0].exportedAt, 'the phone still holds its own poles, so the mix was never exported as a whole');
});

test('an identical job that was exported elsewhere picks up the "exported" mark only', () => {
  const local = maps([job('j1', { updatedAt: 400, exportedAt: 0 })], [pole('p1', 'j1', { updatedAt: 400 })]);
  const plan = planRestore({ jobs: [job('j1', { updatedAt: 400, exportedAt: 400 })], poles: [pole('p1', 'j1', { updatedAt: 400 })] }, local, NOW);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].exportedAt, 400);
  assert.equal(plan.jobs[0].updatedAt, 400);
});

test('times in a backup file are capped at a week ahead, so a wrong clock cannot make a copy win forever', () => {
  const local = maps([job('j1', { updatedAt: NOW - 10 })]);
  const plan = planRestore({ jobs: [job('j1', { updatedAt: NOW + 400 * DAY, createdAt: NOW + 400 * DAY })] }, local, NOW);
  // The job was on the phone and is changed, so it is marked one moment later than its newest time.
  assert.ok(plan.jobs.every((j) => j.updatedAt <= NOW + 7 * DAY + 1 && j.createdAt <= NOW + 7 * DAY));
  // A clock a few hours fast keeps its order, so "changed since the export" stays true.
  const fast = planRestore({ jobs: [job('j2', { createdAt: NOW + 3600e3, exportedAt: NOW + 2 * 3600e3, updatedAt: NOW + 3 * 3600e3 })] }, maps(), NOW);
  assert.ok(fast.jobs[0].updatedAt > fast.jobs[0].exportedAt);
});

test('a damaged or hostile backup file cannot break the plan', () => {
  const empty = { jobs: [], poles: [], photos: [], photoDetails: [], added: { jobs: 0, poles: 0, photos: 0 }, updated: { jobs: 0, poles: 0, photos: 0 } };
  for (const bad of [null, undefined, 'text', 42, [], { jobs: 'x', poles: 5, photos: null }, { jobs: [null, 7, {}, { id: '' }] }]) {
    assert.deepEqual(planRestore(bad, maps(), NOW), empty);
  }
  const hostile = JSON.parse('{"jobs":[{"id":"j1","f":{"__proto__":{"polluted":1},"location":"<img src=x onerror=alert(1)>"}},{"id":"j1","f":{"location":"second copy of the same id"}}]}');
  const plan = planRestore(hostile, maps(), NOW);
  assert.equal(plan.jobs.length, 1, 'a repeated id is taken once');
  assert.deepEqual(Object.keys(plan.jobs[0].f), ['location']);
  assert.equal({}.polluted, undefined);
});

test('photo names inside a backup cannot contain a folder separator', () => {
  assert.equal(photoEntryName('abc-123', 'mid'), 'photos/abc-123.mid.jpg');
  assert.equal(photoEntryName('../x/y', 'full'), 'photos/..%2Fx%2Fy.full.jpg');
});

// ---------------------------------------------------------------------------------------------
// Addresses

test('every screen address can be built and read back', () => {
  assert.deepEqual(parseRoute(paths.home()), { name: 'home' });
  assert.deepEqual(parseRoute(paths.job('a b/c')), { name: 'job', id: 'a b/c' });
  assert.deepEqual(parseRoute(paths.jobDetails('j1')), { name: 'jobdetails', id: 'j1' });
  assert.deepEqual(parseRoute(paths.pole('p1', 'heights')), { name: 'pole', id: 'p1', step: 'heights' });
  assert.deepEqual(parseRoute(paths.pole('p1')), { name: 'pole', id: 'p1', step: '' });
  assert.deepEqual(parseRoute(paths.settings()), { name: 'settings' });
  assert.deepEqual(parseRoute(paths.trash()), { name: 'trash' });
  assert.deepEqual(parseRoute('#/job/j1'), { name: 'job', id: 'j1' });
  assert.deepEqual(parseRoute(''), { name: 'home' });
  assert.deepEqual(parseRoute(null), { name: 'home' });
});

test('odd addresses are "unknown", never an error', () => {
  for (const odd of ['/nowhere', '/job', '/job/a/b/c', '/job/j1/edit', '/pole', '/pole/a/b/c', '/settings/x', '/job/%E0%A4%A', '/%', '/job/%00']) {
    const route = parseRoute(odd);
    assert.ok(route.name === 'unknown' || typeof route.id === 'string', odd);
  }
  assert.deepEqual(parseRoute('/job/%E0%A4%A'), { name: 'unknown' });
  assert.deepEqual(parseRoute('/nowhere'), { name: 'unknown' });
});

// ---------------------------------------------------------------------------------------------
// Safe HTML

test('anything dropped into html`` is escaped', () => {
  const evil = '<img src=x onerror="alert(1)">\'`&';
  assert.equal(String(html`<p title="${evil}">${evil}</p>`), '<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&#96;&amp;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&#96;&amp;</p>');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('html`` nests, joins lists, and drops blanks', () => {
  const items = ['a<b', 'c'].map((text) => html`<li>${text}</li>`);
  assert.equal(String(html`<ul>${items}</ul>`), '<ul><li>a&lt;b</li><li>c</li></ul>');
  assert.equal(String(html`[${null}${undefined}${false}${true}${''}${0}]`), '[0]');
  assert.equal(String(html`${raw('<b>ok</b>')}`), '<b>ok</b>');
  assert.equal(String(html`${['<x>', html`<i>y</i>`]}`), '&lt;x&gt;<i>y</i>');
});

test('attrs builds attributes safely', () => {
  assert.equal(String(attrs({ class: 'a b', hidden: true, disabled: false, title: null, value: '"><script>' })), ' class="a b" hidden value="&quot;&gt;&lt;script&gt;"');
  assert.equal(String(attrs({ 'on click': 'x', 'data-k': 'ok', 'bad"name': 'x' })), ' data-k="ok"', 'a strange attribute name is dropped');
  assert.equal(String(attrs({})), '');
});

test('small text helpers', () => {
  assert.equal(plural(1, 'pole'), '1 pole');
  assert.equal(plural(0, 'pole'), '0 poles');
  assert.equal(plural(2, 'entry', 'entries'), '2 entries');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(35 * 1024 * 1024), '35 MB');
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
  assert.equal(formatBytes(NaN), 'not reported');
  assert.equal(formatDateTime(0), 'never');
  assert.match(formatDateTime(NOW), /^2026-10-0[45] \d\d:\d\d$/);
});

// ---------------------------------------------------------------------------------------------
// Names used in exports

test('photo file names sort by pole and say what they show', () => {
  assert.equal(photoFileName(3, 'A1234', 2, 'Pole tag'), 'P03_A1234_2_Pole_tag.jpg');
  assert.equal(photoFileName(12, '', 1, ''), 'P12_1.jpg');
  assert.equal(photoFileName(1, '../../x', 1, '<b>'), 'P01_x_1_b.jpg');
  assert.equal(photoFileName(100, 'T'.repeat(80), 1, 'L'.repeat(80)), 'P100_' + 'T'.repeat(30) + '_1_' + 'L'.repeat(30) + '.jpg');
  // A cut at 30 never splits a character and never leaves _ . or - at the end of a part.
  assert.equal(photoFileName(1, 'a'.repeat(29) + '\u{20000}x', 1, ''), 'P01_' + 'a'.repeat(29) + '_1.jpg');
  assert.equal(photoFileName(1, 'a'.repeat(29) + ' b', 1, 'x'.repeat(29) + '.y'), 'P01_' + 'a'.repeat(29) + '_1_' + 'x'.repeat(29) + '.jpg');
  assert.equal(photoFileName(undefined, '', 1, ''), 'P00_1.jpg');
});

test('export file names come from the job, and are always safe', () => {
  const one = (f) => ({ template: TEMPLATE, madeAt: Date.UTC(2026, 9, 4, 20), jobs: [{ job: { f }, poles: [] }] });
  assert.equal(fileStem(one({ location: 'Dogwood St / 5th', designNo: 'DES-10442', date: '2026-10-04' })), 'Dogwood_St_5th_DES-10442_2026-10-04');
  assert.equal(fileStem(one({})), 'Pole_Field_Data');
  assert.equal(fileStem(one({ location: '///' })), 'Pole_Field_Data');
  assert.match(fileStem({ template: TEMPLATE, madeAt: Date.UTC(2026, 9, 4, 20), jobs: [{ job: { f: {} } }, { job: { f: {} } }] }), /^Pole_Field_Data_2026-10-0[45]$/);
});

// ---------------------------------------------------------------------------------------------
// The files that ship

async function sourceFiles() {
  const out = [];
  for (const folder of ['src', 'src/views']) {
    for (const name of await readdir(path.join(ROOT, folder))) if (name.endsWith('.js')) out.push(folder + '/' + name);
  }
  return out.sort();
}

test('sw.js is up to date with the files it stores', async () => {
  const result = await rebuild(ROOT, { check: true });
  assert.equal(result.changed, false, 'sw.js is out of date. Run: npm run build');
  const worker = await read('sw.js');
  const { block, version, files } = await generatedBlock(ROOT);
  assert.ok(worker.includes(block));
  assert.match(version, new RegExp('^' + APP_VERSION.replace(/\./g, '\\.') + '-[0-9a-f]{12}$'));
  assert.deepEqual(files, await listFiles(ROOT));
  for (const file of files) {
    const hash = createHash('sha256').update(await readFile(path.join(ROOT, file))).digest('hex');
    assert.ok(worker.includes("['" + file + "', '" + hash + "']"), file + ' has a stale fingerprint');
  }
});

test('the stored file list holds everything the app needs and nothing else', async () => {
  const files = await listFiles(ROOT);
  for (const needed of ['index.html', 'styles.css', 'manifest.webmanifest', 'src/main.js', 'src/watchdog.js', 'src/old-browser.js', 'fonts/LICENSE-IBM-Plex-Sans.txt', 'icons/icon-180.png', ...(await sourceFiles())]) {
    assert.ok(files.includes(needed), needed + ' is not stored for offline use');
  }
  for (const file of files) assert.ok(!/^(tests|tools|docs)\/|sw\.js$|package\.json$|\.md$/.test(file), file + ' should not be stored on the phone');
  const css = await read('styles.css');
  for (const [, url] of css.matchAll(/url\(([^)]+)\)/g)) assert.ok(files.includes(url.replace(/["']/g, '')), url + ' is used by styles.css but not stored');
  const page = await read('index.html');
  for (const [, url] of page.matchAll(/(?:src|href)="([^"#]+)"/g)) assert.ok(files.includes(url), url + ' is used by index.html but not stored');
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(files.includes(icon.src), icon.src);
});

test('every import points at a real file, and every file is used', async () => {
  const files = await sourceFiles();
  const reached = new Set();
  const visit = async (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    const text = await read(file);
    for (const [, target] of text.matchAll(/(?:import|export)\s[^'"]*?from\s+'([^']+)'/g)) {
      assert.ok(target.startsWith('./') || target.startsWith('../'), file + ' imports "' + target + '", which is not part of the app');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      assert.ok(files.includes(resolved), file + ' imports ' + target + ', which does not exist');
      await visit(resolved);
    }
    assert.ok(!/\bimport\s*\(/.test(text), file + ' uses a dynamic import, which the offline list cannot follow');
  };
  await visit('src/main.js');
  const standalone = ['src/watchdog.js', 'src/old-browser.js'];
  for (const file of files) assert.ok(reached.has(file) || standalone.includes(file), file + ' is never loaded');
});

test('the security policy only allows the app\'s own files', async () => {
  const page = await read('index.html');
  const found = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(page);
  assert.ok(found, 'index.html has no Content-Security-Policy');
  const policy = Object.fromEntries(found[1].split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(policy['default-src'], ["'self'"]);
  assert.deepEqual(policy['script-src'], ["'self'"]);
  assert.deepEqual(policy['style-src'], ["'self'"]);
  assert.deepEqual(policy['connect-src'], ["'self'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'none'"]);
  assert.ok(!/unsafe-inline|unsafe-eval|https?:|\*/.test(found[1]), 'the policy must not allow inline code, eval or other sites');
});

test('no inline code or styles, which the security policy would block anyway', async () => {
  const page = await read('index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(page), 'index.html has an inline script');
  assert.ok(!/<style\b/.test(page), 'index.html has an inline style block');
  assert.ok(!/\son[a-z]+\s*=/.test(page), 'index.html has an inline event handler');
  assert.ok(!/\sstyle\s*=/.test(page), 'index.html has an inline style');
  for (const file of await sourceFiles()) {
    const text = await read(file);
    assert.ok(!/<[a-z][^>]*\sstyle\s*=/i.test(text), file + ' writes an inline style');
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(text), file + ' writes an inline event handler');
    assert.ok(!/javascript:/i.test(text), file + ' uses a javascript: address');
    assert.ok(!/\beval\s*\(|new Function\s*\(|document\.write/.test(text), file + ' runs text as code');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(text), file + ' talks to the network. The app must never send data anywhere.');
  }
});

test('page content is only ever built with the escaping helper', async () => {
  for (const file of await sourceFiles()) {
    const text = await read(file);
    for (const [line] of text.matchAll(/^.*\.innerHTML\s*=.*$/gm)) {
      assert.ok(/=\s*(String\(|'';)/.test(line), file + ' sets innerHTML without html``: ' + line.trim());
    }
    assert.ok(!/insertAdjacentHTML|outerHTML\s*=/.test(text), file);
  }
});

function pngSize(buffer) {
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, 'not a PNG file');
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test('the install details are complete and the icons are the sizes they claim', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.ok(manifest.name && manifest.short_name && manifest.short_name.length <= 12);
  assert.ok(!('orientation' in manifest), 'the app must be free to turn with the phone');
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const [w, h] = pngSize(await readFile(path.join(ROOT, icon.src)));
    assert.equal(w + 'x' + h, icon.sizes, icon.src);
  }
  assert.deepEqual(pngSize(await readFile(path.join(ROOT, 'icons/icon-180.png'))), [180, 180]);
  const page = await read('index.html');
  assert.match(page, /rel="apple-touch-icon" href="icons\/icon-180\.png"/);
  assert.match(page, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.ok(!/user-scalable\s*=\s*no|maximum-scale/.test(page), 'pinch to zoom must stay available');
});

test('no company name appears anywhere a user or a buyer could see it', async () => {
  // src/migrate.js is the one exception: it must name the old field keys in order to rename them.
  const files = ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'README.md', 'THIRD-PARTY-NOTICES.md', ...(await sourceFiles()).filter((file) => file !== 'src/migrate.js')];
  for (const name of await readdir(path.join(ROOT, 'docs')).catch(() => [])) files.push('docs/' + name);
  for (const file of files) {
    const text = await read(file).catch(() => '');
    assert.ok(!/bc\s*hydro|bchydro|\bbch\b|telus|hydro/i.test(text), file + ' mentions a company by name');
  }
});

test('the version number is the same everywhere', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.version, APP_VERSION);
  assert.ok((await read('sw.js')).includes("const VERSION = '" + APP_VERSION + '-'));
});

test('each copy of the app keeps its data under its own name', () => {
  // Under Node there is no page address, so the folder is "/".
  assert.equal(DB_NAME, 'polefield@/');
  assert.equal(STORAGE_PREFIX, 'polefield./.');
});

// ---------------------------------------------------------------------------------------------
// Colours

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('text colours are readable outdoors (contrast of at least 4.5 to 1)', async () => {
  const css = await read('styles.css');
  const token = (name) => {
    const found = new RegExp('--' + name + ':(#[0-9A-Fa-f]{6})').exec(css);
    assert.ok(found, 'styles.css has no --' + name);
    return found[1];
  };
  const pairs = [
    ['ink', 'ground'], ['ink', 'card'], ['muted', 'ground'], ['muted', 'card'], ['placeholder', 'card'], ['field', 'card'],
    ['accent-ink', 'accent-soft'], ['accent-ink', 'card'], ['accent-ink', 'ground'], ['warn-ink', 'warn-soft'], ['alert-ink', 'alert-soft'], ['alert-ink', 'card'], ['alert-ink', 'ground'],
  ];
  for (const [text, background] of pairs) {
    const ratio = contrast(token(text), token(background));
    assert.ok(ratio >= 4.5, text + ' on ' + background + ' is only ' + ratio.toFixed(2) + ' to 1');
  }
  assert.ok(contrast('#FFFFFF', token('accent')) >= 4.5, 'white on the button colour');
  assert.ok(contrast('#FFFFFF', token('ink')) >= 4.5, 'white on the dark card');
  assert.ok(contrast('#A3ACA8', token('ink')) >= 4.5, '"not entered" on the dark card');
  assert.ok(contrast('#FFB199', token('ink')) >= 4.5, '"check entry" on the dark card');
  assert.ok(contrast(token('accent'), token('ground')) >= 3, 'the focus ring against the page');
  assert.ok(contrast(token('field'), token('card')) >= 3, 'input borders against white');
});
