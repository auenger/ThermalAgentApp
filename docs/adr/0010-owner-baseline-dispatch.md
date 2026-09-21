# ADR 0010：Owner 远程 Baseline 派单与 Offer 重发

- 状态：本机双 App 集成测试通过；Executor 输入下载/求解和 Windows 双机验收待完成
- 日期：2026-09-21

用户在本机 App 对 READY Task 显式选择“派发到空闲节点”。Core 仅从签名发现且可信、心跳新鲜、Icepak `READY`、版本兼容且有空闲容量的节点中选择 Executor。派单工程路径必须与 Task 已确认需求快照一致；若有工程检查 SHA，字节快照也必须一致。工程文件先进入本机内容寻址存储；SQLite 在一个事务中创建 Baseline Run、QUEUED Attempt、`INPUT_PROJECT` 关联并将 Task 置为 QUEUED。之后 Owner 领取 60 秒单活租约，通过短时加密会话发送 ADR 0009 的 Offer。

网络投递失败、对方拒收或响应丢失时，API 明确返回 `delivered: false`，不创建第二个 Run/Attempt。本机可通过 `retry-offer` 对 QUEUED/LEASED 的同一 Attempt 重发；Executor 按 Attempt ID 幂等接收。如果原租约在尚未执行时过期，Owner 可用更高 epoch 对同一待处理 Attempt 再领取租约；Executor 仅在收件状态仍为 `OFFERED` 时替换租约，旧 epoch 不能覆盖新租约。一旦进入传输/运行状态，改派必须使用新的 Attempt，不可复用旧执行身份。

该阶段完成的是派单与持久接单，不是自动执行。Executor 仍需验证 Owner 当前租约、拉取输入并核验 SHA，再启动插件和按周期续租；输出/证据 Manifest、结果同步和 Owner 最终判定也尚未完成。Task 页面当前提供用户发起的空闲节点选择，真正无需点击的排队自动调度仍待实现。
