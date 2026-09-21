# ADR 0001：本地优先与进程边界

- 状态：已接受
- 日期：2026-09-21

## 决策

产品采用 Electron 桌面壳、本地 Core、DSH Host 和 Python Icepak Plugin 多进程结构。SQLite 与 Artifact Store 由 Core 统一管理。DSH 和 Icepak Plugin 只能通过强类型协议调用 Core，不得直接写数据库。

Electron 和局域网 Web 使用同一套页面和 Core API。Core 默认仅监听 loopback；局域网发布必须在设备认证完成后显式启用。

## 原因

Icepak 求解耗时长、依赖 AEDT/PyAEDT 和许可证，必须与 UI 和 Agent 进程隔离。单进程设计会让 AEDT 崩溃、DSH 重启或 UI 关闭影响真实求解和数据一致性。

## 后果

- 安装包需要携带 Node/Electron、DSH 和兼容的 Python 插件运行环境。
- 跨进程契约必须版本化。
- Core 必须支持异常退出后的状态恢复。
