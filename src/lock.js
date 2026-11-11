// Makes sure only one tab (or window) of the app writes to the phone's storage at a time.
//
// Two tabs editing the same pole could quietly overwrite each other. So the first tab to open
// holds a lock. A second tab sees that and offers "Use it here". If the user agrees, the first
// tab saves, lets go, and shows a notice. If the first tab is frozen in the background and
// cannot answer, the lock is taken from it. Its unsaved work is safe in its journal, which the
// new tab reads.
//
// Browsers too old to have locks (before 2022) skip all of this and behave as a single tab.

import { LOCK_NAME, CHANNEL_NAME } from './config.js';

// A tab that does not answer within this time is taken to be frozen, and the lock is taken.
const YIELD_WAIT_MS = 2500;
// A tab that answers "busy" (still storing photos) is waited for, but not for ever.
const BUSY_BEAT_MS = 1000;
const BUSY_LIMIT_MS = 90000;

let releaseHeld = null;
let onLost = null;
let onYield = null;
let onJournal = null;
let channel = null;
let yielding = false;

const supported = () => typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';

function openChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (e) {
    channel = null;
    return;
  }
  channel.onmessage = async (event) => {
    const type = event.data && event.data.type;
    if (type === 'yield' && releaseHeld) {
      if (yielding) return;
      yielding = true;
      // Another tab wants to take over. Finish storing photos and save first, then let go.
      // Meanwhile say "busy" every second, so the other tab knows this one is not frozen.
      post({ type: 'busy' });
      const beat = setInterval(() => post({ type: 'busy' }), BUSY_BEAT_MS);
      try {
        if (onYield) await onYield();
      } catch (e) {
        console.error(e);
      } finally {
        clearInterval(beat);
        yielding = false;
      }
      const release = releaseHeld;
      releaseHeld = null;
      if (release) release();
      post({ type: 'yielded' });
    } else if (type === 'journal' && releaseHeld && onJournal) {
      onJournal();
    }
  };
}

function post(message) {
  try {
    if (channel) channel.postMessage(message);
  } catch (e) {
    /* the other tab will take the lock without an answer */
  }
}

// Resolves 'held' once this tab has the lock, 'busy' if another tab has it, or 'none' if the
// browser refused the request altogether.
function request(options) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };
    let outcome;
    try {
      outcome = navigator.locks.request(LOCK_NAME, options, (lock) => {
        if (!lock) {
          answer('busy');
          return undefined;
        }
        answer('held');
        return new Promise((release) => {
          releaseHeld = release;
        });
      });
    } catch (e) {
      answer('none');
      return;
    }
    outcome.then(
      () => {},
      () => {
        if (!answered) {
          answer('none');
          return;
        }
        // The lock was held and has been taken away by another tab.
        if (releaseHeld) {
          releaseHeld = null;
          if (onLost) onLost();
        }
      },
    );
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tries to become the one tab that writes.
 * Returns 'held', 'busy' (another tab has it) or 'none' (this browser has no locks).
 * handlers: { onLost(), onYield() (may be async), onJournal() }
 */
export async function acquire(handlers) {
  onLost = handlers && handlers.onLost;
  onYield = handlers && handlers.onYield;
  onJournal = handlers && handlers.onJournal;
  if (!supported()) return 'none';
  openChannel();
  // A tab that is being reloaded or closed lets go a moment later, so try a few times.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await request({ ifAvailable: true });
    if (result !== 'busy') return result;
    await pause(200);
  }
  return 'busy';
}

/**
 * Takes the lock from the other tab: politely if it answers, by force if it does not.
 * While the other tab says it is busy (storing photos), this waits, up to a limit.
 */
export async function takeOver() {
  if (!supported()) return 'none';
  openChannel();
  if (channel) {
    await new Promise((resolve) => {
      const began = Date.now();
      let timer = setTimeout(done, YIELD_WAIT_MS);
      function listener(event) {
        const type = event.data && event.data.type;
        if (type === 'yielded') done();
        else if (type === 'busy' && Date.now() - began < BUSY_LIMIT_MS) {
          clearTimeout(timer);
          timer = setTimeout(done, YIELD_WAIT_MS);
        }
      }
      function done() {
        clearTimeout(timer);
        channel.removeEventListener('message', listener);
        resolve();
      }
      channel.addEventListener('message', listener);
      post({ type: 'yield' });
    });
  }
  return request({ steal: true });
}

/** Tells the tab that now holds the lock that this tab has just written its journal. */
export function announceJournal() {
  openChannel();
  post({ type: 'journal' });
}

export const holdsLock = () => releaseHeld !== null;
