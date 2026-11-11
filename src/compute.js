// Numbers and calculations. Nothing in this file touches the screen or storage, so every rule
// here is covered by fast tests.

const UNIT_WORDS = {
  m: ['m', 'meter', 'meters', 'metre', 'metres'],
  ft: ['ft', 'foot', 'feet', "'", '′'],
  deg: ['deg', 'degree', 'degrees', '°'],
};

const NUMBER = /^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-zA-Z°'′]*)$/;

/**
 * Reads what a person typed as a number.
 *   blank           -> null
 *   "9.4", "9,4"    -> 9.4
 *   "9.4 m" in a metre field -> 9.4
 *   anything else   -> NaN  (the screen then says "check entry")
 */
export function parseNumber(value, unit) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value).replace(/−/g, '-').trim();
  if (text === '') return null;
  const match = NUMBER.exec(text);
  if (!match) return NaN;
  const suffix = match[2].toLowerCase();
  if (suffix !== '') {
    const allowed = UNIT_WORDS[unit];
    if (!allowed || !allowed.includes(suffix)) return NaN;
  }
  const number = Number(match[1].replace(',', '.'));
  return Number.isFinite(number) ? number : NaN;
}

/** Rounds to two decimal places, the same way for positive and negative numbers. */
export function round2(n) {
  if (!Number.isFinite(n)) return n;
  if (Math.abs(n) >= 1e15) return n; // too large to hold hundredths at all
  // Times 100, then rounded to 12 significant digits to clear the tiny error binary numbers
  // carry (1.005 * 100 is 100.49999999999999). Halves then round away from zero, as people do.
  const hundredths = Math.round(Number((Math.abs(n) * 100).toPrecision(12)));
  const rounded = (Math.sign(n) * hundredths) / 100;
  return rounded === 0 ? 0 : rounded;
}

const isBad = (v) => typeof v === 'number' && Number.isNaN(v);
// A result too large to hold (two absurd entries, say) is treated like an unreadable entry.
const finite = (v) => (Number.isFinite(v) ? v : NaN);

/**
 * Works out a group of calculated rows.
 *
 * rows: [{ key, kind, ... }]
 *   kind "diff"    : upper - lower
 *   kind "absdiff" : distance between a and b
 *   kind "min"     : smallest of the "of" list, ignoring blanks
 *   kind "max"     : largest of the "of" list, ignoring blanks
 *   override       : a field that, when filled, replaces the calculation
 * An operand is a field key, or { computed: key } to use another row.
 *
 * read(key) must return a number, null (blank) or NaN (unreadable).
 * Returns { key: number | null | NaN }.
 */
export function evaluateComputed(rows, read) {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const done = new Map();
  const active = new Set();

  const operand = (ref) => {
    if (ref && typeof ref === 'object') return evaluate(ref.computed);
    return read(ref);
  };

  function evaluate(key) {
    if (done.has(key)) return done.get(key);
    const row = byKey.get(key);
    if (!row || active.has(key)) return NaN; // unknown row, or rows that refer to each other
    active.add(key);
    const result = calculate(row);
    active.delete(key);
    done.set(key, result);
    return result;
  }

  function calculate(row) {
    if (row.override) {
      const typed = read(row.override);
      if (isBad(typed)) return NaN;
      if (typed != null) return finite(round2(typed));
    }
    if (row.kind === 'diff' || row.kind === 'absdiff') {
      const a = operand(row.kind === 'diff' ? row.upper : row.a);
      const b = operand(row.kind === 'diff' ? row.lower : row.b);
      if (isBad(a) || isBad(b)) return NaN;
      if (a == null || b == null) return null;
      return finite(round2(row.kind === 'diff' ? a - b : Math.abs(a - b)));
    }
    if (row.kind === 'min' || row.kind === 'max') {
      const values = (row.of || []).map(operand);
      if (values.some(isBad)) return NaN;
      const present = values.filter((v) => v != null);
      if (!present.length) return null;
      return finite(round2(row.kind === 'min' ? Math.min(...present) : Math.max(...present)));
    }
    return NaN;
  }

  const out = {};
  for (const row of rows) out[row.key] = evaluate(row.key);
  return out;
}

/** Turns a calculated value into the words shown on screen. */
export function describeValue(value, unit) {
  if (value == null) return { text: 'not entered', state: 'blank' };
  if (isBad(value) || !Number.isFinite(value)) return { text: 'check entry', state: 'bad' };
  const text = value.toFixed(2) + (unit ? ' ' + unit : '');
  return { text, state: value < 0 ? 'negative' : 'ok' };
}

/**
 * Says whether a number is outside the range a field usually holds.
 * Returns '' when fine, otherwise a short message. It never blocks an entry.
 */
export function rangeMessage(value, soft, unit) {
  if (value == null || isBad(value) || !Array.isArray(soft)) return '';
  const [low, high] = soft;
  if (value >= low && value <= high) return '';
  const u = unit ? ' ' + unit : '';
  return 'Usually ' + low + ' to ' + high + u + '. Check the entry.';
}
