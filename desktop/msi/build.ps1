param(
    [string]$Payload = (Join-Path $PSScriptRoot '../dist/CodexLight-win-x64-0.3.0'),
    [string]$Version = '0.3.0',
    [string]$Output = (Join-Path $PSScriptRoot 'out-release-0.3.0')
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$wix = Join-Path $repo '.tools/wix6/wix.exe'
if (!(Test-Path -LiteralPath $wix)) { throw 'Install pinned WiX 6.0.2 locally: dotnet tool install wix --version 6.0.2 --tool-path .tools/wix6 (review OSMF first)' }
if ((& $wix --version) -notmatch '^6\.0\.2\+') { throw 'Expected WiX 6.0.2' }
$Payload = (Resolve-Path -LiteralPath $Payload).Path
$Output = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path $Output | Out-Null
python (Join-Path $PSScriptRoot 'generate.py') $Payload $Output --version $Version
if ($LASTEXITCODE -ne 0) { throw 'Payload authoring failed' }
& $wix build (Join-Path $Output 'Product.wxs') -arch x64 -o (Join-Path $Output "CodexLight-$Version-x64.msi") -pdbtype none
if ($LASTEXITCODE -ne 0) { throw 'WiX build failed' }
Get-FileHash (Join-Path $Output "CodexLight-$Version-x64.msi") -Algorithm SHA256
