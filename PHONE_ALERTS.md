# Phone alerts (CHARM)

Who gets what:
- **CRITICAL (red)** and Emergency Mode: every registered phone.
- **CAUTION (orange)**: only the phone of the astronaut the alert is about. Cabin alerts (CO₂, radiation) go to every phone.
- A phone belongs to whoever is picked in **Who are you?** / Settings › Who is using this device. The shared display gets red alerts only.
- Imported history (replayed alerts) never sends. Yellow (ATTENTION) never sends.

Tapping the notification opens CHARM on a full-screen alert in its colour (red or orange), with buttons to open the astronaut's file (privacy check applies) or Alerts and history.

## Setup (once)
1. Firebase Console › Project settings › **Cloud Messaging** › Web Push certificates › **Generate key pair**.
2. Copy the **public** key into `public/js/push-config.js`: `window.CHARM_VAPID_KEY = '...';`. It is meant to be public. Never put a private key or a service-account file in the repo.
3. Deploy: `firebase deploy --only hosting,functions`.
4. If sending fails with a permission error, enable **Firebase Cloud Messaging API (V1)** in Google Cloud Console › APIs & Services for project `charm-b9fd1` (usually on already).

## On each phone
- **Android (Chrome):** open charm2026.health › Settings › Who is using this device › **Get alerts on this phone** › Allow. Then **Send a red test**.
- **iPhone (iOS 16.4 or later):** in Safari, Share › **Add to Home Screen**. Open CHARM from the new icon, then Settings › Who is using this device › **Get alerts on this phone** › Allow.

## Cost
Firebase Cloud Messaging has no cost. Sending runs inside the existing Cloud Function calls; phone registrations are a few Firestore documents. In practice $0.

## Files
`public/charm-sw.js` (service worker: shows the notification, opens the alert screen), `public/manifest.webmanifest` + `public/assets/icon-*.png` (install on the Home Screen), `public/assets/alert-*.png` (notification icons), `public/js/push-config.js` (public Web Push key), `tools/fb-entry.js` (Firebase bundle now includes Messaging), server: `shared/core.js` (`pushRegister`, `pushUnregister`, `pushTest`, `notify`), `functions/index.js` (sending with the Admin SDK). Phone tokens are stored in the Firestore collection `push`, which the app cannot read (firestore.rules).
