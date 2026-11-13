param([ValidateSet('win-x64')][string]$Runtime='win-x64',[switch]$SelfContained)
$ErrorActionPreference='Stop'
$project=Join-Path $PSScriptRoot 'CodexLight.Desktop.csproj'
$root=Split-Path $PSScriptRoot -Parent
if (!(Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET 10 SDK is required. Install only from https://dotnet.microsoft.com/download/dotnet/10.0' }
$bridge=Join-Path $root 'components\dsh-bridge'
if (!(Get-Command node -ErrorAction SilentlyContinue) -or !(Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js with npm is required to build the bundled MCP bridge.' }
# Build-only dependency restore: exact lock, public registry, no lifecycle scripts.
# DSH itself is optional and is never downloaded or started by this build.
& npm.cmd ci --prefix $bridge --ignore-scripts --omit=dev --registry=https://registry.npmjs.org --audit=false --fund=false
if ($LASTEXITCODE -ne 0) { throw 'Bundled DSH bridge dependency restore failed' }
& node (Join-Path $bridge 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Bundled DSH bridge verification failed' }
$selfContainedValue=$SelfContained.IsPresent.ToString().ToLowerInvariant()
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
$out=Join-Path $PSScriptRoot "dist\CodexLight-$Runtime-$stamp"
if (Test-Path $out) { throw 'Output directory already exists; will not overwrite.' }
# Only the official NuGet feed is used. No install scripts or model calls.
& dotnet restore $project --runtime $Runtime -p:SelfContained=$selfContainedValue --source 'https://api.nuget.org/v3/index.json'
if ($LASTEXITCODE -ne 0) { throw 'Restore failed' }
& dotnet publish $project --configuration Release --runtime $Runtime --self-contained $selfContainedValue --no-restore --output $out -p:PublishSingleFile=false -p:PublishTrimmed=false
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
$app=Join-Path $out 'app'
New-Item -ItemType Directory -Path $app | Out-Null
Copy-Item (Join-Path $root 'src') $app -Recurse
Copy-Item (Join-Path $root 'public') $app -Recurse
Copy-Item (Join-Path $root 'package.json') $app
$components=Join-Path $app 'components'
New-Item -ItemType Directory -Path $components | Out-Null
Copy-Item -LiteralPath $bridge -Destination (Join-Path $components 'dsh-bridge') -Recurse
Copy-Item (Join-Path $PSScriptRoot 'README.md') $out
Copy-Item (Join-Path $PSScriptRoot 'INSTALLATION.md') $out
# Collect notices from the exact packages selected by restore and framework
# versions actually included by publish. Missing licenses fail the build.
$runtimeConfig = Get-Content (Join-Path $out 'CodexLight.runtimeconfig.json') -Raw | ConvertFrom-Json
$assets = Get-Content (Join-Path $PSScriptRoot 'obj\project.assets.json') -Raw | ConvertFrom-Json
$packageRoots = @($assets.packageFolders.PSObject.Properties.Name)
if ($packageRoots.Count -eq 0) { throw 'NuGet global package roots missing from project.assets.json' }
function Get-IncludedVersion([string]$Name) {
    $matches = @($runtimeConfig.runtimeOptions.includedFrameworks | Where-Object { $_.name -eq $Name })
    if ($matches.Count -ne 1 -or [string]::IsNullOrWhiteSpace($matches[0].version)) {
        throw "Published included framework version missing/ambiguous: $Name"
    }
    return [string]$matches[0].version
}
function Find-PackageFile([string]$Package, [string]$Version, [string]$File) {
    foreach ($base in $packageRoots) {
        $candidate = Join-Path (Join-Path (Join-Path $base $Package.ToLowerInvariant()) $Version.ToLowerInvariant()) $File
        if (Test-Path $candidate -PathType Leaf) { return $candidate }
    }
    throw "Required license is missing from restored package: $Package/$Version/$File"
}
$coreVersion = $null
$desktopVersion = $null
if ($SelfContained) {
    $coreVersion = Get-IncludedVersion 'Microsoft.NETCore.App'
    $desktopVersion = Get-IncludedVersion 'Microsoft.WindowsDesktop.App'
}
$webLibraries = @($assets.libraries.PSObject.Properties.Name | Where-Object { $_ -match '^Microsoft\.Web\.WebView2/' })
if ($webLibraries.Count -ne 1) { throw 'Resolved WebView2 package version is missing/ambiguous' }
$webVersion = $webLibraries[0].Split('/')[1]
$licenseSources = @(
    @{ Source = (Find-PackageFile 'microsoft.web.webview2' $webVersion 'LICENSE.txt'); Name = 'WebView2-LICENSE.txt' },
    @{ Source = (Find-PackageFile 'microsoft.web.webview2' $webVersion 'NOTICE.txt'); Name = 'WebView2-NOTICE.txt' },
    @{ Source = (Join-Path $root 'LICENSE'); Name = 'CodexLight-LICENSE.txt' }
)
if ($SelfContained) {
    $licenseSources += @(
        @{ Source = (Find-PackageFile "microsoft.netcore.app.runtime.$Runtime" $coreVersion 'LICENSE.TXT'); Name = 'DotNet-LICENSE.txt' },
        @{ Source = (Find-PackageFile "microsoft.netcore.app.runtime.$Runtime" $coreVersion 'THIRD-PARTY-NOTICES.TXT'); Name = 'DotNet-THIRD-PARTY-NOTICES.txt' },
        @{ Source = (Find-PackageFile "microsoft.windowsdesktop.app.runtime.$Runtime" $desktopVersion 'LICENSE'); Name = 'WindowsDesktop-LICENSE.txt' }
    )
} else {
    # Framework-dependent still redistributes the native apphost executable.
    $hostId = "microsoft.netcore.app.host.$Runtime"
    $resolvedJson = & dotnet msbuild $project -t:ResolveFrameworkReferences "-p:RuntimeIdentifier=$Runtime" -p:SelfContained=false -getItem:ResolvedAppHostPack -getProperty:NetCoreRoot,NETCoreSdkVersion
    if ($LASTEXITCODE -ne 0) { throw 'Apphost pack resolution failed' }
    $resolved = ($resolvedJson -join "`n") | ConvertFrom-Json
    $hostPacks = @($resolved.Items.ResolvedAppHostPack)
    if ($hostPacks.Count -ne 1 -or $hostPacks[0].RuntimeIdentifier -ne $Runtime) { throw 'Resolved apphost pack missing/ambiguous or runtime mismatch' }
    $hostPack = $hostPacks[0]
    foreach ($path in @($hostPack.PackageDirectory, $hostPack.Path, $resolved.Properties.NetCoreRoot)) {
        if ([string]::IsNullOrWhiteSpace($path) -or $path -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)') { throw 'Resolved apphost/SDK path must be absolute' }
    }
    $packDirectory = [IO.Path]::GetFullPath($hostPack.PackageDirectory).TrimEnd([char[]]'\/')
    $hostVersion = Split-Path $packDirectory -Leaf
    if ($hostVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Resolved apphost pack version is invalid' }
    $sdkRoot = [IO.Path]::GetFullPath($resolved.Properties.NetCoreRoot)
    $sdkVersion = [string]$resolved.Properties.NETCoreSdkVersion
    if ($sdkVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Resolved SDK version is invalid' }
    $sdkPackDirectory = [IO.Path]::GetFullPath((Join-Path $sdkRoot "packs\$hostId\$hostVersion"))
    $fromSdk = $packDirectory.Equals($sdkPackDirectory, [StringComparison]::OrdinalIgnoreCase)
    $fromNuGet = $false
    foreach ($base in $packageRoots) {
        $expected = [IO.Path]::GetFullPath((Join-Path $base "$hostId\$hostVersion"))
        if ($packDirectory.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { $fromNuGet = $true }
    }
    if (!$fromSdk -and !$fromNuGet) { throw 'Resolved apphost pack is outside the SDK packs and restored NuGet roots' }
    $hostPath = [IO.Path]::GetFullPath($hostPack.Path)
    if (!$hostPath.StartsWith($packDirectory + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $hostPath -PathType Leaf)) { throw 'Resolved apphost executable is missing or outside its pack' }
    $hostLicense = Join-Path $packDirectory 'LICENSE.TXT'
    $hostNotices = Join-Path $packDirectory 'THIRD-PARTY-NOTICES.TXT'
    # Installed SDK packs omit their own notices; use only that resolved SDK's
    # root notices. NuGet packages must carry their package-local notices.
    if ($fromSdk -and !(Test-Path -LiteralPath $hostLicense -PathType Leaf)) {
        $hostLicense = Join-Path $sdkRoot 'LICENSE.txt'
        $hostNotices = Join-Path $sdkRoot 'ThirdPartyNotices.txt'
    }
    $licenseSources += @(
        @{ Source = $hostLicense; Name = 'DotNet-AppHost-LICENSE.txt' },
        @{ Source = $hostNotices; Name = 'DotNet-AppHost-THIRD-PARTY-NOTICES.txt' }
    )
}
$licenses = Join-Path $out 'licenses'
New-Item -ItemType Directory -Path $licenses | Out-Null
$bridgeLicenses=Join-Path $licenses 'dsh-bridge'
New-Item -ItemType Directory -Path $bridgeLicenses | Out-Null
Copy-Item -LiteralPath (Join-Path $bridge 'LICENSE') -Destination (Join-Path $bridgeLicenses 'Bridge-MIT-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $bridge 'assets\DeepSeek-MIT-LICENSE') -Destination (Join-Path $bridgeLicenses 'DeepSeek-MIT-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $bridge 'THIRD-PARTY-NOTICES.md') -Destination $bridgeLicenses
Copy-Item -Path (Join-Path $bridge 'licenses\*') -Destination $bridgeLicenses -Recurse
$terminalLicenses = Join-Path $licenses 'xterm'
New-Item -ItemType Directory -Path $terminalLicenses | Out-Null
foreach ($name in @('LICENSE','addon-fit-LICENSE')) {
    $source = Join-Path (Join-Path $root 'licenses/xterm') $name
    if (!(Test-Path -LiteralPath $source -PathType Leaf) -or (Get-Item -LiteralPath $source).Length -eq 0) { throw "Required terminal license missing: $name" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $terminalLicenses $name)
}
$licenseSources += @{ Source = (Join-Path $root 'docs/THIRD-PARTY-NOTICES.md'); Name = 'THIRD-PARTY-NOTICES.md' }
foreach ($entry in $licenseSources) {
    if (!(Test-Path $entry.Source -PathType Leaf) -or (Get-Item $entry.Source).Length -eq 0) { throw "Required license missing/empty: $($entry.Name)" }
    Copy-Item -LiteralPath $entry.Source -Destination (Join-Path $licenses $entry.Name)
}
$versions = @("xterm.js 6.0.0", "@xterm/addon-fit 0.11.0", "Microsoft.Web.WebView2 $webVersion", "Runtime $Runtime", "SelfContained $selfContainedValue")
if ($SelfContained) { $versions += @("Microsoft.NETCore.App $coreVersion", "Microsoft.WindowsDesktop.App $desktopVersion") }
else { $versions += @("Microsoft.NETCore.App.Host.$Runtime $hostVersion", ".NET SDK $sdkVersion") }
$versions | Set-Content (Join-Path $licenses 'VERSIONS.txt') -Encoding UTF8
# Publish the launch pointer only after the complete payload and notices exist.
$dist = Split-Path $out -Parent
$manifest = Join-Path $dist 'current.json'
$manifestTemp = Join-Path $dist ('.current-' + [Guid]::NewGuid().ToString('N') + '.tmp')
$manifestJson = @{ directory = (Split-Path $out -Leaf) } | ConvertTo-Json -Compress
try {
    [IO.File]::WriteAllText($manifestTemp, $manifestJson, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $manifest) {
        [IO.File]::Replace($manifestTemp, $manifest, $null)
    } else {
        [IO.File]::Move($manifestTemp, $manifest)
    }
} finally {
    if (Test-Path -LiteralPath $manifestTemp) { Remove-Item -LiteralPath $manifestTemp }
}
Write-Host "Built: $out\CodexLight.exe"
Write-Host 'Application payload built. Build and verify the internal MSI, then build CodexLight-Setup-<version>-x64.exe; see desktop/msi/README.md and desktop/setup/README.md.'
