# ADR 0012：租约约束的远程结果回传

## 状态

已实现传输原语；远程 Icepak 执行与结果判定尚未接入。

## 决策

- Executor 通过已认证、加密的 Peer 会话向 Task Owner 上传结果；不暴露任意文件写入 API。
- 每个请求绑定 `taskId`、`attemptId`、`leaseId`、`epoch`、SHA-256、大小和结果角色。仅当前最新 Run/Attempt、可信 Executor、有效租约且非终止 Attempt 可写入。
- 允许的角色限于 `SOLVED_PROJECT`、`SOLVER_RESULT`、`CONVERGENCE_EVIDENCE` 和 `LOG`。128 KiB 分块写入 App 自有临时目录，重复块须与已有字节一致；进程重启后可从部分文件继续。
- 收到完整文件后验证 SHA-256，再导入内容寻址 Artifact Store。SQLite 在一个事务内重新检查租约与最新 Attempt，写入 Artifact 元数据及 Attempt 关联；同一角色不得指向不同 SHA。
- 已完成的同 SHA 上传可以重复确认。租约过期、节点撤销、Attempt 终止或被新 Attempt 取代后，不再接受上传。无效或迟到的文件即使已进入内容寻址存储，也不能关联为当前结果。
- 上传过程定期请求续租；Owner 不因单个文件收到就将 Attempt 标记为成功。

## 未完成

- Executor 从 `INPUT_READY` 启动受管 Icepak，持续续租和上报进度。
- 结果 Manifest、必要证据集合与结构化 `SOLVER_RESULT` 校验；全部通过后再原子完成 Attempt/Task。
- 大文件传输限速、空间预留、临时文件清理和 Windows 双机验收。
