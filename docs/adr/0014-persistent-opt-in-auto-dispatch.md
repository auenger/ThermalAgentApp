# ADR 0014：需显式授权的持久自动派单

## 状态

模拟多 App 的等待、重启恢复、空闲节点自动选择和改派已实现；真实 Windows Icepak 能力心跳仍待验收。

## 决策

- Task 的 `READY` 只表示需求已确认，不自动消耗求解许可证。用户需在本机单独授权一次自动 Baseline 派单；LAN 浏览器不能偷偷开启自动派单。
- 授权时将原始 `.aedt` 导入内容寻址 Artifact Store，固定输入 SHA 和有限的求解参数，并在 SQLite `auto_dispatch_requests` 保存 `WAITING` 意图和审计事件。等待期间 Task 保持 READY，但界面明确显示“等待兼容空闲节点”；用户可在尚未创建 Run 前撤销。
- 后台按任务创建顺序扫描等待意图，仅从新鲜、可信、READY、AEDT 版本兼容且未满载的发现节点中选择 Executor。派单仍走既有 Run/Attempt、租约、加密 Offer 与求解协议。
- 若已准备的 Offer 未送达，保留同一 Attempt 和输入快照，后台重试。若节点在启动前失去租约且另有兼容空闲节点，则把旧 Attempt 记为 CANCELLED、在同一 Run 下建立新 Attempt 后改派；旧租约和旧 epoch 无法写入结果。
- 最多保留三个 Executor Attempt；继续改派前若已达上限，事务化关闭最新 Attempt/Run，把 Task 升级为 ESCALATED，要求人工检查。
- App 重启后从 SQLite 恢复等待意图，不依赖内存队列。手动本机/远程 Baseline 与等待中的自动派单互斥，避免双重求解。

## 已验证

双 App 测试覆盖：READY 不自动执行、无节点持续等待、授权快照后源工程变化、Owner 重启恢复、空闲节点出现后自动求解、撤销未派发意图。三 App 测试覆盖首节点拒绝 Offer、撤销信任和租约、第二空闲节点接手，同一 Run 下旧 Attempt 取消、新 Attempt 成功。

## 未完成

- 真实 Windows READY/许可证心跳和双机/多机验收；模拟 READY 不能视为生产能力证明。
- 多节点评分中的磁盘/内存/网络成本，以及同一节点 Offer 长期失败时的退避与人工升级策略。
- 任务 Owner 更换、应用版本不兼容和大工程传输空间预留。
