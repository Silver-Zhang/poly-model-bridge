"use strict";
const vscode = require("vscode");
const { resolveEndpoint } = require("./protocols");

const API_TYPES = new Set(["anthropic", "chat-completions", "responses"]);
const CACHE_TTLS = new Set(["off", "5m", "1h"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function configuration() {
  return vscode.workspace.getConfiguration("polyBridge");
}

function readProviders() {
  return clone(configuration().get("providers") || []);
}

async function writeProviders(providers) {
  await configuration().update(
    "providers",
    providers,
    vscode.ConfigurationTarget.Global
  );
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sanitizeModel(raw) {
  const id = normalizeString(raw && raw.id);
  if (!id) {
    return undefined;
  }
  const model = { id };
  const name = normalizeString(raw.name);
  if (name) model.name = name;
  if (API_TYPES.has(raw.apiType)) model.apiType = raw.apiType;
  if (CACHE_TTLS.has(raw.anthropicCacheTtl)) {
    model.anthropicCacheTtl = raw.anthropicCacheTtl;
  }
  const efforts = Array.isArray(raw.efforts)
    ? [...new Set(raw.efforts.map(normalizeString).filter(Boolean))]
    : [];
  if (efforts.length) model.efforts = efforts;
  const effort = normalizeString(raw.effort);
  if (!efforts.length && effort) model.effort = effort;
  if (raw.thinking === true) model.thinking = true;
  model.maxInputTokens = positiveInteger(raw.maxInputTokens, 200000);
  model.maxOutputTokens = positiveInteger(raw.maxOutputTokens, 16000);
  model.toolCalling = raw.toolCalling !== false;
  model.vision = raw.vision !== false;
  if (raw.maxTokensField === "max_tokens") model.maxTokensField = "max_tokens";
  const url = normalizeString(raw.url);
  if (url) model.url = url;
  return model;
}

function sanitizeProvider(raw, existingNames) {
  const name = normalizeString(raw && raw.name);
  const baseUrl = normalizeString(raw && raw.baseUrl).replace(/\/+$/, "");
  if (!name) throw new Error("中转站名称不能为空。");
  if (existingNames.has(name)) throw new Error(`中转站名称重复：${name}`);
  if (!/^https?:\/\/\S+$/i.test(baseUrl)) {
    throw new Error(`${name} 的 Base URL 必须以 http:// 或 https:// 开头。`);
  }
  existingNames.add(name);
  const provider = {
    name,
    baseUrl,
    apiType: API_TYPES.has(raw.apiType) ? raw.apiType : "anthropic",
    anthropicCacheTtl: CACHE_TTLS.has(raw.anthropicCacheTtl)
      ? raw.anthropicCacheTtl
      : "off",
    requiresApiKey: raw.requiresApiKey !== false,
    models: [],
  };
  if (raw.authHeader === "x-api-key" || raw.authHeader === "authorization") {
    provider.authHeader = raw.authHeader;
  }
  const headers = {};
  for (const [key, value] of Object.entries(raw.extraHeaders || {})) {
    const header = normalizeString(key);
    const headerValue = normalizeString(value);
    if (header && headerValue) headers[header] = headerValue;
  }
  if (Object.keys(headers).length) provider.extraHeaders = headers;
  const modelIds = new Set();
  for (const rawModel of Array.isArray(raw.models) ? raw.models : []) {
    const model = sanitizeModel(rawModel);
    if (!model) continue;
    if (modelIds.has(model.id)) throw new Error(`${name} 中存在重复模型：${model.id}`);
    modelIds.add(model.id);
    provider.models.push(model);
  }
  return provider;
}

function sanitizeProviders(rawProviders) {
  const names = new Set();
  return (Array.isArray(rawProviders) ? rawProviders : []).map((provider) =>
    sanitizeProvider(provider, names)
  );
}

function keySecretId(providerName) {
  return "polyBridge.apiKey::" + providerName;
}

function modelsEndpoint(baseUrl) {
  let base = normalizeString(baseUrl).replace(/\/+$/, "");
  if (!/\/v1$/i.test(base)) base += "/v1";
  return base + "/models";
}

function authHeaders(provider, apiKey) {
  const headers = {};
  if (!apiKey) return headers;
  const apiType = provider.apiType || "anthropic";
  const auth = provider.authHeader ||
    (apiType === "anthropic" ? "x-api-key" : "authorization");
  if (auth === "x-api-key") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = "Bearer " + apiKey;
  }
  return headers;
}

async function fetchModelIds(provider, secrets) {
  const key = await secrets.get(keySecretId(provider.name));
  const response = await fetch(modelsEndpoint(provider.baseUrl), {
    headers: { ...authHeaders(provider, key), ...(provider.extraHeaders || {}) },
  });
  if (!response.ok) {
    throw new Error(`GET /v1/models 返回 ${response.status} ${response.statusText}`);
  }
  const json = await response.json();
  const list = Array.isArray(json) ? json : json.data || json.models || [];
  return [...new Set(list
    .map((item) => (typeof item === "string" ? item : item && item.id))
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim()))].sort();
}

function nonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

class ManagerPanel {
  static current;

  static show(context, chatProvider) {
    if (ManagerPanel.current) {
      ManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      ManagerPanel.current.sendState();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "polyBridge.manager",
      "Poly Model Bridge",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ManagerPanel.current = new ManagerPanel(panel, context, chatProvider);
  }

  constructor(panel, context, chatProvider) {
    this.panel = panel;
    this.context = context;
    this.chatProvider = chatProvider;
    this.disposables = [];
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "icon.png");
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    };
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message) => this.receive(message),
      null,
      this.disposables
    );
    this.sendState();
  }

  async sendState() {
    const providers = readProviders().map((provider) => ({
      ...provider,
      _originalName: provider.name,
    }));
    const keyStates = {};
    for (const provider of providers) {
      keyStates[provider.name] = !!(await this.context.secrets.get(keySecretId(provider.name)));
    }
    await this.panel.webview.postMessage({ type: "state", providers, keyStates });
  }

  async receive(message) {
    try {
      switch (message && message.type) {
        case "ready":
          await this.sendState();
          break;
        case "save":
          await this.save(message.providers);
          break;
        case "setKey":
          await this.setKey(message.providerName);
          break;
        case "fetchModels":
          await this.fetchModels(message.provider);
          break;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettingsJson");
          break;
        default:
          break;
      }
    } catch (error) {
      this.panel.webview.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async save(rawProviders) {
    const previous = readProviders();
    const providers = sanitizeProviders(rawProviders);
    const previousNames = new Set(previous.map((provider) => provider.name));
    const nextNames = new Set(providers.map((provider) => provider.name));
    const migrations = [];
    for (let index = 0; index < providers.length; index++) {
      const oldName = normalizeString(rawProviders[index] && rawProviders[index]._originalName);
      const newName = providers[index].name;
      if (oldName && oldName !== newName && previousNames.has(oldName)) {
        const secret = await this.context.secrets.get(keySecretId(oldName));
        if (secret) migrations.push({ oldName, newName, secret });
      }
    }
    await writeProviders(providers);
    for (const migration of migrations) {
      await this.context.secrets.store(keySecretId(migration.newName), migration.secret);
    }
    for (const oldProvider of previous) {
      if (!nextNames.has(oldProvider.name)) {
        await this.context.secrets.delete(keySecretId(oldProvider.name));
      }
    }
    this.chatProvider.refresh();
    this.panel.webview.postMessage({ type: "saved" });
    await this.sendState();
  }

  async setKey(providerName) {
    const providers = readProviders();
    const provider = providers.find((item) => item.name === providerName);
    if (!provider) throw new Error("请先保存中转站，再设置 API Key。");
    await this.chatProvider.promptForApiKey(providerName);
    await this.sendState();
  }

  async fetchModels(rawProvider) {
    const draft = sanitizeProvider(rawProvider, new Set());
    const stored = readProviders().find((provider) => provider.name === draft.name);
    if (!stored) {
      throw new Error("首次添加中转站时，请先保存，再拉取模型列表。");
    }
    const ids = await fetchModelIds(draft, this.context.secrets);
    this.panel.webview.postMessage({ type: "models", providerName: draft.name, ids });
  }

  dispose() {
    ManagerPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop().dispose();
  }

  asset(name) {
    return this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", name)
    );
  }

  html() {
    const token = nonce();
    const source = this.panel.webview.cspSource;
    const csp = [
      "default-src 'none'",
      `style-src ${source}`,
      `script-src 'nonce-${token}'`,
      `img-src ${source} data:`,
    ].join("; ");
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${this.asset("manager.css")}">
<title>Poly Model Bridge</title>
</head>
<body>
<main class="shell">
  <header class="hero">
    <div>
      <h1>Poly Model Bridge</h1>
      <div class="muted">把中转站的模型接入 Copilot。在这里添加中转站、填写密钥、挑选模型。</div>
    </div>
    <div class="actions">
      <button class="secondary" id="raw">编辑配置文件</button>
      <button class="secondary" id="add">添加中转站</button>
      <button class="save">保存设置</button>
    </div>
  </header>
  <div id="content"></div>
  <div class="savebar" id="savebar">
    <span class="hint">改完记得保存，保存后 Copilot 的模型列表会立即更新。</span>
    <button class="save">保存设置</button>
  </div>
</main>
<div id="notice" class="notice"></div>
<script nonce="${token}" src="${this.asset("manager.js")}"></script>
</body>
</html>`;
  }
}

module.exports = { ManagerPanel, sanitizeProviders, fetchModelIds };
