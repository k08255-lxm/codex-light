# Codex Light Android 客户端

轻量 Android 原生外壳（WebView），用于在同一可信局域网内访问桌面端 Codex Light 开启的「局域网访问」地址。应用本身不包含模型运行时，也不复制本机配置；会话、项目、模型目录、终端与审批均复用所连接电脑上的官方 Codex CLI 实例。

## 已实现的功能

- **移动端专属工作台布局**：与桌面端共享统一的碳黑单色视觉体系（`#181818` 画布、`#202020` 面板与高对比主操作按钮）。顶部采用独立状态胶囊栏（不遮挡网页顶栏），窄屏下自动将左侧图标轨重构为底部六栏导航（目录、对话、用量、终端、账户、设置），释放 100% 横向对话与代码阅读宽度，并在软键盘弹起时自动收起底栏。
- **局域网连接与配对**：支持并排输入主机 IP / 端口与访问令牌，或从系统剪贴板一键解析桌面端生成的 `http://<IP>:<PORT>/#token=<TOKEN>` 链接；保留最近 8 条连接记录并支持清空。
- **令牌刷新保持**：桌面端局域网模式默认在提取 `#token` 后清除地址栏片段且不写入 Web Storage；Android 外壳仅对当前已校验的同源目标通过受控桥接回传当前会话令牌，页面刷新后无需重新粘贴链接。
- **非安全上下文与剪贴板兼容**：局域网 HTTP 下浏览器默认隐藏 `[SecureContext]` API（如 `crypto.randomUUID` 与 `navigator.clipboard`）；前端入口模块内置符合 CSP（`script-src 'self'`）的 UUIDv4 生成与原生剪贴板同步校验兜底——当系统或浏览器拒绝剪贴板写入时如实拒绝 Promise，绝不误报“复制成功”。
- **附件与交互适配**：对接 Android 系统文件/图片选择器（`WebChromeClient.onShowFileChooser`，单次结算回调避免启动异常重复取消），支持向当前回合上传最多 5 个图片或路径引用文件；提供连接诊断卡片重试、网页回退与双击返回退出保护。
- **离线界面预览**：未连接电脑时可进入同风格的内置离线预览工作台，不发起网络或模型请求。

## 安全与使用边界

- 局域网 HTTP 通信不加密，仅适用于受信任的家庭或个人局域网。请勿在公共 Wi-Fi 下开启或暴露端口。
- 外壳禁用应用备份（`android:allowBackup="false"`），`MainActivity` 不向外部应用导出（`android:exported="false"`）。
- WebView 导航严格锁定在当前配置的同源 `http://<host>:<port>`（或演示模式下的 `file:///android_asset/`）；对话内容中的外部网页链接统一交由系统浏览器打开，不会在持有原生桥接的 WebView 内加载第三方站点。
- 遵循服务端局域网权限边界：手机端无法调用主程序关闭、运行引擎升级、DSH 连接注册、应用更新及打开本机资源管理器等仅限本机窗口的接口。

## 连接步骤

### 安装与升级

- 最低系统版本为 Android 7.0（API 24），Manifest 的 target SDK 为 34。需要可用的 Android System WebView；不要把 target SDK 当作最低 Android 版本。
- 从本项目的 [Releases](https://github.com/k08255-lxm/codex-light/releases) 下载同版本 Windows 安装器和 APK，也可以按下文从源码构建。Android 0.4.2 使用 versionCode 402，高于早期测试包的 100；应用内显示版本、原生桥和 User-Agent 均为 0.4.2。下载时核对发布说明与校验文件。
- 将 APK 传到手机，用系统安装器打开；如系统提示，仅为当前使用的文件管理器或浏览器允许安装该来源的应用。安装后即可关闭这项许可。
- 若要核对下载文件，在 Windows 执行 `Get-FileHash .\codex-light.apk -Algorithm SHA256`，与同一发布的 `.sha256` 对比。哈希只校验文件一致性，不能代替对发布者和签名的信任。
- 覆盖升级需要相同应用 ID 和签名证书。作者发布包、自行构建包及其他机器生成的调试密钥不保证互相兼容；签名不匹配时不要直接卸载来强行升级，因为卸载会清除手机保存的连接地址和令牌。请优先使用同一来源、同一签名的更新包。

### 连接电脑

1. 在电脑端启动 Codex Light，打开**设置 → 远程控制 → 局域网访问**，选择局域网 IPv4 地址开启访问并复制链接。
2. 确保手机与电脑处于同一局域网，且电脑防火墙放行对应 TCP 端口（或通过 USB 调试转发）。
3. 打开 Android 端 Codex Light，点击**快捷粘贴局域网链接**（或手动填入主机、端口与令牌），点击**连接并进入**。

## 从源码构建

构建脚本直接使用 Android SDK Build-Tools 与 JDK 原生工具链（`aapt2`、`javac`、`d8`、`zipalign`、`apksigner`），不依赖 Gradle Wrapper 下载外部构件。

### 环境要求

- Windows PowerShell 5.1+ 或 PowerShell 7+
- JDK 17+（设置 `JAVA_HOME` 或加入 `PATH`）
- Android SDK Platform 34 与 Build-Tools 34.0.0+（设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT`）

### 执行构建

```powershell
pwsh -File android/build.ps1
```

以上命令使用 PowerShell 7；仅安装 Windows PowerShell 5.1 时，在仓库根目录执行 `powershell -File android/build.ps1`。脚本调用 Windows 的 `.exe`、`.bat` 和 `cmd.exe`，不是 Linux/macOS 构建脚本。SDK/JDK 检测失败时可用 `-SdkDir`、`-JdkHome` 显式传入安装目录。

默认产物输出至 `android/dist/codex-light.apk` 及对应的 `codex-light.apk.sha256`（已被 `.gitignore` 忽略，不纳入源码提交）。未通过环境变量 `CODEX_LIGHT_ANDROID_KEYSTORE` 指定正式签名密钥时，脚本会在本地生成不入库的 `local-debug.keystore` 完成签名校验；请勿将任何 `.keystore` 或私钥文件提交至版本库。

## 验证范围与限制

- 当前仓库没有 GitHub Actions APK 构建工作流；上面的脚本是本地构建入口，不代表每次提交都已自动构建或真机验收。
- 贡献者在 PR 中报告了 Android 16 / Redmi K60 的安装、配对、刷新和对话收发验证；这不覆盖所有系统 WebView、输入法、文件选择器或屏幕尺寸。
- 前端回归测试可执行 `node --test test/access.test.mjs`，覆盖令牌引导与剪贴板失败路径；该测试不会安装 APK，也不能替代真机附件选择和键盘遮挡测试。
- Android 专属底部导航仅在原生桥标识存在且网页宽度不超过 760 CSS px 时启用；普通手机浏览器仍使用共享网页响应式布局。DSH、插件的独立侧栏入口在该移动布局中隐藏，不代表电脑上的能力被卸载。
- 键盘避让使用 Android `adjustResize` 和网页 `visualViewport`。网页检测到键盘状态或可用高度不超过 520 CSS px 时会隐藏移动底栏；不同输入法行为仍需真机确认，不能保证所有设备都不遮挡。
- 电脑和 Codex Light 服务必须保持运行并可达；手机离线预览不连接模型，也不是真实任务执行。仅支持可信局域网 HTTP，流量不加密，不应把端口直接暴露到公网。

## 源码目录

```text
android/
├── app/src/main/
│   ├── AndroidManifest.xml             # 权限、网络安全配置与 Activity 导出边界
│   ├── assets/web/index.html           # 离线演示模式静态页
│   ├── java/com/codexlight/android/
│   │   ├── ServerConnectActivity.java  # 启动入口：链接粘贴解析与连接历史管理
│   │   ├── MainActivity.java           # WebView 容器、同源校验与错误重试弹层
│   │   ├── AppWebViewClient.java       # 同源导航守卫与外部链接系统浏览器分流
│   │   ├── AppWebChromeClient.java     # 加载进度条与系统文件选择器桥接
│   │   ├── CodexLightBridge.java       # 受同源约束的 JavascriptInterface 桥接
│   │   ├── ServerConfig.java           # 局域网 URL / 令牌解析模型
│   │   └── ServerConfigManager.java    # 本机私有 SharedPreferences 存储
│   └── res/                            # 布局、深色主题、图标与明文局域网配置
└── build.ps1                           # 无 Gradle 原生打包与签名校验脚本
```
