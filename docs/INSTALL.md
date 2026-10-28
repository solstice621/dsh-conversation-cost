# 安装、更新与卸载

## 前提

- 已验证 macOS 上的 DeepSeek Harness Desktop `0.2.1-rc.3`。
- 宿主需提供 `connection`、`sessionQuery`、原生会话统计和回答操作插槽。
- 插件自身无需 API key，也不建立模型连接。请沿用你已有的 DeepSeek 或其他模型渠道。
- 安装包直接包含 Host 与 Client JavaScript，不需要编译、`prepare` 或 `postinstall`。

其他宿主版本、Linux 和 Windows 尚未完成桌面验证。`engines.dsh` 的声明范围不等同于每个版本都已验证。

## 桌面版：从 GitHub 安装

1. 打开 Harness 左侧「插件」。
2. 点击「添加插件」。
3. 填写固定版本地址：

   ```text
   github:solstice621/dsh-conversation-cost#v0.1.5
   ```

4. 安装完成后启用插件。
5. 刷新 Harness 界面。若尚未载入新模块，完全退出并重新打开。
6. 打开已有会话：输入框下方显示会话累计 Cost；每轮已完成回答的末尾按「用量 → Cost → 时间」排列。

点击回答旁的 Cost 查看该轮明细；点击输入框下方的 Cost 查看会话明细。安装后会读取已有日志，不需要发送收费请求验证。

想跟随最新源码时可使用：

```text
github:solstice621/dsh-conversation-cost#main
```

也可将 `main` 替换为指定提交 SHA，以固定到可复现的源码版本。

## 本地打包后安装

本机开发需 Node.js `>=20.3.0` 和 npm；桌面运行使用 Harness 自带的环境。

```sh
git clone https://github.com/solstice621/dsh-conversation-cost.git
cd dsh-conversation-cost
git checkout v0.1.5
npm ci --ignore-scripts
npm test
npm run check
npm pack --ignore-scripts
```

生成 `dsh-conversation-cost-0.1.5.tgz`。在「插件 → 添加插件」中填写它的**绝对路径**并启用，例如：

```text
/absolute/path/to/dsh-conversation-cost/dsh-conversation-cost-0.1.5.tgz
```

开发测试文件保留在 Git 仓库；安装包只包含运行入口、公共价格快照、许可证和说明文档。

## 可选：CLI profile

如果你已经通过 `dsh` CLI 管理 profile，可以使用同一个 bundle：

```sh
dsh plugin --profile web add github:solstice621/dsh-conversation-cost#v0.1.5
```

停止并重新启动对应的 `web` profile 后查看界面。这里的 `web` 只是示例；改为你实际使用的 profile。

此命令遵循 Harness 的原生 bundle 安装接口；本仓库完成的实际安装和界面验证针对 Desktop profile。桌面用户优先使用「插件」页面，避免把插件装入另一套未运行的 profile。

## 更新

1. 在「插件」页面定位 `dsh-conversation-cost`。
2. 若当前安装来源为 `#main`，可通过宿主的更新入口更新该插件。
3. 若固定在 `#v0.1.5`，此地址始终指向同一版本。切换到新的版本标签或提交地址，不能仅靠刷新界面更新。
4. 宿主若不允许直接更换来源，可先卸载该插件，再添加新的 GitHub 地址或本地 `.tgz`。
5. 安装后刷新界面；宿主提示需要重启时，完全退出并重新打开。

不需要更换现有账号、API key 或默认模型。

## 停用与卸载

在「插件」页面单独停用或卸载 `dsh-conversation-cost`。这会移除 Cost 界面和后台价格刷新，不影响模型授权插件、会话日志或原有 Token 统计。

公共价格缓存可能保留在 `<DSH_HOME>/cache/dsh-conversation-cost/`。如需完全清理，可在插件停用后删除此目录；其中没有账号凭据和会话正文。

## 排查

| 现象 | 检查方法 |
| --- | --- |
| 看不到任何 Cost | 确认插件已启用且宿主版本符合要求；刷新或重启 Harness，并打开已有会话 |
| 回答尚未显示单轮 Cost | 单轮入口在回答完成后出现；确认该轮有记录到助手消息及用量 |
| 显示 `Cost ≈—` | 等待读取，或点击查看缺价/缺少用量的原因；尝试「立即同步价格」 |
| 目录同步失败 | 确认宿主能访问 models.dev 与 DeepSeek 文档；失败会保留上次价格，无需重新授权 |
| 旧 Go 模型没有价格 | 仅在同名 Zen API 价格存在时使用参考价，明细会注明；无法匹配时保留未计价状态 |
| 更新后还是旧界面 | 确认安装来源确实变更，再刷新或完全重启；固定标签不会自动变成新版本 |

如需报告问题，请在 [Issues](https://github.com/solstice621/dsh-conversation-cost/issues) 中提供 Harness 版本、插件版本、provider/model ID 和脱敏截图；不需要 API key、Cookie 或对话正文。
