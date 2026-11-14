param([string]$ApkPath = "")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $PSScriptRoot "app\src\main\assets\licenses"
$names = @("CodexLight-LICENSE.txt", "THIRD-PARTY-NOTICES.txt", "ZXING-LICENSE.txt", "MATERIAL-ICONS-LICENSE.txt")
foreach ($name in $names) {
    $file = Join-Path $assets $name
    if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw "Missing Android license asset: $name" }
}
foreach ($pair in @(@((Join-Path $root "LICENSE"), (Join-Path $assets "CodexLight-LICENSE.txt")), @((Join-Path $PSScriptRoot "libs\ZXING-LICENSE.txt"), (Join-Path $assets "ZXING-LICENSE.txt")))) {
    if ((Get-FileHash -LiteralPath $pair[0]).Hash -ne (Get-FileHash -LiteralPath $pair[1]).Hash) { throw "Android license asset does not match its source: $($pair[1])" }
}
if ($ApkPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ApkPath).Path)
    try {
        foreach ($name in $names) {
            $entry = $zip.GetEntry("assets/licenses/$name")
            if (!$entry) { throw "APK is missing license asset: $name" }
            $stream = $entry.Open()
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace("-", "") }
            finally { $hash.Dispose(); $stream.Dispose() }
            if ($actual -ne (Get-FileHash -LiteralPath (Join-Path $assets $name) -Algorithm SHA256).Hash) { throw "APK license content mismatch: $name" }
        }
    } finally { $zip.Dispose() }
}
Write-Host "Android license assets verified."
