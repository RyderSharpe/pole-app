// Settings that the rest of the app reads. No logic lives here apart from working out
// which copy of the app this is.

export const APP_NAME = 'Pole Field Data';
export const APP_VERSION = '0.3.0';

// One web address can hold more than one copy of the app, for example a "test" folder and a
// "real" folder under the same github.io account. A browser gives every page at one address the
// same storage, so each copy keeps its data under its own folder name. SCOPE is that folder.
function scopePath() {
  try {
    if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
      return new URL('.', location.href).pathname;
    }
  } catch (e) {
    /* fall through */
  }
  return '/';
}

export const SCOPE = scopePath();

export const DB_NAME = 'polefield@' + SCOPE;
export const DB_VERSION = 1;

// The first version of the app kept everything in one database with this name. It is read once,
// copied into the new database, and then left alone.
export const LEGACY_DB_NAME = 'polefield';

export const STORAGE_PREFIX = 'polefield.' + SCOPE + '.';
export const CHANNEL_NAME = 'polefield@' + SCOPE;
export const LOCK_NAME = 'polefield@' + SCOPE;

// Deleted jobs, poles and photos can be brought back for this many days.
export const TRASH_DAYS = 30;

// Each photo is kept in three sizes, so lists stay fast and the PDF report stays small.
export const PHOTO = {
  full: { max: 2000, quality: 0.82 },
  mid: { max: 900, quality: 0.72 },
  thumb: { max: 320, quality: 0.7 },
};
export const PHOTO_SIZES = ['full', 'mid', 'thumb'];

// The form says "Power" and "Telecom" until the user sets real names in Settings.
export const DEFAULT_TOKENS = { power: 'Power', telecom: 'Telecom' };

export const SAVE_DELAY_MS = 300;
export const SAVE_RETRY_MS = 4000;

// A GPS reading worse than this is kept, but flagged.
export const GPS_POOR_ACCURACY_M = 30;
export const GPS_GOOD_ACCURACY_M = 10;
export const GPS_SETTLE_MS = 12000;
export const GPS_TIMEOUT_MS = 60000;

// Warn when the phone has used this share of the space the browser allows.
export const LOW_SPACE_RATIO = 0.8;

export const MAX_TEXT = 20000;
