"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// cli.js only depends on protocols.js, which is vscode-free, so it loads as-is.
const { planCliEnv, formatEnvSnippet, KEY_PLACEHOLDER } = require("../cli");

/** Minimal stand-in for one `enumerateModels()` entry. */
function entryFor(provider, model, apiType, effort) {
  return {
    provider: { name: "relay", baseUrl: "https://gw.example.com", ...provider },
    model: { id: "m-1", ...model },
    apiType,
    effort,
    info: { name: "M1" },
  };
}

const anthropic = (p, m) => entryFor(p, m, "anthropic");
const chat = (p, m) => entryFor(p, m, "chat-completions");

test("anthropic gets the root URL, the CLI appends /v1/messages itself", () => {
  const { env } = planCliEnv(anthropic({}, {}), "k");
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "https://gw.example.com");
  assert.equal(env.COPILOT_PROVIDER_TYPE, "anthropic");
  assert.equal(env.COPILOT_PROVIDER_WIRE_API, undefined);
});

test("a base URL already carrying /v1 is not doubled up", () => {
  const withV1 = planCliEnv(anthropic({ baseUrl: "https://gw.example.com/v1" }), "k");
  assert.equal(withV1.env.COPILOT_PROVIDER_BASE_URL, "https://gw.example.com");
  const withPath = planCliEnv(
    anthropic({ baseUrl: "https://gw.example.com/v1/messages" }),
    "k"
  );
  assert.equal(withPath.env.COPILOT_PROVIDER_BASE_URL, "https://gw.example.com");
});

test("openai protocols keep /v1 because the CLI appends only the verb", () => {
  const { env } = planCliEnv(chat({}, {}), "k");
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "https://gw.example.com/v1");
  assert.equal(env.COPILOT_PROVIDER_TYPE, "openai");
  // chat is the CLI's default wire api, so it is left unset
  assert.equal(env.COPILOT_PROVIDER_WIRE_API, undefined);
});

test("the responses protocol is the only one that sets a wire api", () => {
  const { env } = planCliEnv(entryFor({}, {}, "responses"), "k");
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "https://gw.example.com/v1");
  assert.equal(env.COPILOT_PROVIDER_TYPE, "openai");
  assert.equal(env.COPILOT_PROVIDER_WIRE_API, "responses");
});

test("a per-model url on the standard path is reduced like any other", () => {
  const { env, warnings } = planCliEnv(
    chat({}, { url: "https://alt.example.com/v1/chat/completions" }),
    "k"
  );
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "https://alt.example.com/v1");
  assert.equal(warnings.some((w) => w.includes("自定义请求地址")), false);
});

test("a per-model url off the standard path falls back and says so", () => {
  const { env, warnings } = planCliEnv(
    chat({}, { url: "https://alt.example.com/custom/infer" }),
    "k"
  );
  // the CLI builds its own path, so an arbitrary one cannot be honoured
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "https://gw.example.com/v1");
  assert.ok(warnings.some((w) => w.includes("自定义请求地址")));
});

test("providers that need no key produce no credential variables", () => {
  const { env } = planCliEnv(chat({ requiresApiKey: false }, {}), "");
  assert.equal(env.COPILOT_PROVIDER_API_KEY, undefined);
  assert.equal(env.COPILOT_PROVIDER_BEARER_TOKEN, undefined);
});

test("each protocol's default auth maps onto the plain api key variable", () => {
  assert.equal(planCliEnv(anthropic({}, {}), "k").env.COPILOT_PROVIDER_API_KEY, "k");
  assert.equal(planCliEnv(chat({}, {}), "k").env.COPILOT_PROVIDER_API_KEY, "k");
});

test("an anthropic gateway wanting bearer auth uses the bearer variable", () => {
  const { env, warnings } = planCliEnv(
    anthropic({ authHeader: "authorization" }, {}),
    "k"
  );
  assert.equal(env.COPILOT_PROVIDER_BEARER_TOKEN, "k");
  assert.equal(env.COPILOT_PROVIDER_API_KEY, undefined);
  assert.equal(warnings.some((w) => w.includes("x-api-key 认证")), false);
});

test("an openai gateway wanting x-api-key gets both headers, with a warning", () => {
  const { env, warnings } = planCliEnv(chat({ authHeader: "x-api-key" }, {}), "k");
  // the CLI refuses to start without an api key but always sends it as Bearer,
  // so the raw header has to ride along separately
  assert.equal(env.COPILOT_PROVIDER_API_KEY, "k");
  assert.deepEqual(JSON.parse(env.COPILOT_PROVIDER_HEADERS), { "x-api-key": "k" });
  assert.ok(warnings.some((w) => w.includes("x-api-key")));
});

test("provider extra headers are carried across as JSON", () => {
  const { env } = planCliEnv(
    chat({ extraHeaders: { "x-tenant": "acme" } }, {}),
    "k"
  );
  assert.deepEqual(JSON.parse(env.COPILOT_PROVIDER_HEADERS), { "x-tenant": "acme" });
});

test("limits and effort are only emitted when configured", () => {
  const bare = planCliEnv(chat({}, {}), "k").env;
  assert.equal(bare.COPILOT_PROVIDER_MAX_PROMPT_TOKENS, undefined);
  assert.equal(bare.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS, undefined);
  assert.equal(bare.COPILOT_AGENT_REASONING_EFFORT, undefined);

  const full = planCliEnv(
    entryFor({}, { maxInputTokens: 200000, maxOutputTokens: 16000 }, "chat-completions", "high"),
    "k"
  ).env;
  assert.equal(full.COPILOT_PROVIDER_MAX_PROMPT_TOKENS, "200000");
  assert.equal(full.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS, "16000");
  assert.equal(full.COPILOT_AGENT_REASONING_EFFORT, "high");
});

test("capabilities that stay behind in the extension are reported", () => {
  const { warnings } = planCliEnv(
    chat({}, { toolCalling: false, thinking: true, anthropicCacheTtl: "1h" }),
    "k"
  );
  assert.ok(warnings.some((w) => w.includes("工具调用")));
  assert.ok(warnings.some((w) => w.includes("缓存 TTL")));
  assert.ok(warnings.some((w) => w.includes("thinking")));
  // the two unconditional ones: no PolyBridge request handling, no /model switch
  assert.ok(warnings.some((w) => w.includes("上下文裁剪")));
  assert.ok(warnings.some((w) => w.includes("/model")));
});

test("snippets use each shell's own assignment and quoting", () => {
  const env = { COPILOT_MODEL: "gpt-5", COPILOT_PROVIDER_TYPE: "openai" };
  assert.equal(
    formatEnvSnippet(env, "bash"),
    "export COPILOT_PROVIDER_TYPE='openai'\nexport COPILOT_MODEL='gpt-5'\ncopilot"
  );
  assert.equal(
    formatEnvSnippet(env, "pwsh"),
    "$env:COPILOT_PROVIDER_TYPE = 'openai'\n$env:COPILOT_MODEL = 'gpt-5'\ncopilot"
  );
  assert.equal(
    formatEnvSnippet(env, "cmd"),
    'set "COPILOT_PROVIDER_TYPE=openai"\nset "COPILOT_MODEL=gpt-5"\ncopilot'
  );
});

test("single quotes in a value are escaped per shell", () => {
  const env = { COPILOT_MODEL: "a'b" };
  assert.ok(formatEnvSnippet(env, "bash").includes("'a'\\''b'"));
  assert.ok(formatEnvSnippet(env, "pwsh").includes("'a''b'"));
});

test("masking replaces every credential variable, not just the api key", () => {
  const withKey = { COPILOT_PROVIDER_API_KEY: "sk-real", COPILOT_MODEL: "m" };
  const masked = formatEnvSnippet(withKey, "bash", { maskKey: true });
  assert.ok(masked.includes(KEY_PLACEHOLDER));
  assert.equal(masked.includes("sk-real"), false);

  const withBearer = { COPILOT_PROVIDER_BEARER_TOKEN: "sk-real" };
  const maskedBearer = formatEnvSnippet(withBearer, "bash", { maskKey: true });
  assert.equal(maskedBearer.includes("sk-real"), false);

  // without the flag the real value is emitted, which is what the terminal path uses
  assert.ok(formatEnvSnippet(withKey, "bash").includes("sk-real"));
});

test("entries straight out of enumerateModels are accepted unchanged", () => {
  // Guards against provider.js and cli.js drifting apart on the entry shape.
  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
      return {
        workspace: {
          getConfiguration: () => ({
            get: (key) =>
              key === "providers"
                ? [
                    {
                      name: "relay",
                      baseUrl: "https://gw.example.com",
                      apiType: "chat-completions",
                      models: [{ id: "gpt-5", efforts: ["high"] }],
                    },
                  ]
                : undefined,
          }),
        },
        LanguageModelChatMessageRole: {},
        EventEmitter: class {
          constructor() {
            this.event = () => {};
          }
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const { enumerateModels } = require("../provider");
  Module._load = originalLoad;

  const [entry] = enumerateModels();
  const { env } = planCliEnv(entry, "k");
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, "https://gw.example.com/v1");
  assert.equal(env.COPILOT_MODEL, "gpt-5");
  assert.equal(env.COPILOT_AGENT_REASONING_EFFORT, "high");
});
