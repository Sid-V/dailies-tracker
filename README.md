# Dailies Tracker

A tiny personal tracker for daily web games: [Catfishing](https://catfishing.net/) and [Farflung](https://farflung.game/) to start, plus a plain check-off item for the [LeetCode daily](https://leetcode.com/problemset/) and any other game you add. It shows today's games with Play links, logs when you finish (automatically, through a companion userscript), and keeps your streaks, scores and history in sync across desktop, iPhone and iPad.

- **No framework, no build step:** plain HTML/CSS/JS served by GitHub Pages.
- **Your data:** one `data.json` in a **private** GitHub repo that you own.
- **No game logins:** the companion script reads the result each game already saves in your browser.

```
GitHub Pages (this repo, public)              Private repo (e.g. dailies-data)
  index.html, js/, style.css   ── REST ──▶      data.json
                                   ▲
  Companion userscript ────────────┘  (runs on catfishing.net / farflung.game)
```

---

## One-time setup (~10 minutes)

### 1. Create the private data repo
On GitHub, create a new **private** repository, e.g. `dailies-data`. Tick "Add a README" so it has a default branch. The app creates `data.json` itself.

### 2. Publish the tracker on GitHub Pages
1. Create a repository for this code (e.g. `dailies-tracker`) and push this folder to it.
2. Go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then branch `main` and folder `/ (root)`.
3. After a minute it's live at `https://<you>.github.io/dailies-tracker/`.

> GitHub Pages on a free account requires the tracker repo to be public. That's fine: it holds only code. Your progress lives in the private repo.

### 3. Create a fine-grained access token
GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:

| Field | Value |
|---|---|
| Repository access | **Only select repositories** → `dailies-data` |
| Permissions → Repository → **Contents** | **Read and write** (Metadata: read is added automatically) |
| Expiration | up to 1 year; set yourself a reminder to renew it |

Copy the token (`github_pat_…`).

### 4. Connect the tracker
Open the tracker → **Settings → Sync (GitHub)** → fill in owner (your username), repo (`dailies-data`) and the token → **Save & test**. The status pill at the top shows **✓ Synced**.

Do this once in every browser you use: Helium on desktop, and Safari on iPhone/iPad.

### 5. Install the companion script (auto-logging)

**Desktop (Helium or any Chromium browser)**
1. Install **Violentmonkey** (or Tampermonkey) from the Chrome Web Store.
   - Tampermonkey on Chromium also needs: `chrome://extensions` → Tampermonkey → **Details** → turn on **Allow User Scripts**.
2. In the tracker, go to **Settings → Install companion script**. The extension opens an install page; click **Install**.
   - If Chrome/Helium says **"Apps, extensions, and user scripts cannot be added from this website"**, the manager didn't catch the link. Copy the script URL from Settings (`https://<you>.github.io/dailies-tracker/userscript/dailies-companion.user.js`) and paste it into Violentmonkey → **＋ → Install from URL** (Tampermonkey: **Dashboard → Utilities → Import from URL**).
3. Reload the tracker and accept the "Link Dailies Companion to the tracker at …" prompt. Settings now shows **✓ Detected in this browser**.

**iPhone / iPad (Safari)**
1. Install **Userscripts** (free) from the App Store, open it once and pick a folder for scripts.
2. iOS **Settings → Apps → Safari → Extensions → Userscripts**: turn it on and allow it on **All Websites** (or at least `catfishing.net`, `farflung.game` and your `github.io` site).
3. In Safari, open the tracker → **Settings → Install companion script**. Tap the Userscripts icon in the address bar and choose **Install**.
4. Reload the tracker in Safari and accept the link prompt.
5. Play the games **in Safari**. Other iOS browsers can't run userscripts.

> **iOS home-screen app:** in Safari, open the tracker → **Share** (□↑) → **Add to Home Screen** → **Add**. That app has its own storage separate from Safari, so enter the GitHub settings there too. The companion only runs in real Safari tabs. If **Play** opens the game in the home-screen app's built-in browser (no Safari address bar), tap the compass/Safari button to move it to Safari, or open the games from Safari directly. Otherwise auto-logging won't see them.

---

## Daily use
1. Open the tracker and tap **Play ↗** on a game.
2. Finish the puzzle. A small toast on the game page confirms it: "✓ Dailies: logged Catfishing 3/10".
3. Close the tab. When you come back, the tracker has already synced and the card says **✔ Done**.

If the companion isn't installed in that browser, you'll be asked to **Mark done** (with an optional score) when you return. You can also tap any day in a game's calendar to backfill, fix a score, or clear a day.

The first time the companion runs on a game it also imports **past days** that game has saved in that browser.

### How results are detected
| Game | Browser storage it reads | Done when | Score |
|---|---|---|---|
| Catfishing | `game-<N>`, where N counts days from 2024-06-23 in local time (`game-881` = 2026-11-21) | `s === 1` | correct answers out of 10 |
| Farflung | `farflung:record:v1:<profile>:log:YYYY-MM-DD` (rounds) and the matching `:run:` record | run is `done`, or 5 rounds are logged | sum of each round's `pts` |

The companion never overwrites a day you edited or cleared by hand.

### Streak rules
- A streak is consecutive days with the game done. If you haven't played yet today, the streak is shown in orange as **at risk**; it only breaks once the day is over.
- The **all-dailies** streak counts days on which every active game was done. A game only counts from the day you added it, so adding a new game doesn't reset the streak.

---

## Adding another game
**Settings → Games → ＋ Add a game**: name, URL, emoji, score label and max (e.g. `correct` out of `10`). It appears on Today with manual **Mark done**.

For habits with no score (like the built-in **LeetCode daily**), tick **Done / not done only (no score)**. The card's **Mark done** then checks it off in one tap, the score fields and stats are hidden, and it counts toward the all-dailies streak and reminders from the day it was added.

To auto-detect a new game, add a detector to [userscript/dailies-companion.user.js](userscript/dailies-companion.user.js):
1. Add its domain to the `// @match` lines.
2. Write a `detectX(store)` function that returns `[{ gameId, day: 'YYYY-MM-DD', score, details? }]` from the site's `localStorage`. Find the keys in DevTools → Application → Local Storage.
3. Register it in `DETECTORS`, add its id to `DETECTORS` in [js/model.js](js/model.js), and pick it under **Auto-detect** in Settings.
4. Bump `@version` so userscript managers update it.

---

## Data format (`data.json`)
```json
{
  "version": 1,
  "games": [{ "id": "catfishing", "name": "Catfishing", "url": "https://catfishing.net/", "emoji": "🐟",
              "score": { "label": "correct", "max": 10 }, "detector": "catfishing", "order": 0,
              "archived": false, "updatedAt": "…" }],
  "entries": [{ "gameId": "catfishing", "day": "2026-11-21", "score": 3, "source": "auto",
                "details": { "puzzle": 881, "correct": 3, "close": 0, "skipped": 6, "wrong": 1 },
                "loggedAt": "…", "updatedAt": "…" }]
}
```
- An entry means the game was done that day. Cleared days become `{ "deleted": true }` tombstones so the deletion wins on other devices.
- Devices merge per game and day, and the newest `updatedAt` wins. Writes use the file's `sha` and retry on conflict, so two devices can't overwrite each other.
- **Settings → Backup** exports or imports this JSON. Importing merges; it never deletes.

---

## Privacy & security
- The token lives only in your browsers' local storage and the userscript manager's storage. It can touch only the one private repo.
- Every `*.github.io/<repo>` site you own shares the same browser origin, so don't host untrusted code on your `github.io` site.
- The tracker ships a strict Content-Security-Policy (no third-party scripts; network access to `api.github.com` only).
- If a token leaks, revoke it in GitHub settings and paste a new one.

## Troubleshooting
- **"Open your tracker once in this browser to link"** (toast on a game site): open the tracker in the same browser and accept the prompt.
- **⚠ Sync error / Token rejected:** the token expired or was revoked. Create a new one and enter it in Settings (the companion picks it up the next time you open the tracker).
- **A game stopped auto-logging:** the game probably changed how it stores results. Use Mark done and update the detector.

## Reminders (ntfy)
A GitHub Actions workflow in the **private data repo** reminds you at **8:30 AM and 8:30 PM Pacific**. If a game isn't done yet today, it sends a push notification through [ntfy](https://ntfy.sh). The notification lists what's left, shows any streak at risk, and has **Play** buttons. Tapping it opens the tracker. Nothing is sent once everything is done.

**Why an external trigger:** GitHub's built-in cron is too unreliable for timed reminders. In practice the runs came hours late, about twice a day. Runs started on demand (`workflow_dispatch`) begin within a minute, so a free external scheduler starts the workflow at 8:30 with `slot=morning` or `slot=evening`. The script sends **at most one reminder per window** (it checks the ntfy topic's recent messages), so duplicate triggers and the leftover GitHub cron backup are harmless.

Setup:
1. Pick a hard-to-guess topic name, e.g. `dailies-<random letters>`. Anyone who knows it can read and post to it, so treat it like a password.
2. Install the **ntfy** app (App Store) on your iPhone/iPad, tap **＋**, and subscribe to that topic on `ntfy.sh`. Allow notifications.
3. In the data repo: **Settings → Secrets and variables → Actions → New repository secret**, name `NTFY_TOPIC`, value = your topic.
4. Copy [reminders/reminders.yml](reminders/reminders.yml) to `.github/workflows/reminders.yml` in the data repo.
5. Test it: data repo → **Actions → Daily reminders → Run workflow**, tick **test**. It always sends.
6. Set up the 8:30 trigger (below).

### The 8:30 trigger
**Token:** create a second fine-grained token (GitHub → Settings → Developer settings → Fine-grained tokens): **Only select repositories → `dailies-data`**, permission **Actions: Read and write**, nothing else. It can only start workflows; it can't read or change your data.

**Option A: [cron-job.org](https://cron-job.org) (free, recommended, works even if your phone is off).** Create two cron jobs:

| Field | Morning job | Evening job |
|---|---|---|
| URL | `https://api.github.com/repos/Sid-V/dailies-data/actions/workflows/reminders.yml/dispatches` | same |
| Schedule | every day at **08:30** | every day at **20:30** |
| Time zone (Advanced) | `America/Los_Angeles` | same |
| Request method (Advanced) | **POST** | POST |
| Headers (Advanced) | `Authorization: Bearer <token>`<br>`Accept: application/vnd.github+json`<br>`Content-Type: application/json` | same |
| Request body | `{"ref":"main","inputs":{"slot":"morning"}}` | `{"ref":"main","inputs":{"slot":"evening"}}` |

Use **Test run** in cron-job.org. A `204` response means GitHub accepted it, and a run appears under the data repo's **Actions** tab.

**Option B: iOS Shortcuts (no new account, but runs on your phone).** Shortcuts → **Automation → ＋ → Time of Day 8:30 AM, Daily → Run Immediately**. Add the action **Get Contents of URL** with the same URL, Method **POST**, the three headers, and a JSON request body `ref` = `main`, `inputs` = dictionary with `slot` = `morning`. Repeat for 8:30 PM with `evening`.

To change the times, change the trigger times and `SLOTS` in [reminders/remind.js](reminders/remind.js). To change the time zone, edit `REMINDER_TZ` in the workflow and the trigger's time zone.

### If reminders don't arrive
1. **Did a run happen at 8:30?** Check the data repo's **Actions** tab. No run means the trigger isn't firing: look at cron-job.org's history, or check whether the token expired.
2. **What did the run say?** Open the run → **Send reminder** step:
   - `Sent (morning): …`: it was sent, so check the phone side (next step).
   - `Nothing to remind about`: everything was already done.
   - `already sent`: a duplicate trigger (fine).
   - `Outside reminder windows`: the run started at the wrong time.
3. **Phone side:** run the workflow with **test** ticked. If that doesn't arrive, check iOS **Settings → Notifications → ntfy** (allowed, not in a Focus mode that silences it) and that the app is subscribed to exactly the same topic on `ntfy.sh`.

## Development
```powershell
npm test                     # unit tests (Node 20+, no dependencies)
python -m http.server 8000   # then open http://localhost:8000
```
