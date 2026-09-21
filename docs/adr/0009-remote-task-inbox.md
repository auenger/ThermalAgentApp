# ADR 0009：默认关闭的远程任务收件箱

- 状态：本机双 App 加密 Offer、Owner 派单与 Executor 输入暂存集成测试通过；远程求解未接线
- 日期：2026-09-21

Executor 不因为设备互信或开启 LAN Web 就自动接受昂贵 Icepak 求解。远程接单开关保存在本机 SQLite，默认关闭，只允许本机 loopback API 开启/关闭。Owner 经加密会话发送 `task.baseline.offer`，Executor 核对发送设备、目标 Node ID、Offer 字段、租约到期时间、本机空闲槽位及 Icepak 插件 `READY`/`baseline_solve`/AEDT 版本；通过后仅写入 `remote_jobs` 持久收件记录，状态为 `OFFERED`。

以 Attempt ID 为幂等键：完全相同的 Offer 重发返回同一记录，字段冲突拒绝。SQLite 事务内再次检查当前活动任务，防止并发 Offer 越过内存空闲检查。未下载并校验输入 SHA、未由 Owner 实际租约授权前，绝不启动插件。收件记录不复制 Owner 的 Task/Run/Attempt 数据库，也不宣称远程业务状态已完成。

“计算节点”页面已呈现本机远程接单开关和收件记录，并提示当前不会启动求解。Owner 可显式派发真实 Task 与租约并对失败投递重发，见 ADR 0010；Executor 的租约输入暂存见 ADR 0011。后续仍需执行插件和同步结果；真正启用求解时还应补充资源/许可证占用提示。
