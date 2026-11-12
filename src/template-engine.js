// Reads the form description in template.js and answers questions about it:
// which items are shown, which are N/A, what is still blank, what needs a second look,
// and how the answers are laid out in an export. Nothing here touches the screen or storage.

import { parseNumber, evaluateComputed, rangeMessage } from './compute.js';
import { MAX_SPANS, spanLine, spanName, gapsLine, deflectionLine } from './spans.js';

const VALUE_TYPES = new Set(['text', 'number', 'choice', 'toggle', 'note']);
const KNOWN_TYPES = new Set([...VALUE_TYPES, 'heading', 'divider', 'computed', 'gps', 'spanmap', 'photos', 'review']);
const KNOWN_UNITS = new Set(['m', 'ft', 'deg']);
const KNOWN_TOKENS = new Set(['power', 'telecom']);

/** True for items that store an answer. */
export const holdsValue = (item) => VALUE_TYPES.has(item.type);

export function isBlankValue(value) {
  return value == null || value === false || (typeof value === 'string' && value.trim() === '');
}

/** Replaces {power} and {telecom} with the names from Settings. */
export function applyTokens(text, tokens) {
  return String(text == null ? '' : text).replace(/\{(\w+)\}/g, (all, name) => {
    const word = tokens && tokens[name] != null ? String(tokens[name]).trim() : '';
    return word !== '' ? word : all;
  });
}

/** The label shown on screen. Numbers that are not in a row layout carry their unit. */
export function screenLabel(item, tokens) {
  const label = applyTokens(item.label, tokens);
  if (item.type === 'number' && item.unit && item.layout !== 'row') return label + ' (' + item.unit + ')';
  return label;
}

/** The column heading used in exports. Always carries the unit. */
export function columnLabel(item, tokens) {
  const label = applyTokens(item.column || item.label, tokens);
  return item.unit ? label + ' (' + item.unit + ')' : label;
}

const indexes = new WeakMap();

/** Looks up every item once. Returns { items: Map, steps, computed, rows: Map }. */
export function indexTemplate(template) {
  let index = indexes.get(template);
  if (index) return index;
  index = { items: new Map(), steps: [], computed: [], rows: new Map(), jobItems: new Map() };
  for (const item of template.job.items) index.jobItems.set(item.key, item);
  template.pole.steps.forEach((step, stepIndex) => {
    index.steps.push(step);
    for (const item of step.items) {
      index.items.set(item.key, { item, step, stepIndex });
      if (item.type === 'computed') {
        index.computed.push(item);
        for (const row of item.rows) index.rows.set(row.key, { row, item, step, stepIndex });
      }
    }
  });
  indexes.set(template, index);
  return index;
}

/** Tests a condition against the answers of one pole. */
export function test(condition, f) {
  if (condition == null) return false;
  if (Array.isArray(condition)) return condition.every((c) => test(c, f));
  if (Array.isArray(condition.any)) return condition.any.some((c) => test(c, f));
  const value = f ? f[condition.key] : undefined;
  if ('is' in condition) return value === condition.is;
  if ('not' in condition) return value !== condition.not;
  if ('in' in condition) return condition.in.includes(value);
  if ('filled' in condition) return !isBlankValue(value) === Boolean(condition.filled);
  return false;
}

export const isShown = (item, f) => !item.showIf || test(item.showIf, f);
export const isNA = (item, f) => Boolean(item.naIf) && test(item.naIf, f);
export const isBlank = (item, f) => isBlankValue(f ? f[item.key] : undefined);

/** True when a blank answer here should be listed under "Left blank". */
export function isExpected(item, f) {
  if (!holdsValue(item) || !isShown(item, f) || isNA(item, f)) return false;
  const wanted = item.expect === true || (item.expectIf != null && test(item.expectIf, f));
  if (!wanted) return false;
  if (item.expectUnless != null && test(item.expectUnless, f)) return false;
  return true;
}

/** Reads a number field. Hidden and N/A items count as blank. */
export function readNumber(item, f) {
  if (!item || item.type !== 'number' || !isShown(item, f) || isNA(item, f)) return null;
  return parseNumber(f ? f[item.key] : null, item.unit);
}

/** Works out every calculated row. Returns { rowKey: number | null | NaN }. */
export function computeAll(template, f) {
  const index = indexTemplate(template);
  const read = (key) => {
    const found = index.items.get(key);
    return found ? readNumber(found.item, f) : NaN;
  };
  const out = {};
  for (const item of index.computed) Object.assign(out, evaluateComputed(item.rows, read));
  return out;
}

const UNIT_NAMES = { m: 'metres', ft: 'feet', deg: 'degrees' };

/** A short warning for one number field, or '' when it reads fine. */
export function numberWarning(item, f) {
  if (item.type !== 'number' || !isShown(item, f) || isNA(item, f)) return '';
  const value = parseNumber(f ? f[item.key] : null, item.unit);
  if (value == null) return '';
  if (Number.isNaN(value)) {
    const unit = UNIT_NAMES[item.unit];
    return unit ? 'Not a number the app can read. Type it in ' + unit + ', like 9.4' : 'Not a number the app can read';
  }
  return rangeMessage(value, item.soft, item.unit);
}

const sameText = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Every warning for one field, as a list of short sentences.
 * usedElsewhere(key, value) says whether another pole in the job has the same answer.
 */
export function fieldWarnings(item, f, usedElsewhere) {
  const out = [];
  if (!holdsValue(item) || !isShown(item, f) || isNA(item, f)) return out;
  const value = f ? f[item.key] : undefined;
  const number = numberWarning(item, f);
  if (number) out.push(number);
  if (isBlankValue(value)) return out;
  if (item.differsFrom) {
    const other = f[item.differsFrom.key];
    if (!isBlankValue(other) && !sameText(value, other)) out.push(item.differsFrom.text);
  }
  if (item.uniqueInJob && typeof usedElsewhere === 'function' && usedElsewhere(item.key, value)) out.push(item.uniqueInJob);
  return out;
}

/** True when the pole holds at least one answer. */
export function hasAnyValue(template, f) {
  if (!f) return false;
  for (const { item } of indexTemplate(template).items.values()) {
    if (holdsValue(item) && !isBlankValue(f[item.key])) return true;
  }
  return false;
}

/** The tag to show for a pole: the field tag if there is one, otherwise the map tag. */
export function poleTag(template, pole) {
  const f = (pole && pole.f) || {};
  for (const key of template.pole.tagKeys) {
    if (!isBlankValue(f[key])) return String(f[key]).trim();
  }
  return '';
}

/** What is still blank on a pole. Returns { expected, filled, blank: [{ key, label, stepKey, stepTitle }] }. */
export function poleProgress(template, pole, tokens) {
  const f = (pole && pole.f) || {};
  const out = { expected: 0, filled: 0, blank: [] };
  for (const { item, step } of indexTemplate(template).items.values()) {
    if (!isExpected(item, f)) continue;
    if (item.expectUnlessSpans && pole && Array.isArray(pole.spans) && pole.spans.length) continue;
    out.expected += 1;
    if (isBlank(item, f)) out.blank.push({ key: item.key, label: applyTokens(item.label, tokens), stepKey: step.key, stepTitle: step.title });
    else out.filled += 1;
  }
  return out;
}

/**
 * Everything on a pole that deserves a second look.
 * Returns [{ key, label, text, stepKey, stepTitle }].
 */
export function poleWarnings(template, pole, tokens, options) {
  const f = (pole && pole.f) || {};
  const usedElsewhere = options && options.usedElsewhere;
  const poorGps = options && options.poorGpsMetres;
  const index = indexTemplate(template);
  const out = [];
  for (const { item, step } of index.items.values()) {
    if (holdsValue(item)) {
      for (const text of fieldWarnings(item, f, usedElsewhere)) {
        out.push({ key: item.key, label: applyTokens(item.label, tokens), text, stepKey: step.key, stepTitle: step.title });
      }
    } else if (item.type === 'computed') {
      const values = evaluateComputed(item.rows, (key) => {
        const found = index.items.get(key);
        return found ? readNumber(found.item, f) : NaN;
      });
      for (const row of item.rows) {
        const value = values[row.key];
        if (typeof value === 'number' && value < 0) {
          out.push({ key: item.key, label: applyTokens(row.label, tokens), text: 'Works out below zero. Check the numbers.', stepKey: step.key, stepTitle: step.title });
        }
      }
    } else if (item.type === 'gps') {
      const gps = pole && pole.gps;
      if (gps && poorGps && Number.isFinite(gps.acc) && gps.acc > poorGps) {
        out.push({ key: item.key, label: applyTokens(item.label, tokens), text: 'Only accurate to about ' + Math.round(gps.acc) + ' m', stepKey: step.key, stepTitle: step.title });
      }
    } else if (item.type === 'spanmap') {
      const spans = (pole && Array.isArray(pole.spans) && pole.spans) || [];
      spans.forEach((span, i) => {
        if (String(span.len || '').trim() === '') {
          out.push({ key: item.key, label: applyTokens(item.label, tokens), text: 'No length for the span to ' + spanName(span, i), stepKey: step.key, stepTitle: step.title });
        } else if (!(parseNumber(span.len, 'm') > 0)) {
          out.push({ key: item.key, label: applyTokens(item.label, tokens), text: 'Check the length of the span to ' + spanName(span, i), stepKey: step.key, stepTitle: step.title });
        }
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Exports

/** The value written to a file for one answer. Numbers are real numbers when they read cleanly. */
export function fieldExportValue(item, f) {
  if (!isShown(item, f)) return '';
  if (isNA(item, f)) return 'N/A';
  const value = f ? f[item.key] : undefined;
  if (item.type === 'toggle') return value === true ? 'Yes' : '';
  if (isBlankValue(value)) return '';
  if (item.type === 'number') {
    const number = parseNumber(value, item.unit);
    return typeof number === 'number' && !Number.isNaN(number) ? number : String(value).trim();
  }
  return String(value);
}

export function computedExportValue(value) {
  if (value == null) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'check entry';
  return value;
}

export function gpsText(gps) {
  if (!gps || !Number.isFinite(gps.lat) || !Number.isFinite(gps.lon)) return '';
  return gps.lat.toFixed(6) + ', ' + gps.lon.toFixed(6);
}

function spanText(pole, n) {
  const spans = (pole && Array.isArray(pole.spans) && pole.spans) || [];
  return spans[n] ? spanLine(spans[n], n) : '';
}

function gpsTime(gps) {
  if (!gps || !Number.isFinite(gps.at)) return '';
  try {
    return new Date(gps.at).toISOString();
  } catch (e) {
    return '';
  }
}

/**
 * The columns of the "one row per pole" table, in order.
 * Each column: { id, label, group, read(job, pole, extra) }.
 * extra: { number, photos, computed }.
 */
export function exportColumns(template, tokens) {
  const columns = [];
  for (const item of template.job.items) {
    columns.push({ id: 'job.' + item.key, label: columnLabel(item, tokens), group: 'job', text: true, read: (job) => fieldExportValue(item, job.f || {}) });
  }
  columns.push({ id: 'pole.number', label: 'Pole #', group: 'pole', read: (job, pole, extra) => extra.number });
  for (const step of template.pole.steps) {
    for (const item of step.items) {
      if (holdsValue(item)) {
        columns.push({ id: 'f.' + item.key, label: columnLabel(item, tokens), group: step.key, text: item.type !== 'number', read: (job, pole) => fieldExportValue(item, pole.f || {}) });
      } else if (item.type === 'computed') {
        for (const row of item.rows) {
          columns.push({
            id: 'c.' + row.key,
            label: applyTokens(row.column || row.label, tokens) + (item.unit ? ' (' + item.unit + ')' : ''),
            group: step.key,
            computed: true,
            read: (job, pole, extra) => computedExportValue(extra.computed[row.key]),
          });
        }
      } else if (item.type === 'gps') {
        columns.push({ id: 'gps.lat', label: 'GPS latitude', group: step.key, read: (job, pole) => (pole.gps && Number.isFinite(pole.gps.lat) ? pole.gps.lat : '') });
        columns.push({ id: 'gps.lon', label: 'GPS longitude', group: step.key, read: (job, pole) => (pole.gps && Number.isFinite(pole.gps.lon) ? pole.gps.lon : '') });
        columns.push({ id: 'gps.acc', label: 'GPS accuracy (m)', group: step.key, read: (job, pole) => (pole.gps && Number.isFinite(pole.gps.acc) ? Math.round(pole.gps.acc) : '') });
        columns.push({ id: 'gps.at', label: 'GPS time (UTC)', group: step.key, text: true, read: (job, pole) => gpsTime(pole.gps) });
      } else if (item.type === 'spanmap') {
        for (let n = 0; n < MAX_SPANS; n += 1) {
          columns.push({ id: 'spans.' + (n + 1), label: 'Diagram span ' + (n + 1), group: step.key, text: true, read: (job, pole) => spanText(pole, n) });
        }
        columns.push({ id: 'spans.angles', label: 'Diagram angles between spans', group: step.key, text: true, read: (job, pole) => gapsLine(pole.spans || []) });
        columns.push({ id: 'spans.deflection', label: 'Diagram angle of deflection', group: step.key, text: true, read: (job, pole) => deflectionLine(pole.spans || []) });
      } else if (item.type === 'photos') {
        columns.push({ id: 'photos.count', label: 'Photos', group: step.key, read: (job, pole, extra) => extra.photos });
      }
    }
  }
  columns.push({ id: 'pole.status', label: 'Status', group: 'pole', text: true, read: (job, pole) => (pole.done ? 'Done' : 'In progress') });
  return columns;
}

/**
 * The same answers grouped for a one-pole sheet.
 * Returns [{ title, rows: [{ label, computed, read(job, pole, extra) }] }].
 */
export function exportSections(template, tokens) {
  const sections = [];
  sections.push({
    title: 'Job',
    rows: template.job.items.map((item) => ({ label: columnLabel(item, tokens), read: (job) => fieldExportValue(item, job.f || {}) })),
  });
  for (const step of template.pole.steps) {
    const rows = [];
    let diagram = false;
    for (const item of step.items) {
      if (holdsValue(item)) {
        rows.push({ label: columnLabel(item, tokens), note: item.type === 'note', read: (job, pole) => fieldExportValue(item, pole.f || {}) });
      } else if (item.type === 'computed') {
        for (const row of item.rows) {
          rows.push({
            label: applyTokens(row.column || row.label, tokens) + (item.unit ? ' (' + item.unit + ')' : ''),
            computed: true,
            read: (job, pole, extra) => computedExportValue(extra.computed[row.key]),
          });
        }
      } else if (item.type === 'gps') {
        rows.push({ label: 'GPS position', read: (job, pole) => gpsText(pole.gps) });
        rows.push({ label: 'GPS accuracy (m)', read: (job, pole) => (pole.gps && Number.isFinite(pole.gps.acc) ? Math.round(pole.gps.acc) : '') });
      } else if (item.type === 'spanmap') {
        diagram = true;
        for (let n = 0; n < MAX_SPANS; n += 1) rows.push({ label: 'Diagram span ' + (n + 1), read: (job, pole) => spanText(pole, n) });
        rows.push({ label: 'Angles between spans, clockwise', read: (job, pole) => gapsLine(pole.spans || []) });
        rows.push({ label: 'Angle of deflection, from the diagram', computed: true, text: true, read: (job, pole) => deflectionLine(pole.spans || []) });
      }
    }
    if (rows.length) sections.push({ title: step.title, rows, diagram });
  }
  return sections;
}

// ---------------------------------------------------------------------------------------------
// Checking the form description itself

function conditionKeys(condition, out) {
  if (condition == null) return out;
  if (Array.isArray(condition)) condition.forEach((c) => conditionKeys(c, out));
  else if (Array.isArray(condition.any)) condition.any.forEach((c) => conditionKeys(c, out));
  else out.push(condition);
  return out;
}

function tokensIn(text) {
  return [...String(text || '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

/** Returns a list of plain-language mistakes in a form description. Empty means it is fine. */
export function validateTemplate(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['The form description is missing.'];
  if (!t.job || !Array.isArray(t.job.items)) errors.push('The job section has no items.');
  if (!t.pole || !Array.isArray(t.pole.steps) || !t.pole.steps.length) errors.push('The pole section has no steps.');
  if (errors.length) return errors;

  const checkLabel = (where, item) => {
    if (item.type === 'divider') return;
    if (typeof item.label !== 'string' || item.label.trim() === '') errors.push(where + ' has no label.');
    for (const text of [item.label, item.column]) {
      for (const token of tokensIn(text)) {
        if (!KNOWN_TOKENS.has(token)) errors.push(where + ' uses an unknown name in curly brackets: {' + token + '}.');
      }
    }
  };

  const jobKeys = new Set();
  for (const item of t.job.items) {
    const where = 'Job item "' + item.key + '"';
    if (!item.key) errors.push('A job item has no key.');
    if (jobKeys.has(item.key)) errors.push(where + ' is listed twice.');
    jobKeys.add(item.key);
    if (item.type !== 'text' && item.type !== 'note') errors.push(where + ' must be type text or note.');
    checkLabel(where, item);
  }
  for (const name of ['titleKey', 'codeKey']) {
    if (!jobKeys.has(t.job[name])) errors.push('job.' + name + ' points at "' + t.job[name] + '", which is not a job item.');
  }

  const keys = new Map();
  const stepKeys = new Set();
  const rowKeys = new Set();
  for (const step of t.pole.steps) {
    if (!step.key || !/^[a-z][a-z0-9]*$/i.test(step.key)) errors.push('A step has a key that is missing or not plain letters: "' + step.key + '".');
    if (stepKeys.has(step.key)) errors.push('Step "' + step.key + '" is listed twice.');
    stepKeys.add(step.key);
    if (typeof step.title !== 'string' || !step.title.trim()) errors.push('Step "' + step.key + '" has no title.');
    if (!Array.isArray(step.items) || !step.items.length) {
      errors.push('Step "' + step.key + '" has no items.');
      continue;
    }
    for (const item of step.items) {
      const where = 'Item "' + item.key + '"';
      if (!item.key || typeof item.key !== 'string') {
        errors.push('An item in step "' + step.key + '" has no key.');
        continue;
      }
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(item.key)) errors.push(where + ' has a key that is not plain letters and digits.');
      if (['__proto__', 'constructor', 'prototype'].includes(item.key)) errors.push(where + ' uses a reserved key.');
      if (keys.has(item.key)) errors.push(where + ' is listed twice.');
      keys.set(item.key, item);
      if (!KNOWN_TYPES.has(item.type)) errors.push(where + ' has an unknown type: "' + item.type + '".');
      checkLabel(where, item);
      if (item.type === 'choice') {
        if (!Array.isArray(item.options) || item.options.length < 2) errors.push(where + ' needs at least two options.');
        else if (new Set(item.options).size !== item.options.length) errors.push(where + ' repeats an option.');
      }
      if (item.unit != null && !KNOWN_UNITS.has(item.unit)) errors.push(where + ' has an unknown unit: "' + item.unit + '".');
      if (item.soft != null) {
        const ok = Array.isArray(item.soft) && item.soft.length === 2 && item.soft.every(Number.isFinite) && item.soft[0] < item.soft[1];
        if (!ok) errors.push(where + ' has a soft range that is not [low, high].');
        if (item.type !== 'number') errors.push(where + ' has a soft range but is not a number.');
      }
      if (item.type === 'computed') {
        if (!Array.isArray(item.rows) || !item.rows.length) errors.push(where + ' has no rows.');
        for (const row of item.rows || []) {
          if (!row.key) errors.push(where + ' has a row with no key.');
          if (rowKeys.has(row.key)) errors.push('Calculated row "' + row.key + '" is listed twice.');
          rowKeys.add(row.key);
          if (!['diff', 'absdiff', 'min', 'max'].includes(row.kind)) errors.push('Calculated row "' + row.key + '" has an unknown kind: "' + row.kind + '".');
          if (typeof row.label !== 'string' || !row.label.trim()) errors.push('Calculated row "' + row.key + '" has no label.');
          for (const text of [row.label, row.column]) {
            for (const token of tokensIn(text)) {
              if (!KNOWN_TOKENS.has(token)) errors.push('Calculated row "' + row.key + '" uses an unknown name in curly brackets: {' + token + '}.');
            }
          }
        }
      }
    }
  }

  for (const key of rowKeys) {
    if (keys.has(key)) errors.push('"' + key + '" is used for both an item and a calculated row.');
  }
  if (!Array.isArray(t.pole.tagKeys) || !t.pole.tagKeys.length) errors.push('pole.tagKeys is empty.');
  for (const key of t.pole.tagKeys || []) {
    if (!keys.has(key)) errors.push('pole.tagKeys points at "' + key + '", which is not an item.');
  }

  const numberKey = (key) => keys.has(key) && keys.get(key).type === 'number';
  for (const [key, item] of keys) {
    const where = 'Item "' + key + '"';
    for (const name of ['showIf', 'naIf', 'expectIf', 'expectUnless']) {
      for (const condition of conditionKeys(item[name], [])) {
        if (!condition || typeof condition !== 'object' || !condition.key) {
          errors.push(where + ' has a ' + name + ' condition with no key.');
        } else if (!keys.has(condition.key) || !holdsValue(keys.get(condition.key))) {
          errors.push(where + ' has a ' + name + ' condition on "' + condition.key + '", which is not an answer.');
        } else if (!['is', 'not', 'in', 'filled'].some((word) => word in condition)) {
          errors.push(where + ' has a ' + name + ' condition that tests nothing.');
        } else {
          const target = keys.get(condition.key);
          const values = 'in' in condition ? condition.in : 'is' in condition ? [condition.is] : 'not' in condition ? [condition.not] : [];
          if (target.type === 'choice') {
            for (const value of values || []) {
              if (!target.options.includes(value)) errors.push(where + ' has a ' + name + ' condition on "' + condition.key + '" for "' + value + '", which is not one of its options.');
            }
          }
        }
      }
    }
    if (item.differsFrom && !keys.has(item.differsFrom.key)) errors.push(where + ' is compared with "' + item.differsFrom.key + '", which is not an item.');
    if (item.type === 'computed') {
      for (const row of item.rows || []) {
        const operands = row.kind === 'diff' ? [row.upper, row.lower] : row.kind === 'absdiff' ? [row.a, row.b] : row.of || [];
        if (!operands.length) errors.push('Calculated row "' + row.key + '" has nothing to calculate from.');
        for (const ref of operands) {
          if (ref && typeof ref === 'object') {
            if (!rowKeys.has(ref.computed)) errors.push('Calculated row "' + row.key + '" uses "' + ref.computed + '", which is not a calculated row.');
          } else if (!numberKey(ref)) {
            errors.push('Calculated row "' + row.key + '" uses "' + ref + '", which is not a number item.');
          }
        }
        if (row.override != null && !numberKey(row.override)) errors.push('Calculated row "' + row.key + '" can be replaced by "' + row.override + '", which is not a number item.');
      }
    }
  }

  if (!Array.isArray(t.photoLabels) || !t.photoLabels.every((label) => typeof label === 'string' && label.trim())) {
    errors.push('photoLabels must be a list of words.');
  }
  return errors;
}
