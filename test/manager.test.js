"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// manager.js imports vscode at runtime, so test the exported sanitizer with a
// minimal module shim rather than exposing the Webview implementation.
const Module = require("node:module");
const originalLoad = Module._load;
let configuredProviders = [];
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: { getConfiguration: () => ({
        get: () => configuredProviders,
        update: async (_key, value) => { configuredProviders = value; },
        // routing.readRouting() inspects Copilot/core settings; none are
        // registered under the shim, which is the "nothing configured" case.
        inspect: () => undefined,
      }) },
      ConfigurationTarget: { Global: 1 },
      Uri: { joinPath: () => ({}) },
      ViewColumn: { One: 1 },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ManagerPanel, sanitizeProviders } = require("../manager");
Module._load = originalLoad;

test("manager Webview loads valid local assets", () => {
  const manager = {
    context: { extensionUri: {} },
    panel: { webview: {
      cspSource: "vscode-webview:",
      asWebviewUri: (_uri) => "vscode-resource:/asset",
    } },
    asset: ManagerPanel.prototype.asset,
  };
  const html = ManagerPanel.prototype.html.call(manager);
  assert.match(html, /<link rel="stylesheet" href="vscode-resource:\/asset">/);
  assert.match(html, /<script nonce="[^"]+" src="vscode-resource:\/asset"><\/script>/);
  const script = fs.readFileSync(path.join(__dirname, "..", "media", "manager.js"), "utf8");
  assert.doesNotThrow(() => new vm.Script(script, { filename: "manager-webview.js" }));
});

test("manager migrates API Key when a provider is renamed", async () => {
  configuredProviders = [{
    name: "Old Relay",
    baseUrl: "https://example.com",
    apiType: "anthropic",
    models: [],
  }];
  const values = new Map([["polyBridge.apiKey::Old Relay", "secret-value"]]);
  const manager = {
    context: { secrets: {
      get: async (key) => values.get(key),
      store: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
    } },
    chatProvider: { refresh() {} },
    panel: { webview: { postMessage: async () => {} } },
    sendState: ManagerPanel.prototype.sendState,
    routableModels: ManagerPanel.prototype.routableModels,
  };
  await ManagerPanel.prototype.save.call(manager, [{
    name: "New Relay",
    _originalName: "Old Relay",
    baseUrl: "https://example.com",
    apiType: "anthropic",
    models: [],
  }]);
  assert.equal(values.get("polyBridge.apiKey::New Relay"), "secret-value");
  assert.equal(values.has("polyBridge.apiKey::Old Relay"), false);
});

test("manager sanitizes provider and model fields", () => {
  const result = sanitizeProviders([{
    name: " Relay ",
    baseUrl: "https://example.com/",
    apiType: "anthropic",
    anthropicCacheTtl: "1h",
    requiresApiKey: true,
    extraHeaders: { " x-test ": " value " },
    models: [{
      id: " claude-test ",
      efforts: [" high ", "high", "xhigh", "max", "custom-level", ""],
      thinking: true,
      maxInputTokens: "128000",
      maxOutputTokens: 8192,
      maxTokensField: "max_tokens",
      toolCalling: false,
      vision: false,
      url: " https://example.com/custom ",
    }],
  }]);
  assert.equal(result[0].name, "Relay");
  assert.equal(result[0].baseUrl, "https://example.com");
  assert.equal(result[0].anthropicCacheTtl, "1h");
  assert.deepEqual(result[0].extraHeaders, { "x-test": "value" });
  assert.equal(result[0].models[0].id, "claude-test");
  assert.deepEqual(result[0].models[0].efforts, ["high", "xhigh", "max", "custom-level"]);
  assert.equal(result[0].models[0].maxInputTokens, 128000);
  assert.equal(result[0].models[0].maxTokensField, "max_tokens");
  assert.equal(result[0].models[0].toolCalling, false);
  assert.equal(result[0].models[0].vision, false);
  assert.equal(result[0].models[0].url, "https://example.com/custom");
});

test("manager rejects duplicate provider names", () => {
  assert.throws(() => sanitizeProviders([
    { name: "same", baseUrl: "https://one.example", models: [] },
    { name: "same", baseUrl: "https://two.example", models: [] },
  ]), /名称重复/);
});

test("manager rejects provider names containing the picker-id separator", () => {
  // Allowing "::" inside a name would make `provider::model::effort` ambiguous
  // and break the `chat.utilityModel` reference built from it.
  assert.throws(() => sanitizeProviders([
    { name: "my::relay", baseUrl: "https://example.com", models: [] },
  ]), /不能包含/);
});

test("manager rejects duplicate model ids", () => {
  assert.throws(() => sanitizeProviders([{
    name: "relay",
    baseUrl: "https://example.com",
    models: [{ id: "same" }, { id: "same" }],
  }]), /重复模型/);
});