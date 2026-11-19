# 码舱 CodeCang

Codex 桌面与远程客户端（原 Codex Light）。英文名称为 **CodeCang**。

仓库地址、安装包文件名、Windows 更新身份、Android 包名及已有数据目录保持兼容，不需要因名称变化重新登录或迁移个人配置。详见 [品牌与兼容标识](docs/BRANDING.md)。

独立 Windows 桌面客户端，采用 WinForms + WebView2。通过官方 Codex CLI 的 app-server 协议工作，复用已有登录和配置；不改动官方客户端，不伪装成官方客户端。

## WSL 运行环境

可在设置中发现并选择 WSL 内的 Linux Codex，保存后重启使用，账户和数据按运行环境隔离。支持标准 nvm/fnm 候选检测及手动指定 Linux CLI 路径；Windows Git 面板及 Windows CLI 升级在 WSL 模式下禁用；DSH 可显式选择 Windows 或 WSL 原生桥。**WSL 支持已随 v0.4.6 发布，但尚未完成真实 WSL 端到端验收。** 安装条件、使用方式与限制见 [WSL 说明](docs/WSL.md)。

## 界面预览

以下为当前源码在 Windows Chrome 中实际渲染的桌面与手机界面。对话、文件变更及额度均为合成演示数据，不读取个人对话、不调用真实模型。手机图展示 Android WebView 共用的网页界面，不包含系统状态栏。

**电脑端 · 1440 × 920**

![电脑端：顶部导航、项目侧栏、对话与文件变更](docs/assets/conversation-demo.png)

**手机端 · 393 × 900**

<img src="docs/assets/narrow-layout-demo.png" alt="手机端：顶部额度、完整对话、文件变更与底部输入操作" width="393">

## 已实现的主要功能

- 会话：历史浏览、流式回复、停止、重命名、归档与分支；运行中可补充或排队。
- 项目与窗口：可拖动侧栏、项目菜单、系统文件夹选择、原生标题栏与托盘；过程操作可折叠。
- 模型：按引擎提供的目录选择模型、思考强度、权限方式及 Fast 服务层级。
- 审批：命令、文件、基本表单及权限由用户确认；根据原生请求支持一次、对话或指定规则授权。
- 子代理：GPT 与可选 DSH 按对话统一展示，包含模型、来源、状态和时长；详情固定返回栏，后台刷新概览，文件修改汇入当前回合。
- 工作台：官方 PTY 终端，Git 状态、diff、暂存、提交与非强制推送；仓库过滤器和钩子的执行风险会提示确认。
- 插件：目录、详情及来源明确的安装/卸载确认。
- 账户与用量：网页登录、设备码、套餐/额度、重置额度卡、用量趋势、模型/供应商筛选与分页明细；扫描导入本地 Codex 日志，从 models.dev 同步价格，显示总成本及回合估价。参考估价不等于账单；回合平均输出 tok/s 包含思考、工具与等待。
- 附件：图片与文件单次共 5 个；上传和模型查看的图片可放大预览，支持项目外本地图片。文件作为本地路径引用，不自动执行或解包；可执行程序与脚本不接受。
- 设置：五项受支持配置的确认更新、版本冲突检查及本机偏好保存。
- 远程访问：官方远控状态、设备与配对管理；可随时关闭或更换链接的可选局域网访问。
- 外观与提醒：深色/浅色/系统外观、文字大小、减少动画、应用内提醒与快捷键清单。

## 安装与依赖

### Android 局域网客户端

Android 客户端是连接电脑的 WebView 外壳，不在手机上安装或运行 Codex CLI。需要 Android 7.0（API 24）及以上、可用的系统 WebView，以及已开启局域网访问的电脑。手机与电脑须在同一可信局域网；这不是公网远控或离线模型运行方式。

APK 获取、安装与升级、配对和 Windows 源码构建步骤见 [Android 客户端说明](android/README.md)。预构建 APK 随本仓库的 [Releases](https://github.com/k08255-lxm/codex-light/releases) 提供；请核对版本、来源及同一发布的 `SHA256SUMS.txt`。当前没有 GitHub Actions APK 自动构建工作流。

### Windows 桌面客户端

从本仓库 Release 下载 **`CodexLight-Setup-<version>-x64.exe`**（如 `CodexLight-Setup-0.4.11-x64.exe`），这是唯一需要手动下载的 Windows 安装入口。v0.4.6 起新安装内容已内嵌，不需要另下 ZIP；`full.nupkg` 和 `releases.win.json` 供应用自动更新使用。

0.4.4 起使用 Velopack。已有 Velopack 安装优先使用应用内更新；旧 MSI 安装先经固定的 0.4.4 迁移桥，再按提示更新到新版。首次安装复用兼容运行环境，缺失依赖须确认后才安装；完整应用的安装检查要求 Windows Node.js 22.15+（仅核心后端支持 Node.js 20+），WSL 内的 Node 不替代它。未检测到 Windows Codex CLI 时可选择稍后在应用中配置 WSL 或其他已有引擎。

安装与更新不代表每种电脑环境都已实机验收。共享运行时、项目和用户配置不应当作应用缓存清理；迁移恢复资料须保留。详见 [安装与升级](desktop/INSTALLATION.md)。

### DSH 集成（可选）

安装包默认携带 `components/dsh-bridge` MCP 桥，无需另找桥程序。DSH 本体由用户自行安装，缺失时普通 Codex 聊天照常工作。当前兼容 DSH 0.2.2，已核验 0.2.2-rc.1；桥使用 DSH 自带的 Node.js 22.15+ 与 SQLite，主应用仍只需 Node.js 20+。

连接步骤：

1. 打开左侧**设置 → DSH 与 MCP**，查看“DSH MCP 连接”卡片。
2. 已检测到 DSH 时，点击**连接 DSH**；若安装在其他位置，先填写 `DeepSeek Harness.exe` 的绝对路径。
3. 界面会仅添加 Codex 用户配置中的 `dsh_subagent` 一项，再检查实际连接状态，不发送模型请求。显示“已注册”或“刷新已排队”时，尚不能视为已连接；以页面报告的运行时状态为准。

已有同名外部 MCP 配置时会显示“使用已有配置”，保留并继续使用，不提供覆盖或替换操作。安装 DSH 本体本身不会自动注册 MCP；未安装或不连接 DSH，普通 Codex 聊天照常工作。

只使用 DSH 内置 DeepSeek 时，无需添加第三方 provider。需要额外 provider 时，可在同页选择配置来源并启用自动跟随；更新只用于新建 runtime，正在运行的任务继续使用原配置版本。

## 使用边界

- 需要完整官方交互的复杂插件审批，请在官方客户端处理。
- 用量覆盖取决于服务返回内容与历史格式，无法确认的数据保持未知。
- 启动后及运行期间自动检查 GitHub 稳定版，发现更新只提示；也可在设置 → 关于手动检查。已有 Velopack 安装核对更新包后，经用户确认并等待任务安全空闲才应用更新；不在启动时静默安装。目前没有代码签名。

## 开发与检查

Windows 构建完成后，`npm start` 启动原生窗口，`npm run browser` 才进入浏览器开发模式。`npm test` 运行无模型的 Node 测试。`npm run demo` 是明确标识的本地演示，不调用 Codex 或 DeepSeek。真实使用要求已安装官方 Codex CLI；Windows 从已安装的 npm 与桌面运行引擎中选择可用的新版本，也可显式配置 `CODEX_LIGHT_CODEX` 绝对路径。

应用本体依赖 .NET 10；对外安装入口及首次安装依赖引导目标为 Windows 自带的 .NET Framework 4.8。源码采用 MIT 许可证，第三方组件许可见 [THIRD-PARTY-NOTICES](docs/THIRD-PARTY-NOTICES.md)，技术结构见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

### 从源码运行

需要 Node.js 20+。运行本地浏览器演示无需模型登录：

```powershell
npm run demo -- --browser
```

连接真实 Codex 时，先安装并登录官方 Codex CLI，再执行 `npm run browser`。桌面构建需要 .NET 10 SDK；先执行 `desktop/build.ps1` 生成完整应用 payload，再按 [Velopack 构建说明](desktop/velopack/BUILD.md) 生成当前宿主、更新 worker 和经校验的包，并按 [兼容安装入口说明](desktop/velopack/compat-router/README.md) 生成对外单文件 EXE。`desktop/msi` 与 `desktop/setup` 是历史 MSI 工具链，不是当前版本的常规发布路线。

普通 Codex 聊天与浏览器演示不需要安装 npm 依赖。源码模式需要使用 DSH 桥，或完整检查 DSH 的 YAML 解析能力时，先准备桥的锁定依赖与许可清单；这一步使用 Node.js 22.15+，以满足桥自身的版本要求：

```powershell
npm ci --prefix components/dsh-bridge --ignore-scripts --omit=dev
node components/dsh-bridge/build.mjs
```

`desktop/build.ps1` 会自动完成这两步并将桥及依赖许可打入默认 payload；安装包用户无需执行 npm。

随后运行无模型的 Node 测试：

```powershell
npm test
```

根 `package.json` 没有 npm 依赖，只在项目根目录执行安装不会准备桥的依赖。未准备桥依赖、且本机也没有可用 DSH YAML 解析器时，`npm test` 会跳过真实 YAML 解析器用例；DSH 缺失不会阻止服务启动或普通 Codex 聊天。上面的安装与 `build.mjs` 步骤用于获得完整检查覆盖，并校验桥依赖版本、生成许可清单与哈希元数据。

### 隐私与发布

服务默认只监听本机。局域网访问首次默认关闭。Windows 桌面端开启后记住偏好及配对（凭据由当前用户的 DPAPI 加密），应用重启时尝试恢复同一可信网络、地址与端口；主动关闭才取消。网络变化或端口冲突时保留开启偏好，但实际访问保持停止并提示。其他环境仍为临时开启；持有链接的人可以使用本机工作空间。局域网 HTTP 不加密，仅用于可信局域网；应用不会自动修改防火墙或创建公网隧道。手机无法使用主程序关闭、运行引擎升级等本机管理接口。

真实模型请求由所选 Codex 引擎及用户配置的提供商处理。不要提交 `.env`、登录信息、会话日志、个人配置、测试截图或本地产物。此项目与 OpenAI 没有隶属关系。
