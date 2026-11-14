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
- 从本项目的 [Releases](https://github.com/k08255-lxm/codex-light/releases) 下载同版本 Windows 安装器和 APK，也可以按下文从源码构建。Android 0.4.3 使用 versionCode 403，高于早期测试包的 100；应用内显示版本、原生桥和 User-Agent 均为 0.4.3。下载时核对发布说明与校验文件。
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

## 二维码配对与自动更新（待发布）

电脑设置 → 局域网访问 → 开启 → 二维码配对。手机连接页选择“扫描电脑二维码”，仅此时申请相机权限；拒绝后仍可粘贴手动链接。二维码由电脑本地生成，手机 ZXing 本地识别，不上传相机画面，不依赖 Google Play 服务。也可用系统相机打开二维码进入纯网页客户端。

二维码含两分钟单次票据，不含长期访问令牌。重新生成、取消、关闭局域网或轮换令牌会撤销票据。手机确认后兑换并连接；HTTP 传输仍未加密，必须在可信网络使用，二维码截图也应视为临时访问凭据。桌面原复制链接流程继续保留。

桌面启动后及每六小时自动检查稳定 Release，发现新版仅提示；设置 → 关于仍可手动检查、下载与确认安装。Android 进入前台自动检查，并在持续前台时定期检查（成功检查间隔六小时），不依赖电脑连接；只有 Release 存在匹配版本 APK 才提示，点击查看更新打开固定项目发布页，不后台安装。网络错误不会被误报为最新。

APK 升级须保留同一 applicationId 与签名证书，增加 versionCode；Android 安装器会拒绝不匹配签名。不要为更新而卸载应用。当前代码仍为开发中的 0.4.3，发布前必须统一升版；本地构建不是新 Release。0.4.3 / versionCode 403; local builds do not publish a Release.

依赖：ZXing core 3.5.3（Apache-2.0）位于 android/libs，构建时离线编译到 DEX；相机仅扫描页使用，离开页面释放。不自动接受系统相机权限。


### 系统返回

Android 普通返回按钮/边缘返回手势先交给桌面服务提供的网页界面：关闭最上层对话框（遵守取消保护）、菜单/模型选择、移动侧栏、活动面板，再返回前一个页面；根页面才使用 WebView 历史和原有两次返回退出提示。API 33+ 使用 `OnBackInvokedCallback` 的完成回调，旧版本走 `onBackPressed`；不实现预测性返回动画。键盘和原生文件选择器仍由系统先处理。

这需要新版 APK 和包含 `CodexLightNavigation` 的新版桌面网页一起使用。旧服务或离线预览没有该入口时保留原来的 WebView/退出回退。纯浏览器访问不改写浏览器的 Back 历史；网页内侧栏按钮仍可关闭抽屉。

验证脚本：`node --test test/back-navigation.test.mjs` 与 `node test/mobile-back-browser.mjs`（需要本地 Playwright / `CHROMIUM_PATH`，只使用 DemoClient）。浏览器测试可验证页面状态，但不能代替 Android 真机的系统返回、键盘和文件选择器验收。
