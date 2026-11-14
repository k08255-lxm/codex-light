param([Parameter(Mandatory=$true)][string]$Version,[Parameter(Mandatory=$true)][string]$VelopackDirectory,[Parameter(Mandatory=$true)][string]$Output)
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
& dotnet build (Join-Path $PSScriptRoot 'Router.csproj') -c Release "-p:Version=$Version" "-p:RouterPins=$pins" -p:DebugSymbols=false -p:DebugType=none -o (Join-Path $out 'bin') --nologo
if($LASTEXITCODE -ne 0){throw 'Router build failed'}
$public=Join-Path $out 'public';New-Item -ItemType Directory $public|Out-Null
$setup="CodexLight-Setup-$Version-x64.exe";Copy-Item (Join-Path $out 'bin/CodexLight-Setup.exe') (Join-Path $public $setup)
$sha=(Get-FileHash (Join-Path $public $setup)).Hash.ToLowerInvariant()
@{schema=2;version=$Version;bootstrapName=$setup;bootstrapSha256=$sha;migrationSupported=$true;mode='fixedBridgeThenPrompt';bridgeVersion='0.4.4';bridgeUrl='https://github.com/k08255-lxm/codex-light/releases/download/v0.4.4/CodexLight-Setup-0.4.4-x64.exe';bridgeSha256='b2410266d12946301ffecebaa9c1fa77c8cebd065fe889cdb8eb83b974245aba';freshName=$name;freshSha256=$hash}|ConvertTo-Json|Set-Content (Join-Path $public 'release-bootstrap-receipt.json') -Encoding utf8
"$sha  $setup"|Set-Content (Join-Path $public 'SHA256SUMS.txt') -Encoding ascii
Write-Output $public
