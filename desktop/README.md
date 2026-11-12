# Codex Light Windows 桌面宿主

Codex Light 使用 WinForms + WebView2 承载本地界面，通过 Node 后台连接官方 Codex CLI 的 app-server，运行目标为 Windows x64。用户安装入口是内嵌 MSI 的单文件 `CodexLight-Setup.exe`，详见 [安装与升级](INSTALLATION.md)。

## 运行与窗口行为

应用需要 Node.js 20+、.NET 10 Windows Desktop Runtime 和 WebView2 142+。安装器复用已有兼容版本，只补充缺失依赖；普通用户不需要开发 SDK。宿主使用固定版本的 `Microsoft.Web.WebView2` NuGet 包 `1.0.4314.35`。

- 同一 Windows 用户会话只保留一个实例，再次打开会唤醒已有窗口，包括托盘中的窗口。
- 关闭窗口时可退出并停止后台、转入托盘继续运行或取消；托盘支持恢复窗口和退出。
- Node 后台加入宿主私有 Windows Job Object，宿主退出或崩溃时回收所属进程树。独立 DSH 服务不属于该进程树。
- WebView 只加载本次后台的本机随机端口页面；外部 HTTPS 链接经用户操作和确认后交给系统浏览器。
- 项目列表位于 `%LOCALAPPDATA%/CodexLight/state/projects.json`。移除项目只影响列表，不删除目录或聊天。
- WebView 使用独立 InPrivate 会话目录 `%LOCALAPPDATA%/CodexLight/WebView/Sessions`。`logs/webview-startup.json` 仅记录运行时版本、阶段和错误代码。

主程序从随附目录、标准安装位置、注册表和绝对 PATH 目录发现 Node，并实际检查候选版本。WebView2 优先使用系统默认选择，遇到明确的运行时错误时再尝试其他兼容候选；未知错误和超时保留明确失败。

## 构建应用

从仓库根目录使用 PowerShell，预先安装官方 .NET 10 SDK。构建脚本从官方 NuGet 源还原依赖。

```powershell
.\desktop\build.ps1 -Runtime win-x64
```

默认生成 framework-dependent 应用，写入新的 `desktop/dist/CodexLight-win-x64-<timestamp>` 目录。脚本复制 `src/`、`public/`、`package.json` 和产品说明，并收集实际还原版本的 .NET apphost / WebView2 许可证。完整 payload 和许可证准备成功后，才原子更新 `desktop/dist/current.json`。

Windows 上 `npm start` 启动该指针选定的原生应用，`npm run demo` 启动不调用模型的原生演示；没有有效构建时明确报错。`npm run browser` 显式使用浏览器开发模式。构建脚本不会自动启动生成的程序。

`-SelfContained` 可生成包含 .NET 运行时的应用 payload；当前 MSI authoring 要求 framework-dependent payload，因此正式安装器使用默认构建方式。两者都需要 Node 和 WebView2。

完整 payload 包含宿主和发布依赖，以及：

```text
app/package.json
app/src/desktop-backend.mjs
app/src/...
app/public/...
licenses/...
```

## 构建安装包

先完成应用构建，再生成并校验内部 MSI，最后将同版本 MSI 嵌入 Setup：

1. [MSI 构建说明](msi/README.md)：Python 3、项目本地 WiX 6.0.2 和完整 framework-dependent payload。
2. [Setup 构建说明](setup/README.md)：.NET Framework 4.8 WPF 安装器与嵌入资源检查。
3. `desktop/package-release.ps1 -Version 0.3.0`：读取对应构建收据和校验结果，生成分发 ZIP 与哈希清单。

向用户分发 `CodexLight-Setup.exe` 的正式发行包；MSI 是内部安装机制。安装后的升级和卸载由 Windows Installer 管理。发布签名使用 `desktop/sign-release.ps1` 和发布者已有证书；未签名构建可能显示未知发布者或 SmartScreen 提示。

项目设置了 `EnableWindowsTargeting=true`，可还原 Windows targeting packs 进行交叉编译。完整安装器和窗口运行以 Windows 为目标，编译成功不代表运行兼容性。

## 官方参考

- [WebView2 NuGet 包](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35)
- [WinForms WebView2](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.winforms.webview2)
- [WebView2 InPrivate 创建属性](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.winforms.corewebview2creationproperties.isinprivatemodeenabled)
- [Windows Job Object 限制](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
