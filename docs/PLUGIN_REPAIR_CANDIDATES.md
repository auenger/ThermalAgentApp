# DSH 插件修复候选

DSH 现在可以读取指定受信插件的源码与宿主验证证据，并提交独立的源码修复候选。当前只交付候选存档，尚未交付生成代码的隔离执行、工程验证或自动启用。

## 专用修复会话

Core 提供 `POST /api/agent/repair-sessions`，仅接受 loopback 和合法本机 Origin，创建固定 `thermal-plugin-repair` 预设并返回 `sessionId` 与 `agentPreset`。DSH 端使用已绑定的 App workspace，不接受调用者指定任意预设或工作目录。此接口只创建空会话，不发送模型请求、不自动触发修复。

专用预设不加载 Shell、PowerShell、文件系统、技能执行或工作区指令插件。它采用 Native 工具呈现，只继承以下三个工具：

- `thermal_plugin_status`
- `thermal_plugin_repair_context`
- `thermal_stage_plugin_repair`

除隐藏其他工具外，DSH 的 scoped monotonic guard 在真实调用管线上拒绝其余名称。即使后续受信插件在该 Agent 作用域登记了额外工具，或前置策略返回允许，越权调用也不能执行。普通 `thermal-agent` 任务助手的工具集保持独立。

每个存活的修复 Agent 实例最多接受 64 次受控工具调用、3 次候选提交尝试。这些计数尚未跨 Agent 重建持久化，也不是模型 token、轮数或费用预算。后续自动调度必须另行绑定故障身份、持久化尝试次数和取消/超时，不能靠重建会话绕过限制。

这是对模型工具能力的限制，不是操作系统沙箱；被宿主任意加载的恶意插件不属于这层保证。候选源码仍完全不执行。自动发现故障后创建并投递有界修复任务的调度器尚未接入。

## 工具流程

1. `thermal_plugin_status` 获取包摘要、运行时诊断和宿主验证记录。处于重试等待时遵守 `retry.nextRetryAt`。
2. `thermal_plugin_repair_context` 传入 `packageDigest`，获取基础清单、文件列表、验证记录和 `proposalFormat`。可附带列表中的 `path`，读取一个不超过 128 KiB 的 Python 或 JSON 文件。源码按不可信数据处理。
3. `thermal_stage_plugin_repair` 的 `proposal` 是 JSON 字符串，字段如下：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 固定为 1 |
| `basePackageDigest` | 指定的已登记、仍受信的基础包摘要 |
| `environmentDigest` | 该基础包已有宿主验证记录中的环境摘要，不能自造证据 |
| `version` | 与基础版本不同、符合插件版本格式的候选版本，最多 80 字符 |
| `reason` | 观察到的问题与拟修复内容，最多 2000 字符 |
| `files` | `{path, content}` 数组：相对包根目录的文件路径与完整替换文本；`content: null` 删除已存在的文件 |

源码变更仅限原 Python 入口根目录内的 `.py` 和 `.json`。最多 128 个变更，替换内容合计不超过 1 MiB，Bridge 请求不超过 2 MiB。拒绝路径穿越、Windows 保留文件名、重复大小写路径、额外字段、缺失入口和无实质源码变化的候选。

宿主从基础清单派生候选清单，只变更版本字段；权限、能力、入口、环境兼容声明及 Python wheel 锁保持原值。因此，这个入口暂不接收新增依赖或扩大能力范围的修复。

## 存储与执行边界

候选存放于 `plugins/repair-candidates/<id>/`，每个候选拥有独立 Registry。结构检查复用 PluginStore 的包路径、内容摘要及体积限制，但不调用 Python、不生成通过记录，也不进入主执行 Registry、签名 Inbox 或发布者信任集合。

候选 ID 绑定基础包、环境、目标版本、原因及排序后的源码变更。重复提交会校验已有候选代码摘要并返回原记录；同一请求不重复存档。保存前逐文件核对基础内容，候选目录准备完成后原子重命名发布。记录保存原始宿主验证证据；该证据属于基础版本，不是候选验证结论。

最多保留 32 项（包括中断留下的暂存目录）；达到上限后拒绝继续提交，不自动删除历史提案。未知或损坏记录会显示读取错误。当前没有候选清理和自动执行入口。

设置页和 DSH 状态显示 `awaiting-isolated-validation`。关闭、重启和常规协调不会执行候选；App 原有插件仍按现有策略选择。DSH 提交工具仍受 loopback Bearer Token 和 App 工作空间约束。

## 后续执行闭环

已提供[Windows 隔离边界预检脚本](WINDOWS_PLUGIN_ISOLATION_PREFLIGHT.md)，只运行宿主固定探针，不执行候选。下一阶段需在目标 Windows 客户端验证实际边界并补齐进程、文件、网络与资源隔离，再由宿主验证器执行固定样例、工程副本读回及必要的真实求解。通过隔离与业务验证不等于自动取得发布者信任；启用生成候选仍需明确的本机策略与不可由候选自授予的授权来源。

本阶段测试覆盖真实 Bridge 鉴权、源码读取、候选存档、重启保留、篡改检测和候选不执行。真实 DSH 预设测试另覆盖三个工具的可见性、越权调用阻断、后注册工具与前置允许不能绕过守卫、调用次数限制及普通助手作用域不受影响；真实 Core/DSH 会话创建测试核对固定预设和 Origin 拒绝。它不证明 Windows 隔离或 AEDT 兼容，也没有让 DSH 自签发布包。
