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

该入口不主动调用求解，`solve` 仅记录 `hostRequested: false, status: not-verified`。动态 Python 本身具有当前执行进程权限，可能调用其他 API；这不是 Python 沙箱，工程副本也不构成文件系统访问限制。尚未对 HTTP 或 DSH 暴露执行入口，任务授权与代码执行边界需在接入时一并实现。

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

这一批尚未接入 Core 启动、HTTP、DSH 或界面；它是后续任务入口要调用的内部组件，不宣称用户已能通过 App 发起完整流程。

## 接下来需要完成

1. 将本地脚本库与任务管理器接入 Core 生命周期，补齐前次任务恢复与产物数据库登记。
2. 接入任务所有权与执行授权，并显示脚本的当前验证范围及复用状态。
3. 本机 API 与 DSH 工具：查询工程和脚本、生成并执行脚本、根据真实结果修正；沿用任务授权。
4. 持久工程读回与求解证据整合，成功后登记可复用能力。
5. 有界参数迭代，以及可查看每轮指标与停止原因的任务界面。
6. 真实 Windows/Icepak 验收、跨会话复用与无需重新打包的演示记录。

当前完成底层执行入口、能力盘点、内部脚本库和任务编排，不能据此宣称 App 已完成动态脚本复用或自主仿真闭环。
