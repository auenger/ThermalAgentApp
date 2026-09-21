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
- [ ] Lease 和 Peer 协议完整定义。
- [ ] Skill、Skill Version 和 Approval 契约完整定义。

## 阶段 1：单机桌面闭环

- [x] SQLite 本地数据库、WAL、外键和 busy timeout。
- [x] Task 创建、状态转换、乐观版本和事件审计。
- [x] 基于 SHA-256 的本地 Artifact Store。
- [x] Local Core HTTP API。
- [x] Core 同源发布 React Web。
- [x] Electron 桌面启动入口。
- [x] Icepak 插件进程健康检查和保守环境探测。
- [x] 从旧项目迁移通用 AEDT 工程检查逻辑。
- [x] 从旧项目迁移 Baseline PyAEDT 求解代码路径（待 Windows 真实回归）。
- [x] 从旧项目迁移温度 Monitor、原生残差和收敛证据采集（待 Windows 真实回归）。
- [x] 从旧项目迁移风扇动作、写后回读及候选求解代码路径（待任务协调器接入）。
- [ ] 求解子进程 heartbeat、取消和恢复。
- [ ] Artifact 与 Task/Run/Attempt 关联。
- [ ] PDF 报告迁移。
- [ ] Windows 安装包和真实 AEDT 验收。

## 阶段 2：DSH Agent

- [ ] 固定 DSH 版本并完成打包验证。
- [ ] DSH Host 与 Session Adapter。
- [ ] Thermal Tools Bridge。
- [ ] 自然语言需求收集。
- [ ] 人工确认 Gate。
- [ ] Skill 草稿、审核、启用和运行记录。

## 阶段 3：局域网 Web

- [x] Web 与 Electron 共用 Core API 和 React 构建产物。
- [x] Core 默认只允许 loopback 监听。
- [ ] 本地用户认证和会话。
- [ ] 用户显式开启 LAN 发布。
- [ ] 设备配对和访问权限。
- [ ] Windows 防火墙引导。
- [ ] 实时任务进度。

## 阶段 4：去中心化计算节点

- [ ] mDNS/UDP 节点发现。
- [ ] 节点身份和配对。
- [ ] 能力与负载心跳。
- [ ] Owner、Executor、Attempt 和 Lease。
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
- Web 构建及 Core 静态发布。
- Icepak 插件协议和非 Windows 环境探测。
- AEDT 工程副本隔离、工程元数据、能力配置校验。
- 曲线风扇相似定律缩放、更新和写后回读验证。
- Baseline/风扇候选求解、摄氏温度标准化及逐 Monitor 对比。
- 原生残差、Monitor 稳定性、反向流和求解正常结束证据解析。
- Core 为 Icepak 操作分配运行目录并通过插件端口调用。

GUI smoke 脚本为 `pnpm smoke:gui`。当前无可用桌面会话的执行环境中 Electron 未进入 ready 状态，因此需要在 Windows 或有桌面会话的开发机继续验证。
