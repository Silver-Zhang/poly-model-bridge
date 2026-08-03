# Changelog

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
