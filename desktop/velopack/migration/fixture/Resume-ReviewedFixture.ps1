$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'FixtureGuard.ps1')
$msiInventory=New-Object -ComObject WindowsInstaller.Installer
$root='C:\Users\Lee\AppData\Local\Temp\CodexLightMigrationFixture-12a5b1f3248c4468be6e884ad1906a18'
$plan=Get-Content (Join-Path $root 'review-plan.json') -Raw|ConvertFrom-Json
$expectedId='CodexLightMigrationFixture-12a5b1f3248c4468be6e884ad1906a18'
if($plan.FixtureId -ne $expectedId -or $plan.ProductCode -ne '{E625287A-7533-422B-94B8-06CD5CFF1F1E}' -or $plan.UpgradeCode -ne '{8F59CF02-A965-4CB1-B1D0-8B01F5D22D19}'){throw 'Fixture identity differs from reviewed plan'}
foreach($p in @($root,$plan.OldRoot,$plan.NewRoot,$plan.DataRoot,$plan.Msi,$plan.VendorSetup)){if(!(SameRoot $p $root) -and ![IO.Path]::GetFullPath($p).StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Path outside reviewed fixture'};for($a=$p;$a;$a=[IO.Path]::GetDirectoryName($a)){if((Test-Path -LiteralPath $a) -and ((Get-Item -LiteralPath $a -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse point'}}}
if((Get-FileHash $plan.Msi).Hash.ToLowerInvariant() -ne '83a28b6e4dcad1f46a52cc59fbeceb90b2fcbfaf3f4d5011b8a487ffe153e361'){throw 'MSI changed'}
$oldKey='Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$plan.ProductCode;$newKey='Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$plan.FixtureId
function KeyExists([string]$key){if($key -eq $oldKey){return (Test-FixtureOldRegistered $msiInventory $plan $root)};$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key);try{return $null -ne $k}finally{if($k){$k.Close()}}}
function DataHash {return (Get-FileHash (Join-Path $plan.DataRoot 'sentinel.txt')).Hash.ToLowerInvariant()}
if(!(Test-FixtureOldRegistered $msiInventory $plan $root)){throw 'Old fixture not installed'}
if((Test-Path $plan.NewRoot) -or (KeyExists $newKey)){throw 'New fixture already installed'}
if((DataHash) -ne $plan.DataSha256){throw 'Data sentinel changed'}
$results=New-Object Collections.Generic.List[object];foreach($record in @(Get-Content (Join-Path $root 'execution-results.json') -Raw|ConvertFrom-Json)){$results.Add($record)}
function Save { $results|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $root 'execution-results.json') -Encoding utf8 }
function Run([string]$name,[string]$file,[string[]]$arguments){$sw=[Diagnostics.Stopwatch]::StartNew();$p=Start-Process -FilePath $file -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru;$sw.Stop();$item=[ordered]@{Step=$name;ExitCode=$p.ExitCode;Ms=$sw.ElapsedMilliseconds;DataHash=(DataHash);OldRegistered=(KeyExists $oldKey);OldArp=@(Get-FixtureArp $oldKey);NewRegistered=(KeyExists $newKey)};$results.Add($item);Save;Write-Output ($item|ConvertTo-Json -Compress);return $p.ExitCode}
# Capture Run output without confusing its final return code.
function Checked([string]$name,[string]$file,[string[]]$arguments,[int]$expected=0){$output=@(Run $name $file $arguments);$output|Select-Object -SkipLast 1|Write-Host;$exit=$output[-1];if($exit -ne $expected){throw "$name exit $exit, expected $expected"};if((DataHash) -ne $plan.DataSha256){throw 'External fixture data changed'}}
$msiexec=Join-Path ([Environment]::GetFolderPath('System')) 'msiexec.exe'
# Old installation already completed and its exact MSI registration was reviewed.
if(!(KeyExists $oldKey)){throw 'Old MSI registration missing'}
$oldExe=Join-Path $plan.OldRoot ($plan.FixtureId+'.exe');Checked 'old-health' $oldExe @('--fixture-health')
Checked 'stage-new-velopack' $plan.VendorSetup @('--silent','--installto',('"'+$plan.NewRoot+'"'),'--log',('"'+(Join-Path $root 'velo-install.log')+'"'),'--','--fixture-stage')
if(!(KeyExists $oldKey) -or !(KeyExists $newKey)){throw 'Registration after staging unexpected'}
$newExe=Join-Path $plan.NewRoot ('current/'+$plan.FixtureId+'.exe');Checked 'new-health' $newExe @('--fixture-health')
$payload=Join-Path $plan.NewRoot 'current/payload.txt';$original=Join-Path $root 'payload-1.1.0/payload.txt';$before=(Get-FileHash $payload).Hash
Set-Content -LiteralPath $payload -Value 'deliberately corrupt isolated fixture only' -Encoding ascii
try{Checked 'new-corrupt-health' $newExe @('--fixture-health') 22;Checked 'old-still-healthy-after-failure' $oldExe @('--fixture-health');if(!(KeyExists $oldKey)){throw 'Old MSI lost after new failure'}}finally{Copy-Item -LiteralPath $original -Destination $payload -Force;if((Get-FileHash $payload).Hash -ne $before){throw 'Fixture payload restoration failed'}}
Checked 'new-restored-health' $newExe @('--fixture-health')
Checked 'retire-old-msi' $msiexec @('/x',$plan.ProductCode,'/qn','/norestart','/L*v',('"'+(Join-Path $root 'old-uninstall.log')+'"'))
if((KeyExists $oldKey) -or @(Get-FixtureArp $oldKey).Count -gt 0){throw 'Old MSI still registered'}
Checked 'new-health-after-retirement' $newExe @('--fixture-health')
Write-Output 'ISOLATED MIGRATION PASSED; new fixture retained pending normal uninstall review. No production app acceptance implied.'



