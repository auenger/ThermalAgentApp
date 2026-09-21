# ADR 0013：远程 Baseline 执行与 Owner 结果确认

## 状态

协议及模拟双 App 闭环已实现；真实 Windows AEDT 双机验收、自动排队调度与失败恢复仍未完成。

## 决策

- Executor 默认不接单，需用户在本机开启远程执行；收到可信 Owner 的 Offer 后，先下载并校验输入工程，再重新探测 Icepak READY/许可证。
- 求解前通过加密消息让 Owner 将当前租约对应的最新 Baseline Attempt/Task 转入 RUNNING。插件运行期间每 20 秒续租；续租失败则取消受管插件进程。
- 插件产物先进入 Executor 的内容寻址 Artifact Store，SHA 持久记录在 `remote_jobs`，然后分块上传。`SYNCING_RESULTS` 可在 App 重启后继续上传；`RUNNING` 不自动重跑，以免重复占用许可证。
- Owner 仅接受当前租约、当前最新 Run/Attempt 的完成请求。完成前核对输入 SHA、Baseline 结果类型、必要 Artifact 角色、文件大小和 SHA；在一个 SQLite 事务内设置 Attempt SUCCEEDED、Run 选中结果、Task 热判定与人工审批 Gate，并释放租约。
- 完成确认可幂等重发，以应对 Owner 已提交但 Executor 未收到响应的情况。插件执行失败由 Executor 主动上报，Owner 把 Attempt/Run/Task 标记失败并释放租约。
- Owner 重启时不能把远程 Executor 的 RUNNING Attempt 当作本机插件中断；本机恢复逻辑只处理本机执行的 Attempt。
- 若正在运行的远程租约过期或设备被撤销，Owner 同一事务把 Task 升级为 ESCALATED、Attempt 记为 INTERRUPTED、Run 记为 FAILED，避免留下永久 RUNNING 的孤儿记录。

## 已验证

模拟双 App 测试覆盖派单、输入暂存、受管插件调用、结果与收敛文件回传、Owner 校验、PASS 判定、人工审批 Gate、租约释放和插件失败回报；另覆盖错误 epoch、证据缺失、同大小文件损坏、重复完成、迟到上传拒绝及租约过期后的状态收敛。

## 未完成

- 真实 Windows + AEDT/PyAEDT + 许可证环境的双机验收，特别是锁屏、RDP 断开、求解超时、取消和进程回收。
- Windows 环境的可信 READY 心跳；当前真实探测不宣称 READY，模拟测试的 READY 不能替代生产验收。
- Executor 在 RUNNING 期间崩溃后的即时失败通知与人工重试策略；目前 Owner 在租约到期后收敛为 ESCALATED/INTERRUPTED/FAILED。
- 自动空闲节点调度、节点配对、传输空间预留/限速、浏览器 LAN HTTPS。
