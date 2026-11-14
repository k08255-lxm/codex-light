param(
 [Parameter(Mandatory=$true)][string]$ManifestPath,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$TrustedManifestSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$TrustedSetupSha256,
 [switch]$ExecuteStage,
 [switch]$AllowSameVersion,
 [switch]$TasksCompleted
)
$ErrorActionPreference='Stop'
$driver=Join-Path $PSScriptRoot 'bin/Release/net10.0-windows/Migration.dll'
if(!(Test-Path -LiteralPath $driver)){throw 'Build Migration.csproj in Release first'}
$arguments=@($driver,'stage-plan',$ManifestPath,$TrustedManifestSha256,$TrustedSetupSha256)
if($ExecuteStage){$arguments+='--execute-stage'}
if($AllowSameVersion){$arguments+='--allow-same-version'}
if($TasksCompleted){$arguments+='--tasks-completed'}
& dotnet @arguments
if($LASTEXITCODE -ne 0){throw "Stage driver stopped ($LASTEXITCODE); inspect receipt if one was created, never blindly retry"}
