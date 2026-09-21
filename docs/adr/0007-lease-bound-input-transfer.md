# ADR 0007：按任务租约授权的加密输入传输

- 状态：本机双 App 集成测试通过并已接入持久 Offer 输入暂存；无人值守调度、Windows 双机和外部安全审计待完成
- 日期：2026-09-21

节点互信只证明设备身份，不能授予任意文件读取权限。本阶段在 ADR 0006 的短时加密会话内增加唯一的 `artifact.input.chunk` 操作。Owner 仅在以下条件同时成立时发送 `INPUT_PROJECT` 文件片段：请求节点是 Task 当前租约的 Executor；Task 属于本机 Owner；请求的 Run/Attempt 是最新记录，Attempt 绑定此 Executor 和输入 SHA；Artifact 已显式关联该 Attempt；租约 ID、epoch、期限和信任状态均为当前值。未开放通用 Artifact 读取、目录枚举、Task 快照或结果上传。

每个响应最多 128 KiB，附输入 SHA、总长度、偏移与 EOF。Executor 只写入以 SHA 命名的本地 `.part` 文件，支持按已有长度续传；每块检查连续偏移、长度和元数据，完成后再次请求零长度 EOF 确认当前租约，再计算完整 SHA-256。哈希一致才导入本机内容寻址存储并登记 SQLite；哈希错误删除部分文件。会话过期或网络中断保留部分文件，下次调用重新握手并续传。

这里的“续传”是传输层能力，不代表已能自动派单或断网恢复整个仿真。后续仍需远程 Task/Run/Attempt 提议与接受、租约续期、结果 Manifest/上传、迟到结果栅栏、双机断网实测。浏览器 LAN Web 仍是 HTTP，节点应用层加密不替代 TLS。
