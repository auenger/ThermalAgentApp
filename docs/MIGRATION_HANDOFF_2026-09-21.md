# Thermal Agent App 阶段总结与本地手动回归

日期：2026-09-21。项目目录：`/Users/ryan/mycode/ThermalAgentApp`。

## 结论

当前是**可从源码启动、具备主要业务链路的迁移阶段版本**，不是已验收的 Windows 安装版。单机 Task → Icepak 插件 → Run/Attempt → 热判定 → 人工审批 → PDF/Skill，以及 DSH Agent、LAN Web、可信节点远程执行的代码链路已接通；Windows AEDT/许可证、真实双机网络和安装包均未实测通过。不要把模拟测试通过等同于现场可用。

## 已落地范围

| 领域 | 当前实现 | 证据边界 |
| --- | --- | --- |
| 桌面与数据 | Electron 工作台、单实例/托盘后台、独立 Core、SQLite WAL、事件审计、SHA-256 Artifact Store | 自动测试与本机 Core 冒烟；Windows GUI/安装未验收 |
| Icepak | 独立 Python 插件、AEDT 探测、工程检查、Baseline、风扇动作/候选求解、温度及收敛证据 | 插件单测和模拟链路通过；真实 AEDT/许可证未验收 |
| 业务闭环 | Task/Run/Attempt、输入快照、重试、确定性热判定、人工审批、PDF、Skill 草稿/审核发布 | 自动化覆盖；真实工程结果需人工复核 |
| Agent | 固定 DSH 运行时、本机工具桥、自然语言任务草稿和受控工具 | DSH 启动/工具测试通过；模型服务配置及现场对话需本地验证 |
| 局域网与节点 | 显式 LAN 发布、短时码配对、签名发现、可信节点加密会话、租约、显式/授权自动派单、结果回传 | 模拟双/三 App 测试通过；浏览器仍是 HTTP，真实 Windows 双机未验收 |

与旧 B/S 方案相比，新项目不依赖 PostgreSQL、MinIO、Temporal 或常驻中心服务器；数据及节点密钥由每台 App 本地持有。更细的逐项状态见 [MIGRATION_STATUS.md](./MIGRATION_STATUS.md)。

## 本次交接时的验证记录

- `pnpm typecheck`：通过。
- `pnpm test`：通过，55 个 Node 测试、18 个 Icepak Python 测试、2 个报告 Python 测试；Web 构建和 DSH 工具冒烟包含在该命令中。Node 测试不依赖 shell 展开 glob；Icepak 测试入口按平台选用 `python`/`python3`，也可由 `THERMAL_ICEPAK_PYTHON` 指定。
- 使用隔离临时目录在 macOS 启动 `apps/core/dist/cli.js`：`GET /api/health` 返回 `{"status":"ok","service":"thermal-agent-core","version":"0.1.0"}`；首页 HTTP 200；SQLite 和身份密钥生成成功，Core 正常退出。
- `pnpm package:win` 在 macOS x86_64 实际尝试：TS/Web 构建成功，Windows x64 平台预检按设计拒绝继续；**没有生成 `.exe`**。还需 Windows x64 构建机及内置 Node/Python 运行时。见 [WINDOWS_PACKAGING.md](./WINDOWS_PACKAGING.md)。
- 本机未完成 Electron GUI 交互测试、真实 AEDT 求解、许可证验证、Windows 安装/升级/卸载或 LAN 双机测试。

## 本地启动方案（源码运行，不需要安装包）

在项目根目录打开终端。优先使用 Windows x64 工程机；没有 AEDT 的机器只能做界面与非求解冒烟。建议 Node 22.22.x、pnpm 11、Python 3.10+、uv。请先保存/备份要验收的 `.aedt` 源工程，并使用测试数据；求解会占用许可证和机器资源。

```powershell
node --version
pnpm --version
python --version
pnpm install
uv sync --project plugins/report-reportlab
pnpm typecheck
pnpm test
```

在**同一个 PowerShell 窗口**设置实际可用的 Python 路径，然后启动桌面开发态。Icepak Python 必须能导入与本机 AEDT 兼容的 `ansys.aedt.core`；报告 Python 需能导入 `reportlab` 和 `pypdf`。使用不同解释器时分别指定；这里的路径只是示例，不要原样复制。

```powershell
$env:THERMAL_ICEPAK_PYTHON = 'C:\Path\To\IcepakPython\python.exe'
$env:THERMAL_REPORT_PYTHON = (Resolve-Path 'plugins\report-reportlab\.venv\Scripts\python.exe').Path
& $env:THERMAL_ICEPAK_PYTHON -I -c "import ansys.aedt.core; print('PyAEDT OK')"
& $env:THERMAL_REPORT_PYTHON -I -c "import reportlab, pypdf; print('Report OK')"
pnpm dev:desktop
```

`pnpm dev:desktop` 会先构建，再启动 Electron；等待工作台出现。开发态桌面数据位于 Electron `userData/runtime`，**不等于**独立 Core 的项目根目录 `.thermal-agent/`，不要用另一套数据目录判断“数据丢失”。关闭窗口后 App 按设计留在托盘；通过托盘“退出应用”才真正停止。不要同时启动多个占用同一数据目录的 Core。若只需浏览器诊断，可在项目根目录的另一个终端运行 `pnpm dev:core`，然后打开 `http://127.0.0.1:43110/`；此方式使用项目根目录 `.thermal-agent/`，不验证 Electron 托盘和桌面生命周期。

## 手动回归顺序与通过标准

### A. 不依赖 AEDT：先做本机冒烟

1. 启动后检查“概览 / Agent / 任务 / 技能 / 节点 / 设置”可打开，无空白页。Agent 页应显示 DSH 状态；若未配置模型连接，可先只验 Host/工具入口，不把模型对话失败判为 Icepak 故障。
2. 在“概览”的“新建需求草稿”创建一个仅用于持久化的草稿（可暂不填工程路径），记录任务名称。关闭窗口，从托盘重新打开，草稿应仍在；从托盘退出再重启，草稿仍在。切勿删除或单独复制 `identity/node-key.json`：它必须与 SQLite 一起备份/恢复。
3. “设置 → 局域网发布”默认应为关闭。只有在可信内网测试时才显式开启；从第二台设备访问显示的 HTTP 地址，未配对前业务 API 不应可用，输入 8 位短时码后才进入。测试后停止发布；不要暴露到公网或不可信 Wi-Fi。
4. 若需排查服务，可在独立 Core 模式访问 `http://127.0.0.1:43110/api/health`，预期 `service=thermal-agent-core`；桌面模式使用随机 loopback 端口，不固定为 43110。

### B. 有 AEDT/许可证：真实单机业务链路

1. 在“设置 → Icepak 插件”确认探测到本机 AEDT/PyAEDT。用与安装环境匹配的版本执行“验证 Icepak 可启动”；`LAUNCHABLE` **不表示**许可证可用于求解。
2. 使用测试 `.aedt` 做“检查工程”，核对活动设计、Setup、温度 Monitor、能力校验及工作副本；确认源工程未被改写。可在副本上做“验证风扇动作”。
3. 在“概览”创建带工程路径和最高温度目标的草稿，再到“任务”操作“确认需求” → “本机 Baseline”。观察任务状态是否刷新；运行详情可从同源 Core API 的 `/api/tasks` 找到 Task ID，再查 `/api/tasks/{id}`，审批后还可从 PDF 核对 Attempt、收敛和温度证据。当前任务列表不直接展开完整 Attempt 证据。求解成功不等于热设计 PASS。
4. 待人工审批时按证据选择“接受结果”或“拒绝并升级”。若热判定 FAIL 且工程具备风扇候选条件，可单独批准“风扇 +10%”再求解、再审批。该按钮目前是固定演示动作，不是通用自动优化策略。
5. 对已完成任务点“查看 PDF 报告”，检查中文、页数、温度/收敛证据和 Artifact SHA；再点“沉淀 Skill 草稿”，在“技能”页人工审核启用/停用，检查 DSH 发布与撤回。失败/取消任务可测试“重试最近 Run”，但不要在昂贵工程上无意重复求解。

**当前界面限制：**“任务”表单把 `aedtVersion` 默认写为 `2024.2`，界面未提供修改该字段。若机器不是 AEDT 2024.2，任务页的 Baseline/远程派单验收可能因为版本不匹配而失败；先在设置页做匹配版本的环境/工程检查，任务链路需后续修正版本输入或使用受控 API。任务列表在 RUNNING 时也没有直接“取消”按钮；不要把该项记为已完成 GUI 验收。

### C. 两台 Windows 工程机：可选网络回归

两台源码运行的 App 分别在本机显式开启 LAN 发布；确认 Windows 防火墙允许选定 TCP LAN 端口及 UDP 43112 组播，并处于允许组播的同一局域网。线下核对 Node ID/公钥后**双方**登记信任，在“节点”页验证发现、身份挑战和加密 ping。远程接单默认关闭，Executor 需单独开启；真实派单前先用真实求解证据确认版本限定的 READY 与许可证状态，再用小工程依次验证输入同步、求解、续租、结果回传和 Owner 审批。断网、过期租约、重启恢复需单独记录；这部分当前只有模拟测试证据，不应直接用于生产排队。

## 记录反馈时请保留

记录 Windows 版本、AEDT/PyAEDT/Python/Node 版本、启动命令、使用的工程副本、失败操作和时间；提供界面截图、Core/终端错误及对应 Task ID/Attempt ID。分享日志前先遮盖工程路径、模型密钥、局域网配对码和节点私钥。若报告/求解异常，请区分“环境或许可证不可用”“插件协议错误”“热结果不合预期”三类，便于定位。

## 尚未完成的交付门槛

Windows NSIS 安装包与干净机安装/卸载、真实 AEDT/许可证及双机长任务验收；浏览器 LAN HTTPS、Windows 防火墙引导、首次节点配对与协议安全审计；Skill 的 Agent 修订/沙箱验证；真实失败恢复与大型 Artifact 传输性能。这些项目保持未完成，不因本报告或自动化测试通过而改变状态。
