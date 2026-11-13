param(
 [string]$MsiPath = (Join-Path $PSScriptRoot '../msi/out-release-0.4.0/CodexLight-0.4.0-x64.msi'),
 [string]$Output = (Join-Path $PSScriptRoot 'out-release-0.4.0'),
 [switch]$VerifyLayout
)
$ErrorActionPreference = 'Stop'
$package = (Resolve-Path -LiteralPath $MsiPath).Path
if ([IO.Path]::GetExtension($package) -ne '.msi') { throw 'MsiPath must name an MSI package.' }
$destination = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path $destination | Out-Null
& dotnet build (Join-Path $PSScriptRoot 'CodexLight.Setup.csproj') -c Release "-p:MsiPath=$package" --nologo
if ($LASTEXITCODE -ne 0) { throw 'Setup build failed.' }
if ($VerifyLayout) {
 & dotnet build (Join-Path $PSScriptRoot 'tests/CodexLight.Setup.Tests.csproj') -c Release --nologo
 if ($LASTEXITCODE -ne 0) { throw 'Setup tests build failed.' }
 & (Join-Path $PSScriptRoot 'tests/run-tests.ps1') -AssemblyPath (Join-Path $PSScriptRoot 'tests/bin/Release/net10.0-windows/CodexLight.Setup.Tests.dll') -PreviewPath (Join-Path $destination 'previews')
 if ($LASTEXITCODE -ne 0) { throw 'Setup state/layout/resource tests failed.' }
}
& python (Join-Path $PSScriptRoot 'verify-resource.py') (Join-Path $PSScriptRoot 'bin/Release/net48/CodexLightSetup.exe') $package
if ($LASTEXITCODE -ne 0) { throw 'Embedded MSI verification failed.' }
$artifact = Join-Path $destination 'CodexLight-Setup.exe'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'bin/Release/net48/CodexLightSetup.exe') -Destination $artifact -Force
@{ version = '0.4.0'; msi = $package; msiSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash; setupSha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash; tests = $(if($VerifyLayout){Get-Content -LiteralPath (Join-Path $destination 'previews/layout-report.json') -Raw | ConvertFrom-Json}else{'not run; compilation and Python read-only CLR embedded-resource verification only'}); builtUtc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $destination 'build-receipt.json') -Encoding utf8
Write-Output "Built single executable (not started): $artifact"
