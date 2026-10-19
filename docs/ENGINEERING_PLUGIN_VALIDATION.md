# 工程插件升级验证（首个限定能力配置）

本检查点实现宿主验证流程与可控回归测试，尚未完成真实 Windows/AEDT 验收。它不代表整个 App 已支持无人值守自升级。

默认不启用工程候选自动激活。管理员可在插件主目录放置 `engineering-validation.json`，使用 `schemaVersion: 1`、`profile: "project-parameters-solve-v1"` 与 `allowValidationSolves: true` 显式授权。配置字段由 `apps/core/src/plugin-engineering-validation.ts` 的 `EngineeringValidationPolicy` 定义：

- `fixturePath`、`fixtureSha256`：绝对路径的 `.aedt` 样例及 SHA-256。
- `aedtExecutablePath`、`aedtExecutableSha256`、`aedtVersion`：实际 AEDT 可执行文件及版本；须对应本机 `ANSYSEM_ROOT` 安装。
- `design`、`setup`、`changes`：指定设计、求解设置和参数修改（每项包含 `parameterId`、`value`、`role`）。
- `cores`、`timeoutMs`：1–64 核、每次操作 1 秒至 30 分钟超时，整个验证包含多次操作。
- `tmaxRangeC: {minimum, maximum}`、`maxDeltaC`：样例温度范围与两次求解容差，容差须大于 0 且不超过 5°C。

仅接受 capabilities 恰为 `health`、`environment_probe`、`project_inspect`、`parameter_check`、`baseline_solve` 的受信签名候选。选择此配置意味着接受这一限定能力集；未声明的 CAD、风扇等方法在启动 Python 前被拒绝。当前完整内置包仍保留原有能力，不因本配置自动成为限定能力候选。

宿主复制样例，由候选修改参数；再用 App 随附的不可变参考插件独立打开文件，核对参数写入、其他可编辑参数、风扇目录和对象名称。随后参考与候选分别求解同一冻结文件，检查收敛、温度范围和温差。整个过程持有与普通任务相同的持久化 AEDT 操作锁；忙碌时延后，关闭自动更新或宿主时请求取消。

验证结果绑定包、Python 环境、样例、AEDT 可执行文件、配置及参考插件摘要；证据保留在 `engineering-validations/<id>/evidence.json`，当前未实现自动清理。验证通过不写入任务设计 PASS 或全局 readiness。

此配置是固定样例回归，未覆盖全部几何/原生属性、CAD 导入和风扇专属变更，也不提供操作系统级隔离。DSH 生成的任意代码不能凭这套流程直接成为受信更新。真实客户端验收、完整能力覆盖和独立依赖部署仍需后续实现。
