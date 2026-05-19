# Build VGMF portal debug APKs (Admin, Judge, Doctor, Scanner)
# Requires: Node.js, JDK 17+, Android SDK

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$portals = @(
    @{ Dir = "admin-mobile";   Out = "VGMF-Admin-debug.apk" },
    @{ Dir = "judge-mobile";   Out = "VGMF-Judge-debug.apk" },
    @{ Dir = "doctor-mobile";  Out = "VGMF-Doctor-debug.apk" },
    @{ Dir = "scanner-mobile"; Out = "VGMF-Scanner-debug.apk" }
)

function Find-JavaHome {
    $candidates = @(
        $env:JAVA_HOME,
        "C:\Program Files\Android\Android Studio\jbr",
        "$env:LOCALAPPDATA\Programs\Android\Android Studio\jbr",
        "C:\Program Files\Microsoft\jdk-17*",
        "C:\Program Files\Eclipse Adoptium\jdk-17*",
        "C:\Program Files\Java\jdk-17*"
    )
    foreach ($c in $candidates) {
        if (-not $c) { continue }
        $resolved = Resolve-Path $c -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($resolved -and (Test-Path (Join-Path $resolved "bin\java.exe"))) {
            return $resolved.Path
        }
    }
    return $null
}

$javaHome = Find-JavaHome
if (-not $javaHome) {
    Write-Host "JDK 17 not found. Try: winget install Microsoft.OpenJDK.17" -ForegroundColor Yellow
    throw "Set JAVA_HOME to JDK 17+ and run again."
}
$env:JAVA_HOME = $javaHome
$env:PATH = "$javaHome\bin;$env:PATH"
Write-Host "Using JAVA_HOME=$javaHome" -ForegroundColor Cyan

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }
if (-not (Test-Path $sdk)) {
    throw "Android SDK not found at $sdk. Install Android Studio or SDK command-line tools."
}
$env:ANDROID_HOME = $sdk
Write-Host "Using ANDROID_HOME=$sdk" -ForegroundColor Cyan

Write-Host "Syncing portal mobile URLs (seminar.vaidyagogate.org)..." -ForegroundColor Cyan
node (Join-Path $root "scripts\sync-mobile-capacitor.js")
if ($LASTEXITCODE -ne 0) { throw "sync-mobile-capacitor.js failed" }

$built = @()
foreach ($p in $portals) {
    $mobile = Join-Path $root $p.Dir
    $android = Join-Path $mobile "android"
    if (-not (Test-Path $android)) {
        Write-Host "Skip $($p.Dir): no android/ folder" -ForegroundColor Yellow
        continue
    }

    Write-Host ""
    Write-Host "=== Building $($p.Dir) ===" -ForegroundColor Green
    $sdkEsc = ($sdk -replace '\\', '\\')
    Set-Content -Path (Join-Path $android "local.properties") -Value "sdk.dir=$sdkEsc" -Encoding ASCII

    Push-Location $mobile
    try {
        npx cap sync android
        Push-Location $android
        try {
            .\gradlew.bat assembleDebug --no-daemon
            $apk = "app\build\outputs\apk\debug\app-debug.apk"
            if (-not (Test-Path $apk)) {
                throw "APK not found at $apk"
            }
            $dest = Join-Path $root $p.Out
            Copy-Item $apk $dest -Force
            $built += $dest
            Write-Host "OK: $dest" -ForegroundColor Green
        } finally {
            Pop-Location
        }
    } finally {
        Pop-Location
    }
}

Write-Host ""
if ($built.Count) {
    Write-Host "Built $($built.Count) APK(s):" -ForegroundColor Green
    $built | ForEach-Object { Write-Host "  $_" }
} else {
    throw "No APKs were built."
}
