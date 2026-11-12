// Carries data over from the first version of the app.
//
// The first version stored each job as one record with its poles inside it, and used the names
// of two real companies in its field keys. This file is the only place those old keys appear.
// They are renamed here so that nothing else in the app carries a company name.

import { cleanFields, cleanId, cleanTime } from './records.js';

const RENAMED = {
  bchDip: 'powerDip',
  bchAnchor: 'powerAnchor',
  bchSlots: 'powerSlots',
  bchPlate: 'powerPlate',
  bchRod: 'powerRod',
  telusPlant: 'telPlant',
  telusDip: 'telDip',
  telusAnchor: 'telAnchor',
  telusSlots: 'telSlots',
};

const JOB_KEYS = ['location', 'date', 'collectedBy', 'designNo', 'otherId'];

/** True for a job record written by the first version. */
export function isV1Job(job) {
  return Boolean(job) && typeof job === 'object' && Array.isArray(job.poles);
}

/** Renames the old field keys. A new key that is already filled is never overwritten. */
export function convertV1Fields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const key of Object.keys(fields)) {
    if (!(key in RENAMED)) out[key] = fields[key];
  }
  for (const key of Object.keys(fields)) {
    if (key in RENAMED && out[RENAMED[key]] == null) out[RENAMED[key]] = fields[key];
  }
  return cleanFields(out);
}

/**
 * Splits one old job into a job, its poles and a list saying which pole owns which photo.
 *
 * takenByOther(id, jobId) says whether a pole id is already used by a pole of another job. Such
 * a pole (and one with a missing or repeated id) gets an id made from the job id and its place
 * in the list. That id is the same every time, so an import that was interrupted can be run
 * again and still find the poles it made the first time.
 *
 * Returns null when the record cannot be used.
 */
export function convertV1Job(old, now, takenByOther) {
  if (!isV1Job(old)) return null;
  const jobId = cleanId(old.id);
  if (!jobId) return null;
  const createdAt = cleanTime(old.createdAt, now);
  const updatedAt = cleanTime(old.updatedAt, createdAt);
  const jobFields = {};
  for (const key of JOB_KEYS) jobFields[key] = old[key];
  const job = { id: jobId, f: cleanFields(jobFields), createdAt, updatedAt, exportedAt: cleanTime(old.exportedAt, 0) };

  const poles = [];
  const photoOwners = new Map();
  const seen = new Set();
  const free = (id) => Boolean(id) && !seen.has(id) && !(takenByOther && takenByOther(id, jobId));
  const madeUp = (index) => {
    const base = 'v1-' + jobId.slice(0, 80) + '-' + (index + 1);
    for (let n = 1; n <= 50; n += 1) {
      const id = cleanId(n === 1 ? base : base + '-' + n);
      if (free(id)) return id;
    }
    return '';
  };
  old.poles.forEach((oldPole, index) => {
    if (!oldPole || typeof oldPole !== 'object') return;
    let id = cleanId(oldPole.id);
    if (!free(id)) id = madeUp(index);
    if (!id) return;
    seen.add(id);
    poles.push({
      id,
      jobId,
      f: convertV1Fields(oldPole.f),
      gps: null,
      spans: [],
      done: oldPole.done === true,
      // The first version kept poles in a list. One millisecond apart keeps that order.
      createdAt: createdAt + index,
      updatedAt,
    });
    if (Array.isArray(oldPole.photoIds)) {
      for (const photoId of oldPole.photoIds) {
        const clean = cleanId(photoId);
        if (clean && !photoOwners.has(clean)) photoOwners.set(clean, { poleId: id, jobId });
      }
    }
  });
  return { job, poles, photoOwners };
}

/**
 * For an old job that is already on the phone: which pole on the phone holds each old photo.
 *
 * A pole was copied under its own id or under a made-up one (see convertV1Job), depending on
 * which ids were free at the time. That can have changed since (another job deleted for good),
 * so the clash rule is not run again. Instead each old pole, in order, takes the first of its
 * possible ids that is a pole of this job and not already taken.
 * isMine(id) says whether the phone holds a pole with that id in this job.
 */
export function findV1PhotoOwners(old, isMine) {
  const owners = new Map();
  if (!isV1Job(old)) return owners;
  const jobId = cleanId(old.id);
  if (!jobId) return owners;
  const claimed = new Set();
  old.poles.forEach((oldPole, index) => {
    if (!oldPole || typeof oldPole !== 'object') return;
    const base = 'v1-' + jobId.slice(0, 80) + '-' + (index + 1);
    const candidates = [cleanId(oldPole.id)];
    for (let n = 1; n <= 50; n += 1) candidates.push(cleanId(n === 1 ? base : base + '-' + n));
    const poleId = candidates.find((id) => id && !claimed.has(id) && isMine(id));
    if (!poleId) return; // the pole was deleted for good since
    claimed.add(poleId);
    if (!Array.isArray(oldPole.photoIds)) return;
    for (const photoId of oldPole.photoIds) {
      const clean = cleanId(photoId);
      if (clean && !owners.has(clean)) owners.set(clean, { poleId, jobId });
    }
  });
  return owners;
}

/** The details of one old photo. The picture itself is re-saved in three sizes by the caller. */
export function convertV1Photo(old, owner, now) {
  if (!old || typeof old !== 'object' || !owner) return null;
  const id = cleanId(old.id);
  if (!id) return null;
  const createdAt = cleanTime(old.createdAt, now);
  return { id, poleId: owner.poleId, jobId: owner.jobId, label: '', w: 0, h: 0, bytes: 0, createdAt, updatedAt: createdAt };
}
