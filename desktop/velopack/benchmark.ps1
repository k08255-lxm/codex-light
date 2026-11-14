param([Parameter(Mandatory=$true)][string]$WorkRoot,[ValidateRange(1,10)][int]$Runs=3,[switch]$Full)
$ErrorActionPreference='Stop'
$base=[IO.Path]::GetFullPath($WorkRoot)
if(!(Test-Path -LiteralPath (Join-Path $base '.codex-light-velopack-benchmark'))){throw 'Explicit isolated benchmark workspace marker required'}
$old=Join-Path $base 'releases/CodexLightBenchIsolated-0.4.2-full.nupkg'
$delta=Join-Path $base 'releases/CodexLightBenchIsolated-0.4.3-delta.nupkg'
$new=Join-Path $base 'releases/CodexLightBenchIsolated-0.4.3-full.nupkg'
$results=@()
for($i=1;$i -le $Runs;$i++){
 $target=Join-Path $base ('run-'+[guid]::NewGuid().ToString('N'))
 New-Item -ItemType Directory -Path $target|Out-Null
 $sw=[Diagnostics.Stopwatch]::StartNew()
 python -c "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" (Join-Path $base 'old-portable.zip') $target
 if($LASTEXITCODE -ne 0){throw 'Initial extraction failed'}
 $extractMs=$sw.ElapsedMilliseconds
 if(!(Test-Path -LiteralPath (Join-Path $target '.portable'))){throw 'Not a portable root; refusing any updater operation'}
 $update=Join-Path $target 'Update.exe'
 $reconstructed=Join-Path $target 'reconstructed.nupkg'
 if($Full){$reconstructed=$new;$patchMs=0}else{
 $patchLog=Join-Path $target 'patch.log'
 $sw.Restart()
 $p=Start-Process -FilePath $update -ArgumentList @('--silent','--rootDir',('"'+$target+'"'),'--log',('"'+$patchLog+'"'),'patch','--old',('"'+$old+'"'),'--delta',('"'+$delta+'"'),'--output',('"'+$reconstructed+'"')) -WindowStyle Hidden -PassThru -Wait
 $patchMs=$sw.ElapsedMilliseconds
 if($p.ExitCode -ne 0){throw "Patch failed $($p.ExitCode)"}
 }
 $applyLog=Join-Path $target 'apply.log'
 $sw.Restart()
 $p=Start-Process -FilePath $update -ArgumentList @('--silent','--rootDir',('"'+$target+'"'),'--log',('"'+$applyLog+'"'),'apply','--package',('"'+$reconstructed+'"'),'--norestart') -WindowStyle Hidden -PassThru -Wait
 $applyMs=$sw.ElapsedMilliseconds
 if($p.ExitCode -ne 0){throw "Apply failed $($p.ExitCode)"}
 $expected=Join-Path $base 'payload-new'
 foreach($file in Get-ChildItem -LiteralPath $expected -File -Recurse){
  $relative=$file.FullName.Substring($expected.Length+1)
  $actual=Join-Path (Join-Path $target 'current') $relative
  if(!(Test-Path -LiteralPath $actual) -or (Get-FileHash -LiteralPath $actual).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash){throw "Payload mismatch $relative"}
 }
 $results += [pscustomobject]@{run=$i;mode=$(if($Full){'full'}else{'delta'});initialPortableExtractMs=$extractMs;deltaReconstructMs=$patchMs;applyMs=$applyMs;updateLocalTotalMs=$patchMs+$applyMs;root=$target;verified=$true}
 $results|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $base ('benchmark-'+$(if($Full){'full'}else{'delta'})+'.json')) -Encoding utf8
 $results[-1]|ConvertTo-Json -Compress
}
