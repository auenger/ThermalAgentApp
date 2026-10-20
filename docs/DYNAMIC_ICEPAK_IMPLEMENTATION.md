# 动态 Icepak 执行：实现记录与能力盘点

更新时间：2026-10-20。对应目标：[实施计划](DYNAMIC_ICEPAK_SCRIPT_PLAN.md)。

## 现有能力盘点

| 业务环节 | 当前实现位置 | 迁移或复用方式 |
| --- | --- | --- |
| 工程检查和对象清单 | Python `project.py` 的 `_project_metadata`、`_parameter_catalog` | 复用，为动态脚本提供真实对象上下文 |
| 固定 fan 通道操作 | Python `project.py` 的 `apply_fan_speed_ratio` | 保留兼容入口，后续提取为可复用脚本，动态入口不依赖该方法 |
| 参数发现和固定修改适配器 | Python `parameters.py`、`parameter_registry.py` | 保留已验证操作，未知操作转动态脚本流程 |
| 参数方案编排 | Core `parameter-plans.ts` | 依赖完成的 baseline 和固定参数契约；新增动态任务编排，避免将新能力限定在既有参数列表 |
| 求解、指标和收敛证据 | Python `project.py`、`metrics.py`、`convergence.py` | 复用真实求解与证据读取，不以脚本自报替代求解结果 |
| CAD 导入与模型准备 | Python `cad.py`、`model_preparation.py`、`model_validation.py` | 已在插件内，保留现有契约；按需求补充脚本扩展 |
| Python RPC 和超时取消 | Core `icepak-plugin-client.ts`、Python `managed.py` | 动态入口复用执行租约、受管进程、超时与取消 |
| 工程操作独占锁 | Core `icepak-operation-lock.ts` | `executeScript` 已纳入同一锁，含固定版本租约调用 |
| DSH 修复候选 | `plugin-repair-candidates.ts`、DSH 专用修复工具 | 不复用为仿真脚本执行接口；用途和信任状态分开 |
| 报告生成 | `report-reportlab` 插件 | 已插件化，不需要为动态脚本重写 |

宿主继续负责工程、任务、授权和资源生命周期；具体仿真操作逐步由 Python 插件及本地脚本表达。

## 第一批实现：内部动态执行协议

Icepak 插件版本更新为 `0.3.0`，新增 `dynamic_script` 能力及 `execute_script` RPC。Core 通过 `IcepakPluginPort.executeScript` 调用；未声明该能力的历史插件会在启动执行前被拒绝。

输入见 `packages/contracts/src/dynamic-scripts.ts`：

- `source`、`scriptSha256`：UTF-8 Python 源码及其 SHA256，最多 128 KiB。
- `parameters`：JSON 对象，拒绝非有限数字，最多 1 MiB。
- `projectPath`、`projectSha256`：输入工程与预期摘要，复制前及复制后核对。
- `outputDir`：Core 为每次任务生成的全新运行目录，已存在目录拒绝复用。
- `version`、可选 `design`：明确指定 AEDT 环境和设计。

Python 脚本入口为：

```python
def apply(ipk, parameters):
    # 使用真实工程对象和 PyAEDT 接口进行操作。
    return {"operation": "description"}

def verify(ipk, parameters):
    # 对已保存并重新打开的工程读回，比较实际值与目标值。
    return {"passed": True, "checks": [{"actual": "read from project"}]}
```

上述片段仅说明签名，不是可直接用于工程验收的检查实现。`verify` 需要返回真实读回数据；目前结果明确标记为脚本报告的检查，而非独立宿主验证。

执行顺序：核对输入 → 创建工程副本 → 动态加载源码 → 独立 AEDT 会话 → `apply` → 保存到 verified 目录 → 关闭并重新打开 → `verify` → 关闭会话。参数分别复制给两个入口，避免 `apply` 修改目标参数后影响验证。

每次运行保存源码、参数、脚本日志和 `execution.json`。报告区分 `scriptExecuted` 与 `persistedReadback`，记录脚本及工程摘要。异常记录错误类别；保存失败、读回不符或清理失败均不报告成功。硬终止时报告可能停留在 running，后续 Core 任务恢复须将其识别为中断。

该入口不主动调用求解，`solve` 仅记录 `hostRequested: false, status: not-verified`。动态 Python 本身具有当前执行进程权限，可能调用其他 API；这不是 Python 沙箱，工程副本也不构成文件系统访问限制。HTTP、DSH 及任务入口的后续接入见第三批实现。

## 当前验证

- 新增 Python 生命周期测试：以可保存和重新读取的替身工程，验证非 fan 的热源参数修改、源工程不变、摘要不符拒绝、旧运行目录拒绝、保存失败、读回失败、脚本异常、缺少入口和 RPC 错误类别。
- Core 操作锁测试加入动态执行冲突检查；能力检查测试加入历史插件拒绝动态调用。
- 本地测试不提供真实 Windows/AEDT 证据，替身运行报告明确标记 `test-double`。

## 第二批实现：脚本库与内部任务编排

新增 `DynamicScriptLibrary`，使用本机 SQLite 保存不可变脚本版本与运行记录。脚本身份同时绑定源码、参数定义及适用条件；相同内容重复登记返回同一版本，变更保留旧版。支持名称/描述/标签检索、停用、参数默认值、必填、类型、数值范围与枚举检查。

运行记录关联任务、脚本版本、输入工程摘要、实际参数、AEDT 版本及固定的插件运行身份。终态不能被后续结果覆盖。提供中断恢复入口，但调用者必须先确认独占 Core 所有权并处理前次工程进程，不能在打开数据库时直接覆盖仍在运行的任务。

新增内部 `DynamicScriptManager`，固定插件租约后，从产物库复制任务输入工程，检查 AEDT 版本和脚本声明的必要对象，再调用动态执行入口。返回后核对脚本及工程身份、参数、读回标记、输出路径及实际文件摘要，将修改工程和 Core 回执保存到内容寻址产物库。支持异步状态查询、取消、关闭等待及并发任务拒绝。

原生执行的成功记录可作为同一插件包、环境与 AEDT 版本下的复用参考；记录仍明确属于脚本报告的持久工程读回，不授予求解通过结论。替身成功不进入原生复用证据。所有实际调用仍重新检查对象条件；历史成功不能代替新任务验证。

新增 9 项 Node 测试覆盖重启保留、版本去重、参数校验、环境关联、终态保护、任务产物、不同参数重复调用、对象缺失、错误路径/摘要和执行中取消。成功回执过滤测试中的原生记录是合成数据，仅验证过滤规则，不代表真实 AEDT 验收。

第二批提供内部组件；第三批开始将其接入 App。完整仿真迭代仍需继续实现。

## 第三批实现：Core、DSH 与任务界面

`DynamicScriptService` 已在 Core 启动时创建，并与普通 HTTP 和带 Bearer Token 的 DSH Bridge 共用。退出时先关闭 Agent、取消动态任务，再关闭插件和脚本库。脚本运行引用的插件版本加入运行时保留清单；仅在没有活跃动态任务或待清理工程进程时，把遗留 running 记录改为 interrupted。

新增本机 API：

| 路径 | 用途 |
| --- | --- |
| `GET /api/dynamic-scripts?query=...` | 检索脚本 |
| `POST /api/dynamic-scripts` | 保存不可变脚本定义 |
| `GET /api/dynamic-scripts/:id` | 查看具体版本 |
| `POST /api/dynamic-scripts/:id/disable` | 停用或恢复版本 |
| `GET /api/tasks/:taskId/script-context` | 读取工程、AEDT 版本、计划确认状态和执行记录 |
| `GET /api/tasks/:taskId/script-runs` | 查询任务运行记录 |
| `POST /api/tasks/:taskId/script-runs` | 提交 scriptId、parameters 及可选 projectSha256 |
| `POST /api/tasks/:taskId/script-runs/:runId/cancel` | 请求取消，等待终态 |

上述入口限定 loopback 并检查请求 Origin。任务操作检查本机归属，执行沿用任务 `planConfirmed` 状态；输入仅限已绑定 AEDT 工程或同一任务的成功脚本产物。调用者不能传入任意工程路径、运行时身份或成功回执。输出工程和 Core 构建的执行回执会登记到产物数据库。

新增 DSH 工具：`thermal_script_library`、`thermal_stage_script`、`thermal_script_task_context`、`thermal_run_script`、`thermal_script_runs`、`thermal_cancel_script`。普通助手能够检索、生成、登记和调用操作。故障修复专用预设仍保持原有三工具边界。提示词要求仅在用户授权的调整范围内运行脚本，不得通过脚本绕过求解授权；该要求并非对任意 Python 代码的操作系统级执行限制。

任务页新增“可复用 Python 操作”区域，支持脚本选择、源码查看、按参数定义填写输入、选择任务工程或历史产物、执行和取消，以及查看参数、状态、错误和产物摘要。版本不匹配、缺少工程或计划未确认时不能从界面执行。脚本通过记录不显示为求解成功或热设计通过。

验证记录：

- TypeScript 与 Web 生产构建通过。
- Core、DSH Runtime、脚本 API、脚本库及管理器共 27 项集成测试通过。
- 真实 DSH 工具注册与专用修复预设限制检查通过，新增六工具可见。
- 浏览器调用真实 Core API，在工程接口替身上复用同一脚本，以两组不同参数运行并显示持久记录；浏览器无页面异常。
- 这些测试未调用真实 AEDT，也未调用模型供应商生成代码，不替代真实 Windows/Icepak 或模型生成流程验收。

## 接下来需要完成

1. 将动态脚本产物接入明确授权的真实求解流程，关联求解与指标证据。
2. 实现有界参数迭代，以及可查看每轮指标与停止原因的任务界面。
3. 完善脚本适用性与成功证据的跨任务展示，核查版本变化及任务调整范围。
4. 真实 Windows/Icepak 和实际模型生成流程验收、跨会话复用与无需重新打包的演示记录。

当前已接通动态脚本的 App/DSH 调用与参数复用路径，尚不能宣称自主求解迭代已完成，或已经通过真实 Icepak 验收。
