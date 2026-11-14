param(
 [Parameter(Mandatory=$true)][string]$PayloadPath,
 [Parameter(Mandatory=$true)][string]$VelopackHostPath,
 [Parameter(Mandatory=$true)][string]$WorkerPath,
 [Parameter(Mandatory=$true)][string]$Output,
 [string]$ToolPath
)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$version=(Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw|ConvertFrom-Json).version
if($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$'){throw 'Three-part product version required'}
$payload=(Resolve-Path -LiteralPath $PayloadPath).Path
$hostDir=(Resolve-Path -LiteralPath $VelopackHostPath).Path
$workerDir=(Resolve-Path -LiteralPath $WorkerPath).Path
$out=[IO.Path]::GetFullPath($Output)
if(Test-Path -LiteralPath $out){throw 'Output must not exist. Never overwrite a distributed version.'}
function Assert-Plain([string]$p){while($p){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse paths refused'};$p=[IO.Path]::GetDirectoryName($p)}}
Assert-Plain $payload;Assert-Plain $hostDir;Assert-Plain $workerDir;Assert-Plain $out
if((Get-Content -LiteralPath (Join-Path $payload 'app/package.json') -Raw|ConvertFrom-Json).version -ne $version){throw 'Application payload version mismatch'}
$deps=Get-Content -LiteralPath (Join-Path $hostDir 'CodexLight.deps.json') -Raw|ConvertFrom-Json
if(!$deps.libraries.'Velopack/1.2.161' -or !$deps.libraries."CodexLight/$version"){throw 'Publish the matching opt-in host with pinned Velopack 1.2.161 first'}
if((Get-Item -LiteralPath (Join-Path $hostDir 'CodexLight.exe')).VersionInfo.FileVersion -ne "$version.0"){throw 'Host file version mismatch'}
foreach($workerBinary in @('CodexLight.UpdateWorker.exe','CodexLight.UpdateWorker.dll')){
 if((Get-Item -LiteralPath (Join-Path $workerDir $workerBinary)).VersionInfo.FileVersion -ne "$version.0"){throw 'Worker file version mismatch'}
}
New-Item -ItemType Directory -Path $out|Out-Null
$work=Join-Path $out 'work';$stage=Join-Path $work 'payload';$release=Join-Path $out 'release'
New-Item -ItemType Directory -Path $work,$stage,$release|Out-Null
if(!$ToolPath){
 $tools=Join-Path $out 'tools'
 $nugetConfig=Join-Path $out 'NuGet.Config'
 '<configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json" /></packageSources></configuration>'|Set-Content -LiteralPath $nugetConfig -Encoding utf8
 dotnet tool install vpk --version 1.2.161 --tool-path $tools --configfile $nugetConfig
 if($LASTEXITCODE -ne 0){throw 'Official NuGet vpk installation failed'}
 $ToolPath=Join-Path $tools 'vpk.exe'
}
$tool=(Resolve-Path -LiteralPath $ToolPath).Path
$toolVersion=(& $tool --help|Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $toolVersion -notmatch 'Velopack CLI 1\.2\.161,'){throw "Wrong vpk version: $toolVersion"}
$manifestDir=Join-Path $work 'manifest'
python (Join-Path $repo 'desktop/msi/generate.py') $payload $manifestDir --version $version
if($LASTEXITCODE -ne 0){throw 'Existing complete-payload/licensing verification failed'}
python (Join-Path $PSScriptRoot 'stage.py') $payload (Join-Path $manifestDir 'payload-manifest.json') $stage $workerDir $version
if($LASTEXITCODE -ne 0){throw 'Verified payload staging failed'}
foreach($name in @('CodexLight.exe','CodexLight.dll','CodexLight.deps.json','CodexLight.runtimeconfig.json','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','Velopack.dll')){
 $source=Join-Path $hostDir $name;Assert-Plain $source
 Copy-Item -LiteralPath $source -Destination (Join-Path $stage $name) -Force
}
# The external preflight wrapper must run this before the vendor Setup; bare Setup is not the supported entrypoint.
$prerequisiteBuild=Join-Path $work 'prerequisite-build'
dotnet build (Join-Path $PSScriptRoot 'prerequisites/NodePrerequisite.csproj') -c Release -p:Version=$version -p:DebugSymbols=false -p:DebugType=none -o $prerequisiteBuild --source https://api.nuget.org/v3/index.json --nologo
if($LASTEXITCODE -ne 0){throw 'Node preflight build failed'}
foreach($destination in @((Join-Path $stage 'prerequisites'),(Join-Path $release 'prerequisites'))){
 New-Item -ItemType Directory -Path $destination|Out-Null
 foreach($name in @('CodexLight.NodePrerequisite.exe','CodexLight.NodePrerequisite.exe.config')){Copy-Item -LiteralPath (Join-Path $prerequisiteBuild $name) -Destination (Join-Path $destination $name)}
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE-Velopack.txt') -Destination (Join-Path $stage 'licenses/Velopack-LICENSE.txt')
$vendor=Join-Path (Split-Path $tool -Parent) '.store/vpk/1.2.161/vpk/1.2.161/vendor/THIRD_PARTY_NOTICES.md'
if(!(Test-Path -LiteralPath $vendor)){throw 'Pinned vpk vendor notices missing; pass a dotnet --tool-path installation'}
Copy-Item -LiteralPath $vendor -Destination (Join-Path $stage 'licenses/Velopack-VENDOR-NOTICES.md')
# CLI validation normally invokes the app; skip it to guarantee no app/window/model startup.
# The build verifies the referenced runtime but live fast-hook behavior is a separate integration gate.
& $tool pack --packId CodexLightDesktop --packVersion $version --packDir $stage --mainExe CodexLight.exe --packTitle 'Codex Light' --outputDir $release --runtime win-x64 --delta None --shortcuts StartMenuRoot --framework 'net10.0-x64-desktop,webview2' --skipVeloAppCheck
if($LASTEXITCODE -ne 0){throw 'Velopack packaging failed'}
$verification=& python (Join-Path $PSScriptRoot 'verify.py') $release $stage $version --manifest (Join-Path $work 'final-payload-manifest.json')
if($LASTEXITCODE -ne 0){throw 'Release verification failed'}
$verification|Set-Content -LiteralPath (Join-Path $release 'verification.json') -Encoding utf8
Get-ChildItem -LiteralPath $release -File -Recurse|Where-Object {$_.Name -ne 'SHA256SUMS.txt'}|Sort-Object FullName|ForEach-Object {'{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant(),($_.FullName.Substring($release.Length+1).Replace('\','/'))}|Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Encoding ascii
Write-Output "Verified full-only release assets: $release"
Write-Warning 'Vendor Setup alone is not a supported fresh-install entrypoint: consent-aware Node preflight wrapper is required. Not published or installed. Unsigned developer packages. Node.js prerequisite, safe task-idle gate, first MSI migration and rollback remain integration/release gates.'

