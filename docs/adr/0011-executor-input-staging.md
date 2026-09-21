# ADR 0011：Executor 自动拉取并校验租约输入

- 状态：本机双 App 集成测试通过；Windows 双机、真实 AEDT 与后续求解/结果同步待验证
- 日期：2026-09-21

Executor 接受 Baseline Offer 后，后台输入处理器从持久 `remote_jobs` 扫描 `OFFERED`/`TRANSFERRING` 记录。只有重新发现并信任 Owner 时才开始；先通过加密通道向 Owner 续租，再按 ADR 0007 的任务/Attempt/Lease/SHA 授权分块拉取。下载过程中每 20 秒尝试续租，失败则停止继续请求；局部文件保留供断点续传。完整 SHA-256 验证和本机 Artifact 登记成功后，收件状态才变为 `INPUT_READY`。

`remote_jobs` 的状态变更必须同时匹配 Attempt ID、当前 Lease ID 和 epoch。旧租约下载完成不能把新租约的任务误标为输入就绪。网络故障记录错误并延迟重试；损坏的哈希/分块等不可接受证据转为 `FAILED`。App 重启后处理器继续扫描持久收件箱。尚未执行的 `INPUT_READY` 在租约过期后可以接收更高 epoch 的 Offer，重新进入 `OFFERED` 并由 Owner 再次确认输入；已运行的任务不能复用旧 Attempt。

此处只是输入暂存。当前不启动 Icepak 插件、不产生求解结果，也不把 Owner Task 推进到 RUNNING；租约不会在 `INPUT_READY` 阶段无限续期。后续需要实现受管求解、持续续租、进度上报、输出/证据 Manifest 和结果同步，才可形成跨机仿真闭环。
