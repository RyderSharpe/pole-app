#!/usr/bin/env node
// Walks through the real app in a phone-sized browser, then opens the files it produces with
// other programs' libraries.
//
//   npm run e2e                      every group
//   ONLY=photos,gps npm run e2e      only the named groups (or their numbers)
//   SHOTS=out npm run e2e            also save a picture of each screen into ./out
//   KEEP=1 npm run e2e               keep the temporary folder with the downloaded files
//
// Needs Playwright with Chromium, Python 3 with pypdf and Pillow, and poppler-utils and qpdf.

import { createHarness } from './harness.mjs';
import basics from './g1-basics.mjs';
import capture from './g2-capture.mjs';
import exporting from './g3-export.mjs';
import safety from './g4-safety.mjs';
import platform from './g5-platform.mjs';
import recovery from './g6-recovery.mjs';
import secondReview from './g7-second-review.mjs';

const GROUP_TIMEOUT_MS = 6 * 60 * 1000;
const groups = [...basics, ...capture, ...exporting, ...safety, ...platform, ...recovery, ...secondReview];
const only = (process.env.ONLY || '').split(',').map((part) => part.trim()).filter(Boolean);

const names = new Set();
for (const group of groups) {
  if (names.has(group.name)) throw new Error('Two test groups are called "' + group.name + '".');
  names.add(group.name);
}

const started = Date.now();
const h = await createHarness();
let passed = 0;
let ran = 0;
const failures = [];

for (let i = 0; i < groups.length; i += 1) {
  const group = groups[i];
  const number = i + 1;
  if (only.length && !only.includes(group.name) && !only.includes(String(number))) continue;
  ran += 1;
  const begun = Date.now();
  let timer;
  try {
    await Promise.race([
      group.run(h),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('took longer than ' + GROUP_TIMEOUT_MS / 1000 + ' seconds')), GROUP_TIMEOUT_MS);
      }),
    ]);
    passed += 1;
    console.log('ok   ' + String(number).padStart(2) + '  ' + group.title + '  (' + ((Date.now() - begun) / 1000).toFixed(1) + ' s)');
  } catch (error) {
    failures.push(group.name);
    console.log('FAIL ' + String(number).padStart(2) + '  ' + group.title);
    console.log(String((error && error.stack) || error).split('\n').map((line) => '       ' + line).join('\n'));
  } finally {
    clearTimeout(timer);
  }
}

await h.finish();
console.log('\n' + passed + ' of ' + ran + ' groups passed.  (' + Math.round((Date.now() - started) / 1000) + ' s)');
if (failures.length) {
  console.log('Failed: ' + failures.join(', '));
  process.exit(1);
}
if (!ran) {
  console.log('No group matched ONLY=' + only.join(','));
  process.exit(1);
}
