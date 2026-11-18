param([string]$SdkDir = "$env:LOCALAPPDATA\Android\Sdk", [string]$JsonJar = "")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$output = Join-Path $root ".tmp/android-update-tests"
New-Item -ItemType Directory -Force -Path $output | Out-Null
$platform = Get-ChildItem -LiteralPath (Join-Path $SdkDir "platforms") -Directory -Filter 'android-*' | Sort-Object Name -Descending | Select-Object -First 1
if (!$platform) { throw "Android SDK platform not found" }
$androidJar = Join-Path $platform.FullName "android.jar"
$sources = Join-Path $root "android/app/src/main/java/com/codexlight/android"
& javac -encoding UTF-8 -cp $androidJar -d $output (Join-Path $sources "AppUpdateTransport.java") (Join-Path $PSScriptRoot "TransportTests.java")
if ($LASTEXITCODE -ne 0) { throw "Android update test compilation failed" }
$dependency = if ($JsonJar) { (Resolve-Path -LiteralPath $JsonJar).Path } else { $androidJar }
$testParameters = @("-Djava.io.tmpdir=$output", '-cp', "$output;$dependency", 'com.codexlight.android.TransportTests')
if ($JsonJar) { $testParameters += '--json' }
& java @testParameters
if ($LASTEXITCODE -ne 0) { throw "Android update tests failed" }
