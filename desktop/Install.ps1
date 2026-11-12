param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
# User-invoked preflight/installer. No execution-policy change, no silent installation.
$architecture=if($env:PROCESSOR_ARCHITEW6432){$env:PROCESSOR_ARCHITEW6432}else{$env:PROCESSOR_ARCHITECTURE}
if($architecture -ne 'AMD64'){throw 'This package supports Windows x64 only. No dependencies were installed.'}
if([Environment]::OSVersion.Version.Build -lt 19041){throw 'Windows 10 build 19041 or newer is required. This installer does not upgrade Windows.'}
$programFiles=if($env:ProgramW6432){$env:ProgramW6432}else{$env:ProgramFiles}
$runtimeConfig=Get-Content (Join-Path $PSScriptRoot 'CodexLight.runtimeconfig.json') -Raw | ConvertFrom-Json
$selfContained=@($runtimeConfig.runtimeOptions.includedFrameworks).Count -gt 0 -and $null -ne $runtimeConfig.runtimeOptions.includedFrameworks
function Test-DesktopRuntime {
 if($selfContained){return $true}
 $dotnet=Join-Path $programFiles 'dotnet\dotnet.exe'
 if(!(Test-Path $dotnet -PathType Leaf)){return $false}
 $runtimes=& $dotnet --list-runtimes
 if($LASTEXITCODE -ne 0){return $false}
 return (@($runtimes | Where-Object {$_ -match '^Microsoft.WindowsDesktop.App 10\.0\.\d+ \['}).Count -gt 0 -and @($runtimes | Where-Object {$_ -match '^Microsoft.NETCore.App 10\.0\.\d+ \['}).Count -gt 0)
}
function Test-Node {
 foreach($node in @((Join-Path $PSScriptRoot 'runtime\node.exe'),(Join-Path $programFiles 'nodejs\node.exe'))){
  if(Test-Path $node -PathType Leaf){$version=& $node --version;if($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.(\d+)\.(\d+)$' -and [int]$Matches[1] -ge 20){return $true}}
 }
 return $false
}
function Test-WebView {
 # Inspect the official EdgeUpdate registrations, not arbitrary executable names.
 foreach($base in @('HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients','HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients','HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients')){
  if(Test-Path $base){foreach($key in Get-ChildItem $base){$item=Get-ItemProperty $key.PSPath;if($item.name -eq 'Microsoft Edge WebView2 Runtime' -and $item.pv){try{if([version]$item.pv -ge [version]'142.0.0.0'){return $true}}catch{}}}}
 }
 return $false
}
function Confirm-Step([string]$Message){return (Read-Host "$Message [y/N]") -match '^(y|yes)$'}
function Assert-Signed([string]$File,[string]$Publisher){
 $signature=Get-AuthenticodeSignature -LiteralPath $File
 if($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch $Publisher){throw 'Installer signature or publisher verification failed. Nothing was executed.'}
}
function Download-Official([string]$Url,[string]$File){
 $uri=[uri]$Url
 if($uri.Scheme -ne 'https' -or $uri.Host -notin @('builds.dotnet.microsoft.com','download.visualstudio.microsoft.com','dotnetcli.azureedge.net','nodejs.org','go.microsoft.com')){throw 'Download source is not on the official allowlist.'}
 Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing
 if(!(Test-Path $File) -or (Get-Item $File).Length -eq 0){throw 'Empty dependency download'}
}
$checks=@{'Microsoft .NET 10 Windows Desktop Runtime'=(Test-DesktopRuntime);'Microsoft WebView2 Runtime (142+)'=(Test-WebView);'Node.js (20+)'=(Test-Node)}
foreach($name in $checks.Keys){Write-Host "$name : $(if($checks[$name]){'reuse installed'}else{'missing/incompatible'})"}
if($CheckOnly){if($checks.Values -contains $false){exit 2};exit 0}
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$temp=Join-Path ([IO.Path]::GetTempPath()) ('CodexLight-Dependencies-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
 if(!(Test-DesktopRuntime)){
  if(!(Confirm-Step 'Download and open the official Microsoft .NET 10 Windows Desktop Runtime installer? This may request Windows UAC approval.')){throw 'Runtime installation canceled; existing configuration unchanged.'}
  $metadata=Invoke-RestMethod 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json'
  $release=@($metadata.releases | Where-Object {$_.'release-version' -eq $metadata.'latest-release'})[0]
  $file=@($release.windowsdesktop.files | Where-Object {$_.rid -eq 'win-x64' -and $_.name -match '\.exe$'})
  if($file.Count -ne 1 -or $file[0].hash -notmatch '^[a-fA-F0-9]{128}$'){throw 'Official desktop runtime metadata is incomplete.'}
  $installer=Join-Path $temp 'windowsdesktop-runtime.exe';Download-Official $file[0].url $installer
  if((Get-FileHash $installer -Algorithm SHA512).Hash -ne $file[0].hash){throw 'Microsoft runtime SHA512 mismatch'}
  Assert-Signed $installer '(^|,\s*)O=Microsoft Corporation(,|$)'
  $process=Start-Process -FilePath $installer -Wait -PassThru
  if($process.ExitCode -notin @(0,3010) -or !(Test-DesktopRuntime)){throw 'Desktop Runtime installation was canceled or verification failed.'}
 }
 if(!(Test-WebView)){
  if(!(Confirm-Step 'Download and open the official Microsoft WebView2 Evergreen installer? Windows may request UAC approval.')){throw 'WebView2 installation canceled.'}
  $installer=Join-Path $temp 'MicrosoftEdgeWebview2Setup.exe';Download-Official 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' $installer
  Assert-Signed $installer '(^|,\s*)O=Microsoft Corporation(,|$)'
  $process=Start-Process -FilePath $installer -Wait -PassThru
  if($process.ExitCode -notin @(0,3010) -or !(Test-WebView)){throw 'WebView2 installation was canceled or verification failed.'}
 }
 if(!(Test-Node)){
  if(!(Confirm-Step 'Download and open the official Node.js 24 LTS x64 installer? Review its normal installation options; do not select optional build tools.')){throw 'Node installation canceled.'}
  $versions=Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $version=@($versions | Where-Object {$_.version -match '^v24\.' -and $_.lts -and $_.files -contains 'win-x64-msi'})[0].version
  if($version -notmatch '^v24\.\d+\.\d+$'){throw 'Official Node LTS metadata missing'}
  $name="node-$version-x64.msi";$base="https://nodejs.org/dist/$version"
  $hashes=(Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $line=@($hashes -split "`n" | Where-Object {$_ -match ('^[a-fA-F0-9]{64}\s+'+[regex]::Escape($name)+'\s*$')})
  if($line.Count -ne 1){throw 'Official Node checksum missing'}
  $expected=($line[0] -split '\s+')[0];$installer=Join-Path $temp $name;Download-Official "$base/$name" $installer
  if((Get-FileHash $installer -Algorithm SHA256).Hash -ne $expected){throw 'Node SHA256 mismatch'}
  Assert-Signed $installer '(^|,\s*)O=(OpenJS Foundation|Node.js Foundation)(,|$)'
  $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList @('/i',('"'+$installer+'"')) -Wait -PassThru
  if($process.ExitCode -notin @(0,3010) -or !(Test-Node)){throw 'Node installation was canceled or verification failed.'}
 }
 Write-Host 'All prerequisites verified. Run CodexLight.exe when ready. No model request has been sent.'
} finally {Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue}
