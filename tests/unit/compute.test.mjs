import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNumber, round2, evaluateComputed, describeValue, rangeMessage } from '../../src/compute.js';

test('parseNumber: blank entries are null, not zero', () => {
  for (const blank of [null, undefined, '', '   ', '\t']) assert.equal(parseNumber(blank, 'm'), null);
});

test('parseNumber: plain numbers, with a dot or a comma', () => {
  assert.equal(parseNumber('9.4', 'm'), 9.4);
  assert.equal(parseNumber('9,4', 'm'), 9.4);
  assert.equal(parseNumber(' 12 ', 'm'), 12);
  assert.equal(parseNumber('.5', 'm'), 0.5);
  assert.equal(parseNumber('5.', 'm'), 5);
  assert.equal(parseNumber('+3', 'm'), 3);
  assert.equal(parseNumber('-0.2', 'm'), -0.2);
  assert.equal(parseNumber('−0.2', 'm'), -0.2, 'a typographic minus sign is accepted');
  assert.equal(parseNumber(7.25, 'm'), 7.25);
  assert.equal(parseNumber('0', 'm'), 0);
});

test('parseNumber: a unit is accepted only when it is the unit of the field', () => {
  assert.equal(parseNumber('9.4m', 'm'), 9.4);
  assert.equal(parseNumber('9.4 M', 'm'), 9.4);
  assert.equal(parseNumber('9.4 metres', 'm'), 9.4);
  assert.equal(parseNumber('45 ft', 'ft'), 45);
  assert.equal(parseNumber("45'", 'ft'), 45);
  assert.equal(parseNumber('12°', 'deg'), 12);
  assert.equal(parseNumber('12 deg', 'deg'), 12);
  assert.ok(Number.isNaN(parseNumber('45 ft', 'm')), 'feet typed into a metre field must not be read as metres');
  assert.ok(Number.isNaN(parseNumber('9.4 m', 'ft')));
  assert.ok(Number.isNaN(parseNumber('9.4m', undefined)));
});

test('parseNumber: anything else is unreadable, never a guess', () => {
  for (const bad of ['abc', '9.4.2', '9 4', '1,234.5', '--5', '5-', 'm', "30'6\"", '1e3', 'NaN', 'Infinity', '9..4']) {
    assert.ok(Number.isNaN(parseNumber(bad, 'm')), JSON.stringify(bad) + ' should be unreadable');
  }
  assert.ok(Number.isNaN(parseNumber(Infinity, 'm')));
  assert.ok(Number.isNaN(parseNumber(NaN, 'm')));
});

test('round2 rounds half away from zero and never returns minus zero', () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(round2(1.3000000000000007), 1.3);
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.ok(Object.is(round2(-0.001), 0));
  assert.equal(round2(9.4 - 8.1), 1.3);
  // Larger numbers, where a fixed tiny nudge is too small to fix the binary error.
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(-2.675), -2.68);
  assert.equal(round2(1234.565), 1234.57);
  assert.equal(round2(123456.785), 123456.79);
  assert.equal(round2(0.125), 0.13);
  assert.equal(round2(1e21), 1e21);
  assert.ok(Object.is(round2(-5e-324), 0));
  assert.ok(Number.isNaN(round2(NaN)));
  assert.equal(round2(Infinity), Infinity);
});

const rows = [
  { key: 'neuPri', kind: 'diff', upper: 'gP', lower: 'gN', override: 'mP' },
  { key: 'secNeu', kind: 'absdiff', a: 'gN', b: 'gS', override: 'mS' },
  { key: 'telLow', kind: 'diff', upper: { computed: 'low' }, lower: 'gT', override: 'mT' },
  { key: 'low', kind: 'min', of: ['gS', 'gN'] },
];
const reader = (values) => (key) => (key in values ? values[key] : null);

test('evaluateComputed: the worked example from the paper form', () => {
  const out = evaluateComputed(rows, reader({ gP: 9.4, gN: 8.1, gS: 7.9, gT: 6.2 }));
  assert.deepEqual(out, { neuPri: 1.3, secNeu: 0.2, telLow: 1.7, low: 7.9 });
});

test('evaluateComputed: a blank operand gives blank, min ignores blanks', () => {
  const out = evaluateComputed(rows, reader({ gP: 9.4, gN: 8.1, gT: 6.2 }));
  assert.equal(out.secNeu, null);
  assert.equal(out.low, 8.1, 'with no secondary the neutral is the lowest');
  assert.equal(out.telLow, 1.9);
  assert.deepEqual(evaluateComputed(rows, reader({})), { neuPri: null, secNeu: null, telLow: null, low: null });
});

test('evaluateComputed: 3-phase secondary above the neutral still gives a positive separation', () => {
  const out = evaluateComputed(rows, reader({ gN: 8.0, gS: 8.2 }));
  assert.equal(out.secNeu, 0.2);
  assert.equal(out.low, 8.0);
});

test('evaluateComputed: a direct measurement replaces the calculation', () => {
  const out = evaluateComputed(rows, reader({ gP: 9.4, gN: 8.1, mP: 1.25, mT: 1.6 }));
  assert.equal(out.neuPri, 1.25);
  assert.equal(out.telLow, 1.6);
});

test('evaluateComputed: an unreadable entry gives "check entry", never a wrong number', () => {
  assert.ok(Number.isNaN(evaluateComputed(rows, reader({ gP: NaN, gN: 8.1 })).neuPri));
  assert.ok(Number.isNaN(evaluateComputed(rows, reader({ gP: 9.4, gN: 8.1, mP: NaN })).neuPri), 'an unreadable override is not silently skipped');
  const out = evaluateComputed(rows, reader({ gS: NaN, gN: 8.1, gT: 6 }));
  assert.ok(Number.isNaN(out.low));
  assert.ok(Number.isNaN(out.telLow), 'a row built on an unreadable row is unreadable too');
});

test('evaluateComputed: negative results are kept so the screen can flag them', () => {
  assert.equal(evaluateComputed(rows, reader({ gP: 8.1, gN: 9.4 })).neuPri, -1.3);
});

test('evaluateComputed: rows that refer to each other, or to nothing, do not hang', () => {
  const loop = [
    { key: 'a', kind: 'diff', upper: { computed: 'b' }, lower: 'x' },
    { key: 'b', kind: 'diff', upper: { computed: 'a' }, lower: 'x' },
    { key: 'c', kind: 'diff', upper: { computed: 'missing' }, lower: 'x' },
    { key: 'd', kind: 'mystery' },
    { key: 'e', kind: 'max', of: ['x', 'y'] },
  ];
  const out = evaluateComputed(loop, reader({ x: 1, y: 5 }));
  assert.ok(Number.isNaN(out.a) && Number.isNaN(out.b) && Number.isNaN(out.c) && Number.isNaN(out.d));
  assert.equal(out.e, 5);
});

test('describeValue gives the words shown on screen', () => {
  assert.deepEqual(describeValue(null, 'm'), { text: 'not entered', state: 'blank' });
  assert.deepEqual(describeValue(NaN, 'm'), { text: 'check entry', state: 'bad' });
  assert.deepEqual(describeValue(1.3, 'm'), { text: '1.30 m', state: 'ok' });
  assert.deepEqual(describeValue(-54.1, 'm'), { text: '-54.10 m', state: 'negative' });
  assert.deepEqual(describeValue(0, ''), { text: '0.00', state: 'ok' });
});

test('rangeMessage only speaks up outside the usual range', () => {
  assert.equal(rangeMessage(9.4, [5, 22], 'm'), '');
  assert.equal(rangeMessage(5, [5, 22], 'm'), '');
  assert.equal(rangeMessage(22, [5, 22], 'm'), '');
  assert.match(rangeMessage(94, [5, 22], 'm'), /Usually 5 to 22 m/);
  assert.match(rangeMessage(0.94, [5, 22], 'm'), /Check the entry/);
  assert.equal(rangeMessage(null, [5, 22], 'm'), '');
  assert.equal(rangeMessage(NaN, [5, 22], 'm'), '');
  assert.equal(rangeMessage(3, undefined, 'm'), '');
});
