$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$out = Join-Path $root ".tmp/android-reconnect-tests"
New-Item -ItemType Directory -Force $out | Out-Null
$src = Join-Path $root "android/app/src/main/java/com/codexlight/android"
& javac -encoding UTF-8 -d $out (Join-Path $src "ServerConfig.java") (Join-Path $src "ConnectionHistory.java") (Join-Path $src "ReconnectPolicy.java") (Join-Path $src "LanConnectionClient.java") (Join-Path $PSScriptRoot "ReconnectTests.java")
if ($LASTEXITCODE -ne 0) { throw "javac failed" }
& java -cp $out com.codexlight.android.ReconnectTests
if ($LASTEXITCODE -ne 0) { throw "reconnect tests failed" }
