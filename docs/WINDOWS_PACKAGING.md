# Windows 安装包构建与验收

## 2026-10-19 自适应插件手动验收包

本轮源码 `b6d3cee`（`feat/plugin-adaptive-repair`）的独立输出目录为 `release-cross/adaptive-repair-b6d3cee/`，保留之前的试包。安装包、SHA256 与构建证据放在同一目录；操作步骤和能力边界见 [自适应插件验收清单](WINDOWS_ADAPTIVE_REPAIR_ACCEPTANCE.md)。本轮将旧精简 Python 替换为官方 NuGet CPython 3.12.10 x64，保留原有第三方依赖并补齐 venv、ensurepip 和离线 pip wheel；Windows 原生导入与环境创建仍须实机确认。

该包包含已知 AEDT 路径问题的直接适配和受限模型修复任务。模型生成源码的隔离验证与自动激活尚未接通，不能将“修复候选生成”算作完整自修复验收通过。

当前已生成跨平台试包，但尚未完成真实 Windows 安装包验收。正式构建与运行验证仍应在 Windows x64 主机进行；macOS 的原生依赖不能直接充当 Windows 依赖。代码仓库 `https://github.com/auenger/ThermalAgentApp.git` 为公开仓库。用户已确认 `assets/icepak/Project1.aedt` 是可公开分发的测试工程，随源码提交并由安装包带入；这不代表客户模型也可公开。

Windows 测试可直接打开 [离线 HTML 操作说明](./Thermal-Agent-功能进度与操作说明.html)，按 CAD 到 Baseline 步骤操作并保存或导出测试记录。离线说明已同步当前实验分支的 CAD Preview 试包，新增 3D 预览与人工对应步骤；主线与实验包身份以下列各自 SHA 为准。

## 2026-10-13 CAD Preview 更新试包

已重新生成 `release-cross/cad-preview/Thermal-Agent-0.1.0-CAD-Preview-Windows-x64.exe`，212,340,179 字节。SHA256：`afd183a8ec9eb535c18aa87c4faa8aa6392edb3507a8e5fd1ec70d3c701f84e5`。此包替换同路径的 2026-10-12 试包。

包含 Task 详情的模型文件集中入口：原始 CAD、导入几何工程、热模型版本、参数方案工程与求解工程，可下载、复制路径，并在桌面 App 打开任务目录或定位文件。定位时从归档恢复保留文件名的副本，已有副本不覆盖。CAD 查看器的许可入口已移除，组件许可文件仍随包保留。

TypeScript/Web 构建、10 项建模接口测试及浏览器建模流程测试通过；安装包必需资源检查通过，13 个包内桌面/Core/Web 文件与当前构建输出一致。`.exe.sha256` 和 `viewer-build-evidence.json` 已更新，构建证据注明包含尚未提交的工作区改动。

构建使用现有 CAD Preview 配置及缓存的 Electron 38.8.6 Windows x64 压缩包，避免重复下载；仍为 macOS 跨平台试包，Windows 安装、资源管理器定位和真实 Icepak 求解尚待实机验证。应用身份和数据目录沿用 CAD Preview。

## 2026-10-12 CAD Preview 实验试包

分支 `experiment/cad-object-context` 已新增真实 STEP 3D 预览、拾取、隐藏/隔离、人工对应和配置联动。实验包使用独立应用 ID、产品名和包内名称，输出为 `release-cross/cad-preview/Thermal-Agent-0.1.0-CAD-Preview-Windows-x64.exe`（212,251,295 字节）；SHA256 为 `9ee5afe7443ab350d82f97dfda8e8101b6fdfeb57e572267fee84ea693620122`。原主线试包保留在下列位置。

构建命令为 `pnpm package:win:cad-preview:cross`。包内资源与构建 SHA 已核对，Windows 安装、GPU 和真实实体映射仍待验收。测试步骤、能力上限和详细证据见 [CAD 对象交互实验](./CAD_OBJECT_INTERACTION_EXPERIMENT.md)。实验安装后的数据目录与主线分开，不自动迁移主线任务。

## 2026-10-09 CAD 功能跨平台试包（待 Windows 验收）

已重新构建 `release-cross/Thermal-Agent-0.1.0-Windows-x64.exe`，209,763,686 字节，SHA256 为 `e4bdca05ecf34b1450ce6da28bfc23900ce210e51820980dd81ee5e842fa3710`。随包新增 CAD 导入、基础热模型生成和验证模块、受管生命周期与 Windows Job Object 模块、`resources/cad-samples/` 公开 STEP 样本、`resources/cad-acceptance/` 独立验收脚本及契约。`afterPack` 检查必需资源与样本 SHA；实际包内 Core/契约文件已与本次构建输出核对。

包内验收脚本的相对依赖和帮助入口已用 macOS Node 验证。Windows 原生 Node/Python、安装和真实 AEDT/Icepak 仍未运行验收；不能将跨平台试包作为真实仿真通过证据。验收命令、证据目录及剩余门槛见 [CAD 建模实现与验收](./CAD_MODEL_PREPARATION_IMPLEMENTATION.md)。`release-cross/cad-build-evidence.json` 与 `.exe.sha256` 保存本次构建身份，以下历史试包已被本次构建替换。

## 2026-09-23 历史跨平台试包

为便于先在 Windows 安装回归，新增 `pnpm package:win:cross`。它在 macOS 上跳过 Windows 原生模块的重编译和包内 `.exe` 的运行验证，但仍检查必需资源与 Windows 平台模块确实进入解包目录。与下文的 Windows 原生 `pnpm package:win` 不同，它只是试包，不代表运行已验证。

本次从 macOS x64 构建成功：`release-cross/Thermal-Agent-0.1.0-Windows-x64.exe`，209,599,103 字节。2026-09-23 最新版 SHA-256 为 `13dfd4b7afb92d141872add11bdbc9cd66dfa515518c50e9f890d80c6dcb749c`；2026-09-22 修复 DSH 缺失 peer dependency 后的上一版 SHA-256 为 `83df715ed1959121356acbf6972c6c5f822de40d0390bf6634b96d0787926d94`，已过时。使用 Windows x64 Node 22.22.0、Python 3.12.10 embeddable、PyAEDT 1.6.0、ReportLab 4.5.1、pypdf 6.19.0。Windows 的 `node-pty`、sharp、koffi、ripgrep 和 Node 原生扩展都已做静态包内存在检查；没有在 macOS 上执行 Windows 二进制。构建产物被 Git 忽略，不随源码仓库推送。

首次 Windows 安装反馈：安装和 Icepak 环境探测可用，但内置 DSH 启动时报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-group`。原因是 DSH 启动模块的 peer dependency 在打包时被裁剪；现已将缺失的 DSH 包声明为 App 运行时依赖，并让 `afterPack` 检查它们都进入安装包。新包解包后的 DSH 启动模块导入及 CLI `--version` 已在 macOS 上通过；Windows 的 DSH 对话和设置仍待人工复测。

Windows 安装测试请先核对下载文件 SHA-256，再依次检查：安装/卸载、App 主窗口与托盘、Core/SQLite 重启持久化、内置 DSH 对话和设置、报告生成；最后在合法 AEDT/Icepak 工程机上进行三级环境探测、真实工程能力检查与经人工确认的求解。若启动失败，请保留窗口报错和 App 用户数据目录中的运行线索，不要直接把客户工程或 API 密钥发到公开仓库。试包通过安装验证后，仍需在 Windows x64 上运行严格构建及完整测试。

2026-09-21 在 macOS x86_64 执行 `pnpm package:win`：TypeScript 与 Web 构建通过，随后 `verify-windows-runtime.mjs` 按预期拒绝非 Windows x64 构建机，未生成 NSIS 安装包。该机器也没有 `packaging/windows-runtime/` 下的 Windows Node/Python 资源，仓库尚未配置远程 Windows CI。下一次打包需在 Windows x64 主机按下述步骤准备资源后重新执行；此记录不是安装或 AEDT 验收证据。

2026-09-22 在完成统一品牌图标、内置示例工程与 DSH 包校验后，再次执行 `pnpm package:win`：TypeScript/Web 构建及全套测试通过，Windows 预检因当前构建机为 macOS x86_64 而按设计停止，`release/` 未生成安装包。不得将这次构建表述为 Windows 可测试版本。

## 构建输入

1. 在 Windows x64 上安装 Node 22.22.x、pnpm 11、Python 3 和 uv，并运行 `pnpm install`、`pnpm test`。
2. 准备 `packaging/windows-runtime/node/node.exe`，采用可再分发的 Windows x64 Node 22.22.x 或兼容版本。构建前脚本会检查版本和 DSH CLI 语法。
3. 准备 `packaging/windows-runtime/python/python.exe` 及完整的 Windows x64 Python 3.10+ 运行目录。在该内置解释器中安装与 Windows AEDT 匹配的 PyAEDT、`reportlab>=4.2,<5`、`pypdf>=5,<7`，并保留 `venv`、`ensurepip` 及其离线 wheel。预检以 `python -I` 运行，要求第三方模块实际从待打包 Python 目录加载，并实际创建独立环境及运行其中的 pip；依赖用户 site-packages、`PYTHONPATH` 或不支持创建 venv 的精简嵌入发行版会失败。
   DSH 作为 App 的直接依赖随 `node_modules` 打包，配套的散热 Agent 插件也随包提供；用户不需要另行安装 DSH。构建前和 `afterPack` 均校验 DSH CLI、包文件与插件。
4. 目标用户机器仍需有合法 AEDT/Icepak 安装及相应许可证；安装包不会内置 Ansys 产品或许可证。报告字体优先使用 Windows 系统中的可嵌入中文字体，也可设置 `REPORT_FONT_PATH`。
5. 安装包会携带 `assets/icepak/Project1.aedt` 作为三级环境自检的固定示例（SHA-256：`c8b1282d07bce6f0d29cfcba6deecf8b7736f66fc6cd026ad726933b3cd003d7`）。这是用户批准公开分发的测试工程。自检只在本机识别到 AEDT/PyAEDT 且独立会话可启动时，在副本上打开工程，不会自动求解，也不能证明任意客户工程兼容。
6. 品牌图标统一源自 `assets/brand/logo.svg`（由用户提供的 `TuLing/dist/favicon.svg` 复制）。Web、桌面窗口、托盘和 NSIS 安装程序分别使用随包的 SVG、PNG 和 ICO 派生文件；打包预检会校验运行时图标存在。

`packaging/windows-runtime/` 被 Git 忽略，不会把第三方可执行文件提交进仓库。构建者需自行核对二进制来源、许可条款、校验和及软件物料清单。

## Windows x64 新机器接力

在 PowerShell 中安装 Git、Node.js 22.22.x（或兼容的 Node 24）、pnpm 11、Python 3 和 uv 后，从空目录开始：

```powershell
git clone https://github.com/auenger/ThermalAgentApp.git
Set-Location ThermalAgentApp
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm test
```

不要复制 macOS 的 `node_modules`、`.venv` 或构建产物。随后放置待随包分发的 Windows x64 Node 运行时到 `packaging/windows-runtime/node/node.exe`；放置完整、可独立运行的 Python 3.10+ 目录到 `packaging/windows-runtime/python/`，其 `python.exe` 在 `-I` 隔离模式下必须能从该目录加载 `ansys.aedt.core`、`reportlab` 和 `pypdf`。用户机器的系统 Python 或 `PYTHONPATH` 不能代替这些内置资源。仓库已包含测试工程 `assets/icepak/Project1.aedt`，克隆后校验其 SHA-256 即可；不要用空文件替代。

这三个前置路径可以先检查：

```powershell
Test-Path packaging/windows-runtime/node/node.exe
Test-Path packaging/windows-runtime/python/python.exe
Test-Path assets/icepak/Project1.aedt
Get-FileHash assets/icepak/Project1.aedt -Algorithm SHA256
```

三项都存在、示例工程校验和符合上述值后，再运行下方打包命令。若 Python 探测失败，先修复内置目录中的依赖安装及 `._pth`/`site-packages`，不要通过安装到构建机用户目录绕过预检。

## 构建

```powershell
pnpm package:win
```

命令先构建 TypeScript/Web，再用内置 Node 执行固定版本 DSH CLI 与工具冒烟测试，检查 Icepak/报告插件以及隔离 Python 导入、依赖来源和 Windows x64 架构；之后使用 electron-builder 生成 NSIS x64 安装包到 `release/`。`afterPack` 会再次运行实际复制进包内的 DSH CLI `--version`，并检查隔离 Python 依赖。运行时插件进程也以 Python `-I` 启动，不继承用户 `PYTHONPATH`。配置位于 `electron-builder.yml`。缺失或误用系统资源会在打包前或 `afterPack` 阶段失败。

生成后先确认 `release/Thermal-Agent-0.1.0-Windows-x64.exe`（以 `package.json` 的实际版本号为准）存在并记录 SHA-256。不要把安装包、Node/Python 运行时或未授权工程提交回 Git；`release/` 和 `packaging/windows-runtime/` 已忽略。

## Windows 验收门槛

在没有开发工具或系统 Python 的干净 Windows 虚拟机上安装，并至少验证：

- App 启动、内置 Core 健康检查、SQLite 重启持久化和 DSH 对话入口。
- 内置 Python 可加载报告插件，并对已审批任务生成中文 PDF。
- 在有 AEDT 的工程机上运行轻量探测、独立会话启动探测、真实工程检查、Baseline、取消、候选求解和报告。
- 首次打开“设置 → Icepak 插件”应自动依次完成环境、启动和内置示例工程检查；“重新探测”重复这三步。无 AEDT 或非 Windows 应明确跳过后续步骤，示例工程检查不创建 Task、不求解、不宣称许可证 READY。
- App 显式开启/停止内网 Web，第二台浏览器短时码配对；双机组播发现、防火墙与节点信任状态。
- 卸载/升级时确认用户数据目录与 `identity/node-key.json` 不被误删。

这些步骤未执行前，不将“Windows 安装包完成”标记为已完成。代码签名、自动更新和跨 Windows 双机调度也仍在后续阶段。
