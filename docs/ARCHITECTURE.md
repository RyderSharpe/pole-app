# How the app is built

For whoever maintains this code next. It assumes you can read JavaScript.

## The short version

- A single-page web app. Plain ES modules, no framework, no build step other than `tools/build-sw.mjs`.
- All data lives in IndexedDB on the phone. A service worker stores the app's own files so it opens with no signal.
- The form is data (`src/template.js`). One engine draws it, checks it and exports it.
- Nothing is ever sent over the network. A unit test fails if any app file calls `fetch` or similar.

## Files

| File | Job | Touches the screen or storage? |
|---|---|---|
| `src/config.js` | Constants, and the folder name that keeps two copies of the app apart | No |
| `src/compute.js` | Reading typed numbers, rounding, the separation calculations | No |
| `src/template.js` | The form, as data | No |
| `src/template-engine.js` | Shown or hidden, N/A, left blank, warnings, export layout, form validation | No |
| `src/records.js` | The shape of a job, pole, photo and settings. Cleaners for anything read from storage or a file | No |
| `src/csv.js`, `src/zip.js` | File writers. `zip.js` also reads ZIP files | No |
| `src/migrate.js` | Converts data left by the first version | No |
| `src/db.js` | IndexedDB: open, one transaction helper, reading the first version's database | Storage |
| `src/store.js` | Everything in memory, the save queue, the journal, purge and clean-up | Storage |
| `src/lock.js` | One tab at a time | Browser locks |
| `src/nav.js` | Addresses and the history trail | History |
| `src/ui.js` | Safe HTML, icons, the sheet, the toast | Screen |
| `src/form.js` | Draws template items and keeps warnings live while typing | Screen |
| `src/photos.js`, `src/geo.js` | Photo shrinking, GPS | Device |
| `src/pdf.js`, `src/pdf-metrics.js` | A small PDF writer: pages, built-in fonts, text, boxes, JPEG photos | No |
| `src/report.js`, `src/exporter.js`, `src/backup.js` | The PDF report, CSV, package, backup and restore | Storage, files |
| `src/pwa.js`, `sw.js` | Offline copy, updates, install prompt | Network (the app's own files only) |
| `src/views/*.js` | One file per screen, plus the export conversation | Screen |
| `src/main.js` | Start-up, drawing, taps, typing | Screen |

The "No" rows hold most of the rules and are covered by `npm test`. Keep new rules there when you can.

## Data

```
job    { id, f: { location, date, ... }, createdAt, updatedAt, exportedAt, deletedAt? }
pole   { id, jobId, f: { tagMap, gP, ... }, gps: { lat, lon, acc, at } | null, done, createdAt, updatedAt, deletedAt? }
photo  { id, poleId, jobId, label, w, h, bytes, createdAt, updatedAt, deletedAt? }
blob   { key: "<photoId>:<full|mid|thumb>", photoId, size, type, data: ArrayBuffer }
meta   { key: "settings", value: { collectedBy, tokens: { power, telecom }, lastBackupAt, legacyChecked, legacyPhotosLeft } }
```

- Ids are made by the app: random UUIDs, or `id-<time>-<hex>` and `v1-<job>-<n>` for data from the first version. Anything read back must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`, so an id is always safe in a file name, an address and a ZIP entry.

- Answers in `f` are text, or `true` for a switched-on toggle. A blank answer has no key.
- `job.updatedAt` moves whenever the job, any of its poles or any of its photos changes. It is the stamp for the whole job.
- A job reads "Exported" when `exportedAt >= updatedAt`. Marking a job exported sets `exportedAt` to the stamp the job had **when the file was built**, never to the time of the tap. Anything changed in between leaves the job waiting.
- `stamp()` in `store.js` makes `updatedAt` always move forward, even if the phone's clock is set back.
- Times saved on this phone are read back as they are, even when they are ahead of the clock. A phone whose clock was fast and is then put right keeps its poles in order and keeps "changed since export" true. Times from a backup file are different: see below.
- Deleting sets `deletedAt`. Records are removed for good 30 days later, at start-up, or by "Delete forever".
- Photos are stored as ArrayBuffers in three sizes. The photo record and its pictures are written in one transaction, so a photo never exists without its picture.

Each copy of the app uses its own database, named `polefield@<folder>`. Two copies under one web address (a test folder and a real folder) do not share data, caches, locks or journals.

## Saving

1. A change is applied in memory at once. The record id goes into a "dirty" set.
2. After 0.3 s every dirty record is written in one transaction with strict durability, and the transaction is told to commit straight away.
3. If the write fails, the ids go back into the dirty set, the save status becomes "error", a red banner appears on every screen, and the app retries every 4 s.
4. The journal is a copy of the unsaved records in `localStorage`. It is written the moment the app is hidden, and on every change while saves are failing. `localStorage` writes are synchronous, so they finish even if the phone freezes the app a moment later.
5. At start-up, journal records newer than the database are put back, then the journal is cleared after the next clean save.

`flush()` resolves only when nothing is dirty and nothing is in flight. Export and backup call `flush().catch(() => {})` and then build from memory, so they still work while the phone is refusing saves.

Every write reads the stored copy first, inside the same transaction, and skips any record whose stored copy is newer. That can only happen when another tab took over and saved while this one was frozen. The tab then stops saving and shows "Changed in another tab". This is the second line of defence behind the tab lock, and the only one in browsers without locks.

## One tab at a time

Two tabs writing the same pole would overwrite each other. `src/lock.js` uses the Web Locks API:

- The first tab holds a lock for as long as it is open.
- A second tab shows "Already open" with a **Use it here** button.
- On that tap, the second tab asks the first to yield (BroadcastChannel). The first saves, retires and lets go.
- If the first does not answer within 2.5 s (frozen in the background), the lock is taken by force. The first tab's unsaved records are in its journal, which the second tab reads at start-up. When the first tab wakes it finds the lock gone, writes its journal once more, tells the new tab, and shows a notice. A retired tab never writes again.

Browsers without Web Locks (before 2022) run without this protection.

## Screens and redrawing

- `nav.js` keeps a "trail" of visited addresses inside `history.state`. The in-app back arrow calls `backTo(parent)`: if the parent is in the trail the history is rewound to it, otherwise the current entry is replaced. So one tap always shows the parent, and the phone's own Back button still works.
- "Next: Pole 1" on a new job uses `goVia(job, pole)`: the details entry becomes the job before the pole is added. So the phone's Back button goes from the first pole (and from the job after "Save pole") to the job, then the job list.
- A new pole that is left with nothing on it is removed, and so is a new job left with only the details the app filled in. Neither is removed if it holds anything in Recently deleted (a deleted photo, a deleted pole), so Undo and "Bring back" keep working.
- A screen is a plain object: `render()`, and optional `mounted`, `unmount`, `leave`, `changed`, `input`, `tap`, `actions`.
- Every screen is drawn by setting `innerHTML` to the result of the `html` tag in `ui.js`, which escapes everything dropped into it. A unit test checks that no file sets `innerHTML` any other way.
- While the user is typing, the page is never replaced under the keyboard. Field edits are "quiet" changes. Other changes ask for a redraw, which waits until the keyboard is put away.
- Slow work (GPS, photo shrinking, thumbnails) is tied to the pole it started on. `pole.js` keeps a `showing` record and checks it before touching the page. A GPS search is cancelled when the user leaves the pole.
- A second tap in the same spot within 350 ms is ignored: 700 ms after a new screen has appeared, and 1 s after a sheet opened, changed or closed. A press that began before a screen or sheet appeared is ignored too. So a slip, or a gloved "did that work?" tap, cannot press a button that was not there a moment ago.
- Where a sheet replaces a button that was just tapped, the safe answer sits under the finger ("No, try again" where "Download" was).
- A second tap on the answer just chosen keeps it. A later tap clears it, with Undo.

## Exports

- `store.snapshot()` takes a frozen copy and records each job's stamp (`seenAt`).
- `report.js` lays out the PDF report and `pdf.js` writes it. No library: the PDF uses Helvetica and Courier, which every reader has, so no font is stored, and each JPEG is stored as it is, since PDF reads JPEG directly. Character widths for wrapping come from Adobe's font metric files (`tools/make-pdf-metrics.py`). Text is limited to the WinAnsi (Latin) character set; anything else prints as "?".
- The report: per job, a first page with the details and a list of poles; then a page for each pole, with a "Check these" box, every answered question by step, the separations, and the photos two to a row. Questions left blank are left out, so a pole usually fits on one or two pages. Medium-size photos (900 pixels) keep a 40-pole job with 120 photos near 10 MB.
- A job is marked exported only after `navigator.share` resolves, or after the user answers "Yes" to "Did the file save?" following a download. A browser cannot tell the app whether a download finished.
- On an iPhone the share sheet is the only option offered when it is available.
- A photo whose picture cannot be read is reported in the sheet and printed in the report as a note in its place.

## Backup and restore

`planRestore()` in `backup.js` is a pure function and holds all the rules:

- Only in the file: added.
- On both: the newer `updatedAt` wins. A tie keeps the phone's copy.
- Live on the phone, deleted in the file: the phone's copy stays. A restore never deletes.
- Deleted on the phone, live in the file: brought back.
- Deleted more than 30 days ago: left out.
- Times more than a week ahead are brought back to a week ahead, so a wrong clock or an edited file cannot outrank later work forever. Smaller errors keep their order.
- A job that was already on the phone and is changed by the restore is re-stamped, so it reads as not exported.

Photos are restored one at a time. A damaged or missing picture is counted and skipped.

## Data from the first version

The first version kept its own database (`polefield`). It is opened read-only and never changed.

1. Its jobs and poles are copied once. `legacyChecked` is saved in the same transaction, so a job is never copied twice, and a job deleted later stays deleted.
2. Its photos are then re-saved one by one in three sizes. The start-up screen counts them.
3. A photo that the phone has no room for is tried again at the next start (`legacyPhotosLeft`). A photo that cannot be read is left out and reported once.
4. Pole ids that clash with another job get `v1-<job>-<n>`, which is the same on every attempt, so an interrupted copy finds its own poles again.

## Offline copy and updates

- `tools/build-sw.mjs` writes into `sw.js` a version and a SHA-256 fingerprint for every file.
- On install, the service worker downloads every file, checks each fingerprint, and stores them. One mismatch throws the whole download away. This protects against a server that is half way through publishing.
- The new copy waits. The page shows an **Update** button. On tap the app saves, tells the waiting worker to take over, and reloads when it has.
- Cache names include the folder, so one copy never deletes another copy's files.
- Only the app's own address gets `index.html`. Other addresses are looked up as files.

## Security

- Content-Security-Policy in `index.html`: only the app's own files may load or run. No inline code or styles. No connections to other sites.
- All HTML goes through the escaping `html` tag.
- Everything read from storage, a journal or a backup file goes through the cleaners in `records.js`: plain objects only, known shapes, strict ids, capped lengths, no `__proto__`, no control characters or half characters, and times from files capped at a week ahead.
- File names and sheet names are built from a whitelist of characters. ZIP entry names and sheet names also lose characters that cannot be seen or that turn text around.
- CSV cells that a spreadsheet could run as a formula get a leading apostrophe, including ones that hide the sign behind spaces, invisible characters or a full-width sign.
- The app refuses to run inside a frame, before it takes the tab lock, so another page cannot lay buttons over it or block the real copy. (GitHub Pages cannot send a `frame-ancestors` header, so this check is in `main.js`.)
- Every app under one GitHub account shares one web address (`<name>.github.io`) and so one storage area. Do not publish other people's pages, or untrusted code, under the same account as this app.
- The ZIP reader checks every checksum and stops a file that unpacks to more than it promised.

## Tests

- `tests/unit/` runs under plain Node. It covers the pure files and a set of whole-project rules (the offline list is current, imports resolve, the policy is strict, no company names, colour contrast).
- `tests/e2e/` drives Chromium at phone size with Playwright. Each group gets a fresh, empty phone. The tap helper behaves like a finger and respects the app's own slip guard. Exported files are opened with poppler (`pdftotext`, `pdfimages`, `pdfinfo`), qpdf, pypdf, Pillow, and Python's `zipfile` and `csv`.
- Tests reach the app only through the screen and through the phone's own storage. There are no test hooks in the app code.

## Known limits

- Never run on a real phone. See `PHONE-TEST.md`.
- A backup is built in memory. Several hundred photos may be too much for an older phone.
- A restore merges whole records. If the same pole was edited on two phones, the newer copy of that pole wins. Individual answers are not merged.
- The guard against a woken tab writing old copies covers jobs, poles and photos, not settings (name and wording). And if one tab removes a record for good while a frozen tab still holds unsaved changes to it, the woken tab can put it back. Both need two tabs and a frozen one at the same moment.
- The first load fetches about 30 small files. On a weak signal that takes a few seconds.
