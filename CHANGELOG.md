# Changelog

## 0.6.1

针对 0.6.0 的实测问题：选好子 Agent 模型后，委派任务仍然使用主会话模型。

根因不在写入，而在生效条件。`.github/agents/poly-subagent.agent.md` 里的 `model:` 只在主 Agent 主动传 `agentName` 时才被读取；不传时 VS Code 走的是 `resolveSubagentModel(void 0, currentModelId, undefined)`，第一个参数写死为空，直接返回主会话模型。而 `runSubagent` 的工具说明只写了「Optional name of a specific agent to invoke. If not provided, uses the current agent.」，并不要求模型点名。

- 新增 `polyBridge.subagentRedirect`（默认关闭）：由 PolyBridge 自行识别子 Agent 回合并改写上游模型，不依赖模型点名，也不修改 VS Code 核心文件。识别依据是工具列表——`chat.subagents.allowInvocationsFromSubagents` 默认为 `false`，因此子 Agent 的工具列表里没有 `runSubagent`。无工具的请求视为辅助调用，交给 `chat.utilityModel`，不在此处改道。
- 该选项只改上游请求，**VS Code 界面仍显示继承来的模型名**，实际去向记录在 PolyBridge 输出面板。
- 生成的项目指令改用 Copilot 自身在 skills 提示中使用的 `BLOCKING REQUIREMENT` 句式，原先「优先通过……委派」的措辞过弱。
- 生成的 Agent `description` 改为声明自己是唯一委派目标——该字段是模型从系统提示的 `<agents>` 列表中选择时唯一可见的依据。
- 修复保存路由时可能抛出 VS Code 原始报错「没有注册配置 polyBridge.subagentModel，因此无法写入用户设置」。更新扩展后配置项要等窗口重新加载才注册，而 settings.json 里若已存在该键，原先的检测会误判为已注册。现在写入失败按「已跳过」处理并提示重启。

## 0.6.0

新增 **Copilot 路由** 面板：Copilot 有几类请求不走模型选择器，默认落在 GitHub 订阅模型上，现在可以在管理界面里统一指定。

- 辅助调用（应用代码块 mapCode、生成标题、压缩历史等）可选择跟随主会话模型、指定某个 PolyBridge 模型、禁止（宁可报错）或保持 VS Code 默认，写入 `chat.byokUtilityModelDefault` / `chat.utilityModel` / `chat.utilitySmallModel`。
- 内置执行 / 搜索子 Agent 可设为继承主会话模型，写入 `github.copilot.chat.executionSubagent.model` / `searchSubagent.model`。执行子 Agent 默认固定使用 Copilot 的 `gemini-3-flash`，与所选模型无关。
- 子 Agent（`runSubagent`）可指定模型，一键生成 `.github/agents/poly-subagent.agent.md`；并可写入 `.github/copilot-instructions.md`，抵消工具说明中「vendor 通常是 copilot」的提示。该指令段落在标记之间幂等更新，不影响文件其余内容。
- 新增命令 **Copy Model Reference（复制模型引用名）**，输出 `<名称> (poly-bridge)` 与 `poly-bridge/<id>` 两种形式。
- 模型内部 id 的分隔符由不可见的 U+001F 改为 `::`，使其可读、可手写进 `chat.utilityModel`。**升级后请在 Copilot 模型选择器中重新选择一次模型。** 中转站名称不再允许包含 `::`。

已知限制：内置执行 / 搜索子 Agent 的模型名只在 CAPI 中解析，无法指向 BYOK 模型，因此只提供「继承主会话」；`runSubagent` 调用时自带的 `model` 参数优先级最高，客户端无法拦截，只能通过上述指令引导。

## 0.5.4

- 修复中转站不返回 usage 时 Copilot 上下文用量仍显示 `0`：现在会根据最终请求体与流式输出进行保守估算并上报。
- 将 usage 统一延迟到响应结束时发送，优先采用上游真实值，并避免分段 usage 被 Copilot 忽略或覆盖。
- 增加 PolyBridge 输出日志，记录每次 usage 上报值及其来自上游还是本地估算，便于诊断上下文窗口显示。

## 0.5.3

- 修复 Copilot 上下文用量长期显示 `0`：解析 Anthropic、OpenAI Chat Completions 和 OpenAI Responses 的 usage，并通过 VS Code usage data part 上报。
- 增加 Chat Completions 流式 `include_usage` 兼容模式。
- 改进中文、JSON、源代码、Base64 和工具结果的保守 Token 估算。
- 自动截断超大的单个工具输出，并在超限时裁剪较旧对话轮次，同时保留系统消息、当前用户消息和相关工具调用链。
- 增加 400 错误的常见兼容性提示，并在管理界面提供 usage、估算策略和工具结果上限设置。

## 0.5.2

- Optimized the PolyBridge Activity Bar icon for clear display at VS Code's small sidebar size
- Kept the detailed futuristic neon logo for the extension marketplace and README

## 0.5.1

- Redesigned the manager with clearer Chinese labels, explanations and collapsible providers/models
- Added common reasoning levels (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) plus custom effort names
- Added context-window presets from 32K to 1M and clarified thinking/reasoning mode behavior
- Added a dedicated PolyBridge Activity Bar entry and sidebar shortcut to open the manager
- Replaced the extension and Activity Bar icon with a futuristic neon bridge logo
- Expanded README with visual setup, protocol, effort, troubleshooting and privacy guidance

## 0.5.0

- Added a unified visual Webview manager for providers, models, protocols, Anthropic cache TTL, authentication, custom headers and capabilities
- API keys remain in VS Code SecretStorage and are never exposed to the Webview
- Added `/v1/models` discovery directly in the manager, responsive layout, validation and unsaved-change tracking
- The existing add-provider wizard and status-bar quick settings remain available

## 0.4.2

- Added per-provider and per-model Anthropic cache-TTL compatibility modes (`off`, `5m`, `1h`)
- Explicitly marks the last Anthropic tool cache breakpoint when enabled, preventing gateways such as Sub2API from replacing a matching 1h TTL with their default 5m TTL
- Added management UI, configuration schema, documentation and protocol regression tests for cache-TTL compatibility

## 0.4.1

- Empty-state prompt ("configure providers in settings first") now offers a one-click **添加中转站** button that launches the add-provider wizard, instead of only pointing at settings.json
- Manage Providers hub jumps straight into the wizard when no provider exists yet

## 0.4.0

- **Status-bar quick dial**: a persistent status-bar button shows the most recently used model's effort and context window (e.g. `Sonnet 5 · high · 200K`); click to adjust reasoning effort and context length on the spot, Claude Code style (also via command `Poly Model Bridge: Quick Settings`)
- Edit-model menu now exposes context window / output limit (`maxInputTokens` / `maxOutputTokens`) — previously only settable via settings.json

## 0.3.0

No more hand-editing settings.json — full QuickPick management UI:

- **Add Provider wizard** (`Poly Model Bridge: Add Provider`): name → base URL → protocol → API key → pick models
- **Model list auto-fetched** from the endpoint's `/v1/models` (manual input as fallback)
- Manage hub (`Poly Model Bridge: Manage Providers` / the gear next to the picker): per-provider menus for API key, add/remove models, edit model (display name, effort levels via checkboxes, thinking toggle, protocol override), change base URL/protocol, connection test, delete provider
- settings.json remains supported as the advanced path (UI and JSON edit the same `polyBridge.providers`)

## 0.2.0

Renamed to **Poly Model Bridge for Copilot** and generalized to a multi-protocol gateway.

- Three wire protocols: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses — selectable per provider and per model
- Reasoning-effort variants (`efforts`) — one model-picker entry per effort level, Claude Code style
- Thinking/reasoning-summary streaming into the chat UI (`thinking: true`)
- Multiple providers with per-provider API keys in SecretStorage
- Tool calling and image input on all protocols

## 0.1.0

Initial release (Anthropic Messages only).
