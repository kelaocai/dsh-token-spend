# dsh-token-spend

**实时查看本会话消耗的 Token 与花费金额** · Live per-conversation token usage and cost in the DeepSeek Harness composer, priced with DeepSeek's official peak / off-peak rates.

在聊天输入框上方的统计行里，内置的「活动」「用量」旁边会多一个 **`(¥) 1.56 · 37M`** 形式的控件：实时显示当前会话消耗的 Token 和按官方价格估算的人民币花费。点击展开明细：缓存命中 / 未命中 / 输出的 Token 与金额、缓存命中率、高峰 / 空闲时段金额、按模型汇总。

- **实时**：每一轮模型调用结算后立即刷新（与内置 usage 统计同一数据节奏），无需刷新页面。
- **区分时段**：高峰为北京时间工作日 09:00–12:00、14:00–18:00，其余（含周末）按空闲价；空闲价是高峰价的一半。
- **准确**：Token 来自 provider 上报的 usage（与内置 `tokenUsage` 完全一致）；金额按每条调用发生时刻所属时段计价。
- **可配置**：价格、币种、时段、法定节假日、未知模型兜底价都可在 profile patch 中覆盖。
- **纯本地**：不联网、不上传任何数据；只读取当前会话已提交的 Session 事件。

## 安装

### 方式一：市场索引（推荐，一键安装）

1. 在 DSH「插件」页启用实验插件 **自定义插件索引**（`@deepseek-ai/dsh-experimental-plugin-market-bundle`）。
2. 打开「发现」页 → **添加索引源**，粘贴：

```text
https://cdn.jsdelivr.net/gh/kelaocai/dsh-token-spend@main/market/index.json
```

（备用地址：`https://raw.githubusercontent.com/kelaocai/dsh-token-spend/main/market/index.json`）

3. 搜索 `dsh-token-spend`，点击安装。

### 方式二：从 GitHub 仓库安装

```bash
dsh plugin add git+https://github.com/kelaocai/dsh-token-spend.git
```

然后在「插件」页启用 `dsh-token-spend` 这个 bundle（若命令行安装后未自动选中）。

### 方式三：npm（发布后）

```bash
dsh plugin add dsh-token-spend
```

> 需要 DSH **0.2.2-rc.1 或更高版本**（依赖会话投影与 composer dock 槽位）。

## 配置价格

安装后可直接使用内置的 DeepSeek 官方价格。需要改价时，在 profile 的 `cordis.patch.yml`
（`~/.dsh/profiles/<profile>/cordis.patch.yml`）追加：

```yaml
- id: token-spend
  config:
    currency: '¥'
    timeZone: Asia/Shanghai
    peakWeekdays: [1, 2, 3, 4, 5]
    peakWindows:
      - [9, 12]
      - [14, 18]
    # 官方规则里法定节假日全天按空闲价，但插件不内置节假日日历；需要时逐日补充
    holidays: ['2026-10-01', '2026-10-02']
    models:
      deepseek-flash:
        peak: { cacheMiss: 2, cacheHit: 0.04, output: 8 }
        offPeak: { cacheMiss: 1, cacheHit: 0.02, output: 4 }
      deepseek-v4-pro:
        peak: { cacheMiss: 9, cacheHit: 0.3, output: 27 }
        offPeak: { cacheMiss: 4.5, cacheHit: 0.15, output: 13.5 }
    # 未知模型的兜底价；不配置则该模型只显示 Token、不计金额
    fallback:
      peak: { cacheMiss: 1, cacheHit: 0.01, output: 2 }
      offPeak: { cacheMiss: 0.5, cacheHit: 0.005, output: 1 }
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `currency` | `¥` | 金额前缀 |
| `timeZone` | `Asia/Shanghai` | 判定高峰/空闲所用时区 |
| `peakWeekdays` | `[1,2,3,4,5]` | 高峰星期（0=周日） |
| `peakWindows` | `[[9,12],[14,18]]` | 高峰小时区间，左闭右开 |
| `holidays` | `[]` | `YYYY-MM-DD`，当日全天按空闲价 |
| `models` | 内置 DeepSeek 价格 | 键为模型 id，或用 `provider/model` 精确覆盖 |
| `fallback` | `null` | 未知模型的兜底费率；`null` 表示不计金额 |

改价不需要迁移历史数据：投影状态只保存 Token 计数，金额在发布给客户端时计算。

## 默认价格（元 / 百万 tokens）

来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)。

| 模型 | 输入（缓存命中）峰/闲 | 输入（缓存未命中）峰/闲 | 输出 峰/闲 |
| --- | --- | --- | --- |
| `deepseek-flash` | 0.04 / 0.02 | 2 / 1 | 8 / 4 |
| `deepseek-v4-pro` | 0.30 / 0.15 | 9 / 4.5 | 27 / 13.5 |

`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 等历史别名按 flash 价格计费。DeepSeek 不单独收取缓存写入费用；若 provider 上报了 `cacheWriteTokens`，默认按缓存未命中价格计，可用 `cacheWrite` 覆盖。

## 实现与隐私

- **Host 半**注册一个 `tokenCost` 会话投影，折叠 `assistant/message`、`assistant/attempt`、`model/selection` 事件，按「模型 × 高峰/空闲」累计 Token；投影状态随会话 checkpoint 持久化，可回放历史会话。
- **浏览器半**在 `conversation.composer.dock` 注册一个控件，读取 `useProjection('tokenCost')` 渲染；没有 Host 半时退化为只显示 Token。
- 插件只读 Session 事件，无网络请求、无遥测、不写文件、不调用模型；卸载后所有注册随插件 fiber 一起释放。

## 已知边界

- 只统计**当前会话**的模型调用。子代理会话是独立的 Session，其花费不计入父会话；联网搜索/抓取按次计费（¥5/1000 次）也不在 Token 计费范围内。
- 金额是按公开单价的**估算**，不等于平台账单（赠送额度、价格调整、实际扣费以平台为准）。
- 依赖 provider 上报 usage；未上报 usage 的模型调用无法计入（内置 `tokenUsage` 同理）。
- 法定节假日需要手动配置 `holidays`，否则按「工作日 + 时段」规则计算。

## 开发

```bash
node --test "test/*.test.mjs"   # 折叠、时段、计价、schema 的纯函数测试
```

文件结构：

| 文件 | 职责 |
| --- | --- |
| `pricing.js` | 纯逻辑：配置归一化、高峰判定、事件折叠、价格视图、投影 schema（无依赖，可直接用 Node 测试）。 |
| `index.js` | Host 插件入口：向 `ctx.sessionProjections` 注册 `tokenCost` 投影。 |
| `client.js` | 浏览器半：composer dock 控件 + 明细弹层，无需构建。 |
| `cordis.patch.yml` | Bundle patch：挂载 Host 行并给出默认定价。 |
| `market/index.json` | DSH 插件市场索引（format 1），可在「发现」页作为索引源添加。 |
| `test/` | `node:test` 单元测试。 |

欢迎 Issue / PR。

## English

`dsh-token-spend` adds one control to the DeepSeek Harness composer dock that shows the current Session's token usage and an estimated CNY cost, computed from the official DeepSeek list prices with peak / off-peak tariffs. Click it for a breakdown (cache-hit / cache-miss input, output, cache hit rate, peak vs off-peak money, per-model rows).

- Real-time: refreshes as each model call settles, via a per-Session `tokenCost` projection.
- Accurate tokens: reads provider-reported usage, matching the built-in `tokenUsage` control.
- Configurable prices, currency, time zone, peak windows, holiday dates, and a fallback tariff for unknown models.
- Fully local: no network, no telemetry; it only folds the Session log.

Install from the market index URL above, from this Git repository (`dsh plugin add git+https://github.com/kelaocai/dsh-token-spend.git`), or from npm once published (`dsh plugin add dsh-token-spend`). Requires DSH 0.2.2-rc.1 or newer.

MIT licensed.
