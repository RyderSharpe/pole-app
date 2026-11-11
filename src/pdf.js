// A small PDF writer, written for this app so that no outside library is needed.
//
// It knows just enough for the report: pages of one size, the built-in fonts Helvetica,
// Helvetica-Bold and Courier-Bold (every PDF reader has them, so nothing is stored in the file),
// text, filled and outlined boxes, lines, and JPEG photos. A JPEG is stored exactly as it is,
// because a PDF can show one directly.
//
// Text uses the standard Latin character set (WinAnsi). Letters with accents print correctly.
// A character outside that set (an emoji, say) prints as "?".
//
// Positions are in points (1/72 inch), measured from the TOP-left corner of the page, which is
// how a page is laid out. They are turned round to the PDF's own bottom-left origin on output.

import { HELVETICA, HELVETICA_BOLD, WINANSI_EXTRA } from './pdf-metrics.js';

export const LETTER = { width: 612, height: 792 };

const FONTS = {
  regular: { key: 'F1', base: 'Helvetica', widths: HELVETICA },
  bold: { key: 'F2', base: 'Helvetica-Bold', widths: HELVETICA_BOLD },
  mono: { key: 'F3', base: 'Courier-Bold', widths: null }, // every Courier character is 600 wide
};

// Characters with a plain stand-in, so common typing still prints sensibly.
const STAND_INS = { '−': '-', '‐': '-', '‑': '-', '′': "'", '″': '"', ' ': ' ', '\t': ' ', '≤': '<=', '≥': '>=', '≈': '~', '→': '->' };

/** Turns text into WinAnsi character codes (0 to 255). Anything else becomes "?". */
export function winAnsi(text) {
  const out = [];
  for (const ch of String(text == null ? '' : text).normalize('NFC')) {
    const stand = STAND_INS[ch];
    if (stand) {
      for (const s of stand) out.push(s.charCodeAt(0));
      continue;
    }
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff)) out.push(c);
    else if (WINANSI_EXTRA[c]) out.push(WINANSI_EXTRA[c]);
    else if (c === 0x0a || c === 0x0d) out.push(0x20);
    else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue; // control characters
    else if (c >= 0x300 && c <= 0x36f) continue; // a mark left over that could not be combined
    else out.push(0x3f);
  }
  return out;
}

/** Width of text in points. */
export function textWidth(text, font, size) {
  const f = FONTS[font] || FONTS.regular;
  let units = 0;
  for (const code of winAnsi(text)) units += f.widths ? f.widths[code - 32] || 0 : 600;
  return (units * size) / 1000;
}

/**
 * Splits text into lines no wider than width. Line breaks in the text are kept. A word longer
 * than a line is broken where it has to be.
 */
export function wrapText(text, font, size, width) {
  const lines = [];
  for (const paragraph of String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')) {
    const words = paragraph.split(/ +/).filter((w, i, all) => w !== '' || all.length === 1);
    let line = '';
    for (const word of words) {
      const tryLine = line ? line + ' ' + word : word;
      if (textWidth(tryLine, font, size) <= width) {
        line = tryLine;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      // The word alone is too wide: break it into pieces that fit.
      let piece = '';
      for (const ch of word) {
        if (textWidth(piece + ch, font, size) > width && piece) {
          lines.push(piece);
          piece = '';
        }
        piece += ch;
      }
      line = piece;
    }
    lines.push(line);
  }
  return lines;
}

/** Text cut to fit one line of the width given, ending in "..." when it had to be cut. */
export function fitText(text, font, size, width) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (textWidth(value, font, size) <= width) return value;
  let cut = '';
  for (const ch of value) {
    if (textWidth(cut + ch + '...', font, size) > width) break;
    cut += ch;
  }
  return cut.trimEnd() + '...';
}

/** Reads the size and colours of a JPEG. Returns { width, height, components } or null. */
export function jpegInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or picture data before any size
    const length = (b[i + 2] << 8) | b[i + 3];
    // Start-of-frame markers hold the size. C4, C8 and CC are other kinds of marker.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      const components = b[i + 9];
      if (!width || !height || ![1, 3, 4].includes(components)) return null;
      return { width, height, components };
    }
    i += 2 + length;
  }
  return null;
}

const encoder = new TextEncoder();
const num = (n) => (Math.round(n * 100) / 100).toString();
const colour = (hex) => {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => num(c / 255)).join(' ');
};

// Text inside ( ) in a PDF: the three special characters are escaped, the rest are byte values.
function pdfString(codes) {
  let out = '(';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 0x20 || c > 0x7e) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

// Text for the document's details (title and so on): plain ASCII, so any reader shows it.
function infoString(text) {
  return pdfString(winAnsi(text).map((c) => (c > 0x7e ? 0x3f : c)));
}

class Page {
  constructor(doc) {
    this.doc = doc;
    this.ops = [];
    this.images = new Set();
  }

  y(top) {
    return this.doc.size.height - top;
  }

  /** Writes one line of text with its top-left corner at (x, top). */
  text(x, top, text, options) {
    const o = options || {};
    const font = FONTS[o.font] || FONTS.regular;
    const size = o.size || 10;
    // The baseline sits about 80% of the font size below the top of the line.
    const baseline = this.y(top + size * 0.8);
    let left = x;
    if (o.align === 'right') left = x - textWidth(text, o.font, size);
    else if (o.align === 'center') left = x - textWidth(text, o.font, size) / 2;
    this.ops.push('BT /' + font.key + ' ' + num(size) + ' Tf ' + colour(o.color || '#14181A') + ' rg ' + num(left) + ' ' + num(baseline) + ' Td ' + pdfString(winAnsi(text)) + ' Tj ET');
  }

  /** A filled box. */
  box(x, top, width, height, fill) {
    this.ops.push(colour(fill) + ' rg ' + num(x) + ' ' + num(this.y(top + height)) + ' ' + num(width) + ' ' + num(height) + ' re f');
  }

  /** An outlined box. */
  frame(x, top, width, height, stroke, lineWidth) {
    this.ops.push(colour(stroke) + ' RG ' + num(lineWidth || 0.75) + ' w ' + num(x) + ' ' + num(this.y(top + height)) + ' ' + num(width) + ' ' + num(height) + ' re S');
  }

  line(x1, top1, x2, top2, stroke, lineWidth) {
    this.ops.push(colour(stroke) + ' RG ' + num(lineWidth || 0.5) + ' w ' + num(x1) + ' ' + num(this.y(top1)) + ' m ' + num(x2) + ' ' + num(this.y(top2)) + ' l S');
  }

  /** Draws a picture added with doc.addImage, scaled to the box given. */
  image(id, x, top, width, height) {
    this.images.add(id);
    this.ops.push('q ' + num(width) + ' 0 0 ' + num(height) + ' ' + num(x) + ' ' + num(this.y(top + height)) + ' cm /Im' + id + ' Do Q');
  }
}

export class PdfDocument {
  /** options: { size: { width, height }, title, author, subject, created (Date) } */
  constructor(options) {
    const o = options || {};
    this.size = o.size || LETTER;
    this.info = { title: o.title || '', author: o.author || '', subject: o.subject || '', created: o.created || new Date() };
    this.pages = [];
    this.imageList = [];
  }

  addPage() {
    const page = new Page(this);
    this.pages.push(page);
    return page;
  }

  /**
   * Adds a JPEG. Returns { id, width, height } to draw it with page.image, or null when the
   * bytes are not a JPEG this writer can store.
   */
  addImage(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const info = jpegInfo(data);
    if (!info) return null;
    const id = this.imageList.length + 1;
    this.imageList.push({ id, data, ...info });
    return { id, width: info.width, height: info.height };
  }

  /** Builds the file. Returns a list of Uint8Array pieces to put in a Blob, and the total size. */
  finish() {
    const parts = [];
    const offsets = [];
    let size = 0;
    const put = (piece) => {
      const bytes = typeof piece === 'string' ? encoder.encode(piece) : piece;
      parts.push(bytes);
      size += bytes.length;
    };
    // Every object is numbered. 1 = catalog, 2 = page list, 3 = info, 4 to 6 = fonts.
    const begin = (n) => {
      offsets[n] = size;
      put(n + ' 0 obj\n');
    };
    // The header's second line holds bytes above 127, which tells file tools the PDF is binary.
    put(new Uint8Array([...encoder.encode('%PDF-1.4\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const fontObject = { F1: 4, F2: 5, F3: 6 };
    const firstImage = 7;
    const firstPage = firstImage + this.imageList.length;
    const pageObject = (i) => firstPage + i * 2;
    const total = firstPage + this.pages.length * 2;

    begin(1);
    put('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    begin(2);
    put('<< /Type /Pages /Count ' + this.pages.length + ' /Kids [' + this.pages.map((p, i) => pageObject(i) + ' 0 R').join(' ') + '] >>\nendobj\n');
    begin(3);
    const d = this.info.created;
    const pad = (n) => String(n).padStart(2, '0');
    const when = 'D:' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    put('<< /Title ' + infoString(this.info.title) + ' /Author ' + infoString(this.info.author) + ' /Subject ' + infoString(this.info.subject) + ' /Producer (Pole Field Data) /Creator (Pole Field Data) /CreationDate (' + when + ') >>\nendobj\n');
    for (const font of Object.values(FONTS)) {
      begin(fontObject[font.key]);
      put('<< /Type /Font /Subtype /Type1 /BaseFont /' + font.base + ' /Encoding /WinAnsiEncoding >>\nendobj\n');
    }
    for (const image of this.imageList) {
      begin(firstImage + image.id - 1);
      const space = image.components === 1 ? '/DeviceGray' : image.components === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
      put('<< /Type /XObject /Subtype /Image /Width ' + image.width + ' /Height ' + image.height + ' /ColorSpace ' + space + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + image.data.length + ' >>\nstream\n');
      put(image.data);
      put('\nendstream\nendobj\n');
    }
    this.pages.forEach((page, i) => {
      const content = encoder.encode(page.ops.join('\n'));
      const images = [...page.images].map((id) => '/Im' + id + ' ' + (firstImage + id - 1) + ' 0 R').join(' ');
      begin(pageObject(i));
      put(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(this.size.width) + ' ' + num(this.size.height) + '] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >>' +
          (images ? ' /XObject << ' + images + ' >>' : '') +
          ' >> /Contents ' + (pageObject(i) + 1) + ' 0 R >>\nendobj\n',
      );
      begin(pageObject(i) + 1);
      put('<< /Length ' + content.length + ' >>\nstream\n');
      put(content);
      put('\nendstream\nendobj\n');
    });

    const xref = size;
    let table = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let n = 1; n < total; n += 1) table += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    put(table);
    put('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    return { parts, size };
  }
}
