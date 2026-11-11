import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { winAnsi, textWidth, wrapText, fitText, jpegInfo, PdfDocument } from '../../src/pdf.js';
import { buildReport } from '../../src/report.js';
import { TEMPLATE } from '../../src/template.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

// A real JPEG: the app's own icon is a PNG, so one is made by hand from the smallest valid parts.
function tinyJpeg(width, height, components) {
  const sof = [0xff, 0xc0, 0x00, 8 + components * 3, 8, height >> 8, height & 255, width >> 8, width & 255, components];
  for (let c = 0; c < components; c += 1) sof.push(c + 1, 0x11, 0);
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0, ...sof, 0xff, 0xd9]);
}

/** Checks the file's own index: every object is where the index says it is. */
function checkStructure(bytes) {
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const [, first, count] = /^xref\n(\d+) (\d+)\n/.exec(text.slice(startxref));
  assert.equal(first, '0');
  const rows = text.slice(startxref).split('\n').slice(2, 2 + Number(count));
  rows.slice(1).forEach((row, i) => {
    const offset = Number(row.slice(0, 10));
    assert.equal(text.slice(offset, offset + String(i + 1).length + 6), i + 1 + ' 0 obj', 'object ' + (i + 1) + ' is where the index says');
  });
  // Each stream is exactly as long as it says.
  for (const m of text.matchAll(/\/Length (\d+)[^>]*>>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.equal(text.slice(start + Number(m[1]), start + Number(m[1]) + 10), '\nendstream');
  }
  return text;
}

test('text becomes the standard Latin character set, and anything else a question mark', () => {
  assert.deepEqual(winAnsi('Ab 9'), [65, 98, 32, 57]);
  assert.deepEqual(winAnsi('Île-à-la-Crosse'), [...'Île-à-la-Crosse'].map((c) => c.charCodeAt(0)));
  assert.deepEqual(winAnsi('e\u0301'), [0xe9], 'a letter and its accent typed separately are joined');
  assert.deepEqual(winAnsi('1Ø 45°'), [49, 0xd8, 32, 52, 53, 0xb0]);
  assert.deepEqual(winAnsi('\u2013\u2019\u20ac'), [150, 146, 128], 'dash, curly quote and euro sign have their own codes');
  assert.deepEqual(winAnsi('\u22129.4'), [45, 57, 46, 52], 'a typed minus sign prints as a hyphen');
  assert.deepEqual(winAnsi('pole \u{1F600}'), [...'pole ?'].map((c) => c.charCodeAt(0)));
  assert.deepEqual(winAnsi('a\u0000b\nc'), [97, 98, 32, 99], 'control characters go, a line break becomes a space');
  assert.deepEqual(winAnsi(null), []);
});

test('widths come from the font metrics', () => {
  assert.equal(textWidth('A', 'regular', 10), 6.67);
  assert.equal(textWidth('A', 'bold', 10), 7.22);
  assert.equal(textWidth('iiii', 'mono', 10), 24, 'every Courier character is the same width');
  assert.ok(textWidth('WWW', 'regular', 10) > textWidth('iii', 'regular', 10));
});

test('wrapping keeps words whole, keeps line breaks, and breaks a word too long for a line', () => {
  const lines = wrapText('The quick brown fox jumps over the lazy dog', 'regular', 10, 80);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(' '), 'The quick brown fox jumps over the lazy dog');
  for (const line of lines) assert.ok(textWidth(line, 'regular', 10) <= 80);
  assert.deepEqual(wrapText('one\ntwo', 'regular', 10, 500), ['one', 'two']);
  assert.deepEqual(wrapText('', 'regular', 10, 500), ['']);
  const long = wrapText('X'.repeat(60), 'regular', 10, 100);
  assert.ok(long.length > 1 && long.every((line) => textWidth(line, 'regular', 10) <= 100));
  assert.equal(long.join(''), 'X'.repeat(60));
});

test('a line that is too long is cut, and says so', () => {
  assert.equal(fitText('Short', 'regular', 10, 200), 'Short');
  const cut = fitText('A very long name for a job that would run into the page number', 'regular', 10, 100);
  assert.ok(cut.endsWith('...') && textWidth(cut, 'regular', 10) <= 100, cut);
  assert.equal(fitText('  two   spaces ', 'regular', 10, 200), 'two spaces');
});

test('a JPEG gives its size and colours; anything else is refused', () => {
  assert.deepEqual(jpegInfo(tinyJpeg(900, 675, 3)), { width: 900, height: 675, components: 3 });
  assert.deepEqual(jpegInfo(tinyJpeg(10, 20, 1)), { width: 10, height: 20, components: 1 });
  assert.equal(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null, 'a PNG');
  assert.equal(jpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null, 'a JPEG with no picture');
  assert.equal(jpegInfo(new Uint8Array(0)), null);
  assert.equal(jpegInfo(tinyJpeg(0, 10, 3)), null);
});

test('a document is a well-formed PDF with its pages, fonts and pictures', () => {
  const doc = new PdfDocument({ title: 'Test (one) \\ two', created: new Date(2026, 9, 31, 17, 30) });
  const page = doc.addPage();
  page.text(40, 40, 'Hello (world) \\ Île', { font: 'bold', size: 12 });
  page.box(40, 60, 100, 20, '#0A6B5D');
  page.frame(40, 60, 100, 20, '#C9CEC6');
  page.line(40, 90, 200, 90, '#C9CEC6');
  const picture = doc.addImage(tinyJpeg(300, 200, 3));
  assert.deepEqual(picture, { id: 1, width: 300, height: 200 });
  page.image(picture.id, 40, 100, 150, 100);
  assert.equal(doc.addImage(new Uint8Array([1, 2, 3])), null);
  doc.addPage().text(40, 40, 'Second page');
  const { parts, size } = doc.finish();
  const bytes = Buffer.concat(parts.map((p) => Buffer.from(p)));
  assert.equal(bytes.length, size);
  const text = checkStructure(bytes);
  assert.match(text, /\/Type \/Pages \/Count 2/);
  assert.match(text, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
  assert.match(text, /\/Subtype \/Image \/Width 300 \/Height 200 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/);
  assert.match(text, /\(Hello \\\(world\\\) \\\\ \\316le\) Tj/, 'brackets and backslashes are escaped, accents written as codes');
  assert.match(text, /\/Title \(Test \\\(one\\\) \\\\ two\)/);
  assert.match(text, /\/CreationDate \(D:20261031173000\)/);
  // The top of the page is at the top: y is measured down from the top, the PDF counts up.
  assert.match(text, /40 712 100 20 re f/);
});

test('the report: a first page per job, a page per pole, photos, and a list of what to check', async () => {
  const now = Date.UTC(2026, 9, 31, 12);
  const pole = (id, number, f, extra) => ({ pole: { id, jobId: 'j1', f, gps: null, done: true, createdAt: now, updatedAt: now, ...extra }, number, photos: [] });
  const first = pole('p1', 1, { tagMap: 'A1', tagField: 'A1', height: '45', gP: '9.4', gN: '8.1', notes: 'Line one\nLine two (with brackets)' }, { gps: { lat: 50.02, lon: -125.24, acc: 6, at: now } });
  first.photos = [{ id: 'f1', label: 'Pole tag', w: 900, h: 675 }, { id: 'f2', label: '', w: 900, h: 675 }];
  const second = pole('p2', 2, { tagMap: 'B7', tagField: 'B8', gP: '1' + '0'.repeat(308), gN: '-' + '1' + '0'.repeat(308) });
  const data = {
    template: TEMPLATE,
    tokens: { power: 'Power', telecom: 'Telecom' },
    madeAt: now,
    jobs: [{ job: { id: 'j1', f: { location: 'Dogwood St', designNo: 'D-1', date: '2026-10-31' }, createdAt: now, updatedAt: now, exportedAt: 0 }, poles: [first, second] }],
  };
  const seen = [];
  const readPhoto = async (photo) => (photo.id === 'f1' ? { data: tinyJpeg(900, 675, 3) } : null);
  const report = await buildReport(data, readPhoto, (done, total) => seen.push(done + '/' + total));
  assert.equal(report.missingPhotos, 1, 'the photo that could not be read is counted');
  assert.deepEqual(seen, ['1/2', '2/2']);
  const text = checkStructure(Buffer.concat(report.parts.map((p) => Buffer.from(p))));
  const pages = Number(/\/Type \/Pages \/Count (\d+)/.exec(text)[1]);
  assert.ok(pages >= 3, 'a first page and a page for each pole');
  for (const words of ['POLE FIELD DATA REPORT', 'Dogwood St', 'Pole 1', 'Pole 2', 'CHECK THESE', 'Does not match the map tag', 'Photo 1 of 2: Pole tag', 'This photo could not be read from the phone.', 'Line two \\(with brackets\\)', '50.020000, -125.240000', '1.30', 'check entry', 'Page 1 of ' + pages]) {
    assert.ok(text.includes('(' + words) || text.includes(words), 'the report says: ' + words);
  }
  assert.ok(!/Infinity|NaN/.test(text), 'no impossible number is printed');
  assert.ok(!text.includes('not entered'), 'questions left blank are not listed');
  assert.ok(readFileSync(path.join(ROOT, 'src/pdf-metrics.js'), 'utf8').startsWith('// Made by tools/make-pdf-metrics.py'));
});
