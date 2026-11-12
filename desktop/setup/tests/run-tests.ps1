param([Parameter(Mandatory=$true)][string]$AssemblyPath,[Parameter(Mandatory=$true)][string]$PreviewPath)
$ErrorActionPreference = 'Stop'
$hostPath = Join-Path $env:ProgramFiles 'dotnet/dotnet.exe'
if (!(Test-Path -LiteralPath $hostPath)) { throw 'Installed system dotnet.exe is required for the net10 shared-source offscreen tests.' }
& $hostPath (Resolve-Path -LiteralPath $AssemblyPath).Path ([IO.Path]::GetFullPath($PreviewPath))
if ($LASTEXITCODE -ne 0) { throw 'Shared-source offscreen state/layout tests failed. No policy changes or fallback apphost execution are permitted.' }
