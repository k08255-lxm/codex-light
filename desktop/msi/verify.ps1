param([string]$Output = (Join-Path $PSScriptRoot 'out-release-0.4.0'), [string]$Version = '0.4.0')
$ErrorActionPreference = 'Stop'
$Output = (Resolve-Path -LiteralPath $Output).Path
$msi = Join-Path $Output "CodexLight-$Version-x64.msi"
$wix = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path '.tools/wix6/wix.exe'
$extracted = Join-Path $Output ('inspect-' + [guid]::NewGuid().ToString('N'))
& $wix msi decompile $msi -o "$extracted.wxs" -x $extracted
if ($LASTEXITCODE -ne 0) { throw 'Read-only MSI decompilation failed' }
$manifest = Get-Content (Join-Path $Output 'payload-manifest.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest) {
    $file = Join-Path $extracted ('File/' + $entry.fileId)
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Cabinet hash mismatch: $($entry.path)" }
    if ((Get-Item -LiteralPath $file).Length -ne $entry.size) { throw "Cabinet length mismatch: $($entry.path)" }
}
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.OpenDatabase($msi, 0)
function Query([string]$sql, [int]$columns) {
    $view = $db.OpenView($sql)
    $null = $view.Execute()
    $rows = @()
    while ($record = $view.Fetch()) {
        $values = @()
        for ($index = 1; $index -le $columns; $index++) { $values += $record.StringData($index) }
        $rows += ,$values
    }
    $null = $view.Close()
    return ,$rows
}
$props = @{}
foreach ($row in (Query 'SELECT `Property`,`Value` FROM `Property`' 2)) { $props[$row[0]] = $row[1] }
if ($props['ProductVersion'] -ne $Version -or $props['UpgradeCode'] -ne '{C63D113F-36E4-46F6-B635-F1CE57BD166E}') { throw 'Identity mismatch' }
if ($props['ProductLanguage'] -ne '1033') { throw 'Product language must match the existing 0.2.0 installation' }
if ($props.ContainsKey('ALLUSERS')) { throw 'Expected strict per-user package' }
if ($props.ContainsKey('UILevel')) { throw 'The internal MSI must not override Setup UI level' }
$tables = Query 'SELECT `Name` FROM `_Tables`' 1
if ($tables | Where-Object { $_[0] -in @('Dialog','Control','ControlEvent','Binary') }) { throw 'The internal MSI must not contain an independent wizard or executable binary stream' }
$appSearch = @{}
foreach ($row in (Query 'SELECT `Property`,`Signature_` FROM `AppSearch`' 2)) { $appSearch[$row[0]] = $row[1] }
$registries = @{}
foreach ($row in (Query 'SELECT `Signature_`,`Root`,`Key`,`Name`,`Type` FROM `RegLocator`' 5)) { $registries[$row[0]] = $row }
$directories = @{}
foreach ($row in (Query 'SELECT `Signature_`,`Parent`,`Path`,`Depth` FROM `DrLocator`' 4)) { $directories[$row[0]] = $row }
$signatures = @{}
foreach ($row in (Query 'SELECT `Signature`,`FileName`,`MinVersion`,`MaxVersion`,`Languages` FROM `Signature`' 5)) { $signatures[$row[0]] = $row }
# Check locator links, not just presence of a file-version filter. A dangling
# DrLocator parent silently prevents the dependency from being found by AppSearch.
foreach ($row in $directories.Values) {
    if ($row[1] -and !$registries.ContainsKey($row[1]) -and !$directories.ContainsKey($row[1])) { throw "Unresolved directory locator parent: $($row[0]) -> $($row[1])" }
}
foreach ($id in $appSearch.Values) {
    if (!$registries.ContainsKey($id) -and !$directories.ContainsKey($id)) { throw "Unresolved AppSearch locator: $id" }
}
$hostSource = Get-Content (Join-Path $PSScriptRoot '../WebViewRuntime.cs') -Raw
if ($hostSource -notmatch 'const int MinimumMajor\s*=\s*(\d+)\s*;') { throw 'Cannot read host WebView2 requirement' }
$webViewMinimum = $Matches[1] + '.0.0.0'
foreach ($name in @('NODE_RUNTIME','NODE_USER_RUNTIME','WEBVIEW_MACHINE','WEBVIEW_USER','DESKTOP_RUNTIME_10','CORE_RUNTIME_10')) {
    $id = $appSearch[$name]
    if (!$id -or !$signatures.ContainsKey($id)) { throw "Missing dependency file signature: $name" }
    $signature = $signatures[$id]
    $directory = $directories[$id]
    if (!$directory) { throw "Missing dependency directory locator: $name" }
    if ($name -like 'NODE*') {
        if ($signature[1] -ne 'node.exe' -or $signature[2] -ne '20.0.0.0' -or $signature[4] -ne '1033' -or $directory[3] -ne '0') { throw "Incorrect Node.js search: $name" }
        $registry = $registries[$directory[1]]
        $registryRoot = if ($name -eq 'NODE_RUNTIME') { '2' } else { '1' }
        if (!$registry -or $registry[1] -ne $registryRoot -or $registry[2] -ne 'SOFTWARE\Node.js' -or $registry[3] -ne 'InstallPath' -or $registry[4] -ne '16') { throw "Incorrect Node.js registry locator: $name" }
    } elseif ($name -like 'WEBVIEW*') {
        if ($signature[1] -ne 'msedgewebview2.exe' -or $signature[2] -ne $webViewMinimum -or $directory[3] -ne '1') { throw "Incorrect WebView2 search: $name" }
        $registry = $registries[$directory[1]]
        $registryRoot = if ($name -eq 'WEBVIEW_MACHINE') { '2' } else { '1' }
        if (!$registry -or $registry[1] -ne $registryRoot -or $registry[2] -ne 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -or $registry[3] -ne 'location' -or $registry[4] -ne '0') { throw "Incorrect WebView2 registry locator: $name" }
    } else {
        $framework = if ($name -eq 'CORE_RUNTIME_10') { 'Microsoft.NETCore.App' } else { 'Microsoft.WindowsDesktop.App' }
        $fileName = if ($name -eq 'CORE_RUNTIME_10') { 'coreclr.dll' } else { 'PresentationFramework.dll' }
        if ($signature[1] -ne $fileName -or $signature[2] -ne '10.0.0.0' -or $signature[3] -ne '10.65535.65535.65535' -or $directory[2] -ne "[ProgramFiles64Folder]dotnet\shared\$framework" -or $directory[3] -ne '1') { throw "Incorrect .NET search: $name" }
    }
}
$conditions = Query 'SELECT `Condition` FROM `LaunchCondition`' 1
if (!($conditions | Where-Object { $_[0] -eq 'Installed OR REMOVE="ALL" OR SETUP_PREREQUISITES_VERIFIED = "1" OR (DESKTOP_RUNTIME_10 AND CORE_RUNTIME_10 AND (NODE_RUNTIME OR NODE_USER_RUNTIME) AND (WEBVIEW_MACHINE OR WEBVIEW_USER))' })) { throw 'Dependency/maintenance condition mismatch' }
if (!($conditions | Where-Object { $_[0] -eq 'Installed OR WIX_UPGRADE_DETECTED OR NOT EXISTING_TARGET' })) { throw 'Existing non-MSI target guard missing' }
if (!($conditions | Where-Object { $_[0] -eq 'NOT WIX_DOWNGRADE_DETECTED' })) { throw 'Downgrade guard missing' }
$seq = @{}
foreach ($row in (Query 'SELECT `Action`,`Sequence` FROM `InstallExecuteSequence`' 2)) { $seq[$row[0]] = [int]$row[1] }
if (!($seq.FindRelatedProducts -lt $seq.AppSearch -and $seq.AppSearch -lt $seq.RestorePreviousInstallFolder -and $seq.RestorePreviousInstallFolder -lt $seq.LaunchConditions -and $seq.InstallInitialize -lt $seq.RemoveExistingProducts -and $seq.RemoveExistingProducts -lt $seq.InstallFiles)) { throw 'Unexpected upgrade/guard sequence' }
$actions = Query 'SELECT `Action`,`Type`,`Source`,`Target` FROM `CustomAction`' 4
$expectedActions = @{
    SetARPINSTALLLOCATION = @('ARPINSTALLLOCATION', '[INSTALLFOLDER]')
    SetINSTALLFOLDER = @('INSTALLFOLDER', '[LocalAppDataFolder]Programs\CodexLight\')
    RestorePreviousInstallFolder = @('INSTALLFOLDER', '[PREVIOUS_INSTALLFOLDER]')
}
if ($actions.Count -ne $expectedActions.Count) { throw 'Internal MSI custom-action count mismatch' }
foreach ($row in $actions) {
    $expected = $expectedActions[$row[0]]
    if ([int]$row[1] -ne 51 -or !$expected -or $row[2] -ne $expected[0] -or $row[3] -ne $expected[1]) { throw "Unexpected custom action: $($row[0])" }
}
if ((Query 'SELECT `File` FROM `File`' 1).Count -ne $manifest.Count) { throw 'File table count mismatch' }
foreach ($row in (Query 'SELECT `FileName` FROM `RemoveFile`' 1)) { if ($row[0]) { throw 'Only empty-folder removal is allowed' } }
$upgrades = Query 'SELECT `VersionMin`,`VersionMax`,`Attributes`,`ActionProperty`,`Language` FROM `Upgrade`' 5
foreach ($row in $upgrades) { if ($row[4] -ne '1033') { throw 'Upgrade language must include the existing 0.2.0 package' } }
if (!($upgrades | Where-Object { $_[0] -eq '' -and $_[1] -eq $Version -and $_[2] -eq '1' -and $_[3] -eq 'WIX_UPGRADE_DETECTED' }) -or !($upgrades | Where-Object { $_[0] -eq $Version -and $_[1] -eq '' -and $_[2] -eq '2' -and $_[3] -eq 'WIX_DOWNGRADE_DETECTED' })) { throw 'Major upgrade/downgrade bounds mismatch' }
$report = [ordered]@{ msi=$msi; sha256=(Get-FileHash $msi).Hash; files=$manifest.Count; allCabinetHashesMatch=$true; perUser=$true; internalSilentPayload=$true; productLanguage=$props['ProductLanguage']; dependencyLocatorChains=$true; webViewMinimum=$webViewMinimum; upgradeSequence=$seq; customActions=$actions; boundaries='Read-only inspection; no install/uninstall/GUI. ICE could not run because Windows Installer service is inaccessible in sandbox.' }
$report | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Output 'verification.json') -Encoding utf8
Write-Output "Verified $($manifest.Count) cabinet hashes, MSI identity, strict per-user scope, dependency locator chains and versions, property-only custom actions, empty-folder cleanup, and upgrade bounds/sequence."
