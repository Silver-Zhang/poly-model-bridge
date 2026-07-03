# Changelog

## 0.1.0

Initial release.

- Register Anthropic Messages API compatible endpoints as models in GitHub Copilot's model picker
- SSE streaming, tool calling (agent mode), image input, system prompt mapping
- Thinking delta pass-through (when supported by the VS Code build)
- API key in SecretStorage; `x-api-key` / `Authorization: Bearer` auth styles; custom headers
