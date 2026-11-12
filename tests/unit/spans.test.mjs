import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, degreesText, between, gaps, deflection, nextBearing, fromGps, spanLine, gapsLine, deflectionLine, layout, arcPoints, MAX_SPANS } from '../../src/spans.js';
import { cleanSpans, cleanPole } from '../../src/records.js';
import { TEMPLATE } from '../../src/template.js';
import { exportColumns, exportSections, poleProgress, poleWarnings, validateTemplate } from '../../src/template-engine.js';
import { PdfDocument } from '../../src/pdf.js';
import { buildReport } from '../../src/report.js';

const span = (to, brg, extra) => ({ id: 'id-' + to, to, toPole: '', cond: '', len: '', brg, main: false, how: '', ...extra });
const TOKENS = { power: 'Power', telecom: 'Telecom' };

test('norm, between and degreesText', () => {
  assert.equal(norm(370), 10);
  assert.equal(norm(-10), 350);
  assert.equal(norm(360), 0);
  assert.equal(Object.is(norm(-360), 0), true, 'never minus zero');
  assert.equal(between(350, 10), 20);
  assert.equal(between(0, 180), 180);
  assert.equal(between(90, 90), 0);
  assert.equal(degreesText(13.594), '13.59°');
  assert.equal(degreesText(90), '90°');
  assert.equal(degreesText(NaN), '');
});

test('gaps: the angles between neighbours go clockwise and add up to 360', () => {
  const spans = [span('A', 258.59), span('R', 65), span('B', 126.84)];
  const list = gaps(spans);
  assert.deepEqual(list.map((g) => [g.from.to, g.to.to, g.angle]), [['R', 'B', 61.84], ['B', 'A', 131.75], ['A', 'R', 166.41]]);
  assert.equal(Math.round(list.reduce((sum, g) => sum + g.angle, 0) * 100) / 100, 360);
  assert.deepEqual(gaps([span('A', 10)]), []);
  assert.deepEqual(gaps([span('A', 10), span('B', 10)]).map((g) => g.angle), [0, 360], 'two spans on top of each other');
  assert.deepEqual(gaps([span('A', 350), span('B', 20)]).map((g) => g.angle), [330, 30]);
  assert.deepEqual(gaps([span('A', 10), span('B', null)]), [], 'a span with no direction is left out');
});

test('deflection: straight is zero, and the pair is the marked one or the straightest', () => {
  assert.equal(deflection([span('A', 0)]), null);
  assert.equal(deflection([span('A', 270), span('B', 90)]).angle, 0);
  const two = deflection([span('A', 258.59), span('R', 65)]);
  assert.deepEqual([two.angle, two.chosen], [13.59, 'only']);
  const three = deflection([span('A', 258.59), span('R', 65), span('B', 126.84)]);
  assert.deepEqual([three.a.to, three.b.to, three.angle, three.chosen], ['A', 'R', 13.59, 'straightest']);
  const marked = deflection([span('A', 258.59, { main: true }), span('R', 65), span('B', 126.84, { main: true })]);
  assert.deepEqual([marked.a.to, marked.b.to, marked.angle, marked.chosen], ['A', 'B', 48.25, 'marked']);
  const oneMark = deflection([span('A', 258.59, { main: true }), span('R', 65), span('B', 126.84)]);
  assert.equal(oneMark.chosen, 'straightest', 'one mark is not a pair');
});

test('nextBearing: left first, then opposite, then the middle of the widest gap', () => {
  assert.equal(nextBearing([]), 270);
  assert.equal(nextBearing([span('A', 270)]), 90);
  assert.equal(nextBearing([span('A', 270), span('B', 90)]), 180);
  assert.equal(nextBearing([span('A', 0), span('B', 90), span('C', 180)]), 270);
});

test('fromGps: direction and distance between two positions', () => {
  const here = { lat: 50.0244, lon: -125.2475, acc: 5 };
  const north = fromGps(here, { lat: 50.0253, lon: -125.2475, acc: 7 });
  assert.equal(north.brg, 0);
  assert.ok(Math.abs(north.dist - 100.1) < 0.5, String(north.dist));
  assert.equal(north.acc, 12);
  const east = fromGps(here, { lat: 50.0244, lon: -125.2461 });
  assert.ok(Math.abs(east.brg - 90) < 0.1, String(east.brg));
  assert.ok(Math.abs(east.dist - 100) < 1, String(east.dist));
  assert.equal(east.acc, null);
  assert.equal(fromGps(here, null), null);
  assert.equal(fromGps(here, here).dist, 0);
});

test('the one-line descriptions used in exports', () => {
  const spans = [span('A-059', 258.59, { len: '72.80', cond: '2/0 ACSR', main: true }), span('', 65)];
  assert.equal(spanLine(spans[0], 0), 'To A-059, 72.80 m, 2/0 ACSR, direction 258.59°, main line');
  assert.equal(spanLine(spans[1], 1), 'To Span 2, direction 65°');
  assert.equal(gapsLine(spans), 'Span 2 to A-059 193.59°; A-059 to Span 2 166.41°');
  assert.equal(deflectionLine(spans), '13.59° (between A-059 and Span 2)');
  assert.equal(deflectionLine([spans[0]]), '');
});

test('layout: ends sit on a circle in the right direction, with room for a label', () => {
  const g = layout([span('N', 0), span('E', 90), span('S', 180), span('W', 270)], { width: 300, height: 200, r: 50 });
  const [n, e, s, w] = g.ends;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(n.x, 150) && near(n.y, 50) && n.anchor === 'middle' && n.up === true);
  assert.ok(near(e.x, 200) && near(e.y, 100) && e.anchor === 'start');
  assert.ok(near(s.x, 150) && near(s.y, 150) && s.anchor === 'middle' && s.up === false);
  assert.ok(near(w.x, 100) && near(w.y, 100) && w.anchor === 'end');
  assert.ok(e.room > 60 && w.room > 60);
  assert.equal(g.angles.length, 4);
  assert.equal(g.through, null, 'a straight line has no dashed extension');
  const bent = layout([span('A', 270), span('B', 80)], { width: 300, height: 200, r: 50 });
  assert.ok(near(bent.through.x, 200) && near(bent.through.y, 100), 'the dashed line carries A straight on');
  const arc = arcPoints(0, 0, 10, 0, 90);
  assert.ok(near(arc[0].x, 0) && near(arc[0].y, -10) && near(arc[arc.length - 1].x, 10) && near(arc[arc.length - 1].y, 0));
});

test('cleanSpans keeps only usable spans', () => {
  assert.deepEqual(cleanSpans(null), []);
  assert.deepEqual(cleanSpans('x'), []);
  const out = cleanSpans([
    { id: 'a', to: '  059   210 ', cond: '2/0 ACSR', len: 72.8, brg: 618.594, main: 1, how: 'typed', toPole: 'p2', extra: 'x' },
    { id: 'a', to: 'same id again' },
    { id: 'b', to: 'x'.repeat(100), len: { evil: 1 }, brg: 'north', how: 'magic', toPole: '../etc' },
    { id: '', to: 'no id' },
    'not a span',
    { id: 'c', brg: -10 },
    { id: 'd', brg: 359.999 },
    { id: 'e', brg: Infinity, to: 'A\u0000B' },
  ]);
  assert.deepEqual(out[0], { id: 'a', to: '059 210', toPole: 'p2', cond: '2/0 ACSR', len: '72.8', brg: 258.59, main: false, how: 'typed' });
  assert.deepEqual(out[1], { id: 'b', to: 'x'.repeat(60), toPole: '', cond: '', len: '', brg: null, main: false, how: '' });
  assert.equal(out[2].brg, 350);
  assert.equal(out[3].brg, 0, '359.999 rounds to a full turn, which is north');
  assert.deepEqual([out[4].brg, out[4].to], [null, 'AB']);
  assert.equal(out.length, 5);
  const many = cleanSpans(Array.from({ length: 20 }, (_, i) => ({ id: 's' + i, brg: i })));
  assert.equal(many.length, MAX_SPANS);
  assert.deepEqual(cleanPole({ id: 'p', jobId: 'j' }, 1000).spans, [], 'a pole stored by an older version gets an empty list');
  assert.equal(cleanPole({ id: 'p', jobId: 'j', spans: [{ id: 'a', brg: 5, main: true }] }, 1000).spans[0].main, true);
});

test('the template: the diagram is exported, warned about, and stands in for "Span 1"', () => {
  assert.deepEqual(validateTemplate(TEMPLATE), []);
  const pole = { id: 'p', jobId: 'j', f: {}, gps: null, spans: [], done: false };
  const blank = (p) => poleProgress(TEMPLATE, p, TOKENS).blank.map((b) => b.key);
  assert.ok(blank(pole).includes('span1'));
  const drawn = { ...pole, spans: [span('A', 270, { len: '40' }), span('B', 85, { len: '' }), span('C', 10, { len: 'far' })] };
  assert.ok(!blank(drawn).includes('span1'), 'a drawn span answers the question');
  const warnings = poleWarnings(TEMPLATE, drawn, TOKENS, {}).filter((w) => w.key === 'spanMap').map((w) => w.text);
  assert.deepEqual(warnings, ['No length for the span to B', 'Check the length of the span to C']);

  const columns = exportColumns(TEMPLATE, TOKENS);
  const read = (id) => columns.find((c) => c.id === id).read({ f: {} }, drawn, { number: 1, photos: 0, computed: {} });
  assert.equal(read('spans.1'), 'To A, 40 m, direction 270°');
  assert.equal(read('spans.4'), '');
  assert.equal(read('spans.deflection'), '5° (between A and B)');
  assert.equal(columns.filter((c) => c.id.startsWith('spans.')).length, MAX_SPANS + 2);
  assert.equal(columns.find((c) => c.id === 'spans.1').read({ f: {} }, { f: {} }, {}), '', 'a pole with no list of spans');
  const section = exportSections(TEMPLATE, TOKENS).find((s) => s.diagram);
  assert.equal(section.title, 'Spans');
});

test('the PDF writer draws lines through points and circles', () => {
  const doc = new PdfDocument({ created: new Date(2026, 0, 2) });
  const page = doc.addPage();
  page.polyline([{ x: 10, top: 20 }, { x: 30, top: 40 }, { x: 50, top: 20 }], '#FF0000', 2, { dash: [4, 3] });
  page.polyline([{ x: 1, top: 1 }], '#000000', 1);
  page.circle(100, 100, 10, { fill: '#FFFFFF', stroke: '#0000FF', lineWidth: 1.5 });
  page.circle(100, 100, 5, { fill: '#000000' });
  const ops = page.ops.join('\n');
  assert.match(ops, /q \[4 3\] 0 d 1 J 1 j 1 0 0 RG 2 w 10 772 m 30 752 l 50 772 l S Q/);
  assert.equal(page.ops.length, 3, 'a single point draws nothing');
  assert.match(page.ops[1], /^q 1 1 1 rg 0 0 1 RG 1\.5 w 110 692 m .* c h B Q$/);
  assert.match(page.ops[2], / f Q$/);
  assert.ok(doc.finish().size > 500);
});

test('the report draws the span diagram on the pole page', async () => {
  const pole = { id: 'p1', jobId: 'j1', f: { tagMap: 'T-1' }, gps: null, done: true, spans: [span('A-059', 258.59, { len: '72.80', cond: '2/0 ACSR' }), span('REG (x)', 65, { len: '34.16' })] };
  const data = { template: TEMPLATE, tokens: TOKENS, madeAt: Date.UTC(2026, 0, 2), jobs: [{ job: { id: 'j1', f: { location: 'Test Rd' } }, poles: [{ pole, number: 1, photos: [] }] }] };
  const report = await buildReport(data, async () => null);
  const text = Buffer.concat(report.parts.map((part) => Buffer.from(part))).toString('latin1');
  for (const words of ['(A-059) Tj', '(72.80 m) Tj', '(2/0 ACSR) Tj', '(REG \\(x\\)) Tj', '(166.41\\260) Tj', '(193.59\\260) Tj', '(13.59\\260 \\(between A-059 and REG \\(x\\)\\)) Tj', '[4 3] 0 d']) {
    assert.ok(text.includes(words), 'the file holds: ' + words);
  }
  const none = await buildReport({ ...data, jobs: [{ job: data.jobs[0].job, poles: [{ pole: { ...pole, spans: [] }, number: 1, photos: [] }] }] }, async () => null);
  const plain = Buffer.concat(none.parts.map((part) => Buffer.from(part))).toString('latin1');
  assert.ok(!plain.includes('Seen from above'), 'no diagram without spans');
  const old = await buildReport({ ...data, jobs: [{ job: data.jobs[0].job, poles: [{ pole: { id: 'p1', jobId: 'j1', f: {}, gps: null, done: false }, number: 1, photos: [] }] }] }, async () => null);
  assert.ok(old.size > 500, 'a pole with no list of spans still makes a report');
});
