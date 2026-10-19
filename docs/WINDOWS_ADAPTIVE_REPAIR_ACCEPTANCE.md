# Windows 自适应插件试包验收

本轮应用源码：`b6d3cee2a9abf4182f78a8f884b290f6a97dcedc`，分支 `feat/plugin-adaptive-repair`。安装包位于 `release-cross/adaptive-repair-b6d3cee/Thermal-Agent-0.1.0-Windows-x64.exe`；以同目录的 `build-evidence.json` 和 `.exe.sha256` 核对交付身份。版本号仍为 0.1.0，请勿仅凭文件名识别旧包。

这是 macOS 交叉构建的 Windows x64 手动验收包，尚未完成 Windows 原生运行、真实 AEDT 启动及求解验收。应用身份沿用 Thermal Agent，可能使用已有安装的数据目录；CAD Preview 的独立数据目录不自动迁移。

## 本轮覆盖与限制

- 已实现：宿主插件管理、兼容版本选择、验证记录、回退机制、受管依赖环境重建、限定故障后的持久化 DSH 修复任务，以及 AEDT 标准安装目录的进程启动路径自动适配。
- 修复任务默认关闭。开启后使用已配置模型的额度；每个插件版本与环境组合自动请求一次，五分钟后发起取消。生成的源码仅登记为候选。
- **尚未接通：模型生成候选的隔离运行验证与自动激活。** 候选出现不代表故障已经修复，当前包不能验收“任意问题自动改代码并生效”的完整目标。
- 目前自动模型修复要求活动的受信插件存在对应环境下的宿主失败记录；普通业务错误、许可证不足、参数不合法不保证触发任务。不要人为损坏生产插件来测试。

## 建议手动验证顺序

| 步骤 | 操作 | 预期与记录 |
| --- | --- | --- |
| 1 | 安装并启动 App，打开设置，发送一次普通 AI 对话 | 主窗口、设置和 DSH 可用；记录 Windows、AEDT 版本及完整错误文本 |
| 2 | 设置 → 插件与自适应升级 → 立即检查环境与插件 | 插件状态、环境身份及验证记录可见；没有 AEDT 时应明确显示不可用，不应虚报就绪 |
| 3 | 开启“自动获取并选择兼容版本”，再次检查 | 标准路径已安装商业版 AEDT，但缺少或存在失效的 ANSYSEM_ROOT 配置时，显示“本机启动路径适配”；已有正确配置时零条修复也正常 |
| 4 | 设置 → Icepak 插件，执行环境、启动和内置示例工程检查 | 检查实际启动及工程读取结果；路径适配成功本身不等于启动或许可证成功 |
| 5 | 退出 App（包括托盘），重新打开并重复步骤 2–4 | 开关设置保留；相同安装情况应重建相同路径适配，实际检查结果一致 |
| 6 | 开启“故障后自动请求模型生成修复候选”后重启 | 开关保留；正常环境不应产生无故修复任务。如果出现符合条件的宿主故障，记录任务与候选状态 |
| 7 | 用测试工程执行既有参数读取/修改、CAD 预览和报告流程；有许可证时再验证求解 | 分别记录业务是否成功。求解沿用现有人工确认流程；本表不把环境检查替代求解验收 |

路径适配支持 `Program Files/AnsysEM/vnnn` 与 `Program Files/ANSYS Inc/vnnn/AnsysEM`，包括主程序在 `Win64` 子目录的情况。同版本多个可选目录时应报告歧义。自定义安装路径、学生版、所有注册表与 AWP_ROOT 路径未纳入完整自动修复范围。不需要为了测试去改系统环境变量。

## 内置 Python 独立环境检查（可选，建议执行）

旧试包使用精简 Python，缺少 `venv/ensurepip`。本轮更换为官方 NuGet 的同版本 CPython 3.12.10 x64，保留既有 PyAEDT、ReportLab、pypdf 依赖，补齐标准库、venv 启动器与离线 pip wheel。其来源与摘要见构建记录。[Python 官方 Windows 文档](https://docs.python.org/3.12/using/windows.html#the-nuget-org-packages)介绍了该分发渠道。

在 Windows PowerShell 中，将首行改为实际安装目录，再执行：

```powershell
$resources = 'C:\实际安装目录\resources'
& "$resources\python\python.exe" -I -c "import sys,ansys.aedt.core,reportlab,pypdf; print(sys.version); print(ansys.aedt.core.__file__); print(reportlab.__file__); print(pypdf.__file__)"
if ($LASTEXITCODE -ne 0) { throw '内置 Python 导入失败' }
$probe = Join-Path $env:TEMP ('thermal-venv-check-' + [guid]::NewGuid().ToString('N'))
try {
  & "$resources\python\python.exe" -I -m venv $probe
  if ($LASTEXITCODE -ne 0) { throw '独立环境创建失败' }
  & "$probe\Scripts\python.exe" -I -m pip --isolated --version
  if ($LASTEXITCODE -ne 0) { throw '独立环境 pip 检查失败' }
} finally {
  if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Recurse -Force }
}
```

预期第三方模块路径均位于安装目录的 `resources\python` 内；pip 路径应位于临时独立环境。此检查不安装网络依赖、不启动 AEDT。

## 反馈记录

请记录安装包 SHA256、Windows/AEDT 版本、失败步骤、设置页插件状态和完整错误文本。区分“路径补齐”“启动成功”“工程读取成功”“求解成功”“生成候选”“候选已启用”，逐项标记；本轮不应出现未经验证就自动启用模型候选的行为。
