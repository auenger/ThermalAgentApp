# 迁移状态

更新日期：2026-09-21

本文件记录从 `suzhousanre` 向 Thermal Agent App 的实际迁移进度。只有已经存在代码和验证证据的项目才能标记完成。

## 阶段 0：契约和架构边界

- [x] 新项目和 pnpm workspace。
- [x] 本地优先、多进程边界 ADR。
- [x] Task Owner 与远程 Executor ADR。
- [x] 执行状态、热判定和审批状态分离。
- [x] Icepak 插件 Manifest 和版本化 RPC 契约。
- [x] Run 与 Attempt 本地执行契约、状态、心跳和结果选择。
- [ ] Lease 和 Peer 网络协议完整定义（身份、信任、租约、输入/结果、远程 Baseline、自动派单和签名心跳的可用磁盘声明已有实现；版本协商、正式协议安全审计未完成）。
- [x] Skill、Skill Version 和人工审核契约定义。

## 阶段 1：单机桌面闭环

- [x] SQLite 本地数据库、WAL、外键和 busy timeout。
- [x] Task 创建、状态转换、乐观版本和事件审计。
- [x] 基于 SHA-256 的本地 Artifact Store。
- [x] Local Core HTTP API。
- [x] Core 同源发布 React Web。
- [x] Electron 桌面启动入口。
- [x] Electron 单实例与托盘后台生命周期：关闭窗口不退出 App 或终止 Core，托盘可重新打开工作台并显式退出；Core 异常退出后最多 3 次退避重启并刷新 UI（待 Windows 桌面实测，锁屏/RDP 场景仍未验证）。
- [x] Desktop 独占 loopback 端口及开发/packaged 资源路径解析。
- [x] Icepak 插件进程健康检查、轻量安装识别、本机显式启动/释放独立 AEDT 会话，以及经用户单独授权的真实求解能力验证入口。
- [x] 从旧项目迁移通用 AEDT 工程检查逻辑。
- [x] 从旧项目迁移 Baseline PyAEDT 求解代码路径（待 Windows 真实回归）。
- [x] 从旧项目迁移温度 Monitor、原生残差和收敛证据采集（待 Windows 真实回归）。
- [x] 从旧项目迁移风扇动作、写后回读及一次受审批的候选求解协调。
- [x] 本地求解 Attempt heartbeat、用户取消和 Core 重启中断识别。
- [x] Windows 进程树强制终止（`taskkill /T /F`，待真实 AEDT 回归）。
- [x] 失败/取消 Run 的显式可恢复重试，复用输入 Artifact 且最多 3 次 Attempt。
- [x] 输入、求解工程、结果 JSON 和收敛证据与 Attempt 关联。
- [x] 校验/收敛/目标温度的确定性热判定和人工结果审批 Gate。
- [x] ReportLab PDF 插件、已审批任务的报告生成/下载、Artifact 关联与中英文字体/渲染验收（待 Windows 离线打包和真实工程报告复核）。
- [ ] Windows 安装包和真实 AEDT 验收（已有 electron-builder NSIS 配置、内置 Node 的 DSH 冒烟、隔离 Python 依赖来源与 x64 预检、`afterPack` 二次检查及 Desktop 缺件拒启；运行时插件也不继承用户 `PYTHONPATH`；尚无 Windows 构建/安装证据）。

## 阶段 2：DSH Agent

- [x] 固定 DSH `0.1.5-rc.2` 并验证真实 Web Host。
- [ ] DSH 随 Windows 安装包的离线打包验证（内置 Node 的 DSH 冒烟及 `afterPack` CLI 语法检查已配置，尚无实际安装运行证据）。
- [x] DSH Host、认证 URL、工作区和原生 Session 持久化接入。
- [x] Loopback + Bearer Token 的 Thermal Tools Bridge。
- [x] 自然语言创建 Task 草稿、读取任务、环境探测和工程检查工具。
- [x] 人工确认 Gate：DSH 不暴露启动 Baseline 或发布 Skill 的工具。
- [x] 从已完成且证据完整的任务生成幂等 Skill 草稿。
- [x] Skill 版本、来源、人工审核、启用及 DSH 发布/撤回。
- [x] Skill Run、步骤断点、成功/失败统计和连续失败 `NEEDS_REPAIR` 自动撤回。
- [ ] `NEEDS_REPAIR` 的 Agent 修订、沙箱验证和人工发布新版本。

## 阶段 3：局域网 Web

- [x] Web 与 Electron 共用 Core API 和 React 构建产物。
- [x] Core 默认只允许 loopback 监听。
- [x] LAN 浏览器短时配对和 HttpOnly、SameSite 会话。
- [x] 用户从本机 App 显式开启/停止独立 LAN Listener。
- [x] 未配对 API/SSE 拒绝、写操作同源校验和配对失败限流。
- [x] 持久 Ed25519 设备身份、本机手动信任登记与撤销；旧版 Owner 迁移。
- [ ] 双向配对、网络挑战签名、细粒度访问权限（已加入可信节点间双向 Ed25519 挑战应答及本机显式验证；首次信任仍需线下核对，权限分级未完成）。
- [ ] TLS 证书或可信局域网证书方案（节点之间已有独立的短时应用层加密会话和租约授权输入读取；浏览器 LAN Web 仍为 HTTP）。
- [ ] Windows 防火墙引导。
- [x] 基于 SSE 的 Task/活跃 Attempt 实时状态流。

## 阶段 4：去中心化计算节点

- [x] 显式 LAN 发布下的签名 UDP 组播节点发现、30 秒时效与重放防护（待 Windows 双机和防火墙验收）。
- [x] 持久节点身份、本机手动信任登记、双向签名身份握手及短时 X25519/AES-GCM 加密通道；加密 ping、Offer、租约续期与当前租约授权的输入下载、结果上传原语已验证，自动配对待实现。
- [ ] 可用于生产自动调度的真实 Icepak 能力心跳（签名 UDP 心跳、持久快照、30 秒新鲜度和负载选择已接通；显式真实 Baseline 成功后可签发 30 分钟的版本限定 READY 证明，过期自动降级，并供接单/执行前统一校验；尚无真实 Windows/AEDT/许可证双机验收，不能视为生产可用）。
- [ ] Owner、Executor、Attempt 和 Lease 远程协调（显式派单及经用户授权的持久自动队列，已在模拟双/三 App 中验证等待、重启恢复、空闲节点选择、租约失效后改派、受管求解和 Owner 审批 Gate；Executor 中断求解后的持久失败通知与幂等重发已有模拟验证，真实 Windows 双机时效与人工重试策略待完成）。
- [ ] Artifact 分块传输和断点续传（输入与结果已接入远程 Baseline 流程，并验证部分文件恢复和 SHA；签名心跳发布磁盘余量供 Owner 提前筛选，Executor 接单前重新检查，尚非空间预留；限速、真实大工程与 Windows 双机验证待完成）。
- [ ] 网络分区、租约超时和迟到结果处理。

## 当前验证命令

```sh
pnpm typecheck
pnpm test
pnpm dev:core
```

当前自动化覆盖：

- Task 领域状态机。
- Run/Attempt 持久化、状态约束、heartbeat 和选中结果。
- SQLite 重启恢复、事件审计和版本冲突。
- Artifact SHA 去重和路径约束。
- Core API 创建和转换 Task。
- Core SSE 初始快照、连接关闭和任务状态推送。
- LAN 默认关闭、本机管理、短时码配对、会话 Cookie、限流与同源写保护。
- Web 构建及 Core 静态发布。
- Icepak 插件协议和非 Windows 环境探测。
- AEDT 工程副本隔离、工程元数据、能力配置校验。
- 曲线风扇相似定律缩放、更新和写后回读验证。
- Baseline/风扇候选求解、摄氏温度标准化及逐 Monitor 对比。
- 原生残差、Monitor 稳定性、反向流和求解正常结束证据解析。
- Core 为 Icepak 操作分配运行目录并通过插件端口调用。
- Baseline 后台执行、输入快照、进度 heartbeat、取消和结果回收。
- Baseline 失败后的显式重试、不可变输入复用和 Attempt 上限。
- DSH preset 解析、Host 启停/重启和一次性 token 认证页面。
- DSH Agent 实例暴露受控散热工具，包括只读查询已审核 Skill。
- Thermal Tools Bridge 鉴权、Task 草稿和 Icepak 只读操作。
- Skill 草稿证据门槛、幂等提取、并发审核和发布文件权限边界。
- Skill 驱动 Task、环境/工程前置检查、步骤证据和连续失败自动撤回。
- Electron 开发与 `app.asar`/unpacked 资源路径分离。
- Electron 托盘图标 PNG 结构、单实例启动与关窗留后台代码路径已实现；实际系统托盘和后台真实 Icepak 求解仍待 Windows GUI 验收。
- Windows 进程树终止命令和非 Windows 信号降级。
- 已审批任务 PDF 报告 Gate、Run/Attempt、热证据、事件与 SHA-256 审计、幂等关联和下载；中文嵌入字体及逐页渲染检查。
- 持久 Ed25519 节点身份、API Owner 防伪、旧任务迁移、手动信任/撤销、能力新鲜度与负载筛选、单活租约/epoch 栅栏及分区后的保守升级。
- 签名 UDP beacon 的公钥/指纹、时间窗、nonce 重放和容量验证；真实本机 UDP 收包、可信/未登记/撤销节点区分；LAN 发布启停联动。
- 双向 Ed25519 挑战应答、30 秒时窗与 nonce 防重放、撤销信任后的握手拒绝；此握手仅交换身份元数据，不授予工程/任务传输权限。
- Ed25519 签名临时 X25519 公钥、HKDF 派生双向独立 AES-256-GCM 会话密钥；消息序号、AAD、完整性标签和短时会话过期；双 App 加密 ping 与非授权操作拒绝。现已开放受当前租约约束的输入、结果、Offer、续租和 Baseline 状态操作；协议尚未经过外部安全审计。
- 双 App 加密输入下载：绑定 Owner、Executor、最新 Run/Attempt、当前 Lease/epoch 和 `INPUT_PROJECT` SHA；128 KiB 分块、部分文件续传、最终 SHA 校验及错误部分文件清理。测试覆盖错误执行节点、错误 SHA、旧 epoch、撤销信任和损坏续传文件；尚未接入自动调度。
- Executor 通过加密会话每 20 秒续租，Owner 核验设备身份、Task Owner、Lease/epoch、最新 Run/Attempt 及非终止状态。测试覆盖错误节点、旧 epoch、终止 Attempt 与撤销信任；真实长时间 Windows 求解仍待验收。
- Executor 远程接单默认关闭，可经本机“计算节点”页或 API 显式开启；可信 Owner 的加密 Baseline Offer 需通过本机 Icepak READY/能力/版本、空闲槽位与目标节点校验，SQLite 按 Attempt 幂等保存并展示收件记录。
- Owner 可通过本机 Task API/UI 从签名发现的 READY 空闲节点中显式派发 Baseline：输入快照、Run/Attempt/Artifact/QUEUED 原子准备、租约领取、加密 Offer、失败重发及未执行旧租约的 epoch 更新均有双 App 测试。
- Executor 收到 Offer 后会在可信 Owner 被发现时自动续租并拉取输入，支持中断续传和完整 SHA 校验；`remote_jobs` 用 Lease ID/epoch 栅栏进入 `INPUT_READY`。测试覆盖租约过期后新 epoch 再验输入。
- Executor 到 Owner 的结果分块上传已接入远程 Baseline：加密会话、定期续租、可恢复部分文件、最终 SHA 校验、当前 Lease/epoch 与最新 Attempt 校验、SQLite 原子关联及重复确认。双 App 测试覆盖损坏文件、错误节点/epoch、终止 Attempt 和部分块恢复。
- 默认启用的远程执行处理器已接通 `INPUT_READY → RUNNING → SYNCING_RESULTS → COMPLETED`：调用受管 Icepak 插件，持久化结果 SHA，Owner 校验必要证据并原子完成 Attempt/Run、请求人工审批及释放租约。模拟双 App 端到端测试通过；真实 Windows READY/许可证和双机验收仍缺，不能宣称生产可用。
- Executor 重启时把中断的 RUNNING 远程 Job 持久标记 FAILED 并通知 Owner；失败回执在响应丢失后可重发，同一错误只确认当前最新 Run/Attempt 与原租约，旧租约不能污染后续 Attempt。通知不受新接单开关影响，5 分钟后停止重试，Owner 租约到期仍是最终兜底。已有 SQLite 重启和模拟通道测试；真实 Windows 故障时效未验证。
- 自动派单需用户在本机单独授权；SQLite 持久保存待派发意图、输入 SHA 和求解参数。模拟测试覆盖无节点等待、Owner 重启、源文件变化不影响快照、授权撤销、空闲节点自动接单，以及首节点租约被撤销后的跨节点改派。真实 Windows 多机验收未完成，因此生产环境尚不能依赖自动调度。
- Icepak 插件现用 `win32` 平台契约；Core 不从安装或 AEDT 启动推断求解 READY。用户明确授权的诊断 Baseline 成功且证据完整后，SQLite 记录版本/插件/结果 SHA 与时间，Core 最多 30 分钟发布对应版本的 READY，并在版本变化、过期和非 Windows 时降级。模拟测试已通过，真实许可证占用情况仍需 Windows 验收。
- 远程 Baseline Offer 必须明确指定已验证的 AEDT 版本；Executor 在首次接单前使用当前文件系统剩余容量做保守预检（输入大小的 4 倍加 512 MiB 余量）。这是拒绝明显不足空间的早期保护，不是磁盘预留，求解期间空间变化与大型结果仍需实际验收。
- 新版节点在签名 UDP 心跳中发布本机可用磁盘字节数并写入可信节点快照；Owner 自动派单与手动派单在发 Offer 前使用相同阈值过滤。旧版节点未声明该字段时仍允许协议兼容，但 Executor 接单预检是最终保护。模拟测试覆盖空间不足时等待、不消耗 Run/Lease，以及后续容量恢复时继续派单。

GUI smoke 脚本为 `pnpm smoke:gui`。当前无可用桌面会话的执行环境中 Electron 未进入 ready 状态，因此需要在 Windows 或有桌面会话的开发机继续验证。
