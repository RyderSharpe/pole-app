# Third-party notices

The app includes these parts written by others. Their licences allow use in a commercial product, as long as the notices below stay with the app.

| Part | Version | Licence | Where | Licence text |
|---|---|---|---|---|
| IBM Plex Sans | via @fontsource 5.3.0 | SIL Open Font Licence 1.1 | `fonts/ibm-plex-sans-*.woff2` | `fonts/LICENSE-IBM-Plex-Sans.txt` |
| IBM Plex Mono | via @fontsource 5.3.0 | SIL Open Font Licence 1.1 | `fonts/ibm-plex-mono-*.woff2` | `fonts/LICENSE-IBM-Plex-Mono.txt` |

Notes:

- The PDF report uses the fonts built into every PDF reader (Helvetica and Courier), so no font is stored in a report. The character widths in `src/pdf-metrics.js` were taken from Adobe's published font metric (AFM) files by `tools/make-pdf-metrics.py`. Adobe allows those files to be used and copied for any purpose without charge.
- The font files are unmodified. The Open Font Licence does not allow the fonts to be sold on their own.
- Nothing else in the app comes from an outside source. The PDF writer, ZIP writer, CSV writer, icons and all screens were written for this app.
- The licence texts are stored on the phone with the app, and are linked from **Settings**, **About and licences**.

This file is a summary, not legal advice.
