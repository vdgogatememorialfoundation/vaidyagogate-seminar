# Build VGMF Scanner debug APK (Capacitor Android)
# Prefer: scripts\build-portal-apks.ps1 (builds Admin, Judge, Doctor, Scanner)
# Requires: Node.js, JDK 17+, Android SDK (via Android Studio)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$mobile = Join-Path $root "scanner-mobile"
$android = Join-Path $mobile "android"

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
    Write-Host "JDK 17 not found. Install one of:" -ForegroundColor Yellow
    Write-Host "  winget install Microsoft.OpenJDK.17"
    Write-Host "  Or install Android Studio (includes a bundled JBR)"
    Write-Host ""
    $install = Read-Host "Try winget install Microsoft.OpenJDK.17 now? (y/N)"
    if ($install -eq "y") {
        winget install --id Microsoft.OpenJDK.17 -e --accept-package-agreements --accept-source-agreements
        $javaHome = Find-JavaHome
    }
}
if (-not $javaHome) {
    throw "Set JAVA_HOME to JDK 17+ and run this script again."
}

$env:JAVA_HOME = $javaHome
$env:PATH = "$javaHome\bin;$env:PATH"
Write-Host "Using JAVA_HOME=$javaHome" -ForegroundColor Cyan

$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = "$env:LOCALAPPDATA\Android\Sdk" }
if (-not (Test-Path $sdk)) {
    throw "Android SDK not found at $sdk. Install cmdline-tools and run sdkmanager for platform-tools, platforms;android-34, build-tools;34.0.0"
}
$env:ANDROID_HOME = $sdk
$localProps = Join-Path $android "local.properties"
$sdkEsc = ($sdk -replace '\\', '\\')
Set-Content -Path $localProps -Value "sdk.dir=$sdkEsc" -Encoding ASCII
Write-Host "Using ANDROID_HOME=$sdk" -ForegroundColor Cyan

Push-Location $mobile
try {
    if (-not (Test-Path "node_modules")) { npm install }
    npx cap sync android
    Push-Location $android
    .\gradlew.bat assembleDebug --no-daemon
    $apk = "app\build\outputs\apk\debug\app-debug.apk"
    if (Test-Path $apk) {
        $dest = Join-Path $root "VGMF-Scanner-debug.apk"
        Copy-Item $apk $dest -Force
        Write-Host ""
        Write-Host "APK ready:" -ForegroundColor Green
        Write-Host "  $dest"
        Write-Host "  (also at scanner-mobile\android\$apk)"
    } else {
        throw "Build finished but APK not found at $apk"
    }
} finally {
    Pop-Location
    Pop-Location
}
