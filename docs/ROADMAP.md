# What is done, and what is not

## Done in version 0.3.0

| Area | State |
|---|---|
| Recording jobs and poles with no signal | Done |
| Calculations, warnings, N/A logic, "before you save" list | Done |
| Photos with labels, GPS | Done |
| PDF report, CSV, full package | Done |
| Backup and restore | Done |
| Recently deleted (30 days) | Done |
| Safe updates, two copies under one address | Done |
| One tab at a time | Done |
| Carrying data over from the first version | Done |
| Automated tests | 109 fast checks, 63 walk-throughs in Chromium |

## Before any real field use

Do these in order. Stop at the first one that fails.

| # | Step | Why |
|---|---|---|
| 1 | Run `docs/PHONE-TEST.md` on an iPhone | Nothing has run on a real iPhone yet |
| 2 | Open an exported PDF on the iPhone and on a laptop, and print a page | Only poppler, qpdf and pypdf have read one |
| 3 | Use it for a week with made-up poles, including a day with no signal | Finds what a checklist cannot |
| 4 | Have the "usual range" numbers in `src/template.js` checked by someone who knows the standards | They are estimates |
| 5 | Get written permission before any real job data goes onto a phone or a host | See the README |

## Not built

| Feature | Notes |
|---|---|
| Automatic upload | Would need a server, accounts and a security review |
| Sharing jobs between people | Today: export, or a backup file |
| Sign-in | None. Anyone holding the phone can open the app |
| Editing the form inside the app | Today the form is changed in `src/template.js` |
| More than one form | The engine allows it. The screens assume one |
| Maps | GPS is recorded as numbers only |
| Voice notes, video | Not started |
| Languages other than English | Not started |

## Before selling it

This list is about the product, not the code.

| Question | Why it matters |
|---|---|
| Who owns the app? | Check your employment agreement and your employer's code of conduct before offering it to anyone. Get the answer in writing |
| Who else sells this? | Established products exist for pole data collection and joint use. A buyer will compare |
| Who supports it? | A buyer expects fixes, updates and someone to call |
| Has anyone reviewed the security? | A utility will ask for an independent review |
| How is data shared and kept? | Buyers expect accounts, sync, and data on their own servers |
| Can it be managed on company phones? | Many companies only allow apps they can install and remove centrally |

## Known rough edges

- The CSV file is for other programs. Opened directly in Excel it can lose leading zeros.
- On a phone turned on its side the header and footer scroll with the page.
- A backup with several hundred photos may be too large for an older phone to build.
