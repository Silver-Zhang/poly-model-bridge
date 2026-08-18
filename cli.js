"use strict";
/**
 * Copilot CLI bridge.
 *
 * GitHub Copilot CLI (`@github/copilot`) is a separate process, so it cannot
 * see the `vscode.lm` provider this extension registers. It does however have
 * its own BYOK support, driven entirely by environment variables, and the three
 * wire formats it speaks are exactly the three in protocols.js. So the job here
 * is configuration translation, not proxying: turn one `enumerateModels()`
 * entry into the environment a `copilot` process needs.
 *
 * Only `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`,
 * `COPILOT_PROVIDER_API_KEY` and `COPILOT_MODEL` are documented publicly:
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models
 * The rest were read off the CLI's own runtime, which registers them alongside
 * the documented four, and each is written only when the model configuration
 * actually calls for it — an unset variable is the CLI's own default.
 *
 * Two limits are inherent to the CLI and are surfaced to the user rather than
 * worked around: a custom provider empties the model list, so `/model` cannot
 * switch models mid-session (one model per process), and setting a base URL
 * takes over all routing, so GitHub-hosted models are gone for that process.
 */

const { PROTOCOLS, resolveEndpoint } = require("./protocols");

/** PolyBridge apiType -> the CLI's `COPILOT_PROVIDER_TYPE`. */
const PROVIDER_TYPES = {
  anthropic: "anthropic",
  "chat-completions": "openai",
  responses: "openai",
};

/** How the CLI authenticates by default, per provider type. */
const CLI_DEFAULT_AUTH = {
  anthropic: "x-api-key",
  openai: "authorization",
};

/** Stands in for the real key when a snippet leaves the extension host. */
const KEY_PLACEHOLDER = "YOUR_API_KEY_HERE";

/** Emitted in this order so snippets stay stable across runs. */
const ENV_ORDER = [
  "COPILOT_PROVIDER_BASE_URL",
  "COPILOT_PROVIDER_TYPE",
  "COPILOT_PROVIDER_WIRE_API",
  "COPILOT_MODEL",
  "COPILOT_PROVIDER_API_KEY",
  "COPILOT_PROVIDER_BEARER_TOKEN",
  "COPILOT_PROVIDER_HEADERS",
  "COPILOT_PROVIDER_MAX_PROMPT_TOKENS",
  "COPILOT_PROVIDER_MAX_OUTPUT_TOKENS",
  "COPILOT_AGENT_REASONING_EFFORT",
];

const SECRET_ENV = new Set([
  "COPILOT_PROVIDER_API_KEY",
  "COPILOT_PROVIDER_BEARER_TOKEN",
]);

/**
 * Reduce a fully resolved endpoint back to the base the CLI wants.
 *
 * The CLI appends the path itself, and where it starts from differs by type:
 * Anthropic is given the root (it appends `/v1/messages`), OpenAI is given the
 * `/v1` prefix (it appends `/chat/completions` or `/responses`). Returns
 * undefined when the endpoint does not end in the protocol's own path, which
 * happens only for a hand-written per-model `url`.
 */
function baseUrlFromEndpoint(endpoint, apiType) {
  const adapter = PROTOCOLS[apiType] || PROTOCOLS.anthropic;
  const suffix = "/" + adapter.defaultPath;
  if (!endpoint.endsWith(suffix)) {
    return undefined;
  }
  const base = endpoint.slice(0, -suffix.length);
  return apiType === "anthropic" ? base.replace(/\/v1$/, "") : base;
}

/**
 * Translate one picker entry into the environment a `copilot` process needs.
 *
 * `apiKey` may be empty for providers with `requiresApiKey: false` (a local
 * Ollama or vLLM instance); the CLI accepts an unauthenticated provider.
 * Returns the variables plus every PolyBridge capability that does not survive
 * the crossing, so the caller can say so instead of dropping it silently.
 */
function planCliEnv(entry, apiKey) {
  const { provider, model, apiType, effort } = entry;
  const warnings = [];
  const env = {};

  const providerType = PROVIDER_TYPES[apiType] || "openai";
  let baseUrl = baseUrlFromEndpoint(
    resolveEndpoint(provider.baseUrl, apiType, model.url),
    apiType
  );
  if (baseUrl === undefined) {
    // A per-model `url` that is not the protocol's standard path cannot be
    // reduced to a base, so fall back to the provider's own URL.
    baseUrl = baseUrlFromEndpoint(
      resolveEndpoint(provider.baseUrl, apiType, undefined),
      apiType
    );
    warnings.push(
      `模型 ${model.id} 配了自定义请求地址 ${model.url}，CLI 只接受根地址、路径由它自己拼，` +
        `因此改用中转站地址 ${baseUrl}。若该模型必须走自定义路径，CLI 侧用不了。`
    );
  }

  env.COPILOT_PROVIDER_BASE_URL = baseUrl;
  env.COPILOT_PROVIDER_TYPE = providerType;
  if (apiType === "responses") {
    env.COPILOT_PROVIDER_WIRE_API = "responses";
  }
  env.COPILOT_MODEL = model.id;

  const headers = Object.assign({}, provider.extraHeaders || {});
  if (apiKey) {
    const adapter = PROTOCOLS[apiType] || PROTOCOLS.anthropic;
    const authHeader = provider.authHeader || adapter.defaultAuth;
    if (authHeader === CLI_DEFAULT_AUTH[providerType]) {
      env.COPILOT_PROVIDER_API_KEY = apiKey;
    } else if (authHeader === "authorization") {
      // Anthropic-protocol gateway that wants `Authorization: Bearer` instead
      // of `x-api-key`. The CLI has a variable for exactly this.
      env.COPILOT_PROVIDER_BEARER_TOKEN = apiKey;
    } else {
      // OpenAI-protocol gateway that wants a raw `x-api-key`. The CLI has no
      // switch for this and refuses to start without an api key, so send both
      // and say so.
      env.COPILOT_PROVIDER_API_KEY = apiKey;
      headers["x-api-key"] = apiKey;
      warnings.push(
        `中转站 ${provider.name} 用 x-api-key 认证，但 CLI 的 OpenAI 协议固定发 ` +
          `Authorization: Bearer。已同时附上 x-api-key，若中转站拒绝多余的认证头则用不了。`
      );
    }
  }
  if (Object.keys(headers).length > 0) {
    env.COPILOT_PROVIDER_HEADERS = JSON.stringify(headers);
  }

  if (model.maxInputTokens) {
    env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS = String(model.maxInputTokens);
  }
  if (model.maxOutputTokens) {
    env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = String(model.maxOutputTokens);
  }
  if (effort) {
    env.COPILOT_AGENT_REASONING_EFFORT = effort;
  }

  if (model.toolCalling === false) {
    warnings.push(
      `模型 ${model.id} 标记为不支持工具调用，而 CLI 要求模型同时支持工具调用和流式输出，很可能直接报错。`
    );
  }
  const cacheTtl = model.anthropicCacheTtl || provider.anthropicCacheTtl || "off";
  if (cacheTtl !== "off") {
    warnings.push(
      "Anthropic 缓存 TTL 兼容处理只在插件里生效，CLI 直连中转站，不经过这一步。"
    );
  }
  if (model.thinking === true) {
    warnings.push(
      "思考内容由 CLI 自己解析，PolyBridge 的 thinking 流式处理不参与。"
    );
  }
  warnings.push(
    "CLI 直连中转站：PolyBridge 的上下文裁剪、工具输出截断和用量统计都不生效，" +
      "上下文由 CLI 自己管理。"
  );
  warnings.push(
    "该终端内所有请求都走这个模型：CLI 配了自定义 provider 后模型列表为空，" +
      "会话中途无法用 /model 切换，换模型请开新终端。"
  );

  return { env, warnings };
}

function escapePosix(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function escapePowerShell(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * Render the environment as a copy-pasteable snippet.
 *
 * With `maskKey` the credentials are replaced by a placeholder, so the snippet
 * can go to the clipboard — and from there into a chat log, a note or a commit
 * — without carrying the key.
 */
function formatEnvSnippet(env, shell, options) {
  const maskKey = !!(options && options.maskKey);
  const lines = [];
  for (const name of ENV_ORDER) {
    if (env[name] === undefined) {
      continue;
    }
    const value = maskKey && SECRET_ENV.has(name) ? KEY_PLACEHOLDER : env[name];
    if (shell === "bash") {
      lines.push("export " + name + "=" + escapePosix(value));
    } else if (shell === "cmd") {
      // cmd has no escape for %, so a value containing it would be expanded.
      lines.push('set "' + name + "=" + value + '"');
    } else {
      lines.push("$env:" + name + " = " + escapePowerShell(value));
    }
  }
  lines.push("copilot");
  return lines.join("\n");
}

module.exports = {
  planCliEnv,
  formatEnvSnippet,
  baseUrlFromEndpoint,
  KEY_PLACEHOLDER,
  ENV_ORDER,
};
