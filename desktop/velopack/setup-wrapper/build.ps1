param([Parameter(Mandatory=$true)][string]$VendorSetup,[Parameter(Mandatory=$true)][string]$Output,[Parameter(Mandatory=$true)][string]$Version,[string]$CliPrerequisiteProject)
$ErrorActionPreference='Stop'
$vendor=(Resolve-Path -LiteralPath $VendorSetup).Path
$out=[IO.Path]::GetFullPath($Output)
if(Test-Path -LiteralPath $out){throw 'Wrapper output must be a new directory'}
if($Version -notmatch '^\d+\.\d+\.\d+$'){throw 'Product version required'}
function Plain([string]$p){while($p){if((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Reparse paths refused'};$p=[IO.Path]::GetDirectoryName($p)}}
Plain $vendor;Plain $out
$hash=(Get-FileHash -LiteralPath $vendor -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Path $out|Out-Null
$hashFile=Join-Path $out 'vendor.sha256'
$hash|Set-Content -LiteralPath $hashFile -Encoding ascii
$bin=Join-Path $out 'bin'
$extra=@();if($CliPrerequisiteProject){$extra+="-p:CliPrerequisiteProject=$((Resolve-Path -LiteralPath $CliPrerequisiteProject).Path)"}
dotnet build (Join-Path $PSScriptRoot 'SetupWrapper.csproj') -c Release "-p:Version=$Version" "-p:VendorSetup=$vendor" "-p:VendorHash=$hashFile" -p:DebugSymbols=false -p:DebugType=none -o $bin --source https://api.nuget.org/v3/index.json --nologo @extra
if($LASTEXITCODE -ne 0){throw 'New-install wrapper build failed'}
if((Get-FileHash -LiteralPath $vendor).Hash.ToLowerInvariant() -ne $hash){throw 'Vendor changed during wrapper build'}
$public=Join-Path $out 'public'
New-Item -ItemType Directory -Path $public|Out-Null
Get-ChildItem -LiteralPath $bin -File|Where-Object {$_.Extension -in @('.exe','.dll','.config')}|ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $public}
@'
Codex Light 新电脑安装入口
解压后打开 CodexLight-Install.exe。先复用已有兼容 Node.js 22.15+（满足 DSH 桥）和 Codex CLI；缺失项分别经明确同意才从锁定官方来源安装。不会自动登录或修改已有 Codex 配置/PATH。
这仅用于首次安装。存在 Codex Light 程序、登记或数据时会停止，不能覆盖旧 MSI；旧用户请使用更新/迁移流程。
确认任务结束才安装。系统安全拦截、权限错误、取消或需要重启时停止，不要管理员绕过、禁用防护或删除旧程序/备份。
采用 Velopack 1.3.39-g8d2844f 预发布依赖，应用安装包尚未数字签名。打开入口会实际检查/安装；成功后安装器可能自动打开新应用。
官方 npm Codex CLI 平台包下载约 187 MB、展开约 515 MB，临时解包另外占空间；工具装入本应用私有用户目录，不替换已有系统 CLI。
'@|Set-Content -LiteralPath (Join-Path $public '安装说明.txt') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../../LICENSE') -Destination (Join-Path $public 'LICENSE.txt')
Get-ChildItem -LiteralPath $public -File|Sort-Object Name|ForEach-Object {'{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant(),$_.Name}|Set-Content -LiteralPath (Join-Path $public 'SHA256SUMS.txt') -Encoding utf8
Compress-Archive -Path (Join-Path $public '*') -DestinationPath (Join-Path $out "CodexLight-NewInstall-$Version-x64.zip")
[pscustomobject]@{VendorSha256=$hash;Wrapper=(Join-Path $public 'CodexLight-Install.exe');Zip=(Join-Path $out "CodexLight-NewInstall-$Version-x64.zip");Installed=$false}|ConvertTo-Json
