# Windows 安装包构建与验收

当前仅有构建配置和静态预检，尚未完成真实 Windows 安装包验收。构建必须在 Windows x64 主机进行；原生依赖不能用 macOS 的 `node_modules` 直接交叉打包。

## 构建输入

1. 在 Windows x64 上安装 Node 22.22.x、pnpm 11、Python 3 和 uv，并运行 `pnpm install`、`pnpm test`。
2. 准备 `packaging/windows-runtime/node/node.exe`，采用可再分发的 Windows x64 Node 22.22.x 或兼容版本。构建前脚本会检查版本和 DSH CLI 语法。
3. 准备 `packaging/windows-runtime/python/python.exe` 及完整的 Windows x64 Python 运行目录。在该内置解释器中安装与 Windows AEDT 匹配的 PyAEDT、`reportlab>=4.2,<5`、`pypdf>=5,<7`。如果使用 Python embeddable distribution，需确保其 `._pth` 配置启用所需 `site-packages`，且构建前导入检查通过。
4. 目标用户机器仍需有合法 AEDT/Icepak 安装及相应许可证；安装包不会内置 Ansys 产品或许可证。报告字体优先使用 Windows 系统中的可嵌入中文字体，也可设置 `REPORT_FONT_PATH`。

`packaging/windows-runtime/` 被 Git 忽略，不会把第三方可执行文件提交进仓库。构建者需自行核对二进制来源、许可条款、校验和及软件物料清单。

## 构建

```powershell
pnpm package:win
```

命令先构建 TypeScript/Web，再检查内置 Node、Python、DSH CLI/插件及 Icepak/报告插件的存在和 Python 导入，之后使用 electron-builder 生成 NSIS x64 安装包到 `release/`。配置位于 `electron-builder.yml`。缺失资源会在打包前或 `afterPack` 阶段失败。

## Windows 验收门槛

在没有开发工具或系统 Python 的干净 Windows 虚拟机上安装，并至少验证：

- App 启动、内置 Core 健康检查、SQLite 重启持久化和 DSH 对话入口。
- 内置 Python 可加载报告插件，并对已审批任务生成中文 PDF。
- 在有 AEDT 的工程机上运行轻量探测、独立会话启动探测、真实工程检查、Baseline、取消、候选求解和报告。
- App 显式开启/停止内网 Web，第二台浏览器短时码配对；双机组播发现、防火墙与节点信任状态。
- 卸载/升级时确认用户数据目录与 `identity/node-key.json` 不被误删。

这些步骤未执行前，不将“Windows 安装包完成”标记为已完成。代码签名、自动更新和跨 Windows 双机调度也仍在后续阶段。
