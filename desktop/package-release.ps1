param(
    [string]$Version = '0.3.0',
    [string]$MsiPath = (Join-Path $PSScriptRoot 'msi/out-release-0.3.0/CodexLight-0.3.0-x64.msi'),
    [string]$SetupPath = (Join-Path $PSScriptRoot 'setup/out-release-0.3.0/CodexLight-Setup.exe'),
    [string]$OutputRoot = (Join-Path $PSScriptRoot 'dist')
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a three-part release version.' }
$package = (Resolve-Path -LiteralPath $MsiPath).Path
$setup = (Resolve-Path -LiteralPath $SetupPath).Path
$root = [IO.Path]::GetFullPath($OutputRoot)
$directory = Join-Path $root "CodexLight-$Version"
$archive = "$directory.zip"
if ((Test-Path -LiteralPath $directory) -or (Test-Path -LiteralPath $archive)) {
    throw 'Release output already exists. Use a new version/output directory; do not overwrite a distributed package.'
}
if ((Get-Item -LiteralPath $setup).VersionInfo.FileVersion -ne "$Version.0") {
    throw 'Setup file version does not match release version.'
}
# Static PE inspection only. Never load or execute the generated installer.
& python (Join-Path $PSScriptRoot 'setup/verify-resource.py') $setup $package
if ($LASTEXITCODE -ne 0) { throw 'Setup does not embed the exact release MSI.' }
$verification = Get-Content -LiteralPath (Join-Path (Split-Path $package) 'verification.json') -Raw | ConvertFrom-Json
$receipt = Get-Content -LiteralPath (Join-Path (Split-Path $setup) 'build-receipt.json') -Raw | ConvertFrom-Json
$msiHash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash
$setupHash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash
if ($verification.sha256 -ne $msiHash -or !$verification.allCabinetHashesMatch -or !$verification.perUser -or !$verification.dependencyLocatorChains) {
    throw 'MSI verification is missing, failed or stale. Run msi/verify.ps1 against this package first.'
}
if ([IO.Path]::GetFileName($package) -ne "CodexLight-$Version-x64.msi") {
    throw 'MSI filename does not match release version.'
}
if ($receipt.msiSha256 -ne $msiHash -or $receipt.setupSha256 -ne $setupHash) {
    throw 'Setup build receipt is stale.'
}
New-Item -ItemType Directory -Path $directory | Out-Null
Copy-Item -LiteralPath $setup -Destination (Join-Path $directory 'CodexLight-Setup.exe')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'INSTALLATION.md') -Destination (Join-Path $directory 'INSTALLATION.md')
$readme = @"
# Codex Light $Version · Windows x64

将整个 ZIP 解压到下载等普通文件夹，打开 CodexLight-Setup.exe。
选择安装位置后点击“安装”；已有 MSI 安装会沿用原位置更新。安装器会复用已有运行环境，只补充缺失的 Node.js、.NET Desktop 与 WebView2；无需手动安装 Node 或开发工具。

EXE 已内置 MSI，不需要再找另一个安装包。默认安装到当前用户的 Programs/CodexLight，开始菜单提供应用入口。卸载使用 Windows 设置中的“已安装的应用”。安装完成不会自动打开应用。

旧版非 MSI 安装不会被覆盖。首次安装请使用尚不存在的新目录；无需预先创建。项目、共享 Codex 配置和用户会话不随卸载删除。

此版本尚未代码签名。当前电脑正常启动不代表所有电脑都会免提示；Windows 仍可能显示未知发布者或 SmartScreen 提示。

构建流程会校验内部安装包内容、升级表及嵌入资源；这些检查不代表所有电脑上的实机兼容性。安装与依赖说明见 INSTALLATION.md，SHA256SUMS.txt 可核对包内文件。
"@
Set-Content -LiteralPath (Join-Path $directory 'README.md') -Value $readme -Encoding utf8
$hashes = Get-ChildItem -LiteralPath $directory -File | Sort-Object Name | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
}
Set-Content -LiteralPath (Join-Path $directory 'SHA256SUMS.txt') -Value $hashes -Encoding ascii
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $directory -File).FullName -DestinationPath $archive -CompressionLevel Optimal
Get-FileHash -LiteralPath $archive -Algorithm SHA256
Write-Output 'Archive created only. Do not launch workspace EXEs; extract the release into an ordinary destination and inspect file integrity there.'
