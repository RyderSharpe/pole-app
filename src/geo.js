// Reads the phone's position. GPS needs no cell signal, but with no signal the first reading
// can take a minute, so the app listens for a while and keeps the most accurate reading it gets.

import { GPS_GOOD_ACCURACY_M, GPS_SETTLE_MS, GPS_TIMEOUT_MS } from './config.js';

export const gpsAvailable = () => typeof navigator !== 'undefined' && Boolean(navigator.geolocation);

const MESSAGES = {
  unsupported: 'This phone does not share its position with the browser.',
  denied: 'Location is turned off for this app. Turn it on in the phone settings, then try again.',
  unavailable: 'The phone could not find its position. Move to open sky and try again.',
  timeout: 'No position after a minute. Move to open sky and try again.',
  cancelled: 'Cancelled.',
};

function problem(code) {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  return error;
}

/**
 * Listens for the position.
 *   - Stops as soon as a reading is accurate to GPS_GOOD_ACCURACY_M or better.
 *   - Otherwise keeps the best reading seen in the GPS_SETTLE_MS after the first one.
 *   - Gives up after GPS_TIMEOUT_MS with no reading at all.
 * options: { signal, onProgress(best) }. Aborting the signal rejects at once with code "cancelled".
 * Resolves { lat, lon, acc, at }. Rejects with an Error whose code is one of the MESSAGES keys.
 */
export function getPosition(options) {
  const o = options || {};
  return new Promise((resolve, reject) => {
    if (!gpsAvailable()) {
      reject(problem('unsupported'));
      return;
    }
    let best = null;
    let watch = null;
    let settle = null;
    let limit = null;
    let finished = false;

    const finish = (settleWith, value) => {
      if (finished) return;
      finished = true;
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      clearTimeout(settle);
      clearTimeout(limit);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
      settleWith(value);
    };
    function onAbort() {
      finish(reject, problem('cancelled'));
    }

    if (o.signal) {
      if (o.signal.aborted) {
        onAbort();
        return;
      }
      o.signal.addEventListener('abort', onAbort);
    }

    const onReading = (position) => {
      if (finished) return;
      const c = position.coords;
      if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
      const reading = { lat: c.latitude, lon: c.longitude, acc: Number.isFinite(c.accuracy) && c.accuracy >= 0 ? c.accuracy : null, at: Date.now() };
      const better = !best || (reading.acc != null && (best.acc == null || reading.acc <= best.acc));
      if (better) best = reading;
      if (o.onProgress) {
        try {
          o.onProgress(best);
        } catch (e) {
          console.error(e);
        }
      }
      if (best.acc != null && best.acc <= GPS_GOOD_ACCURACY_M) {
        finish(resolve, best);
      } else if (settle === null) {
        settle = setTimeout(() => finish(resolve, best), GPS_SETTLE_MS);
      }
    };

    const onError = (error) => {
      if (finished) return;
      if (error && error.code === 1) finish(reject, problem('denied'));
      else if (best) finish(resolve, best);
      else if (error && error.code === 2) finish(reject, problem('unavailable'));
      // A timeout with nothing yet: keep listening until the overall limit below.
    };

    limit = setTimeout(() => (best ? finish(resolve, best) : finish(reject, problem('timeout'))), GPS_TIMEOUT_MS);
    try {
      watch = navigator.geolocation.watchPosition(onReading, onError, { enableHighAccuracy: true, maximumAge: 0, timeout: GPS_TIMEOUT_MS });
    } catch (e) {
      finish(reject, problem('unavailable'));
    }
  });
}
