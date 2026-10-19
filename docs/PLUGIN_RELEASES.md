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

## HTTPS 自动更新源

管理员可在 `<THERMAL_AGENT_HOME>/plugins/update-sources.json` 配置最多五个 HTTPS 目录：

```json
[{ "id": "company", "url": "https://updates.example.com/thermal/index.json" }]
```

示例域名需替换为实际部署地址。客户端不预设公共更新服务器，也不把更新源当成新的发布者公钥。DSH 只能触发已有策略下的检查，不能通过业务工具新增源或授信。

发布目录与签名包置于同一 HTTPS origin，可用脚本生成目录文件，再由现有发布系统部署：

```sh
node scripts/create-plugin-update-catalog.mjs /releases/new-index.json /releases/report-release.json
```

脚本只写新文件，不覆盖已有目录；发布时将其部署为 `index.json`。目录格式为：

```json
{
  "schemaVersion": 1,
  "releases": [
    { "url": "report-release.json", "sha256": "完整签名包 JSON 文件的 SHA-256" }
  ]
}
```

SHA-256 绑定下载的完整 envelope 字节，公钥签名另外绑定 payload。目录本身不授予代码信任，不允许跨 origin 包地址、URL 内用户名密码、HTTP 降级或重定向。下载不发送浏览器 Cookie。

启动协调先准备本地插件，之后获取目录；慢网络不阻止已经就绪的本地运行时。自动更新关闭时不联网，仍检查本地环境和当前版本。下载成功后才重新走宿主验证和空闲激活；断网、错误签名及坏版本均不删除已安装版本。重启后缓存会重验签名与内容完整性，不只按文件名判断已下载。

每个目录最多 64 KiB / 50 个包，每轮最多尝试为 10 个包补齐代码或依赖；JSON 包体读取预算 96 MiB（目录另计），独立 wheel 资产传输预算 2 GiB。JSON 单请求 15 秒、资产请求 5 分钟、整轮 10 分钟超时。失败包在当前进程内等待 15 分钟再试，其他候选仍可继续；重启不保留该等待计时。关闭 App 或关闭自动更新会取消正在进行的请求。设置页与 DSH 状态接口展示检查结果、资产传输进度及源 ID，不展示可能含令牌的源 URL。

## 验证与激活

需要独立依赖的包使用 `hostApi: 2` 和 `pythonRuntime` wheel 锁；超过小包容量的 wheel 使用 API 3 的 `asset.sizeBytes` 声明。发布工具把外部资产输出到签名包同级 `assets/<sha256>.whl`，HTTPS 部署时须包含该目录。单个资产最多 256 MiB，单包资产合计最多 1 GiB。详见 [独立 Python 依赖](PLUGIN_PYTHON_ENVIRONMENTS.md)。旧 API 1 插件继续使用基础运行时。

- 包签名绑定完整 payload 字节，包括清单、文件路径与文件内容；宿主校验发布者插件范围，拒绝路径穿越、大小写歧义及超量文件。登记后的版本由已有内容寻址存储保护。
- 报告更新必须先通过 health 身份检查，再在临时目录生成宿主固定样例。独立 Python/PyPDF 读回核对中文标题、任务 ID、FAIL 判定、页数和宿主计算的 PDF 摘要，并检查未审批任务被拒绝。验证结果绑定插件包与本机 Python 环境摘要。
- 签名 Icepak 包默认仅登记。Windows 客户端显式配置工程样例与求解授权后，可对限定能力包执行工程副本、独立参数读回与双求解比较，再决定是否激活；详见 [工程升级验证](ENGINEERING_PLUGIN_VALIDATION.md)。签名证明来源，不证明仿真兼容。完整 CAD/风扇能力包仍待对应验证器。
- 更新关闭时保留当前受信版本；回退保持状态仍生效。忙碌作业使用原租约，新版本验证失败会隔离并选择可用旧版本。
- 显式回退独立检查目标旧版本，不要求当前坏版本先恢复就绪，也不会先自动升级后再回退。重新采集基础环境、准备旧版本对应的依赖环境，且必须已有匹配该环境的通过记录；环境变化、旧包损坏、发布者失效或任务占用都会阻止切换。当前包损坏或已隔离时，自动更新关闭也可手动恢复已验证的旧版本；成功后清除不可用诊断与重试等待并保持回退版本。
- 签名原件保存在 `plugins/releases`；每次环境协调重新验证当前发布者策略。删除或收缩公钥范围后，该发布者包不再进入候选集合，自动更新开启时回到可用受信版本。检查周期内及已持有的运行租约不强行中断。

## 当前边界

签名 envelope 为 `{schemaVersion:1,publisherId,payload,signature}`，payload/signature 使用标准 Base64。签名算法 Ed25519，签名原文为 payload 解码后的原始字节。payload 为 `{schemaVersion:1,publishedAt,files}`，files 把相对路径映射为文件内容 Base64。不得重新序列化 payload 后再校验签名。

单个 JSON 包上限 48 MiB，解码文件总量上限 32 MiB，文件最多 2000 个。离线 inbox 一次最多扫描 200 个签名原件。API 2 可携带离线 wheel，API 3 可引用签名锁绑定的外部 wheel；资产只在验签后下载，安装过程仍禁止网络和源码构建。网络传输测试使用临时证书的真实 TLS 服务，未验收客户代理、私有 CA 部署、完整 Windows PyAEDT 依赖闭包或真实生产更新站点。已完成资产缓存按版本和历史引用保留，空闲时回收过期无引用资产，规则见 `PLUGIN_PYTHON_ENVIRONMENTS.md`。

发布者配置属于本机管理员配置，不提供给 DSH 修改的业务工具。DSH 当前仍具有同用户的通用文件能力，这不是对恶意同权限进程的 OS 隔离。自主生成代码的执行隔离和授信流程仍未交付，不可把自签名候选当成可信发布版本。

当前报告 fixture 覆盖基础渲染与审批语义，并非完整业务回归；真实 Windows 打包运行、字体兼容和 AEDT 验收仍须另行完成。
