# Poly Model Bridge for Copilot

将你的第三方模型中转站接入 GitHub Copilot Chat 的模型选择器。

Poly Model Bridge 是一个轻量的本地 VS Code 扩展，适用于 Anthropic、OpenAI 兼容网关、Sub2API、One-API、New-API、国产模型中转站以及本地模型服务。配置、密钥、模型和协议都可以在可视化界面中管理。

![Poly Model Bridge](icon.png)

## ✨ 功能一览

- **可视化管理界面**：不需要手写 JSON，在左侧 PolyBridge 活动栏直接打开
- **三种请求格式**：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses
- **每个模型独立设置格式**：同一个中转站内可以同时使用不同接口格式
- **多种推理强度**：支持 `minimal`、`low`、`medium`、`high`、`xhigh`、`max` 以及自定义档位
- **上下文长度下拉选择**：32K、64K、128K、200K、400K、1M，也支持自定义值
- **思考 / 推理模式**：按协议请求 Anthropic 自适应思考或 Responses 推理摘要
- **工具调用和图片输入**：可用于 Copilot Agent 和多模态模型
- **Anthropic 缓存兼容**：支持 `off`、`5m`、`1h`，兼容 Sub2API 等网关的缓存策略
- **API Key 安全存储**：使用 VS Code SecretStorage，不写入 settings.json，也不会发送到 Webview
- **自动发现模型**：可以从中转站的模型列表接口读取可用模型
- **中转站重命名自动迁移密钥**：避免修改名称后丢失 API Key
- **Copilot 路由**：把子 Agent 和后台辅助请求也指向中转站模型，避免误用 Copilot 订阅额度

## 🚀 快速开始

### 1. 打开管理界面

安装扩展后：

1. 点击 VS Code 左侧活动栏的 **PolyBridge** 图标
2. 点击 **打开管理界面**
3. 点击 **添加中转站**

也可以使用命令面板运行 **Poly Model Bridge: Open Manager**，或点击底部状态栏的 PolyBridge 按钮。

### 2. 添加中转站

填写：

| 项目 | 填写说明 |
|---|---|
| 名称 | 自己起一个容易识别的名称，例如“我的 Claude 中转站” |
| 接口地址 | 中转站提供的网址，例如 `https://api.example.com` |
| 接口格式 | 不确定时优先选择 Anthropic；OpenAI 网关通常选择 Chat Completions |
| API Key | 点击“填写密钥”，密钥只保存到 VS Code 安全存储中 |

### 3. 添加模型

点击 **向中转站查询可用模型**，扩展会尝试从中转站读取模型列表。

如果中转站不提供模型列表接口，也可以点击 **手动添加模型**，填写中转站文档中的模型编号。

### 4. 在 Copilot 中启用模型

打开 Copilot Chat 的模型选择器，进入 **Manage Models**，勾选 Poly Model Bridge 下的模型。

之后即可在 Chat、Edits 和 Agent 模式中使用。

## 🧠 推理强度和思考模式

### 推理强度

不同模型支持的档位并不相同，不要盲目全部勾选。常见档位包括：

| 档位 | 通常含义 |
|---|---|
| `minimal` | 尽量少思考，速度快、成本低 |
| `low` | 较少推理，适合简单任务 |
| `medium` | 平衡速度和推理质量 |
| `high` | 更充分推理，适合复杂编码任务 |
| `xhigh` | 极高推理强度，仅部分模型支持 |
| `max` | 最高推理强度，仅部分模型或网关支持 |

中转站文档如果提供了其他名称，可以在“其他档位”中填写，例如 `auto`、`ultra`、`3` 等。插件会把所填名称原样传给中转站。

每个勾选的档位会在 Copilot 模型选择器中生成一个独立条目，例如 `GPT-5.5 (high)`。

### 开启推理 / 思考模式是什么意思？

这是一个**请求开关**，表示告诉上游模型“请启用推理能力”。它不是把模型的完整隐藏思维过程暴露出来：

- Anthropic：请求自适应思考，并将上游返回的思考摘要显示在聊天中
- OpenAI Responses：请求推理摘要
- OpenAI Chat Completions：通常主要使用上面的 `reasoning_effort`

如果你的模型或中转站不支持思考参数，请关闭此选项；遇到参数不支持的 400 错误时也应关闭。

## 🔌 三种接口格式

| 配置项 | 请求路径 | 常见场景 |
|---|---|---|
| `anthropic` | `/v1/messages` | Claude、Anthropic 兼容中转站 |
| `chat-completions` | `/v1/chat/completions` | OpenAI 兼容网关、绝大多数中转站、本地服务 |
| `responses` | `/v1/responses` | OpenAI Responses、Codex 类部署 |

扩展会根据接口格式自动补上请求路径。通常只需要填写中转站的基础网址。

## 🗄️ Anthropic 缓存时长兼容

如果中转站给系统提示词使用 `1h` 缓存，却默认给工具使用 `5m` 缓存，Anthropic 可能返回缓存顺序冲突的 400 错误。

此时可以将中转站或模型的缓存时长设置为 `1h`。Poly Model Bridge 会在最后一个工具上明确发送相同的缓存时长，让支持保留客户端参数的网关正确处理。

默认值是 `off`，适合普通 Anthropic API 或不会改写缓存的中转站。只有遇到缓存冲突时才建议调整。

## 🧭 Copilot 路由（避免误用订阅额度）

在模型选择器里选中中转站模型，只决定**主对话**用什么模型。Copilot 还有几类请求走的是另一套解析逻辑，默认会落到 GitHub 订阅模型上：

| 请求类型 | 默认行为 | 能否指向中转站 |
| --- | --- | --- |
| 后台辅助调用（应用代码块、生成标题、压缩历史等） | 使用 Copilot 订阅 | ✅ 可以，数量最多、影响最大 |
| 内置执行子 Agent | 固定使用 `gemini-3-flash` | ⚠️ 只能设为继承主会话模型 |
| 内置搜索子 Agent | 继承主会话模型 | ⚠️ 只能设为继承主会话模型 |
| 子 Agent 委派（`runSubagent`） | 继承主会话，但模型可自行指定 | ✅ 可指定，但模型可覆盖 |

打开管理界面的 **Copilot 路由** 面板即可统一设置，PolyBridge 会写入对应的 VS Code 设置。

关于子 Agent：VS Code 解析顺序是 **调用时自带的 `model` 参数 → 自定义 Agent 的 `model:` 字段 → 继承主会话**。面板里选好模型后点「生成子 Agent 文件」，会写出 `.github/agents/poly-subagent.agent.md`。

需要注意的是，模型在调用 `runSubagent` 时可以自带 `model` 参数，其优先级高于一切，客户端无法拦截；而 VS Code 给模型看的工具说明里写着 *vendor is usually "copilot"*，模型因此很容易选到订阅模型。「写入项目指令」按钮会在 `.github/copilot-instructions.md` 中生成一段说明来抵消这个倾向——这是引导，不是强制。若要彻底杜绝，可在自定义 Agent 中设置 `agents: []` 关闭子 Agent 能力。

由于 VS Code 按完整字符串精确匹配模型名，而「· 中转站名」后缀只在配置了多个中转站时出现，**增删中转站之后请重新生成上述文件**。命令 **Copy Model Reference（复制模型引用名）** 可以随时取到当前的正确写法。

## ⚙️ 高级 JSON 配置

普通用户无需编辑 JSON。熟悉配置文件的用户可以在 `settings.json` 中编辑 `polyBridge.providers`：

```jsonc
{
  "polyBridge.providers": [
    {
      "name": "我的中转站",
      "baseUrl": "https://api.example.com",
      "apiType": "anthropic",
      "anthropicCacheTtl": "off",
      "models": [
        {
          "id": "claude-sonnet-4-5",
          "name": "Claude Sonnet",
          "efforts": ["low", "medium", "high", "xhigh"],
          "thinking": true,
          "maxInputTokens": 200000,
          "maxOutputTokens": 16000,
          "toolCalling": true,
          "vision": true
        }
      ]
    }
  ]
}
```

### 常用模型字段

| 字段 | 说明 |
|---|---|
| `id` | 中转站文档中的模型编号，必填 |
| `name` | Copilot 模型列表中显示的名称 |
| `apiType` | 模型单独使用的接口格式，不填则跟随中转站 |
| `efforts` | 多个推理强度档位，每档生成一个模型选择项 |
| `effort` | 固定使用一个推理档位；有 `efforts` 时会被忽略 |
| `thinking` | 是否请求推理 / 思考模式 |
| `maxInputTokens` | 允许发送给模型的最大上下文长度 |
| `maxOutputTokens` | 单次回复最大生成长度 |
| `toolCalling` | 是否向 Copilot 声明支持工具调用 |
| `vision` | 是否向 Copilot 声明支持图片输入 |
| `url` | 该模型单独使用的完整请求地址，通常不需要填写 |

## ❓ 常见问题

### 模型没有出现在 Copilot 中

确认已经点击“保存设置”，然后在 Copilot Chat 模型选择器中打开 **Manage Models** 并勾选模型。必要时执行 **Developer: Reload Window**。

### 返回 401 或 403

检查 API Key 是否正确。Anthropic 通常使用 `x-api-key`，OpenAI 兼容网关通常使用 `Authorization: Bearer`；如果自动判断不适用，可以在界面中手动选择。

### 返回 `protocol_mismatch`

说明该模型使用的接口格式与配置不一致。打开模型的设置，将“接口格式”改成中转站文档要求的格式。

### 返回参数不支持的 400 错误

关闭模型的“开启推理 / 思考模式”，或清空不受支持的推理强度档位，然后重新保存。

### 行内补全是否支持这些模型？

VS Code 当前限制 BYOK 模型主要用于 Chat、Edits 和 Agent。行内补全仍使用 Copilot 自带模型。

## 🔐 隐私与安全

- API Key 使用 VS Code SecretStorage 保存
- API Key 不写入 `settings.json`
- API Key 不发送给 Webview
- 扩展只在你发起请求时连接你配置的中转站

## 📦 本地安装 VSIX

从 Releases 下载 `.vsix` 文件后，在 VS Code 扩展面板中选择右上角菜单 → **Install from VSIX...**。

## License

MIT

## Advanced: configure via settings.json

The UI and JSON edit the same setting (`polyBridge.providers`) — power users can edit directly:

```jsonc
{
  "polyBridge.providers": [
    {
      "name": "MyRelay",
      "baseUrl": "https://my-relay.example.com",
      "apiType": "anthropic",                    // provider default protocol
      "anthropicCacheTtl": "1h",                 // optional: align tool cache with a 1h gateway
      "models": [
        { "id": "claude-opus-4-8", "name": "Claude Opus 4.8", "efforts": ["high", "xhigh"] },
        { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "thinking": true },
        // per-model protocol override:
        { "id": "gpt-5.5", "name": "GPT-5.5", "apiType": "chat-completions", "efforts": ["low", "medium", "high"] }
      ]
    }
  ]
}
```

2. Command Palette → **Poly Model Bridge: Set API Key** → pick the provider → paste your key.
3. Copilot Chat model picker → **Manage Models** → tick the models under **Poly Model Bridge**.

## Model options

| Option | Default | Notes |
|---|---|---|
| `id` | — | Model ID sent to the endpoint (required) |
| `name` | `id` | Picker display name |
| `apiType` | provider's | Per-model protocol override |
| `efforts` | — | List of reasoning-effort variants → one picker entry each |
| `effort` | — | Single fixed effort (no suffix); ignored when `efforts` set |
| `thinking` | `false` | Anthropic: adaptive thinking (summarized); Responses: reasoning summaries |
| `anthropicCacheTtl` | provider's / `off` | Anthropic only: `off`, `5m`, or `1h`; per-model override for gateway cache-TTL compatibility |
| `maxInputTokens` / `maxOutputTokens` | 200000 / 16000 | Context window / `max_tokens` |
| `toolCalling` / `vision` | `true` / `true` | Capabilities advertised to Copilot |
| `maxTokensField` | `max_completion_tokens` | Chat Completions only; set `max_tokens` for older gateways |
| `url` | — | Full endpoint override for this model |

Provider options: `apiType`, `authHeader` (`x-api-key` \| `authorization`), `requiresApiKey: false` for local servers, `extraHeaders`.

### Anthropic cache-TTL compatibility

Anthropic processes cache breakpoints in `tools → system → messages` order and requires longer TTLs before shorter TTLs. A gateway that writes `system: 1h` but injects its default `tools: 5m` produces an invalid `5m → 1h` request. Set the provider's **Anthropic cache TTL compatibility** option to `1h` (Manage Providers → provider → Anthropic cache TTL compatibility), or configure `"anthropicCacheTtl": "1h"`. PolyBridge then explicitly marks only the last tool as `1h`; gateways such as Sub2API that preserve client-provided tool TTLs no longer replace it with 5m.

This option only affects Anthropic requests that contain tools. `off` sends no cache controls and remains the recommended default for endpoints that do not rewrite caching. A 1-hour cache write can cost more than a 5-minute write; match this setting to the gateway's actual policy.

## FAQ

**Models don't show up?** Check `polyBridge.providers` is set, run "Chat: Manage Language Models", reload the window if needed.

**401/403?** Try the other `authHeader` style — official Anthropic uses `x-api-key`, most OpenAI-style gateways use `Authorization: Bearer`.

**`protocol_mismatch` / provider errors on one model?** That model isn't served over the configured protocol by your gateway — set the correct per-model `apiType`.

**Inline completions?** VS Code limitation: BYOK models power Chat/Edits/Agent only; ghost-text completions keep using Copilot's built-in model.

---

# 中文说明

把任意第三方模型端点接入 GitHub Copilot 模型选择器，支持三种协议：**Anthropic Messages**、**OpenAI Chat Completions**、**OpenAI Responses**，可按模型混用；支持 Chat / Edits / **Agent 模式**。

亮点：像 Claude Code 一样**按模型配置多档 reasoning effort**（`"efforts": ["low","medium","high"]`），每档在选择器里是独立条目（如 *GPT-5.5 (high)*）；`"thinking": true` 可把思考过程流式显示在聊天里；API Key 按 provider 存系统钥匙串。

Anthropic 缓存兼容：如果中转站给 system/messages 写入 `1h` 缓存、同时又默认给 tools 写入 `5m`，Anthropic 会因 `5m → 1h` 顺序非法而返回 400。可在 **管理中转站 → Anthropic 缓存 TTL 兼容** 中选择 `1h`，或配置 `"anthropicCacheTtl": "1h"`；PolyBridge 会在最后一个工具上显式声明相同 TTL。默认 `off`，仅 Anthropic 且请求含工具时生效。

快速上手：命令面板运行 **Poly Model Bridge: Open Manager**，在统一 UI 中配置中转站、模型、协议、缓存 TTL、Headers 和 API Key → 模型选择器 **Manage Models** 勾选。

常见问题：401/403 换 `authHeader` 风格；某模型报 `protocol_mismatch` 说明网关没按该协议提供它，给这个模型单独设 `apiType`；行内补全不走 BYOK（VS Code 平台限制）。

## License

MIT
