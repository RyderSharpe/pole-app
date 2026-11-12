// Builds the PDF report: for each job a first page with its details and a list of its poles,
// then one page (or more) for each pole with every answer, the calculated separations, anything
// to check, and the photos.

import { PdfDocument, LETTER, wrapText, textWidth, fitText } from './pdf.js';
import { exportSections, computeAll, poleTag, poleProgress, poleWarnings, columnLabel } from './template-engine.js';
import { APP_NAME, GPS_POOR_ACCURACY_M } from './config.js';
import { layout as spanLayout, arcPoints, spanColour, spanName } from './spans.js';

const INK = '#14181A';
const MUTED = '#4A5257';
const ACCENT = '#0A6B5D';
const ACCENT_INK = '#063F37';
const ACCENT_SOFT = '#DDF1EC';
const LINE = '#C9CEC6';
const FAINT = '#E4E7E1';
const CALC = '#E9EBE6';
const ROW_TINT = '#F5F6F3';
const WARN = '#C98A12';
const WARN_INK = '#5C3900';
const WARN_SOFT = '#FFF4DC';
const ALERT_INK = '#8A3D00';

const PAGE = LETTER;
const LEFT = 40;
const RIGHT = PAGE.width - 40;
const WIDTH = RIGHT - LEFT;
const TOP = 64; // below the running header
const BOTTOM = PAGE.height - 56; // above the footer

const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
};

/** How an answer reads in the report. */
function shown(value, computed) {
  if (value === '' || value == null) return '';
  if (typeof value === 'number') return computed ? value.toFixed(2) : String(value);
  return String(value);
}

/** Lays out pages from the top down, starting a new page when the next piece does not fit. */
class Layout {
  constructor(doc, header) {
    this.doc = doc;
    this.header = header;
    this.page = null;
    this.top = 0;
  }

  newPage(header) {
    if (header) this.header = header;
    this.page = this.doc.addPage();
    this.page.header = this.header;
    this.top = TOP;
    return this.page;
  }

  /** Makes room for height points, starting a new page if needed. Returns true when it did. */
  room(height) {
    if (this.page && this.top + height <= BOTTOM) return false;
    this.newPage();
    return true;
  }

  /** Text that wraps to the width given. Returns the height used. */
  paragraph(text, options) {
    const o = { font: 'regular', size: 10, color: INK, width: WIDTH, x: LEFT, gap: 1.3, ...options };
    const lines = wrapText(text, o.font, o.size, o.width);
    const step = o.size * o.gap;
    for (const line of lines) {
      this.room(step);
      this.page.text(o.x, this.top, line, o);
      this.top += step;
    }
    return lines.length * step;
  }

  /** A dark bar with a section title. */
  bar(title) {
    this.room(22 + 24); // never alone at the bottom of a page
    this.page.box(LEFT, this.top, WIDTH, 20, ACCENT_INK);
    this.page.text(LEFT + 8, this.top + 5.5, title.toUpperCase(), { font: 'bold', size: 9.5, color: '#FFFFFF' });
    this.top += 20;
  }

  /** One label and value row, both wrapping. */
  row(label, value, options) {
    const o = options || {};
    const labelWidth = o.labelWidth || 210;
    const size = 9.5;
    const step = size * 1.3;
    const labelLines = wrapText(label, o.computed ? 'bold' : 'regular', size, labelWidth - 12);
    const empty = value === '';
    const valueFont = o.mono && !empty ? 'mono' : o.computed ? 'bold' : 'regular';
    const valueLines = wrapText(empty ? 'not entered' : value, valueFont, size, WIDTH - labelWidth - 12);
    const height = Math.max(labelLines.length, valueLines.length) * step + 8;
    if (height <= BOTTOM - TOP) this.room(height);
    if (o.computed) this.page.box(LEFT, this.top, WIDTH, height, CALC);
    else if (o.tint) this.page.box(LEFT, this.top, WIDTH, height, ROW_TINT);
    let y = this.top + 4.5;
    for (const line of labelLines) {
      this.page.text(LEFT + 8, y, line, { font: o.computed ? 'bold' : 'regular', size, color: o.computed ? INK : MUTED });
      y += step;
    }
    y = this.top + 4.5;
    for (const line of valueLines) {
      // A long note may still run past the bottom of a page: it simply continues on the next.
      if (y + step > BOTTOM) {
        this.newPage();
        y = this.top + 4.5;
      }
      this.page.text(LEFT + labelWidth, y, line, { font: valueFont, size, color: empty ? '#7A8287' : o.alert ? ALERT_INK : INK });
      y += step;
    }
    this.top = Math.max(this.top + height, y + 3.5);
    this.page.line(LEFT, this.top, RIGHT, this.top, FAINT, 0.5);
  }

  gap(points) {
    this.top += points;
  }
}

function drawHeaderAndFooter(doc, made) {
  const total = doc.pages.length;
  doc.pages.forEach((page, i) => {
    const h = page.header || {};
    // Each side keeps to its own part of the line, so a long name never runs into the other.
    page.text(LEFT, 30, fitText(h.left, 'bold', 8.5, WIDTH * 0.6), { font: 'bold', size: 8.5, color: MUTED });
    page.text(RIGHT, 30, fitText(h.right, 'regular', 8.5, WIDTH * 0.36), { font: 'regular', size: 8.5, color: MUTED, align: 'right' });
    page.line(LEFT, 46, RIGHT, 46, LINE, 0.75);
    page.line(LEFT, PAGE.height - 42, RIGHT, PAGE.height - 42, LINE, 0.5);
    page.text(LEFT, PAGE.height - 34, 'Made with ' + APP_NAME + ', ' + stamp(made), { size: 8, color: MUTED });
    page.text(RIGHT, PAGE.height - 34, 'Page ' + (i + 1) + ' of ' + total, { size: 8, color: MUTED, align: 'right' });
  });
}

/** A coloured label with a word in it, like the ones in the app. Returns its width. */
function pill(page, right, top, text, done) {
  const width = textWidth(text, 'bold', 9) + 16;
  page.box(right - width, top, width, 18, done ? ACCENT_SOFT : WARN_SOFT);
  page.text(right - width / 2, top + 4.5, text, { font: 'bold', size: 9, color: done ? ACCENT_INK : WARN_INK, align: 'center' });
  return width;
}

function jobTitle(data, job) {
  const f = job.f || {};
  return String(f[data.template.job.titleKey] || '').trim() || 'Job with no location';
}

function jobCode(data, job) {
  const f = job.f || {};
  return String(f[data.template.job.codeKey] || '').trim();
}

function coverPage(layout, data, entry, facts) {
  const { job } = entry;
  const page = layout.newPage({ left: jobTitle(data, job), right: jobCode(data, job) ? 'Design # ' + jobCode(data, job) : '' });
  page.text(LEFT, layout.top, 'POLE FIELD DATA REPORT', { font: 'bold', size: 9, color: ACCENT });
  layout.gap(18);
  layout.paragraph(jobTitle(data, job), { font: 'bold', size: 22, gap: 1.2 });
  if (jobCode(data, job)) {
    layout.gap(2);
    layout.paragraph(jobCode(data, job), { font: 'mono', size: 13, color: MUTED });
  }
  layout.gap(14);

  layout.bar('Job details');
  const details = data.template.job.items.map((item) => ({ item, value: shown((job.f || {})[item.key]) })).filter((d) => d.value !== '');
  details.forEach(({ item, value }, i) => layout.row(columnLabel(item, data.tokens), value, { mono: item.mono, tint: i % 2 === 1 }));
  if (!details.length) layout.paragraph('No job details were entered.', { size: 9.5, color: MUTED, x: LEFT + 8 });
  layout.gap(16);

  const done = entry.poles.filter((item) => item.pole.done).length;
  const photoCount = entry.poles.reduce((sum, item) => sum + item.photos.length, 0);
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  layout.paragraph(plural(entry.poles.length, 'pole') + ' and ' + plural(photoCount, 'photo') + '. ' + done + ' done, ' + (entry.poles.length - done) + ' in progress.', { size: 10.5 });
  layout.gap(3);
  layout.paragraph('Each pole has its own page. Questions left blank are not listed there; a "Check these" box names the ones that should have an answer.', { size: 9.5, color: MUTED });
  layout.gap(10);

  // The list of poles.
  const columns = [
    { title: 'Pole', x: LEFT + 8 },
    { title: 'Tag', x: LEFT + 58 },
    { title: 'Status', x: LEFT + 200 },
    { title: 'Left blank', x: LEFT + 290 },
    { title: 'To check', x: LEFT + 360 },
    { title: 'Photos', x: LEFT + 425 },
    { title: 'GPS', x: LEFT + 480 },
  ];
  const head = () => {
    layout.page.box(LEFT, layout.top, WIDTH, 20, ACCENT_INK);
    for (const c of columns) layout.page.text(c.x, layout.top + 6, c.title, { font: 'bold', size: 8.5, color: '#FFFFFF' });
    layout.top += 20;
  };
  layout.room(20 + 18);
  head();
  entry.poles.forEach((item, i) => {
    if (layout.room(18)) head();
    const f = facts.get(item.pole.id);
    if (i % 2 === 1) layout.page.box(LEFT, layout.top, WIDTH, 18, ROW_TINT);
    const cells = [String(item.number), f.tag || 'no tag', item.pole.done ? 'Done' : 'In progress', String(f.blank), String(f.warnings.length), String(item.photos.length), item.pole.gps ? 'Yes' : 'No'];
    cells.forEach((text, k) => {
      const shortTag = k === 1 ? fitText(text, 'mono', 9, 136) : text;
      layout.page.text(columns[k].x, layout.top + 5, shortTag, { font: k === 1 ? 'mono' : k === 0 ? 'bold' : 'regular', size: 9, color: k === 4 && f.warnings.length ? ALERT_INK : INK });
    });
    layout.top += 18;
    layout.page.line(LEFT, layout.top, RIGHT, layout.top, FAINT, 0.5);
  });
}

const DIAGRAM_HEIGHT = 250;

/** The span diagram: this pole in the middle, seen from above, with a line to each pole it connects to. */
function spanDiagram(layout, spans) {
  layout.room(DIAGRAM_HEIGHT + 22);
  const page = layout.page;
  const top = layout.top + 6;
  page.frame(LEFT, top, WIDTH, DIAGRAM_HEIGHT, LINE, 0.5);
  const g = spanLayout(spans, { width: WIDTH, height: DIAGRAM_HEIGHT, r: 76 });
  const at = (p) => ({ x: LEFT + p.x, top: top + p.y });
  const centre = at({ x: g.cx, y: g.cy });
  for (const a of g.angles) page.polyline(arcPoints(g.cx, g.cy, 24, a.a0, a.a1).map(at), WARN, 0.9);
  if (g.through) page.polyline([centre, at(g.through)], MUTED, 0.7, { dash: [4, 3] });
  for (const end of g.ends) page.polyline([centre, at(end)], spanColour(end.index), 2.4);
  for (const a of g.angles) {
    const p = at(a);
    const wide = textWidth(a.text, 'mono', 8.5) + 4;
    page.box(p.x - wide / 2, p.top - 6, wide, 12, '#FFFFFF');
    page.text(p.x, p.top - 4.5, a.text, { font: 'mono', size: 8.5, align: 'center' });
  }
  page.circle(centre.x, centre.top, 4.5, { fill: INK });
  for (const end of g.ends) {
    const p = at(end);
    page.circle(p.x, p.top, 4.5, { fill: '#FFFFFF', stroke: spanColour(end.index), lineWidth: 1.8 });
    const lines = [{ text: spanName(end.span, end.index), font: 'bold', size: 9.5, color: INK }];
    const length = String(end.span.len || '').trim();
    if (length) lines.push({ text: length + ' m', font: 'mono', size: 9, color: spanColour(end.index) });
    const wire = String(end.span.cond || '').trim();
    if (wire) lines.push({ text: wire, font: 'regular', size: 8.5, color: MUTED });
    const step = 11.5;
    const label = at({ x: end.lx, y: end.ly });
    const align = end.anchor === 'start' ? 'left' : end.anchor === 'end' ? 'right' : 'center';
    // Beside the end the label is centred on it. Above it the label stacks upward, below it downward.
    let y = end.anchor === 'middle' ? (end.up ? label.top - lines.length * step : label.top + 2) : label.top - (lines.length * step) / 2;
    for (const line of lines) {
      page.text(label.x, y, fitText(line.text, line.font, line.size, Math.max(40, end.room - 6)), { font: line.font, size: line.size, color: line.color, align });
      y += step;
    }
  }
  page.text(RIGHT - 14, top + 8, 'N', { font: 'bold', size: 8.5, color: MUTED, align: 'center' });
  page.polyline([{ x: RIGHT - 14, top: top + 36 }, { x: RIGHT - 14, top: top + 21 }], MUTED, 0.9);
  page.polyline([{ x: RIGHT - 18, top: top + 26 }, { x: RIGHT - 14, top: top + 21 }, { x: RIGHT - 10, top: top + 26 }], MUTED, 0.9);
  layout.top = top + DIAGRAM_HEIGHT + 5;
  page.text(LEFT, layout.top, 'Seen from above, with this pole in the middle. North is up. Angles are drawn true. Lines are all drawn the same length.', { size: 8, color: MUTED });
  layout.top += 13;
}

async function polePages(layout, data, entry, item, facts, sections, readPhoto, progress) {
  const { job } = entry;
  const f = facts.get(item.pole.id);
  const header = { left: jobTitle(data, job), right: 'Pole ' + item.number + (f.tag ? ' ' + f.tag : '') };
  const page = layout.newPage(header);

  // Title: "Pole 3", the tag, and whether it is done.
  page.text(LEFT, layout.top, 'Pole ' + item.number, { font: 'bold', size: 20 });
  const after = LEFT + textWidth('Pole ' + item.number, 'bold', 20) + 12;
  const pillWidth = pill(page, RIGHT, layout.top + 2, item.pole.done ? 'Done' : 'In progress', item.pole.done);
  if (f.tag) page.text(after, layout.top + 4, fitText(f.tag, 'mono', 15, RIGHT - pillWidth - 12 - after), { font: 'mono', size: 15, color: ACCENT_INK });
  layout.gap(28);
  layout.paragraph(jobTitle(data, job) + (jobCode(data, job) ? '  |  Design # ' + jobCode(data, job) : ''), { size: 10, color: MUTED });
  layout.gap(10);

  // Anything to check, the same list the app shows before saving.
  if (f.warnings.length || f.blankLabels.length) {
    const lines = [];
    for (const w of f.warnings) lines.push({ text: w.label + ': ' + w.text, bold: false });
    if (f.blankLabels.length) lines.push({ text: 'Left blank: ' + f.blankLabels.join(', ') + '.', bold: false });
    const size = 9.5;
    const step = size * 1.3;
    const wrapped = lines.map((l) => wrapText(l.text, 'regular', size, WIDTH - 24));
    const height = 26 + wrapped.reduce((sum, w) => sum + w.length * step + 3, 0);
    layout.room(Math.min(height, BOTTOM - TOP));
    const start = layout.top;
    layout.page.box(LEFT, start, WIDTH, height, WARN_SOFT);
    layout.page.frame(LEFT, start, WIDTH, height, WARN, 0.75);
    layout.page.text(LEFT + 12, start + 8, 'CHECK THESE', { font: 'bold', size: 9, color: WARN_INK });
    layout.top = start + 24;
    for (const w of wrapped) {
      for (const line of w) {
        layout.page.text(LEFT + 12, layout.top, line, { size, color: WARN_INK });
        layout.top += step;
      }
      layout.top += 3;
    }
    layout.top = start + height + 12;
  }

  // Every answer, step by step. Questions left blank are not listed (the box above names the
  // ones that should have an answer), so a pole usually fits on one or two pages.
  const extra = { number: item.number, photos: item.photos.length, computed: f.computed };
  for (const section of sections) {
    if (section.title === 'Job') continue;
    const rows = section.rows.map((line) => ({ line, value: shown(line.read(job, item.pole, extra), line.computed) })).filter((r) => r.value !== '');
    const spans = section.diagram ? (item.pole.spans || []).filter((span) => Number.isFinite(span.brg)) : [];
    if (!rows.length && !spans.length) continue;
    // The heading is never left alone at the bottom of a page: the diagram must fit under it.
    if (spans.length) layout.room(22 + DIAGRAM_HEIGHT + 24);
    layout.bar(section.title);
    if (spans.length) spanDiagram(layout, item.pole.spans);
    rows.forEach(({ line, value }, i) => {
      layout.row(line.label, value, { computed: line.computed, tint: !line.computed && i % 2 === 1, alert: line.computed && (value === 'check entry' || value.startsWith('-')) });
    });
    layout.gap(12);
  }

  // Photos, two side by side.
  let missing = 0;
  if (!item.photos.length) return missing;
  const cell = (WIDTH - 12) / 2;
  const maxHeight = 300;
  // The heading is never left alone at the bottom of a page: there must be room for the first
  // row of photos under it too (worked out from the photo's own shape).
  const firstRow = Math.max(...item.photos.slice(0, 2).map((p) => (p.w > 0 && p.h > 0 ? Math.min(maxHeight, (cell * p.h) / p.w) : 120))) + 30;
  layout.room(28 + firstRow);
  layout.bar('Photos (' + item.photos.length + ')');
  layout.gap(8);
  for (let i = 0; i < item.photos.length; i += 2) {
    const pair = [];
    for (const photo of item.photos.slice(i, i + 2)) {
      const picture = await readPhoto(photo);
      const image = picture ? layout.doc.addImage(picture.data) : null;
      if (!image) missing += 1;
      pair.push({ photo, image });
      if (progress) progress();
    }
    const sized = pair.map(({ photo, image }) => {
      if (!image) return { w: cell, h: 120 };
      let w = cell;
      let h = (cell * image.height) / image.width;
      if (h > maxHeight) {
        w = (w * maxHeight) / h;
        h = maxHeight;
      }
      return { w, h };
    });
    const rowHeight = Math.max(...sized.map((s) => s.h)) + 30;
    layout.room(rowHeight);
    pair.forEach(({ photo, image }, k) => {
      const x = LEFT + k * (cell + 12);
      const { w, h } = sized[k];
      const caption = 'Photo ' + (i + k + 1) + ' of ' + item.photos.length + (photo.label ? ': ' + photo.label : '');
      if (image) {
        layout.page.image(image.id, x + (cell - w) / 2, layout.top, w, h);
        layout.page.frame(x + (cell - w) / 2, layout.top, w, h, LINE, 0.5);
      } else {
        layout.page.box(x, layout.top, w, h, CALC);
        layout.page.text(x + w / 2, layout.top + h / 2 - 5, 'This photo could not be read from the phone.', { size: 9, color: ALERT_INK, align: 'center' });
      }
      layout.page.text(x, layout.top + h + 6, fitText(caption, 'bold', 9, cell), { font: 'bold', size: 9 });
    });
    layout.top += rowHeight;
  }
  return missing;
}

/**
 * data: { template, tokens, jobs: [{ job, poles: [{ pole, number, photos }] }], madeAt }
 * readPhoto(photo) resolves { data } (JPEG bytes) or null when the picture cannot be read.
 * onProgress(done, total) is called as photos are added.
 * Returns { parts, size, missingPhotos }: the pieces of the file, ready for a Blob.
 */
export async function buildReport(data, readPhoto, onProgress) {
  const made = data.madeAt || Date.now();
  const single = data.jobs.length === 1 ? data.jobs[0].job : null;
  const doc = new PdfDocument({ title: single ? 'Pole field data: ' + jobTitle(data, single) : 'Pole field data', author: APP_NAME, subject: 'Pole field data report', created: new Date(made) });
  const layout = new Layout(doc, {});
  const sections = exportSections(data.template, data.tokens);
  const total = data.jobs.reduce((sum, entry) => sum + entry.poles.reduce((n, item) => n + item.photos.length, 0), 0);
  let done = 0;
  const progress = () => {
    done += 1;
    if (onProgress) onProgress(done, total);
  };

  let missingPhotos = 0;
  for (const entry of data.jobs) {
    // What each pole needs on the first page and on its own page, worked out once.
    const facts = new Map();
    for (const item of entry.poles) {
      const tag = poleTag(data.template, item.pole);
      const usedElsewhere = (key, value) => {
        const wanted = String(value || '').trim().toLowerCase();
        return Boolean(wanted) && entry.poles.some((other) => other !== item && String((other.pole.f || {})[key] || '').trim().toLowerCase() === wanted);
      };
      const progressInfo = poleProgress(data.template, item.pole, data.tokens);
      facts.set(item.pole.id, {
        tag,
        computed: computeAll(data.template, item.pole.f),
        blank: progressInfo.blank.length,
        blankLabels: progressInfo.blank.map((b) => b.label),
        warnings: poleWarnings(data.template, item.pole, data.tokens, { usedElsewhere, poorGpsMetres: GPS_POOR_ACCURACY_M }),
      });
    }
    coverPage(layout, data, entry, facts);
    for (const item of entry.poles) missingPhotos += await polePages(layout, data, entry, item, facts, sections, readPhoto, progress);
  }
  drawHeaderAndFooter(doc, made);
  const { parts, size } = doc.finish();
  return { parts, size, missingPhotos };
}
