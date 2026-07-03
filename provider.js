"use strict";
const vscode = require("vscode");

const VENDOR = "anthropic-compat";
const API_KEY_SECRET = "anthropicCompat.apiKey";

function getConfig() {
  const cfg = vscode.workspace.getConfiguration("anthropicCompat");
  return {
    baseUrl: (cfg.get("baseUrl") || "").trim(),
    models: cfg.get("models") || [],
    authHeader: cfg.get("authHeader") || "x-api-key",
    extraHeaders: cfg.get("extraHeaders") || {},
  };
}

/** baseUrl -> full /v1/messages endpoint; a per-model url wins and is used as-is. */
function resolveEndpoint(baseUrl, modelUrl) {
  if (modelUrl && modelUrl.trim()) {
    return modelUrl.trim();
  }
  let base = baseUrl.replace(/\/+$/, "");
  if (/\/v1\/messages$/.test(base)) {
    return base;
  }
  if (/\/v1$/.test(base)) {
    return base + "/messages";
  }
  return base + "/v1/messages";
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
      // e.g. LanguageModelPromptTsxPart
      try {
        pieces.push(JSON.stringify(c.value));
      } catch {
        /* ignore */
      }
    }
  }
  return pieces.join("\n");
}

/** Convert VS Code chat messages into Anthropic { system, messages }. */
function convertMessages(messages) {
  const systemParts = [];
  const out = [];

  for (const msg of messages) {
    if (isSystemRole(msg.role)) {
      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart && part.value) {
          systemParts.push(part.value);
        }
      }
      continue;
    }

    const role =
      msg.role === vscode.LanguageModelChatMessageRole.Assistant
        ? "assistant"
        : "user";

    // Anthropic expects tool_result blocks to lead the user turn.
    const toolResults = [];
    const rest = [];

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value.length > 0) {
          rest.push({ type: "text", text: part.value });
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        rest.push({
          type: "tool_use",
          id: part.callId,
          name: part.name,
          input: part.input || {},
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: part.callId,
          content: toolResultText(part) || "(no output)",
        });
      } else if (isDataPart(part)) {
        const mime = part.mimeType || "image/png";
        if (mime.startsWith("image/")) {
          rest.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mime,
              data: Buffer.from(part.data).toString("base64"),
            },
          });
        }
      }
    }

    const content = toolResults.concat(rest);
    if (content.length > 0) {
      out.push({ role, content });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function convertTools(options) {
  const tools = options && options.tools;
  if (!tools || tools.length === 0) {
    return {};
  }
  const converted = tools.map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.inputSchema || { type: "object", properties: {} },
  }));
  const required =
    options.toolMode !== undefined &&
    options.toolMode === vscode.LanguageModelChatToolMode.Required;
  const result = { tools: converted };
  if (required) {
    result.tool_choice = { type: "any" };
  }
  return result;
}

class AnthropicCompatProvider {
  constructor(secrets) {
    this._secrets = secrets;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  }

  refresh() {
    this._onDidChange.fire();
  }

  async provideLanguageModelChatInformation(options, _token) {
    const { baseUrl, models } = getConfig();

    if (models.length === 0 || !baseUrl) {
      if (!options.silent) {
        const pick = await vscode.window.showInformationMessage(
          "Anthropic Compatible: configure baseUrl and models in settings first.",
          "Open Settings"
        );
        if (pick === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "anthropicCompat"
          );
        }
      }
      return [];
    }

    let apiKey = await this._secrets.get(API_KEY_SECRET);
    if (!apiKey && !options.silent) {
      apiKey = await this.promptForApiKey();
    }
    if (!apiKey) {
      return [];
    }

    return models
      .filter((m) => m.id && m.id.trim())
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        family: "claude",
        version: "1.0.0",
        maxInputTokens: m.maxInputTokens || 200000,
        maxOutputTokens: m.maxOutputTokens || 16000,
        tooltip: resolveEndpoint(baseUrl, m.url),
        capabilities: {
          toolCalling: m.toolCalling !== false,
          imageInput: m.vision !== false,
        },
      }));
  }

  async promptForApiKey() {
    const value = await vscode.window.showInputBox({
      title: "Anthropic Compatible: API Key",
      prompt:
        "Enter the API key for your endpoint (submit empty to clear the stored key)",
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return undefined; // user cancelled
    }
    if (value === "") {
      await this._secrets.delete(API_KEY_SECRET);
      this.refresh();
      vscode.window.showInformationMessage("API key cleared.");
      return undefined;
    }
    await this._secrets.store(API_KEY_SECRET, value.trim());
    this.refresh();
    return value.trim();
  }

  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const { baseUrl, models, authHeader, extraHeaders } = getConfig();
    const modelCfg = models.find((m) => m.id === model.id);
    const endpoint = resolveEndpoint(baseUrl, modelCfg && modelCfg.url);

    const apiKey = await this._secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      throw new Error(
        'Anthropic Compatible: no API key set (run "Anthropic Compatible: Set API Key").'
      );
    }

    const converted = convertMessages(messages);
    const body = {
      model: model.id,
      max_tokens: model.maxOutputTokens,
      stream: true,
      messages: converted.messages,
    };
    if (converted.system) {
      body.system = converted.system;
    }
    Object.assign(body, convertTools(options));

    const headers = Object.assign(
      {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      extraHeaders
    );
    if (authHeader === "authorization") {
      headers["authorization"] = "Bearer " + apiKey;
    } else {
      headers["x-api-key"] = apiKey;
    }

    const ac = new AbortController();
    const cancelSub = token.onCancellationRequested(() => ac.abort());

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          "Request failed " + res.status + " " + res.statusText + " @ " +
            endpoint + "\n" + errText.slice(0, 800)
        );
      }

      await this._consumeSSE(res.body, progress);
    } finally {
      cancelSub.dispose();
    }
  }

  async _consumeSSE(stream, progress) {
    const decoder = new TextDecoder();
    let buffer = "";
    // Open content blocks by index (tool_use accumulates streamed JSON input).
    const blocks = new Map();
    const ThinkingPart = vscode.LanguageModelThinkingPart;

    const handleEvent = (evt) => {
      switch (evt.type) {
        case "content_block_start": {
          const cb = evt.content_block || {};
          blocks.set(evt.index, {
            type: cb.type,
            id: cb.id,
            name: cb.name,
            json: "",
          });
          break;
        }
        case "content_block_delta": {
          const delta = evt.delta || {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            progress.report(new vscode.LanguageModelTextPart(delta.text));
          } else if (delta.type === "input_json_delta") {
            const b = blocks.get(evt.index);
            if (b) {
              b.json += delta.partial_json || "";
            }
          } else if (
            delta.type === "thinking_delta" &&
            typeof delta.thinking === "string" &&
            delta.thinking.length > 0 &&
            ThinkingPart
          ) {
            progress.report(new ThinkingPart(delta.thinking));
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(evt.index);
          if (b && b.type === "tool_use" && b.id && b.name) {
            let input = {};
            if (b.json && b.json.trim()) {
              try {
                input = JSON.parse(b.json);
              } catch {
                input = {};
              }
            }
            progress.report(
              new vscode.LanguageModelToolCallPart(b.id, b.name, input)
            );
          }
          blocks.delete(evt.index);
          break;
        }
        case "error": {
          const err = evt.error || {};
          throw new Error(
            "Endpoint returned error: " + (err.type || "unknown") + " - " +
              (err.message || "")
          );
        }
        default:
          // message_start / message_delta / message_stop / ping — nothing to do
          break;
      }
    };

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // tolerate non-standard keep-alive lines from relays
        }
        handleEvent(evt);
      }
    }
  }

  async provideTokenCount(_model, text, _token) {
    if (typeof text === "string") {
      return Math.ceil(text.length / 4);
    }
    let total = 8; // fixed per-message overhead
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

module.exports = { AnthropicCompatProvider, VENDOR, API_KEY_SECRET };
