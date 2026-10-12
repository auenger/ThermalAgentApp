# CAD 转换与基础热模型实现及验收记录

实现与试包日期：2026-10-09；文档更新：2026-10-12。设计依据：[CAD 建模计划](./CAD_MODEL_PREPARATION_PLAN.md)。

## 当前实现

- 任务详情提供 STEP/STP 导入、实体列表、可用截图、工程下载、对象材料/功率/监测配置、环境与模板参数、草稿保存和本地未提交配置恢复。
- `inspect_cad` 创建独立几何工程；`prepare_model` 从归档工程副本施加材料、实体总功率、实体中心监测、开放空气域、重力、稳态 Setup 和全局/局部网格设置。
- `validate_model` 在独立副本的新 AEDT 会话中核对实际配置，执行模型检查、网格生成与网格统计导出。未完整通过时不得激活。
- 原始 CAD、导入工程、配置版本、生成工程和验证证据分别保存 SHA。激活后绑定 Baseline 输入，现有求解器保留建模版本身份；后续优化复用原有参数方案流程。
- SQLite 迁移 15 保存导入、草稿、不可变建模配置、作业与产物关系，以及共享 Icepak 执行锁。取消和失败留痕，重启后的非终态作业标记中断，不自动重新执行。
- 迁移 16 补充执行锁的 Core PID/出生身份、插件 PID 与受管 AEDT 进程身份。恢复不会直接删除仍有存活进程的锁；身份或退出证据不足时保留锁并显示原因。
- 首版无需 Agent。人工输入、CAD 材料线索和模板默认值分别展示；关键项必须确认。

新增主要入口：`ModelPreparationWorkspace.tsx`、`ModelPreparationManager`、`ModelPreparationStore`，插件模块 `cad.py`、`model_preparation.py`、`model_validation.py`。所有 Core 插件调用者共用 `lockIcepakOperations`。

## 首版限制

支持稳态开放环境自然对流、固体实体、理想直接接触、保留间隙、不启用辐射。材料候选为 aluminum、copper、silicon、steel、FR4_epoxy；材料是否可用及实际属性仍需在目标 Icepak 中核对。模板显示 `REQUIRES_WINDOWS_ACCEPTANCE`，默认值是待确认的初始配置。

建模适配固定 PyAEDT **1.6.0**（与当前内置 Windows 运行时一致）；真实调用遇到其他版本会明确拒绝。当前重力适配适用于 2027.1 之前版本，目标 AEDT 版本必须实际启动并匹配。

温度监测位于所选实体中心。当前温度指标是监测位置的最大值，不能作为全模型最高温度或芯片表面最高温度。真实案例若要求表面/体域最高温度，须扩展后处理并验收；这项完成前不能声称满足该类工程要求。

当前几何诊断包括实体类型、包围盒、可获取体积、空模型、异常体积，以及后续 Icepak 模型检查。接触、薄层和关键间隙由用户核对；导入修复不保证修复任意 CAD。独立重开与无外部组件检查用于首版工程完整性检查，复杂外部文件依赖尚不支持。

## 本地验证结果

2026-10-09，在 macOS 上使用 Node 22.22.0 执行：

- `pnpm test`：82 项 Node 测试、34 项 Icepak 插件 Python 测试、2 项报告测试通过；DSH 工具检查通过。回归中发现原有 UDP 发现测试随机端口冲突，已改为从系统获取空闲 UDP 端口并重新通过全量测试。
- `pnpm typecheck`：Core、契约、存储及 Web 类型检查通过。
- `scripts/smoke-model-preparation.mjs`：浏览器操作测试通过，覆盖导入、映射、逐项确认、刷新恢复草稿、生成、验证、工程下载、375px 布局、版本激活和 Baseline。
- 浏览器测试截图位于 `.thermal-agent/screenshots/cad/`，已检查生成页面。

后续补充验收脚本、求解产物下载和安装包资源后，重新运行全量 Node 测试：**85 项通过**。安装包资源测试验证公开 STEP 的 SHA，并验证包内独立验收脚本能解析其相对契约依赖；浏览器回归新增求解结果 JSON 下载并通过。Python 插件与报告代码在这轮补充中未修改。

2026-10-09 再补充取消、恢复和进程生命周期保护后，全量测试为 **94 项 Node、44 项插件 Python、2 项报告，通过且无跳过**。真实进程测试使用隔离的 Python 3.12 + psutil 7.2.2，在 macOS 验证受管单次请求正常退出，以及协作取消先结束注册的真实子进程再解除执行锁。Windows Job Object 的结构、参数、失败处理与 PID 出生身份检查采用替身测试，仍待 Windows 原生执行。

真实 DSH 启动在回归中曾超过原测试观察时限；独立观察确认最终进入 READY。Node 文件并发默认限制为 4（可用 `THERMAL_TEST_CONCURRENCY` 调整），DSH 冷启动集成测试观察时限设为 30 秒，保留原有 READY、会话与认证断言，重新通过全量检查。浏览器完整 CAD 流程及求解证据下载再次通过。

### 取消与恢复行为

- 不完整的配置草稿可以保存；记录人、依据和工程确认缺项只在生成之前拦截。
- 同一任务的导入、生成或验证未结束时，不能提前确认成 READY。取消任务会向它的活跃建模作业发送取消信号，作业的最终取消状态在受管调用结束后记录。
- 受管插件采用单次请求加取消通道；正常请求、主动取消、Core 消失和强制回收均有对应生命周期边界。
- Python 侧核对进程出生时间，只清理明确注册的 AEDT 会话与其子进程。Windows Worker 使用 Job Object 的 kill-on-close 边界，并核对新建 AEDT 会话的成员身份；创建或成员核对失败会阻止操作，而不假定保护已生效。[Microsoft Job Objects 文档](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- Core 会记录插件与受管进程。回复返回后仍无法确认退出的进程会保留执行锁；重启恢复也保留仍存活的旧 Worker，不杀任意 PID。已结束旧进程的锁才自动解除。
- 同一工作空间仍有可确认存活的 Core 时，新 Core 不接管其作业；Core PID 的出生身份用于区分 PID 复用，无法读取身份时保持保守。
- 恢复期间 Baseline、Candidate 和重试在创建新 Attempt 前被拒绝，节点能力显示 BUSY；浏览器内网访问只读展示 CAD 配置与证据。
- 旧版执行锁若完全缺少进程身份，会保留恢复提示，需要本机核查旧会话；不要通过直接删锁来替代确认旧进程已退出。该升级路径与 Windows 强制回收、锁屏/RDP 断开仍需实机验收。

上述建模/求解测试使用明确标识的替身，验证软件流程与拒绝条件，不证明真实 AEDT 调用、网格或热结果正确。新增代码后应按变更重新运行相应检查。

## 公开 STEP 参考样本

`assets/cad/reference-natural-convection.step` 由仓库脚本生成，无客户数据，包含 CPU 实体与带六条鳍片的散热器。单位 mm；CPU 为 10×10×2，散热器基座为 30×30×3，鳍片为 1.5×30×15。CPU 上表面与基座下表面直接接触，无导热垫。

生成及几何内核读回命令：

```sh
uv run --python 3.11 --with cadquery-ocp python scripts/create-cad-reference.py
```

脚本用 Open CASCADE 导出并重新导入 STEP，检查两个部件体积分别为 200 和 6750 mm³，写入同名 JSON 记录。该检查通过只证明 STEP 几何读回，不代表 Icepak 导入或热仿真通过。样本建议功耗等字段需工程确认；具体 SHA 以样本 JSON 为准。

## Windows 手动验收

1. 准备 Windows x64、项目要求的 Node 与 PyAEDT 1.6.0、实际安装的 AEDT Icepak 和可用许可证，记录版本及机器信息。
2. 启动 App，新建任务，填写需求并上传参考 STEP。CAD 只保存草稿，进入任务详情。
3. 在 CAD 建模区域填写实际 AEDT 版本，导入 CAD。核对实体数、mm 单位、尺寸和可用截图；下载几何工程，在 Icepak 中人工检查。
4. 按实际导入名称映射 CPU 和散热器，填写材料、功率、环境、重力和监测；核对接触与全部模板设置，并填写工程依据。初次案例的温度偏差、网格敏感性和热量平衡标准提前由工程师记录。
5. 生成工程，下载并人工核对材料、热源、空气域、开放边界、重力、Setup、监测和网格设置。
6. 执行验证，下载读回证据、几何检查与网格统计。确认产物的输入 SHA 和配置 SHA 对应本版本。
7. 选为 Baseline 输入，确认需求并启动本机 Baseline。核对求解结果、收敛证据、监测范围与人工参考工程。
8. 测试错误材料、过期映射、非法 CAD、网格失败、缺许可证、取消和 Core 中断；确保没有误标通过或重复启动。
9. 用一个实际业务 STEP 重复上述过程；完成工程容差、网格敏感性和热量平衡验收。
10. 在 Windows 安装包中重复操作，核对插件与运行时资源完整性；使用下文 SHA 对应的 2026-10-09 试包；更早的安装包不包含本次 CAD 实现。

### 使用 App API 验收脚本

`scripts/accept-cad-model.mjs` 使用与界面相同的 App API，不直接调用求解插件。先启动 App，在“设置 → App 工作空间”读取本机服务地址。每次执行生成独立的 `acceptance-<ID>.json`，记录 Task/Job/Run/Attempt 身份、返回结果和产物 SHA；下载按流处理，支持现有 2 GiB 产物上限。

第一步只上传并导入 CAD，导出待审核配置，不生成或求解热模型：

```powershell
node scripts/accept-cad-model.mjs --base http://127.0.0.1:43110 --cad assets/cad/reference-natural-convection.step --version 2024.2 --out C:\ThermalAcceptance\Reference
```

服务地址和 AEDT 版本须替换为当前 App 的实际值。根据导入清单在 App 中核对几何，完善脚本导出的 `model-spec-<ID>.json`，填写记录人、工程依据、材料、角色、功率、监测、环境与全部确认项。配置保留对应导入版本身份，不能把另一任务的映射直接复制进来。

第二步使用第一次输出的 Task ID 和人工核对的配置，执行生成、验证和明确授权的单次 Baseline：

```powershell
node scripts/accept-cad-model.mjs --base http://127.0.0.1:43110 --task <Task-ID> --spec C:\ThermalAcceptance\Reference\reviewed-spec.json --out C:\ThermalAcceptance\Reference --solve
```

省略 `--solve` 时只生成并验证工程。求解完成后仍保留人工结果复核状态；脚本不会接受结果，也不会把工程比较、业务案例或安装包验收标记完成。界面“求解证据下载”可下载指定 Task/Run/Attempt 的输入工程、求解工程及结果文件，接口拒绝跨任务或未关联产物。

脚本观察超时时，原 App 作业可能仍在运行，不能据此重复发起导入或求解。可在 App 查看进度，或用记录中的原 Job ID 继续只读观察：

```powershell
node scripts/accept-cad-model.mjs --base http://127.0.0.1:43110 --task <Task-ID> --observe-job <原Job-ID> --out C:\ThermalAcceptance\Reference
```

最新版试包同时携带脚本、所需契约和公开 STEP。仅安装 App 的测试机可使用包内 Node，无需另外构建源码：

```powershell
$CadAppInstallRoot = "<App安装目录>"
$CadNode = Join-Path $CadAppInstallRoot "resources\node\node.exe"
$CadAcceptance = Join-Path $CadAppInstallRoot "resources\cad-acceptance\scripts\accept-cad-model.mjs"
$CadReference = Join-Path $CadAppInstallRoot "resources\cad-samples\reference-natural-convection.step"
& $CadNode $CadAcceptance --help
& $CadNode $CadAcceptance --base <本机服务地址> --cad $CadReference --version <实际AEDT版本> --out C:\ThermalAcceptance\Reference
```

上述两阶段、证据 SHA、下载作用域、超时保留原作业及续看逻辑均已有本地替身测试；仍须通过真实 Windows 插件和安装后的 App 执行才能获得实机证据。

### 2026-10-09 Windows 跨平台试包

`pnpm package:win:cross` 成功生成 `release-cross/Thermal-Agent-0.1.0-Windows-x64.exe`，209,763,686 字节，SHA256：

```text
e4bdca05ecf34b1450ce6da28bfc23900ce210e51820980dd81ee5e842fa3710
```

`.exe.sha256` 已更新，`release-cross/cad-build-evidence.json` 保存构建证据。实际解包目录的必需资源、CAD 样本 SHA、Core/契约/存储文件的归档 SHA、受管 Python 模块与源码的 SHA，以及包内验收脚本依赖加载已验证。后者使用 macOS Node 执行 `--help`，没有运行 Windows `.exe` 或真实 Icepak。

试包只证明跨平台构建与静态资源完整性，Windows 安装、内置运行时执行、许可证、真实模型与业务案例仍未验收。构建文件由 Git 忽略，未发布到外部服务。

## 尚未完成的计划验收

| 计划项 | 现有证据 | 待补证据 |
|---|---|---|
| M0 环境和首例模板确认 | 已核对内置 PyAEDT 1.6.0 源码接口；公开 STEP 内核读回 | 真实 Windows 启动、导入、接口行为、材料和模板数值确认 |
| M1 App CAD 转换 | 插件/接口实现与浏览器替身流程 | 实际 STEP 导入工程、预览、保存重开 |
| M2 热模型与验证 | 配置契约、模板、持久化读回/网格代码及替身测试 | 实际材料/功率/边界/网格证据、工程完整性确认 |
| M3 Baseline | 替身端到端执行与输入身份绑定 | 真实求解、收敛、监测范围和参考结果比较 |
| M4 业务和安装包 | 验收脚本、证据下载、最新 NSIS 试包及资源/归档 SHA 验证 | 业务 STEP、Windows 安装包运行、取消/中断实机回归 |

整体目标仍在进行中，不能用本地替身测试替代这张表中的实机证据。

## 完成审计与外部依赖

本次连续实现已完成 App 流程、接口、存储、插件适配、公开 STEP、验收脚本及跨平台试包，并以本地自动化、浏览器和真实进程测试验证软件路径。以下完成门槛仍缺权威证据：

- M0/M1：真实 Windows + AEDT + PyAEDT 1.6.0 的 CAD 导入、几何尺寸、保存重开与预览。
- M2：工程师确认的材料属性、接触与模板数值，以及真实读回、模型检查、网格统计和 Job Object 行为。
- M3：真实 Baseline 的求解、收敛、监测范围、网格敏感性与热量平衡，以及与人工参考工程的温度对照。
- M4：至少一个实际业务 STEP 的完整验收，及安装后的 Windows App、取消、强制中断、RDP/锁屏与恢复回归。

当前执行环境为 macOS；未找到可用的 Windows 执行工具、项目连接配置或本地已登记的测试节点信息。用户尚未提供测试机连接方式、业务 STEP 与人工参考结果。该依赖在连续目标轮次中未改变；当前不能通过增加替身测试补齐上述门槛，也不能据此标记整体目标完成。

获得测试环境与案例后，从本文件的 Windows 手动/API 验收步骤继续，保留完整原始工程、日志、SHA 与比较记录；依据真实失败证据修正适配器或模板。

## 2026-10-12 文档与后续计划同步

已整理 [独立离线 HTML 操作说明](./Thermal-Agent-功能进度与操作说明.html)，包括功能进度、Windows 准备、CAD 到 Baseline 操作、状态解释、演示截图及可保存/导出的测试清单。截图和本地建模/求解演示使用明确标识的替身，不代表实机验收。HTML 已检查离线打开、筛选、图片查看、记录恢复/导出、375px 布局和打印样式。

后续按 [设计计划第 11 节](./CAD_MODEL_PREPARATION_PLAN.md#11-后续推进顺序2026-10-12) 执行：先补齐 Windows Baseline 证据，再开展 3D 对象选择、几何预检查、参数化散热器和 Agent 辅助。这些扩展不计入当前试包的已实现功能。本轮文档更新没有重新生成安装包。

### 本次提交前回归

2026-10-12，macOS + Node 22.22.0：

- `pnpm test`：94 项 Node、44 项 Icepak 插件 Python、2 项报告测试通过；Node 测试无跳过，DSH 工具检查通过。插件与真实进程测试使用独立 Python 3.12 + psutil 运行时。
- `pnpm typecheck`：通过。
- `scripts/smoke-model-preparation.mjs`：导入、对象映射、确认、草稿恢复、生成、验证、下载、窄屏、激活和无需 Agent 的 Baseline 流程通过。
- `scripts/smoke-parameter-workspace.mjs`：编辑、草稿恢复、不可变版本、读回验证、比较、导出、窄屏、执行回链和工况子任务通过。

浏览器建模与求解使用替身；本次检查不补齐 Windows 实机工程验收，也未重新打包。
