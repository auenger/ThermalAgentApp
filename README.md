# Thermal Agent App

面向 Windows Icepak 工程师的桌面优先散热 Agent 应用。项目正在从原有的 FastAPI、PostgreSQL、MinIO、Temporal B/S 架构迁移为 Electron、SQLite、DSH、插件化 Icepak 和局域网计算节点架构。

完整目标设计见 [散热 Agent 桌面应用重构架构分析](./散热Agent桌面应用重构架构分析.md)。

## 当前迁移状态

已经建立第一批可执行基础：

- Task、审批、热判定和插件能力契约。
- 可验证的 Task 状态机。
- SQLite 本地持久化及状态事件审计。
- 基于 SHA-256 的本地 Artifact Store。
- 内置 Local Core HTTP API。
- Electron 与浏览器共用的 Fluent UI 工程工作台。
- Icepak 插件 Manifest、stdio JSON 协议和保守环境探测。
- 从旧 Windows Worker 抽取的 AEDT 工程检查、能力配置校验、Baseline/风扇求解、温度指标和收敛证据逻辑。
- Run/Attempt 后台执行、输入快照、heartbeat、取消以及结果 Artifact 关联。
- 基于校验、收敛、最高温度目标的确定性热判定，以及独立的人工结果审批 Gate。
- 由用户批准的单次风扇候选求解：复用 Baseline 已求解工程和指标，完成逐 Monitor 对比后再次复核。
- 固定 DSH `0.1.5-rc.2` 的本地 Agent Host、持久会话工作区和散热专用 preset。
- Token 保护的 Thermal Tools Bridge，以及任务、Icepak 探测和工程检查工具。
- 以完成任务证据为来源的 Skill 草稿、人工审核、版本记录和 DSH `SKILL.md` 发布/撤回。

当前还没有完成 Windows 真实 AEDT 回归验收、通用候选策略、Skill 运行/修复闭环、安装包和局域网节点调度。未完成能力不会在界面中显示为可用。

## 本地运行

要求 Node.js `^22.19.0` 或 `>=24`、pnpm 11，以及用于 Icepak 插件开发检查的 Python 3。DSH CLI 使用 `import.meta.main`，Node 22.13 会静默跳过入口，因此不能作为运行环境。

```sh
pnpm install
pnpm test
pnpm dev:core
```

Core 默认只监听 `127.0.0.1:43110`，数据默认保存在当前目录的 `.thermal-agent/`。可通过以下环境变量覆盖：

```text
THERMAL_AGENT_HOME
THERMAL_AGENT_HOST
THERMAL_AGENT_PORT
THERMAL_AGENT_DSH_CLI
THERMAL_AGENT_NODE_BIN
THERMAL_AGENT_DSH_PLUGIN
```

局域网绑定不会默认开启。后续实现设备配对和认证之后，才允许显式绑定非 loopback 地址。

在 Windows Icepak 开发机上，可进入“设置 → Icepak 插件”，填写本机 `.aedt` 路径执行工程检查或风扇动作验证。也可以新建带工程路径的任务，确认需求后启动后台 Baseline。Core 会先生成内容寻址快照，源工程不会被保存或修改。求解完成后任务进入待复核状态；用户接受证据后才会完成，拒绝则升级人工处理。

“Agent”页面嵌入本机 DSH 对话。Agent 可以通过自然语言创建 Task 草稿、读取任务证据、探测 Icepak 和检查工程，但工具层不提供直接启动 Baseline 的能力；需求确认和昂贵求解必须回到 App 操作。

完成任务只有在存在成功 Attempt，且输入工程、求解工程和结构化结果 Artifact 齐全时，才能沉淀为 Skill 草稿。草稿不会进入 DSH；用户在“技能”页面审核启用后才发布到本机工作区，停用会撤回发布文件。

## 目录

```text
apps/core/                 本地业务 API 与后台协调入口
apps/desktop/              Electron 桌面进程
apps/web/                  App 与局域网 Web 共用界面
packages/contracts/        跨进程和跨节点契约
packages/domain/           Task 状态机和领域规则
packages/sqlite-store/     SQLite migration 与 Repository
packages/artifact-store/   本地内容寻址文件存储
plugins/icepak-pyaedt/     独立 Python Icepak 插件
plugins/dsh-thermal/       DSH 散热工具插件
docs/adr/                  架构决策记录
tests/                     跨包集成测试
```
