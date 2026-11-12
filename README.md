# Pole Field Data

A phone app for recording utility pole field data where there is no cell signal.

- It is a web app. It installs to the Home Screen and then opens like any other app.
- Everything is saved on the phone. Nothing is sent anywhere unless you export it.
- Version 0.4.0.

## Where it stands

| Question | Answer |
|---|---|
| Does it work? | Yes, in a desktop browser set to phone size. 120 fast checks and 66 walk-throughs pass. |
| Has it run on a real phone? | **No. It has not run on an iPhone yet.** |
| Which phones? | iPhone only (iOS 15.4 or newer). Other phones are not tested. |
| Can real field data go in it yet? | No. See "Use made-up data for now". |
| What is the next step? | The 30-minute phone test in `docs/PHONE-TEST.md`. |

## What it does

| Area | What you get |
|---|---|
| Works offline | Opens and records with no signal, after one visit with signal |
| Jobs and poles | A job holds its poles. Each pole is filled in over 6 short steps |
| Calculations | Wire separations are worked out as you type |
| Checks | Warns about a mismatched tag, a repeated tag, an unreadable number, a slipped decimal point, a negative separation, a poor GPS reading |
| N/A logic | Questions that do not apply (anchor details when there is no anchor, for example) show N/A |
| Before you save | The last step lists what is still blank and what needs a second look. Tap an item to jump to it |
| Photos | Camera or library, labelled, stored on the phone in three sizes |
| GPS | One tap records the pole's position. Works with no signal |
| Span diagram | On the Spans step: a view from above with this pole in the middle and a line to each pole it connects to. Turn a line by dragging its end, by typing an angle, or from the GPS positions of both poles. The angles between spans and the angle of deflection are worked out |
| Sketch pad | Draw a pole with a finger and label each wire, for poles the questions do not cover. Or draw on top of a photo. Sketches are kept with the photos |
| Export | A PDF report with photos, to AirDrop or email to a laptop. Or a ZIP with the report, the raw data, a CSV file and full-size photos |
| Honest status | A job only says "Exported" after the file has really left the app |
| Backup | One file holds everything. Restore it on the same phone or a new one. Restore never deletes |
| Recently deleted | Deleted jobs, poles and photos can be brought back for 30 days |
| Safe updates | A new version never takes over in the middle of your work |

## Use made-up data for now

Until you have written permission to keep real field data on this phone and on this host:

- Enter made-up data only.
- Do not sign in to, or connect, any work account.
- Use your own phone, your own computer and your own time.

## Put it on a phone

It needs a web address that starts with `https://`. GitHub Pages is one free way.

1. Create a repository on GitHub and upload everything in this folder.
2. In the repository: **Settings**, then **Pages**. Under "Build and deployment" choose **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
3. Wait a minute. GitHub shows the address, like `https://yourname.github.io/your-repo/`.
4. On the iPhone, open that address in **Safari**.
5. **Add it to the Home Screen before recording anything.** Share button, then "Add to Home Screen".
6. Open it from the Home Screen once while you still have signal.
7. In the app: **Settings**. "Works with no signal" must say **Yes**.

Notes:

- On the free GitHub plan the repository has to be public for GitHub Pages, so anyone can read the code. A paid plan allows a private repository. Check GitHub's current rules.
- On an iPhone, poles saved in Safari do **not** move to the Home Screen app. They are two separate stores. Use a backup file to move them.
- Every site published under one GitHub account shares one web address (`yourname.github.io`), and so one storage area on the phone. Publish nothing else under the account that hosts this app, or give the app its own domain.
- An iPhone needs iOS 15.4 or newer. That is an expectation from the features used, not a test result.

## A day in the field

1. **New job.** Fill in the location and other job details once.
2. **Next: Pole 1.** Work through the 6 steps. Skip what does not apply.
3. **Save pole.** Then **Add pole** for the next one.
4. Back in service: open the job, **Export this job**, choose **PDF report**, then **Save or share the file**. AirDrop it to your Mac, or Mail it to yourself.
5. When the app asks "Did the file save?", check, then answer.

The first screen always shows how many poles are still only on the phone.

## What is in the export

| File | Contents |
|---|---|
| PDF report | A first page with the job details and a list of the poles, then a page for each pole: every answer, the separations, what to check, the span diagram, and its photos and sketches. Letter size, ready to print |
| Full package (ZIP) | The PDF report, `data.json` (every answer, for a program to read later), a CSV file, and every photo at full size |

- Numbers are stored as numbers. Tags and design numbers are stored as text, so leading zeros survive.
- An entry the app could not read as a number is exported exactly as typed.
- Questions left blank are not listed on a pole's page. A "Check these" box names the ones that should have an answer.
- The report uses fonts every PDF reader has. They hold the usual Latin letters, accents included. A character they lack (an emoji, say) prints as "?".
- `data.json` is the way into a future web page or program. The CSV file opens in a spreadsheet; it can lose leading zeros if opened directly in Excel.

## Company names

The questions say "Power" and "Telecom" until you set your own names in **Settings**. The names stay on the phone.

## If something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Red banner "The phone is not saving" | The phone refused the last save, usually because it is full | Keep the app open. Export or back up now: the file includes what is on screen. Free up space, then tap **Try again** |
| "Already open" | The app is open in another tab or window | Use that one, or tap **Use it here**. Nothing is lost |
| "Changed in another tab" | Another tab saved newer entries. This tab stopped saving so it could not overwrite them | Reload |
| "Open the app on its own" | Another page is showing the app inside itself. The app will not run there | Tap **Open the app** |
| "Reload needed" | A newer version of the app has taken over | Reload |
| A photo shows "Cannot read photo" | The phone lost that picture | Take it again. Exports tell you when a photo is missing |
| You deleted something by mistake | It is in **Settings**, **Recently deleted**, for 30 days | Tap **Bring back** |

Back up before anything risky: **Settings**, **Save a backup file**.

## Changing the form

The whole form is described in one file: `src/template.js`. Add, remove or reword questions there. No screen code has to change.

After any change:

```
npm test         # 120 fast checks, including one that checks the form for mistakes
npm run build    # rewrites sw.js so phones notice the update
```

Then upload the changed files. Phones show an **Update** button the next time they have signal.

`npm` needs [Node.js](https://nodejs.org) 20 or newer. If `sw.js` is not rebuilt, phones keep the old version. A test fails if you forget.

## Tests

| Command | What it does | Needs |
|---|---|---|
| `npm test` | 120 fast checks of the calculations, form rules, PDF and file writers, restore rules and security rules | Node.js |
| `npm run e2e` | 66 walk-throughs of the real app in a phone-sized browser. Exported files are then opened with other programs (poppler, qpdf, pypdf, Pillow) | Playwright with Chromium, Python 3 with `pypdf` and `Pillow`, and the `poppler-utils` and `qpdf` programs |
| `npm run serve` | Runs the app at `http://localhost:8080` | Node.js |

Measured in desktop Chromium with 40 poles and 120 photos: 70 MB of storage, PDF report 10 MB (122 pages) built in about 1.5 seconds, full package 69 MB in about 3 seconds, backup 69 MB in about 3 seconds. An iPhone will be slower.

## What has not been done

- **No test on a real iPhone.** Use `docs/PHONE-TEST.md`.
- The PDF report has been read by poppler, qpdf and pypdf, not yet by the iPhone's own viewer or by Preview or Adobe Reader on a laptop.
- No automatic upload, no accounts, no shared team data. Export and backup are by hand.
- No security review by anyone other than the author.
- The usual ranges behind "check the entry" warnings (for example 5 to 22 m for the primary bolt) are the author's estimates, not a published standard. Change them in `src/template.js`.

See `docs/ROADMAP.md` for the full list, and `docs/ARCHITECTURE.md` for how the code is built.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `styles.css` | The page and its look |
| `src/template.js` | The form, written as data |
| `src/` | The app code. Each file starts with a note on what it does |
| `sw.js` | Keeps the offline copy. Partly generated by `npm run build` |
| `manifest.webmanifest`, `icons/` | Lets the app install to the Home Screen |
| `fonts/` | IBM Plex typeface (SIL Open Font Licence 1.1) |
| `tests/`, `tools/`, `docs/` | Tests, build tools and notes. Not needed on the phone |

## Licences of the parts that are not ours

See `THIRD-PARTY-NOTICES.md`.
