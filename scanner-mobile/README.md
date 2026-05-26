# VGMF Seminar Scanner — Android APK

Native Android shell (Capacitor) for **seminar check-in and book pickup only**.  
Loads the live scanner from:

`https://seminar.vaidyagogate.org/scanner.html?app=seminar`

This is **not** the autism/ABA portal APK. It uses package id `org.vaidyagogate.seminar.scanner` and blocks navigation to other hosts.

## Features in the app

- Seminar e-ticket check-in (QR scan)
- Book pickup mode (Agnikarma / Viddhakarma orders)
- Scanner staff login only (`scanner_portal_user` accounts from Admin → Staff users)

## Prerequisites

- Node.js 20+
- [Android Studio](https://developer.android.com/studio) with Android SDK
- JDK 17

## Quick build (from repo root)

```bash
npm run build:scanner-apk
```

Output: `dist/VGMF-Seminar-Scanner-debug.apk`

## Manual build

```bash
cd scanner-mobile
npm install
npx cap sync android
cd android
gradlew.bat assembleDebug
```

APK: `scanner-mobile/android/app/build/outputs/apk/debug/app-debug.apk`

## Production release APK

1. Create a keystore (once):

```bash
keytool -genkey -v -keystore vgmf-seminar-scanner.keystore -alias seminar_scanner -keyalg RSA -keysize 2048 -validity 10000
```

2. Configure signing in `android/app/build.gradle` ([Capacitor docs](https://capacitorjs.com/docs/android)).

3. `cd android && gradlew.bat assembleRelease`

## Install on phones

1. Copy the APK to the device.
2. Enable “Install unknown apps” for your file manager.
3. Open the APK and install.
4. Sign in with a **scanner** staff account created in the seminar admin panel.

## Updating the app

Most UI/logic is loaded from the server. After deploying web changes, staff usually only need to refresh (pull to refresh in WebView) or reopen the app — **no new APK** unless you change `capacitor.config.json` or native permissions.

If you change `server.url`, run `npx cap sync android` and rebuild the APK.

## Local testing

Point `capacitor.config.json` → `server.url` to your LAN server, e.g.:

```json
"url": "http://192.168.1.10:3000/scanner.html?app=seminar",
"cleartext": true
```

Then `npx cap sync android` and rebuild.
