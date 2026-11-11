// Gets data off the phone: a PDF report, or a ZIP package with the report, the raw data (for a
// program to read later), a CSV file and every photo at full size.

import { TEMPLATE } from './template.js';
import { exportColumns, computeAll, poleTag, applyTokens } from './template-engine.js';
import { safeFileName, cutText, today } from './records.js';
import { toCsv } from './csv.js';
import { ZipWriter } from './zip.js';
import { buildReport } from './report.js';
import { APP_NAME, APP_VERSION } from './config.js';
import * as store from './store.js';

export const PDF_TYPE = 'application/pdf';
export const ZIP_TYPE = 'application/zip';

/**
 * Takes a frozen copy of the chosen jobs.
 * Returns { template, tokens, jobs, seenAt, madeAt, poleCount, photoCount }.
 */
export function collectExport(jobIds) {
  const snap = store.snapshot(jobIds);
  let poleCount = 0;
  let photoCount = 0;
  for (const entry of snap.jobs) {
    poleCount += entry.poles.length;
    for (const item of entry.poles) photoCount += item.photos.length;
  }
  return { template: TEMPLATE, tokens: { ...store.tokens() }, jobs: snap.jobs, seenAt: snap.seenAt, madeAt: Date.now(), poleCount, photoCount };
}

/** The file name, without its ending. One job: its location, design number and date. */
export function fileStem(data) {
  if (data.jobs.length === 1) {
    const f = data.jobs[0].job.f || {};
    const parts = [f[data.template.job.titleKey], f[data.template.job.codeKey], f.date].filter((part) => part != null && String(part).trim() !== '');
    return safeFileName(parts.join('_'), 'Pole_Field_Data');
  }
  return safeFileName('Pole_Field_Data_' + today(new Date(data.madeAt)), 'Pole_Field_Data');
}

/** P03_A1234_2_Pole_tag.jpg */
export function photoFileName(poleNumber, tag, index, label) {
  // Each part is cut to 30 characters, then tidied again so it does not end in _ . or -
  const part = (text) => cutText(safeFileName(text, ''), 30).replace(/[_.-]+$/, '');
  const number = Number.isFinite(poleNumber) && poleNumber > 0 ? Math.floor(poleNumber) : 0;
  const parts = ['P' + String(number).padStart(2, '0')];
  const cleanTag = part(tag);
  if (cleanTag) parts.push(cleanTag);
  parts.push(String(index));
  const cleanLabel = part(label);
  if (cleanLabel) parts.push(cleanLabel);
  return parts.join('_') + '.jpg';
}

function tableRows(data) {
  const columns = exportColumns(data.template, data.tokens);
  const rows = [columns.map((column) => column.label)];
  for (const entry of data.jobs) {
    for (const item of entry.poles) {
      const extra = { number: item.number, photos: item.photos.length, computed: computeAll(data.template, item.pole.f) };
      rows.push(columns.map((column) => column.read(entry.job, item.pole, extra)));
    }
  }
  return rows;
}

export function buildCsv(data) {
  return toCsv(tableRows(data));
}

// The report uses the medium-size photos (900 pixels across), so it stays easy to email.
function reportBytes(data, onProgress) {
  const readPhoto = (photo) => store.getPhotoBytes(photo.id, 'mid');
  return buildReport(data, readPhoto, onProgress);
}

/** Returns { file, missingPhotos }. */
export async function buildPdfFile(data, onProgress) {
  const { parts, missingPhotos } = await reportBytes(data, onProgress);
  const file = new File(parts, fileStem(data) + '.pdf', { type: PDF_TYPE, lastModified: data.madeAt });
  return { file, missingPhotos };
}

/**
 * Returns { file, missingPhotos }. The package is a ZIP holding the PDF report, a CSV file, the
 * raw data (data.json, for a program to read later), and every photo at full size.
 */
export async function buildPackageFile(data, onProgress) {
  const stem = fileStem(data);
  const when = new Date(data.madeAt);
  const zip = new ZipWriter();
  const total = data.photoCount * 2;
  let done = 0;
  const step = () => {
    done += 1;
    if (onProgress) onProgress(done, total);
  };

  const report = await reportBytes(data, step);
  zip.add(stem + '.pdf', await new Blob(report.parts).arrayBuffer(), when);
  zip.add(stem + '.csv', buildCsv(data), when);

  const many = data.jobs.length > 1;
  const photoIndex = [];
  let missingPhotos = 0;
  for (let j = 0; j < data.jobs.length; j += 1) {
    const entry = data.jobs[j];
    const folder = 'photos/' + (many ? safeFileName('J' + (j + 1) + '_' + (entry.job.f[data.template.job.titleKey] || 'job'), 'job') + '/' : '');
    for (const item of entry.poles) {
      const tag = poleTag(data.template, item.pole);
      for (let i = 0; i < item.photos.length; i += 1) {
        const photo = item.photos[i];
        const picture = await store.getPhotoBytes(photo.id, 'full');
        if (picture) {
          const name = zip.add(folder + photoFileName(item.number, tag, i + 1, photo.label), picture.data, new Date(photo.createdAt));
          photoIndex.push({ photoId: photo.id, poleId: item.pole.id, file: name });
        } else {
          missingPhotos += 1;
          photoIndex.push({ photoId: photo.id, poleId: item.pole.id, file: null });
        }
        step();
      }
    }
  }

  const raw = {
    format: 'polefield-export',
    formatVersion: 1,
    app: APP_NAME,
    appVersion: APP_VERSION,
    madeAt: new Date(data.madeAt).toISOString(),
    names: { power: applyTokens('{power}', data.tokens), telecom: applyTokens('{telecom}', data.tokens) },
    jobs: data.jobs.map((entry) => ({
      job: entry.job,
      poles: entry.poles.map((item) => ({ number: item.number, pole: item.pole, calculated: computeAll(data.template, item.pole.f), photos: item.photos })),
    })),
    photoFiles: photoIndex,
  };
  // JSON has no "not a number" value, so an unreadable calculation is written as the words the screen shows.
  zip.add('data.json', JSON.stringify(raw, (key, value) => (typeof value === 'number' && Number.isNaN(value) ? 'check entry' : value), 2), when);

  const blob = zip.finish(ZIP_TYPE);
  const file = new File([blob], stem + '.zip', { type: ZIP_TYPE, lastModified: data.madeAt });
  return { file, missingPhotos: Math.max(missingPhotos, report.missingPhotos) };
}

/** True when the phone can hand this file to its share sheet (Files, Mail, AirDrop and so on). */
export function canShareFile(file) {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch (e) {
    return false;
  }
}

/** Opens the share sheet. Returns 'shared', 'cancelled' or 'failed'. */
export async function shareFile(file) {
  try {
    await navigator.share({ files: [file], title: file.name });
    return 'shared';
  } catch (e) {
    return e && e.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

/** Starts a download. The browser does not report whether it finished, so the caller must ask the user. */
export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
