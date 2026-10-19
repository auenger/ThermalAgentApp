# Windows 插件隔离边界预检

目的：在允许 DSH 生成代码执行之前，先以宿主维护的固定命令验证目标客户端的部分隔离边界。此探针不会读取或运行修复候选，不会修改 App 更新策略、启用 Windows 可选功能或授予候选信任。

## 当前后端选择与依据

微软文档将 Windows Sandbox CLI 的适用起点列为 Windows 11 24H2。CLI 支持指定沙箱 ID、创建、执行及停止，但当前文档明确不支持取回沙箱进程输出。因此，此探针只用固定命令的退出码传递结果，没有共享可写输出目录。

- [Windows Sandbox CLI 官方说明](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli)
- [Windows Sandbox 配置官方说明](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

这只是隔离后端的预检，不表示 Windows Sandbox 能直接使用宿主上安装的 AEDT 或许可证，也不表示客户端已有完整的候选验证环境。

## 运行

在 Windows 11 24H2 或更高版本、已安装 Windows Sandbox CLI 的测试客户端上，从项目根目录执行：

```powershell
node scripts/probe-windows-plugin-isolation.mjs --output C:\ThermalProbe\report.json --wsb "C:\实际安装路径\wsb.exe"
```

`--wsb` 必须指向可信安装提供的真实 CLI 可执行文件，不能是链接或应用执行别名；路径和文件 SHA-256 将记录在报告中。脚本不会下载、搜索并自动运行未知 CLI。报告本身不是签名远程证明，信任该客户端和指定 CLI 是前提。

退出码：0 表示本次探针通过；2 表示平台不支持；1 表示检查失败或清理未确认。Mac/Linux 上可执行同一脚本并省略 `--wsb`，但只生成 `unsupported` 报告，不会启动进程。

## 配置和实际检查

配置请求关闭网络、vGPU、音视频输入、打印机及剪贴板共享，开启 Protected Client，配置 2048 MiB 内存。唯一共享目录是本轮新建的只读测试输入目录，内含随机标记；没有映射 App 数据、候选源码、用户目录、Python 环境或工程文件。

实际观测按顺序进行：

1. 创建本轮 UUID 标识的沙箱。
2. 执行固定 `exit 37` 命令，要求 CLI 确实返回 37。如果 CLI 只返回派发成功，停止检查，不以其后续 0 返回码当作成功。
3. 读取只读共享文件并核对随机内容。
4. 尝试覆盖该测试文件，要求写入失败。
5. 尝试读取同一个宿主临时目录中、未映射的测试文件，要求读取失败。
6. 检查沙箱内没有处于 Up 状态的非 Loopback 网络接口。
7. 宿主核对两个测试文件内容均未变化。
8. 停止本轮确切 ID 的沙箱，CLI 返回成功后才发布最终通过记录。

退出码探针使用沙箱内的 System 身份，不创建 RDP 连接。目标机器若不支持这种调用、只读映射尚不可见或 CLI 行为不同，会得到失败证据，而不会静默降级到普通宿主子进程。

网络检查证明的是本次接口状态观测，不覆盖所有 IPC、隐蔽通信或未来配置变化。剪贴板、设备共享和 Protected Client 目前只有配置请求，尚无逐项效果验收。内存值是配置请求，不是实测资源上限；CPU、磁盘配额和恶意资源耗尽尚未验证。

## 超时、取消和清理

创建最多等待 120 秒，其他单个命令最多 30 秒，业务探针总预算 180 秒，CLI 的 stdout/stderr 每路最多 64 KiB。超时或 Ctrl+C 会进入单独的 30 秒停止流程，只使用本次沙箱 ID，不停止用户其他沙箱。

启动前保存 ID、临时目录、CLI 摘要和探针代码摘要；中间结果原子替换报告。即使启动返回错误或超时，也尝试停止可能已创建的沙箱。停止未确认时，状态为 `cleanup-unconfirmed`，保留临时目录供核实，不宣称资源已释放。清理确认后才移除测试文件。

如果 Core/Node 被强制终止或断电，脚本不能保证清理；报告中的 `running` 状态也不是沙箱仍在运行的证明。应使用报告里的 ID，结合目标机当前 `wsb list`/`wsb stop --id <ID>` 的实际返回核实。不得按名称批量终止其他沙箱。

## 与自主修复闭环的关系

自动测试中的 CLI 驱动替身会明确标注 `execution: simulated`；这些测试只验证流程、参数、取消和失败处理，不证明 Windows 隔离有效。实际运行使用 `execution: native`。

当前没有把探针报告导入宿主通过记录的接口，即使报告为 `passed`，也不能激活任何修复候选。下一步仍需真实 Windows 运行结果、资源配额和恶意候选验收、候选依赖环境部署、独立结果回收与验证、AEDT/许可证兼容验证及本机授权策略。
