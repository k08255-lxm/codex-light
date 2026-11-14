param(
 [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
 [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$TargetVersion,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$TrustedSetupSha256,
 [switch]$Execute,
 [switch]$TasksIdleConfirmed,
 [switch]$InstallMissingNode,
 [switch]$RetireLegacy,
 [switch]$HealthConfirmed,
 [string]$ReceiptPath
)
$ErrorActionPreference='Stop'
# No dynamic command strings, no user-supplied process arguments, no force stop/delete.
function Plain([string]$p){$p=[IO.Path]::GetFullPath($p);while($p){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse path refused'};$p=[IO.Path]::GetDirectoryName($p)}}
function Same([string]$a,[string]$b){return [IO.Path]::GetFullPath($a).TrimEnd('\').Equals([IO.Path]::GetFullPath($b).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)}
function Hash([string]$p){Plain $p;return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}
function Idle {if(!$TasksIdleConfirmed){throw 'Explicit confirmation that all Codex Light tasks have finished is required'};if(@(Get-Process -Name CodexLight -ErrorAction SilentlyContinue).Count){throw 'Codex Light still runs; exit it normally. This wrapper never terminates tasks.'}}
$release=(Resolve-Path -LiteralPath $ReleaseDirectory).Path;Plain $release
$vendor=Join-Path $release 'CodexLightDesktop-win-Setup.exe';$helper=Join-Path $release 'prerequisites/CodexLight.NodePrerequisite.exe'
if((Hash $vendor) -ne $TrustedSetupSha256.ToLowerInvariant()){throw 'Trusted installer SHA256 mismatch'}
$sums=Get-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt')
foreach($relative in @('CodexLightDesktop-win-Setup.exe','prerequisites/CodexLight.NodePrerequisite.exe','prerequisites/CodexLight.NodePrerequisite.exe.config')){
 $lines=@($sums|Where-Object {$_ -match ('^[a-f0-9]{64}  '+[regex]::Escape($relative)+'$')});if($lines.Count -ne 1 -or (Hash (Join-Path $release $relative)) -ne $lines[0].Substring(0,64)){throw "Release checksum mismatch: $relative"}
}
$probe=Join-Path $PSScriptRoot 'bin/Release/net10.0-windows/Migration.dll'
if(!(Test-Path -LiteralPath $probe)){throw 'Build Migration.csproj in Release before running this wrapper'}
function Inspect { $raw=& dotnet $probe inspect;if($LASTEXITCODE -ne 0){throw 'Exact MSI/source inventory failed'};return ($raw|Out-String|ConvertFrom-Json) }
$old=Inspect
if([version]$TargetVersion -le [version]$old.Version){throw 'Target must be newer than installed MSI'}
$local=[Environment]::GetFolderPath('LocalApplicationData');$newRoot=Join-Path $local 'CodexLightDesktop';$data=Join-Path $local 'CodexLight';Plain $newRoot;Plain $data;Plain $old.InstallRoot
foreach($p in @($old.InstallRoot,$data)){if((Same $p $newRoot) -or $newRoot.StartsWith($p.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($newRoot.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Program/data directory overlap'}}
$plan=[ordered]@{Mode=$(if($RetireLegacy){'retire'}else{'stage'});Legacy=$old;NewRoot=$newRoot;DataRoot=$data;TargetVersion=$TargetVersion;Installer=$vendor;InstallerSha256=$TrustedSetupSha256;Execute=[bool]$Execute}
$plan|ConvertTo-Json -Depth 6|Write-Output
if(!$Execute){Write-Output 'INSPECT ONLY: no installer, app or cleanup was executed.';return}
# Release gate: pinned vendor source has broken EXE_ARGS parsing (Velopack issue #1039).
# Until a no-normal-start staging path is verified end-to-end, both staging and retirement stay disabled.
throw 'EXECUTION DISABLED: Velopack 1.2.161 argument-forwarding safety and disposable-VM migration/rollback have not passed. No installer or prerequisite was started.'
Idle
$mutex=New-Object Threading.Mutex($false,'Local\CodexLight.MsiVelopackMigration')
$locked=$false
try {
 try{$locked=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
 if(!$locked){throw 'Another migration is in progress'}
 if((Inspect|ConvertTo-Json -Compress) -ne ($old|ConvertTo-Json -Compress)){throw 'MSI/source changed'}
 if($RetireLegacy){
  if(!$HealthConfirmed -or !$ReceiptPath){throw 'Explicit successful manual health confirmation and staged receipt required'}
  Plain $ReceiptPath;$receipt=Get-Content -LiteralPath $ReceiptPath -Raw|ConvertFrom-Json
  if($receipt.Phase -ne 'StagedOldPreserved' -or $receipt.Legacy.ProductCode -ne $old.ProductCode -or $receipt.Legacy.SourceSha256 -ne $old.SourceSha256 -or $receipt.TargetVersion -ne $TargetVersion -or !(Same $receipt.NewRoot $newRoot) -or (Hash $receipt.BackupSource) -ne $old.SourceSha256){throw 'Staged receipt/rollback source does not match current installation'}
  $hostPath=Join-Path $newRoot 'current/CodexLight.exe';Plain $hostPath
  if((Get-Item -LiteralPath $hostPath).VersionInfo.FileVersion -ne "$TargetVersion.0"){throw 'New host version mismatch'}
  Idle
  $receipt.Phase='Retiring';$receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $ReceiptPath -Encoding utf8
  $msi=Join-Path ([Environment]::GetFolderPath('System')) 'msiexec.exe'
  $p=Start-Process -FilePath $msi -ArgumentList @('/x',$old.ProductCode,'/norestart') -PassThru -Wait
  $receipt.Phase=if($p.ExitCode -eq 0){'RetiredNeedsVerification'}else{'RecoveryRequired'};$receipt.ExitCode=$p.ExitCode
  $receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $ReceiptPath -Encoding utf8
  Write-Output "MSI exit code $($p.ExitCode). Receipt retained. Recheck Apps, shortcuts, application health and data before declaring migration complete."
  return
 }
 if(Test-Path -LiteralPath $newRoot){throw 'Dedicated destination already exists; inspect before proceeding'}
 # Stage full installer + expanded payload + source backup; conservative until exact manifest sizing is integrated.
 $packageBytes=(Get-Item -LiteralPath $vendor).Length;$required=[Math]::Max(1GB,10*$packageBytes+(Get-Item -LiteralPath $old.SourceMsi).Length)
 if((New-Object IO.DriveInfo([IO.Path]::GetPathRoot($newRoot))).AvailableFreeSpace -lt $required){throw 'Insufficient conservative staging/recovery space budget'}
 $cache=Join-Path $local ('CodexLightMigration/'+[guid]::NewGuid().ToString('N'));Plain $cache;New-Item -ItemType Directory -Path $cache|Out-Null
 $backup=Join-Path $cache 'legacy-source.msi';Copy-Item -LiteralPath $old.SourceMsi -Destination $backup
 if((Hash $backup) -ne $old.SourceSha256){throw 'Recovery source verification failed'}
 $ReceiptPath=Join-Path $cache 'receipt.json';$receipt=[ordered]@{Phase='Prepared';Legacy=$old;NewRoot=$newRoot;TargetVersion=$TargetVersion;BackupSource=$backup;InstallerSha256=$TrustedSetupSha256;ExitCode=$null}
 $receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $ReceiptPath -Encoding utf8
 & $helper --check-node $old.InstallRoot;$nodeCode=$LASTEXITCODE
 if($nodeCode -eq 20 -and $InstallMissingNode){& $helper --install-node $old.InstallRoot;$nodeCode=$LASTEXITCODE}
 if($nodeCode -ne 0){throw "Node prerequisite unresolved ($nodeCode); no vendor Setup started"}
 Idle
 # Official --installto plus documented forwarded exe args. The opt-in host recognizes
 # --migration-staged and exits before UI/global mutex/backend/user-state startup.
 $receipt.Phase='Staging';$receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $ReceiptPath -Encoding utf8
 $p=Start-Process -FilePath $vendor -ArgumentList @('--installto',('"'+$newRoot+'"'),'--','--migration-staged') -Wait -PassThru
 $receipt.ExitCode=$p.ExitCode
 $receipt.Phase=if($p.ExitCode -eq 0){'StagedOldPreserved'}else{'RecoveryRequired'}
 $receipt|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $ReceiptPath -Encoding utf8
 Write-Output "Vendor Setup returned $($p.ExitCode). Old MSI retained. Receipt: $ReceiptPath"
 Write-Output 'This is NOT completed migration. Verify new native/backend health and unchanged data before explicit retirement.'
} finally {if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
