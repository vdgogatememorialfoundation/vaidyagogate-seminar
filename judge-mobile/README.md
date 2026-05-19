# VGMF Judge Android app

The app loads the judge portal from:

**https://seminar.vaidyagogate.org/judge.html**

Do **not** use `https://judge.vaidyagogate.org` as the Capacitor `server.url` (legacy DNS only redirects to the URL above).

## Rebuild APK

```powershell
cd D:\SeminarSystem
node scripts\sync-mobile-capacitor.js
# or:
.\scripts\build-portal-apks.ps1
```

Install `VGMF-Judge-debug.apk` from the repo root.
