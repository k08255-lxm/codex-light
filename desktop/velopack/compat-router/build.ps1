param([Parameter(Mandatory=$true)][string]$Version,[Parameter(Mandatory=$true)][string]$VelopackDirectory,[Parameter(Mandatory=$true)][string]$Output,[switch]$EnableRecovery)
$ErrorActionPreference='Stop'
if($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or [version]$Version -le [version]'0.4.4'){throw 'Post-bridge version required'}
function Plain([string]$p){$p=[IO.Path]::GetFullPath($p);while($p){if((Test-Path -LiteralPath $p)-and((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse path'};$p=[IO.Path]::GetDirectoryName($p)}}
$source=(Resolve-Path -LiteralPath $VelopackDirectory).Path;$out=[IO.Path]::GetFullPath($Output);Plain $source;Plain $out
if(Test-Path -LiteralPath $out){throw 'New output required'}
$v=Get-Content (Join-Path $source 'verification.json') -Raw -Encoding utf8|ConvertFrom-Json
if($v.version -ne $Version -or $v.packageId -ne 'CodexLightDesktop' -or !$v.fullOnly -or !$v.allPayloadHashesMatch -or !$v.setupEmbedsExactPackage -or !$v.workerPresent -or !$v.portableMatches){throw 'Unverified target output'}
$name="CodexLight-NewInstall-$Version-x64.zip";$fresh=Join-Path $source $name;Plain $fresh
$hash=(Get-FileHash -LiteralPath $fresh).Hash.ToLowerInvariant();$sums=Get-Content (Join-Path $source 'SHA256SUMS.txt') -Encoding utf8
if(@($sums|Where-Object {$_ -match ('^'+$hash+'\s+\*?'+[regex]::Escape($name)+'$')}).Count -ne 1){throw 'Fresh archive checksum absent'}
New-Item -ItemType Directory -Path $out|Out-Null
$url="https://github.com/k08255-lxm/codex-light/releases/download/v$Version/$name"
$pins=Join-Path $out 'Pins.cs';"namespace CodexLight.PublicSetup { internal static class Pins { internal const string Version=`"$Version`",FreshUrl=`"$url`",FreshHash=`"$hash`"; } }"|Set-Content $pins -Encoding utf8
$repairArgs=@()
$verifier=Join-Path $out 'resource-verify'
& dotnet build (Join-Path $PSScriptRoot 'resource-verify/ResourceVerify.csproj') -c Release -o $verifier --nologo
if($LASTEXITCODE -ne 0){throw 'Resource verifier build failed'}
$verifierDll=Join-Path $verifier 'ResourceVerify.dll'
if($EnableRecovery){
 $packageName="CodexLightDesktop-$Version-full.nupkg";$package=Join-Path $source $packageName;Plain $package
 $packageHash=(Get-FileHash -LiteralPath $package).Hash.ToLowerInvariant()
 if(@($sums|Where-Object {$_ -match ('^'+$packageHash+'\s+\*?'+[regex]::Escape($packageName)+'$')}).Count -ne 1){throw 'Recovery package checksum absent'}
 $offset=& dotnet $verifierDll --package-offset $fresh $package
 if($LASTEXITCODE -ne 0 -or "$offset" -notmatch '^\d+$'){throw 'Unable to locate verified package in fresh installer'}
 $packageLength=(Get-Item -LiteralPath $package).Length
 $helper=Join-Path $out 'recovery-helper'
 $worker=Join-Path $PSScriptRoot '../worker/BootstrapWorker.csproj'
 & dotnet publish $worker -c Release -r win-x64 --self-contained false "-p:Version=$Version" "-p:RepairVersion=$Version" "-p:RepairSha256=$packageHash" -p:DebugSymbols=false -p:DebugType=none -o $helper --nologo
 if($LASTEXITCODE -ne 0){throw 'Recovery helper publish failed'}
 & (Join-Path $PSScriptRoot '../worker/verify-entrypoint.ps1') -Directory $helper -Name 'CodeCang.BootstrapWorker'
 $framework=(Get-Content (Join-Path $helper 'CodeCang.BootstrapWorker.runtimeconfig.json') -Raw |ConvertFrom-Json).runtimeOptions.framework
 if($framework.name -ne 'Microsoft.NETCore.App' -or $framework.version -ne '10.0.0'){throw 'Unexpected repair runtime requirement'}
 # Only the native apphost is redistributed. Resolve its notices from the SDK or restored host pack.
 $resolved=& dotnet msbuild $worker -t:ResolveFrameworkReferences -p:RuntimeIdentifier=win-x64 -p:SelfContained=false -getItem:ResolvedAppHostPack -getProperty:NetCoreRoot
 if($LASTEXITCODE -ne 0){throw 'Recovery apphost resolution failed'}
 $resolved=$resolved|Out-String|ConvertFrom-Json
 $packs=@($resolved.Items.ResolvedAppHostPack|Where-Object {$_.Identity -eq 'AppHost' -and $_.RuntimeIdentifier -eq 'win-x64'})
 if($packs.Count -ne 1){throw 'Recovery apphost pack unavailable'}
 $license=Join-Path $packs[0].PackageDirectory 'LICENSE.TXT';$notice=Join-Path $packs[0].PackageDirectory 'THIRD-PARTY-NOTICES.TXT'
 if(!(Test-Path -LiteralPath $license) -and $packs[0].PackageDirectory.StartsWith((Join-Path $resolved.Properties.NetCoreRoot 'packs\'),[StringComparison]::OrdinalIgnoreCase)){
  $license=Join-Path $resolved.Properties.NetCoreRoot 'LICENSE.txt';$notice=Join-Path $resolved.Properties.NetCoreRoot 'ThirdPartyNotices.txt'
 }
 Plain $license;Plain $notice
 Copy-Item -LiteralPath $license -Destination (Join-Path $helper 'DOTNET-LICENSE.TXT')
 Copy-Item -LiteralPath $notice -Destination (Join-Path $helper 'DOTNET-THIRD-PARTY-NOTICES.TXT')

 $helperZip=Join-Path $out 'recovery-helper.zip';Compress-Archive -Path (Join-Path $helper '*') -DestinationPath $helperZip
 $helperHash=(Get-FileHash -LiteralPath $helperZip).Hash.ToLowerInvariant()
 $repairPins=Join-Path $out 'RepairPins.cs';"namespace CodexLight.PublicSetup { internal static class RepairPins { internal const string PackageHash=`"$packageHash`",HelperHash=`"$helperHash`"; internal const long PackageOffset=$offset,PackageLength=$packageLength; } }"|Set-Content $repairPins -Encoding utf8
 $repairArgs=@("-p:RouterRepair=$helperZip","-p:RouterRepairPins=$repairPins")
}
& dotnet build (Join-Path $PSScriptRoot 'Router.csproj') -c Release "-p:Version=$Version" "-p:RouterPins=$pins" "-p:RouterFresh=$fresh" -p:DebugSymbols=false -p:DebugType=none -o (Join-Path $out 'bin') --nologo @repairArgs
if($LASTEXITCODE -ne 0){throw 'Router build failed'}
# Inspect PE metadata/bytes; never load the final EXE as an assembly to verify it.
$resourceArgs=@((Join-Path $out 'bin/CodexLight-Setup.exe'),'CodeCang.Fresh.zip',$hash)
if($EnableRecovery){$resourceArgs+=@('CodeCang.Repair.zip',$helperHash)}
& dotnet $verifierDll @resourceArgs
if($LASTEXITCODE -ne 0){throw 'Embedded resource verification failed'}
$public=Join-Path $out 'public';New-Item -ItemType Directory $public|Out-Null
$setup="CodexLight-Setup-$Version-x64.exe";Copy-Item (Join-Path $out 'bin/CodexLight-Setup.exe') (Join-Path $public $setup)
$sha=(Get-FileHash (Join-Path $public $setup)).Hash.ToLowerInvariant()
@{schema=3;recoveryEnabled=[bool]$EnableRecovery;recoveryPackageSha256=$packageHash;recoveryHelperSha256=$helperHash;freshEmbedded=$true;embeddedResource='CodeCang.Fresh.zip';version=$Version;bootstrapName=$setup;bootstrapSha256=$sha;migrationSupported=$true;mode='fixedBridgeThenPrompt';bridgeVersion='0.4.4';bridgeUrl='https://github.com/k08255-lxm/codex-light/releases/download/v0.4.4/CodexLight-Setup-0.4.4-x64.exe';bridgeSha256='b2410266d12946301ffecebaa9c1fa77c8cebd065fe889cdb8eb83b974245aba';freshName=$name;freshSha256=$hash}|ConvertTo-Json|Set-Content (Join-Path $public 'release-bootstrap-receipt.json') -Encoding utf8
"$sha  $setup"|Set-Content (Join-Path $public 'SHA256SUMS.txt') -Encoding ascii
Write-Output $public
