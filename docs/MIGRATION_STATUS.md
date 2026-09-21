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
- [ ] Lease 和 Peer 网络协议完整定义（已有持久身份、信任登记、能力快照和租约栅栏基础）。
- [x] Skill、Skill Version 和人工审核契约定义。

## 阶段 1：单机桌面闭环

- [x] SQLite 本地数据库、WAL、外键和 busy timeout。
- [x] Task 创建、状态转换、乐观版本和事件审计。
- [x] 基于 SHA-256 的本地 Artifact Store。
- [x] Local Core HTTP API。
- [x] Core 同源发布 React Web。
- [x] Electron 桌面启动入口。
- [x] Desktop 独占 loopback 端口及开发/packaged 资源路径解析。
- [x] Icepak 插件进程健康检查、轻量安装识别，以及本机显式启动/释放独立 AEDT 会话的深度探测。
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
- [ ] Windows 安装包和真实 AEDT 验收（已有 electron-builder NSIS 配置、运行时预检及 Desktop 缺件拒启；尚无 Windows 构建/安装证据）。

## 阶段 2：DSH Agent

- [x] 固定 DSH `0.1.5-rc.2` 并验证真实 Web Host。
- [ ] DSH 随 Windows 安装包的离线打包验证（打包资源与 Node 版本预检已配置，尚无实际安装运行证据）。
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
- [ ] TLS 证书或可信局域网证书方案（节点之间已有独立的短时应用层加密会话，仅开放 ping；浏览器 LAN Web 仍为 HTTP）。
- [ ] Windows 防火墙引导。
- [x] 基于 SSE 的 Task/活跃 Attempt 实时状态流。

## 阶段 4：去中心化计算节点

- [x] 显式 LAN 发布下的签名 UDP 组播节点发现、30 秒时效与重放防护（待 Windows 双机和防火墙验收）。
- [x] 持久节点身份、本机手动信任登记、双向签名身份握手及短时 X25519/AES-GCM 加密 ping 通道；自动配对与 Task/Artifact 数据权限待实现。
- [ ] 可用于自动调度的真实 Icepak 能力心跳（签名 UDP 心跳、持久快照、30 秒新鲜度和负载选择已接通；显式深度探测可证明 `LAUNCHABLE`，但求解许可证、项目兼容性和自动刷新仍未验证，因此不会宣告 `READY` 或容量）。
- [ ] Owner、Executor、Attempt 和 Lease 远程协调（已有 Owner 绑定和原子 Lease/epoch/过期栅栏）。
- [ ] Artifact 分块传输和断点续传。
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
- Windows 进程树终止命令和非 Windows 信号降级。
- 已审批任务 PDF 报告 Gate、Run/Attempt、热证据、事件与 SHA-256 审计、幂等关联和下载；中文嵌入字体及逐页渲染检查。
- 持久 Ed25519 节点身份、API Owner 防伪、旧任务迁移、手动信任/撤销、能力新鲜度与负载筛选、单活租约/epoch 栅栏及分区后的保守升级。
- 签名 UDP beacon 的公钥/指纹、时间窗、nonce 重放和容量验证；真实本机 UDP 收包、可信/未登记/撤销节点区分；LAN 发布启停联动。
- 双向 Ed25519 挑战应答、30 秒时窗与 nonce 防重放、撤销信任后的握手拒绝；此握手仅交换身份元数据，不授予工程/任务传输权限。
- Ed25519 签名临时 X25519 公钥、HKDF 派生双向独立 AES-256-GCM 会话密钥；消息序号、AAD、完整性标签和短时会话过期；双 App 加密 ping 与非授权操作拒绝。此协议尚未经过外部安全审计，不传工程和任务。

GUI smoke 脚本为 `pnpm smoke:gui`。当前无可用桌面会话的执行环境中 Electron 未进入 ready 状态，因此需要在 Windows 或有桌面会话的开发机继续验证。
