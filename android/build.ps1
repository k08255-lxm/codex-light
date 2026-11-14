param(
    [string]$SdkDir = "",
    [string]$JdkHome = "",
    [string]$KeystorePath = $env:CODEX_LIGHT_ANDROID_KEYSTORE,
    [string]$KeystorePass = $(if ($env:CODEX_LIGHT_ANDROID_KS_PASS) { $env:CODEX_LIGHT_ANDROID_KS_PASS } else { "android" }),
    [string]$KeyAlias = $(if ($env:CODEX_LIGHT_ANDROID_KEY_ALIAS) { $env:CODEX_LIGHT_ANDROID_KEY_ALIAS } else { "androiddebugkey" }),
    [string]$KeyPass = $(if ($env:CODEX_LIGHT_ANDROID_KEY_PASS) { $env:CODEX_LIGHT_ANDROID_KEY_PASS } else { "android" })
)

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "verify-licenses.ps1")
$QrJar = Join-Path $PSScriptRoot "libs\zxing-core-3.5.3.jar"
if ((Get-FileHash -LiteralPath $QrJar -Algorithm SHA256).Hash.ToLowerInvariant() -ne "8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82") { throw "Pinned ZXing dependency checksum mismatch" }

$AndroidDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $AndroidDir "app\src\main"
$BuildDir = Join-Path $AndroidDir "build"
$DistDir = Join-Path $AndroidDir "dist"

function Resolve-AndroidSdk {
    param([string]$Explicit)
    $candidates = @(@($Explicit, $env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk", "C:\tools\android-sdk") |
        Where-Object { $_ -and (Test-Path $_) })
    if ($candidates.Count -eq 0) {
        throw "Android SDK not found. Set ANDROID_HOME or pass -SdkDir."
    }
    return (Resolve-Path $candidates[0]).Path
}

function Resolve-JdkBin {
    param([string]$Explicit)
    $homeCandidates = @(@($Explicit, $env:JAVA_HOME) | Where-Object { $_ -and (Test-Path (Join-Path $_ "bin\javac.exe")) })
    if ($homeCandidates.Count -gt 0) {
        return Join-Path (Resolve-Path $homeCandidates[0]).Path "bin"
    }
    $cmd = Get-Command javac.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        return Split-Path -Parent $cmd.Source
    }
    $toolsJdk = Get-ChildItem -Path "C:\tools" -Directory -Filter "jdk-*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($toolsJdk -and (Test-Path (Join-Path $toolsJdk.FullName "bin\javac.exe"))) {
        return Join-Path $toolsJdk.FullName "bin"
    }
    throw "JDK (17+) not found. Set JAVA_HOME or pass -JdkHome."
}

$ResolvedSdk = Resolve-AndroidSdk -Explicit $SdkDir
$BuildToolsEntry = Get-ChildItem -Path (Join-Path $ResolvedSdk "build-tools") -Directory -ErrorAction Stop |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $BuildToolsEntry) { throw "No Android SDK build-tools installed under $ResolvedSdk\build-tools" }
$BuildToolsDir = $BuildToolsEntry.FullName

$AndroidJar = Join-Path $ResolvedSdk "platforms\android-34\android.jar"
if (!(Test-Path $AndroidJar)) {
    $PlatformEntry = Get-ChildItem -Path (Join-Path $ResolvedSdk "platforms") -Directory -Filter "android-*" -ErrorAction Stop |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $PlatformEntry) { throw "No Android SDK platform installed under $ResolvedSdk\platforms" }
    $AndroidJar = Join-Path $PlatformEntry.FullName "android.jar"
}

$JdkBin = Resolve-JdkBin -Explicit $JdkHome

$Aapt2 = Join-Path $BuildToolsDir "aapt2.exe"
$D8 = Join-Path $BuildToolsDir "d8.bat"
$ZipAlign = Join-Path $BuildToolsDir "zipalign.exe"
$ApkSigner = Join-Path $BuildToolsDir "apksigner.bat"
$Javac = Join-Path $JdkBin "javac.exe"
$KeyTool = Join-Path $JdkBin "keytool.exe"
$Jar = Join-Path $JdkBin "jar.exe"

if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
New-Item -ItemType Directory -Force -Path $BuildDir, "$BuildDir\gen", "$BuildDir\classes", "$BuildDir\dex", $DistDir | Out-Null

Write-Host "[1/6] Compiling resources with aapt2..."
$ResDir = Join-Path $AppDir "res"
& $Aapt2 compile --dir $ResDir -o "$BuildDir\compiled_res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "[2/6] Linking resources..."
$Manifest = Join-Path $AppDir "AndroidManifest.xml"
$UnalignedApk = "$BuildDir\unaligned.apk"
& $Aapt2 link -I $AndroidJar `
    --manifest $Manifest `
    -o $UnalignedApk `
    --java "$BuildDir\gen" `
    --auto-add-overlay `
    "$BuildDir\compiled_res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "[3/6] Compiling Java sources..."
$JavaSources = Get-ChildItem -Path "$AppDir\java", "$BuildDir\gen" -Filter "*.java" -Recurse | Select-Object -ExpandProperty FullName
& $Javac -encoding UTF-8 `
    -cp "$AndroidJar;$AndroidDir\libs\zxing-core-3.5.3.jar" `
    -d "$BuildDir\classes" `
    -source 8 -target 8 `
    $JavaSources
if ($LASTEXITCODE -ne 0) { throw "javac compilation failed" }

Write-Host "[4/6] Converting classes to DEX with d8..."
& $Jar cf "$BuildDir\classes.jar" -C "$BuildDir\classes" .
if ($LASTEXITCODE -ne 0) { throw "jar packaging failed" }

cmd.exe /c "`"$D8`" --output `"$BuildDir\dex`" --lib `"$AndroidJar`" `"$BuildDir\classes.jar`" `"$AndroidDir\libs\zxing-core-3.5.3.jar`""
if ($LASTEXITCODE -ne 0) { throw "d8 execution failed" }

Write-Host "[5/6] Packaging DEX bytecode and assets..."
Push-Location "$BuildDir\dex"
try {
    & $Jar uf $UnalignedApk classes.dex
    if ($LASTEXITCODE -ne 0) { throw "packaging classes.dex failed" }
} finally {
    Pop-Location
}

Push-Location $AppDir
try {
    & $Jar uf $UnalignedApk assets
    if ($LASTEXITCODE -ne 0) { throw "packaging assets failed" }
} finally {
    Pop-Location
}

Write-Host "[6/6] Aligning and signing APK..."
$AlignedApk = "$BuildDir\aligned.apk"
& $ZipAlign -f -p 4 $UnalignedApk $AlignedApk
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

if (-not $KeystorePath) {
    $KeystorePath = Join-Path $AndroidDir "local-debug.keystore"
    if (!(Test-Path $KeystorePath)) {
        Write-Host "Generating untracked local signing keystore ($KeystorePath)..."
        & $KeyTool -genkeypair `
            -keystore $KeystorePath `
            -alias $KeyAlias `
            -keyalg RSA -keysize 2048 -validity 10000 `
            -storepass $KeystorePass -keypass $KeyPass `
            -dname "CN=Android Debug,O=Android,C=US" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
    }
}

$FinalApk = Join-Path $DistDir "codex-light.apk"
cmd.exe /c "`"$ApkSigner`" sign --ks `"$KeystorePath`" --ks-key-alias `"$KeyAlias`" --ks-pass `"pass:$KeystorePass`" --key-pass `"pass:$KeyPass`" --out `"$FinalApk`" `"$AlignedApk`""
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

cmd.exe /c "`"$ApkSigner`" verify -v `"$FinalApk`"" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "apk signature verification failed" }
& (Join-Path $PSScriptRoot "verify-licenses.ps1") -ApkPath $FinalApk

$Hash = (Get-FileHash -Algorithm SHA256 $FinalApk).Hash.ToLowerInvariant()
"$Hash  codex-light.apk" | Set-Content -Encoding ascii -NoNewline "$FinalApk.sha256"
$SizeKb = [Math]::Round((Get-Item $FinalApk).Length / 1KB, 1)

Write-Host "APK ready: $FinalApk ($SizeKb KB)"
Write-Host "SHA256:    $Hash"
