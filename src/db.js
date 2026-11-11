// The on-phone database (IndexedDB). Only store.js talks to this file.
//
// Stores:
//   jobs    one record per job
//   poles   one record per pole            (index: jobId)
//   photos  one record per photo, details only (index: poleId)
//   blobs   the pictures themselves, three sizes per photo, key "<photoId>:<size>"
//   meta    settings

import { DB_NAME, DB_VERSION, LEGACY_DB_NAME } from './config.js';

let opening = null; // the promise for the open database
let openedDb = null; // the database itself, once open
const listeners = { blocked: new Set(), outdated: new Set() };

/** Listen for "blocked" (another tab is in the way) or "outdated" (a newer version of the app has taken over). */
export function onDbEvent(name, fn) {
  listeners[name].add(fn);
  return () => listeners[name].delete(fn);
}

function emit(name) {
  for (const fn of listeners[name]) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

function describe(error) {
  if (error && error.name === 'VersionError') {
    const e = new Error('A newer version of the app has already used this phone. Reload to get it.');
    e.name = 'VersionError';
    return e;
  }
  return error || new Error('The phone would not open its storage.');
}

// Stops using a database that has been closed, so the next piece of work opens a fresh one.
function forget(db) {
  if (openedDb === db) {
    openedDb = null;
    opening = null;
  }
}

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('This browser has no on-phone storage.'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(describe(e));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      const names = db.objectStoreNames;
      if (!names.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!names.contains('poles')) db.createObjectStore('poles', { keyPath: 'id' }).createIndex('jobId', 'jobId');
      if (!names.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' }).createIndex('poleId', 'poleId');
      if (!names.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' }).createIndex('photoId', 'photoId');
      if (!names.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onblocked = () => emit('blocked');
    request.onerror = () => reject(describe(request.error));
    request.onsuccess = () => {
      const db = request.result;
      // A newer copy of the app wants to change the database. Step aside so it is not held up.
      db.onversionchange = () => {
        db.close();
        forget(db);
        emit('outdated');
      };
      // The browser can close the database on its own, for example after a long time in the
      // background. The next save simply opens it again.
      db.onclose = () => forget(db);
      resolve(db);
    };
  });
}

export function openDB() {
  if (!opening) {
    const attempt = open();
    opening = attempt;
    attempt.then(
      (db) => {
        if (opening === attempt) openedDb = db;
      },
      () => {
        if (opening === attempt) opening = null;
      },
    );
  }
  return opening;
}

export async function closeDB() {
  const pending = opening;
  opening = null;
  openedDb = null;
  if (!pending) return;
  try {
    (await pending).close();
  } catch (e) {
    /* it never opened */
  }
}

function isLostConnection(error) {
  if (!error) return false;
  if (error.name === 'InvalidStateError') return true;
  return error.name === 'UnknownError' && /connection|closing|closed/i.test(String(error.message));
}

function resolved(out) {
  const isRequest = (x) => typeof IDBRequest !== 'undefined' && x instanceof IDBRequest;
  if (isRequest(out)) return out.result;
  if (Array.isArray(out)) return out.map((x) => (isRequest(x) ? x.result : x));
  return out;
}

function run(db, names, mode, work, chained) {
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = mode === 'readwrite' ? db.transaction(names, mode, { durability: 'strict' }) : db.transaction(names, mode);
    } catch (e) {
      reject(e);
      return;
    }
    let out;
    t.oncomplete = () => resolve(resolved(out));
    t.onabort = () => reject(t.error || new Error('The phone cancelled the save.'));
    try {
      const stores = {};
      for (const name of names) stores[name] = t.objectStore(name);
      out = work(stores, t);
      // Everything has been queued, so ask the phone to finish now instead of waiting for it to
      // notice. This matters when the app is about to be put in the background.
      if (mode === 'readwrite' && !chained && typeof t.commit === 'function') t.commit();
    } catch (e) {
      try {
        t.abort();
      } catch (ignored) {
        /* already finished */
      }
      reject(e);
    }
  });
}

/**
 * Runs one all-or-nothing piece of work.
 *
 * work(stores, transaction) must queue all of its requests straight away. It may return a
 * request, or a list of requests, and tx() resolves with their results.
 * Pass { chained: true } when the work makes further requests from inside a request's callback.
 * A dropped connection is retried once with a fresh one. Every write in this app is safe to repeat.
 */
export async function tx(storeNames, mode, work, options) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  const chained = Boolean(options && options.chained);
  for (let attempt = 0; ; attempt += 1) {
    const pending = openDB();
    const db = await pending;
    try {
      return await run(db, names, mode, work, chained);
    } catch (e) {
      if (attempt > 0 || !isLostConnection(e)) throw e;
      if (opening === pending) {
        opening = null;
        openedDb = null;
      }
      try {
        db.close();
      } catch (ignored) {
        /* already closed */
      }
    }
  }
}

export const getAll = (store) => tx(store, 'readonly', (s) => s[store].getAll());
export const getAllKeys = (store) => tx(store, 'readonly', (s) => s[store].getAllKeys());
export const get = (store, key) => tx(store, 'readonly', (s) => s[store].get(key));
export const put = (store, value) => tx(store, 'readwrite', (s) => s[store].put(value));
export const del = (store, key) => tx(store, 'readwrite', (s) => s[store].delete(key));

export const blobKey = (photoId, size) => photoId + ':' + size;
export const photoIdOfBlobKey = (key) => String(key).slice(0, String(key).lastIndexOf(':'));

// ---------------------------------------------------------------------------------------------
// Data left by the first version of the app

async function legacyExists() {
  if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases();
      return list.some((entry) => entry.name === LEGACY_DB_NAME);
    } catch (e) {
      /* fall through and find out by opening it */
    }
  }
  return null; // unknown
}

/**
 * Opens the first version's database for reading, without changing it.
 * Returns null when there is none. Otherwise { jobs, getPhoto(id), close() }.
 */
export async function openLegacy() {
  if (typeof indexedDB === 'undefined' || !indexedDB) return null;
  if ((await legacyExists()) === false) return null;
  const db = await new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(LEGACY_DB_NAME);
    } catch (e) {
      resolve(null);
      return;
    }
    // "Upgrade needed" on a plain open means the database did not exist. Cancelling the upgrade
    // stops an empty one from being left behind.
    request.onupgradeneeded = () => {
      try {
        request.transaction.abort();
      } catch (e) {
        /* nothing to cancel */
      }
    };
    request.onerror = (event) => {
      event.preventDefault();
      resolve(null);
    };
    request.onblocked = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
  if (!db) return null;
  if (!db.objectStoreNames.contains('jobs')) {
    db.close();
    return null;
  }
  const read = (store, work) =>
    new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readonly');
      const request = work(t.objectStore(store));
      t.oncomplete = () => resolve(request.result);
      t.onabort = () => reject(t.error || new Error('Could not read the old data.'));
    });
  let jobs;
  try {
    jobs = await read('jobs', (s) => s.getAll());
  } catch (e) {
    db.close();
    return null;
  }
  const hasPhotos = db.objectStoreNames.contains('photos');
  return {
    jobs,
    getPhoto: (id) => (hasPhotos ? read('photos', (s) => s.get(id)).catch(() => null) : Promise.resolve(null)),
    close: () => db.close(),
  };
}
