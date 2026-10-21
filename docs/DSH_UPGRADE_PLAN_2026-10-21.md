# DSH 接入与独立升级计划

## 发布版本核查（2026-10-21）

官方 npm `@deepseek-ai/dsh` 的 `latest`、`next` 均为 `0.2.1-rc.2`，`alpha` 为 `0.2.1-alpha.5`。版本列表中没有正式稳定版。GitHub 同样将最新候选版标记为 Pre-release。不能把 npm latest 当成稳定性承诺。

- https://registry.npmjs.org/@deepseek-ai%2Fdsh
- https://github.com/deepseek-ai/deepseek-harness/releases
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md

用户已明确选择官方 latest。本次从 `0.1.5-rc.2` 升级至 `0.2.1-rc.2`，界面继续明确标注预发布版。

## 已落地的更新

- DSH 启动不再直接改写 `storages/workspace.json`，thermal session-control 通过 `workspaceRegistry.create` 注册或复用工作目录，由 DSH 负责持久化和迁移。
- 状态接口和设置页显示实际选中 CLI 所属 DSH 包的版本，并标注预发布版；无法辨认时报告未知。
- Windows 打包执行校验读取项目声明的 DSH 版本，去掉另一处写死的旧版本号。
- `pnpm check:dsh` 校验直接依赖、已安装包和 DSH overrides 是否一致；`pnpm check:dsh --online` 查询官方发行渠道，分别报告 latest 和正式稳定版。
- 增加运行时版本识别，以及真实 DSH 重启后会话和工作区身份保留的回归检查。

- DSH、直接依赖、overrides 和锁文件统一升级，Cordis 对齐 4.0.5；移除新版已退役的 code-runtime、subagent-in-process-driver 依赖。
- 预设迁移到新版本的声明式 `agent-preset-registry` / `agent-preset` 配置。
- 使用官方 `runProfile` 启动接口和 App 自有 IPC 就绪协议；插件安装通过内置 Node + pnpm 参数数组执行。
- 新增 `dsh.client` 浏览器插件，通过 `uiWorkspace` 服务切换会话、通过 `settings.launcher` 插槽打开设置，去除桌面端 React Fiber、散列 CSS 和内部 localStorage 操作。保留 DSH 自身侧栏及原生插件管理页。
- 普通任务预设与修复预设分开；自动修复仍仅能调用 3 个受控工具，保留调用次数及候选提交预算。
- 增加独立运行时目录导入：平台/架构/Bridge 协议/文件清单及摘要校验，复制到用户目录后再次校验。
- 更新排队到下次 App 冷启动，启动新引擎前复制 Profile；后端和工具桥通过后提交当前版本。失败恢复旧运行时，原 Profile 保留。崩溃后不会无限重试未通过的候选。
- 可排队恢复上一版运行时及对应 Profile，新版会话文件保留在磁盘。
- 内置引擎版本变化时，先备份已有 Profile；此备份用于保留升级前数据，不等同于保存旧安装包的二进制。
- 设置页提供导入、排队状态、错误信息和回退入口；`scripts/export-dsh-runtime.mjs` 从已构建的桌面资源导出完整运行时目录。
- Windows 原生依赖对齐：sharp 0.35.5、koffi 3.1.1、Node addon 0.1.9。安装包验收脚本按包清单核对 DSH 版本。

## 验证记录

- `pnpm build`：通过。
- `pnpm check:dsh --online`：依赖一致，官方 latest 为 0.2.1-rc.2，正式稳定版不存在。
- Node 全量 257 项：255 通过，2 项默认 Python 环境缺少 psutil 而跳过；另用独立 Python 环境补测，2 项全部通过。
- 新增真实 DSH 启动、重启、会话保留、坏候选回退；运行时路径/摘要/平台拒绝；Profile 快照与恢复检查。
- `scripts/smoke-dsh-navigation.mjs`：浏览器首次配置、设置页、会话切换、插件管理入口和 App 引擎更新页通过；通过内置 pnpm 安装含空格路径的本地测试插件，启用后实际执行成功。
- `scripts/smoke-dsh-agent-tools.mjs`：普通预设 32 个工具，其中 23 个 Thermal 工具；修复预设严格 3 个工具、64 次调用/3 次候选预算通过。
- Windows 原生安装及 Icepak 工程验证仍需在目标机器执行。跨平台构建不替代真机验收。

## 独立引擎更新使用方式

1. 发行方从已构建的目标平台资源导出：
   ```sh
   node scripts/export-dsh-runtime.mjs <resources目录> <新输出目录> win32 x64
   ```
2. 将整个目录交付目标机器，在设置 → DSH 引擎更新中输入目录路径并校验。
3. 等当前任务完成后完全退出 App，再启动以应用。单击关闭窗口如果仅隐藏到托盘，不算完全退出。
4. 新运行时失败会恢复原版本；也可在设置中排队恢复上一版。

状态位于 App 数据目录 `dsh-runtimes/state.json`。外置运行时以清单摘要命名，运行数据位于 `dsh-profiles/<uuid>`；初始内置数据仍在 `dsh`。内置升级的数据备份位于 `dsh-runtimes/bundled-backups/<uuid>`。

本阶段导入的是用户明确选择的可信本地包。摘要校验保证文件一致性，不认证发布者。没有接入云端发行服务、签名更新源或自动跟随 npm latest；不能直接把 npm 包目录当成完整运行时包导入。

## 本次 Windows 交付

- 安装包目录：`release-cross/dsh-latest-20261021-r1/`，普通版 Windows x64。
- 打包资源已核对：DSH 0.2.1-rc.2，Core、Desktop、客户端插件和启动器与当前编译产物逐字节一致。
- 真机优先验收：覆盖旧普通版安装；安装至 `C:\Thermal Agent Test`；启动后确认引擎版本；旧会话可打开；插件可安装和执行；真实 Icepak 动态 Python 调参、保存和复用。
- 外置运行时在“设置 → DSH 引擎更新”导入后完全退出再启动；确认更新失败时旧引擎可恢复，以及成功更新后的上一版回退。
- CAD Preview 的独立安装包本次未生成，不能据此宣称其覆盖安装通过。

## 后续发行与 Windows 验收

- 建设自有 DSH 工程插件索引及发行源。原生插件管理页面已接入；自有仓库的地址、发布凭据和版本治理尚未配置。
- 外置运行时包包含与引擎匹配的 thermal 适配器；当前必需的适配器不提供单独卸载/升级入口，避免与 Core 协议失配。Python 工程脚本与插件仍使用既有独立演进机制。
- 对网络运行时更新增加受信源、发布者签名与渠道选择后，再开放自动检查和下载。
- Windows 验证普通版与 CAD Preview 覆盖安装、空格/中文路径、会话迁移、插件安装、外置引擎更新/回退和真实 Icepak 动态 Python 仿真。
