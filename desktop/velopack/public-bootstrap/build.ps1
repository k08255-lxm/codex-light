param(
 [Parameter(Mandatory=$true)][string]$StageRelease,
 [Parameter(Mandatory=$true)][string]$FreshInstallerDirectory,
 [Parameter(Mandatory=$true)][string]$Output,
 [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version
)
$ErrorActionPreference='Stop'
function Plain([string]$path){$p=[IO.Path]::GetFullPath($path);while($p){if((Test-Path -LiteralPath $p)-and((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse path refused'};$p=[IO.Path]::GetDirectoryName($p)}}
$stage=(Resolve-Path -LiteralPath $StageRelease).Path
$fresh=(Resolve-Path -LiteralPath $FreshInstallerDirectory).Path
$out=[IO.Path]::GetFullPath($Output)
Plain $stage;Plain $fresh;Plain $out
if(Test-Path -LiteralPath $out){throw 'Output must be a new directory'}
$manifest=Join-Path $stage 'migration-release.json'
$m=Get-Content -LiteralPath $manifest -Raw -Encoding UTF8|ConvertFrom-Json
if($m.Version -ne $Version -or $m.PackageId -ne 'CodexLightDesktop' -or $m.Shortcuts -ne 'None'){throw 'Migration package identity mismatch'}
if(!(Test-Path -LiteralPath (Join-Path $fresh 'CodexLight-Install.exe'))){throw 'Fresh install wrapper is missing'}
$freshVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $fresh 'CodexLight-Install.exe')).ProductVersion
if(($freshVersion -split '\+')[0] -ne $Version -and ($freshVersion -split '\+')[0] -ne ($Version+'.0')){throw 'Fresh installer version mismatch'}
$manifestHash=(Get-FileHash -LiteralPath $manifest).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Path $out|Out-Null
$bundle=Join-Path $out 'bundle'
New-Item -ItemType Directory -Path $bundle,(Join-Path $bundle 'release'),(Join-Path $bundle 'fresh')|Out-Null
function CopyPinned([string]$relative,[string]$sha,[long]$bytes){
 if($relative -match '[:\\]' -or @($relative.Split('/')|Where-Object {$_ -in @('','.','..') -or $_.EndsWith('.') -or $_.EndsWith(' ')}).Count){throw 'Unsafe manifest member'}
 $source=Join-Path $stage $relative;Plain $source
 if((Get-Item -LiteralPath $source).Length -ne $bytes -or (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() -ne $sha.ToLowerInvariant()){throw "Source hash mismatch: $relative"}
 $dest=Join-Path (Join-Path $bundle 'release') $relative
 New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($dest))|Out-Null
 Copy-Item -LiteralPath $source -Destination $dest
 if((Get-FileHash -LiteralPath $dest).Hash.ToLowerInvariant() -ne $sha.ToLowerInvariant()){throw 'Copy changed'}
}
foreach($file in $m.Files){CopyPinned $file.Path $file.Sha256 $file.Bytes}
foreach($file in $m.PayloadFiles){CopyPinned "$($m.PayloadDirectory)/$($file.Path)" $file.Sha256 $file.Bytes}
Copy-Item -LiteralPath $manifest -Destination (Join-Path $bundle 'release/migration-release.json')
foreach($file in Get-ChildItem -LiteralPath $fresh -File){Plain $file.FullName;Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $bundle 'fresh')}
$vendorHash=(Get-FileHash -LiteralPath (Join-Path $stage $m.Setup)).Hash.ToLowerInvariant()
@{manifestSha256=$manifestHash;setupSha256=$vendorHash}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $bundle 'migration-pins.json') -Encoding UTF8
& dotnet publish (Join-Path $PSScriptRoot 'worker/Worker.csproj') -c Release -r win-x64 --self-contained false -p:DebugSymbols=false -p:DebugType=none -o (Join-Path $bundle 'worker') --nologo
if($LASTEXITCODE -ne 0){throw 'Migration worker build failed'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=Join-Path $out 'MigrationBundle.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($bundle,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$bundleHash=(Get-FileHash -LiteralPath $zip).Hash.ToLowerInvariant()
$hashFile=Join-Path $out 'bundle.sha256';$bundleHash|Set-Content -LiteralPath $hashFile -Encoding ascii
& dotnet build (Join-Path $PSScriptRoot 'PublicSetup.csproj') -c Release "-p:Version=$Version" "-p:Bundle=$zip" "-p:BundleHash=$hashFile" -p:DebugSymbols=false -p:DebugType=none -o (Join-Path $out 'bin') --nologo
if($LASTEXITCODE -ne 0){throw 'Public bootstrap build failed'}
if((Get-FileHash -LiteralPath $zip).Hash.ToLowerInvariant() -ne $bundleHash){throw 'Embedded bundle changed during build'}
$public=Join-Path $out 'public';New-Item -ItemType Directory -Path $public|Out-Null
$name="CodexLight-Setup-$Version-x64.exe"
Copy-Item -LiteralPath (Join-Path $out 'bin/CodexLight-Setup.exe') -Destination (Join-Path $public $name)
$exeHash=(Get-FileHash -LiteralPath (Join-Path $public $name)).Hash.ToLowerInvariant()
@{schema=1;version=$Version;migrationSupported=$true;bootstrapName=$name;bootstrapSha256=$exeHash;migrationBundleSha256=$bundleHash;vendorSetupSha256=$vendorHash;migrationManifestSha256=$manifestHash}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $public 'release-bootstrap-receipt.json') -Encoding UTF8
"$exeHash  $name"|Set-Content -LiteralPath (Join-Path $public 'SHA256SUMS.txt') -Encoding ascii
Write-Output $public
