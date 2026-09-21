# ADR 0017：离线 Python 运行时隔离与打包证明

## 状态

打包前、`afterPack` 与运行时隔离代码已实现；尚无 Windows x64 安装包和真实 AEDT 机器上的验收记录。

## 背景

只验证 `python.exe` 存在或第三方模块“能导入”，无法证明安装包离线可用：构建机用户的 `PYTHONPATH` 或系统 site-packages 可能掩盖内置运行时缺件。

## 决策

- Windows 构建前用内置 Node 执行固定 DSH CLI `--version` 和散热工具冒烟测试；内置 Python 必须是 Windows x64、Python 3.10+。
- Python 用 `-I` 隔离模式执行导入探测，显式加入待打包 Icepak 与报告插件目录，并核验 PyAEDT、ReportLab、PyPDF 的模块文件实际位于内置 Python 目录。
- Electron `afterPack` 对实际复制的 Node/DSH CLI 和 Python 目录重复执行关键检查，防止构建源通过但产物缺件。
- Core 启动 Icepak 与报告插件时也用 `-I`，通过受控 `runpy` 入口加入对应插件目录，不继承用户 `PYTHONPATH`。

[Python 命令行文档](https://docs.python.org/3/using/cmdline.html)说明 `-I` 会忽略 `PYTHON*` 环境变量和用户 site-packages；[Windows 嵌入发行版文档](https://docs.python.org/3/using/windows.html#the-embeddable-package)说明 `._pth` 可明确设置模块搜索路径。构建者仍须核对第三方二进制来源、重分发许可、校验和，以及目标 AEDT/PyAEDT 兼容性。

## 验证边界

自动化测试覆盖内置目录导入成功、同名系统包回退被拒、运行时插件在冲突 `PYTHONPATH` 下仍从指定目录启动，以及现有 Icepak/报告回归。尚需在无系统 Python/Node 的干净 Windows 机器安装并验证真实插件与 DSH 会话。
