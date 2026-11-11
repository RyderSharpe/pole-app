// Writes a CSV file that other programs can import.
//
// The CSV file is for other programs. Opened straight in Excel it can lose leading zeros (a tag
// "0042" becomes 42), because Excel guesses what each cell means.

const PLAIN_NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/;
// A spreadsheet may skip spaces and characters that cannot be seen before it looks for a formula,
// and some read the full-width signs (＝ ＋ － ＠) as ordinary ones. So all of those count.
const STARTS_LIKE_FORMULA = /^[\s\u00a0\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]*[=+\-@\uff1d\uff0b\uff0d\uff20]|^[\t\r\n]/;

/**
 * One cell.
 *   numbers are written bare
 *   text is always wrapped in quotes, so commas, semicolons and line breaks are safe
 *   text that a spreadsheet could run as a formula gets a leading apostrophe
 */
export function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? '"Yes"' : '';
  let text = String(value);
  if (text === '') return '';
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (text === '') return '';
  if (STARTS_LIKE_FORMULA.test(text) && !PLAIN_NUMBER.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

/** rows: an array of arrays. Returns the file text: UTF-8 marker, commas, Windows line ends. */
export function toCsv(rows) {
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
