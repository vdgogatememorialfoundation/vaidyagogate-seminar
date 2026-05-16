# VGMF Scanner — Android APK

This wraps your **live** scanner page in a native Android shell (Capacitor). The app loads:

`https://YOUR-DOMAIN/scanner.html`

so you can update the scanner UI on the server without republishing the APK.

## Prerequisites

- Node.js 20+
- [Android Studio](https://developer.android.com/studio) with Android SDK
- JDK 17

## Setup (once)

```bash
cd scanner-mobile
npm install
```

Edit `capacitor.config.json` and set `server.url` to your live URL, for example:

```json
"server": {
  "url": "https://seminar.yourdomain.com/scanner.html",
  "cleartext": false
}
```

For local testing only:

```json
"url": "http://YOUR-PC-LAN-IP:3000/scanner.html",
"cleartext": true
```

## Build debug APK (quick test)

```bash
npx cap sync android
cd android
./gradlew assembleDebug
```

APK output:

`android/app/build/outputs/apk/debug/app-debug.apk`

Copy to staff phones and install (enable “Install unknown apps”).

## Build release APK (production)

1. Create a keystore (once):

```bash
keytool -genkey -v -keystore vgmf-scanner.keystore -alias vgmf -keyalg RSA -keysize 2048 -validity 10000
```

2. Add signing config in `android/app/build.gradle` (see [Capacitor Android docs](https://capacitorjs.com/docs/android)).

3. Build:

```bash
cd android
./gradlew assembleRelease
```

Release APK: `android/app/build/outputs/apk/release/app-release.apk`

## Permissions

The WebView needs **camera** for QR scanning. `AndroidManifest.xml` should include `CAMERA` (Capacitor adds this on sync).

## Notes

- Staff must use **scanner accounts** created in Admin → Staff users.
- HTTPS is required on production (`cleartext: false`).
- After changing `server.url`, run `npx cap sync android` and rebuild.
