# Changelog

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
