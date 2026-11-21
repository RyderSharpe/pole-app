// What is on a sketch: a list of items, each one a thing that can be picked up and moved.
//
//   pen   { t:'pen',  c, w, p:[[x,y],...] }          a freehand stroke
//   line  { t:'line', c, w, a:[x,y], b:[x,y] }       a straight line
//   text  { t:'text', c, s, x, y, text, w }          words (x is the left edge, y the middle; w the width)
//   sym   { t:'sym',  k, c, s, r, x, y, text }       a standard symbol (x, y the middle; s the size; r degrees)
//
// c is a colour, w a line width, s a size. All are in the units of the page the sketch is drawn on.
// The sums here (hit tests, snapping, handles) touch no screen. Drawing needs a canvas context.

export const MAX_ITEMS = 300;
export const MAX_POINTS = 700;

export const COLOURS = [
  { name: 'Black', value: '#14181A' },
  { name: 'Red', value: '#D42A20' },
  { name: 'Blue', value: '#1D5FD0' },
  { name: 'Green', value: '#0A7A45' },
  { name: 'Yellow', value: '#F2C40F' },
];

/**
 * The standard things that can be placed. Each is drawn about its middle.
 * reach: how far it reaches from the middle at size 1. capY: how far below the middle its words sit.
 * size: how much bigger than usual it is when first placed (a pole is tall). group: "side" for a side view of a pole (how poles are usually sketched), "above" for a view from above.
 */
export const SYMBOLS = [
  { key: 'epole', name: 'Pole', text: '', reach: 100, capY: 112, size: 1.7, group: 'side' },
  { key: 'ecross', name: 'Crossarm', text: '', reach: 50, capY: -34, group: 'side' },
  { key: 'etx', name: 'Transformer', text: '1PH TX', reach: 34, capY: 44, group: 'side' },
  { key: 'esl', name: 'Street light', text: 'Street light', reach: 46, capY: 36, group: 'side' },
  { key: 'esec', name: 'Secondary rack', text: '', reach: 34, capY: 44, group: 'side' },
  { key: 'edip', name: 'Dip (riser)', text: 'Dip', reach: 50, capY: 62, group: 'side' },
  { key: 'eguy', name: 'Guy and anchor', text: 'Anchor', reach: 50, capY: 56, group: 'side' },
  { key: 'pole', name: 'Pole (from above)', text: 'Pole', reach: 40, capY: 30, group: 'above' },
  { key: 'newpole', name: 'New pole (from above)', text: 'New pole', reach: 40, capY: 30, group: 'above' },
  { key: 'tx1', name: '1PH transformer (from above)', text: '1PH TX', reach: 40, capY: 30, group: 'above' },
  { key: 'tx3', name: '3PH transformer (from above)', text: '3PH TX', reach: 40, capY: 30, group: 'above' },
  { key: 'sl', name: 'Street light (from above)', text: 'Street light', reach: 40, capY: 30, group: 'above' },
  { key: 'anchor', name: 'Anchor and guy (from above)', text: 'Anchor', reach: 40, capY: 30, group: 'above' },
  { key: 'dip', name: 'Dip (from above)', text: 'Dip', reach: 40, capY: 30, group: 'above' },
  { key: 'switch', name: 'Switch', text: 'Switch', reach: 40, capY: 30, group: 'above' },
  { key: 'fuse', name: 'Fuse', text: 'Fuse', reach: 40, capY: 30, group: 'above' },
  { key: 'cap', name: 'Capacitor', text: 'Cap', reach: 40, capY: 30, group: 'above' },
  { key: 'meter', name: 'Meter', text: 'Meter', reach: 40, capY: 30, group: 'above' },
  { key: 'north', name: 'North arrow', text: 'N', reach: 40, capY: 30, group: 'above' },
];
export const SYMBOL_KEYS = new Set(SYMBOLS.map((s) => s.key));
const SPEC = new Map(SYMBOLS.map((s) => [s.key, s]));

/** How far a symbol reaches from its middle at size 1. */
export const symbolReach = (key) => (SPEC.get(key) || { reach: 40 }).reach;
const reachOf = (item) => symbolReach(item.k) * item.s;
const capOf = (item) => ((SPEC.get(item.k) || { capY: 30 }).capY) * item.s;

const FONT = '"IBM Plex Sans", system-ui, -apple-system, sans-serif';

const RAD = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------------------------
// Sums

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a[0], p.y - a[1]);
  const t = clamp(((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
}

/**
 * The point b brought to dead horizontal, dead vertical or a 45 degree line from a, when it is
 * within tol degrees of one. Otherwise b is returned as it is.
 */
export function snapAngle(a, b, tol) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!len) return [b[0], b[1]];
  const angle = Math.atan2(dy, dx) / RAD;
  const step = Math.round(angle / 45) * 45;
  if (Math.abs(angle - step) > (tol == null ? 5 : tol)) return [b[0], b[1]];
  return [a[0] + len * Math.cos(step * RAD), a[1] + len * Math.sin(step * RAD)];
}

/** The ends of lines and the middles of symbols, which a new line end can snap to. */
export function anchors(items, skip) {
  const out = [];
  for (const item of items) {
    if (item === skip) continue;
    if (item.t === 'line') out.push(item.a, item.b);
    else if (item.t === 'sym') out.push([item.x, item.y]);
  }
  return out;
}

/** The nearest anchor within reach of p, or null. */
export function snapToAnchor(p, list, reach) {
  let best = null;
  let nearest = reach;
  for (const a of list) {
    const d = Math.hypot(p[0] - a[0], p[1] - a[1]);
    if (d <= nearest) {
      best = a;
      nearest = d;
    }
  }
  return best ? [best[0], best[1]] : null;
}

export function textWidth(item) {
  return item.w > 0 ? item.w : item.s * String(item.text || '').length * 0.6;
}

function captionBox(item) {
  const size = item.s * 14;
  const wide = String(item.text || '').length * size * 0.6;
  return { left: item.x - wide / 2, right: item.x + wide / 2, top: item.y + capOf(item) - size, bottom: item.y + capOf(item) + size };
}

/** True when p is on the item, give or take reach. */
export function hit(item, p, reach) {
  if (item.t === 'line') return distToSegment(p, item.a, item.b) <= reach + item.w / 2;
  if (item.t === 'pen') {
    const pts = item.p;
    if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= reach + item.w / 2;
    for (let i = 1; i < pts.length; i += 1) if (distToSegment(p, pts[i - 1], pts[i]) <= reach + item.w / 2) return true;
    return false;
  }
  if (item.t === 'text') {
    const wide = textWidth(item);
    return p.x >= item.x - reach && p.x <= item.x + wide + reach && p.y >= item.y - item.s * 0.7 - reach && p.y <= item.y + item.s * 0.7 + reach;
  }
  if (item.t === 'sym') {
    if (Math.hypot(p.x - item.x, p.y - item.y) <= reachOf(item) + reach) return true;
    if (!item.text) return false;
    const box = captionBox(item);
    return p.x >= box.left - reach && p.x <= box.right + reach && p.y >= box.top - reach && p.y <= box.bottom + reach;
  }
  return false;
}

/** The topmost item at p (the last one in the list), or null. */
export function itemAt(items, p, reach) {
  for (let i = items.length - 1; i >= 0; i -= 1) if (hit(items[i], p, reach)) return items[i];
  return null;
}

export function moveItem(item, dx, dy) {
  if (item.t === 'line') {
    item.a = [item.a[0] + dx, item.a[1] + dy];
    item.b = [item.b[0] + dx, item.b[1] + dy];
  } else if (item.t === 'pen') {
    item.p = item.p.map((q) => [q[0] + dx, q[1] + dy]);
  } else {
    item.x += dx;
    item.y += dy;
  }
}

/** The grab points of a picked item: [{ id, x, y }]. A line has one at each end, the rest one for size. */
export function handles(item) {
  if (item.t === 'line') return [{ id: 'a', x: item.a[0], y: item.a[1] }, { id: 'b', x: item.b[0], y: item.b[1] }];
  if (item.t === 'sym') return [{ id: 'size', x: item.x + reachOf(item), y: item.y + reachOf(item) }];
  if (item.t === 'text') return [{ id: 'size', x: item.x + textWidth(item), y: item.y + item.s * 0.7 }];
  return [];
}

/** Bigger or smaller by a factor: text and symbol size, line width. */
export function resizeItem(item, factor) {
  if (item.t === 'text') item.s = clamp(item.s * factor, 12, 400);
  else if (item.t === 'sym') item.s = clamp(item.s * factor, 0.2, 8);
  else item.w = clamp(item.w * factor, 1, 60);
}

/** The size a text or symbol takes when its grab point is dragged to p. */
export function sizeFromHandle(item, p, startSize, startDist) {
  const d = Math.hypot(p.x - item.x, p.y - item.y);
  const factor = startDist > 0 ? d / startDist : 1;
  return item.t === 'text' ? clamp(startSize * factor, 12, 400) : clamp(startSize * factor, 0.2, 8);
}

/** The picture is kept to a sensible number of points, by dropping every few in a long stroke. */
export function thin(points) {
  if (points.length <= MAX_POINTS) return points;
  const every = Math.ceil(points.length / MAX_POINTS);
  const out = points.filter((_, i) => i % every === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Drawing

function haloText(context, text, x, y, size, color, align) {
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.font = '600 ' + size + 'px ' + FONT;
  context.textBaseline = 'middle';
  context.textAlign = align || 'left';
  context.lineJoin = 'round';
  // A light edge keeps words readable on top of a photo or of other drawing.
  context.lineWidth = Math.max(3, size / 5);
  context.strokeStyle = color === '#F2C40F' ? '#14181A' : '#FFFFFF';
  context.strokeText(text, x, y);
  context.fillStyle = color;
  context.fillText(text, x, y);
  context.restore();
}

function line(context, x1, y1, x2, y2) {
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
}

function circle(context, x, y, r, fill) {
  context.beginPath();
  context.arc(x, y, r, 0, Math.PI * 2);
  if (fill) context.fill();
  else context.stroke();
}

// Each symbol is drawn with its middle at 0, 0.
const SHAPES = {
  // ---- side views: how a pole is usually sketched ----
  epole(c) {
    c.save();
    c.lineWidth = 6;
    line(c, 0, -100, 0, 100);
    c.restore();
    line(c, -34, 100, 34, 100);
    line(c, -22, 108, -12, 100);
    line(c, 0, 108, 10, 100);
    line(c, 22, 108, 32, 100);
  },
  ecross(c) {
    c.save();
    c.lineWidth = 7;
    line(c, -46, 0, 46, 0);
    c.restore();
    for (const x of [-38, 0, 38]) line(c, x, 0, x, -14);
    for (const x of [-38, 0, 38]) circle(c, x, -18, 4, true);
  },
  etx(c) {
    c.beginPath();
    c.roundRect ? c.roundRect(-20, -16, 40, 50, 8) : c.rect(-20, -16, 40, 50);
    c.stroke();
    line(c, -9, -16, -9, -30);
    line(c, 9, -16, 9, -30);
    circle(c, -9, -33, 3.5, true);
    circle(c, 9, -33, 3.5, true);
    line(c, -34, -6, -20, -6);
    line(c, -34, 22, -20, 22);
  },
  esl(c) {
    line(c, -46, 14, -20, 14);
    c.beginPath();
    c.moveTo(-20, 14);
    c.quadraticCurveTo(10, 14, 28, -12);
    c.stroke();
    c.beginPath();
    c.ellipse(34, -12, 14, 7, -0.5, 0, Math.PI * 2);
    c.fill();
    line(c, 30, -2, 26, 12);
    line(c, 38, -2, 38, 14);
  },
  esec(c) {
    c.save();
    c.lineWidth = 5;
    line(c, 0, -30, 0, 30);
    c.restore();
    for (const y of [-20, 0, 20]) {
      line(c, 0, y, 18, y);
      circle(c, 22, y, 4, true);
    }
  },
  edip(c) {
    c.save();
    c.lineWidth = 7;
    line(c, 0, -46, 0, 46);
    c.restore();
    c.strokeRect(-8, -50, 16, 100);
    line(c, -14, -50, 14, -50);
  },
  eguy(c) {
    line(c, -10, -46, 38, 38);
    c.beginPath();
    c.moveTo(30, 46);
    c.lineTo(46, 46);
    c.lineTo(38, 30);
    c.closePath();
    c.fill();
    circle(c, -10, -46, 4, true);
  },
  // ---- seen from above ----
  pole(c) {
    circle(c, 0, 0, 18);
    circle(c, 0, 0, 5, true);
  },
  newpole(c) {
    circle(c, 0, 0, 18, true);
    c.save();
    c.strokeStyle = '#FFFFFF';
    c.lineWidth = 3;
    line(c, -9, 0, 9, 0);
    line(c, 0, -9, 0, 9);
    c.restore();
  },
  tx1(c) {
    circle(c, 0, 0, 24);
    c.font = '700 28px ' + FONT;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('1', 0, 2);
  },
  tx3(c) {
    circle(c, -10, 6, 17);
    circle(c, 10, 6, 17);
    circle(c, 0, -11, 17);
  },
  sl(c) {
    circle(c, -22, 18, 5, true);
    line(c, -22, 18, 12, -8);
    circle(c, 22, -14, 11);
    line(c, 22, -32, 22, -38);
    line(c, 38, -14, 44, -14);
    line(c, 34, -26, 39, -31);
    line(c, 6, -14, 0, -14);
  },
  anchor(c) {
    line(c, -34, 34, 30, -22);
    c.beginPath();
    c.moveTo(-40, 40);
    c.lineTo(-24, 40);
    c.lineTo(-40, 24);
    c.closePath();
    c.stroke();
    circle(c, 30, -22, 5, true);
  },
  dip(c) {
    line(c, 0, -28, 0, 24);
    line(c, -12, -28, 12, -28);
    circle(c, 0, 28, 5, true);
  },
  switch(c) {
    circle(c, -20, 0, 5, true);
    circle(c, 20, 0, 5, true);
    line(c, -20, 0, 14, -22);
  },
  fuse(c) {
    c.strokeRect(-20, -9, 40, 18);
    line(c, -34, 0, 34, 0);
  },
  cap(c) {
    line(c, -6, -20, -6, 20);
    line(c, 6, -20, 6, 20);
    line(c, -34, 0, -6, 0);
    line(c, 6, 0, 34, 0);
  },
  meter(c) {
    circle(c, 0, 0, 22);
    c.font = '700 26px ' + FONT;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('M', 0, 2);
  },
  north(c) {
    c.beginPath();
    c.moveTo(0, -34);
    c.lineTo(14, 8);
    c.lineTo(0, 0);
    c.lineTo(-14, 8);
    c.closePath();
    c.fill();
  },
};

export function drawItem(context, item) {
  if (item.t === 'text') {
    context.save();
    context.font = '600 ' + item.s + 'px ' + FONT;
    item.w = context.measureText(item.text).width;
    context.restore();
    haloText(context, item.text, item.x, item.y, item.s, item.c, 'left');
    return;
  }
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.strokeStyle = item.c;
  context.fillStyle = item.c;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (item.t === 'line') {
    context.lineWidth = item.w;
    line(context, item.a[0], item.a[1], item.b[0], item.b[1]);
  } else if (item.t === 'pen') {
    context.lineWidth = item.w;
    const points = item.p;
    if (points.length === 1) {
      circle(context, points[0][0], points[0][1], item.w / 2, true);
    } else {
      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      // Each point is joined through the middle of the next gap, which rounds off the corners.
      for (let i = 1; i < points.length - 1; i += 1) {
        context.quadraticCurveTo(points[i][0], points[i][1], (points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2);
      }
      const last = points[points.length - 1];
      context.lineTo(last[0], last[1]);
      context.stroke();
    }
  } else if (item.t === 'sym') {
    context.translate(item.x, item.y);
    context.save();
    context.rotate((item.r || 0) * RAD);
    context.scale(item.s, item.s);
    context.lineWidth = 3.5;
    const shape = SHAPES[item.k];
    if (shape) shape(context);
    context.restore();
    context.restore();
    if (item.text) haloText(context, item.text, item.x, item.y + capOf(item), item.s * 14, item.c, 'center');
    return;
  }
  context.restore();
}

/** Draws the whole sketch: every item, in order. */
export function drawItems(context, items) {
  for (const item of items) drawItem(context, item);
}

/** The marks that show which item is picked up and where it can be grabbed. Never part of a saved picture. */
export function drawPick(context, item, unit) {
  context.save();
  context.setLineDash([unit * 2, unit * 1.5]);
  context.lineWidth = Math.max(2, unit * 0.5);
  context.strokeStyle = '#1D8FFF';
  if (item.t === 'line') {
    line(context, item.a[0], item.a[1], item.b[0], item.b[1]);
  } else {
    const b = bounds(item);
    context.strokeRect(b.left - unit, b.top - unit, b.right - b.left + unit * 2, b.bottom - b.top + unit * 2);
  }
  context.setLineDash([]);
  for (const h of handles(item)) {
    context.fillStyle = '#FFFFFF';
    context.strokeStyle = '#1D8FFF';
    context.lineWidth = Math.max(2.5, unit * 0.7);
    circle(context, h.x, h.y, unit * 2.6, true);
    circle(context, h.x, h.y, unit * 2.6, false);
  }
  context.restore();
}

/** The box round an item. */
export function bounds(item) {
  if (item.t === 'line') return { left: Math.min(item.a[0], item.b[0]), right: Math.max(item.a[0], item.b[0]), top: Math.min(item.a[1], item.b[1]), bottom: Math.max(item.a[1], item.b[1]) };
  if (item.t === 'pen') {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const q of item.p) {
      left = Math.min(left, q[0]);
      right = Math.max(right, q[0]);
      top = Math.min(top, q[1]);
      bottom = Math.max(bottom, q[1]);
    }
    return { left, right, top, bottom };
  }
  if (item.t === 'text') return { left: item.x, right: item.x + textWidth(item), top: item.y - item.s * 0.7, bottom: item.y + item.s * 0.7 };
  const r = reachOf(item);
  const box = { left: item.x - r, right: item.x + r, top: item.y - r, bottom: item.y + r };
  if (item.text) {
    const cap = captionBox(item);
    box.left = Math.min(box.left, cap.left);
    box.right = Math.max(box.right, cap.right);
    box.bottom = Math.max(box.bottom, cap.bottom);
  }
  return box;
}
