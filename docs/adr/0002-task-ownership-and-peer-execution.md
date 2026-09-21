# ADR 0002：任务所有权与远程执行

- 状态：已接受
- 日期：2026-09-21

## 决策

每个 Task 永远只有一个 Owner 节点作为事实源。具有 Icepak 能力的其他节点可以作为 Executor，通过带过期时间的租约执行某个 Attempt。节点之间同步契约、事件和 Artifact，不复制或合并 SQLite 数据库。

## 原因

SQLite 适合单机事务，不适合多主复制。真实 Icepak 求解成本高，必须通过租约、Attempt 幂等和 Artifact SHA 防止重复执行和迟到结果覆盖。

## 后果

- Owner 离线时 Executor 保存进度和结果，恢复连接后再同步。
- 租约到期前不能把同一 Attempt 分配给其他节点。
- 迟到结果只能保存为历史证据，不能覆盖当前有效 Attempt。
