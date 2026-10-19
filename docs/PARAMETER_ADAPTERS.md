# 插件参数适配协议

Icepak 插件 `0.2.1` 引入 `AdapterRegistry`。新增参数不再需要给 Core 类型、React 输入控件或 Python 写入/读回流程增加类型分支。扩展代码仍属于一个受管插件版本，不会从目录数据动态导入 Python 模块。

## 参数描述

现有 `id / target / currentValue / fingerprint / unit / role` 继续绑定被检查的工程对象。新增字段：

```json
{
  "adapter": "surface-emissivity",
  "adapterVersion": "1.0.0",
  "adapterLabel": "表面辐射",
  "valueSchema": {
    "version": 1,
    "type": "number",
    "minimum": 0,
    "maximum": 1,
    "defaultValue": "0.9",
    "hint": "表面发射率范围 0–1"
  }
}
```

这是扩展示例，不代表当前已实现真实 AEDT 表面发射率修改。

Schema v1 支持 `number` 和 `enum`。数值沿用描述中的精确单位，允许 `minimum / maximum / exclusiveMinimum`；枚举使用 `values`。`defaultValue` 与 `hint` 用于界面。宿主不执行来自目录的脚本、表达式或正则。未知 Schema 版本或字段、非有限范围、重复参数 ID、缺少适配器版本等会被拒绝。

已有四类参数的历史目录可继续读取：宿主集中将旧 `min / max / choices` 和风扇比值限制解释为 Schema。新适配器必须声明 Schema，不能依赖旧类型默认规则。旧任务仍使用其锁定的插件代码，不能因为新版本注册了新参数，就自动改用新版本解释旧工程。

## Python 注册

可信插件启动代码向 `parameters.DEFAULT_REGISTRY` 注册 `ParameterAdapter(id, version, label, discover, apply, readback)`：

- `discover(ipk)` 返回该适配器的参数描述，参数 ID 必须以适配器 ID 加冒号开头。注册表填入适配器身份、版本和名称，并校验描述与 Schema。
- `apply(ipk, parameter, value)` 修改工程副本，返回供读回使用的辅助证据，不能替换宿主生成的前后值、参数身份或验证状态。
- `readback(ipk, parameter, result)` 从重新打开的工程读取实际值。框架比较实际值与请求值，成功后才标记 `verified`。枚举按字符串精确比较，数值按已有数值容差比较。

整批修改必须先重新发现目录并验证后才能开始写入；任何参数身份、适配器版本、Schema、原值、单位或工况用途变化都会中止。工况参数不能伪装为结构优化，仍须建立新的 Baseline。

Core 还会按相同 Schema 核对回执中的 `verifiedAfter` 是否等于请求值，拒绝“verified 为真但读回值不同”的矛盾证据。这是回执一致性检查，不替代未来独立的工程兼容性验证器。

内置变量、材料、总功率和风扇适配器已通过注册表执行。风扇曲线仍专门核对保存后读回的 X/Y 数组，不把回显的比值当成持久化证据。

## 验证范围与剩余工作

测试覆盖插件扩展经 Core 目录与不可变参数方案传递、浏览器根据 Schema 编辑、批量修改前拒绝篡改，以及 Python 独立重载后发现丢失写入。模拟测试不能证明真实 AEDT 版本兼容。

签名 Icepak 新版本目前仍只登记候选；还需要宿主工程样例验证器、可信隔离执行及真实 Windows 求解证据，才能完成客户端自主适配升级。当前 Schema 也尚不支持数组、曲线、对象选择或复杂约束；这些需以显式协议演进加入。
