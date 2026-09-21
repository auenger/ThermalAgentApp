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
- Icepak 插件 Manifest、stdio JSON 协议和环境探测骨架。

当前还没有完成 Electron UI、DSH 接入、真实 Icepak 求解迁移和局域网节点调度。这些会在基础契约稳定后逐步接入。

## 本地运行

要求 Node.js 22.13 或更高版本、pnpm 11，以及用于 Icepak 插件开发检查的 Python 3。

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
```

局域网绑定不会默认开启。后续实现设备配对和认证之后，才允许显式绑定非 loopback 地址。

## 目录

```text
apps/core/                 本地业务 API 与后台协调入口
packages/contracts/        跨进程和跨节点契约
packages/domain/           Task 状态机和领域规则
packages/sqlite-store/     SQLite migration 与 Repository
packages/artifact-store/   本地内容寻址文件存储
plugins/icepak-pyaedt/     独立 Python Icepak 插件
docs/adr/                  架构决策记录
tests/                     跨包集成测试
```
