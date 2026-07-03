# Poly Model Bridge for Copilot

Bring **any third-party model endpoint** into GitHub Copilot Chat's model picker — over three wire protocols:

| `apiType` | Protocol | Typical endpoints |
|---|---|---|
| `anthropic` | Anthropic Messages (`/v1/messages`) | Anthropic API, relays/gateways (one-api, new-api), DeepSeek/Kimi/GLM Anthropic-compatible endpoints |
| `chat-completions` | OpenAI Chat Completions (`/v1/chat/completions`) | OpenAI API, almost every relay/gateway, local servers |
| `responses` | OpenAI Responses (`/v1/responses`) | OpenAI API, Codex-style deployments |

Mix protocols freely — even per model within one provider. Works in Chat, Edits and **Agent mode**, with free model switching from the picker.

## Highlights

- 🎚️ **Reasoning effort variants, Claude Code style** — configure `"efforts": ["low", "medium", "high"]` on a model and each effort shows up as its own picker entry, e.g. *GPT-5.5 (high)*. Mapped per protocol: `output_config.effort` (Anthropic) / `reasoning_effort` (Chat Completions) / `reasoning.effort` (Responses).
- 🧠 **Thinking in the UI** — set `"thinking": true` to stream Anthropic thinking deltas or Responses reasoning summaries into the chat.
- 🛠️ Tool calling on all three protocols (Copilot Agent mode ready)
- 🖼️ Image input on all three protocols
- 🔑 API keys per provider in VS Code **SecretStorage** (never in settings.json); `x-api-key` / `Bearer` styles; custom headers; key-less local endpoints supported
- 🧩 Multiple providers side by side, grouped names in the picker

## Quick Start

1. Add providers in Settings (`polyBridge.providers`):

```jsonc
{
  "polyBridge.providers": [
    {
      "name": "MyRelay",
      "baseUrl": "https://my-relay.example.com",
      "apiType": "anthropic",                    // provider default protocol
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
| `maxInputTokens` / `maxOutputTokens` | 200000 / 16000 | Context window / `max_tokens` |
| `toolCalling` / `vision` | `true` / `true` | Capabilities advertised to Copilot |
| `maxTokensField` | `max_completion_tokens` | Chat Completions only; set `max_tokens` for older gateways |
| `url` | — | Full endpoint override for this model |

Provider options: `apiType`, `authHeader` (`x-api-key` \| `authorization`), `requiresApiKey: false` for local servers, `extraHeaders`.

## FAQ

**Models don't show up?** Check `polyBridge.providers` is set, run "Chat: Manage Language Models", reload the window if needed.

**401/403?** Try the other `authHeader` style — official Anthropic uses `x-api-key`, most OpenAI-style gateways use `Authorization: Bearer`.

**`protocol_mismatch` / provider errors on one model?** That model isn't served over the configured protocol by your gateway — set the correct per-model `apiType`.

**Inline completions?** VS Code limitation: BYOK models power Chat/Edits/Agent only; ghost-text completions keep using Copilot's built-in model.

---

# 中文说明

把任意第三方模型端点接入 GitHub Copilot 模型选择器，支持三种协议：**Anthropic Messages**、**OpenAI Chat Completions**、**OpenAI Responses**，可按模型混用；支持 Chat / Edits / **Agent 模式**。

亮点：像 Claude Code 一样**按模型配置多档 reasoning effort**（`"efforts": ["low","medium","high"]`），每档在选择器里是独立条目（如 *GPT-5.5 (high)*）；`"thinking": true` 可把思考过程流式显示在聊天里；API Key 按 provider 存系统钥匙串。

快速上手：设置里配 `polyBridge.providers`（见上方英文示例）→ 命令面板 **Poly Model Bridge: Set API Key** → 模型选择器 **Manage Models** 勾选。

常见问题：401/403 换 `authHeader` 风格；某模型报 `protocol_mismatch` 说明网关没按该协议提供它，给这个模型单独设 `apiType`；行内补全不走 BYOK（VS Code 平台限制）。

## License

MIT
