# 签名插件包与客户端适配

客户端现在能独立接收插件版本，不必重装 App。当前支持内置版本和管理员配置发布者的 Ed25519 签名包；没有默认发布者密钥，也不会把包内携带的密钥当成可信来源。

## 发布与部署

1. 发布系统保管 Ed25519 私钥，客户端只部署 SPKI PEM 公钥。私钥不得交给 DSH 或复制到客户端。
2. 更新 Python 源目录的 `plugin.json` 版本及协议 health 返回版本。相同插件 ID、版本不能对应不同字节。
3. 在项目根目录构建并签名，例如：

   ```sh
   pnpm build:ts
   node scripts/package-plugin-release.mjs plugins/report-reportlab/python company-report /secure/release-key.pem /releases/report-release.json
   ```

4. 管理员在客户端 `<THERMAL_AGENT_HOME>/plugins/publishers.json` 配置允许的发布者和插件范围：

   ```json
   [
     {
       "id": "company-report",
       "publicKey": "-----BEGIN PUBLIC KEY-----\n实际 Ed25519 公钥内容\n-----END PUBLIC KEY-----\n",
       "pluginIds": ["report-reportlab"]
     }
   ]
   ```

5. 在本机设置页导入 JSON 包，或把包放到 App workspace，通过 DSH 的 `thermal_install_plugin_release` 登记。随后 `thermal_reconcile_plugins` 触发环境检查与选择；CLI 也会每五分钟自动协调。包导入本身不执行代码、不改变更新策略、不激活版本。

## 验证与激活

- 包签名绑定完整 payload 字节，包括清单、文件路径与文件内容；宿主校验发布者插件范围，拒绝路径穿越、大小写歧义及超量文件。登记后的版本由已有内容寻址存储保护。
- 报告更新必须先通过 health 身份检查，再在临时目录生成宿主固定样例。独立 Python/PyPDF 读回核对中文标题、任务 ID、FAIL 判定、页数和宿主计算的 PDF 摘要，并检查未审批任务被拒绝。验证结果绑定插件包与本机 Python 环境摘要。
- 签名 Icepak 包可以登记，但仍不进入自动激活集合；后续需要宿主工程副本、参数读回与真实求解验证器。签名证明来源，不证明仿真兼容。
- 更新关闭时保留当前受信版本；回退保持状态仍生效。忙碌作业使用原租约，新版本验证失败会隔离并选择可用旧版本。
- 签名原件保存在 `plugins/releases`；每次环境协调重新验证当前发布者策略。删除或收缩公钥范围后，该发布者包不再进入候选集合，自动更新开启时回到可用受信版本。检查周期内及已持有的运行租约不强行中断。

## 当前边界

签名 envelope 为 `{schemaVersion:1,publisherId,payload,signature}`，payload/signature 使用标准 Base64。签名算法 Ed25519，签名原文为 payload 解码后的原始字节。payload 为 `{schemaVersion:1,publishedAt,files}`，files 把相对路径映射为文件内容 Base64。不得重新序列化 payload 后再校验签名。

单个 JSON 包上限 48 MiB，解码文件总量上限 32 MiB，文件最多 2000 个。离线 inbox 一次最多扫描 200 个签名原件。包不包含也不安装 Python 依赖；依赖隔离与网络更新源尚待实现。

发布者配置属于本机管理员配置，不提供给 DSH 修改的业务工具。DSH 当前仍具有同用户的通用文件能力，这不是对恶意同权限进程的 OS 隔离。自主生成代码的执行隔离和授信流程仍未交付，不可把自签名候选当成可信发布版本。

当前报告 fixture 覆盖基础渲染与审批语义，并非完整业务回归；真实 Windows 打包运行、字体兼容和 AEDT 验收仍须另行完成。
