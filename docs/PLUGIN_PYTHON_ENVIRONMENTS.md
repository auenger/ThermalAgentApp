# 插件独立 Python 依赖

签名插件现在可携带离线 wheel 锁。宿主为每个包与基础环境组合创建独立的 venv，候选选择、验证、执行、回退及恢复旧作业都使用对应解释器。未声明依赖锁的旧插件继续使用 App 基础环境。

此功能要求 `hostApi: 2`，避免旧 App 忽略新字段并错误地在公共环境中执行。JSON-RPC 协议仍为 `1.0.0`；新宿主仍接受 API 1 的既有插件。

在 `plugin.json` 中添加以下字段，并将 wheel 放在 Python 源码目录下的 `wheels/`。填写真实版本和 wheel 文件 SHA-256：

```json
{
  "hostApi": 2,
  "pythonRuntime": {
    "schemaVersion": 1,
    "wheels": [
      {
        "name": "example-package",
        "version": "1.0.0",
        "path": "wheels/example_package-1.0.0-py3-none-any.whl",
        "sha256": "填写 wheel 文件的 64 位小写十六进制 SHA-256"
      }
    ]
  }
}
```

锁须包含完整依赖闭包；名称使用小写及连字符规范化形式。不能提供 URL、源码包、任意 pip 参数或安装脚本。沿用签名发布工具和发布者授权；DSH 不获得创建公钥或修改基础 Python 的能力。

安装步骤：

1. 校验已验签包、wheel 摘要及展开预算。
2. 在最终固定路径创建 venv 并用 Python 自带 ensurepip 离线初始化 pip。Windows 复制解释器，其他系统使用 venv 支持的链接方式。环境创建后不移动。
3. 使用 `--no-index --no-deps --require-hashes --only-binary=:all:` 安装指定 wheel，禁止源码构建；再运行 `pip check`，核对声明版本并采集实际依赖内容摘要。
4. 完成后才发布环境索引，随后仍必须通过宿主插件验证。报告的独立 PDF 读回、工程的内置参考插件使用基础环境，候选依赖不能替代参考验证器。

安装失败保留旧版本并清理此次尚未发布的环境，15 分钟后才重试同一包/基础环境组合；关闭自动更新或宿主会取消正在准备的进程。缓存重用会重新采集内容并比较安装时摘要，内容被改写时拒绝使用，当前会回到其他通过验证的候选；尚未实现损坏环境的自动重建。

包和环境身份同时保留在执行证据中。回退不会把旧依赖重新安装到新版本环境；已持有的租约继续使用原解释器。基础环境变化会使独立环境与参考验证器的绑定失效，需要重新准备和验证。

当前边界：

- 基础 Python 必须支持 `venv` 和离线 `ensurepip`；Windows 打包预检和 afterPack 会实际创建环境并运行 pip。仅能导入业务依赖的精简嵌入式 Python 不足以满足要求。
- 沿用签名包 32 MiB 内容、48 MiB 信封限制，wheel 展开合计限制 512 MiB；较大的 PyAEDT 依赖闭包还需后续独立资产传输。每个安装命令最多 120 秒，最多保留 64 个环境，尚无自动回收或崩溃孤儿清理。
- venv 隔离依赖目录，不隔离操作系统权限，也不提供完全独立的 Python 标准库/原生运行库。当前不下载或升级基础 Python 解释器。
- 已用真实 wheel、Python 子进程和真实 PDF 验证报告升级、重启、回退与失败回退。Windows/AEDT 的独立依赖升级仍需目标客户端验收；DSH 生成代码的执行隔离仍未完成。

实现依据：[pip 哈希与二进制安装约束](https://pip.pypa.io/en/stable/topics/secure-installs/)、[Python venv 的创建与不可迁移性](https://docs.python.org/3/library/venv.html)。
