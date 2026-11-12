// The spans that leave a pole, seen from above: the sums behind the span diagram.
//
// A span: { id, to, toPole, cond, len, brg, main, how }
//   to      what the span goes to (a pole number or a few words)
//   toPole  the id of another pole in the same job, when the span was linked to one
//   cond    the wire, as typed ("2/0 ACSR")
//   len     the length in metres, as typed
//   brg     the direction, in degrees clockwise from north (north is up on the diagram)
//   main    true when the user marked the span as part of the main line
//   how     where the direction came from: drag | typed | gps
//
// Nothing here touches the screen or storage.

export const MAX_SPANS = 6;

/** Any angle brought into 0 to 360 (360 itself becomes 0). */
export function norm(degrees) {
  const d = degrees % 360;
  return d < 0 ? d + 360 : d === 0 ? 0 : d;
}

/** A number of degrees as text: at most two decimals, with no trailing zeros. */
export function degreesText(value) {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 100) / 100;
  return String(rounded) + '°';
}

const placed = (spans) => (spans || []).filter((s) => Number.isFinite(s.brg));

/** The angle between two directions, the short way round: 0 to 180. */
export function between(a, b) {
  const d = Math.abs(norm(a) - norm(b));
  return d > 180 ? 360 - d : d;
}

/**
 * The angles between neighbouring spans, going clockwise. They add up to 360.
 * Returns [{ from, to, angle, mid }]: the two spans, the angle from one round to the next, and
 * the direction half way between them. Empty when fewer than two spans have a direction.
 */
export function gaps(spans) {
  const list = placed(spans).slice().sort((a, b) => norm(a.brg) - norm(b.brg));
  if (list.length < 2) return [];
  let used = 0;
  return list.map((from, i) => {
    const to = list[(i + 1) % list.length];
    // The last gap is whatever is left of the full circle, so the angles always add up to 360.
    const angle = i === list.length - 1 ? 360 - used : norm(to.brg) - norm(from.brg);
    used += angle;
    return { from, to, angle: Math.round(angle * 100) / 100, mid: norm(norm(from.brg) + angle / 2) };
  });
}

/**
 * The angle of deflection: how far the line turns at this pole. A straight line is 0.
 * The two spans used are the two marked "main line", or else the two closest to a straight line.
 * Returns { a, b, angle, chosen } or null when fewer than two spans have a direction.
 * chosen is "marked" when the user picked the pair, "only" when there are just two, else "straightest".
 */
export function deflection(spans) {
  const list = placed(spans);
  if (list.length < 2) return null;
  const marked = list.filter((s) => s.main === true);
  let pair = null;
  let chosen = 'straightest';
  if (marked.length === 2) {
    pair = marked;
    chosen = 'marked';
  } else if (list.length === 2) {
    pair = list;
    chosen = 'only';
  } else {
    let best = -1;
    for (let i = 0; i < list.length; i += 1) {
      for (let k = i + 1; k < list.length; k += 1) {
        const apart = between(list[i].brg, list[k].brg);
        if (apart > best) {
          best = apart;
          pair = [list[i], list[k]];
        }
      }
    }
  }
  const angle = Math.round((180 - between(pair[0].brg, pair[1].brg)) * 100) / 100;
  return { a: pair[0], b: pair[1], angle, chosen };
}

/** A direction for a new span: opposite the only one, or in the middle of the widest gap. */
export function nextBearing(spans) {
  const list = placed(spans);
  if (!list.length) return 270;
  if (list.length === 1) return norm(list[0].brg + 180);
  const widest = gaps(list).reduce((best, gap) => (gap.angle > best.angle ? gap : best));
  return Math.round(widest.mid);
}

const RAD = Math.PI / 180;
const EARTH_M = 6371008.8;

/**
 * The direction and distance from one GPS position to another.
 * Returns { brg, dist, acc }: degrees from north, metres, and how far off the two positions
 * together may be (metres), or null when either position is missing.
 */
export function fromGps(a, b) {
  const ok = (g) => g && Number.isFinite(g.lat) && Number.isFinite(g.lon);
  if (!ok(a) || !ok(b)) return null;
  const p1 = a.lat * RAD;
  const p2 = b.lat * RAD;
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  const dist = 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  const brg = dist < 0.01 ? 0 : norm(Math.atan2(y, x) / RAD);
  const accA = Number.isFinite(a.acc) ? a.acc : null;
  const accB = Number.isFinite(b.acc) ? b.acc : null;
  return { brg: Math.round(brg * 10) / 10, dist: Math.round(dist * 10) / 10, acc: accA == null || accB == null ? null : Math.round(accA + accB) };
}

/** The name to show for a span. */
export const spanName = (span, index) => String(span.to || '').trim() || 'Span ' + (index + 1);

/** One line that says everything about a span, for lists and exports. */
export function spanLine(span, index) {
  const parts = ['To ' + spanName(span, index)];
  if (String(span.len || '').trim()) parts.push(String(span.len).trim() + ' m');
  if (String(span.cond || '').trim()) parts.push(String(span.cond).trim());
  if (Number.isFinite(span.brg)) parts.push('direction ' + degreesText(span.brg));
  if (span.main === true) parts.push('main line');
  return parts.join(', ');
}

/** The angles between neighbouring spans as one line: "A to B 166.41°; B to C 61.84°". */
export function gapsLine(spans) {
  const index = new Map((spans || []).map((s, i) => [s, i]));
  return gaps(spans)
    .map((gap) => spanName(gap.from, index.get(gap.from)) + ' to ' + spanName(gap.to, index.get(gap.to)) + ' ' + degreesText(gap.angle))
    .join('; ');
}

/** The angle of deflection as one line, naming the two spans it was worked out from. */
export function deflectionLine(spans) {
  const d = deflection(spans);
  if (!d) return '';
  const index = new Map((spans || []).map((s, i) => [s, i]));
  return degreesText(d.angle) + ' (between ' + spanName(d.a, index.get(d.a)) + ' and ' + spanName(d.b, index.get(d.b)) + ')';
}

// One colour for each span, dark enough to read on white, on screen and on paper.
export const SPAN_COLOURS = ['#0A6B5D', '#C2571A', '#5B4BC4', '#1D6FB8', '#A3246B', '#6B6F12'];
export const spanColour = (index) => SPAN_COLOURS[index % SPAN_COLOURS.length];

/**
 * Where everything on the diagram goes, for a drawing of the size given.
 * box: { width, height, r } where r is the length every span line is drawn at.
 * Every line is drawn the same length so the labels stay readable: the angles are true, and the
 * real lengths are in the labels.
 * Returns { cx, cy, r, ends: [{ span, index, x, y, lx, ly, anchor, room }], angles: [{ x, y, text, a0, a1 }], through }
 * room: how wide a label at that end may be. through: the far end of the dashed line that
 * carries one span of the main line straight on past the pole.
 */
export function layout(spans, box) {
  const cx = box.width / 2;
  const cy = box.height / 2;
  const r = box.r;
  const point = (brg, radius) => ({ x: cx + radius * Math.sin(brg * RAD), y: cy - radius * Math.cos(brg * RAD) });
  const ends = [];
  (spans || []).forEach((span, index) => {
    if (!Number.isFinite(span.brg)) return;
    const end = point(span.brg, r);
    const label = point(span.brg, r + 14);
    const sideways = Math.sin(span.brg * RAD);
    const anchor = sideways > 0.3 ? 'start' : sideways < -0.3 ? 'end' : 'middle';
    const room = anchor === 'start' ? box.width - label.x - 4 : anchor === 'end' ? label.x - 4 : 2 * Math.min(label.x, box.width - label.x) - 8;
    ends.push({ span, index, x: end.x, y: end.y, lx: label.x, ly: label.y, anchor, room, up: Math.cos(span.brg * RAD) > 0 });
  });
  const angles = gaps(spans).map((gap) => {
    const at = point(gap.mid, r * 0.6);
    return { x: at.x, y: at.y, text: degreesText(gap.angle), a0: norm(gap.from.brg), a1: norm(gap.from.brg) + gap.angle, gap };
  });
  const d = deflection(spans);
  let through = null;
  if (d && d.angle > 0.005) {
    const far = point(norm(d.a.brg + 180), r);
    through = { x: far.x, y: far.y, from: d.a, to: d.b, angle: d.angle };
  }
  return { cx, cy, r, ends, angles, through };
}

/** Points along an arc round the middle, for drawing it as short straight pieces. */
export function arcPoints(cx, cy, radius, from, to) {
  const steps = Math.max(2, Math.ceil(Math.abs(to - from) / 6));
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (from + ((to - from) * i) / steps) * RAD;
    out.push({ x: cx + radius * Math.sin(a), y: cy - radius * Math.cos(a) });
  }
  return out;
}
