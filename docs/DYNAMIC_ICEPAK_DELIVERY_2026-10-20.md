# 动态 Icepak 脚本能力 Windows 试包

日期：2026-10-20。源码分支：`feat/plugin-adaptive-repair`。运行代码提交：`7e62a805f1c5af9d7b93a592e024b6b8be9026e8`，已推送。

## 安装包

- 位置：`release-cross/dynamic-icepak-20261020-r1/Thermal-Agent-0.1.0-Windows-x64.exe`
- 文件大小：215,404,299 字节。
- SHA256：`9cb90a0f411008e67c1573b0a501e600debef9cd2be38f371d282e32d41a645f`
- macOS 交叉构建的 Windows x64 NSIS 试包，App 版本仍为 0.1.0，请用摘要辨认本轮文件。
- 同目录包含 `build-evidence.json`、`packaged-file-hashes.json`、构建及测试日志、`.exe.sha256` 和手动验收说明。

## 本轮能力

动态 Python 通过 Icepak 插件运行，可表达固定 fan 参数接口之外的工程操作；脚本保存为带参数、版本和环境要求的本地能力。任务页与 DSH 已接入登记、执行、查询和复用流程。

有界迭代支持数值参数范围、温度目标、轮数/耗时预算、取消、每轮结果和最佳方案记录。本轮另补充历史验证范围、提交来源、Core 实例记录和验收材料导出，便于核查跨会话复用。

## 已验证与待验证

- 全量 Node 回归：244 项，242 通过、2 跳过、0 失败。跳过的是需要带 psutil 的独立 Python 环境的两个真实进程测试。
- TypeScript/Web 构建、DSH 工具检查、浏览器脚本复用与导出测试通过。浏览器中的工程执行使用测试替身。
- 安装包内 279 个应用构建文件与 Python 源文件逐文件比对一致。比对排除打包器默认不包含的 `.d.ts` 声明及 Python 缓存。
- 尚未在真实 Windows 上安装、调用模型生成操作或运行真实 Icepak 求解。覆盖安装与含空格安装路径问题仍待实机确认。

请按 [Windows 实机验收说明](DYNAMIC_ICEPAK_WINDOWS_ACCEPTANCE.md) 完成非 fan 操作、重启后不同参数复用、实际求解、多轮停止与取消，并保留导出记录。计划仍在推进中，本试包不代表全计划已验收。
