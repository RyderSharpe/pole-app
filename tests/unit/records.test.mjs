import test from 'node:test';
import assert from 'node:assert/strict';
import { uid, today, cleanText, cutText, cleanFields, cleanId, cleanTime, cleanGps, cleanJob, cleanPole, cleanPhoto, cleanSettings, defaultSettings, safeFileName } from '../../src/records.js';
import { isV1Job, convertV1Fields, convertV1Job, convertV1Photo } from '../../src/migrate.js';
import { planJournal, planReplay, planCleanUp } from '../../src/store.js';
import { TRASH_DAYS } from '../../src/config.js';

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

test('uid gives a fresh id every time', () => {
  const ids = new Set(Array.from({ length: 500 }, uid));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('today is the local date', () => {
  assert.equal(today(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('cleanFields keeps plain answers and drops everything else', () => {
  const hostile = JSON.parse('{"tagMap":"A1","ww":true,"off":false,"n":5,"nested":{"a":1},"list":[1],"nul":null,"bad key":"x","9lives":"x","__proto__":{"polluted":true},"constructor":"x","prototype":"x","empty":""}');
  const out = cleanFields(hostile);
  assert.deepEqual(out, { tagMap: 'A1', ww: true, n: '5' });
  assert.equal({}.polluted, undefined, 'nothing leaked onto every object');
  assert.deepEqual(cleanFields(null), {});
  assert.deepEqual(cleanFields('text'), {});
  assert.deepEqual(cleanFields([1, 2]), {});
  assert.deepEqual(cleanFields(new Date()), {});
});

test('cleanText removes what a file cannot hold and never splits a character', () => {
  assert.equal(cleanText('a\u0000b\u0007c\u007fd\ufffee\uffff'), 'abcde');
  assert.equal(cleanText('lone \ud83d half'), 'lone  half', 'half of a two-part character is dropped');
  assert.equal(cleanText('lone \ude00 half'), 'lone  half');
  assert.equal(cleanText('pair \ud83d\ude00 kept'), 'pair \ud83d\ude00 kept', 'a whole emoji is kept');
  assert.equal(cleanText('tab\tline\nreturn\r'), 'tab\tline\nreturn\r');
  assert.equal(cleanText('ab\ud83d\ude00', 3), 'ab', 'a cut never leaves half an emoji');
  assert.equal(cutText('ab\ud83d\ude00cd', 4), 'ab\ud83d\ude00');
  assert.equal(cutText('abc', 10), 'abc');
});

test('cleanFields caps very long text and removes control characters', () => {
  const out = cleanFields({ notes: 'a\u0000b\u0007c\nd\te' + 'x'.repeat(30000) });
  assert.ok(out.notes.startsWith('abc\nd\te'), 'line breaks and tabs are kept');
  assert.equal(out.notes.length, 20000);
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(42), '42');
  const many = {};
  for (let i = 0; i < 700; i += 1) many['k' + i] = 'v';
  assert.equal(Object.keys(cleanFields(many)).length, 500);
});

test('cleanId accepts ordinary ids and refuses odd ones', () => {
  assert.equal(cleanId('3f2b'), '3f2b');
  assert.equal(cleanId('0b6c5f9e-1d2a-4c3b-9e8f-7a6b5c4d3e2f'), '0b6c5f9e-1d2a-4c3b-9e8f-7a6b5c4d3e2f');
  assert.equal(cleanId('id-1696000000000-a1b2'), 'id-1696000000000-a1b2', 'first-version ids');
  assert.equal(cleanId('v1-job.1_2'), 'v1-job.1_2');
  assert.equal(cleanId(42), '42');
  assert.equal(cleanId(42.9), '42');
  assert.equal(cleanId(-1), '');
  assert.equal(cleanId(''), '');
  assert.equal(cleanId('a:b'), '', 'a colon would break the picture keys');
  assert.equal(cleanId('a\nb'), '');
  assert.equal(cleanId('a b'), '');
  assert.equal(cleanId('../x'), '', 'an id can never climb out of a folder');
  assert.equal(cleanId('-x'), '', 'an id starts with a letter or digit');
  assert.equal(cleanId('.x'), '');
  assert.equal(cleanId('é'), '');
  assert.equal(cleanId('x'.repeat(100)), 'x'.repeat(100));
  assert.equal(cleanId('x'.repeat(101)), '');
  assert.equal(cleanId(null), '');
  assert.equal(cleanId({}), '');
});

test('times: anything that is not a time gets the fallback, and only times from a file are capped', () => {
  assert.equal(cleanTime(NOW - 5, 7), NOW - 5);
  assert.equal(cleanTime(NOW + 0.9, 7), NOW, 'whole milliseconds');
  assert.equal(cleanTime(-1, 7), 7);
  assert.equal(cleanTime(0, 7), 7);
  assert.equal(cleanTime('yesterday', 7), 7);
  assert.equal(cleanTime(NaN, 7), 7);
  assert.equal(cleanTime(Infinity, 7), 7);
  assert.equal(cleanTime(9e15, 7), 7, 'beyond the last date a computer can show');
  assert.equal(cleanTime(undefined), 0);
  // Records saved on this phone keep their times, even ones ahead of the clock. A phone whose
  // clock was fast and is then put right must keep the order its records were made in.
  assert.equal(cleanTime(NOW + 10 * DAY, 0), NOW + 10 * DAY);
  const mine = cleanJob({ id: 'j1', f: {}, createdAt: NOW + DAY, updatedAt: NOW + 2 * DAY, exportedAt: NOW + DAY }, NOW);
  assert.deepEqual([mine.createdAt, mine.updatedAt, mine.exportedAt], [NOW + DAY, NOW + 2 * DAY, NOW + DAY]);
  // Times from a file are capped, so a wrong clock or an edited file cannot outrank later work.
  const cap = NOW + 7 * DAY;
  assert.equal(cleanTime(NOW + 10 * DAY, 0, cap), cap);
  assert.equal(cleanTime(NOW + 2 * DAY, 0, cap), NOW + 2 * DAY, 'small errors keep their order');
  const fromFile = cleanJob({ id: 'j1', f: {}, createdAt: NOW + 400 * DAY, updatedAt: NOW + 500 * DAY, exportedAt: NOW + 450 * DAY, deletedAt: NOW + 600 * DAY }, NOW, cap);
  assert.deepEqual([fromFile.createdAt, fromFile.updatedAt, fromFile.exportedAt, fromFile.deletedAt], [cap, cap, cap, cap]);
  assert.equal(cleanJob({ id: 'j1' }, NOW + 20 * DAY, cap).createdAt, cap, 'a missing time is never later than the cap');
  assert.deepEqual(cleanGps({ lat: 1, lon: 2, acc: 3, at: NOW + 20 * DAY }, cap).at, cap);
});

test('cleanJob, cleanPole and cleanPhoto reject records that cannot be used', () => {
  assert.equal(cleanJob(null, NOW), null);
  assert.equal(cleanJob({ f: {} }, NOW), null);
  assert.equal(cleanJob('job', NOW), null);
  assert.equal(cleanPole({ id: 'p1' }, NOW), null, 'a pole needs its job');
  assert.equal(cleanPhoto({ id: 'f1', poleId: 'p1' }, NOW), null, 'a photo needs its job');
  const job = cleanJob({ id: 'j1' }, NOW);
  assert.deepEqual(job, { id: 'j1', f: {}, createdAt: NOW, updatedAt: NOW, exportedAt: 0 });
  assert.ok(!('deletedAt' in job));
  const pole = cleanPole({ id: 'p1', jobId: 'j1', f: { tagMap: 'A1', evil: { a: 1 } }, done: 'yes', gps: { lat: 91, lon: 0 }, extra: 1 }, NOW);
  assert.deepEqual(pole, { id: 'p1', jobId: 'j1', f: { tagMap: 'A1' }, gps: null, spans: [], done: false, createdAt: NOW, updatedAt: NOW });
  const photo = cleanPhoto({ id: 'f1', poleId: 'p1', jobId: 'j1', label: '  Pole   tag  ', w: 1500.4, h: -3, bytes: 'big', deletedAt: NOW - 5 }, NOW);
  assert.deepEqual(photo, { id: 'f1', poleId: 'p1', jobId: 'j1', label: 'Pole tag', w: 1500, h: 0, bytes: 0, createdAt: NOW, updatedAt: NOW, deletedAt: NOW - 5 });
});

test('cleanGps accepts real positions only', () => {
  assert.deepEqual(cleanGps({ lat: 50.02, lon: -125.24, acc: 6.5, at: NOW - 1 }, NOW), { lat: 50.02, lon: -125.24, acc: 6.5, at: NOW - 1 });
  assert.deepEqual(cleanGps({ lat: 0, lon: 0 }, NOW), { lat: 0, lon: 0, acc: null, at: 0 });
  assert.equal(cleanGps({ lat: '50', lon: -125 }, NOW), null);
  assert.equal(cleanGps({ lat: 50, lon: 181 }, NOW), null);
  assert.equal(cleanGps({ lat: NaN, lon: 1 }, NOW), null);
  assert.equal(cleanGps(null, NOW), null);
  assert.equal(cleanGps({ lat: 50, lon: 1, acc: -4 }, NOW).acc, null);
});

test('cleanSettings falls back to the defaults', () => {
  assert.deepEqual(cleanSettings(undefined), defaultSettings());
  const raw = { collectedBy: '  R.   Sharpe ', tokens: { power: ' {Power} Co ', telecom: '' }, lastBackupAt: NOW + DAY, legacyChecked: true, legacyPhotosLeft: 'yes', admin: true };
  assert.deepEqual(cleanSettings(raw), { collectedBy: 'R. Sharpe', tokens: { power: 'Power Co', telecom: 'Telecom' }, lastBackupAt: NOW + DAY, legacyChecked: true, legacyPhotosLeft: false });
  assert.equal(cleanSettings(raw, NOW).lastBackupAt, NOW, 'capped when it comes from a file');
  assert.equal(cleanSettings({ legacyPhotosLeft: true }).legacyPhotosLeft, true);
  assert.deepEqual(cleanSettings({ tokens: 'x' }).tokens, { power: 'Power', telecom: 'Telecom' });
});

test('safeFileName makes names every phone and computer accepts', () => {
  assert.equal(safeFileName('Dogwood St / 5th Ave: #12 <test>.. '), 'Dogwood_St_5th_Ave_#12_test');
  assert.equal(safeFileName('../../etc/passwd'), 'etc_passwd');
  assert.equal(safeFileName('con'), '_con');
  assert.equal(safeFileName('LPT1'), '_LPT1');
  assert.equal(safeFileName('   '), 'file');
  assert.equal(safeFileName('', 'Pole_Field_Data'), 'Pole_Field_Data');
  assert.equal(safeFileName(null, 'x'), 'x');
  assert.equal(safeFileName('Île-à-la-Crosse né'), 'Île-à-la-Crosse_né');
  assert.equal(safeFileName('東京 第1'), '東京_第1');
  assert.equal(safeFileName('a"b\'c`d$e;f|g'), 'a_b_c_d_e_f_g');
  assert.equal(safeFileName('R&D #4 + spare'), 'R&D_#4_+_spare');
  assert.equal(safeFileName('a\u0000b\nc'), 'ab_c', 'control characters are dropped, a line break becomes _');
  assert.equal(safeFileName('nul.txt'), '_nul.txt');
  assert.equal(safeFileName('Com¹'), '_Com¹');
  assert.equal(safeFileName('CONSOLE'), 'CONSOLE', 'only the exact reserved names are changed');
  assert.equal(safeFileName('😀 Pole'), 'Pole');
  const bytes = (text) => new TextEncoder().encode(text).length;
  assert.equal(bytes(safeFileName('x'.repeat(300))), 120);
  const wide = safeFileName('東'.repeat(100));
  assert.ok(bytes(wide) <= 120 && /^東+$/.test(wide), 'a cut never splits a character');
  assert.ok(!/[_.\-]$/.test(safeFileName('x'.repeat(119) + '._-')));
});

// ---------------------------------------------------------------------------------------------
// Data from the first version of the app

const V1_JOB = {
  id: 'job-1', location: 'Dogwood St', date: '2026-09-01', collectedBy: 'RS', designNo: 'D-1', otherId: '',
  createdAt: NOW - 3 * DAY, updatedAt: NOW - 2 * DAY, exportedAt: NOW - DAY,
  poles: [
    { id: 'p1', done: true, f: { tagMap: 'A1', bchDip: 'Yes', telusPlant: 'No', bchAnchor: 'Yes', bchSlots: '2', bchPlate: '10 ft', bchRod: '3/4', telusAnchor: 'No', telusSlots: '', telusDip: 'No', gP: '9.4', ww: true }, photoIds: ['ph1', 'ph2'] },
    { id: 'p2', done: false, f: {}, photoIds: [] },
  ],
};

test('first-version field keys are renamed, and a filled new key is never overwritten', () => {
  assert.deepEqual(convertV1Fields(V1_JOB.poles[0].f), {
    tagMap: 'A1', gP: '9.4', ww: true, powerDip: 'Yes', telPlant: 'No', powerAnchor: 'Yes', powerSlots: '2', powerPlate: '10 ft', powerRod: '3/4', telAnchor: 'No', telDip: 'No',
  });
  assert.deepEqual(convertV1Fields({ bchDip: 'Yes', powerDip: 'No' }), { powerDip: 'No' });
  assert.deepEqual(convertV1Fields(null), {});
});

test('a first-version job is split into a job, its poles and its photo owners', () => {
  assert.ok(isV1Job(V1_JOB));
  assert.ok(!isV1Job({ id: 'x', f: {} }));
  assert.ok(!isV1Job(null));
  const out = convertV1Job(V1_JOB, NOW, () => false);
  assert.deepEqual(out.job, { id: 'job-1', f: { location: 'Dogwood St', date: '2026-09-01', collectedBy: 'RS', designNo: 'D-1' }, createdAt: NOW - 3 * DAY, updatedAt: NOW - 2 * DAY, exportedAt: NOW - DAY });
  assert.deepEqual(out.poles.map((p) => [p.id, p.jobId, p.done, p.createdAt - out.job.createdAt]), [['p1', 'job-1', true, 0], ['p2', 'job-1', false, 1]]);
  assert.deepEqual([...out.photoOwners], [['ph1', { poleId: 'p1', jobId: 'job-1' }], ['ph2', { poleId: 'p1', jobId: 'job-1' }]]);
});

test('first-version oddities: numeric ids, repeated pole ids, broken records', () => {
  const odd = { id: 17, poles: [{ id: 'p1', f: {}, photoIds: [5] }, { id: 'p1', f: {} }, null, { f: {}, photoIds: 'x' }, { id: 'p:9', f: {} }] };
  // "p1" already belongs to a pole of another job, so it is never reused.
  const usedElsewhere = (id, jobId) => id === 'p1' && jobId !== 'other-job';
  const out = convertV1Job(odd, NOW, usedElsewhere);
  assert.equal(out.job.id, '17');
  assert.deepEqual(out.poles.map((p) => p.id), ['v1-17-1', 'v1-17-2', 'v1-17-4', 'v1-17-5']);
  assert.deepEqual([...out.photoOwners], [['5', { poleId: 'v1-17-1', jobId: '17' }]]);
  // Run again after an interruption, the same poles get the same ids, so nothing is doubled.
  const mine = new Set(out.poles.map((p) => p.id));
  const again = convertV1Job(odd, NOW, (id, jobId) => usedElsewhere(id, jobId) && !mine.has(id));
  assert.deepEqual(again.poles.map((p) => p.id), ['v1-17-1', 'v1-17-2', 'v1-17-4', 'v1-17-5']);
  // A made-up id that is itself taken by another job moves on to the next free one.
  const crowded = convertV1Job({ id: 'j', poles: [{ id: 'p1' }] }, NOW, (id) => id === 'p1' || id === 'v1-j-1');
  assert.deepEqual(crowded.poles.map((p) => p.id), ['v1-j-1-2']);
  // A repeat inside one job keeps the first and renames the second.
  assert.deepEqual(convertV1Job({ id: 'j', poles: [{ id: 'a' }, { id: 'a' }] }, NOW, () => false).poles.map((p) => p.id), ['a', 'v1-j-2']);
  assert.equal(convertV1Job({ poles: [] }, NOW, () => false), null, 'a job with no id cannot be used');
  assert.equal(convertV1Job({ id: 'x' }, NOW, () => false), null);
  assert.equal(convertV1Job({ id: 'bad id', poles: [] }, NOW, () => false), null);
});

test('first-version photo details', () => {
  const owner = { poleId: 'p1', jobId: 'job-1' };
  assert.deepEqual(convertV1Photo({ id: 'ph1', createdAt: NOW - 5 }, owner, NOW), { id: 'ph1', poleId: 'p1', jobId: 'job-1', label: '', w: 0, h: 0, bytes: 0, createdAt: NOW - 5, updatedAt: NOW - 5 });
  assert.equal(convertV1Photo(null, owner, NOW), null);
  assert.equal(convertV1Photo({ id: 'ph1' }, null, NOW), null);
});

// ---------------------------------------------------------------------------------------------
// The crash-proof journal

const maps = (jobs = [], poles = [], photos = []) => ({
  jobs: new Map(jobs.map((r) => [r.id, r])),
  poles: new Map(poles.map((r) => [r.id, r])),
  photos: new Map(photos.map((r) => [r.id, r])),
});

test('planJournal copies only what has not reached the database', () => {
  const job = { id: 'j1', f: { location: 'A' }, updatedAt: 5 };
  const pole = { id: 'p1', jobId: 'j1', f: {}, updatedAt: 6 };
  const read = { job: (id) => (id === 'j1' ? job : undefined), pole: (id) => (id === 'p1' ? pole : undefined), photo: () => undefined, settings: () => ({ collectedBy: 'RS' }) };
  assert.deepEqual(planJournal({ jobs: ['j1', 'gone'], poles: ['p1'], photos: ['x'], settings: false }, read, NOW), { v: 1, at: NOW, jobs: [job], poles: [pole], photos: [], settings: null });
  assert.equal(planJournal({ jobs: [], poles: [], photos: [], settings: false }, read, NOW), null);
  assert.equal(planJournal({ jobs: ['gone'], poles: [], photos: [], settings: false }, read, NOW), null);
  assert.deepEqual(planJournal({ jobs: [], poles: [], photos: [], settings: true }, read, NOW).settings, { collectedBy: 'RS' });
});

test('planReplay puts back only what is newer than the phone has', () => {
  const local = maps(
    [{ id: 'j1', updatedAt: 10 }, { id: 'j2', updatedAt: 50 }],
    [{ id: 'p1', jobId: 'j1', updatedAt: 10 }],
    [{ id: 'f1', poleId: 'p1', jobId: 'j1', updatedAt: 10 }],
  );
  const journal = {
    v: 1,
    jobs: [{ id: 'j1', f: { location: 'newer' }, updatedAt: 20 }, { id: 'j2', f: { location: 'older' }, updatedAt: 40 }, { id: 'j3', f: {}, updatedAt: 5 }, { f: {} }],
    poles: [{ id: 'p1', jobId: 'j1', f: { tagMap: 'A2' }, updatedAt: 11 }, { id: 'p9', jobId: 'j1', f: {}, updatedAt: 1 }],
    photos: [{ id: 'f1', poleId: 'p1', jobId: 'j1', label: 'Pole tag', updatedAt: 30 }, { id: 'f-new', poleId: 'p1', jobId: 'j1', updatedAt: 30 }],
    settings: { collectedBy: 'RS' },
  };
  const plan = planReplay(journal, local, NOW);
  assert.deepEqual(plan.jobs.map((j) => j.id), ['j1', 'j3']);
  assert.deepEqual(plan.poles.map((p) => p.id), ['p1', 'p9']);
  assert.deepEqual(plan.photos.map((p) => p.id), ['f1'], 'a photo is never created from a journal, because the journal holds no picture');
  assert.equal(plan.settings.collectedBy, 'RS');
});

test('planReplay ignores a journal it does not understand', () => {
  const empty = { jobs: [], poles: [], photos: [], settings: null };
  assert.deepEqual(planReplay(null, maps(), NOW), empty);
  assert.deepEqual(planReplay('text', maps(), NOW), empty);
  assert.deepEqual(planReplay({ v: 2, jobs: [{ id: 'j1' }] }, maps(), NOW), empty);
  assert.deepEqual(planReplay({ v: 1, jobs: 'nope', poles: null }, maps(), NOW), empty);
});

test('planCleanUp removes only what is past its 30 days or has lost its parent', () => {
  const old = NOW - (TRASH_DAYS + 1) * DAY;
  const recent = NOW - (TRASH_DAYS - 1) * DAY;
  const held = maps(
    [{ id: 'live' }, { id: 'old-job', deletedAt: old }, { id: 'recent-job', deletedAt: recent }],
    [
      { id: 'p-live', jobId: 'live' },
      { id: 'p-old', jobId: 'live', deletedAt: old },
      { id: 'p-recent', jobId: 'live', deletedAt: recent },
      { id: 'p-of-old-job', jobId: 'old-job' },
      { id: 'p-orphan', jobId: 'no-such-job' },
      { id: 'p-of-recent-job', jobId: 'recent-job' },
    ],
    [
      { id: 'f-live', poleId: 'p-live' },
      { id: 'f-old', poleId: 'p-live', deletedAt: old },
      { id: 'f-recent', poleId: 'p-live', deletedAt: recent },
      { id: 'f-of-old-pole', poleId: 'p-old' },
      { id: 'f-of-old-job', poleId: 'p-of-old-job' },
      { id: 'f-orphan', poleId: 'no-such-pole' },
    ],
  );
  const plan = planCleanUp(held, NOW);
  assert.deepEqual(plan.jobs, ['old-job']);
  assert.deepEqual(plan.poles.sort(), ['p-old', 'p-orphan']);
  assert.deepEqual(plan.photos.sort(), ['f-old', 'f-orphan'], 'photos of removed poles go with their pole, so they are not listed twice');
  assert.deepEqual(planCleanUp(maps([{ id: 'a' }], [{ id: 'p', jobId: 'a' }], [{ id: 'f', poleId: 'p' }]), NOW), { jobs: [], poles: [], photos: [] });
});
