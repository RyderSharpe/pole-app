// Everything the app knows, held in memory and kept in step with the on-phone database.
//
// The screens read from here and change things through here. They never touch the database.
//
// How saving works:
//   1. A change is made in memory at once, so the screen never waits.
//   2. The changed record is queued. A moment later (0.3 s) every queued record is written to the
//      database in one all-or-nothing step.
//   3. If the phone refuses, the records stay queued, a copy goes into a small "journal" that
//      survives a crash, and the app tries again every few seconds.
//   4. When the app is put in the background the journal is written first, because that is the
//      one kind of save that finishes before the phone can freeze the app.
//   5. The next time the app starts, anything in a journal that is newer than the database is
//      put back.

import * as db from './db.js';
import { TEMPLATE } from './template.js';
import { hasAnyValue } from './template-engine.js';
import { cleanJob, cleanPole, cleanPhoto, cleanSettings, cleanGps, cleanSpans, cleanText, defaultSettings, uid, today } from './records.js';
import { convertV1Job, convertV1Photo, findV1PhotoOwners } from './migrate.js';
import { TRASH_DAYS, PHOTO_SIZES, SAVE_DELAY_MS, SAVE_RETRY_MS, STORAGE_PREFIX, LOW_SPACE_RATIO, DEFAULT_TOKENS } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const jobs = new Map();
const poles = new Map();
const photos = new Map();
let settingsValue = defaultSettings();

const dirty = { jobs: new Set(), poles: new Set(), photos: new Set(), settings: false };
const purging = new Set();
let inFlight = null;
let status = 'saved';
let lastError = null;
let timer = null;
let draining = null;
let retired = false;
let spaceLow = false;
let journalKeysToClear = [];
const working = new Set();

const tabId = uid();
const JOURNAL_PREFIX = STORAGE_PREFIX + 'journal.';
const journalKey = JOURNAL_PREFIX + tabId;

// ---------------------------------------------------------------------------------------------
// Events

const subscribers = { change: new Set(), status: new Set(), retired: new Set() };

/** subscribe('change' | 'status' | 'retired', fn). Returns a function that stops listening. */
export function subscribe(name, fn) {
  subscribers[name].add(fn);
  return () => subscribers[name].delete(fn);
}

function emit(name, detail) {
  for (const fn of [...subscribers[name]]) {
    try {
      fn(detail || {});
    } catch (e) {
      console.error(e);
    }
  }
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  emit('status', { status });
}

/** 'saved', 'saving' or 'error'. */
export const saveStatus = () => status;
export const saveError = () => lastError;
export const isRetired = () => retired;

// ---------------------------------------------------------------------------------------------
// The journal (pure parts first, so they can be tested without a browser)

/**
 * Builds the journal: a copy of every record that has not reached the database yet.
 * ids: { jobs: [id], poles: [id], photos: [id], settings: boolean }
 * read: { job(id), pole(id), photo(id), settings() }
 * Returns null when there is nothing to keep.
 */
export function planJournal(ids, read, now) {
  const pick = (list, get) => (list || []).map(get).filter(Boolean);
  const out = {
    v: 1,
    at: now,
    jobs: pick(ids.jobs, read.job),
    poles: pick(ids.poles, read.pole),
    photos: pick(ids.photos, read.photo),
    settings: ids.settings ? read.settings() : null,
  };
  if (!out.jobs.length && !out.poles.length && !out.photos.length && !out.settings) return null;
  return out;
}

/**
 * Decides which journal records to put back.
 * A job or pole is put back when the phone has no copy, or an older one.
 * A photo is only ever updated, never created, because the journal holds no pictures.
 * local: { jobs: Map, poles: Map, photos: Map }
 */
export function planReplay(journal, local, now) {
  const out = { jobs: [], poles: [], photos: [], settings: null };
  if (!journal || typeof journal !== 'object' || journal.v !== 1) return out;
  const newer = (map, record) => {
    const mine = map.get(record.id);
    return !mine || (mine.updatedAt || 0) < record.updatedAt;
  };
  for (const raw of Array.isArray(journal.jobs) ? journal.jobs : []) {
    const job = cleanJob(raw, now);
    if (!job) continue;
    const mine = local.jobs.get(job.id);
    if (newer(local.jobs, job)) out.jobs.push(job);
    // The same job, but the journal knows it was exported since (the mark could not be saved).
    else if (mine && mine.updatedAt === job.updatedAt && job.exportedAt > (mine.exportedAt || 0)) out.jobs.push({ ...mine, exportedAt: job.exportedAt });
  }
  for (const raw of Array.isArray(journal.poles) ? journal.poles : []) {
    const pole = cleanPole(raw, now);
    if (pole && newer(local.poles, pole)) out.poles.push(pole);
  }
  for (const raw of Array.isArray(journal.photos) ? journal.photos : []) {
    const photo = cleanPhoto(raw, now);
    if (photo && local.photos.has(photo.id) && newer(local.photos, photo)) out.photos.push(photo);
  }
  if (journal.settings && typeof journal.settings === 'object') out.settings = cleanSettings(journal.settings);
  return out;
}

function unsavedIds() {
  const merge = (name) => [...new Set([...(inFlight ? inFlight[name] : []), ...dirty[name]])];
  return { jobs: merge('jobs'), poles: merge('poles'), photos: merge('photos'), settings: dirty.settings || Boolean(inFlight && inFlight.settings) };
}

function writeJournal() {
  try {
    const plan = planJournal(unsavedIds(), { job: (id) => jobs.get(id), pole: (id) => poles.get(id), photo: (id) => photos.get(id), settings: () => settingsValue }, Date.now());
    if (plan) localStorage.setItem(journalKey, JSON.stringify(plan));
    else localStorage.removeItem(journalKey);
  } catch (e) {
    /* The journal is a second line of defence. If it cannot be written, the retry timer still runs. */
    return;
  }
  // This tab's journal now holds everything not yet saved, including whatever was taken from
  // other tabs' journals. Those are no longer needed, and keeping them could bring back
  // something removed since.
  try {
    for (const key of journalKeysToClear) localStorage.removeItem(key);
    journalKeysToClear = [];
  } catch (e) {
    /* they are cleared after the next save instead */
  }
}

// Nothing is waiting any more: the journals go, and the status says so.
function settleSaved() {
  if (retired) return;
  clearJournals();
  lastError = null;
  setStatus('saved');
}

function clearJournals() {
  try {
    localStorage.removeItem(journalKey);
    for (const key of journalKeysToClear) localStorage.removeItem(key);
  } catch (e) {
    /* nothing to clear */
  }
  journalKeysToClear = [];
}

function readJournals() {
  const found = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(JOURNAL_PREFIX) || key === journalKey) continue;
      try {
        found.push({ key, journal: JSON.parse(localStorage.getItem(key)) });
      } catch (e) {
        found.push({ key, journal: null });
      }
    }
  } catch (e) {
    /* storage is not available */
  }
  return found;
}

/**
 * Takes in anything in the database that is newer than what this tab holds. Called when a tab
 * that stepped aside announces itself: it may have saved an entry or a photo after this tab
 * loaded (for example when the phone froze it half way through storing a photo).
 * Returns how many records came in.
 */
export async function takeNewerFromDb() {
  if (retired) return 0;
  const [jobRows, poleRows, photoRows] = await db.tx(['jobs', 'poles', 'photos'], 'readonly', (s) => [s.jobs.getAll(), s.poles.getAll(), s.photos.getAll()]);
  const now = Date.now();
  let count = 0;
  const adopt = (map, record) => {
    if (!record || purging.has(record.id)) return;
    const mine = map.get(record.id);
    if (mine && (mine.updatedAt || 0) >= record.updatedAt) return;
    map.set(record.id, record);
    count += 1;
  };
  for (const raw of jobRows) adopt(jobs, cleanJob(raw, now));
  for (const raw of poleRows) adopt(poles, cleanPole(raw, now));
  for (const raw of photoRows) adopt(photos, cleanPhoto(raw, now));
  if (count) emit('change', { kind: 'replay' });
  return count;
}

/** Puts back anything a journal holds that is newer than what is loaded. Returns how many records came back. */
export function replayJournals() {
  let count = 0;
  const now = Date.now();
  for (const { key, journal } of readJournals()) {
    const plan = planReplay(journal, { jobs, poles, photos }, now);
    for (const job of plan.jobs) {
      jobs.set(job.id, job);
      dirty.jobs.add(job.id);
    }
    for (const pole of plan.poles) {
      poles.set(pole.id, pole);
      dirty.poles.add(pole.id);
    }
    for (const photo of plan.photos) {
      photos.set(photo.id, photo);
      dirty.photos.add(photo.id);
    }
    if (plan.settings) {
      // Copying from the first version is never undone by an older journal. A spare second
      // attempt at its photos costs nothing, so either side asking for one is enough.
      settingsValue = {
        ...plan.settings,
        legacyChecked: settingsValue.legacyChecked || plan.settings.legacyChecked,
        legacyPhotosLeft: settingsValue.legacyPhotosLeft || plan.settings.legacyPhotosLeft,
      };
      dirty.settings = true;
    }
    count += plan.jobs.length + plan.poles.length + plan.photos.length;
    journalKeysToClear.push(key);
  }
  if (count || dirty.settings) {
    schedule(0);
    emit('change', { kind: 'replay' });
  } else if (journalKeysToClear.length && !hasDirty() && !inFlight) {
    clearJournals();
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// The save queue

function hasDirty() {
  return dirty.jobs.size > 0 || dirty.poles.size > 0 || dirty.photos.size > 0 || dirty.settings;
}

function schedule(ms) {
  if (retired) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flush().catch(() => {});
  }, ms);
}

function queue(kind, id) {
  if (kind === 'settings') dirty.settings = true;
  else dirty[kind].add(id);
  if (status !== 'error') setStatus('saving');
  else writeJournal(); // saves are failing, so keep the crash-proof copy up to date
  schedule(SAVE_DELAY_MS);
}

function takeBatch() {
  const batch = { jobs: [...dirty.jobs], poles: [...dirty.poles], photos: [...dirty.photos], settings: dirty.settings };
  dirty.jobs.clear();
  dirty.poles.clear();
  dirty.photos.clear();
  dirty.settings = false;
  return batch;
}

function requeue(batch) {
  for (const id of batch.jobs) if (jobs.has(id) && !purging.has(id)) dirty.jobs.add(id);
  for (const id of batch.poles) if (poles.has(id) && !purging.has(id)) dirty.poles.add(id);
  for (const id of batch.photos) if (photos.has(id) && !purging.has(id)) dirty.photos.add(id);
  if (batch.settings) dirty.settings = true;
}

// Writes one batch. A record is never written over a newer copy that is already in the database.
// That can only happen when another tab took over and saved while this one was frozen; this tab's
// copy is then out of date. Resolves with the ids that were held back for that reason.
function writeBatch(batch) {
  const stale = [];
  const guard = (store, map, id) => {
    if (!map.has(id) || purging.has(id)) return;
    const request = store.get(id);
    request.onsuccess = () => {
      // The record is read here, at the moment of writing, so the newest values are stored.
      const record = map.get(id);
      if (!record || purging.has(id)) return;
      const there = request.result;
      if (there && (there.updatedAt || 0) > (record.updatedAt || 0)) stale.push(id);
      else store.put(record);
    };
  };
  return db
    .tx(
      ['jobs', 'poles', 'photos', 'meta'],
      'readwrite',
      (s) => {
        for (const id of batch.jobs) guard(s.jobs, jobs, id);
        for (const id of batch.poles) guard(s.poles, poles, id);
        for (const id of batch.photos) guard(s.photos, photos, id);
        if (batch.settings) s.meta.put({ key: 'settings', value: settingsValue });
      },
      { chained: true },
    )
    .then(() => stale);
}

async function drain() {
  while (hasDirty()) {
    if (retired) throw new Error('The app has moved to another tab.');
    clearTimeout(timer);
    timer = null;
    inFlight = takeBatch();
    let stale;
    try {
      stale = await writeBatch(inFlight);
    } catch (error) {
      requeue(inFlight);
      inFlight = null;
      lastError = error;
      writeJournal();
      setStatus('error');
      if (!retired) schedule(SAVE_RETRY_MS);
      throw error;
    }
    inFlight = null;
    lastError = null;
    if (stale.length) {
      // Another tab has saved newer copies. Everything else in the batch was saved; this tab
      // stops here so it cannot write anything else that is out of date.
      retire('stale');
      throw new Error('Newer entries were saved in another tab.');
    }
  }
  clearJournals();
  setStatus('saved');
}

/**
 * Writes every queued change. Resolves once nothing is waiting and nothing is half-written.
 * Rejects if the phone refused. The changes then stay queued and are tried again.
 */
export async function flush() {
  for (;;) {
    if (!draining) {
      if (!hasDirty()) {
        // For example, everything that failed to save has since been removed for good.
        if (status !== 'saved') settleSaved();
        return;
      }
      draining = drain().finally(() => {
        draining = null;
      });
    }
    await draining;
    if (!draining && !hasDirty()) return;
  }
}

/** Called when the app is being hidden or closed. The journal is written first, because it cannot be interrupted. */
export function saveBeforeLeaving() {
  if (hasDirty() || inFlight) writeJournal();
  return flush().catch(() => {});
}

export const hasUnsavedChanges = () => hasDirty() || inFlight !== null;

/**
 * Stops this tab from writing. reason: 'moved' (another tab took over) or 'stale' (another tab
 * saved newer copies of records this tab still holds).
 */
export function retire(reason) {
  if (retired) return;
  if (hasDirty() || inFlight) writeJournal();
  retired = true;
  clearTimeout(timer);
  timer = null;
  emit('status', { status });
  emit('retired', { reason: reason || 'moved' });
}

// ---------------------------------------------------------------------------------------------
// Work that is still going on (photos being shrunk and stored)

/** Remembers a piece of unfinished work, so an export can wait for it. */
export function track(promise) {
  working.add(promise);
  const done = () => working.delete(promise);
  promise.then(done, done);
  return promise;
}

export const pendingWork = () => working.size;

/**
 * Resolves once no photo is being shrunk or stored. maxMs (optional) stops the wait early, so a
 * picture that never finishes cannot hold up an update or a move to another tab for ever.
 */
export async function whenIdle(maxMs) {
  const waiting = (async () => {
    while (working.size) await Promise.allSettled([...working]);
  })();
  if (!maxMs) return waiting;
  let timer;
  await Promise.race([waiting, new Promise((resolve) => {
    timer = setTimeout(resolve, maxMs);
  })]);
  clearTimeout(timer);
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Reading

// A record counts as gone from the moment its removal starts, so it never flashes back on screen.
const live = (record) => Boolean(record) && !record.deletedAt && !purging.has(record.id);
const byNewest = (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1);
const byCreated = (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function listJobs() {
  return [...jobs.values()].filter(live).sort(byNewest);
}

export function getJob(id) {
  const job = jobs.get(id);
  return live(job) ? job : null;
}

export function listPoles(jobId) {
  return [...poles.values()].filter((pole) => pole.jobId === jobId && live(pole)).sort(byCreated);
}

export const hasAnyPole = (jobId) => [...poles.values()].some((pole) => pole.jobId === jobId && live(pole));

export function getPole(id) {
  const pole = poles.get(id);
  return live(pole) && getJob(pole.jobId) ? pole : null;
}

export function poleNumber(pole) {
  return listPoles(pole.jobId).findIndex((p) => p.id === pole.id) + 1;
}

export function listPhotos(poleId) {
  return [...photos.values()].filter((photo) => photo.poleId === poleId && live(photo)).sort(byCreated);
}

export function getPhoto(id) {
  const photo = photos.get(id);
  return live(photo) ? photo : null;
}

export const photoCount = (poleId) => listPhotos(poleId).length;

/**
 * True when a pole has never held anything, not even a photo that is now in Recently deleted.
 * Only such a pole may be removed when it is left, because nothing on it can be wanted later.
 */
export function poleNeverUsed(pole) {
  if (pole.done || pole.gps || (pole.spans && pole.spans.length) || hasAnyValue(TEMPLATE, pole.f)) return false;
  for (const photo of photos.values()) if (photo.poleId === pole.id) return false;
  return true;
}

/** True when a job has no poles at all, not even ones in Recently deleted. */
export function jobHasNoPoles(jobId) {
  for (const pole of poles.values()) if (pole.jobId === jobId) return false;
  return true;
}

/** True once a pole holds anything at all. */
export function poleStarted(pole) {
  return pole.done === true || Boolean(pole.gps) || Boolean(pole.spans && pole.spans.length) || hasAnyValue(TEMPLATE, pole.f) || photoCount(pole.id) > 0;
}

/** True when the job's poles have all been untouched since the last confirmed export. */
export function jobExported(job) {
  return job.exportedAt > 0 && job.exportedAt >= job.updatedAt;
}

/** { key: 'new' | 'wait' | 'done', text } */
export function jobStatus(job) {
  if (!listPoles(job.id).some(poleStarted)) return { key: 'new', text: 'Not started' };
  if (jobExported(job)) return { key: 'done', text: 'Exported' };
  return { key: 'wait', text: job.exportedAt > 0 ? 'Changed since export' : 'Waiting to export' };
}

/** How many started poles sit in jobs that have not been exported. */
export function waitingPoleCount() {
  let count = 0;
  for (const job of listJobs()) {
    if (!jobExported(job)) count += listPoles(job.id).filter(poleStarted).length;
  }
  return count;
}

const normal = (value) => String(value).trim().toLowerCase();

/** True when another pole in the same job has the same answer under this key. */
export function valueUsedElsewhere(pole, key, value) {
  const wanted = normal(value);
  if (wanted === '') return false;
  return listPoles(pole.jobId).some((other) => other.id !== pole.id && other.f[key] != null && normal(other.f[key]) === wanted);
}

/** Deleted things that can still be brought back. */
export function trash() {
  const now = Date.now();
  const daysLeft = (record) => Math.min(TRASH_DAYS, Math.max(0, Math.ceil((record.deletedAt + TRASH_DAYS * DAY_MS - now) / DAY_MS)));
  const newestFirst = (a, b) => b.deletedAt - a.deletedAt;
  const out = { jobs: [], poles: [], photos: [] };
  for (const job of jobs.values()) {
    if (job.deletedAt) out.jobs.push({ job, daysLeft: daysLeft(job), poleCount: [...poles.values()].filter((p) => p.jobId === job.id && live(p)).length });
  }
  for (const pole of poles.values()) {
    const job = jobs.get(pole.jobId);
    if (pole.deletedAt && live(job)) out.poles.push({ pole, job, daysLeft: daysLeft(pole) });
  }
  for (const photo of photos.values()) {
    const pole = poles.get(photo.poleId);
    const job = pole && jobs.get(pole.jobId);
    if (photo.deletedAt && live(pole) && live(job)) out.photos.push({ photo, pole, job, daysLeft: daysLeft(photo) });
  }
  out.jobs.sort((a, b) => newestFirst(a.job, b.job));
  out.poles.sort((a, b) => newestFirst(a.pole, b.pole));
  out.photos.sort((a, b) => newestFirst(a.photo, b.photo));
  return out;
}

export function trashCount() {
  const t = trash();
  return t.jobs.length + t.poles.length + t.photos.length;
}

export function counts() {
  let jobCount = 0;
  let poleCount = 0;
  let photoTotal = 0;
  for (const job of jobs.values()) if (live(job)) jobCount += 1;
  for (const pole of poles.values()) if (getPole(pole.id)) poleCount += 1;
  for (const photo of photos.values()) if (live(photo) && getPole(photo.poleId)) photoTotal += 1;
  return { jobs: jobCount, poles: poleCount, photos: photoTotal };
}

const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * A frozen copy of the chosen jobs for an export.
 * seenAt records how each job looked at this moment. A job is only marked "exported" up to that
 * point, so anything changed while the file was being built still counts as waiting.
 */
export function snapshot(jobIds) {
  const out = { jobs: [], seenAt: {} };
  for (const id of jobIds) {
    const job = getJob(id);
    if (!job) continue;
    const started = listPoles(id).filter(poleStarted);
    if (!started.length) continue;
    out.seenAt[id] = job.updatedAt;
    out.jobs.push({
      job: copy(job),
      poles: started.map((pole) => ({ pole: copy(pole), number: poleNumber(pole), photos: listPhotos(pole.id).map(copy) })),
    });
  }
  return out;
}

/** Every record, deleted ones included. Used for backups. */
export function everything() {
  return {
    jobs: [...jobs.values()].map(copy),
    poles: [...poles.values()].map(copy),
    photos: [...photos.values()].map(copy),
    settings: copy(settingsValue),
  };
}

/** The records as they are held now. Read-only: used to compare with a backup file. */
export const held = () => ({ jobs, poles, photos });

/** The newest change time across everything, used to tell whether a backup is still current. */
export function latestChange() {
  let latest = 0;
  for (const map of [jobs, poles, photos]) for (const record of map.values()) latest = Math.max(latest, record.updatedAt || 0);
  return latest;
}

// ---------------------------------------------------------------------------------------------
// Settings

export const settings = () => settingsValue;
export const tokens = () => settingsValue.tokens;

/** quiet: true while the user is typing, so the screen is not redrawn under the keyboard. */
export function setSetting(key, value, quiet) {
  if (key === 'collectedBy') settingsValue.collectedBy = cleanText(value, 80).replace(/\s+/g, ' ').trim();
  else if (key === 'lastBackupAt') settingsValue.lastBackupAt = Number(value) || 0;
  else return;
  queue('settings');
  emit('change', { kind: 'settings', quiet: Boolean(quiet) });
}

export function setToken(name, value, quiet) {
  if (!(name in DEFAULT_TOKENS)) return;
  const text = cleanText(value, 40).replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  settingsValue.tokens[name] = text || DEFAULT_TOKENS[name];
  queue('settings');
  emit('change', { kind: 'settings', quiet: Boolean(quiet) });
}

/** A pole even if it has been deleted. Used to find the way back to its job. */
export const findPole = (id) => poles.get(id) || null;

// ---------------------------------------------------------------------------------------------
// Changing things

// A time for "last changed" that always moves forward, even if the phone's clock was set back.
const stamp = (record, now) => Math.max(now, (record.updatedAt || 0) + 1, (record.exportedAt || 0) + 1);

function touchJob(job, now) {
  job.updatedAt = stamp(job, now);
  queue('jobs', job.id);
}

function touchPole(pole, now) {
  pole.updatedAt = stamp(pole, now);
  queue('poles', pole.id);
  const job = jobs.get(pole.jobId);
  if (job) touchJob(job, now);
}

const fieldValue = (value) => {
  if (value === true) return true;
  if (typeof value !== 'string') return undefined;
  const text = cleanText(value);
  return text === '' ? undefined : text;
};

function setField(record, key, value) {
  const next = fieldValue(value);
  if (next === undefined) {
    if (!(key in record.f)) return false;
    delete record.f[key];
    return true;
  }
  if (record.f[key] === next) return false;
  record.f[key] = next;
  return true;
}

export function createJob() {
  const now = Date.now();
  const f = { date: today() };
  if (settingsValue.collectedBy) f.collectedBy = settingsValue.collectedBy;
  const job = { id: uid(), f, createdAt: now, updatedAt: now, exportedAt: 0 };
  jobs.set(job.id, job);
  queue('jobs', job.id);
  emit('change', { kind: 'job', id: job.id });
  return job;
}

export function setJobField(jobId, key, value) {
  const job = getJob(jobId);
  if (!job || !setField(job, key, value)) return;
  touchJob(job, Date.now());
  emit('change', { kind: 'job', id: jobId, quiet: true });
}

export function deleteJob(jobId) {
  const job = getJob(jobId);
  if (!job) return;
  const now = Date.now();
  job.deletedAt = now;
  touchJob(job, now);
  emit('change', { kind: 'job', id: jobId });
}

export function restoreJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.deletedAt) return;
  delete job.deletedAt;
  touchJob(job, Date.now());
  emit('change', { kind: 'job', id: jobId });
}

/** Records that a file holding this job, as it looked at seenAt, has left the phone. */
export function markExported(jobId, seenAt) {
  const job = jobs.get(jobId);
  if (!job || !(seenAt > 0)) return;
  if (seenAt <= job.exportedAt) return;
  job.exportedAt = Math.min(seenAt, job.updatedAt);
  queue('jobs', jobId);
  emit('change', { kind: 'job', id: jobId });
}

export function createPole(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  const now = Date.now();
  const others = listPoles(jobId);
  const last = others.length ? others[others.length - 1].createdAt : 0;
  const createdAt = Math.max(now, last + 1);
  const pole = { id: uid(), jobId, f: {}, gps: null, spans: [], done: false, createdAt, updatedAt: createdAt };
  poles.set(pole.id, pole);
  queue('poles', pole.id);
  emit('change', { kind: 'pole', id: pole.id });
  return pole;
}

export function setPoleField(poleId, key, value) {
  const pole = getPole(poleId);
  if (!pole || !setField(pole, key, value)) return;
  touchPole(pole, Date.now());
  emit('change', { kind: 'pole', id: poleId, quiet: true });
}

export function setPoleDone(poleId, done) {
  const pole = getPole(poleId);
  if (!pole || pole.done === Boolean(done)) return;
  pole.done = Boolean(done);
  touchPole(pole, Date.now());
  emit('change', { kind: 'pole', id: poleId });
}

/** Stores a position on a pole, or clears it with null. Returns false if the pole is gone. */
export function setPoleGps(poleId, gps) {
  const pole = getPole(poleId);
  if (!pole) return false;
  const now = Date.now();
  pole.gps = gps == null ? null : cleanGps(gps, now);
  touchPole(pole, now);
  emit('change', { kind: 'pole', id: poleId });
  return true;
}

/** Stores the spans of a pole's span diagram. quiet: the screen that made the change redraws itself. */
export function setPoleSpans(poleId, spans, quiet) {
  const pole = getPole(poleId);
  if (!pole) return false;
  pole.spans = cleanSpans(spans);
  touchPole(pole, Date.now());
  emit('change', { kind: 'pole', id: poleId, quiet: quiet === true });
  return true;
}

export function deletePole(poleId) {
  const pole = getPole(poleId);
  if (!pole) return;
  const now = Date.now();
  pole.deletedAt = now;
  touchPole(pole, now);
  emit('change', { kind: 'pole', id: poleId });
}

export function restorePole(poleId) {
  const pole = poles.get(poleId);
  if (!pole || !pole.deletedAt) return;
  delete pole.deletedAt;
  touchPole(pole, Date.now());
  emit('change', { kind: 'pole', id: poleId });
}

// ---------------------------------------------------------------------------------------------
// Photos

function writePhoto(photo, renditions) {
  return db.tx(['photos', 'blobs'], 'readwrite', (s) => {
    for (const size of PHOTO_SIZES) {
      if (renditions[size]) s.blobs.put({ key: db.blobKey(photo.id, size), photoId: photo.id, size, type: 'image/jpeg', data: renditions[size] });
    }
    s.photos.put(photo);
  });
}

/**
 * Stores a new photo on a pole. The picture and its details are written together, so a photo
 * can never exist without its picture. Throws if the phone refuses.
 * renditions: { full, mid, thumb (ArrayBuffers), w, h }
 */
export async function addPhoto(poleId, renditions) {
  if (retired) throw new Error('The app has moved to another tab.');
  const pole = getPole(poleId);
  if (!pole) throw new Error('That pole is no longer on this phone.');
  const now = Date.now();
  const others = listPhotos(poleId);
  const last = others.length ? others[others.length - 1].createdAt : 0;
  const createdAt = Math.max(now, last + 1);
  const photo = {
    id: uid(),
    poleId,
    jobId: pole.jobId,
    label: '',
    w: renditions.w || 0,
    h: renditions.h || 0,
    bytes: renditions.full ? renditions.full.byteLength : 0,
    createdAt,
    updatedAt: createdAt,
  };
  await writePhoto(photo, renditions);
  photos.set(photo.id, photo);
  const stillThere = poles.get(poleId);
  if (stillThere) touchPole(stillThere, Date.now());
  emit('change', { kind: 'photo', id: photo.id, poleId });
  checkSpace().catch(() => {});
  return photo;
}

/** Stores a photo that came from a backup file or from the first version of the app. */
export async function putPhoto(photo, renditions) {
  if (retired) throw new Error('The app has moved to another tab.');
  await writePhoto(photo, renditions);
  photos.set(photo.id, photo);
}

export function setPhotoLabel(photoId, label) {
  const photo = getPhoto(photoId);
  if (!photo) return;
  const text = cleanText(label, 60).replace(/\s+/g, ' ').trim();
  if (photo.label === text) return;
  const now = Date.now();
  photo.label = text;
  photo.updatedAt = stamp(photo, now);
  queue('photos', photoId);
  const pole = poles.get(photo.poleId);
  if (pole) touchPole(pole, now);
  emit('change', { kind: 'photo', id: photoId, poleId: photo.poleId });
}

export function deletePhoto(photoId) {
  const photo = getPhoto(photoId);
  if (!photo) return;
  const now = Date.now();
  photo.deletedAt = now;
  photo.updatedAt = stamp(photo, now);
  queue('photos', photoId);
  const pole = poles.get(photo.poleId);
  if (pole) touchPole(pole, now);
  emit('change', { kind: 'photo', id: photoId, poleId: photo.poleId });
}

export function restorePhoto(photoId) {
  const photo = photos.get(photoId);
  if (!photo || !photo.deletedAt) return;
  const now = Date.now();
  delete photo.deletedAt;
  photo.updatedAt = stamp(photo, now);
  queue('photos', photoId);
  const pole = poles.get(photo.poleId);
  if (pole) touchPole(pole, now);
  emit('change', { kind: 'photo', id: photoId, poleId: photo.poleId });
}

/**
 * The bytes of one picture, or null when it cannot be read.
 * If the wanted size is missing, the next best size is used, unless exact is true.
 */
export async function getPhotoBytes(photoId, size, exact) {
  const order = exact ? [size] : [size, ...PHOTO_SIZES.filter((other) => other !== size)];
  for (const candidate of order) {
    let record = null;
    try {
      record = await db.get('blobs', db.blobKey(photoId, candidate));
    } catch (e) {
      record = null;
    }
    if (record && record.data && record.data.byteLength > 0) return { data: record.data, type: record.type || 'image/jpeg', size: candidate };
  }
  return null;
}

export async function getPhotoBlob(photoId, size) {
  const found = await getPhotoBytes(photoId, size);
  return found ? new Blob([found.data], { type: found.type }) : null;
}

// ---------------------------------------------------------------------------------------------
// Bringing in records from a backup file

/** Stores jobs and poles that a restore decided to keep. */
export function applyRecords(records) {
  for (const job of records.jobs || []) {
    jobs.set(job.id, job);
    queue('jobs', job.id);
  }
  for (const pole of records.poles || []) {
    poles.set(pole.id, pole);
    queue('poles', pole.id);
  }
  for (const photo of records.photoDetails || []) {
    if (photos.has(photo.id)) {
      photos.set(photo.id, photo);
      queue('photos', photo.id);
    }
  }
  emit('change', { kind: 'restore' });
}

/** Tells the screens that something changed, so they redraw. */
export function announce(kind) {
  emit('change', { kind: kind || 'data' });
}

/** Fills in settings that are still at their defaults from a backup file. Never overwrites a choice made on this phone. */
export function mergeSettings(incoming) {
  const clean = cleanSettings(incoming, Date.now() + 7 * DAY_MS);
  let changed = false;
  if (!settingsValue.collectedBy && clean.collectedBy) {
    settingsValue.collectedBy = clean.collectedBy;
    changed = true;
  }
  for (const name of Object.keys(DEFAULT_TOKENS)) {
    if (settingsValue.tokens[name] === DEFAULT_TOKENS[name] && clean.tokens[name] !== DEFAULT_TOKENS[name]) {
      settingsValue.tokens[name] = clean.tokens[name];
      changed = true;
    }
  }
  if (changed) {
    queue('settings');
    emit('change', { kind: 'settings' });
  }
}

// ---------------------------------------------------------------------------------------------
// Removing things for good

function expand(ids) {
  const plan = { jobs: new Set(ids.jobs || []), poles: new Set(ids.poles || []), photos: new Set(ids.photos || []) };
  for (const pole of poles.values()) if (plan.jobs.has(pole.jobId)) plan.poles.add(pole.id);
  for (const photo of photos.values()) if (plan.poles.has(photo.poleId)) plan.photos.add(photo.id);
  return plan;
}

/**
 * Removes jobs, poles and photos from the phone for good, along with everything inside them.
 * ids: { jobs: [id], poles: [id], photos: [id] }
 */
export async function purge(ids, quiet) {
  const plan = expand(ids);
  const all = [...plan.jobs, ...plan.poles, ...plan.photos];
  if (!all.length) return;
  const wasDirty = { jobs: [...plan.jobs].filter((id) => dirty.jobs.has(id)), poles: [...plan.poles].filter((id) => dirty.poles.has(id)), photos: [...plan.photos].filter((id) => dirty.photos.has(id)) };
  for (const id of all) purging.add(id);
  for (const id of plan.jobs) dirty.jobs.delete(id);
  for (const id of plan.poles) dirty.poles.delete(id);
  for (const id of plan.photos) dirty.photos.delete(id);
  try {
    await db.tx(['jobs', 'poles', 'photos', 'blobs'], 'readwrite', (s) => {
      for (const id of plan.jobs) s.jobs.delete(id);
      for (const id of plan.poles) s.poles.delete(id);
      for (const id of plan.photos) {
        s.photos.delete(id);
        for (const size of PHOTO_SIZES) s.blobs.delete(db.blobKey(id, size));
      }
    });
  } catch (e) {
    for (const id of all) purging.delete(id);
    for (const id of wasDirty.jobs) dirty.jobs.add(id);
    for (const id of wasDirty.poles) dirty.poles.add(id);
    for (const id of wasDirty.photos) dirty.photos.add(id);
    if (hasDirty()) schedule(SAVE_DELAY_MS);
    throw e;
  }
  for (const id of plan.jobs) jobs.delete(id);
  for (const id of plan.poles) poles.delete(id);
  for (const id of plan.photos) photos.delete(id);
  for (const id of all) purging.delete(id);
  // The journal must not keep a copy of anything that is now gone for good.
  if (hasDirty() || inFlight) writeJournal();
  else settleSaved();
  if (!quiet) emit('change', { kind: 'purge' });
}

/** Works out what the start-up tidy should remove. Pure, so it can be tested. */
export function planCleanUp(held, now) {
  const cutoff = now - TRASH_DAYS * DAY_MS;
  const expired = (record) => record.deletedAt > 0 && record.deletedAt < cutoff;
  const out = { jobs: [], poles: [], photos: [] };
  const goneJobs = new Set();
  const gonePoles = new Set();
  for (const job of held.jobs.values()) {
    if (expired(job)) {
      out.jobs.push(job.id);
      goneJobs.add(job.id);
    }
  }
  for (const pole of held.poles.values()) {
    if (goneJobs.has(pole.jobId)) {
      gonePoles.add(pole.id);
    } else if (!held.jobs.has(pole.jobId) || expired(pole)) {
      out.poles.push(pole.id);
      gonePoles.add(pole.id);
    }
  }
  for (const photo of held.photos.values()) {
    if (gonePoles.has(photo.poleId)) continue;
    if (!held.poles.has(photo.poleId) || expired(photo)) out.photos.push(photo.id);
  }
  return out;
}

async function removeStrayPictures() {
  // A picture with no photo record can only be left by an interrupted purge. Both lists are read
  // inside one all-or-nothing step, so a photo being added at this moment is never mistaken for a stray.
  await db.tx(
    ['photos', 'blobs'],
    'readwrite',
    (s) => {
      const photoKeys = s.photos.getAllKeys();
      photoKeys.onsuccess = () => {
        const known = new Set(photoKeys.result);
        const blobKeys = s.blobs.getAllKeys();
        blobKeys.onsuccess = () => {
          for (const key of blobKeys.result) {
            if (!known.has(db.photoIdOfBlobKey(key))) s.blobs.delete(key);
          }
        };
      };
    },
    { chained: true },
  );
}

/**
 * The time the start-up tidy goes by. A phone's date can be wrong, so it is never more than a
 * day past the newest change the app has made. Something is only removed for good once the
 * app has really been in use for 30 days since it was deleted.
 */
export const cleanUpClock = (now, newest) => Math.min(now, newest + DAY_MS);

async function cleanUp() {
  const plan = planCleanUp({ jobs, poles, photos }, cleanUpClock(Date.now(), latestChange()));
  if (plan.jobs.length || plan.poles.length || plan.photos.length) await purge(plan, true);
  await removeStrayPictures();
}

// ---------------------------------------------------------------------------------------------
// Space on the phone

/** { usage, quota, persisted }. Any of them is null when the phone does not report it. */
export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null };
  const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
  try {
    if (storage && typeof storage.estimate === 'function') {
      const estimate = await storage.estimate();
      if (Number.isFinite(estimate.usage)) out.usage = estimate.usage;
      if (Number.isFinite(estimate.quota)) out.quota = estimate.quota;
    }
  } catch (e) {
    /* not reported */
  }
  try {
    if (storage && typeof storage.persisted === 'function') out.persisted = await storage.persisted();
  } catch (e) {
    /* not reported */
  }
  return out;
}

export const isSpaceLow = () => spaceLow;

export async function checkSpace() {
  const info = await storageInfo();
  const low = info.usage != null && info.quota > 0 && info.usage / info.quota >= LOW_SPACE_RATIO;
  if (low !== spaceLow) {
    spaceLow = low;
    emit('change', { kind: 'space' });
  }
  return info;
}

/** Asks the browser not to clear this app's data when the phone runs short of space. */
export async function requestPersistence() {
  try {
    const storage = navigator.storage;
    if (storage && typeof storage.persist === 'function') return await storage.persist();
  } catch (e) {
    /* not supported */
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Data from the first version of the app
//
// The first version kept its own database. Its jobs and poles are copied over once. Its photos are
// then copied one at a time, because each one has to be re-saved in three sizes. If the app is
// closed part way, or the phone runs out of space, the photos still to do are tried again at the
// next start. Jobs are never copied a second time, so a job deleted in the meantime stays deleted.
// The old database is only read, never changed.

/**
 * Copies what the first version left. Returns
 * { jobs, photos, unreadable, retry, again }: jobs and photos copied, photos that could not be
 * read, photos to try again at the next start, and whether this was such a second attempt.
 */
async function importLegacy(options) {
  const result = { jobs: 0, photos: 0, unreadable: 0, retry: 0, again: Boolean(settingsValue.legacyChecked) };
  const makeRenditions = options && options.makeRenditions;
  const progress = options && typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const legacy = await db.openLegacy();
  if (!legacy) return result;
  try {
    const now = Date.now();
    const takenByOther = (id, jobId) => {
      const pole = poles.get(id);
      return Boolean(pole) && pole.jobId !== jobId;
    };
    const todo = [];
    for (const old of legacy.jobs) {
      const converted = convertV1Job(old, now, takenByOther);
      if (!converted) continue;
      const jobId = converted.job.id;
      if (!settingsValue.legacyChecked && !jobs.has(jobId)) {
        jobs.set(jobId, converted.job);
        queue('jobs', jobId);
        for (const pole of converted.poles) {
          if (poles.has(pole.id)) continue;
          poles.set(pole.id, pole);
          queue('poles', pole.id);
        }
        result.jobs += 1;
      }
      // A job deleted for good since the first attempt stays deleted, photos and all.
      if (!jobs.has(jobId)) continue;
      const isMine = (id) => {
        const pole = poles.get(id);
        return Boolean(pole) && pole.jobId === jobId;
      };
      for (const [photoId, owner] of findV1PhotoOwners(old, isMine)) {
        if (!photos.has(photoId)) todo.push([photoId, owner]);
      }
    }
    // Saved in the same step as the jobs and poles above, so they are never copied twice.
    settingsValue.legacyChecked = true;
    settingsValue.legacyPhotosLeft = todo.length > 0;
    queue('settings');
    if (!makeRenditions) {
      result.retry = todo.length;
      return result;
    }
    let done = 0;
    for (const [photoId, owner] of todo) {
      progress(done, todo.length);
      done += 1;
      let details;
      let renditions;
      try {
        const oldPhoto = await legacy.getPhoto(photoId);
        details = convertV1Photo(oldPhoto, owner, now);
        if (!details || !(oldPhoto.blob instanceof Blob) || oldPhoto.blob.size === 0) throw new Error('No picture.');
        renditions = await makeRenditions(oldPhoto.blob);
        details.w = renditions.w;
        details.h = renditions.h;
        details.bytes = renditions.full.byteLength;
      } catch (e) {
        result.unreadable += 1;
        continue;
      }
      // The pole may have been removed while the picture was being shrunk.
      if (!poles.has(owner.poleId)) continue;
      try {
        await putPhoto(details, renditions);
        result.photos += 1;
      } catch (e) {
        result.retry += 1;
      }
    }
    progress(todo.length, todo.length);
    settingsValue.legacyPhotosLeft = result.retry > 0;
    queue('settings');
  } finally {
    legacy.close();
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Start-up

/**
 * Loads everything from the phone. Call once.
 * options.makeRenditions is used to re-save pictures left by the first version of the app, and
 * options.onProgress(done, total) is told how far that has got.
 * Returns { legacy }: null, or what was carried over from the first version (see importLegacy).
 */
export async function init(options) {
  const now = Date.now();
  const [jobRows, poleRows, photoRows, meta] = await db.tx(['jobs', 'poles', 'photos', 'meta'], 'readonly', (s) => [
    s.jobs.getAll(),
    s.poles.getAll(),
    s.photos.getAll(),
    s.meta.get('settings'),
  ]);
  jobs.clear();
  poles.clear();
  photos.clear();
  for (const raw of jobRows) {
    const job = cleanJob(raw, now);
    if (job) jobs.set(job.id, job);
  }
  for (const raw of poleRows) {
    const pole = cleanPole(raw, now);
    if (pole) poles.set(pole.id, pole);
  }
  for (const raw of photoRows) {
    const photo = cleanPhoto(raw, now);
    if (photo) photos.set(photo.id, photo);
  }
  settingsValue = cleanSettings(meta && meta.value);

  replayJournals();

  let legacy = null;
  if (!settingsValue.legacyChecked || settingsValue.legacyPhotosLeft) {
    try {
      legacy = await importLegacy(options);
    } catch (e) {
      console.warn('Old data could not be carried over yet.', e);
    }
  }

  try {
    await cleanUp();
  } catch (e) {
    console.warn('Tidy-up skipped.', e);
  }
  await flush().catch(() => {});
  checkSpace().catch(() => {});
  return { legacy };
}
