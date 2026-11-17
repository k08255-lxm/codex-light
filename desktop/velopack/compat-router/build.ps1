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
if($EnableRecovery){
 $packageName="CodexLightDesktop-$Version-full.nupkg";$package=Join-Path $source $packageName;Plain $package
 $packageHash=(Get-FileHash -LiteralPath $package).Hash.ToLowerInvariant()
 if(@($sums|Where-Object {$_ -match ('^'+$packageHash+'\s+\*?'+[regex]::Escape($packageName)+'$')}).Count -ne 1){throw 'Recovery package checksum absent'}
 $helper=Join-Path $out 'recovery-helper'
 & dotnet publish (Join-Path $PSScriptRoot '../worker/BootstrapWorker.csproj') -c Release -r win-x64 --self-contained true "-p:RepairVersion=$Version" "-p:RepairSha256=$packageHash" -p:DebugSymbols=false -p:DebugType=none -o $helper --nologo
 if($LASTEXITCODE -ne 0){throw 'Recovery helper publish failed'}
 # Self-contained recovery redistributes .NET: carry the exact restored runtime
 # package's license and notices, rather than guessing from the installed SDK.
 $assets=Get-Content (Join-Path $PSScriptRoot '../worker/obj/project.assets.json') -Raw -Encoding utf8|ConvertFrom-Json
 $runtime=@($assets.project.frameworks.PSObject.Properties.Value.downloadDependencies|Where-Object {$_.name -eq 'Microsoft.NETCore.App.Runtime.win-x64'})
 if($runtime.Count -ne 1 -or $runtime[0].version -notmatch '^\[([0-9.]+), \1\]$'){throw 'Ambiguous recovery runtime license source'}
 $runtimePath='microsoft.netcore.app.runtime.win-x64/'+$Matches[1];$runtimeRoot=$null
 foreach($folder in $assets.packageFolders.PSObject.Properties.Name){$candidate=Join-Path $folder $runtimePath;if(Test-Path -LiteralPath $candidate){$runtimeRoot=$candidate;break}}
 if(!$runtimeRoot){throw 'Recovery runtime package unavailable'}
 foreach($notice in @('LICENSE.TXT','THIRD-PARTY-NOTICES.TXT')){$noticePath=Join-Path $runtimeRoot $notice;Plain $noticePath;Copy-Item -LiteralPath $noticePath -Destination (Join-Path $helper ('DOTNET-'+$notice))}

 $helperZip=Join-Path $out 'recovery-helper.zip';Compress-Archive -Path (Join-Path $helper '*') -DestinationPath $helperZip
 $helperHash=(Get-FileHash -LiteralPath $helperZip).Hash.ToLowerInvariant()
 $repairPins=Join-Path $out 'RepairPins.cs';"namespace CodexLight.PublicSetup { internal static class RepairPins { internal const string PackageHash=`"$packageHash`",HelperHash=`"$helperHash`"; } }"|Set-Content $repairPins -Encoding utf8
 $repairArgs=@("-p:RouterRepair=$helperZip","-p:RouterPackage=$package","-p:RouterRepairPins=$repairPins")
}
& dotnet build (Join-Path $PSScriptRoot 'Router.csproj') -c Release "-p:Version=$Version" "-p:RouterPins=$pins" "-p:RouterFresh=$fresh" -p:DebugSymbols=false -p:DebugType=none -o (Join-Path $out 'bin') --nologo @repairArgs
if($LASTEXITCODE -ne 0){throw 'Router build failed'}
# Inspect PE metadata/bytes; never load the final EXE as an assembly to verify it.
$verifier=Join-Path $out 'resource-verify'
& dotnet build (Join-Path $PSScriptRoot 'resource-verify/ResourceVerify.csproj') -c Release -o $verifier --nologo
if($LASTEXITCODE -ne 0){throw 'Resource verifier build failed'}
$resourceArgs=@((Join-Path $out 'bin/CodexLight-Setup.exe'),'CodeCang.Fresh.zip',$hash)
if($EnableRecovery){$resourceArgs+=@('CodeCang.Repair.zip',$helperHash,'CodeCang.Repair.nupkg',$packageHash)}
& dotnet (Join-Path $verifier 'ResourceVerify.dll') @resourceArgs
if($LASTEXITCODE -ne 0){throw 'Embedded resource verification failed'}
$public=Join-Path $out 'public';New-Item -ItemType Directory $public|Out-Null
$setup="CodexLight-Setup-$Version-x64.exe";Copy-Item (Join-Path $out 'bin/CodexLight-Setup.exe') (Join-Path $public $setup)
$sha=(Get-FileHash (Join-Path $public $setup)).Hash.ToLowerInvariant()
@{schema=3;recoveryEnabled=[bool]$EnableRecovery;recoveryPackageSha256=$packageHash;recoveryHelperSha256=$helperHash;freshEmbedded=$true;embeddedResource='CodeCang.Fresh.zip';version=$Version;bootstrapName=$setup;bootstrapSha256=$sha;migrationSupported=$true;mode='fixedBridgeThenPrompt';bridgeVersion='0.4.4';bridgeUrl='https://github.com/k08255-lxm/codex-light/releases/download/v0.4.4/CodexLight-Setup-0.4.4-x64.exe';bridgeSha256='b2410266d12946301ffecebaa9c1fa77c8cebd065fe889cdb8eb83b974245aba';freshName=$name;freshSha256=$hash}|ConvertTo-Json|Set-Content (Join-Path $public 'release-bootstrap-receipt.json') -Encoding utf8
"$sha  $setup"|Set-Content (Join-Path $public 'SHA256SUMS.txt') -Encoding ascii
Write-Output $public
