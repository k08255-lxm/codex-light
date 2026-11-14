param([Parameter(Mandatory=$true)][string]$WixPath)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$vpk=Join-Path $repo '.eval/preview-1.3.39/tools/vpk.exe'
if((& $WixPath --version) -notmatch '^6\.0\.2\+'){throw 'WiX version'}
if((& $vpk --help|Out-String) -notmatch '1\.3\.39-g8d2844f'){throw 'vpk version'}
$id='CodexLightMigrationFixture-'+[guid]::NewGuid().ToString('N');$out=Join-Path ([IO.Path]::GetTempPath()) $id
if(Test-Path -LiteralPath $out){throw 'Unexpected existing fixture'}
New-Item -ItemType Directory -Path $out|Out-Null
$source=Join-Path $out 'source';New-Item -ItemType Directory -Path $source|Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Program.cs') -Destination $source
$project='<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>WinExe</OutputType><TargetFramework>net10.0-windows</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><AssemblyName>'+ $id +'</AssemblyName><DebugType>none</DebugType></PropertyGroup><ItemGroup><PackageReference Include="Velopack" Version="1.3.39-g8d2844f" /></ItemGroup></Project>'
$project|Set-Content -LiteralPath (Join-Path $source 'Fixture.csproj') -Encoding utf8
foreach($version in @('1.0.0','1.1.0')){
 $payload=Join-Path $out ('payload-'+$version)
 dotnet publish (Join-Path $source 'Fixture.csproj') -c Release -r win-x64 --self-contained false -p:Version=$version -o $payload --source https://api.nuget.org/v3/index.json --nologo
 if($LASTEXITCODE -ne 0){throw 'Compile failed'}
 Set-Content -LiteralPath (Join-Path $payload 'fixture-id.txt') -Value $id -Encoding ascii
 Set-Content -LiteralPath (Join-Path $payload 'payload.txt') -Value "Benign fixture $version" -Encoding ascii
 $hashes=[ordered]@{};Get-ChildItem -LiteralPath $payload -File -Recurse|Sort-Object FullName|ForEach-Object {$hashes[$_.FullName.Substring($payload.Length+1)]=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}
 $hashes|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $payload 'fixture-hashes.json') -Encoding utf8
}
$upgrade=[guid]::NewGuid().ToString('B').ToUpperInvariant();$product=[guid]::NewGuid().ToString('B').ToUpperInvariant()
$oldRoot=Join-Path $out 'installed-msi';$newRoot=Join-Path $out 'installed-velopack';$dataRoot=Join-Path $out 'fixture-data'
New-Item -ItemType Directory -Path $dataRoot|Out-Null;Set-Content -LiteralPath (Join-Path $dataRoot 'sentinel.txt') -Value 'Keep this independent test data.' -Encoding ascii
$xml=New-Object Xml.XmlDocument;$root=$xml.CreateElement('Wix','http://wixtoolset.org/schemas/v4/wxs');$xml.AppendChild($root)|Out-Null
function Element($parent,$name,$attributes){$node=$xml.CreateElement($name,$root.NamespaceURI);foreach($key in $attributes.Keys){$node.SetAttribute($key,[string]$attributes[$key])};$parent.AppendChild($node)|Out-Null;return $node}
$package=Element $root 'Package' @{Name=$id;Manufacturer='Codex Light isolated fixture';Version='1.0.0';ProductCode=$product;UpgradeCode=$upgrade;Scope='perUser';Language='1033';InstallerVersion='500'}
Element $package 'MediaTemplate' @{EmbedCab='yes'}|Out-Null
Element $package 'Property' @{Id='INSTALLFOLDER';Value=$oldRoot}|Out-Null
$standard=Element $package 'StandardDirectory' @{Id='LocalAppDataFolder'};$directory=Element $standard 'Directory' @{Id='INSTALLFOLDER';Name=$id};$feature=Element $package 'Feature' @{Id='Main';Title=$id;Level='1'}
$i=0;foreach($file in Get-ChildItem -LiteralPath (Join-Path $out 'payload-1.0.0') -File){$i++;$comp=Element $directory 'Component' @{Id="C$i";Guid=[guid]::NewGuid().ToString('B')};Element $comp 'RegistryValue' @{Root='HKCU';Key="Software\$id";Name="file$i";Type='integer';Value='1';KeyPath='yes'}|Out-Null;Element $comp 'File' @{Id="F$i";Source=$file.FullName}|Out-Null;Element $feature 'ComponentRef' @{Id="C$i"}|Out-Null}
$wxs=Join-Path $out 'Fixture.wxs';$xml.Save($wxs);$msi=Join-Path $out ($id+'.msi');& $WixPath build $wxs -arch x64 -o $msi -pdbtype none;if($LASTEXITCODE -ne 0){throw 'WiX failed'}
$release=Join-Path $out 'velopack';New-Item -ItemType Directory -Path $release|Out-Null
& $vpk pack --packId $id --packVersion 1.1.0 --packDir (Join-Path $out 'payload-1.1.0') --mainExe ($id+'.exe') --outputDir $release --shortcuts None --delta None --skipVeloAppCheck
if($LASTEXITCODE -ne 0){throw 'Velopack failed'}
$plan=[ordered]@{BuildOnly=$true;Installed=$false;FixtureId=$id;ProductCode=$product;UpgradeCode=$upgrade;OldRoot=$oldRoot;NewRoot=$newRoot;DataRoot=$dataRoot;DataSha256=(Get-FileHash (Join-Path $dataRoot 'sentinel.txt')).Hash.ToLowerInvariant();Msi=$msi;MsiSha256=(Get-FileHash $msi).Hash.ToLowerInvariant();VendorSetup=(Join-Path $release ($id+'-win-Setup.exe'));MsiRegistry="HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product";VeloRegistry="HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\$id";ComponentRegistry="HKCU\Software\$id";Shortcuts='None';CustomActions='None';EnvironmentChanges='None';Vpk='1.3.39-g8d2844f';ReviewRequired=$true}
$plan|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $out 'review-plan.json') -Encoding utf8
$plan|ConvertTo-Json -Depth 6
Write-Output 'BUILD ONLY. No installer/application executed. Review required.'

