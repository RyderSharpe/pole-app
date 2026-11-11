import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../../src/csv.js';

test('numbers are written bare, text is always quoted', () => {
  assert.equal(csvCell(9.4), '9.4');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(-1.3), '-1.3');
  assert.equal(csvCell('Dogwood St'), '"Dogwood St"');
  assert.equal(csvCell('0042'), '"0042"');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(NaN), '');
  assert.equal(csvCell(Infinity), '');
  assert.equal(csvCell(true), '"Yes"');
  assert.equal(csvCell(false), '');
});

test('commas, semicolons, quotes and line breaks stay inside their cell', () => {
  assert.equal(csvCell('North, 42 m'), '"North, 42 m"');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('He said "ok"'), '"He said ""ok"""');
  assert.equal(csvCell('line 1\nline 2'), '"line 1\nline 2"');
});

test('text that a spreadsheet could run as a formula is defused', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
  assert.equal(csvCell('+1+1'), '"\'+1+1"');
  assert.equal(csvCell('-2+3'), '"\'-2+3"');
  assert.equal(csvCell('@SUM(A1)'), '"\'@SUM(A1)"');
  assert.equal(csvCell('\tcmd'), '"\'\tcmd"');
  assert.equal(csvCell('\r=1'), '"\'\r=1"');
  assert.equal(csvCell('\n=1'), '"\'\n=1"');
  // Spaces and characters that cannot be seen in front of the sign do not hide it.
  assert.equal(csvCell(' =1+1'), '"\' =1+1"');
  assert.equal(csvCell('\u00a0=1+1'), '"\'\u00a0=1+1"');
  assert.equal(csvCell('\u200b=1+1'), '"\'\u200b=1+1"');
  assert.equal(csvCell('\ufeff@SUM(A1)'), '"\'\ufeff@SUM(A1)"');
  assert.equal(csvCell('\u202e=1+1'), '"\'\u202e=1+1"');
  // Full-width signs, which some spreadsheets read as the ordinary ones.
  assert.equal(csvCell('\uff1d1+1'), '"\'\uff1d1+1"');
  assert.equal(csvCell('\uff0b1'), '"\'\uff0b1"');
  // Control characters have no place in a cell.
  assert.equal(csvCell('a\u0000b\u0007c'), '"abc"');
  assert.equal(csvCell('\u0000=1'), '"\'=1"');
  assert.equal(csvCell('\u0000'), '');
});

test('a plain signed number typed as text is left alone', () => {
  assert.equal(csvCell('-5'), '"-5"');
  assert.equal(csvCell('+12.5'), '"+12.5"');
  assert.equal(csvCell('-0,5'), '"-0,5"');
});

test('the file starts with a UTF-8 marker and uses Windows line ends', () => {
  const text = toCsv([['Pole #', 'Tag'], [1, 'Île-1'], [2, '']]);
  assert.equal(text, '﻿"Pole #","Tag"\r\n1,"Île-1"\r\n2,\r\n');
  assert.equal(toCsv([]), '﻿\r\n');
});
