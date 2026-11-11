// Shared tools for the browser tests: a phone-sized browser, a tap that behaves like a finger,
// and helpers to look inside the phone's storage and the files the app produces.

import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { makeServer } from '../../tools/serve.mjs';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    try {
      const found = require(name);
      if (found.chromium) return found;
    } catch (e) {
      /* try the next name */
    }
  }
  console.error('Playwright was not found. Install it (npm install -g playwright) and set NODE_PATH to the global node_modules folder.');
  process.exit(2);
  return null;
}

const PHONE = { width: 390, height: 844 };
// The app ignores a second tap in the same spot soon after the first: within 0.7 s after a new
// screen, 1 s after a sheet opened, changed or closed. A test that is not about that rule waits
// it out, the way a person's finger would.
const SAME_SPOT_PX = 30;
const SAME_SPOT_MS = 750;
const SAME_SPOT_AFTER_SHEET_MS = 1050;

export async function createHarness() {
  const { chromium } = loadPlaywright();
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({ executablePath });
  const tmp = await mkdtemp(path.join(tmpdir(), 'polefield-e2e-'));
  const images = path.join(tmp, 'images');
  const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
  if (shots) await mkdir(shots, { recursive: true });
  const servers = [];
  const contexts = [];

  const h = { ROOT, tmp, images, assert };

  /** Runs the Python checker and returns what it found. */
  h.py = async (mode, target) => {
    const { stdout } = await run('python3', [path.join(HERE, 'inspect_files.py'), mode, target], { maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(stdout);
  };

  /**
   * Serves a folder. Returns { url, origin, port, close }.
   * options: mount and intercept are passed to the server. port asks for a particular port.
   * server uses a ready-made server in place of a new one.
   */
  h.serve = async (root, options) => {
    const server = (options && options.server) || makeServer(root || ROOT, options || {});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen((options && options.port) || 0, '127.0.0.1', resolve);
    });
    const sockets = new Set();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const entry = {
      url: 'http://localhost:' + server.address().port + ((options && options.mount) || '/'),
      origin: 'http://localhost:' + server.address().port,
      port: server.address().port,
      close: () =>
        new Promise((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };
    servers.push(entry);
    return entry;
  };

  /** The app as it is in this folder, served once and shared by the tests that do not change files. */
  let shared = null;
  h.site = async () => {
    if (!shared) shared = await h.serve(ROOT);
    return shared;
  };

  /** A copy of the project in a fresh folder, for tests that change files. */
  h.copyProject = async (name) => {
    const target = path.join(tmp, name);
    await mkdir(target, { recursive: true });
    for (const item of ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'src', 'fonts', 'icons', 'tools', 'package.json']) {
      await cp(path.join(ROOT, item), path.join(target, item), { recursive: true });
    }
    return target;
  };

  /**
   * Opens a new, empty phone. Returns { context, page, problems }.
   * problems collects console errors, page errors and security-policy violations.
   */
  h.phone = async (options) => {
    const o = options || {};
    const context = await browser.newContext({
      viewport: o.viewport || PHONE,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      acceptDownloads: true,
      userAgent: o.userAgent,
      permissions: o.permissions || [],
      geolocation: o.geolocation,
      serviceWorkers: o.serviceWorkers || 'allow',
    });
    contexts.push(context);
    for (const script of o.initScripts || []) await context.addInitScript(script);
    await context.addInitScript(() => {
      // Real taps only. A click the app makes by itself (to start a download, say) has no position.
      window.addEventListener('click', (event) => { if (event.isTrusted && event.detail > 0) window.__lastClick = { x: event.clientX, y: event.clientY, t: performance.now() }; }, true);
      // When a sheet last opened, changed or closed. Watched from outside the app.
      const watchSheet = () => {
        const modal = document.getElementById('modal');
        if (!modal) return false;
        new MutationObserver(() => { window.__sheetChangedAt = performance.now(); }).observe(modal, { childList: true, attributes: true, attributeFilter: ['hidden'] });
        return true;
      };
      if (!watchSheet()) document.addEventListener('DOMContentLoaded', watchSheet);
      document.addEventListener('securitypolicyviolation', (event) => { console.error('CSP violation: ' + event.violatedDirective + ' ' + event.blockedURI); });
    });
    const page = await h.newPage(context);
    return { context, page, problems: page.problems };
  };

  /** Another tab in the same phone. */
  h.newPage = async (context) => {
    const page = await context.newPage();
    page.problems = [];
    page.on('console', (message) => {
      if (message.type() === 'error') page.problems.push('console: ' + message.text());
    });
    page.on('pageerror', (error) => page.problems.push('page error: ' + error.message));
    return page;
  };

  /** Loads the app and waits until a screen is drawn. */
  h.open = async (page, url) => {
    await page.goto(url);
    await page.waitForSelector('#app [data-heading]', { timeout: 15000 });
  };

  h.pause = (page, ms) => page.waitForTimeout(ms);

  /** Taps like a finger: once, in the middle, never quicker than the app's slip guard allows. */
  h.tap = async (page, target, options) => {
    const locator = typeof target === 'string' ? page.locator(target).first() : target;
    let box = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await locator.waitFor({ state: 'visible', timeout: (options && options.timeout) || 10000 });
        await locator.scrollIntoViewIfNeeded();
        box = await locator.boundingBox();
        break;
      } catch (error) {
        // The screen was redrawn at that very moment. Look again.
        if (attempt >= 3 || !/not attached|detached/i.test(String(error && error.message))) throw error;
      }
    }
    const last = await page.evaluate(() => (window.__lastClick ? { ...window.__lastClick, now: performance.now(), sheet: window.__sheetChangedAt || -1 } : null));
    if (box && last) {
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const near = Math.abs(x - last.x) < SAME_SPOT_PX && Math.abs(y - last.y) < SAME_SPOT_PX;
      const since = last.now - last.t;
      const wait = last.sheet > last.t ? SAME_SPOT_AFTER_SHEET_MS : SAME_SPOT_MS;
      if (near && since < wait) await page.waitForTimeout(wait - since);
    }
    await locator.click();
    await page.waitForTimeout((options && options.settle) || 60);
  };

  h.fill = async (page, selector, value) => {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout: 10000 });
    await locator.fill(value);
  };

  h.text = async (page, target) => (await (typeof target === 'string' ? page.locator(target).first() : target).innerText()).trim();
  h.count = (page, selector) => page.locator(selector).count();
  h.visible = async (page, selector) => (await page.locator(selector).count()) > 0 && page.locator(selector).first().isVisible();

  /** Waits until the app says everything is on the phone. */
  h.saved = async (page) => {
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-save-status]');
      return el && el.classList.contains('is-saved');
    }, null, { timeout: 10000 });
  };

  /** Runs an action that starts a download, and returns { path, name }. */
  h.download = async (page, action) => {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), action()]);
    const name = download.suggestedFilename();
    const target = path.join(tmp, 'downloads', Date.now() + '-' + name);
    await mkdir(path.dirname(target), { recursive: true });
    await download.saveAs(target);
    return { path: target, name };
  };

  h.shot = async (page, name) => {
    if (shots) await page.screenshot({ path: path.join(shots, name + '.png') });
  };

  /** Reads the phone's database directly, without going through the app. */
  h.stored = (page, dbName) =>
    page.evaluate(async (name) => {
      const list = indexedDB.databases ? await indexedDB.databases() : [];
      if (!list.some((entry) => entry.name === name)) return null;
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const out = {};
      for (const store of db.objectStoreNames) {
        out[store] = await new Promise((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result.map((record) => (record && record.data instanceof ArrayBuffer ? { ...record, data: record.data.byteLength } : record)));
          request.onerror = () => reject(request.error);
        });
      }
      db.close();
      return out;
    }, dbName || 'polefield@/');

  /** Copies one stored picture out of the phone into a file, and returns the file's path. */
  h.pictureFile = async (page, photoId, size, dbName) => {
    const base64 = await page.evaluate(
      async ([name, key]) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const record = await new Promise((resolve, reject) => {
          const request = db.transaction('blobs', 'readonly').objectStore('blobs').get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        if (!record) return null;
        const bytes = new Uint8Array(record.data);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      },
      [dbName || 'polefield@/', photoId + ':' + size],
    );
    if (base64 === null) return null;
    const target = path.join(tmp, 'pictures', photoId + '.' + size + '.jpg');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(base64, 'base64'));
    return target;
  };

  /**
   * Reads a PDF report with other programs (poppler, qpdf, pypdf). Returns what inspect_files.py
   * found, plus helpers that find a pole's pages and the answer on a line of one of them.
   */
  h.pdf = async (file) => {
    const doc = await h.py('pdf', file);
    assert.ok(doc.ok, 'qpdf finds the PDF well formed');
    const isPole = (page, n) => {
      const right = (page.lines[0] || []).slice(-1)[0] || '';
      return right === 'Pole ' + n || right.startsWith('Pole ' + n + ' ');
    };
    doc.polePages = (n) => doc.pages.map((page, i) => ({ ...page, number: i + 1 })).filter((page) => isPole(page, n));
    doc.poleText = (n) => doc.polePages(n).map((page) => page.text).join(' ');
    doc.poleImages = (n) => {
      const numbers = doc.polePages(n).map((page) => page.number);
      return doc.images.filter((image) => numbers.includes(image.page));
    };
    // The answer on the row with this label. A long label wraps onto a second line, so when no row
    // has the whole label, a row holding a long first part of it is taken.
    doc.value = (n, label) => {
      const rows = doc.polePages(n).flatMap((page) => page.lines.filter((line) => line.length > 1));
      const exact = rows.find((line) => line[0] === label);
      const wrapped = exact || rows.find((line) => line[0].length >= 30 && label.startsWith(line[0]));
      return wrapped ? wrapped.slice(1).join(' ') : undefined;
    };
    // Text with all spaces and line breaks taken out, for checking text that may have wrapped.
    doc.squeezed = (text) => text.replace(/\s+/g, '');
    return doc;
  };

  /**
   * Opens a file in LibreOffice by converting it to PDF. Returns the size of the PDF in bytes,
   * or null when LibreOffice is not installed. A file LibreOffice cannot read makes this throw.
   */
  h.libreOffice = async (file) => {
    const outDir = path.join(tmp, 'office-' + Date.now());
    await mkdir(outDir, { recursive: true });
    try {
      await run('soffice', ['--headless', '--norestore', '-env:UserInstallation=file://' + path.join(tmp, 'office-profile'), '--convert-to', 'pdf', '--outdir', outDir, file], { timeout: 180000 });
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    const pdf = path.join(outDir, path.basename(file).replace(/\.[^.]+$/, '') + '.pdf');
    const data = await readFile(pdf);
    assert.equal(data.subarray(0, 4).toString(), '%PDF', 'LibreOffice did not produce a PDF');
    return data.length;
  };

  /** Unpacks one file from a ZIP into the temporary folder and returns its path. */
  h.unzip = async (zipFile, entry) => {
    const outDir = path.join(tmp, 'unzip-' + Date.now() + '-' + Math.round(Math.random() * 1e6));
    await mkdir(outDir, { recursive: true });
    await run('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])', zipFile, entry, outDir]);
    return path.join(outDir, entry);
  };

  /** Fails if the page logged an error, apart from ones the test expects (given as text to look for). */
  h.clean = (page, allowed) => {
    const unexpected = page.problems.filter((problem) => !(allowed || []).some((text) => problem.includes(text)));
    assert.deepEqual(unexpected, [], 'the page reported problems');
  };

  h.readFile = readFile;
  h.writeFile = writeFile;
  h.path = path;

  h.closeContext = async (context) => {
    const index = contexts.indexOf(context);
    if (index >= 0) contexts.splice(index, 1);
    await context.close().catch(() => {});
  };

  h.finish = async () => {
    for (const context of contexts.splice(0)) await context.close().catch(() => {});
    for (const server of servers.splice(0)) await server.close().catch(() => {});
    await browser.close();
    if (process.env.KEEP) console.log('Kept: ' + tmp);
    else await rm(tmp, { recursive: true, force: true });
  };

  await h.py('make-images', images);
  return h;
}

// ---------------------------------------------------------------------------------------------
// Steps that many tests share

/** Starts a job from the home screen and stops on step 1 of its first pole. */
export async function startJob(h, page, details) {
  await h.tap(page, '[data-act="new-job"]');
  for (const [key, value] of Object.entries(details || {})) await h.fill(page, '#f-' + key, value);
  await h.tap(page, '[data-act="details-done"]');
  await page.waitForSelector('#f-tagMap');
}

/** Moves to a step of the pole on screen, by its key. */
export async function gotoStep(h, page, key) {
  await h.tap(page, '.progress [data-step="' + key + '"]');
  await page.waitForFunction((wanted) => location.hash.endsWith('/' + wanted), key);
}

/** Types answers into the step on screen. answers: { key: text } for inputs, { key: ['Option'] } for choices. */
export async function answer(h, page, answers) {
  for (const [key, value] of Object.entries(answers)) {
    if (Array.isArray(value)) await h.tap(page, '[data-choice="' + key + '"][data-v="' + value[0] + '"]');
    else await h.fill(page, '#f-' + key, value);
  }
}

/** From the last step, saves the pole and waits for the job screen. */
export async function savePole(h, page) {
  await gotoStep(h, page, 'photos');
  await h.tap(page, '[data-act="step-next"]');
  await page.waitForSelector('[data-act="add-pole"]');
}
