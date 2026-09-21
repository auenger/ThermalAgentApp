# ADR 0008：Executor 发起的加密租约续期

- 状态：本机双 App 集成测试通过；自动续期循环、远程执行与 Windows 双机验收待完成
- 日期：2026-09-21

Icepak 求解可能持续几十分钟，Executor 必须能够在 Owner 上延长当前租约。新增加密操作 `lease.renew`，只接受已互信节点的设备身份及租约 ID、epoch；续期时 Owner 再检查 Task 归本机所有、租约当前且未过期、请求节点正是 Executor、最新 Run/Attempt 仍归该节点且 Attempt 未终止。续期时长固定 60 秒，由 Owner 决定，Executor 不能要求任意 TTL。响应只返回租约 ID、epoch、到期时间及 TTL，不暴露 Task/工程内容。

此操作只是远程执行协议的一项原语。后续 Executor 需要在长时间求解期间按更短周期自动续租；续租失败时停止本地执行并保留证据，不能继续向 Owner 提交为有效结果。Owner 仍以 Lease epoch 栅栏拒绝迟到或旧节点结果。
