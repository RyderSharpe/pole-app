# iPhone test

About 30 minutes. Use made-up data only.

The automated tests ran in a desktop browser. This list covers what only a real iPhone can show. Write down the iPhone model, its iOS version, and the result of every step.

**Stop and report if any step marked "must" fails.**

## 1. Install

| # | Do this | Expect | Must |
|---|---|---|---|
| 1.1 | Open the address in **Safari** | The job list appears, with no error | Yes |
| 1.2 | Read the yellow notice | It says to add the app to the Home Screen first | |
| 1.3 | Share button, **Add to Home Screen**, Add | An icon with a white pole on green | Yes |
| 1.4 | Open the app from the icon | No Safari address bar | Yes |
| 1.5 | Settings | "Works with no signal: Yes" and "On the Home Screen: Yes" | Yes |
| 1.6 | Settings, Storage | A size is shown, or "This phone does not report it". No error either way | |

## 2. Record with no signal

Turn on Airplane Mode. Close the app fully (swipe it away), then open it from the icon.

| # | Do this | Expect | Must |
|---|---|---|---|
| 2.1 | Open the app | It opens. The banner says "No signal" | Yes |
| 2.2 | New job, fill in details, Next: Pole 1 | The keyboard does not cover the field being typed in | |
| 2.3 | Tap a height field | A number keypad with a decimal point | |
| 2.4 | Type 9.4, 8.1, 7.9, 6.2 in the four heights | Separations show 1.30, 0.20, 1.70, 7.90 | Yes |
| 2.5 | Type 62 in the telecom height | A "usually 3 to 15 m" warning, and a negative separation in a warning colour | |
| 2.6 | Double-tap "Next" quickly | It moves one step, not two | |
| 2.7 | Tap an answer (say "Good"), then tap it again straight away | The answer stays chosen | |
| 2.8 | Step 1, "Record this pole's position", outdoors | A position within a minute. Note the accuracy | Yes |
| 2.9 | While it is still searching, go back and add another pole | The second pole shows no position | Yes |

## 3. Photos

| # | Do this | Expect | Must |
|---|---|---|---|
| 3.1 | Photos step, Take photo, hold the iPhone upright | The camera opens. After the shot, the app is still on the photos step | Yes |
| 3.2 | Look at the small picture | It is the right way up | Yes |
| 3.3 | Take another with the iPhone on its side | Also the right way up | Yes |
| 3.4 | Choose, pick three photos from the library | All three appear | |
| 3.5 | Tap a photo, set a label, tap the dim area above the sheet | The sheet closes. The label shows on the photo | |
| 3.6 | Take five photos in a row, quickly | All five are there | Yes |
| 3.7 | Type notes straight after taking a photo | The keyboard stays up. No sheet pops over it | |

## 4. Leaving and coming back

| # | Do this | Expect | Must |
|---|---|---|---|
| 4.1 | Type in a field, then swipe up to the Home Screen at once | | |
| 4.2 | Open the app again | The text is there | Yes |
| 4.3 | Type in a field, then swipe the app away at once. Open it again | The text is there | Yes |
| 4.4 | Lock the iPhone for 10 minutes mid-pole. Unlock | The same screen, nothing lost, status "Saved" | Yes |
| 4.5 | Restart the iPhone. Open the app | Every pole and photo is there | Yes |

## 5. Getting the report to your laptop

Turn Airplane Mode off.

| # | Do this | Expect | Must |
|---|---|---|---|
| 5.1 | Open the job, Export this job, **PDF report** | "File is ready" within a few seconds | Yes |
| 5.2 | Save or share the file, then **AirDrop** it to your Mac, or **Mail** it to yourself | The share sheet opens. After it is sent, the job says "Exported" | Yes |
| 5.3 | Start again, open the share sheet and cancel it | The job still says "Waiting" or "Changed" | Yes |
| 5.4 | Open the PDF on the laptop | A first page with the job details and a list of poles, then a page for each pole with its answers and photos, upright | Yes |
| 5.5 | Print one page of it | It fits a Letter page | |
| 5.6 | Export again as Full package, Save to Files | A ZIP. It opens. Photos inside are full size | |
| 5.7 | Settings, Save a backup file, Save to Files | A ZIP is saved. "Last backup" shows the time | Yes |
| 5.8 | Settings, Copy details | "Details copied", or a sheet with the text | |

## 6. Restore and delete

| # | Do this | Expect | Must |
|---|---|---|---|
| 6.1 | Delete a job. Tap Undo | It comes back | |
| 6.2 | Delete it again. Settings, Recently deleted, Bring back | It comes back with its photos | Yes |
| 6.3 | Settings, Restore from a backup file, pick the backup | "Everything in the file was already on this phone" | Yes |
| 6.4 | In Safari (not the Home Screen app), restore the same backup | All jobs, poles and photos appear | Yes |

## 7. Updates and tabs

| # | Do this | Expect | Must |
|---|---|---|---|
| 7.1 | Publish a small change (see the README), open the app with signal, Settings, Check for update | An Update button within a minute | |
| 7.2 | Tap Update | The app reloads. All data is there | Yes |
| 7.3 | In Safari (not the Home Screen app), open the address in two tabs | The second tab says "Already open" | |

## 8. A week later

| # | Do this | Expect | Must |
|---|---|---|---|
| 8.1 | Leave the Home Screen app unopened for 8 days. Open it | Every pole and photo is still there | Yes |

Step 8.1 matters. Safari can clear a website's storage after 7 days without use. Apps added to the Home Screen are meant to be exempt. This test confirms it for this app on your iPhone.

## What to send back

- The iPhone model and its iOS version.
- The number of every step that failed, and what happened.
- For anything odd: Settings, Copy details, and paste the text.
