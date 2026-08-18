"use strict";
const vscode = require("vscode");
const { PROTOCOLS, resolveEndpoint } = require("./protocols");
const {
  estimateTokenCount,
  sanitizeNeutral,
  completeUsage,
  pruneNeutralToBudget,
} = require("./context");

const VENDOR = "poly-bridge";
// Picker-id separator: provider SEP model SEP effort. Kept printable so the id
// can be hand-written into VS Code's `chat.utilityModel` (whose format is
// `vendor/id`) and read back out of settings.json. sanitizeProvider rejects
// provider names containing it, keeping the three-part id unambiguous.
const SEP = "::";

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

/**
 * Whether this request is a delegated subagent turn.
 *
 * VS Code has no setting for the model a `runSubagent` call uses. With no
 * `agentName` argument core calls `resolveSubagentModel(void 0, currentModelId,
 * undefined)`, which returns the main session's model outright, so the request
 * reaches us indistinguishable from the main turn — same picker id, same
 * `requestInitiator` (the Copilot extension either way).
 *
 * The tool list is the one signal that survives. Core disables the runSubagent
 * tool inside a subagent unless `chat.subagents.allowInvocationsFromSubagents`
 * is on, and that setting defaults to false:
 *
 *   let W = F ? S7n : 0;      // F = the setting
 *   let Q = G + 1 <= W;       // false when W is 0
 *   g[zK.Id] = Q;             // runSubagent removed from the subagent's tools
 *
 * So an agentic request that cannot itself delegate is a subagent turn.
 * Deliberately conservative: a request with no tools at all is a utility call
 * (titles, mapCode, summaries), which `chat.utilityModel` already routes, so it
 * is left alone here. If the user turns nested subagents on, the signal
 * disappears and this silently degrades to plain inheritance.
 */
function isSubagentRequest(options) {
  const tools = options && options.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return false;
  }
  return !tools.some((tool) => /subagent/i.test((tool && tool.name) || ""));
}

/**
 * Swap in the configured subagent model for a delegated turn. Returns `entry`
 * unchanged whenever the redirect is off, not applicable, or points at a model
 * that no longer exists — a stale picker id must not break the request.
 */
function resolveSubagentEntry(entry, options, entries) {
  const cfg = vscode.workspace.getConfiguration("polyBridge");
  if (cfg.get("subagentRedirect") !== true) {
    return entry;
  }
  const target = cfg.get("subagentModel");
  if (!target || target === entry.pickerId || !isSubagentRequest(options)) {
    return entry;
  }
  return entries.find((e) => e.pickerId === target) || entry;
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
        const pickerId = provider.name + SEP + model.id + SEP + (effort || "");
        const displayName = baseName + suffix;
        entries.push({
          pickerId,
          provider,
          model,
          effort: effort || undefined,
          apiType: model.apiType || provider.apiType || "anthropic",
          // How other VS Code features address this model:
          //   qualifiedName -> `.agent.md` frontmatter `model:` and instructions
          //   utilityRef    -> `chat.utilityModel` / `chat.utilitySmallModel`
          qualifiedName: displayName + " (" + VENDOR + ")",
          utilityRef: VENDOR + "/" + pickerId,
          info: {
            id: pickerId,
            name: displayName,
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
  constructor(secrets, output) {
    this._secrets = secrets;
    this._output = output;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
    this._onDidUseModel = new vscode.EventEmitter();
    this.onDidUseModel = this._onDidUseModel.event;
    this.lastUsed = undefined; // { providerName, modelId } of the most recent request
  }

  refresh() {
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(options, _token) {
    const providers = getProviders();
    if (providers.length === 0) {
      if (!options.silent) {
        const pick = await vscode.window.showInformationMessage(
          "Poly Model Bridge: 还没有配置中转站。用向导添加一个，全程无需编辑 JSON。",
          "添加中转站",
          "打开设置"
        );
        if (pick === "添加中转站") {
          vscode.commands.executeCommand("polyBridge.addProvider");
        } else if (pick === "打开设置") {
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
    const entries = enumerateModels();
    const selected = entries.find((e) => e.pickerId === model.id);
    if (!selected) {
      throw new Error(
        "Poly Model Bridge: model not found in settings (was the configuration changed?)."
      );
    }
    // VS Code still believes this turn runs on `selected`; only the upstream
    // call is redirected, so the chat UI keeps showing the inherited name.
    const entry = resolveSubagentEntry(selected, options, entries);
    if (entry !== selected) {
      this._output?.appendLine(
        `[PolyBridge] subagent turn detected: ${selected.pickerId} -> ${entry.pickerId}`
      );
    }
    const { provider, apiType, effort } = entry;
    this.lastUsed = { providerName: provider.name, modelId: entry.model.id };
    this._onDidUseModel.fire(this.lastUsed);
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
      anthropicCacheTtl: entry.model.anthropicCacheTtl || provider.anthropicCacheTtl || "off",
      effort,
      thinking: entry.model.thinking === true,
      usageMode: entry.model.usageMode || provider.usageMode || "auto",
    };

    const maxInputTokens = Number(entry.model.maxInputTokens || 200000);
    const toolResultMaxTokens = Number(entry.model.toolResultMaxTokens) ||
      Math.max(512, Math.min(32768, Math.floor(maxInputTokens * 0.2)));
    ctx.neutral = sanitizeNeutral(ctx.neutral, toolResultMaxTokens);
    const reserve = Math.max(256, Number(ctx.maxOutputTokens || 16000));
    const budget = Math.max(1, maxInputTokens - reserve);
    const pruned = pruneNeutralToBudget(
      ctx.neutral,
      budget,
      (neutral) => adapter.buildBody({ ...ctx, neutral })
    );
    ctx.neutral = pruned.neutral;
    if (pruned.estimatedTokens > budget) {
      throw new Error(
        `Poly Model Bridge: 请求上下文过长（估算 ${pruned.estimatedTokens} tokens，` +
        `可用上限 ${budget} tokens）。请缩小上下文长度、减少工具输出，或新建聊天。`
      );
    }

    const endpoint = resolveEndpoint(provider.baseUrl, apiType, entry.model.url);
    const headers = Object.assign(
      adapter.headers(apiKey, provider.authHeader || adapter.defaultAuth),
      provider.extraHeaders || {}
    );

    const ThinkingPart = vscode.LanguageModelThinkingPart;
    let upstreamUsage;
    let completionTokens = 0;
    const sink = {
      text: (t) => {
        completionTokens += estimateTokenCount(t);
        progress.report(new vscode.LanguageModelTextPart(t));
      },
      thinking: (t) => {
        completionTokens += estimateTokenCount(t);
        if (ThinkingPart && t) {
          progress.report(new ThinkingPart(t));
        }
      },
      toolCall: (id, name, input) => {
        completionTokens += 16 + estimateTokenCount(JSON.stringify(input || {}));
        progress.report(new vscode.LanguageModelToolCallPart(id, name, input));
      },
      usage: (usage) => {
        upstreamUsage = usage;
      },
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
        const hints = res.status === 400
          ? "\n可能原因：reasoning_effort、max_completion_tokens、tool_choice 或工具调用参数不被中转站支持；也请确认接口格式和请求地址。"
          : "";
        throw new Error(
          "Request failed " + res.status + " " + res.statusText + " @ " +
            endpoint + hints + "\n" + errText.slice(0, 1600)
        );
      }
      await adapter.parseStream(res.body, sink);
      if (vscode.LanguageModelDataPart) {
        const promptTokens = estimateTokenCount(
          JSON.stringify(adapter.buildBody(ctx))
        );
        const usage = completeUsage(upstreamUsage, promptTokens, completionTokens);
        const usagePart = new vscode.LanguageModelDataPart(
          new TextEncoder().encode(JSON.stringify(usage)),
          "usage"
        );
        progress.report(usagePart);
        this._output?.appendLine(
          `[usage] ${provider.name}/${entry.model.id}: ` +
          `prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, ` +
          `total=${usage.total_tokens}, source=${upstreamUsage ? "upstream" : "estimated"}`
        );
      } else {
        this._output?.appendLine(
          `[usage] ${provider.name}/${entry.model.id}: VS Code 不支持 LanguageModelDataPart，无法上报。`
        );
      }
    } finally {
      cancelSub.dispose();
    }
  }

  async provideTokenCount(model, text, _token) {
    const entry = enumerateModels().find((item) => item.pickerId === model.id);
    const strategy = entry && entry.model.tokenEstimator === "balanced"
      ? "balanced"
      : "conservative";
    if (typeof text === "string") {
      return estimateTokenCount(text, strategy);
    }
    let total = 8;
    for (const part of text.content || []) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += estimateTokenCount(part.value, strategy) + 4;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        total += estimateTokenCount(JSON.stringify(part.input || {}), strategy) + 24;
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        total += estimateTokenCount(toolResultText(part), strategy) + 24;
      }
    }
    return total;
  }
}

module.exports = {
  PolyBridgeProvider,
  VENDOR,
  SEP,
  getProviders,
  enumerateModels,
  isSubagentRequest,
  resolveSubagentEntry,
};
