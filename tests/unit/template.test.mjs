import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATE } from '../../src/template.js';
import {
  validateTemplate, indexTemplate, test as holds, isShown, isNA, isExpected, readNumber, computeAll, numberWarning, fieldWarnings,
  hasAnyValue, poleTag, poleProgress, poleWarnings, fieldExportValue, computedExportValue, gpsText, exportColumns, exportSections,
  applyTokens, screenLabel, columnLabel, holdsValue, isBlankValue,
} from '../../src/template-engine.js';

const TOKENS = { power: 'Northern Power', telecom: 'Coast Tel' };
const item = (key) => indexTemplate(TEMPLATE).items.get(key).item;
const clone = (value) => JSON.parse(JSON.stringify(value));
const blankKeys = (f) => poleProgress(TEMPLATE, { f }, TOKENS).blank.map((b) => b.key);

test('the form description that ships has no mistakes', () => {
  assert.deepEqual(validateTemplate(TEMPLATE), []);
});

test('validateTemplate explains mistakes in plain words', () => {
  const broken = (change) => {
    const t = clone(TEMPLATE);
    change(t);
    return validateTemplate(t).join('\n');
  };
  const firstStep = (t) => t.pole.steps[0].items;
  assert.match(broken((t) => firstStep(t).push({ type: 'text', key: 'tagMap', label: 'Again' })), /"tagMap" is listed twice/);
  assert.match(broken((t) => firstStep(t).push({ type: 'slider', key: 'x1', label: 'X' })), /unknown type: "slider"/);
  assert.match(broken((t) => firstStep(t).push({ type: 'choice', key: 'x2', label: 'X', options: ['One'] })), /needs at least two options/);
  assert.match(broken((t) => firstStep(t).push({ type: 'text', key: 'x3', label: 'X', naIf: { key: 'nothing', is: 'No' } })), /condition on "nothing", which is not an answer/);
  assert.match(broken((t) => firstStep(t).push({ type: 'text', key: 'x4', label: 'X', naIf: { key: 'tagStatus', is: 'Lost' } })), /"Lost", which is not one of its options/);
  assert.match(broken((t) => firstStep(t).push({ type: 'text', key: 'x5', label: '{gas} meter' })), /unknown name in curly brackets: \{gas\}/);
  assert.match(broken((t) => firstStep(t).push({ type: 'number', key: 'x6', label: 'X', soft: [10, 2] })), /soft range that is not \[low, high\]/);
  assert.match(broken((t) => firstStep(t).push({ type: 'text', key: 'x7', label: '' })), /has no label/);
  assert.match(broken((t) => firstStep(t).push({ type: 'text', key: '__proto__', label: 'X' })), /reserved key|not plain letters/);
  assert.match(broken((t) => firstStep(t).push({ type: 'number', key: 'x8', label: 'X', unit: 'yd' })), /unknown unit: "yd"/);
  assert.match(broken((t) => { t.pole.tagKeys = ['nope']; }), /pole\.tagKeys points at "nope"/);
  assert.match(broken((t) => { t.job.titleKey = 'nope'; }), /job\.titleKey points at "nope"/);
  assert.match(broken((t) => { t.pole.steps.push(clone(t.pole.steps[1])); }), /Step "equipment" is listed twice/);
  assert.match(broken((t) => { t.pole.steps = []; }), /no steps/);
  const badCard = broken((t) => {
    const card = t.pole.steps[3].items.find((i) => i.type === 'computed');
    card.rows[0].upper = 'tagMap';
    card.rows[1].kind = 'product';
    card.rows[2].upper = { computed: 'ghost' };
  });
  assert.match(badCard, /uses "tagMap", which is not a number item/);
  assert.match(badCard, /unknown kind: "product"/);
  assert.match(badCard, /uses "ghost", which is not a calculated row/);
  assert.deepEqual(validateTemplate(null), ['The form description is missing.']);
});

test('conditions: is, not, in, filled, all, any', () => {
  const f = { a: 'Yes', b: '', c: true, d: '  ' };
  assert.ok(holds({ key: 'a', is: 'Yes' }, f));
  assert.ok(!holds({ key: 'a', is: 'No' }, f));
  assert.ok(holds({ key: 'a', not: 'No' }, f));
  assert.ok(holds({ key: 'missing', not: 'No' }, f), 'a blank answer is "not No"');
  assert.ok(holds({ key: 'a', in: ['Yes', 'Maybe'] }, f));
  assert.ok(!holds({ key: 'b', in: ['Yes', 'Maybe'] }, f));
  assert.ok(holds({ key: 'c', is: true }, f));
  assert.ok(holds({ key: 'a', filled: true }, f));
  assert.ok(holds({ key: 'd', filled: false }, f), 'spaces alone do not count as filled');
  assert.ok(holds([{ key: 'a', is: 'Yes' }, { key: 'c', is: true }], f));
  assert.ok(!holds([{ key: 'a', is: 'Yes' }, { key: 'c', is: false }], f));
  assert.ok(holds({ any: [{ key: 'a', is: 'No' }, { key: 'c', is: true }] }, f));
  assert.ok(!holds({ any: [{ key: 'a', is: 'No' }] }, f));
  assert.ok(!holds(null, f));
  assert.ok(!holds({ key: 'a' }, f));
  assert.ok(!holds({ key: 'a', is: 'Yes' }, undefined));
});

test('anchor details show N/A when there is no anchor, and are expected when there is one', () => {
  for (const [switchKey, keys] of [['powerAnchor', ['powerSlots', 'powerPlate', 'powerRod']], ['telAnchor', ['telSlots']], ['jointAnchor', ['jointSlots']]]) {
    for (const key of keys) {
      assert.ok(isNA(item(key), { [switchKey]: 'No' }), key);
      assert.ok(!isNA(item(key), { [switchKey]: 'Yes' }), key);
      assert.ok(!isNA(item(key), {}), key);
      assert.ok(isExpected(item(key), { [switchKey]: 'Yes' }), key);
      assert.ok(!isExpected(item(key), { [switchKey]: 'No' }), key);
      assert.ok(!isExpected(item(key), {}), key + ' is not chased before the yes/no question is answered');
      assert.equal(fieldExportValue(item(key), { [switchKey]: 'No', [key]: 'old text' }), 'N/A');
    }
  }
});

test('the field tag is expected unless the tag is missing', () => {
  assert.ok(isExpected(item('tagField'), {}));
  assert.ok(isExpected(item('tagField'), { tagStatus: 'Damaged' }));
  assert.ok(!isExpected(item('tagField'), { tagStatus: 'Missing' }));
});

test('ground heights are expected, until "wire to wire" is switched on', () => {
  const base = { secondary: '1Ø', telPlant: 'Yes' };
  for (const key of ['gP', 'gN', 'gS', 'gT']) assert.ok(isExpected(item(key), base), key);
  for (const key of ['gP', 'gN', 'gS', 'gT']) assert.ok(!isExpected(item(key), { ...base, ww: true }), key);
  assert.ok(!isExpected(item('gS'), { secondary: 'None' }), 'no secondary on the pole');
  assert.ok(!isExpected(item('gS'), {}), 'not chased before the secondary question is answered');
  assert.ok(!isExpected(item('gT'), { telPlant: 'No' }), 'no telecom plant on the pole');
  assert.ok(isNA(item('gS'), { secondary: 'None' }));
});

test('switching on "wire to wire" asks for the measured values instead of emptying the list', () => {
  const before = blankKeys({ secondary: '1Ø', telPlant: 'Yes' });
  const after = blankKeys({ secondary: '1Ø', telPlant: 'Yes', ww: true });
  for (const key of ['gP', 'gN', 'gS', 'gT']) {
    assert.ok(before.includes(key), key + ' before');
    assert.ok(!after.includes(key), key + ' after');
  }
  for (const key of ['mP', 'mS', 'mT']) {
    assert.ok(!before.includes(key), key + ' before');
    assert.ok(after.includes(key), key + ' after');
  }
  assert.ok(!blankKeys({ secondary: 'None', ww: true }).includes('mS'));
  assert.ok(!blankKeys({ telPlant: 'No', ww: true }).includes('mT'));
  assert.ok(!isShown(item('mP'), {}), 'the measured boxes are hidden until the switch is on');
  assert.ok(isShown(item('mP'), { ww: true }));
});

test('follow-up questions are expected once their parent answer calls for them', () => {
  assert.ok(isExpected(item('gDip'), { powerDip: 'Yes' }));
  assert.ok(!isExpected(item('gDip'), { powerDip: 'No' }));
  assert.ok(!isExpected(item('gDip'), {}));
  assert.ok(isNA(item('gDip'), { powerDip: 'No' }));
  assert.ok(isExpected(item('gSL'), { streetLight: 'Yes' }));
  assert.ok(isExpected(item('gSL'), { streetLight: 'Yes - Bonded' }));
  assert.ok(!isExpected(item('gSL'), { streetLight: 'No' }));
  assert.ok(isNA(item('gSL'), { streetLight: 'No' }));
  for (const key of ['midBetween', 'midAnd']) {
    assert.ok(isExpected(item(key), { midIssue: 'Yes' }), key);
    assert.ok(!isExpected(item(key), { midIssue: 'No' }), key);
    assert.ok(!isExpected(item(key), {}), key);
    assert.ok(isNA(item(key), { midIssue: 'No' }), key);
  }
  assert.ok(isExpected(item('otherWhat'), { gOther: '4.2' }));
  assert.ok(!isExpected(item('otherWhat'), {}));
});

test('an empty pole lists exactly the always-expected questions', () => {
  const progress = poleProgress(TEMPLATE, { f: {} }, TOKENS);
  assert.deepEqual(
    progress.blank.map((b) => b.key),
    ['tagMap', 'tagField', 'tagStatus', 'poleType', 'condition', 'height', 'poleClass', 'xfmr', 'secondary', 'powerDip', 'streetLight', 'telPlant', 'telDip', 'powerAnchor', 'telAnchor', 'jointAnchor', 'gP', 'gN', 'gT', 'span1'],
  );
  assert.equal(progress.expected, 20);
  assert.equal(progress.filled, 0);
  const one = poleProgress(TEMPLATE, { f: { tagMap: 'A1' } }, TOKENS);
  assert.equal(one.filled, 1);
  assert.equal(one.blank.length, 19);
  assert.equal(progress.blank.find((b) => b.key === 'powerDip').label, 'Northern Power dip', 'company names are filled in');
  assert.equal(progress.blank.find((b) => b.key === 'gP').stepTitle, 'Heights from ground');
});

test('computeAll: the worked example, typed the way people type', () => {
  const f = { gP: '9.4', gN: '8,1', gS: '7.9 m', gT: ' 6.2', secondary: '1Ø' };
  assert.deepEqual(computeAll(TEMPLATE, f), { neuPri: 1.3, secNeu: 0.2, telLow: 1.7, low: 7.9 });
});

test('computeAll: measured values only count while "wire to wire" is on', () => {
  const f = { gP: '9.4', gN: '8.1', mP: '1.25', secondary: '1Ø' };
  assert.equal(computeAll(TEMPLATE, f).neuPri, 1.3, 'a left-over measured value is ignored when the switch is off');
  assert.equal(computeAll(TEMPLATE, { ...f, ww: true }).neuPri, 1.25);
  const onlyMeasured = computeAll(TEMPLATE, { ww: true, mP: '1.2', mS: '0.2', mT: '1.0', secondary: '1Ø' });
  assert.deepEqual(onlyMeasured, { neuPri: 1.2, secNeu: 0.2, telLow: 1, low: null });
});

test('computeAll: with no secondary, a left-over secondary height is ignored', () => {
  const out = computeAll(TEMPLATE, { gN: '8.1', gS: '2.0', gT: '6.1', secondary: 'None' });
  assert.equal(out.low, 8.1);
  assert.equal(out.telLow, 2);
  assert.equal(out.secNeu, null);
});

test('readNumber treats hidden and N/A items as blank', () => {
  assert.equal(readNumber(item('mP'), { mP: '1.2' }), null);
  assert.equal(readNumber(item('mP'), { mP: '1.2', ww: true }), 1.2);
  assert.equal(readNumber(item('gS'), { gS: '7', secondary: 'None' }), null);
  assert.equal(readNumber(item('tagMap'), { tagMap: '5' }), null, 'a text item is never read as a number');
  assert.equal(readNumber(undefined, {}), null);
});

test('number warnings: unreadable, out of the usual range, fine', () => {
  assert.equal(numberWarning(item('gP'), { gP: '9.4' }), '');
  assert.equal(numberWarning(item('gP'), {}), '');
  assert.match(numberWarning(item('gP'), { gP: '94' }), /Usually 5 to 22 m/);
  assert.match(numberWarning(item('gP'), { gP: '9.4.' }), /Not a number the app can read\. Type it in metres/);
  assert.match(numberWarning(item('height'), { height: '45 m' }), /Type it in feet/);
  assert.match(numberWarning(item('height'), { height: '4.5' }), /Usually 25 to 120 ft/);
  assert.equal(numberWarning(item('gS'), { gS: 'junk', secondary: 'None' }), '', 'an N/A item never warns');
  assert.equal(numberWarning(item('mP'), { mP: 'junk' }), '', 'a hidden item never warns');
});

test('tag warnings: mismatch with the map, and a repeat within the job', () => {
  const tagField = item('tagField');
  assert.deepEqual(fieldWarnings(tagField, { tagMap: 'A1234', tagField: 'A1235' }, () => false), ['Does not match the map tag']);
  assert.deepEqual(fieldWarnings(tagField, { tagMap: 'a1234 ', tagField: ' A1234' }, () => false), [], 'case and spaces are ignored');
  assert.deepEqual(fieldWarnings(tagField, { tagField: 'A1235' }, () => false), [], 'nothing to compare with yet');
  assert.deepEqual(fieldWarnings(tagField, { tagField: 'A1235' }, (key, value) => key === 'tagField' && value === 'A1235'), ['Another pole in this job has the same tag']);
  assert.deepEqual(fieldWarnings(tagField, {}, () => true), [], 'a blank tag is never a repeat');
  assert.deepEqual(fieldWarnings(tagField, { tagField: 'A1' }, null), []);
});

test('poleWarnings gathers every warning with the step it is on', () => {
  const pole = { f: { tagMap: 'A1', tagField: 'A2', gP: '8.1', gN: '9.4', gT: '62', height: 'tall' }, gps: { lat: 50, lon: -125, acc: 85, at: 1 } };
  const warnings = poleWarnings(TEMPLATE, pole, TOKENS, { usedElsewhere: () => false, poorGpsMetres: 30 });
  const byKey = Object.fromEntries(warnings.map((w) => [w.key + ':' + w.label, w]));
  assert.equal(byKey['tagField:Pole tag # in field'].stepKey, 'pole');
  assert.match(byKey['height:Pole height'].text, /Not a number/);
  assert.match(byKey['gT:Coast Tel, top cable'].text, /Usually 3 to 15 m/);
  assert.match(byKey['separations:Neutral to primary bolt'].text, /below zero/);
  assert.match(byKey['separations:Coast Tel to lowest neutral or secondary'].text, /below zero/);
  assert.match(byKey['gps:GPS position'].text, /about 85 m/);
  assert.equal(warnings.length, 6);
  assert.deepEqual(poleWarnings(TEMPLATE, { f: {}, gps: { lat: 50, lon: -125, acc: 8, at: 1 } }, TOKENS, { poorGpsMetres: 30 }), []);
  assert.deepEqual(poleWarnings(TEMPLATE, { f: {}, gps: null }, TOKENS, {}), []);
});

test('poleTag prefers the tag seen in the field', () => {
  assert.equal(poleTag(TEMPLATE, { f: { tagMap: 'M1', tagField: ' F1 ' } }), 'F1');
  assert.equal(poleTag(TEMPLATE, { f: { tagMap: 'M1', tagField: '  ' } }), 'M1');
  assert.equal(poleTag(TEMPLATE, { f: {} }), '');
  assert.equal(poleTag(TEMPLATE, null), '');
});

test('hasAnyValue: a switched-off toggle and blank text do not count', () => {
  assert.ok(!hasAnyValue(TEMPLATE, {}));
  assert.ok(!hasAnyValue(TEMPLATE, { notes: '   ', ww: false, notAField: 'x' }));
  assert.ok(hasAnyValue(TEMPLATE, { notes: 'x' }));
  assert.ok(hasAnyValue(TEMPLATE, { ww: true }));
  assert.ok(!hasAnyValue(TEMPLATE, undefined));
});

test('labels: company names and units', () => {
  assert.equal(applyTokens('{power} dip', TOKENS), 'Northern Power dip');
  assert.equal(applyTokens('{power} dip', { power: '  ' }), '{power} dip', 'a blank name leaves the placeholder for the caller to default');
  assert.equal(applyTokens('{power} dip', undefined), '{power} dip');
  assert.equal(applyTokens(null, TOKENS), '');
  assert.equal(screenLabel(item('height'), TOKENS), 'Pole height (ft)');
  assert.equal(screenLabel(item('gP'), TOKENS), 'Primary bolt', 'row numbers show the unit beside the box instead');
  assert.equal(columnLabel(item('gP'), TOKENS), 'Ground to primary bolt (m)');
  assert.equal(columnLabel(item('gT'), TOKENS), 'Ground to Coast Tel top cable (m)');
  assert.equal(columnLabel(item('mT'), TOKENS), 'Measured: Coast Tel to lowest neutral or secondary (m)');
  assert.equal(columnLabel(item('tagMap'), TOKENS), 'Pole tag # (map)');
});

test('export values: numbers are numbers, everything else is text', () => {
  assert.equal(fieldExportValue(item('gP'), { gP: '9,4 m' }), 9.4);
  assert.equal(fieldExportValue(item('gP'), { gP: 'about 9' }), 'about 9', 'an unreadable entry is exported as typed, not dropped');
  assert.equal(fieldExportValue(item('gP'), {}), '');
  assert.equal(fieldExportValue(item('tagMap'), { tagMap: '0042' }), '0042', 'tags keep their leading zeros');
  assert.equal(fieldExportValue(item('ww'), { ww: true }), 'Yes');
  assert.equal(fieldExportValue(item('ww'), {}), '');
  assert.equal(fieldExportValue(item('mP'), { mP: '1.2' }), '', 'a hidden answer is not exported');
  assert.equal(fieldExportValue(item('notes'), { notes: 'line 1\nline 2' }), 'line 1\nline 2');
  assert.equal(computedExportValue(null), '');
  assert.equal(computedExportValue(NaN), 'check entry');
  assert.equal(computedExportValue(1.3), 1.3);
  assert.equal(gpsText({ lat: 50.0244, lon: -125.2475 }), '50.024400, -125.247500');
  assert.equal(gpsText(null), '');
  assert.equal(gpsText({ lat: 'x', lon: 1 }), '');
});

test('export columns: one per answer, unique, with names filled in', () => {
  const columns = exportColumns(TEMPLATE, TOKENS);
  const labels = columns.map((c) => c.label);
  const ids = columns.map((c) => c.id);
  assert.equal(new Set(labels).size, labels.length, 'no two columns share a heading');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(labels.every((label) => !/[{}]/.test(label)), 'no placeholder is left in a heading');
  assert.deepEqual(labels.slice(0, 6), ['Location', 'Date', 'Collected by', 'Design # / Job', 'Other identifiers', 'Pole #']);
  assert.equal(labels[labels.length - 1], 'Status');
  for (const wanted of ['Northern Power dip', 'Ground to primary bolt (m)', 'Measured wire to wire', 'Separation: neutral to primary bolt (m)', 'Lowest neutral or secondary height (m)', 'GPS latitude', 'GPS accuracy (m)', 'Photos', 'Notes', 'Proposed new pole location']) {
    assert.ok(labels.includes(wanted), wanted);
  }
  const valueItems = [...indexTemplate(TEMPLATE).items.values()].filter(({ item: i }) => holdsValue(i)).length;
  assert.equal(columns.filter((c) => c.id.startsWith('f.')).length, valueItems, 'every answer has a column');

  const job = { f: { location: 'Dogwood St', designNo: '00077' } };
  const pole = { f: { tagField: 'A1', gP: '9.4', gN: '8.1' }, gps: { lat: 50.1, lon: -125.2, acc: 7.6, at: Date.UTC(2026, 9, 4, 17, 30) }, done: true };
  const extra = { number: 3, photos: 2, computed: computeAll(TEMPLATE, pole.f) };
  const row = Object.fromEntries(columns.map((c) => [c.label, c.read(job, pole, extra)]));
  assert.equal(row.Location, 'Dogwood St');
  assert.equal(row['Design # / Job'], '00077');
  assert.equal(row['Pole #'], 3);
  assert.equal(row['Ground to primary bolt (m)'], 9.4);
  assert.equal(row['Separation: neutral to primary bolt (m)'], 1.3);
  assert.equal(row['Separation: secondary to neutral (m)'], '');
  assert.equal(row['GPS latitude'], 50.1);
  assert.equal(row['GPS accuracy (m)'], 8);
  assert.equal(row['GPS time (UTC)'], '2026-10-04T17:30:00.000Z');
  assert.equal(row.Photos, 2);
  assert.equal(row.Status, 'Done');
  const none = Object.fromEntries(columns.map((c) => [c.label, c.read({ f: {} }, { f: {}, gps: null, done: false }, { number: 1, photos: 0, computed: {} })]));
  assert.equal(none['GPS latitude'], '');
  assert.equal(none['GPS time (UTC)'], '');
  assert.equal(none.Status, 'In progress');
});

test('export sections follow the steps of the form', () => {
  const sections = exportSections(TEMPLATE, TOKENS);
  assert.deepEqual(sections.map((s) => s.title), ['Job', 'Pole', 'Equipment', 'Anchors', 'Heights from ground', 'Spans', 'Photos and notes']);
  const heights = sections.find((s) => s.title === 'Heights from ground');
  assert.ok(heights.rows.some((r) => r.computed && r.label === 'Separation: neutral to primary bolt (m)'));
  assert.ok(sections.every((s) => s.rows.every((r) => !/[{}]/.test(r.label))));
  assert.ok(sections.find((s) => s.title === 'Pole').rows.some((r) => r.label === 'GPS position'));
});

test('isBlankValue', () => {
  for (const blank of [null, undefined, '', '  ', false]) assert.ok(isBlankValue(blank));
  for (const filled of ['x', '0', true, 0]) assert.ok(!isBlankValue(filled));
});
