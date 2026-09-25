# Thermal Agent App

面向 Windows Icepak 工程师的桌面优先散热 Agent 应用。项目正在从原有的 FastAPI、PostgreSQL、MinIO、Temporal B/S 架构迁移为 Electron、SQLite、DSH、插件化 Icepak 和局域网计算节点架构。

完整目标设计见 [散热 Agent 桌面应用重构架构分析](./散热Agent桌面应用重构架构分析.md)。

当前交接结论、已验证范围与本地手动回归步骤见 [阶段总结与本地手动回归](./docs/MIGRATION_HANDOFF_2026-09-21.md)。Windows 构建机准备、打包命令与验收门槛见 [Windows 打包说明](./docs/WINDOWS_PACKAGING.md)。已生成跨平台 Windows 试包，但尚未完成 Windows 安装与运行验收。

## 当前迁移状态

已经建立第一批可执行基础：

- Task、审批、热判定和插件能力契约。
- 可验证的 Task 状态机。
- SQLite 本地持久化及状态事件审计。
- 基于 SHA-256 的本地 Artifact Store。
- 内置 Local Core HTTP API。
- Electron 与浏览器共用的 Fluent UI 工程工作台。
- 桌面端隐藏原始标题栏，保留原生最小化、最大化和关闭按钮；主导航使用填充图标标识当前页面。DSH 对话归档在侧栏内联确认，不再使用系统确认弹窗。
- Core SSE 状态流，桌面与 Web 可自动更新 Task 和活跃 Attempt 状态。
- 默认关闭的独立 LAN Listener；本机显式开启后，远端浏览器必须用 8 位短时码换取 HttpOnly、SameSite 会话。
- Desktop 为每次 App 会话分配独占 loopback 端口，并区分开发目录与 `app.asar`/unpacked 运行资源。
- Desktop 单实例与托盘后台：关闭工作台窗口不会终止 Core，托盘可重新打开；Core 异常退出会有限次退避重启。真实 Windows 长任务不中断与恢复仍待验收。
- Icepak 插件 Manifest、stdio JSON 协议、轻量安装识别与显式独立会话启动探测（`LAUNCHABLE` 不等于求解许可证可用）。
- 从旧 Windows Worker 抽取的 AEDT 工程检查、能力配置校验、Baseline/风扇求解、温度指标和收敛证据逻辑。
- Run/Attempt 后台执行、输入快照、heartbeat、取消以及结果 Artifact 关联。
- Windows `taskkill /T /F` 进程树回收边界，用于取消 PyAEDT/AEDT、停止 DSH 和退出 Desktop。
- 失败/取消 Run 的显式重试：复用不可变输入 Artifact，每个 Run 最多保留 3 次 Attempt。
- 基于校验、收敛、最高温度目标的确定性热判定，以及独立的人工结果审批 Gate。
- 完整建单入口：人工填写或载入 DSH Agent 整理的 Task 草稿，填写散热需求、客户/项目、工况、监测点、最高温度目标和调优边界；可上传单个 `.aedt`，也可在仅有 CAD 时先归档 STEP、IGES、Parasolid 或 ACIS 中性几何。上传文件限 2 GiB，原件保留在本地 Artifact Store；当前不处理独立 `.aedb`、CAD 装配依赖文件，也不自动把 CAD 转成可求解的 Icepak 工程。
- 新建任务位于独立页面，不在首页内嵌表单。任务列表进入 Task 详情：结构化展示需求、模型能力、保存时的优化策略初筛、人工选定方案和补充约束、每轮 Icepak 求解的最高温度与证据、状态事件。专家可在任务时间线追加署名记录，记录不会自动触发求解；当前通用多轮改模仍未实现。
- App 默认工作空间为数据根目录下的 `workspace/`，DSH Agent 会话以此为工作目录；每个 Task 独占 `workspace/tasks/<Task ID>/`，输入模型、对话附件、求解过程和报告在其子目录中。DSH 对话建单会自动归档最近一条用户消息上传的文件；唯一可识别的 `.aedt` / CAD 文件会绑定任务，仍须能力检查与人工确认。工作目录详情见 [Task 工作台设计](./docs/TASK_WORKSPACE_DESIGN.md)。
- `.aedt` 上传后需显式运行模型能力检查：在独立副本中检查设计与 Setup，并只读导出模型可操作参数清单（变量、对象材料、边界、风扇和 Setup），可在建单、任务详情及插件设置页查看并下载 JSON。清单中的发现项不代表已验证可修改。发现曲线型原生 Fan 时，再实际执行不求解的 +10% 风扇写入／读回验证，并显示全部目标风扇。只有检查通过才能确认求解；未验证的风扇不得预授权自动候选。其余优化 Skill 仍显示为需对象映射、不可用或仅客户建议。
- 由用户批准的单次风扇候选求解：复用 Baseline 已求解工程和指标，完成逐 Monitor 对比后再次复核。建单时可明确预授权“Baseline FAIL 时自动尝试风扇 +10%”，最多一轮候选；未授权时仍需运行后人工批准。
- 固定 DSH `0.1.5-rc.2` 的本地 Agent Host、持久会话工作区和散热专用 preset。
- “设置 → Icepak 插件”进入时自动依次识别本机 AEDT/PyAEDT、验证独立会话可启动、用安装包内置 `Project1.aedt` 的副本检查工程；可手动重新探测。该自检不求解、不证明许可证可用；指定客户工程和真实求解仍是分开的人工操作。
- Token 保护的 Thermal Tools Bridge，以及任务、Icepak 探测和工程检查工具。
- 六条初始散热优化策略 Skill（导热贴、鳍片、热管/VC、风扇、系统风口、铝改铜）；可在“技能”页新建、修改并保留版本，也可明确要求 DSH Agent 通过对话创建或修改。新建任务与 Agent 均可按需求预筛候选，匹配依据和未验证状态保存到任务快照。系统风口仅为客户建议，所有预期降温幅度均为经验估计。
- 以完成任务证据为来源的可执行流程 Skill 草稿、人工审核、版本记录和 DSH `SKILL.md` 发布/撤回；内置策略不能直接发起 Skill Run 或跳过求解确认。
- Skill Run、步骤证据与失败统计；启用 Skill 可先完成环境/工程检查再创建 Task，连续 3 次失败自动撤回并进入 `NEEDS_REPAIR`。
- 独立 ReportLab PDF 插件：仅对已完成且人工接受的任务生成双语审计报告，并把报告作为 `REPORT` Artifact 关联到选中的 Attempt。App 和已配对的内网 Web 均可查看。
- 每台 App 的持久 Ed25519 节点身份；Core 强制绑定新任务 Owner 并迁移旧 `local-node` 任务。“节点”页可在线下核对公钥后手动登记或撤销信任。SQLite 使用带 epoch 的单活租约和过期栅栏；远程接单默认关闭，用户可显式派单或授权持久自动队列。模拟双/三 App 已验证加密输入传输、真实插件端口上的受管远程 Baseline、结果同步、人工审批 Gate 与租约撤销后改派；真实 Windows 双机仍未验收。
- 用户显式开启 LAN 发布时启动签名 UDP 组播发现（`239.255.43.12:43112`）；未知节点只显示候选，匹配本机信任公钥的节点才更新能力心跳。轻量 Icepak 探测保持保守；显式授权的真实求解成功后才能短时发布按 AEDT 版本限定的 `READY`，磁盘余量也随签名心跳发布。
- 已登记的两台 App 可通过签名挑战应答相互验证公钥身份；该 HTTP 握手只交换身份元数据，不构成加密任务通道，也不会触发自动派单。
- 在此基础上，双方可建立签名临时密钥的短时应用层加密会话；加密通道承载租约续期、Offer、分块输入/结果和状态回执，Artifact 均校验 SHA。浏览器 LAN Web 仍是 HTTP，只宜用于可信内网。

节点私钥保存在 App 数据目录 `identity/node-key.json`（非 Windows 系统权限为 `0600`），公钥指纹同时锚定在 SQLite。备份 App 数据时必须连同私钥一起备份；若密钥丢失或与数据库不一致，Core 会拒绝以新身份接管旧任务。

当前还没有完成 Windows 真实 AEDT 与双机回归验收、基于仿真证据的通用候选策略排序、可执行流程 Skill 的对话式修订和安装包验收。当前策略 Skill 的关键词预筛不是物理诊断结论。自动派单需要用户单独授权，且仅选择已信任、近期 `READY`、版本/容量匹配的节点；模拟通过不等于生产可用。

Windows 安装包构建配置和隔离资源预检已加入；正式构建仍需在 Windows x64 主机准备内置 Node `22.22.x` 或兼容更新版，以及带 PyAEDT、ReportLab、pypdf 的 Python 运行时。预检和插件启动均不依赖用户的 `PYTHONPATH`；Desktop 打包后若缺少内置运行时会拒绝启动。当前已有 macOS 跨平台试包可供 Windows 手动安装测试，但尚未通过 Windows 运行验收。用户已确认 `assets/icepak/Project1.aedt` 可作为公开测试工程随源码提交，并会打入 App 安装包用于环境自检；客户任务仍须上传并检查自己的模型。

## 本地运行

要求 Node.js `^22.19.0` 或 `>=24`、pnpm 11、Python 3 和 uv（安装报告插件依赖及执行其测试）。DSH CLI 使用 `import.meta.main`，Node 22.13 会静默跳过入口，因此不能作为运行环境。

```sh
pnpm install
uv sync --project plugins/report-reportlab
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
THERMAL_REPORT_PLUGIN_ROOT
THERMAL_REPORT_PYTHON
REPORT_FONT_PATH
```

局域网绑定不会默认开启。在本机“设置 → 局域网发布”显式开启后，配对页可访问，但浏览器 API 与 SSE 必须先完成短时码配对；管理 Listener 和查看配对码仍只允许本机。签名发现只发送公开身份与能力元数据，不传工程或任务。可信节点可在授权后接收自动队列，受租约保护地求解并同步结果；当前 Web 仍为受信任内网 HTTP 模式，不应暴露到公网或不可信 Wi-Fi。

在 Windows Icepak 开发机上，可进入“设置 → Icepak 插件”，填写本机 `.aedt` 路径执行工程检查或风扇动作验证。正式建单请从“任务 → 新建任务”填写需求并上传模型：CAD 只形成待建模草稿；`.aedt` 需先检查工程能力，显示每条策略的可执行性与风扇目标，再由用户选择方案并确认。可选择立即启动本机 Baseline，或稍后从任务列表启动。模型以 SHA-256 保存，求解始终在副本上进行。若明确勾选自动风扇二次仿真，且 Baseline 收敛但未达目标，Core 只会自动尝试一次 +10% 风扇参数候选；其他策略目前仅建议，不能自动改模。最终结果仍进入人工复核，用户接受证据后才会完成，拒绝则升级人工处理。

“Agent”页面嵌入本机 DSH 对话。桌面 App 侧栏提供当前工作区的对话记录、新建与归档入口，归档只从 App 侧栏移除记录，DSH 原始对话仍保留；“设置 → DSH 原生设置”可进入模型、API 密钥和预设配置。Agent 会先调用优化方案推荐工具，按需求提示已存策略的适用性和证据缺口，也能在用户明确要求时创建或修改建议型策略 Skill。Agent 根据对话创建的 Task 仍是未确认草稿，可从独立的新建任务页面载入并补齐字段；用户必须上传模型、核对候选方案并决定是否启动求解。关键词预筛不代表已由 Icepak 验证。Agent 工具层不提供直接启动 Baseline 的能力。局域网 Web 不开放 DSH 对话、会话控制或认证 URL。

完成任务只有在存在成功 Attempt，且输入工程、求解工程和结构化结果 Artifact 齐全时，才能沉淀为 Skill 草稿。草稿不会进入 DSH；用户在“技能”页面审核启用后才发布到本机工作区，停用会撤回发布文件。

已完成且人工接受的任务可从“任务”页面生成/查看 PDF。报告分开呈现执行状态、热判定与审批状态，列出 Run/Attempt、温度与收敛证据、任务事件及 Artifact SHA-256；报告本身也会进入 Artifact Store。报告是证据归档，不是工程签字。Windows 运行时需附带 ReportLab/PyPDF 与可嵌入的 CJK 字体（可用 `REPORT_FONT_PATH` 指定）。

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
plugins/report-reportlab/  独立 Python PDF 报告插件
plugins/dsh-thermal/       DSH 散热工具插件
docs/adr/                  架构决策记录
tests/                     跨包集成测试
```
