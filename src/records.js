// The shape of the things the app stores (jobs, poles, photos, settings) and the rules that keep
// them clean. Everything read from storage, from a journal or from a backup file passes through
// these cleaners, so a damaged or hand-edited file cannot put odd values into the app.

import { DEFAULT_TOKENS, MAX_TEXT } from './config.js';

export { isBlankValue } from './template-engine.js';

/** A new unique id. */
export function uid() {
  const c = typeof crypto !== 'undefined' ? crypto : null;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

/** Today's date on this phone, as 2026-10-04. */
export function today(now) {
  const d = now instanceof Date ? now : new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY_SHAPE = /^[a-zA-Z][a-zA-Z0-9]{0,59}$/;
const MAX_KEYS = 500;

// Characters that have no place in text: control characters (apart from tab and line breaks),
// half of a two-part character, and the two "non-characters" that some file formats cannot hold.
// eslint-disable-next-line no-control-regex
const SUSPECT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff￾￿]/;

function keepCharacter(ch) {
  const c = ch.codePointAt(0);
  if (c < 0x20) return c === 0x09 || c === 0x0a || c === 0x0d;
  if (c === 0x7f || c === 0xfffe || c === 0xffff) return false;
  // A whole pair reads as one character above 0xFFFF. A lone half reads as itself.
  return c < 0xd800 || c > 0xdfff;
}

/** Text with the unusable characters removed, cut to at most max characters without splitting one. */
export function cleanText(value, max) {
  if (value == null) return '';
  let text = String(value);
  if (SUSPECT.test(text)) {
    let out = '';
    for (const ch of text) if (keepCharacter(ch)) out += ch;
    text = out;
  }
  return cutText(text, max || MAX_TEXT);
}

/** The first max code units of text, never ending on half of a two-part character. */
export function cutText(text, max) {
  const value = String(text);
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Keeps only plain answers: text, and true for switched-on toggles. */
export function cleanFields(fields) {
  const out = {};
  if (!isPlainObject(fields)) return out;
  let count = 0;
  for (const key of Object.keys(fields)) {
    if (FORBIDDEN_KEYS.has(key) || !KEY_SHAPE.test(key)) continue;
    const value = fields[key];
    if (typeof value === 'string') {
      const text = cleanText(value);
      if (text === '') continue;
      out[key] = text;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      out[key] = String(value);
    } else if (value === true) {
      out[key] = true;
    } else {
      continue;
    }
    count += 1;
    if (count >= MAX_KEYS) break;
  }
  return out;
}

// Ids are made by the app (random UUIDs, or "id-<time>-<hex>" from the first version). Keeping
// them to plain letters, digits and - _ . means an id is always safe in a file name, a web address
// and a ZIP entry.
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function cleanId(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) value = String(Math.floor(value));
  if (typeof value !== 'string' || !ID_SHAPE.test(value)) return '';
  return value;
}

const LAST_TIME = 8.64e15; // the last moment a date can hold

/**
 * A stored time, in milliseconds.
 * fallback: used when the value is missing or not a time.
 * cap: the latest time accepted. Records from this phone are not capped: a phone whose clock
 * was fast and is then put right must keep the order its records were made in. Records from a
 * file are capped, so a file with a far-future time cannot outrank every later change.
 */
export function cleanTime(value, fallback, cap) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > LAST_TIME) return fallback == null ? 0 : fallback;
  const time = Math.floor(value);
  return cap == null ? time : Math.min(time, cap);
}

export function cleanGps(gps, cap) {
  if (!isPlainObject(gps)) return null;
  const { lat, lon } = gps;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const acc = typeof gps.acc === 'number' && Number.isFinite(gps.acc) && gps.acc >= 0 ? gps.acc : null;
  return { lat, lon, acc, at: cleanTime(gps.at, 0, cap) };
}

function withDeleted(out, source, cap) {
  const deletedAt = cleanTime(source.deletedAt, 0, cap);
  if (deletedAt > 0) out.deletedAt = deletedAt;
  return out;
}

/** now: used for a missing creation time. cap: see cleanTime. */
export function cleanJob(job, now, cap) {
  if (!isPlainObject(job)) return null;
  const id = cleanId(job.id);
  if (!id) return null;
  const t = now == null ? Date.now() : now;
  const createdAt = cleanTime(job.createdAt, Math.min(t, cap == null ? t : cap), cap);
  const out = {
    id,
    f: cleanFields(job.f),
    createdAt,
    updatedAt: cleanTime(job.updatedAt, createdAt, cap),
    exportedAt: cleanTime(job.exportedAt, 0, cap),
  };
  return withDeleted(out, job, cap);
}

export function cleanPole(pole, now, cap) {
  if (!isPlainObject(pole)) return null;
  const id = cleanId(pole.id);
  const jobId = cleanId(pole.jobId);
  if (!id || !jobId) return null;
  const t = now == null ? Date.now() : now;
  const createdAt = cleanTime(pole.createdAt, Math.min(t, cap == null ? t : cap), cap);
  const out = {
    id,
    jobId,
    f: cleanFields(pole.f),
    gps: cleanGps(pole.gps, cap),
    done: pole.done === true,
    createdAt,
    updatedAt: cleanTime(pole.updatedAt, createdAt, cap),
  };
  return withDeleted(out, pole, cap);
}

const cleanSize = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100000 ? Math.round(value) : 0);

export function cleanPhoto(photo, now, cap) {
  if (!isPlainObject(photo)) return null;
  const id = cleanId(photo.id);
  const poleId = cleanId(photo.poleId);
  const jobId = cleanId(photo.jobId);
  if (!id || !poleId || !jobId) return null;
  const t = now == null ? Date.now() : now;
  const createdAt = cleanTime(photo.createdAt, Math.min(t, cap == null ? t : cap), cap);
  const out = {
    id,
    poleId,
    jobId,
    label: cleanText(photo.label, 60).replace(/\s+/g, ' ').trim(),
    w: cleanSize(photo.w),
    h: cleanSize(photo.h),
    bytes: typeof photo.bytes === 'number' && Number.isFinite(photo.bytes) && photo.bytes > 0 ? Math.round(photo.bytes) : 0,
    createdAt,
    updatedAt: cleanTime(photo.updatedAt, createdAt, cap),
  };
  return withDeleted(out, photo, cap);
}

export function defaultSettings() {
  // legacyChecked: the first version's jobs have been copied over. legacyPhotosLeft: some of its
  // photos are still to be copied.
  return { collectedBy: '', tokens: { ...DEFAULT_TOKENS }, lastBackupAt: 0, legacyChecked: false, legacyPhotosLeft: false };
}

const cleanName = (value, fallback) => {
  const text = cleanText(value, 40).replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  return text || fallback;
};

export function cleanSettings(settings, cap) {
  const out = defaultSettings();
  if (!isPlainObject(settings)) return out;
  out.collectedBy = cleanText(settings.collectedBy, 80).replace(/\s+/g, ' ').trim();
  if (isPlainObject(settings.tokens)) {
    out.tokens.power = cleanName(settings.tokens.power, DEFAULT_TOKENS.power);
    out.tokens.telecom = cleanName(settings.tokens.telecom, DEFAULT_TOKENS.telecom);
  }
  out.lastBackupAt = cleanTime(settings.lastBackupAt, 0, cap);
  out.legacyChecked = settings.legacyChecked === true;
  out.legacyPhotosLeft = settings.legacyPhotosLeft === true;
  return out;
}

// Windows will not create a file whose name, before the first dot, is one of these.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
const MAX_NAME_BYTES = 120;
const encoder = new TextEncoder();

/**
 * Turns any text into a file name that every phone and computer accepts.
 * Letters and digits of any language are kept, along with - _ . & # +
 * The result is at most 120 bytes, so an ending such as ".pdf" always fits.
 * fallback is used when nothing usable is left. It defaults to "file", and may be "".
 */
export function safeFileName(text, fallback) {
  const tidy = (value) => value.replace(/_+/g, '_').replace(/\.{2,}/g, '.').replace(/^[_.\-]+|[_.\-]+$/g, '');
  let name = tidy(
    cleanText(text == null ? '' : String(text))
      .normalize('NFC')
      .replace(/[^\p{L}\p{M}\p{N}\-_.&#+]+/gu, '_'),
  );
  let cut = '';
  let bytes = 0;
  for (const ch of name) {
    const size = encoder.encode(ch).length;
    if (bytes + size > MAX_NAME_BYTES) break;
    cut += ch;
    bytes += size;
  }
  name = tidy(cut);
  if (name === '') name = fallback === undefined || fallback === null ? 'file' : String(fallback);
  if (WINDOWS_RESERVED.test(name)) name = '_' + name;
  return name;
}
