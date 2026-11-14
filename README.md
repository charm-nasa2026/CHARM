# C.H.A.R.M. live app (Firebase)

Crew Health Assessment and Response Module, NASA Space Apps 2026.
This is the live version: real data on a server, with no simulated data built in.

## What runs where

| Part | Where | What it does |
|---|---|---|
| Web app | Firebase Hosting (`public/`) | The C.H.A.R.M. interface. It reads live data from Firestore and works offline from its local copy. |
| `api` | Cloud Function (callable) | Handles every write: measurements, guided tests, CSV import, thresholds, crew, mission, messages, demo scenario. It checks each value against plausible ranges and updates alert status. |
| `tick` | Cloud Function (every 5 min) | Clears alerts after 3 checks back in range, flags silent wearables, raises cabin CO₂ and radiation alerts, moves the Earth outbox, and pulls real space weather from NOAA SWPC (GOES ≥10 MeV protons). |
| Database | Firestore | Collections: `crew`, `mission`, `overrides`, `readings`, `env`, `status`, `events`, `outbox`, `inbox`. All data is append-only. |

The server logic lives in `shared/engine.js` and `shared/core.js`. The browser uses the same files, so the levels on screen match the server exactly. **Edit them only in `shared/`.** On each deploy, `tools/sync-shared.js` copies them into `functions/` and `public/js/`.

## Starting state
- Nine crew profiles are created on first start: Sarah, Marcus, Mei, John, Elena, David, Robert, Maya and Amara (name, agency, role and photo). If the database already exists, the next start (or the 5-minute server check) adds any missing ones.
- There are **no health readings**. To get data in, use one of these:
  - **Add measurement** (left menu, the astronaut file, or each metric page)
  - **Guided tests** (blood pressure, glucose, ECG, reaction time)
  - **Import data** (CSV templates for NASA, ESA, JAXA and CSA in `public/assets/templates/`)
  - **Settings › Demo › Load demo scenario** (for the judges' demo). It writes about 3 hours of readings tagged `DEMO`:
    - Sarah: irregular rhythm, CRITICAL
    - Marcus: short sleep, CAUTION
    - Elena: wearable silent, NO DATA
    - Cabin CO₂ rising

## Laptop / tablet view
The button next to the gear wheel switches between laptop and tablet view. Tablet view has bigger touch targets, a collapsed menu and fewer cards per row. The choice is saved on the device. On a touch screen narrower than 1400 px, tablet view turns on automatically.

## Data (`data/`)
Real crew files (NASA bed rest, Inspiration4, CSA stream), two demo scenarios (red alert, caution), and reference tables. Import them with **Import data**. See `data/README.md` for sources, the load order (set today to Mission Day 60 first) and the personal alert limits. Rebuild them with `python3 tools/build_crew_csv.py <charm_db folder> data`.

## Startup intro (6 s)
`public/assets/intro.mp4`: the C.H.A.R.M. clip, compressed to 3.2 MB at 1080p. It plays over the app while the app loads underneath.
- **Shown** when this device has not opened CHARM in the last 8 hours. The device stores `charm-last-active` and refreshes it every 5 minutes while the app is open.
- **Not shown** when an emergency was open the last time this device ran CHARM (`charm-emergency-open`), or when the device has reduced motion turned on.
- **Closes at once** if an emergency opens while it plays: a crew member goes CRITICAL or Emergency Mode starts.
- Starts with sound. If the browser blocks autoplay with sound (usually on a first visit, before any click on the site), it plays muted instead and shows **Sound on**. Skip with **Skip**, a tap anywhere, Escape or Enter. It never blocks the app for more than 12 s.
- Testing: `?intro=1` always shows it; `?nointro` never shows it.

## Deploy (first time)
Run these in WSL, in this folder:

1. In the Firebase console, open project **charm-b9fd1** and upgrade to the **Blaze** plan. Cloud Functions need Blaze; your Google Cloud credit pays for it.
2. In the console, go to **Firestore Database › Create database**. Choose production mode and region `us-central1` (or `nam5`).
3. Install and log in:
   ```bash
   cd functions && npm install && cd ..
   firebase login          # sign in with charm.nasa@gmail.com
   ```
4. Deploy everything:
   ```bash
   firebase deploy
   ```
   This uploads hosting, both functions, the Firestore rules and the indexes. The first deploy takes a few minutes and may ask to enable APIs; answer **y**.
5. Open `https://charm-b9fd1.web.app`. The crew appears within a few seconds.

Later updates: `firebase deploy`, or `firebase deploy --only hosting` if you changed only the web app.

## Test without Firebase
```bash
cd public && python3 -m http.server 8000
# open http://localhost:8000/index.html?backend=local
```
`?backend=local` runs the same server code inside the browser, with memory storage. Nothing is saved. Use it for screenshots and the video.

`?emulator` connects to the Firebase emulators (`firebase emulators:start`).

## Rebuild the Firebase browser bundle (rarely needed)
`cd tools && npm install && npm run build` writes `public/js/firebase.js`. Deploying does not need this; the built file is included.

## Server tests
`node --test test/core.test.js`

## Security note (read before real astronaut data)
There is **no sign-in** (team decision for the demo).
- Firestore rules let anyone with the link **read** the data. Nobody can write directly; all writes go through the `api` function.
- The "Who is using this device" choice only labels entries. It is not a login.
- Before real medical data: add Firebase Authentication, limit reads to the crew and flight surgeons, and check the callable's `req.auth`.

## Not included yet
- Live link to an Earth ground station. The Earth link uses loopback: each record is acknowledged after 2 × the one-way light time. **Test link loss** in the Earth link page cuts it.
- Direct pairing with a watch or wearable. Use CSV import or manual entry.
- Voice input.

Thresholds are demo values and need review by a flight surgeon.
