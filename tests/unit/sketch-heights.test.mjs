import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanExtras, cleanSketch, cleanPole, cleanPhoto, MAX_EXTRAS } from '../../src/records.js';
import { snapAngle, distToSegment, hit, itemAt, moveItem, handles, resizeItem, thin, snapToAnchor, anchors, bounds, SYMBOLS, MAX_POINTS } from '../../src/scene.js';
import { TEMPLATE } from '../../src/template.js';
import { exportColumns, exportSections, poleWarnings, extraRows, validateTemplate } from '../../src/template-engine.js';

const TOKENS = { power: 'Power', telecom: 'Telecom' };
const NOW = 1700000000000;

test('the "other" heights are cleaned and limited', () => {
  const list = cleanExtras([
    { id: 'a1', what: '  Cable   riser ', h: 4.2 },
    { id: 'a1', what: 'duplicate', h: '1' },
    { what: 'no id', h: '2' },
    'junk',
    { id: 'b2', what: 'x'.repeat(200), h: '3,5 m' },
  ]);
  assert.deepEqual(list.map((x) => [x.id, x.what.length > 60 ? 'long' : x.what, x.h]), [['a1', 'Cable riser', '4.2'], ['b2', 'x'.repeat(60), '3,5 m']]);
  const many = cleanExtras(Array.from({ length: 40 }, (_, i) => ({ id: 'id' + i, what: 'w', h: '1' })));
  assert.equal(many.length, MAX_EXTRAS);
  assert.deepEqual(cleanExtras(null), []);
});

test('the single "Other" height of earlier versions becomes the first entry of the list', () => {
  const pole = cleanPole({ id: 'p1', jobId: 'j1', f: { tagMap: 'A1', gOther: '4.2', otherWhat: 'Fibre box' } }, NOW);
  assert.deepEqual(pole.extras.map((x) => [x.what, x.h]), [['Fibre box', '4.2']]);
  assert.equal(pole.f.gOther, undefined);
  assert.equal(pole.f.otherWhat, undefined);
  assert.equal(pole.f.tagMap, 'A1');
  // Cleaning again changes nothing.
  assert.deepEqual(cleanPole(pole, NOW).extras, pole.extras);
});

test('other heights make one tidy line each, in the report rows and one column', () => {
  const pole = { f: {}, extras: [{ id: 'a', what: 'Cable riser', h: '4,2' }, { id: 'b', what: '', h: '3' }, { id: 'c', what: 'Empty', h: '' }, { id: 'd', what: '', h: '' }] };
  assert.deepEqual(extraRows(pole), [
    { label: 'Cable riser (m)', value: 4.2 },
    { label: 'Other (m)', value: 3 },
    { label: 'Empty (m)', value: '' },
  ]);
  const section = exportSections(TEMPLATE, TOKENS).find((s) => s.title === 'Heights from ground');
  const row = section.rows.find((r) => r.expand);
  assert.deepEqual(row.expand({}, pole).map((r) => r.label), ['Cable riser (m)', 'Other (m)', 'Empty (m)']);
  const column = exportColumns(TEMPLATE, TOKENS).find((c) => c.id === 'extras');
  assert.equal(column.read({}, pole), 'Cable riser 4.2 m; Other 3 m; Empty ?');
  // No "Other" row followed by an "Other: what is it" row any more.
  const labels = section.rows.map((r) => r.label);
  assert.ok(!labels.some((l) => /what is it/i.test(l)));
});

test('other heights that look wrong are flagged', () => {
  const warn = (extras) => poleWarnings(TEMPLATE, { f: {}, extras }, TOKENS).filter((w) => w.key === 'extras').map((w) => w.text);
  assert.deepEqual(warn([]), []);
  assert.deepEqual(warn([{ id: 'a', what: 'Riser', h: '4' }]), []);
  assert.deepEqual(warn([{ id: 'a', what: 'Riser', h: '' }]), ['No height for Riser']);
  assert.deepEqual(warn([{ id: 'a', what: '', h: '4' }]), ['Say what the 4 m height is']);
  assert.deepEqual(warn([{ id: 'a', what: 'Riser', h: 'high' }]), ['Check the height of Riser']);
  assert.deepEqual(warn([{ id: 'a', what: 'Riser', h: '90' }]), ['Check the height of Riser']);
  assert.deepEqual(warn([{ id: 'a', what: '', h: '' }]), []);
});

test('heights are asked bottom to top', () => {
  const heights = TEMPLATE.pole.steps.find((s) => s.key === 'heights');
  const keys = heights.items.map((i) => i.key);
  const order = ['gT2', 'gT', 'gS', 'gN', 'gSL', 'gXB', 'gXT', 'gP', 'gTop', 'extras'];
  assert.deepEqual(keys.filter((k) => order.includes(k)), order);
  assert.deepEqual(validateTemplate(TEMPLATE), []);
});

test('a sketch is cleaned to what can be opened again', () => {
  const scene = cleanSketch({
    v: 9, w: 1200, h: 1500, bg: 'photo1',
    items: [
      { t: 'line', c: '#d42a20', w: 8, a: [10.04, 20], b: [100, 20] },
      { t: 'pen', c: 'red', w: 99999, p: [[1, 2], [3, 4], ['x', 1]] },
      { t: 'text', c: '#14181A', s: 45, x: 5, y: 6, text: '  PRIMARY   25 KV ', w: 300 },
      { t: 'text', c: '#14181A', s: 45, x: 5, y: 6, text: '   ' },
      { t: 'sym', k: 'tx1', c: '#14181A', s: 1.6, r: 45, x: 50, y: 60, text: '1PH TX' },
      { t: 'sym', k: 'not-a-symbol', x: 1, y: 1 },
      { t: 'wiggle' },
      null,
    ],
  });
  assert.equal(scene.v, 1);
  assert.equal(scene.bg, 'photo1');
  assert.deepEqual(scene.items.map((i) => i.t), ['line', 'pen', 'text', 'sym']);
  assert.equal(scene.items[0].c, '#D42A20');
  assert.deepEqual(scene.items[0].a, [10, 20]);
  assert.equal(scene.items[1].c, '#14181A');
  assert.equal(scene.items[1].w, 60);
  assert.equal(scene.items[1].p.length, 2);
  assert.equal(scene.items[2].text, 'PRIMARY 25 KV');
  assert.equal(cleanSketch(null), null);
  assert.equal(cleanSketch({ items: 'no' }), null);
  const photo = cleanPhoto({ id: 'ph1', poleId: 'p1', jobId: 'j1', label: 'Sketch', w: 1200, h: 1500, bytes: 5, sketch: { w: 1200, h: 1500, items: [{ t: 'line', c: '#14181A', w: 8, a: [0, 0], b: [5, 5] }] } }, NOW);
  assert.equal(photo.sketch.items.length, 1);
  assert.equal(cleanPhoto({ id: 'ph1', poleId: 'p1', jobId: 'j1' }, NOW).sketch, undefined);
});

test('every standard symbol has a name, words and a shape that the sketch accepts', () => {
  assert.ok(SYMBOLS.length >= 10);
  const keys = new Set(SYMBOLS.map((s) => s.key));
  assert.equal(keys.size, SYMBOLS.length);
  for (const s of SYMBOLS) {
    assert.ok(s.name && typeof s.text === 'string', s.key); // a bare pole has no words by design
    assert.equal(cleanSketch({ items: [{ t: 'sym', k: s.key, c: '#14181A', s: 1, x: 1, y: 1, text: s.text }] }).items.length, 1, s.key);
  }
  for (const wanted of ['tx1', 'tx3', 'sl', 'epole', 'ecross', 'etx', 'esl', 'esec']) assert.ok(keys.has(wanted));
});

test('lines snap level, upright and to 45 degrees only when close', () => {
  const a = [100, 100];
  assert.deepEqual(snapAngle(a, [300, 108], 5).map(Math.round), [300, 100]);
  assert.deepEqual(snapAngle(a, [108, 300], 5).map(Math.round), [100, 300]);
  const diag = snapAngle(a, [300, 296], 5);
  assert.ok(Math.abs(diag[0] - 100 - (diag[1] - 100)) < 1e-9);
  assert.deepEqual(snapAngle(a, [300, 170], 5), [300, 170]); // about 19 degrees: left as drawn
  assert.deepEqual(snapAngle(a, [100, 100], 5), [100, 100]);
});

test('touching an item finds the topmost one, and a finger has some reach', () => {
  const line = { t: 'line', c: '#000000', w: 8, a: [0, 100], b: [200, 100] };
  const sym = { t: 'sym', k: 'tx1', c: '#000000', s: 1, r: 0, x: 100, y: 100, text: 'TX' };
  const text = { t: 'text', c: '#000000', s: 40, x: 300, y: 300, text: 'HELLO', w: 120 };
  const items = [line, sym, text];
  assert.equal(itemAt(items, { x: 100, y: 100 }, 10), sym, 'the symbol is on top of the line');
  assert.equal(itemAt(items, { x: 10, y: 105 }, 10), line);
  assert.equal(itemAt(items, { x: 10, y: 140 }, 10), null);
  assert.equal(itemAt(items, { x: 350, y: 305 }, 10), text);
  assert.equal(itemAt(items, { x: 500, y: 500 }, 10), null);
  assert.ok(Math.abs(distToSegment({ x: 50, y: 130 }, [0, 100], [100, 100]) - 30) < 1e-9);
});

test('items move, resize, and show where they can be grabbed', () => {
  const line = { t: 'line', c: '#000000', w: 8, a: [0, 0], b: [10, 0] };
  moveItem(line, 5, 7);
  assert.deepEqual([line.a, line.b], [[5, 7], [15, 7]]);
  assert.deepEqual(handles(line).map((h) => h.id), ['a', 'b']);
  resizeItem(line, 2);
  assert.equal(line.w, 16);
  const sym = { t: 'sym', k: 'sl', c: '#000000', s: 1, r: 0, x: 100, y: 100, text: '' };
  resizeItem(sym, 2);
  assert.equal(sym.s, 2);
  assert.equal(handles(sym).length, 1);
  assert.ok(bounds(sym).right > 100 && bounds(sym).left < 100);
  const pen = { t: 'pen', c: '#000000', w: 8, p: [[0, 0], [10, 10]] };
  moveItem(pen, 1, 1);
  assert.deepEqual(pen.p, [[1, 1], [11, 11]]);
  assert.deepEqual(handles(pen), []);
});

test('lines end on the ends of other lines and on symbols when close', () => {
  const items = [{ t: 'line', c: '#000000', w: 8, a: [0, 0], b: [100, 0] }, { t: 'sym', k: 'pole', c: '#000000', s: 1, r: 0, x: 50, y: 80, text: '' }];
  const list = anchors(items);
  assert.deepEqual(snapToAnchor([103, 4], list, 10), [100, 0]);
  assert.deepEqual(snapToAnchor([52, 79], list, 10), [50, 80]);
  assert.equal(snapToAnchor([200, 200], list, 10), null);
});

test('a long freehand stroke is thinned and keeps its last point', () => {
  const stroke = Array.from({ length: MAX_POINTS * 3 + 1 }, (_, i) => [i, i]);
  const thinned = thin(stroke);
  assert.ok(thinned.length <= MAX_POINTS + 1);
  assert.deepEqual(thinned[thinned.length - 1], stroke[stroke.length - 1]);
  const short = [[0, 0], [1, 1]];
  assert.equal(thin(short), short);
});

test('side-view symbols are listed first, and a tall pole reaches far', () => {
  assert.equal(SYMBOLS[0].key, 'epole');
  assert.ok(SYMBOLS.filter((s) => s.group === 'side').length >= 6);
  const pole = { t: 'sym', k: 'epole', c: '#000000', s: 1, r: 0, x: 100, y: 200, text: '' };
  assert.ok(bounds(pole).bottom - bounds(pole).top >= 200, 'taller than wide');
  assert.equal(itemAt([pole], { x: 100, y: 120 }, 5), pole, 'the top of the pole can be touched');
  assert.equal(itemAt([pole], { x: 100, y: 330 }, 5), null);
});
