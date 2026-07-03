# Changelog

## 0.2.0

Renamed to **Poly Model Bridge for Copilot** and generalized to a multi-protocol gateway.

- Three wire protocols: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses — selectable per provider and per model
- Reasoning-effort variants (`efforts`) — one model-picker entry per effort level, Claude Code style
- Thinking/reasoning-summary streaming into the chat UI (`thinking: true`)
- Multiple providers with per-provider API keys in SecretStorage
- Tool calling and image input on all protocols

## 0.1.0

Initial release (Anthropic Messages only).
