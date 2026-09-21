# ADR 0015：基于真实求解证据的 Icepak READY 能力证明

## 状态

代码与模拟 Windows 测试已实现；尚无真实 Windows/AEDT/许可证机器上的验证记录。

## 背景

安装路径存在或 AEDT 能启动，不足以证明 Icepak 求解许可证可用。[PyAEDT 官方入门文档](https://aedt.docs.pyansys.com/version/stable/Getting_started/index.html)要求使用有许可证的 AEDT；[AEDT 命令行文档](https://ansyshelp.ansys.com/public/views/secured/electronics/v261/en/subsystems/hfss/content/GettingStarted/RunningANSYSElectronicsDesktopfromacommandline.htm)明确 `-validateonly` 不会求解。因此不能由轻量探测或启动探测直接发布 READY。

此外，插件原先使用完整 OS 描述作为 `platform`，而 Executor 契约要求 `win32`，会导致真实 Windows 节点拒绝接单；现在统一为 Python 的 `sys.platform`。

## 决策

- 轻量插件探测仍只返回 `NOT_INSTALLED`、`NEEDS_CONFIG` 或 `DETECTED`；单独启动 AEDT 最多到 `LAUNCHABLE`，许可证状态保持 `UNKNOWN`。
- 本机用户可在 App 中显式确认“真实求解验证”，指定已有 `.aedt` 工程与版本。Core 创建可审计的诊断 Task，复用受管 Baseline 流程，在副本上求解；未经确认不启动。
- 只有求解报告成功、工程校验通过、solver 正常结束，并且结果工程和结构化结果均与成功 Attempt 关联时，SQLite 才记录版本、插件版本、结果 SHA、来源 Attempt 和验证时间。
- 有效期 30 分钟。Core 仅在 Windows、AEDT/PyAEDT 仍可检测、插件版本未变化、目标 AEDT 版本仍安装且证据 Artifact 仍存在时，把该版本临时发布为 READY。能力心跳、远程接单和执行前检查使用同一有效探测。
- 远程任务完成真实求解后也可刷新能力证明。过期、版本变化或证据丢失自动回退为轻量探测状态。READY 代表“近期有真实成功求解证据”，不是未来许可证可用的绝对保证；每次任务实际求解仍可能因许可证变化失败并向 Owner 报告。

## 已验证

模拟 Windows 插件测试覆盖：无证据时 DETECTED、未授权拒绝、显式诊断 Task 真实求解、成功后 READY、版本仅限已验证版本、30 分钟到期、插件版本变化、非 Windows 降级和 App 重启恢复。Python 插件测试覆盖平台标识与非 Windows 不误报 READY。

## 待验证

- Windows 登录会话、真实 AEDT/PyAEDT 与许可证条件下的诊断 Task 和随后远程 Offer。
- 许可证刚好被其他进程占用、RDP 断开、锁屏、许可证服务器短暂不可达等动态情况。
- 减少大型项目诊断求解成本的标准化小型验证工程及许可证使用策略。
