# Anthropic Compatible Provider for Copilot

Bring any **Anthropic Messages API** (`/v1/messages`) compatible endpoint into GitHub Copilot Chat's model picker — the official Anthropic API, relay/proxy gateways (one-api, new-api, etc.), or vendor endpoints that speak the Anthropic protocol (DeepSeek, Kimi, GLM, MiniMax…).

Works in Chat, Edits and **Agent mode** (tool calling fully supported), with free model switching from the picker.

## Features

- ✅ SSE streaming responses
- ✅ Tool calling (`tool_use` / `tool_result`) — required for Copilot Agent mode
- ✅ Image input (base64 image blocks)
- ✅ System prompt mapped to Anthropic's top-level `system` field
- ✅ Thinking deltas passed through when your VS Code exposes `LanguageModelThinkingPart`
- ✅ API key kept in VS Code **SecretStorage** (never written to settings.json)
- ✅ `x-api-key` or `Authorization: Bearer` auth styles, plus custom headers

## Quick Start

1. Open Settings (`anthropicCompat`) and set your endpoint and models:

```jsonc
{
  "anthropicCompat.baseUrl": "https://your-relay.example.com",
  "anthropicCompat.models": [
    { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" },
    { "id": "claude-opus-4-8", "name": "Claude Opus 4.8" }
  ]
}
```

2. Command Palette → **Anthropic Compatible: Set API Key** → paste your key.
3. Open Copilot Chat's model picker → **Manage Models** → tick the models under **Anthropic Compatible**.

## Settings

| Setting | Description |
|---|---|
| `anthropicCompat.baseUrl` | Endpoint base URL. Requests go to `<baseUrl>/v1/messages`; a URL already ending in `/v1` or `/v1/messages` is handled too. |
| `anthropicCompat.models` | Array of `{ id, name?, maxInputTokens?, maxOutputTokens?, toolCalling?, vision?, url? }`. `id` must be a model your endpoint serves. |
| `anthropicCompat.authHeader` | `x-api-key` (default, official style) or `authorization` (Bearer). |
| `anthropicCompat.extraHeaders` | Extra HTTP headers for every request. |

Per-model defaults: 200K input / 16K output tokens, tool calling and vision enabled.

## FAQ

**Models don't show up in the picker?** Run "Chat: Manage Language Models", make sure baseUrl/models are set and the API key is stored; reload the window if needed.

**401/403 errors?** Some relays want `Authorization: Bearer` instead of `x-api-key` — switch `anthropicCompat.authHeader`.

**`protocol_mismatch` or similar errors?** That model is not served over the Anthropic protocol by your relay (it may be OpenAI-protocol only). Use an OpenAI-compatible provider extension for it instead.

**Inline completions?** VS Code limitation: BYOK models power Chat/Edits/Agent only — ghost-text completions keep using Copilot's built-in model.

---

# 中文说明

把任意 **Anthropic Messages 协议**（`/v1/messages`）端点接入 GitHub Copilot 的模型选择器——官方 API、中转站/网关（one-api、new-api 等）、或各家的 Anthropic 兼容端点。支持 Chat / Edits / **Agent 模式**（完整工具调用），可在选择器中自由切换。

## 快速开始

1. 设置中填 `anthropicCompat.baseUrl`（中转站 base URL）和 `anthropicCompat.models`（`id` 必须是中转站实际支持的模型名）
2. 命令面板 → **Anthropic Compatible: Set API Key** 粘贴 Key（存入系统钥匙串，不落盘）
3. Copilot 模型选择器 → **Manage Models** → 勾选 **Anthropic Compatible** 下的模型

## 常见问题

- **401/403**：部分中转站要求 Bearer 认证，把 `anthropicCompat.authHeader` 改成 `authorization`
- **protocol_mismatch**：该模型在你的中转站上不走 Anthropic 协议（仅 OpenAI 协议），请改用 OpenAI 兼容类插件接入
- **行内补全**：VS Code 平台限制，BYOK 模型只作用于 Chat/Edits/Agent，行内补全仍用内置模型

## License

MIT
