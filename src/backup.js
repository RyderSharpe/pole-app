// Backup and restore.
//
// A backup is one ZIP file holding every job, pole and photo on the phone, including the ones
// in "Recently deleted".
//
// Restore never removes anything. It only adds what is missing and updates what is older:
//   - Something only in the file is added.
//   - Something on both: the newer copy wins. A tie keeps the phone's copy.
//   - Something live on the phone is never replaced by a deleted copy from the file.
//   - Something deleted on the phone but live in the file is brought back.
//   - Anything deleted more than 30 days ago is left out.
// A job that already existed on the phone and was changed by the restore is marked as changed,
// so it shows as waiting to export.

import { TRASH_DAYS, APP_NAME, APP_VERSION, PHOTO_SIZES } from './config.js';
import { cleanJob, cleanPole, cleanPhoto, today } from './records.js';
import { ZipWriter, readZip } from './zip.js';
import { looksLikeJpeg } from './photos.js';
import * as store from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AHEAD_MS = 7 * DAY_MS;
const FORMAT = 'polefield-backup';
const FORMAT_VERSION = 1;

export const photoEntryName = (photoId, size) => 'photos/' + encodeURIComponent(photoId) + '.' + size + '.jpg';

/**
 * Decides what a restore should store. Pure: it only reads its arguments.
 * data:  the parsed backup.json
 * local: { jobs: Map, poles: Map, photos: Map } as held on the phone
 * Returns {
 *   jobs, poles      records to store
 *   photos           photos new to this phone (their pictures must be read from the file)
 *   photoDetails     photos already on this phone whose details should be updated
 *   added, updated   counts for the message shown to the user
 * }
 */
export function planRestore(data, local, now) {
  const out = { jobs: [], poles: [], photos: [], photoDetails: [], added: { jobs: 0, poles: 0, photos: 0 }, updated: { jobs: 0, poles: 0, photos: 0 } };
  const cutoff = now - TRASH_DAYS * DAY_MS;
  // A time far in the future (a wrong clock, or an edited file) is brought back to a week from
  // now, so it cannot outrank every change made later. Smaller errors keep their order.
  const latest = now + MAX_AHEAD_MS;
  const expired = (record) => record.deletedAt > 0 && record.deletedAt < cutoff;
  const list = (value) => (Array.isArray(value) ? value : []);
  const source = data && typeof data === 'object' ? data : {};

  function decide(incoming, mine) {
    if (!mine) return incoming;
    const mineLive = !mine.deletedAt;
    const incomingLive = !incoming.deletedAt;
    if (mineLive && !incomingLive) return null;
    if (!mineLive && !incomingLive) return null;
    if (!mineLive && incomingLive) {
      const base = incoming.updatedAt > mine.updatedAt ? incoming : mine;
      const back = { ...base, updatedAt: Math.max(now, mine.updatedAt + 1, incoming.updatedAt + 1) };
      delete back.deletedAt;
      return back;
    }
    if (incoming.updatedAt > mine.updatedAt) return incoming;
    if (incoming.updatedAt === mine.updatedAt && (incoming.exportedAt || 0) > (mine.exportedAt || 0)) return { ...mine, exportedAt: incoming.exportedAt };
    return null;
  }

  const plannedJobs = new Map();
  const knownJobs = new Set(local.jobs.keys());
  const touched = new Set(); // jobs that were already on the phone and are changed by this restore
  const seen = new Set();

  for (const raw of list(source.jobs)) {
    const incoming = cleanJob(raw, now, latest);
    if (!incoming || seen.has('j' + incoming.id) || expired(incoming)) continue;
    seen.add('j' + incoming.id);
    const mine = local.jobs.get(incoming.id);
    const chosen = decide(incoming, mine);
    knownJobs.add(incoming.id);
    if (!chosen) continue;
    plannedJobs.set(chosen.id, chosen);
    if (!mine) out.added.jobs += 1;
    else {
      out.updated.jobs += 1;
      const onlyExportMark = chosen.updatedAt === mine.updatedAt && !mine.deletedAt;
      if (!onlyExportMark) touched.add(chosen.id);
    }
  }

  const knownPoles = new Map(); // pole id -> job id
  for (const pole of local.poles.values()) knownPoles.set(pole.id, pole.jobId);
  for (const raw of list(source.poles)) {
    const incoming = cleanPole(raw, now, latest);
    if (!incoming || seen.has('p' + incoming.id) || expired(incoming) || !knownJobs.has(incoming.jobId)) continue;
    seen.add('p' + incoming.id);
    const mine = local.poles.get(incoming.id);
    const chosen = decide(incoming, mine);
    if (!mine) knownPoles.set(incoming.id, incoming.jobId);
    if (!chosen) continue;
    out.poles.push(chosen);
    knownPoles.set(chosen.id, chosen.jobId);
    if (!mine) out.added.poles += 1;
    else out.updated.poles += 1;
    if (local.jobs.has(chosen.jobId)) touched.add(chosen.jobId);
  }

  for (const raw of list(source.photos)) {
    const incoming = cleanPhoto(raw, now, latest);
    if (!incoming || seen.has('f' + incoming.id) || expired(incoming) || !knownPoles.has(incoming.poleId)) continue;
    seen.add('f' + incoming.id);
    // A photo always belongs to the job its pole belongs to, whatever the file says.
    incoming.jobId = knownPoles.get(incoming.poleId);
    const mine = local.photos.get(incoming.id);
    if (!mine) {
      out.photos.push(incoming);
      out.added.photos += 1;
    } else {
      const chosen = decide(incoming, mine);
      if (!chosen) continue;
      out.photoDetails.push(chosen);
      out.updated.photos += 1;
    }
    if (local.jobs.has(incoming.jobId)) touched.add(incoming.jobId);
  }

  // A job that was already here and now holds different content has not been exported in this form.
  for (const jobId of touched) {
    const base = plannedJobs.get(jobId) || local.jobs.get(jobId);
    if (!base) continue;
    const changed = { ...base, updatedAt: Math.max(now, (base.updatedAt || 0) + 1, (base.exportedAt || 0) + 1) };
    if (!plannedJobs.has(jobId)) out.updated.jobs += 1;
    plannedJobs.set(jobId, changed);
  }
  out.jobs = [...plannedJobs.values()];
  return out;
}

/**
 * Builds the backup file.
 * Returns { file, photos, missingPhotos, jobs, poles }.
 */
export async function buildBackupFile(onProgress) {
  await store.whenIdle();
  await store.flush().catch(() => {}); // if the phone is refusing saves, the backup is built from what is on screen
  const all = store.everything();
  const when = new Date();
  const zip = new ZipWriter();
  zip.add(
    'backup.json',
    JSON.stringify({
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      app: APP_NAME,
      appVersion: APP_VERSION,
      madeAt: when.toISOString(),
      jobs: all.jobs,
      poles: all.poles,
      photos: all.photos,
      settings: { collectedBy: all.settings.collectedBy, tokens: all.settings.tokens },
    }),
    when,
  );
  let missingPhotos = 0;
  let done = 0;
  for (const photo of all.photos) {
    let found = false;
    for (const size of PHOTO_SIZES) {
      const picture = await store.getPhotoBytes(photo.id, size, true);
      if (picture) {
        zip.add(photoEntryName(photo.id, size), picture.data, new Date(photo.createdAt));
        found = true;
      }
    }
    if (!found) missingPhotos += 1;
    done += 1;
    if (onProgress) onProgress(done, all.photos.length);
  }
  const blob = zip.finish('application/zip');
  const clock = String(when.getHours()).padStart(2, '0') + String(when.getMinutes()).padStart(2, '0');
  const file = new File([blob], 'Pole_Field_Data_backup_' + today(when) + '_' + clock + '.zip', { type: 'application/zip', lastModified: when.getTime() });
  return { file, photos: all.photos.length, missingPhotos, jobs: all.jobs.length, poles: all.poles.length };
}

const isOutOfSpace = (error) => Boolean(error) && (error.name === 'QuotaExceededError' || /quota|space/i.test(String(error.message)));

/**
 * Reads a backup file and merges it into the phone.
 * One damaged photo never stops the rest.
 * Returns { added, updated, photos, missingPhotos, damagedPhotos, outOfSpace }.
 * Throws an Error with a plain message when the file cannot be used at all.
 */
export async function restoreBackupFile(file, onProgress) {
  const zip = await readZip(file);
  if (!zip.has('backup.json')) throw new Error('This file is not a backup made by this app.');
  let data;
  try {
    data = JSON.parse(await zip.text('backup.json'));
  } catch (e) {
    throw new Error('The backup file is damaged and cannot be read.');
  }
  if (!data || typeof data !== 'object' || data.format !== FORMAT) throw new Error('This file is not a backup made by this app.');
  if (typeof data.formatVersion !== 'number' || data.formatVersion > FORMAT_VERSION) {
    throw new Error('This backup was made by a newer version of the app. Update the app, then try again.');
  }

  const plan = planRestore(data, store.held(), Date.now());
  const result = { added: plan.added, updated: plan.updated, photos: 0, missingPhotos: 0, damagedPhotos: 0, outOfSpace: false };
  store.applyRecords({ jobs: plan.jobs, poles: plan.poles, photoDetails: plan.photoDetails });
  try {
    await store.flush();
  } catch (e) {
    throw new Error('The phone refused to store the restored jobs. Free up some space, then try again.');
  }

  let done = 0;
  try {
    for (const photo of plan.photos) {
      const renditions = { w: photo.w, h: photo.h };
      let present = 0;
      let good = 0;
      for (const size of PHOTO_SIZES) {
        const name = photoEntryName(photo.id, size);
        if (!zip.has(name)) continue;
        present += 1;
        try {
          const bytes = await zip.bytes(name);
          const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          if (looksLikeJpeg(buffer)) {
            renditions[size] = buffer;
            good += 1;
          }
        } catch (e) {
          /* this size is damaged; another size may still be fine */
        }
      }
      done += 1;
      if (onProgress) onProgress(done, plan.photos.length);
      if (!good) {
        if (present) result.damagedPhotos += 1;
        else result.missingPhotos += 1;
        continue;
      }
      try {
        await store.putPhoto(photo, renditions);
        result.photos += 1;
      } catch (e) {
        if (isOutOfSpace(e)) {
          result.outOfSpace = true;
          break;
        }
        result.damagedPhotos += 1;
      }
    }
  } finally {
    store.mergeSettings(data.settings);
    store.announce('restore');
    store.checkSpace().catch(() => {});
  }
  result.added = { ...plan.added, photos: result.photos };
  return result;
}
