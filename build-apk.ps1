# Builds the Enhanced Training Studio (ETS) APK on Windows. Package id stays com.adam.injectiontracker so it installs over the old app.
# Usage (PowerShell, in this folder):  powershell -ExecutionPolicy Bypass -File .\build-apk.ps1
# Free edition (injections only, for GitHub):  .\build-apk.ps1 -Edition free
#   scripts\make-edition.mjs builds each edition from the same source into dist-www\ (the folder Capacitor packages)
param(
  [ValidateSet('premium','free')][string]$Edition = 'free',
  # -Install: after a good build, offer to install it on a phone plugged in by USB (BUILD-APK.bat passes this;
  # the release script doesn't, so releases never stop to ask)
  [switch]$Install
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$log = Join-Path $PSScriptRoot 'build-log.txt'
Start-Transcript -Path $log -Force | Out-Null
try {
  # --- Version: package.json ------------------------------------------------------------
  $version = (Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json).version
  if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "Version '$version' must look like 1.2.3" }
  # versionCode comes from the version number, so a newer version always installs over an older one
  # (and Android refuses to put an older free version over a newer premium one, which protects the data).
  $vc = 100000000 + [int]$matches[1] * 1000000 + [int]$matches[2] * 1000 + [int]$matches[3]
  $outApk = if ($Edition -eq 'free') { "ETS-free-$version.apk" } else { 'ETS.apk' }
  Write-Host "Version $version ($Edition), versionCode $vc"

  # --- Java: Gradle 8.14 needs JDK 17-24. Use a private JDK 21 in .tools\ if the installed one doesn't fit ---
  function Get-JavaMajor($home_) {
    $rel = Join-Path $home_ 'release'
    if (Test-Path $rel) { $m = Select-String -Path $rel -Pattern 'JAVA_VERSION="(\d+)' | Select-Object -First 1; if ($m) { return [int]$m.Matches[0].Groups[1].Value } }
    return 0
  }
  $toolDir = Join-Path $PSScriptRoot '.tools'
  $candidates = @($env:JAVA_HOME, "$env:ProgramFiles\Android\Android Studio\jbr", "$env:LOCALAPPDATA\Programs\Android Studio\jbr") + @(Get-ChildItem $toolDir -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue | ForEach-Object FullName)
  $jdk = $candidates | Where-Object { $_ -and (Test-Path "$_\bin\java.exe") } | Where-Object { $v = Get-JavaMajor $_; $v -ge 17 -and $v -le 24 } | Select-Object -First 1
  if (-not $jdk) {
    Write-Host "Downloading a private JDK 21 (installed Java is left alone)..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Force $toolDir | Out-Null
    $zip = Join-Path $toolDir 'jdk21.zip'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' -OutFile $zip
    Expand-Archive $zip -DestinationPath $toolDir -Force
    Remove-Item $zip
    $jdk = Get-ChildItem $toolDir -Directory -Filter 'jdk-21*' | Select-Object -First 1 -ExpandProperty FullName
  }
  $env:JAVA_HOME = $jdk
  $env:Path = "$env:JAVA_HOME\bin;$env:Path"
  Write-Host "JAVA_HOME = $env:JAVA_HOME (Java $(Get-JavaMajor $jdk))"

  # --- Android SDK ---
  $sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $sdk) { throw "Android SDK not found. Open Android Studio once and let it install the SDK." }
  $env:ANDROID_HOME = $sdk; $env:ANDROID_SDK_ROOT = $sdk
  Write-Host "ANDROID_HOME = $sdk"

  # --- Node: Capacitor 8 needs Node 22+. Use a private copy in .tools\ so the system Node is untouched ---
  $needNode = $true
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $major = [int]((node -v) -replace '^v(\d+).*','$1')
    if ($major -ge 22) { $needNode = $false }
  }
  if ($needNode) {
    $toolDir = Join-Path $PSScriptRoot '.tools'
    $nodeDir = Get-ChildItem $toolDir -Directory -Filter 'node-v22*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeDir) {
      Write-Host "Downloading a private copy of Node 22 (system Node is left alone)..."
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
      $ver = ($idx | Where-Object { $_.version -like 'v22.*' } | Select-Object -First 1).version
      New-Item -ItemType Directory -Force $toolDir | Out-Null
      $zip = Join-Path $toolDir "node-$ver-win-x64.zip"
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
      Expand-Archive $zip -DestinationPath $toolDir -Force
      Remove-Item $zip
      $nodeDir = Get-ChildItem $toolDir -Directory -Filter 'node-v22*' | Select-Object -First 1
    }
    $env:Path = "$($nodeDir.FullName);$env:Path"
  }
  Write-Host "node $(node -v)"

  Write-Host "`n== npm install =="
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

  Write-Host "`n== bundle fonts =="
  node scripts/copy-fonts.js
  if ($LASTEXITCODE -ne 0) { throw "copying fonts failed" }

  Write-Host "`n== $Edition edition web app =="
  node scripts/make-edition.mjs check
  if ($LASTEXITCODE -ne 0) { throw "edition check failed" }
  node scripts/make-edition.mjs web $Edition www dist-www --version $version
  if ($LASTEXITCODE -ne 0) { throw "making the $Edition web app failed" }

  if (-not (Test-Path android)) {
    Write-Host "`n== cap add android =="
    npx cap add android
    if ($LASTEXITCODE -ne 0) { throw "cap add android failed" }
  }

  # notification icon
  New-Item -ItemType Directory -Force android\app\src\main\res\drawable | Out-Null
  # notification icons: syringe (injections), dumbbell (training), heart (health)
  Copy-Item android-extras\res\drawable\ic_stat_*.xml android\app\src\main\res\drawable\ -Force

  # permissions for reminders
  $mf = 'android\app\src\main\AndroidManifest.xml'
  $xml = Get-Content $mf -Raw
  foreach ($p in 'POST_NOTIFICATIONS','SCHEDULE_EXACT_ALARM','RECEIVE_BOOT_COMPLETED','WAKE_LOCK') {
    if ($xml -notmatch "android.permission.$p") { $xml = $xml -replace '</manifest>', "    <uses-permission android:name=`"android.permission.$p`" />`r`n</manifest>" }
  }
  Set-Content $mf $xml -NoNewline

  "sdk.dir=$($sdk -replace '\\','\\')" | Set-Content android\local.properties

  # --- Release signing ---------------------------------------------------------
  # Uses the same key the first (debug) build was signed with, so this installs as an
  # UPDATE over the app already on the phone and keeps its data. The key is copied into
  # .\signing\ — back that folder up: without it future updates can't install over this app.
  New-Item -ItemType Directory -Force signing | Out-Null
  $ks = Join-Path $PSScriptRoot 'signing\injection-tracker.keystore'
  if (-not (Test-Path $ks)) {
    $dbg = Join-Path $env:USERPROFILE '.android\debug.keystore'
    if (-not (Test-Path $dbg)) { throw "No signing key found at $dbg. Build once from Android Studio, or ask Claude to create a new key." }
    Copy-Item $dbg $ks
    Write-Host "Copied signing key to $ks  <-- BACK THIS UP"
  }
  $props = Join-Path $PSScriptRoot 'signing\keystore.properties'
  if (-not (Test-Path $props)) {
    "storeFile=$($ks -replace '\\','/')`r`nstorePassword=android`r`nkeyAlias=androiddebugkey`r`nkeyPassword=android" | Set-Content $props
  }
  $gradleFile = 'android\app\build.gradle'
  $g = Get-Content $gradleFile -Raw
  if ($g -notmatch 'INJTRACK-SIGNING') {
    $block = @"
    // INJTRACK-SIGNING
    signingConfigs {
        release {
            def p = new Properties()
            p.load(new FileInputStream(rootProject.file('../signing/keystore.properties')))
            storeFile file(p['storeFile'])
            storePassword p['storePassword']
            keyAlias p['keyAlias']
            keyPassword p['keyPassword']
        }
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
"@
    $g = $g -replace '(?m)^(\s*)buildTypes \{', "$block`r`n`$1buildTypes {"
    $g = $g -replace '(?m)(release \{\s*\r?\n\s*minifyEnabled false)', "`$1`r`n            signingConfig signingConfigs.release"
  }
  $g = $g -replace 'versionCode \d+', "versionCode $vc"
  $g = $g -replace 'versionName "[^"]*"', ('versionName "' + $version + '"')
  Set-Content $gradleFile $g -NoNewline

  # --- App lock: native plugin (fingerprint / face / screen lock) --------------
  $javaDir = 'android\app\src\main\java\com\adam\injectiontracker'
  Copy-Item android-extras\java\* $javaDir -Force
  $g2 = Get-Content $gradleFile -Raw
  if ($g2 -notmatch 'androidx.biometric') {
    $g2 = $g2 -replace '(?m)^(\s*)implementation project\(\x27:capacitor-android\x27\)', "`$1implementation project(':capacitor-android')`r`n`$1implementation `"androidx.biometric:biometric:1.1.0`""
    Set-Content $gradleFile $g2 -NoNewline
  }

  # keep health data out of Android's own cloud backup and phone-to-phone transfer
  New-Item -ItemType Directory -Force android\app\src\main\res\xml | Out-Null
  Copy-Item android-extras\res\xml\*.xml android\app\src\main\res\xml\ -Force
  $mf3 = Get-Content $mf -Raw
  $mf3 = $mf3 -replace 'android:allowBackup="true"', 'android:allowBackup="false"'
  if ($mf3 -notmatch 'dataExtractionRules') {
    $mf3 = $mf3 -replace '<application', '<application android:dataExtractionRules="@xml/data_extraction_rules" android:fullBackupContent="@xml/backup_rules"'
  }
  Set-Content $mf $mf3 -NoNewline

  # allow writing backups to Documents on Android 10
  $mf2 = Get-Content $mf -Raw
  if ($mf2 -notmatch 'requestLegacyExternalStorage') {
    $mf2 = $mf2 -replace '<application', '<application android:requestLegacyExternalStorage="true"'
    Set-Content $mf $mf2 -NoNewline
  }

  # native plugins, MainActivity and manifest for this edition (the free app has no health, Bluetooth or GPS permissions)
  node scripts/make-edition.mjs android $Edition
  if ($LASTEXITCODE -ne 0) { throw "making the $Edition Android project failed" }

  Write-Host "`n== cap sync =="
  npx cap sync android
  if ($LASTEXITCODE -ne 0) { throw "cap sync failed" }

  Write-Host "`n== gradle assembleRelease =="
  Push-Location android
  .\gradlew.bat --stop | Out-Null
  .\gradlew.bat assembleRelease --no-daemon
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "Gradle build failed" }

  $apk = 'android\app\build\outputs\apk\release\app-release.apk'

  # --- Release key (with key rotation) -------------------------------------------
  # Gradle signs with the original key. apksigner then adds the new ETS release key plus a
  # "lineage" file proving the original key handed over to it, so phones that already have
  # the app accept this as an update, and from now on Android trusts the new key.
  # The signing folder holds both keys, their passwords and the lineage: BACK IT UP somewhere safe.
  $newProps = Join-Path $PSScriptRoot 'signing\ets-release.properties'
  if (Test-Path $newProps) {
    function Read-Props($f) { $h = @{}; Get-Content $f | ForEach-Object { if ($_ -match '^\s*(\w+)\s*=\s*(.*?)\s*$') { $h[$matches[1]] = $matches[2] } }; return $h }
    $op = Read-Props $props; $np = Read-Props $newProps
    $oldKs = $op.storeFile
    $newKs = Join-Path $PSScriptRoot ("signing\" + $np.storeFile)
    $lineage = Join-Path $PSScriptRoot 'signing\ets-lineage.bin'
    $bt = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $bt) { throw "No Android build-tools found in $sdk. Install them from Android Studio's SDK Manager." }
    if ([version]$bt.Name -lt [version]'33.0.1') { throw "Android build-tools $($bt.Name) is too old for key rotation. Install 34 or newer from Android Studio's SDK Manager." }
    $apksigner = Join-Path $bt.FullName 'apksigner.bat'
    # passwords go through environment variables so they never appear on a command line or in the log
    $env:ETS_OLD_SP = $op.storePassword; $env:ETS_OLD_KP = $op.keyPassword; $env:ETS_NEW_SP = $np.storePassword; $env:ETS_NEW_KP = $np.keyPassword
    try {
      $old = @('--ks', $oldKs, '--ks-key-alias', $op.keyAlias, '--ks-pass', 'env:ETS_OLD_SP', '--key-pass', 'env:ETS_OLD_KP')
      $new = @('--ks', $newKs, '--ks-key-alias', $np.keyAlias, '--ks-pass', 'env:ETS_NEW_SP', '--key-pass', 'env:ETS_NEW_KP')
      if (-not (Test-Path $lineage)) {
        Write-Host "`n== creating signing lineage (first time only) =="
        & $apksigner rotate --out $lineage --old-signer @old --new-signer @new
        if ($LASTEXITCODE -ne 0) { throw "apksigner rotate failed" }
        Write-Host "Created signing\ets-lineage.bin  <-- BACK UP the signing folder"
      }
      Write-Host "`n== signing with the ETS release key =="
      & $apksigner sign @old --next-signer @new --lineage $lineage --rotation-min-sdk-version 28 --out $outApk $apk
      if ($LASTEXITCODE -ne 0) { throw "apksigner sign failed" }
    } finally { Remove-Item Env:ETS_OLD_SP, Env:ETS_OLD_KP, Env:ETS_NEW_SP, Env:ETS_NEW_KP -ErrorAction SilentlyContinue }
    & $apksigner verify --verbose --print-certs $outApk | Select-String -Pattern 'Verified using v3|Signer #1 certificate DN|Signer #1 certificate SHA-256' | ForEach-Object { Write-Host $_.Line }
    if ($LASTEXITCODE -ne 0) { throw "The signed APK did not verify" }
  } else {
    Copy-Item $apk $outApk -Force
  }
  Write-Host "`nBUILD OK -> $PSScriptRoot\$outApk ($Edition $version)"
} catch {
  Write-Host "`nBUILD FAILED: $_" -ForegroundColor Red
  $buildFailed = $true
} finally {
  Stop-Transcript | Out-Null
}

# --- Optional: install on a phone plugged in by USB (needs USB debugging on) ---------------
# Kept outside the build: a failed install never marks the build as failed.
if ($Install -and -not $buildFailed) {
  $ErrorActionPreference = 'Continue'
  $adb = Join-Path $sdk 'platform-tools\adb.exe'
  if (-not (Test-Path $adb)) {
    Write-Host "`nTo install on your phone from here, add 'Android SDK Platform-Tools' in Android Studio's SDK Manager."
  } else {
    $lines = & $adb devices 2>$null | Select-Object -Skip 1 | Where-Object { $_ -match '\S' }
    $ready = @($lines | Where-Object { $_ -match '\tdevice$' } | ForEach-Object { ($_ -split '\t')[0] })
    $locked = @($lines | Where-Object { $_ -match '\tunauthorized$' })
    if ($locked.Count -gt 0 -and $ready.Count -eq 0) {
      Write-Host "`nA phone is plugged in but hasn't allowed USB debugging from this PC yet."
      Write-Host "Unlock it, tap Allow on the 'Allow USB debugging?' message, then run BUILD-APK.bat again (or install $outApk by hand)."
    } elseif ($ready.Count -eq 0) {
      Write-Host "`nNo phone found over USB, so nothing was installed. (Plug one in with USB debugging on to install it from here.)"
    } else {
      foreach ($serial in $ready) {
        $model = (& $adb -s $serial shell getprop ro.product.model 2>$null | Out-String).Trim()
        if (-not $model) { $model = $serial }
        $answer = Read-Host "`nInstall $outApk on ${model}? Your data on the phone is kept. (Y/n)"
        if ($answer -match '^\s*(n|no)\s*$') { Write-Host "Not installed."; continue }
        Write-Host "Installing on $model..."
        $out = (& $adb -s $serial install -r $outApk 2>&1 | Out-String).Trim()
        if ($out -match 'Success') {
          Write-Host "Installed on $model." -ForegroundColor Green
        } else {
          Write-Host "Install on $model failed:`n$out" -ForegroundColor Red
          if ($out -match 'UPDATE_INCOMPATIBLE|signatures do not match') {
            Write-Host "The app on the phone was signed with a different key. Don't uninstall it to get past this: that deletes your data. Back up in the app first if you ever do."
          } elseif ($out -match 'VERSION_DOWNGRADE') {
            Write-Host "The phone has a newer version than this build."
          } elseif ($out -match 'USER_RESTRICTED|INSTALL_CANCELED') {
            Write-Host "The phone blocked it: check the phone for an install prompt, or turn on 'Install via USB' in Developer options."
          }
        }
      }
    }
  }
}

# exit code for scripts that run this one (scripts\ship.ps1 in ets-web)
if ($buildFailed) { exit 1 }
