. (Join-Path $PSScriptRoot 'FixtureGuard.ps1')
$plan=[pscustomobject]@{FixtureId='Fixture';ProductCode='{E625287A-7533-422B-94B8-06CD5CFF1F1E}'}
$root='C:\Temp\Fixture'
$valid=@{State=5;Name='Fixture';Assignment='0';Version='1.0.0';Source=$root}
Assert-FixtureIdentity ([pscustomobject]$valid) $plan $root
$count=1
foreach($field in @('State','Name','Assignment','Version','Source')){
 $bad=$valid.Clone();$bad[$field]=if($field -eq 'State'){1}elseif($field -eq 'Source'){'C:\Temp\Other'}else{'wrong'}
 $rejected=$false;try{Assert-FixtureIdentity ([pscustomobject]$bad) $plan $root}catch{$rejected=$true}
 if(!$rejected){throw "Accepted wrong $field"};$count++
}
foreach($name in @('FixtureGuard.ps1','Run-ReviewedFixture.ps1','Resume-ReviewedFixture.ps1')){
 $tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw ($errors|Out-String)};$count++
}
Write-Output "PASS $count simulated identity / syntax checks. No registry reads or installers executed."
