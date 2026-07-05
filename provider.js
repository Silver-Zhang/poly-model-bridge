"use strict";
const vscode = require("vscode");
const { PROTOCOLS, resolveEndpoint } = require("./protocols");

const VENDOR = "poly-bridge";
const SEP = "\u001F"; // internal picker-id separator: provider SEP model SEP effort

function keySecretId(providerName) {
  return "polyBridge.apiKey::" + providerName;
}

function getProviders() {
  const cfg = vscode.workspace.getConfiguration("polyBridge");
  const providers = cfg.get("providers") || [];
  return providers.filter(
    (p) => p && p.name && p.baseUrl && Array.isArray(p.models)
  );
}

function isSystemRole(role) {
  const sys = vscode.LanguageModelChatMessageRole.System;
  return typeof sys === "number" ? role === sys : role === 3;
}

function isDataPart(part) {
  const Ctor = vscode.LanguageModelDataPart;
  if (Ctor && part instanceof Ctor) {
    return true;
  }
  return (
    !!part &&
    typeof part === "object" &&
    typeof part.mimeType === "string" &&
    part.data instanceof Uint8Array
  );
}

function toolResultText(part) {
  const pieces = [];
  for (const c of part.content || []) {
    if (c instanceof vscode.LanguageModelTextPart) {
      pieces.push(c.value);
    } else if (c && typeof c === "object" && "value" in c) {
      try {
        pieces.push(JSON.stringify(c.value));
      } catch {
        /* ignore */
      }
    }
  }
  return pieces.join("\n");
}

/** VS Code chat messages -> protocol-neutral model (see protocols.js). */
function extractNeutral(messages) {
  const neutral = [];
  for (const msg of messages) {
    const role = isSystemRole(msg.role)
      ? "system"
      : msg.role === vscode.LanguageModelChatMessageRole.Assistant
        ? "assistant"
        : "user";
    const parts = [];
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push({ kind: "text", text: part.value });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        parts.push({
          kind: "toolCall",
          id: part.callId,
          name: part.name,
          input: part.input || {},
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        parts.push({ kind: "toolResult", id: part.callId, text: toolResultText(part) });
      } else if (isDataPart(part)) {
        const mime = part.mimeType || "image/png";
        if (mime.startsWith("image/")) {
          parts.push({
            kind: "image",
            mime,
            b64: Buffer.from(part.data).toString("base64"),
          });
        }
      }
    }
    if (parts.length > 0) {
      neutral.push({ role, parts });
    }
  }
  return neutral;
}

/** Flatten providers × models × effort variants into picker entries. */
function enumerateModels() {
  const providers = getProviders();
  const multi = providers.length > 1;
  const entries = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      if (!model || !model.id || !model.id.trim()) {
        continue;
      }
      const efforts =
        Array.isArray(model.efforts) && model.efforts.length > 0
          ? model.efforts
          : [model.effort || ""];
      for (const effort of efforts) {
        const baseName = model.name || model.id;
        const suffix =
          (effort ? " (" + effort + ")" : "") +
          (multi ? " · " + provider.name : "");
        entries.push({
          pickerId: provider.name + SEP + model.id + SEP + (effort || ""),
          provider,
          model,
          effort: effort || undefined,
          apiType: model.apiType || provider.apiType || "anthropic",
          info: {
            id: provider.name + SEP + model.id + SEP + (effort || ""),
            name: baseName + suffix,
            family:
              (model.apiType || provider.apiType || "anthropic") === "anthropic"
                ? "claude"
                : "gpt",
            version: "1.0.0",
            maxInputTokens: model.maxInputTokens || 200000,
            maxOutputTokens: model.maxOutputTokens || 16000,
            tooltip: resolveEndpoint(
              provider.baseUrl,
              model.apiType || provider.apiType || "anthropic",
              model.url
            ),
            capabilities: {
              toolCalling: model.toolCalling !== false,
              imageInput: model.vision !== false,
            },
          },
        });
      }
    }
  }
  return entries;
}

class PolyBridgeProvider {
  constructor(secrets) {
    this._secrets = secrets;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  }

  refresh() {
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(options, _token) {
    const providers = getProviders();
    if (providers.length === 0) {
      if (!options.silent) {
        const pick = await vscode.window.showInformationMessage(
          "Poly Model Bridge: configure providers in settings first.",
          "Open Settings"
        );
        if (pick === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "polyBridge.providers"
          );
        }
      }
      return [];
    }

    if (!options.silent) {
      for (const p of providers) {
        if (p.requiresApiKey === false) {
          continue;
        }
        const existing = await this._secrets.get(keySecretId(p.name));
        if (!existing) {
          await this.promptForApiKey(p.name); // Esc skips; key re-checked at request time
        }
      }
    }

    return enumerateModels().map((e) => e.info);
  }

  getApiKey(providerName) {
    return this._secrets.get(keySecretId(providerName));
  }

  async deleteApiKey(providerName) {
    await this._secrets.delete(keySecretId(providerName));
    this.refresh();
  }

  async promptForApiKey(providerName) {
    const value = await vscode.window.showInputBox({
      title: "Poly Model Bridge: API key for " + providerName,
      prompt: "Enter the API key (submit empty to clear the stored key)",
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return undefined; // cancelled
    }
    if (value === "") {
      await this._secrets.delete(keySecretId(providerName));
      this.refresh();
      vscode.window.showInformationMessage(
        "API key cleared for " + providerName + "."
      );
      return undefined;
    }
    await this._secrets.store(keySecretId(providerName), value.trim());
    this.refresh();
    return value.trim();
  }

  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const entry = enumerateModels().find((e) => e.pickerId === model.id);
    if (!entry) {
      throw new Error(
        "Poly Model Bridge: model not found in settings (was the configuration changed?)."
      );
    }
    const { provider, apiType, effort } = entry;
    const adapter = PROTOCOLS[apiType];
    if (!adapter) {
      throw new Error("Poly Model Bridge: unknown apiType '" + apiType + "'.");
    }

    let apiKey = "";
    if (provider.requiresApiKey !== false) {
      apiKey = await this._secrets.get(keySecretId(provider.name));
      if (!apiKey) {
        apiKey = await this.promptForApiKey(provider.name);
      }
      if (!apiKey) {
        throw new Error(
          'Poly Model Bridge: no API key for "' + provider.name +
            '" (run "Poly Model Bridge: Set API Key").'
        );
      }
    }

    const ctx = {
      modelId: entry.model.id,
      maxOutputTokens: model.maxOutputTokens,
      maxTokensField: entry.model.maxTokensField,
      neutral: extractNeutral(messages),
      tools: (options && options.tools) || [],
      toolsRequired:
        options &&
        options.toolMode !== undefined &&
        options.toolMode === vscode.LanguageModelChatToolMode.Required,
      effort,
      thinking: entry.model.thinking === true,
    };

    const endpoint = resolveEndpoint(provider.baseUrl, apiType, entry.model.url);
    const headers = Object.assign(
      adapter.headers(apiKey, provider.authHeader || adapter.defaultAuth),
      provider.extraHeaders || {}
    );

    const ThinkingPart = vscode.LanguageModelThinkingPart;
    const sink = {
      text: (t) => progress.report(new vscode.LanguageModelTextPart(t)),
      thinking: (t) => {
        if (ThinkingPart && t) {
          progress.report(new ThinkingPart(t));
        }
      },
      toolCall: (id, name, input) =>
        progress.report(new vscode.LanguageModelToolCallPart(id, name, input)),
    };

    const ac = new AbortController();
    const cancelSub = token.onCancellationRequested(() => ac.abort());
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(adapter.buildBody(ctx)),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          "Request failed " + res.status + " " + res.statusText + " @ " +
            endpoint + "\n" + errText.slice(0, 800)
        );
      }
      await adapter.parseStream(res.body, sink);
    } finally {
      cancelSub.dispose();
    }
  }

  async provideTokenCount(_model, text, _token) {
    if (typeof text === "string") {
      return Math.ceil(text.length / 4);
    }
    let total = 8;
    for (const part of text.content || []) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += Math.ceil(part.value.length / 4);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        total += Math.ceil(JSON.stringify(part.input || {}).length / 4) + 16;
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        total += Math.ceil(toolResultText(part).length / 4) + 16;
      }
    }
    return total;
  }
}

module.exports = { PolyBridgeProvider, VENDOR, getProviders };
