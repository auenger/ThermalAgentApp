# Windows 安装包构建与验收

当前仅有构建配置和静态预检，尚未完成真实 Windows 安装包验收。构建必须在 Windows x64 主机进行；原生依赖不能用 macOS 的 `node_modules` 直接交叉打包。代码仓库 `https://github.com/auenger/ThermalAgentApp.git` 为公开仓库。用户已确认 `assets/icepak/Project1.aedt` 是可公开分发的测试工程，随源码提交并由安装包带入；这不代表客户模型也可公开。

2026-09-21 在 macOS x86_64 执行 `pnpm package:win`：TypeScript 与 Web 构建通过，随后 `verify-windows-runtime.mjs` 按预期拒绝非 Windows x64 构建机，未生成 NSIS 安装包。该机器也没有 `packaging/windows-runtime/` 下的 Windows Node/Python 资源，仓库尚未配置远程 Windows CI。下一次打包需在 Windows x64 主机按下述步骤准备资源后重新执行；此记录不是安装或 AEDT 验收证据。

2026-09-22 在完成统一品牌图标、内置示例工程与 DSH 包校验后，再次执行 `pnpm package:win`：TypeScript/Web 构建及全套测试通过，Windows 预检因当前构建机为 macOS x86_64 而按设计停止，`release/` 未生成安装包。不得将这次构建表述为 Windows 可测试版本。

## 构建输入

1. 在 Windows x64 上安装 Node 22.22.x、pnpm 11、Python 3 和 uv，并运行 `pnpm install`、`pnpm test`。
2. 准备 `packaging/windows-runtime/node/node.exe`，采用可再分发的 Windows x64 Node 22.22.x 或兼容版本。构建前脚本会检查版本和 DSH CLI 语法。
3. 准备 `packaging/windows-runtime/python/python.exe` 及完整的 Windows x64 Python 3.10+ 运行目录。在该内置解释器中安装与 Windows AEDT 匹配的 PyAEDT、`reportlab>=4.2,<5`、`pypdf>=5,<7`。如果使用 Python embeddable distribution，需确保其 `._pth` 配置启用所需 `site-packages`。预检以 `python -I` 运行，并要求第三方模块实际从待打包 Python 目录加载；依赖构建机用户 site-packages 或 `PYTHONPATH` 会失败。
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
