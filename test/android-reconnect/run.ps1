$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$out = Join-Path $root ".tmp/android-reconnect-tests"
New-Item -ItemType Directory -Force $out | Out-Null
[IO.File]::WriteAllText((Join-Path $out "Uri.java"), 'package android.net; public final class Uri { public static String encode(String value) { return value; } }', (New-Object Text.UTF8Encoding($false)))
$src = Join-Path $root "android/app/src/main/java/com/codexlight/android"
& javac -encoding UTF-8 -d $out (Join-Path $out "Uri.java") (Join-Path $src "ServerConfig.java") (Join-Path $src "ReconnectPolicy.java") (Join-Path $src "LanConnectionClient.java") (Join-Path $PSScriptRoot "ReconnectTests.java")
if ($LASTEXITCODE -ne 0) { throw "javac failed" }
& java -cp $out com.codexlight.android.ReconnectTests
if ($LASTEXITCODE -ne 0) { throw "reconnect tests failed" }
