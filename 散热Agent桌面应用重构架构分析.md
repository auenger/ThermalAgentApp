# 散热 Agent 桌面应用重构架构分析

> 文档状态：架构分析初稿  
> 编写日期：2026-09-21  
> 参考项目：`suzhousanre`、`/Users/ryan/mycode/AgentHR`

## 1. 背景与重构目标

当前 `suzhousanre` 是典型的 B/S 架构：React Web、FastAPI Gateway、PostgreSQL、MinIO、Temporal、编排 Worker 和 Windows Icepak Worker。它已经能够完成固定 `Project1.aedt` 的真实 Baseline、AI 风扇动作、候选求解、温度对比、证据保存和 PDF 报告，但部署组件较多，并且依赖中心服务器。

本次重构的目标是把产品调整为一个可直接安装在 Windows 工程师电脑上的散热 Agent App：

1. 不再要求用户部署 PostgreSQL、MinIO、Temporal、Docker 或独立服务器。
2. App 内置 SQLite、本地文件存储、Task 管理、Agent Runtime 和 Web 服务。
3. 桌面 App 与局域网 Web 共用一套界面和业务逻辑。
4. Icepak/PyAEDT 作为可发现、可验证、可升级的求解插件。
5. 参考 AgentHR，在 App 内托管 DSH，通过自然语言完成需求收集、Task 管理、模型连接、逻辑判断、Skill 选择和 Skill 沉淀。
6. 多台安装 App 的 Windows 电脑可在局域网自动发现，形成去中心化计算节点池，将任务分配给具有可用 Icepak 环境的空闲节点。

这次工作不是简单替换数据库或增加 Electron 外壳，而是把产品从“中心化 Web 仿真平台”重构为：

> 桌面优先、Agent 驱动、插件化求解、可组成局域网算力池的 Windows 工程应用。

## 2. 总体架构判断

方向可行，推荐采用 Electron + React + 本地 Core + SQLite + DSH + Python Icepak Plugin 的混合架构。

“所有逻辑收敛在 App”应理解为产品和交付形态收敛，而不是将全部能力塞进一个进程。为了保证 AEDT 崩溃隔离、长任务恢复、DSH 重启和桌面 UI 稳定，内部仍需要清晰的进程边界。

```text
Thermal Agent App
├─ Desktop Shell
│  └─ Electron + React
├─ Embedded Web
│  └─ 同一套 React 页面，通过局域网浏览器访问
├─ Local Core
│  ├─ Task/Workflow 状态机
│  ├─ 人工确认与策略校验
│  ├─ SQLite Repository
│  ├─ Artifact Store
│  ├─ 本地/LAN API
│  └─ 审计、备份与恢复
├─ DSH Agent Runtime
│  ├─ 模型配置
│  ├─ 自然语言会话
│  ├─ Thermal Tools
│  └─ Skill Registry
├─ Icepak Plugin Host
│  ├─ 环境探测
│  ├─ 工程检查
│  ├─ PyAEDT/AEDT 求解
│  ├─ 证据采集
│  └─ 取消与进程回收
└─ Peer Service
   ├─ 节点发现与配对
   ├─ 能力与负载心跳
   ├─ 任务租约
   ├─ 文件传输
   └─ 结果同步
```

## 3. 产品运行形态

每台 Windows 安装包都是一个完整节点，可以承担不同角色：

- 工作台节点：创建需求、管理任务、运行 Agent、查看结果，不一定安装 Icepak。
- 计算节点：检测到可用 Icepak 后对外发布求解能力。
- 混合节点：同时承担工作台和本机求解。

同一个安装实例支持三种入口：

1. 本机 Electron 桌面窗口。
2. Windows 托盘后台服务。
3. 用户明确开启后，通过局域网浏览器访问的 Web 页面。

建议第一版运行在登录用户会话中，通过托盘和开机自启动保证后台执行。暂不直接运行在 Windows Session 0 Service 中，因为 AEDT、许可证、用户配置目录及非图形启动在服务会话中的兼容性需要单独验证。

关闭主窗口不应终止 Task、DSH Host、局域网服务或 Icepak 求解；只有用户执行“退出应用”时才进行受控关闭。

## 4. 桌面端与 Web 端共用架构

桌面端和 Web 端不应形成两套实现。

```text
Electron Renderer ─┐
                   ├── Local Core API ── Domain Services ── SQLite / Artifacts
LAN Browser ───────┘
```

推荐原则：

1. 一套 React 页面构建产物，同时供 Electron 和内置 HTTP 服务使用。
2. 一套 Core API，同时服务 Electron 与 LAN Web。
3. 所有业务写入经过领域服务、事务和审计，不允许 Renderer、DSH 和插件直接写 SQLite。
4. Electron IPC 仅处理桌面能力，如选择文件、托盘、系统通知、窗口管理；业务数据仍通过 Core。
5. LAN Web 不直接访问 DSH Host、SQLite 或 Icepak Plugin。

## 5. 本地数据与文件存储

### 5.1 推荐目录

```text
%LOCALAPPDATA%/ThermalAgent/
├─ data/
│  └─ thermal.db
├─ artifacts/
│  ├─ sha256/
│  └─ tasks/{task-id}/
├─ workspace/
├─ plugins/
├─ dsh/
├─ logs/
├─ backups/
└─ node-identity/
```

### 5.2 SQLite 保存的内容

- Task、执行状态和当前步骤。
- 需求快照、单位、来源和版本。
- 审批请求、审批决定和操作人。
- 运行轮次、模型版本和 lineage。
- Agent 决策、策略校验和动作记录。
- Skill、Skill 版本、来源任务和运行记录。
- 节点、能力、配对关系、租约和同步状态。
- Artifact 元数据、SHA-256、大小和相对路径。
- 审计事件、错误码和诊断信息。

### 5.3 文件系统保存的内容

- `.aedt` 和 `.aedtresults`。
- CAD/STP 原始输入。
- Monitor、convergence、原生 solver 文件。
- 温度云图、粒子流、CSV 和截图。
- PDF 报告。
- 插件日志和诊断包。

大型二进制文件不得写入 SQLite。Artifact Store 建议按内容哈希管理，并在 Task 目录中保存引用或硬链接，避免重复复制大文件。

### 5.4 SQLite 运行要求

- 开启 WAL。
- 开启 foreign keys。
- 设置 busy timeout。
- 采用版本化 migration。
- Core 为唯一业务写入者。
- 定期在线备份。
- 支持导出/导入诊断包和项目包。
- API Key、设备私钥等秘密使用 Windows Credential Manager 或 DPAPI，不以明文写入 SQLite。

多台机器不能复制或合并同一个 SQLite 文件。每个节点拥有自己的数据库，跨节点同步业务事件、任务快照和 Artifact，不做数据库级多主同步。

## 6. Task 与本地持久化工作流

Temporal 移除后，不能把长流程退化为内存中的 Promise 或简单队列。Local Core 必须提供可恢复的持久化状态机、事务 outbox、幂等执行和任务租约。

建议将三类状态分开：

### 6.1 执行状态

```text
DRAFT
→ READY
→ QUEUED
→ LEASED
→ TRANSFERRING
→ RUNNING
→ WAITING_FOR_APPROVAL
→ SYNCING_RESULTS
→ COMPLETED / FAILED / CANCELLED / ESCALATED
```

### 6.2 热设计判定

```text
PENDING / PASS / FAIL / INVALID / DIVERGED
```

### 6.3 人工决策状态

```text
NONE / PENDING / APPROVED / REJECTED / EXPIRED / CANCELLED
```

任务必须保留：

- `task_id`
- `run_id`
- `attempt_id`
- `owner_node_id`
- `executor_node_id`
- `lease_id`
- 需求版本
- 输入 SHA
- 插件及 Skill 版本
- 每轮 checkpoint
- 最终 Artifact 引用

App 异常退出后，重新启动必须能够识别：

- 尚未开始的排队任务。
- 正在远程执行且租约仍有效的任务。
- 本地子进程已经消失的中断任务。
- 已完成求解但结果尚未写回的任务。
- 等待用户确认的任务。

## 7. Icepak 插件化设计

### 7.1 插件边界

推荐保留 Python/PyAEDT 实现，把当前求解代码抽成独立插件进程，而不是改写成 TypeScript。

```text
Local Core
    │ JSON-RPC / loopback HTTP / stdio protocol
    ▼
Icepak Plugin Host（独立 Python 进程）
    │
    ▼
PyAEDT / AEDT / License
```

插件接口建议包括：

```text
probe_environment()
inspect_project()
validate_project()
prepare_run()
solve()
cancel()
collect_artifacts()
health()
```

插件不得直接修改 Core SQLite。所有状态、结果和 Artifact 都通过协议返回给 Core。

### 7.2 环境探测状态

不能因为发现 AEDT 安装目录就宣称“求解可用”。探测应分层：

1. `NOT_INSTALLED`：未发现 AEDT。
2. `DETECTED`：发现安装目录和版本。
3. `NEEDS_CONFIG`：缺少 PyAEDT、许可证或必要配置。
4. `LAUNCHABLE`：AEDT 可以启动。
5. `PROJECT_COMPATIBLE`：Design、Setup、Monitor 和项目结构可识别。
6. `READY`：可执行真实求解并生成必要证据。
7. `BUSY`：当前没有可用并发。
8. `DEGRADED`：可求解，但某些导出或收敛接口不可用。

示例：

```json
{
  "plugin": "icepak-pyaedt",
  "plugin_version": "1.0.0",
  "status": "READY",
  "aedt_versions": ["2024.2"],
  "selected_version": "2024.2",
  "pyaedt_available": true,
  "license_status": "AVAILABLE",
  "capabilities": [
    "inspect",
    "baseline_solve",
    "fan_curve_scale",
    "monitor_export",
    "convergence_evidence"
  ]
}
```

### 7.3 插件 Manifest

每个插件需要声明：

- 插件 ID 和版本。
- 支持的 AEDT 版本。
- Python Runtime 要求。
- 操作系统要求。
- 支持的输入类型。
- 支持的动作类型及范围。
- 需要的许可证。
- 最大并发。
- 证据输出契约。
- 配置 schema。

### 7.4 现有代码复用

当前项目中以下能力应保留并迁入插件：

- `services/worker/solver/icepak_project.py`
- `services/worker/solver/icepak_convergence.py`
- `services/worker/solver/icepak.py`
- `scripts/check_icepak_project.py`
- `scripts/check_icepak_project.ps1`
- `scripts/windows_convergence_probe.py`
- 求解进程 heartbeat、启动超时和取消清理逻辑。
- Artifact、SHA、lineage、Monitor 和收敛证据校验。

迁移时需要解除这些代码对 MinIO、Temporal Activity、全局 Settings、PostgreSQL 和当前 Worker 入口的直接依赖。

## 8. DSH Agent Runtime

### 8.1 可复用 AgentHR 模式

AgentHR 已经验证：

- Electron 桌面壳。
- 内置 SQLite。
- 使用受管子进程启动 DSH Web Host。
- 随机 loopback 端口和认证 token。
- DSH Profile 与领域插件组合。
- Task、Skill、Skill 版本、运行步骤和审计。
- 从成功任务提取 Skill 草稿。
- 打包时携带固定版本的 DSH Runtime。

Thermal App 可以复用 AgentHR 的 `dsh-host.ts`、`dsh-profile.ts`、Bridge 和 Store 设计思想，但不能直接复制招聘领域代码。

### 8.2 DSH 的责任

- 理解自然语言需求。
- 识别缺失信息并追问。
- 调用强类型 Thermal Tools。
- 解释确定性检查结果。
- 根据能力、历史和 Skill 提出候选方案。
- 生成报告摘要和 Skill 草稿。

### 8.3 Core 的责任

- 字段校验和单位归一化。
- 状态机、事务和幂等。
- 权限、审批和审计。
- 能力检查和策略边界。
- Task、Artifact 和 Skill 持久化。
- 本地或远程执行节点选择。

### 8.4 Icepak Plugin 的责任

- 环境探测。
- 工程检查。
- 工作副本管理。
- AEDT/PyAEDT 调用。
- 真实求解。
- Monitor、收敛和 Artifact 采集。
- 取消和进程回收。

DSH 不得直接操作 SQLite，也不得直接加载 PyAEDT 或控制 AEDT。

### 8.5 Thermal Tools

建议首批工具：

```text
thermal_get_environment
thermal_create_task_draft
thermal_update_requirements
thermal_attach_model
thermal_inspect_model
thermal_validate_parameters
thermal_propose_run_plan
thermal_request_approval
thermal_start_solve
thermal_get_run_status
thermal_cancel_run
thermal_list_iterations
thermal_propose_candidate
thermal_approve_candidate
thermal_reject_candidate
thermal_generate_report
thermal_create_skill_draft
thermal_publish_skill
thermal_list_peer_nodes
```

生产 preset 不应像 AgentHR 当前原型一样默认给 Agent 不受限的 Shell 和文件读写能力。需要的文件访问应限制在 Task Workspace 内，外部路径通过用户选择和 Core 授权。

### 8.6 DSH UI 集成

可以在 Electron 中嵌入 DSH Web，但核心 Task 流程不应长期依赖操作 DSH 页面 DOM 来新建会话和发送消息。建议增加独立 `DshSessionAdapter`，通过稳定的 DSH API 或 Host 协议完成：

- 创建会话。
- 发送消息。
- 监听增量输出。
- 接收工具调用。
- 恢复会话。
- 取消 Agent 任务。

DSH Host 保持 loopback-only，不直接发布到局域网。LAN 用户通过 Thermal Core 的会话 API 操作 Agent。

## 9. 自然语言业务闭环

目标流程：

```text
用户自然语言描述需求
→ Agent 整理结构化需求草稿
→ Core 校验缺失参数、单位和来源
→ 用户确认需求快照
→ 探测本机和局域网 Icepak 能力
→ 检查模型和运行条件
→ Agent 生成求解计划
→ 用户确认开始求解
→ 本机执行或发放给局域网节点
→ 保存 Baseline、日志和证据
→ 确定性判定
→ Agent 生成候选方案
→ 策略引擎校验动作边界
→ 用户批准一个方案
→ 插件执行并重算
→ 同步结果
→ 报告与 Skill 草稿
→ 人工审核后发布 Skill
```

必须保留的人工 Gate：

1. 需求冻结。
2. 开始真实求解。
3. 应用候选参数变更。
4. 接受失败结果或升级人工处理。
5. 交付报告与发布 Skill。

Agent 不能自行放宽客户目标、绕过预算、修改原始工程、执行未批准动作或自动启用新学到的 Skill。

## 10. Skill 沉淀

Skill 建议具有以下状态：

```text
DRAFT → REVIEWED → ENABLED → DISABLED / NEEDS_REPAIR
```

每个 Skill 保存：

- Skill ID、名称、类别和适用场景。
- 版本化定义。
- 输入参数 schema。
- 所需 Icepak 能力。
- 操作步骤。
- 风险等级。
- 必要审批点。
- 成功标准。
- 失败策略和回滚方式。
- 来源任务和证据。
- 使用次数、成功次数、连续失败次数。

成功任务可以生成 Skill 草稿或向已有草稿合并新证据，但不能自动进入 `ENABLED`。热仿真 Skill 具有工程风险，必须经过工程师审核。

Skill 选择建议采用两阶段：

1. 确定性过滤：输入类型、插件能力、AEDT 版本、动作范围和审批要求。
2. Agent 排序与解释：结合任务目标、历史效果和证据推荐候选 Skill。

## 11. 局域网去中心化组网

### 11.1 核心原则

推荐采用：

> 自动发现 + 能力发布 + 设备配对 + 任务 Owner + Executor 租约。

去中心化不等于所有节点同时拥有同一数据库。每个任务只有一个 Owner 节点作为事实源，可以由另一个 Executor 节点完成求解。

### 11.2 节点发现

建议组合：

- mDNS/Bonjour 服务发布。
- UDP Discovery 作为 Windows 网络环境补充。
- 手动输入 IP 作为兜底。

节点心跳示例：

```json
{
  "node_id": "stable-device-id",
  "name": "ICEPAK-WS-03",
  "app_version": "1.0.0",
  "platform": "windows",
  "icepak_status": "READY",
  "aedt_versions": ["2024.2"],
  "plugin_version": "1.0.0",
  "license_cores": 4,
  "concurrency": 1,
  "running_tasks": 0,
  "free_disk_gb": 180,
  "last_heartbeat": "2026-09-21T00:00:00Z"
}
```

### 11.3 Owner 与 Executor

Owner 负责：

- 需求、审批和任务事实状态。
- 选择执行节点。
- 发放和续期租约。
- 输入 Artifact 和 SHA。
- 接收进度、验证结果、形成最终状态。

Executor 负责：

- 校验租约和能力要求。
- 下载并验证输入 SHA。
- 在隔离工作目录执行。
- 上报 heartbeat 和阶段进度。
- 上传结果、原生证据和输出 SHA。
- 网络中断时保留结果，等待 Owner 恢复后重新同步。

### 11.4 任务租约

任务发放至少包含：

```json
{
  "task_id": "...",
  "run_id": "...",
  "attempt_id": "...",
  "owner_node_id": "...",
  "executor_node_id": "...",
  "lease_id": "...",
  "lease_expires_at": "...",
  "input_sha256": "...",
  "required_capabilities": ["baseline_solve", "monitor_export"]
}
```

Executor 定期续租。租约过期后 Owner 才能重新分配。迟到结果可以保存为孤立 Attempt 证据，但不能覆盖新的有效 Attempt。

节点选择建议按以下顺序评分：

1. 本机 READY 且空闲时优先本机。
2. AEDT 和插件版本兼容。
3. License、CPU、内存和磁盘满足要求。
4. 当前队列长度和预计等待时间。
5. 节点信任等级。
6. 网络传输成本。

### 11.5 文件和结果传输

- Artifact 按 SHA-256 标识。
- 支持分块上传和断点续传。
- 传输前后校验哈希。
- 大文件避免通过 JSON。
- 结果包含 Manifest、文件列表、大小和 SHA。
- Owner 确认全部必要证据到齐后才写最终状态。

### 11.6 安全

局域网发现不等于自动信任。首次组网需要：

- 配对码或二维码。
- 每个设备独立身份密钥。
- 双向认证。
- 用户明确批准设备。
- 节点权限和可执行能力范围。
- 可撤销配对。
- 请求、租约和结果签名。
- 防重放 nonce 和过期时间。

只有 Thermal Core API 可以对局域网开放。SQLite、DSH Host、插件 RPC 和调试端口必须保持 loopback-only。

## 12. 现有系统的保留与替换

| 当前能力 | 重构处理 |
| --- | --- |
| React 页面 | 保留业务组件，迁入 Electron Renderer，并由 LAN Web 复用 |
| FastAPI HTTP 契约 | 保留接口语义，重构为内置 Core API |
| PostgreSQL | 替换为 SQLite |
| MinIO | 替换为 Artifact Store 和节点文件传输 |
| Temporal | 替换为 SQLite 持久化状态机、outbox 和任务租约 |
| DeepSeek 直连 | 替换为 DSH 的模型与 Agent Runtime |
| Icepak/PyAEDT | 保留，抽为独立插件 |
| convergence/monitor 证据 | 保留 |
| PDF 报告 | 保留，改为 Core 或报告插件调用 |
| Docker Compose | 桌面产品不再依赖 |
| JWT 多租户 | 改为本机账户、LAN 用户和设备授权 |
| Windows 验收脚本 | 保留并升级为插件自检 |
| Task/Iteration/Model lineage | 保留概念，迁入 SQLite |

## 13. 推荐代码结构

```text
ThermalAgentApp/
├─ apps/
│  ├─ desktop/                 # Electron Main、Preload、托盘和更新
│  ├─ web/                     # React，共用于 Electron 与 LAN
│  └─ core/                    # 本地 API、领域服务和后台调度
├─ packages/
│  ├─ contracts/               # API、事件、插件、Peer 契约
│  ├─ domain/                  # Task、Requirement、Approval、Skill
│  ├─ sqlite-store/            # Migration 和 Repository
│  ├─ artifact-store/          # 本地 Artifact 和 SHA
│  ├─ dsh-runtime/             # DSH Host、Profile、Session Adapter
│  ├─ thermal-tools/           # DSH Thermal Tools
│  ├─ peer-network/            # Discovery、配对、租约和同步
│  └─ report/                  # 报告编排
├─ plugins/
│  └─ icepak-pyaedt/
│     ├─ manifest.json
│     ├─ python/
│     ├─ tests/
│     └─ acceptance/
├─ skills/
│  ├─ builtin/
│  └─ schemas/
├─ migrations/
├─ docs/
├─ scripts/
└─ tests/
```

如果 Core 最终采用 TypeScript，可复用 AgentHR 的 Electron、DSH 和 SQLite 经验；Icepak Plugin 继续使用 Python。如果希望最大限度保留现有 Python 领域代码，也可以将 Core 暂时做成打包的 Python sidecar，但长期需要避免 Electron、Core 和插件三处重复定义业务状态。

推荐以 TypeScript Core 负责产品领域、SQLite、DSH 和 LAN；Python 仅负责 Icepak 插件和已有报告/工程算法，边界最清晰。

## 14. 分阶段实施计划

### 阶段 0：契约和决策冻结

- 建立新仓库/目录。
- 编写 Architecture Decision Records。
- 固定 Task、Run、Attempt、Artifact、Plugin、Skill 和 Peer 契约。
- 明确第一版支持的 AEDT/PyAEDT/Windows 版本。
- 明确哪些现有代码迁移、哪些淘汰。

### 阶段 1：单机桌面闭环

- Electron + React App。
- SQLite 和 migration。
- Local Artifact Store。
- 本地 Task 状态机。
- Icepak Plugin Host。
- 迁移真实 Baseline、候选求解和证据保存。
- App 崩溃和重启恢复。
- 安装包内不需要 PostgreSQL、MinIO、Temporal 或 Docker。

验收目标：一台 Windows 安装后，可以独立完成真实 Icepak 两轮任务并生成报告。

### 阶段 2：DSH Agent 化

- 嵌入固定版本 DSH Runtime。
- Thermal DSH Plugin。
- 自然语言需求收集。
- Task 管理 Tools。
- 人工确认 Gate。
- Skill 草稿、版本、启用、失败统计。
- 模型配置和安全凭据管理。

验收目标：用户主要通过自然语言创建、执行和复核任务，所有动作有结构化记录。

### 阶段 3：LAN Web

- 内置 Web 服务。
- Electron 与浏览器共用前端。
- 用户、设备配对和权限。
- HTTPS 或受信任局域网证书方案。
- Windows 防火墙引导。
- WebSocket/SSE 任务进度。

验收目标：同一局域网的另一台电脑可以安全查看和操作本机 App。

### 阶段 4：局域网计算节点

- mDNS/UDP 节点发现。
- 能力和负载心跳。
- 节点配对和信任。
- Task Owner、Executor 和租约。
- Artifact 分块传输、断点续传和 SHA 校验。
- 远程进度与结果同步。
- 网络中断和迟到结果处理。

验收目标：无 Icepak 的工作台节点可以将任务交给空闲 Icepak 节点，并获得完整可验证结果。

### 阶段 5：产品化

- Windows 签名安装包。
- App 和插件独立更新。
- AEDT/PyAEDT 兼容矩阵。
- 备份与恢复。
- 日志诊断包。
- 求解取消与 License 释放验收。
- 多节点压力、断网、重启和版本不兼容测试。

## 15. 主要风险

### 15.1 AEDT 与 Windows 后台会话

必须验证托盘后台、用户锁屏、远程桌面断开、开机自启动和 Session 变化对 AEDT/PyAEDT 的影响。不要在未验证前承诺真正的 Windows Service 模式。

### 15.2 DSH 版本仍较新

AgentHR 固定使用 DSH RC 版本。Thermal App 必须固定依赖版本、保留打包后 Host 验证，并通过 Adapter 隔离 DSH API 变化。

### 15.3 SQLite 不是分布式数据库

SQLite 适合单节点本地事实存储，但不能承担多节点共享数据库。分布式部分必须围绕 Task Owner、租约、事件和 Artifact 协议设计。

### 15.4 大文件传输

`.aedtresults` 可能很大，必须支持分块、断点续传、磁盘空间预检和内容哈希去重。

### 15.5 重复求解和许可证浪费

任务租约、attempt 幂等、并发限制和取消回执是必需能力，不能只依赖“节点当前显示空闲”。

### 15.6 Agent 工程安全

Agent 的自然语言能力不能绕过确定性校验。需求冻结、真实求解、参数变更、接受失败和发布 Skill 都需要人工 Gate。

### 15.7 App 更新兼容性

Core、数据库、插件、DSH、Skill 和 Peer 协议都需要独立版本，节点之间必须协商协议版本，不能默认不同版本完全兼容。

## 16. 最终建议

1. 正式采用 Electron + React + TypeScript Core + SQLite + DSH + Python Icepak Plugin。
2. “App 一体化交付、内部多进程隔离”。
3. 首先完成单机真实求解闭环，再接入 DSH，再发布 LAN Web，最后做多节点调度。
4. SQLite 只作为本机数据库，大文件使用 Artifact Store。
5. Icepak Plugin 必须同时具备环境探测、工程检查、真实求解、证据采集和取消能力。
6. DSH 只调用强类型 Thermal Tools，不直接访问 SQLite 和 AEDT。
7. 局域网采用任务 Owner + Executor 租约，不做 SQLite 多主同步。
8. LAN 服务默认关闭或只绑定 loopback，用户明确启用后再开放，并完成设备配对和认证。
9. 从成功任务生成的 Skill 只能成为草稿，必须经工程师审核后启用。
10. 保留当前真实 Icepak、收敛证据、Artifact lineage 和 Windows 验收成果，避免重写已经验证的工程逻辑。

重构完成后的产品不再是一个固定 `Project1` 的服务端 Demo，而应成为一个可安装、可扩展、可自然语言操作、可发布局域网 Web，并能组成去中心化 Icepak 算力池的散热工程 Agent App。
