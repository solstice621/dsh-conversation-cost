# Cost for DeepSeek Harness

[![CI](https://github.com/solstice621/dsh-conversation-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/solstice621/dsh-conversation-cost/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

在 DeepSeek Harness 桌面版中查看**每轮回答费用**与**当前会话累计费用**。自动读取模型价格，常驻界面只显示 `Cost ≈$x`，点击再看单价与用量明细。

独立社区插件，包名 **`dsh-conversation-cost`**。无需新增 API key，无运行时 npm 依赖，不修改 App 或 asar，可独立停用、卸载。

## 显示效果

每轮回答结束后，顺序为 **用量 → Cost → 时间**：

![每轮回答的费用位于用量后、时间前](docs/screenshots/answer-footer.png)

输入框下方显示整个会话的累计金额：

![会话累计费用](docs/screenshots/conversation-cost.png)

点击任一 Cost，查看对应范围的模型、四类 Token、单价和价格来源：

![本轮回答的费用明细](docs/screenshots/answer-details.png)

截图仅包含插件界面，未包含对话正文或账号信息。

## 安装

已验证 **macOS + DeepSeek Harness Desktop `0.2.1-rc.3`**。插件不设宿主版本门槛，启动时检查会话读取和认证 Fetch 接口；其他宿主版本和操作系统尚未完成桌面验证。

1. 在 Harness 左侧打开「插件」→「添加插件」。
2. 填写以下地址，安装并启用：

   ```text
   github:solstice621/dsh-conversation-cost#main
   ```

3. 若当前窗口尚未出现 Cost，刷新 Harness 界面；仍未出现时完全退出并重新打开。
4. 打开一个已有会话，即可看到累计费用和已完成回答的逐轮费用，无需为验证功能重新发送模型请求。

固定安装源码时，可将 `#main` 替换为指定提交 SHA；已有 tag 使用各自的旧版声明。插件直接提供可运行的 JavaScript，无需构建或执行第三方安装脚本。

本地打包、CLI 安装、更新与卸载步骤见 **[安装说明](docs/INSTALL.md)**。

## 功能

| 功能 | 行为 |
| --- | --- |
| 每轮回答费用 | 汇总该轮已记录的各次模型调用，不混入其他轮次；费用位于用量后、时间前 |
| 会话累计费用 | 输入框下方显示当前会话自己的累计金额，不重复计入 fork 继承的上下文 |
| 简洁标签 | 显示 `Cost ≈$x`；加载、读取失败、未计价分别标识；后台校验时保留金额，不添加更新状态提示 |
| 费用明细 | 点击后查看模型、普通输入、缓存读取、缓存写入、输出和对应单价 |
| 自动价格同步 | 启动读取，随后每 6 小时刷新；明细中也可手动同步 |
| 离线回退 | 同步失败保留最近成功的缓存；首次离线使用随包公共价格快照 |
| 多模型与分档 | 每次调用采用自己的模型与价格，上下文档位按该次完整输入选择 |
| 共用请求 | 同一会话的回答标记与累计费用共享读取结果，不为每条回答单独创建轮询 |
| 本地费用缓存 | 本地保存精简用量快照，先展示缓存，后台校验；新用量增量更新并自动落盘 |

## 价格从哪里来

| 渠道 | 价格来源与匹配规则 |
| --- | --- |
| `deepseek`、`deepseek-official`、`deepseek-account` | [DeepSeek 官方定价页](https://api-docs.deepseek.com/quick_start/pricing/)，按调用时间应用峰谷、周末和中国节假日规则 |
| 其他 API 渠道 | [models.dev 公共目录](https://models.dev/api.json)，精确匹配 `provider/model`；不会因模型名相似而借用其他渠道的价格 |
| `codex-subscription`、`openai-codex` | 使用 models.dev 中同模型的 OpenAI API 价格计算订阅参考价值 |
| `opencode-go-subscription`、`opencode-go` | 优先读取 models.dev 的 Go 同模型价格；缺价时仅可使用 OpenCode Zen **相同模型 ID** 的 API 参考价，并在明细中注明参考路由 |

支持独立安装，也可搭配 [OpenAI / Codex Auth](https://github.com/solstice621/dsh-openai-auth) 和 [OpenCode Go Auth](https://github.com/solstice621/dsh-opencode-go-auth)。本插件不依赖它们的授权流程，也不负责登录或查询订阅额度。

## 金额如何计算

以每百万 Token 的单价计算每条用量记录，再汇总到对应回答和会话：

```text
金额 =（普通输入 × 输入单价
      + 缓存读取 × 读取单价
      + 缓存写入 × 写入单价
      + 输出 × 输出单价）/ 1,000,000
```

推理 Token 已包含在输出中，不重复相加。分档依据该次请求的普通输入、缓存读取和缓存写入之和。单次金额保留计算精度，最终显示四位小数；极小的正数显示小于 `$0.0001`。

金额统一为 **美元 USD**，不进行汇率换算。常驻标签合计 API 估算与订阅等值，明细将两者分开。**订阅等值是 API 价格折算的参考价值，不代表订阅实际扣款。**

### 统计范围

- 使用原始日志中 `assistant/message` 回报的有效 `usage`；优先采用消息的真实 provider/model，缺失时使用请求头。
- 会话金额只计本会话自己的记录，不合并子会话，不重复计入 fork 继承的历史。
- 每轮金额包含该轮中已记录的各次助手调用；分页和折叠不会把累计金额截断成屏幕上可见的部分。
- 缺失单价或用量会在明细标出覆盖缺口；部分缺价时标签只合计可计算的金额，全部缺价时显示 `Cost 未计价`。
- 工具按次费用、会话标题等辅助调用，以及没有形成有效助手用量记录的失败尝试不保证纳入。
- 历史用量使用**当前价格重估**；价格更新可能改变旧会话的估算，本插件不保存历次账单或历史价格版本。

因此，这个金额适合查看用量对应的成本量级，不是平台账单。

## 数据与网络

会话用量通过宿主的 `sessionQuery` 按需读取。精简快照持久化在本地，不保存原始事件、对话正文、工具结果、密钥或模型 replayState：

```text
<DSH_HOME>/cache/dsh-conversation-cost/prices.json
<DSH_HOME>/cache/dsh-conversation-cost/sessions/<sessionId>.json
```

费用快照保存会话 ID、模型标识、四类 Token、时间、归属轮次、已统计游标和 fork 继承边界。目录权限为 0700、文件为 0600（支持 POSIX 权限的系统），500ms 合并原子写入，宿主 durability checkpoint、退出及 LRU 淘汰时刷新待保存记录。首次 live 用量可直接使用内存会话快照建立账本；正常退出给已开始的首次读取最多 2 秒完成窗口，超时仍只保留旧有效快照，完整会话日志保持为权威来源。每个快照上限为 16MiB；损坏、不匹配或过大的缓存会被忽略并重新读取，不影响会话本身。只读/写入失败保留内存结果及上一份有效磁盘快照。

首次打开先显示缓存金额，不额外显示更新状态提示；后台在进程重启、LRU 淘汰、事件缺口、会话关闭后校验完整日志；已打开的静默会话最多每 5 分钟做一次后台校验，以发现删除或修复。正常会话依靠新用量事件增量累计，界面轮询只读内存汇总。同一账本及价格未变化时复用汇总，不重复扫描用量。缓存不是账单：价格更新会重新计价；校验后修正已修复/截断的历史，排除 fork 继承。宿主明确返回会话不存在时会清除对应旧快照，仅留下会话 ID 和删除时间的标记，防止迟到写入恢复已删除用量。费用缓存不重用已删除的会话 ID；恢复/导入会话时应使用新的会话 ID。每会话的文件锁覆盖读/比较/原子写入与删除；锁等待最多 2 秒，使用单调时钟；失败时不破坏旧快照。进程崩溃留下的 `.json.lock` 不会自动偷取，以避免跨进程竞态；确认没有任何写入者后可手动清理该会话的残留锁，期间内存计价及旧缓存读取仍可用。更新时间用于处理跨实例较旧写入，系统时钟显著回拨时仍依靠后续完整日志校验纠正。

加载和费用读取异常仅记录固定错误码及会话 ID，不记录异常中的对话内容。

无需读取账号凭据，不修改授权插件、默认模型或原有 Token 统计。出站请求仅用于读取 models.dev、DeepSeek 官方定价页，以及按需读取的 [holiday-cn](https://github.com/NateScarlet/holiday-cn) 年度日历，不上传对话、用量或凭据。随包快照目前含 2026 年日历；没有可用日历的年份不会猜测 DeepSeek 峰谷价。

宿主接口沿用原生 `connection.fetch` 的认证与 Host/Origin 检查：

- `GET /api/conversation-cost?sessionId=…`：会话总计、各轮总计、价格更新时间和 `cache` 元数据（状态、统计游标、更新时间）。已有快照立即返回，后台校验。
- `GET /api/conversation-cost?sessionId=…&cached=1`：仅读取本地/内存快照，不重放会话；没有快照返回 404。
- `POST /api/conversation-cost/prices/refresh`：刷新公共价格。

## 常见问题

**为什么显示加载中、暂不可用或未计价？**

尚无本地数据时显示加载中；首次读取失败显示暂不可用，点击即可重试。模型缺价或有效用量完全缺失时显示未计价，可点击明细检查。存在缓存时，即使读取失败仍保留金额，后台继续校验和重试，不显示额外更新状态提示。缓存金额可能暂未包含最新调用，校验完成后自动刷新。缺价不会当成免费；价格来源恢复后也可点击「立即同步价格」。

**为什么模型和插件都升级了，旧回答的 ID 仍然不同？**

历史记录保留当时调用的模型。Go 缺少旧 ID 时会尝试同名 Zen API 参考价，但不会把旧模型当成新版本计价；参考路由会明确显示。

**能否修改币种或隐藏某个 Cost？**

当前版本固定显示美元，同时提供逐轮和会话累计两个入口，尚未提供额外显示设置。

## 开发与验证

```sh
git clone https://github.com/solstice621/dsh-conversation-cost.git
cd dsh-conversation-cost
npm ci --ignore-scripts
npm test
npm run check
```

测试无需真实账号或付费模型请求。CI 在 Node.js 20、22、24 上运行单元测试与包检查；桌面验证记录、覆盖边界和目录结构见 [测试说明](docs/TESTING.md)。

## License

[MIT](LICENSE)。随包公共价格和节假日数据的来源与许可见 [第三方声明](THIRD_PARTY_NOTICES.md)。
