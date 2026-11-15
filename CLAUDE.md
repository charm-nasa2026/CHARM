# CHARM live app – notes for Claude Code

Read README.md first. Key rules:

- Server logic: `shared/engine.js` (levels, freshness, hysteresis, validation, mission geometry) and `shared/core.js` (api ops, tick, demo). These are UMD/ES5 files shared by the Cloud Functions and the browser. Edit them only in `shared/`. Run `node tools/sync-shared.js` to copy them, then `node --test test/core.test.js`.
- `functions/index.js` is the Firestore adapter for core.js, plus the `api` callable, the `tick` schedule and the NOAA fetch.
- `public/index.html` is the whole UI as one file. `public/js/backend.js` connects it to Firebase, or to local memory with `?backend=local`.
- Writes go only through `api`. Firestore rules deny all client writes. Data is append-only; never edit or delete readings.
- There is no simulated data in the app. The demo scenario is a server op (`runDemo`), and its readings are tagged `src:'demo'`.
- Product rules:
  - English only in the UI.
  - No agency logos.
  - The AI assistant is "Charmy" (never "bot").
  - No gamification.
  - Status is always color + word + shape (NORMAL / ATTENTION / CAUTION / CRITICAL / NO DATA). Levels in code: -1, 0, 1, 2, 3. Thresholds for the six conditions are in data/reference/charm_alert_rules.csv; keep engine.js in step with it.
  - Stale data is never green.
- Personal bands come from the team's model (`charm_model/`) via `tools/build_model_profiles.py` into the `MODEL` block of `shared/engine.js`. They may only ADD an ATTENTION; never loosen common limits or move CRITICAL ones.
- Access: astronauts see only their own data (status of others); the doctor signs in (`isDoc`, `canSee` in index.html). It is a screen lock, not security.
- Never handle credentials. Deploy with the user's own `firebase login` (project charm-b9fd1).
- Test locally: serve `public/` and open `index.html?backend=local`.
