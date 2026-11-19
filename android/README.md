# 码舱 CodeCang Android 客户端

轻量 Android 原生外壳（WebView），用于在同一可信局域网内访问桌面端 码舱 CodeCang 开启的「局域网访问」地址。应用本身不包含模型运行时，也不复制本机配置；会话、项目、模型目录、终端与审批均复用所连接电脑上的官方 Codex CLI 实例。

## 已实现的功能

- **移动端专属工作台布局**：连接后将原生连接栏融入网页顶栏，利用顶栏显示连接状态与实际可用额度；项目选择行同时容纳审批方式和上下文信息。窄屏使用底部五栏导航（对话、用量、终端、账户、设置），软键盘弹起时自动收起底栏；加载失败和连接管理仍保留原生入口。
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
- 连接使用 Android 默认网络路由，不因 VPN 已开启就拒绝连接，也不把进程或 socket 强绑到物理 Wi-Fi；局域网绕行由系统与 VPN 配置控制。旧网络指纹不再阻止连接，URL、私有 IPv4、端口、同源导航及配对兑换禁止重定向的检查仍保留。

## 连接步骤

### 安装与升级

- 最低系统版本为 Android 7.0（API 24），Manifest 的 target SDK 为 34。需要可用的 Android System WebView；不要把 target SDK 当作最低 Android 版本。
- 从本项目的 [Releases](https://github.com/k08255-lxm/codex-light/releases) 下载匹配发布版本的 Windows 安装器和 APK，也可以按下文从源码构建。v0.4.11 支持在手机设置中检查、下载并安装更新，下载文件为 `codex-light-0.4.11.apk`，versionCode 为 411。
- 将 APK 传到手机，用系统安装器打开；如系统提示，仅为当前使用的文件管理器或浏览器允许安装该来源的应用。安装后即可关闭这项许可。
- 若要核对下载文件，在 Windows 执行 `Get-FileHash .\codex-light-0.4.11.apk -Algorithm SHA256`，与同一发布的 `SHA256SUMS.txt` 中对应文件名的条目对比。哈希只校验文件一致性，不能代替对发布者和签名的信任。
- 覆盖升级需要相同应用 ID 和签名证书。作者发布包、自行构建包及其他机器生成的调试密钥不保证互相兼容；签名不匹配时不要直接卸载来强行升级，因为卸载会清除手机保存的连接地址和令牌。请优先使用同一来源、同一签名的更新包。

### 连接电脑

1. 在电脑端启动 码舱 CodeCang，打开**设置 → 远程控制 → 局域网访问**，选择局域网 IPv4 地址开启访问并复制链接。
2. 确保手机与电脑处于同一局域网，且电脑防火墙放行对应 TCP 端口（或通过 USB 调试转发）。
3. 打开 Android 端 码舱 CodeCang，点击**快捷粘贴局域网链接**（或手动填入主机、端口与令牌），点击**连接并进入**。

## 从源码构建

构建脚本直接使用 Android SDK Build-Tools 与 JDK 原生工具链（`aapt2`、`javac`、`d8`、`zipalign`、`apksigner`），不依赖 Gradle Wrapper 下载外部构件。

### 环境要求

- Windows PowerShell 5.1+ 或 PowerShell 7+
- JDK 17+（设置 `JAVA_HOME` 或加入 `PATH`）
- Android SDK Platform 36 或更高版本与 Build-Tools 34.0.0+（设置 `ANDROID_HOME` 或 `ANDROID_SDK_ROOT`）

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
- 电脑和 码舱 CodeCang 服务必须保持运行并可达；手机离线预览不连接模型，也不是真实任务执行。仅支持可信局域网 HTTP，流量不加密，不应把端口直接暴露到公网。

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

## 二维码配对与自动更新

电脑设置 → 局域网访问 → 开启 → 二维码配对。手机连接页选择“扫描电脑二维码”，仅此时申请相机权限；拒绝后仍可粘贴手动链接。二维码由电脑本地生成，手机 ZXing 本地识别，不上传相机画面，不依赖 Google Play 服务。也可用系统相机打开二维码进入纯网页客户端。

二维码含两分钟单次票据，不含长期访问令牌。重新生成、取消、关闭局域网或轮换令牌会撤销票据。手机确认后兑换并连接；HTTP 传输仍未加密，必须在可信网络使用，二维码截图也应视为临时访问凭据。桌面原复制链接流程继续保留。

桌面启动后及每六小时自动检查稳定 Release，发现新版仅提示；设置 → 关于仍可手动检查、下载与确认安装。Android 进入前台自动检查稳定 Release，成功检查间隔六小时。连接页、连接失败或离线页、手机设置均可点击「检查更新」立即检查，无需连接电脑。发现新版时可查看下载进度，待 APK 的 SHA256、包名、版本和签名全部通过核验后，点击「打开系统安装器」并在 Android 中确认安装。首次使用时 Android 可能要求允许码舱安装未知应用。手动检查失败会提示原因，自动检查遇到网络错误会稍后重试。

APK 升级须保留同一 applicationId 与签名证书，增加 versionCode；Android 安装器会拒绝不匹配签名。不要为更新而卸载应用。v0.4.6 已随 Release 提供 APK，versionCode 为 406；后续构建仍须同步版本并使用原签名。本地构建脚本不会自动发布 Release，其独立 `.sha256` 输出与 Release 汇总的 `SHA256SUMS.txt` 用途不同。

依赖：ZXing core 3.5.3（Apache-2.0）位于 android/libs，构建时离线编译到 DEX；相机仅扫描页使用，离开页面释放。不自动接受系统相机权限。


### 系统返回

Android 普通返回按钮/边缘返回手势先交给桌面服务提供的网页界面：关闭最上层对话框（遵守取消保护）、菜单/模型选择、移动侧栏、活动面板，再返回前一个页面；根页面才使用 WebView 历史和原有两次返回退出提示。API 33+ 使用 `OnBackInvokedCallback` 的完成回调，旧版本走 `onBackPressed`；不实现预测性返回动画。键盘和原生文件选择器仍由系统先处理。

这需要新版 APK 和包含 `CodexLightNavigation` 的新版桌面网页一起使用。旧服务或离线预览没有该入口时保留原来的 WebView/退出回退。纯浏览器访问不改写浏览器的 Back 历史；网页内侧栏按钮仍可关闭抽屉。

验证脚本：`node --test test/back-navigation.test.mjs` 与 `node test/mobile-back-browser.mjs`（需要本地 Playwright / `CHROMIUM_PATH`，只使用 DemoClient）。浏览器测试可验证页面状态，但不能代替 Android 真机的系统返回、键盘和文件选择器验收。


## 保存配对与自动重连

- 打开 App 会尝试一次连接上次成功认证的局域网电脑，可在连接页关闭“打开 App 时连接上次配对的电脑”。打开连接管理页不会立即跳回自动连接。
- 连接过程可用顶部设置/电脑按钮返回连接页取消，旧异步结果不会重新打开会话。临时离线显示重试；返回前台时允许一次重试，401/403 或非法配置停止自动重试并提示重新配对。
- 地址和端口保持为用户配对时的目标，不扫描局域网、不跟随重定向。地址改变后请重新扫码；电脑须开启持久局域网访问以保持端口和令牌。
- 当前令牌及连接历史使用 Android Keystore AES-GCM 加密；旧明文凭据仅在加密成功并保存后移除。密钥不可用时不回退为明文，不发送不可解密凭据，提示重新配对。应用备份继续禁用。
- 仅支持严格私有 IPv4 + 有效端口 + 64 位小写十六进制 LAN 令牌。HTTP 仍未加密，可信局域网要求不变；固定地址不是服务器身份认证，不能抵御同 IP 冒充。
- 开发检查：`powershell -File test/android-reconnect/run.ps1` 运行宿主 JVM 策略与 HTTP 传输假连接测试。Android APK 编译不能替代真机的 Keystore、生命周期、触摸/返回和断网恢复验收。

## 未连接时查看上次页面

连接中或连接失败时，如该电脑已有保存记录，手机会显示可滚动的只读文字快照和保存时间，保留“重新连接”“更换电脑”入口；真实连接就绪后切回实时页面。快照保存当前已加载的对话、用量或账户内容，不包含图片、未加载历史、输入草稿、设置凭据或终端；离线页面不能发送消息、批准操作或打开网页链接。

连接正常时约每 30 秒及离开页面前尝试更新，空白、未就绪或断线状态不会覆盖上次可用快照。内容最多 10 万字符，按电脑地址与端口隔离，在 Android 应用私有 `noBackup` 目录原子保存，最多保留 8 台电脑；当前访问令牌在写入前脱敏。展示使用独立的无 JavaScript、无原生 bridge、禁止网络和导航的 WebView。原生网页归档不承诺剔除认证元数据，因此这里保存的是受控文字，而非可重新执行的整页资源。

## 任务通知与 Android 实时通知

在手机「设置 → 通知」开启「手机任务通知」，Android 13 及以上会申请系统通知权限。运行中的任务随实际活动显示工作中、思考中、执行中或回复中。等待回答、等待审批、完成、失败、停止和断线会更新同一条通知。每个对话一条，最多同时显示三条。点击通知可回到对话，划除或选择「取消固定」可停止提醒同一轮。「提问与审批提醒」使用独立通知渠道，点击可打开相应请求。

Android 16 及以上可在「实时通知设置」查看系统授权。任务运行时，设置页会显示系统是否已将该条任务通知提升为实时通知。若「任务状态」通知类别的重要性为最低，可点「系统通知设置」进入该类别调整。实时通知在通知栏、锁屏或状态栏的展示由系统决定。[Android 实时通知](https://developer.android.com/develop/ui/views/notifications/live-update)


可主动开启「后台同步通知」。首次开启时，Android 13 及以上会请求通知权限。允许后手机会把电脑上仍待处理的提问和审批加入通知栏。应用打开时，新事件会立即触发同步；离开应用后，前台数据同步服务会定期检查已配对电脑。通知栏有停止入口，每次最长六小时，离开可访问电脑的网络或进入深度休眠时可能暂停。电脑端需要支持后台通知接口，配对授权仍须有效。旧版电脑继续通过应用内网页连接提供通知。

维护入口为 `TaskNotificationController`、`QuestionNotificationController` 和 `MobileNotificationService`。`GET /api/mobile/notification-state` 限有效的局域网配对授权，返回任务状态、请求类别及对话路由标识，排除命令、消息、问题正文。后台和网页使用同一通知标识，恢复时既有通知静默同步。可运行 `node --test test/android-task-notifications.test.mjs test/mobile-notification-feed.test.mjs` 验证状态和配对链路。

## APK 发布命名

每个 Release 都附带 APK。Android 有实质代码或资源变化时使用旧客户端兼容的 `codex-light-VERSION.apk`，发布前核查已发布更新器的实际匹配规则。仅确认 Android 除版本外没有实质变化时才使用 `--android-unchanged`，输出 `codex-light-android-VERSION.apk` 且不上传标准名别名。v0.4.7 的配对修复属于实质更新，不能使用静默命名；过去某版仅同步版本的例外不适用于后续功能更新。两种命名都必须保持包 ID、签名兼容和递增 versionCode，并校验内部版本与哈希。

v0.4.9 使用标准 APK 名称，不能沿用 v0.4.8 的 `--android-unchanged` 例外。
