# VGMF Admin Android app

The app loads the admin panel from:

**https://seminar.vaidyagogate.org/admin.html**

Do **not** use `https://admin.vaidyagogate.org` as the Capacitor `server.url` (legacy DNS only redirects to the URL above).

## Rebuild APK after URL changes

```powershell
cd D:\SeminarSystem
node scripts\sync-mobile-capacitor.js
# or full build:
.\scripts\build-portal-apks.ps1
```

Install the new `VGMF-Admin-debug.apk` from the repo root.
