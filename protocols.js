"use strict";
/**
 * Protocol adapters. Each adapter maps a neutral message model to a wire
 * request and parses the protocol's SSE stream.
 *
 * Neutral model produced by provider.js:
 *   { role: "system"|"user"|"assistant",
 *     parts: [ { kind:"text", text }
 *            | { kind:"image", mime, b64 }
 *            | { kind:"toolCall", id, name, input }
 *            | { kind:"toolResult", id, text } ] }
 *
 * Stream sink (protocol-agnostic):
 *   sink.text(str)  sink.thinking(str)  sink.toolCall(id, name, inputObj)
 */

/** Async-iterate SSE `data:` payload objects from a fetch body stream. */
async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
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
      if (!payload) {
        continue;
      }
      if (payload === "[DONE]") {
        yield { __done: true };
        continue;
      }
      try {
        yield JSON.parse(payload);
      } catch {
        // tolerate malformed keep-alive lines from relays
      }
    }
  }
}

function parseJsonSafe(text) {
  if (!text || !text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function joinSystemText(neutral) {
  const parts = [];
  for (const m of neutral) {
    if (m.role === "system") {
      for (const p of m.parts) {
        if (p.kind === "text" && p.text) {
          parts.push(p.text);
        }
      }
    }
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages API                                              */
/* ------------------------------------------------------------------ */

const anthropic = {
  defaultPath: "messages",
  defaultAuth: "x-api-key",

  headers(apiKey, authHeader) {
    const h = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) {
      if (authHeader === "authorization") {
        h["authorization"] = "Bearer " + apiKey;
      } else {
        h["x-api-key"] = apiKey;
      }
    }
    return h;
  },

  buildBody(ctx) {
    const messages = [];
    for (const m of ctx.neutral) {
      if (m.role === "system") {
        continue;
      }
      const toolResults = [];
      const rest = [];
      for (const p of m.parts) {
        if (p.kind === "text" && p.text.length > 0) {
          rest.push({ type: "text", text: p.text });
        } else if (p.kind === "toolCall") {
          rest.push({ type: "tool_use", id: p.id, name: p.name, input: p.input });
        } else if (p.kind === "toolResult") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: p.id,
            content: p.text || "(no output)",
          });
        } else if (p.kind === "image") {
          rest.push({
            type: "image",
            source: { type: "base64", media_type: p.mime, data: p.b64 },
          });
        }
      }
      const content = toolResults.concat(rest);
      if (content.length > 0) {
        messages.push({ role: m.role, content });
      }
    }

    const body = {
      model: ctx.modelId,
      max_tokens: ctx.maxOutputTokens,
      stream: true,
      messages,
    };
    const system = joinSystemText(ctx.neutral);
    if (system) {
      body.system = system;
    }
    if (ctx.tools.length > 0) {
      body.tools = ctx.tools.map((t) => ({
        name: t.name,
        description: t.description || "",
        input_schema: t.inputSchema || { type: "object", properties: {} },
      }));
      if (ctx.toolsRequired) {
        body.tool_choice = { type: "any" };
      }
    }
    if (ctx.effort) {
      body.output_config = { effort: ctx.effort };
    }
    if (ctx.thinking) {
      body.thinking = { type: "adaptive", display: "summarized" };
    }
    return body;
  },

  async parseStream(stream, sink) {
    const blocks = new Map();
    for await (const evt of sseEvents(stream)) {
      switch (evt.type) {
        case "content_block_start": {
          const cb = evt.content_block || {};
          blocks.set(evt.index, { type: cb.type, id: cb.id, name: cb.name, json: "" });
          break;
        }
        case "content_block_delta": {
          const d = evt.delta || {};
          if (d.type === "text_delta" && typeof d.text === "string") {
            sink.text(d.text);
          } else if (d.type === "input_json_delta") {
            const b = blocks.get(evt.index);
            if (b) {
              b.json += d.partial_json || "";
            }
          } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
            sink.thinking(d.thinking);
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(evt.index);
          if (b && b.type === "tool_use" && b.id && b.name) {
            sink.toolCall(b.id, b.name, parseJsonSafe(b.json));
          }
          blocks.delete(evt.index);
          break;
        }
        case "error": {
          const err = evt.error || {};
          throw new Error((err.type || "error") + ": " + (err.message || "unknown"));
        }
        default:
          break;
      }
    }
  },
};

/* ------------------------------------------------------------------ */
/* OpenAI Chat Completions API                                         */
/* ------------------------------------------------------------------ */

const chatCompletions = {
  defaultPath: "chat/completions",
  defaultAuth: "authorization",

  headers(apiKey, authHeader) {
    const h = { "content-type": "application/json" };
    if (apiKey) {
      if (authHeader === "x-api-key") {
        h["x-api-key"] = apiKey;
      } else {
        h["authorization"] = "Bearer " + apiKey;
      }
    }
    return h;
  },

  buildBody(ctx) {
    const messages = [];
    for (const m of ctx.neutral) {
      if (m.role === "system") {
        const text = m.parts
          .filter((p) => p.kind === "text" && p.text)
          .map((p) => p.text)
          .join("\n\n");
        if (text) {
          messages.push({ role: "system", content: text });
        }
        continue;
      }
      if (m.role === "assistant") {
        const text = m.parts
          .filter((p) => p.kind === "text")
          .map((p) => p.text)
          .join("");
        const toolCalls = m.parts
          .filter((p) => p.kind === "toolCall")
          .map((p) => ({
            id: p.id,
            type: "function",
            function: { name: p.name, arguments: JSON.stringify(p.input || {}) },
          }));
        const msg = { role: "assistant", content: text || null };
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        if (msg.content !== null || toolCalls.length > 0) {
          messages.push(msg);
        }
        continue;
      }
      // user turn: tool results become role:"tool" messages first
      for (const p of m.parts) {
        if (p.kind === "toolResult") {
          messages.push({
            role: "tool",
            tool_call_id: p.id,
            content: p.text || "(no output)",
          });
        }
      }
      const content = [];
      for (const p of m.parts) {
        if (p.kind === "text" && p.text.length > 0) {
          content.push({ type: "text", text: p.text });
        } else if (p.kind === "image") {
          content.push({
            type: "image_url",
            image_url: { url: "data:" + p.mime + ";base64," + p.b64 },
          });
        }
      }
      if (content.length > 0) {
        const onlyText = content.every((c) => c.type === "text");
        messages.push({
          role: "user",
          content: onlyText ? content.map((c) => c.text).join("\n") : content,
        });
      }
    }

    const body = { model: ctx.modelId, stream: true, messages };
    body[ctx.maxTokensField || "max_completion_tokens"] = ctx.maxOutputTokens;
    if (ctx.tools.length > 0) {
      body.tools = ctx.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.inputSchema || { type: "object", properties: {} },
        },
      }));
      if (ctx.toolsRequired) {
        body.tool_choice = "required";
      }
    }
    if (ctx.effort) {
      body.reasoning_effort = ctx.effort;
    }
    return body;
  },

  async parseStream(stream, sink) {
    const pending = new Map(); // tool call index -> {id, name, args}
    const flush = () => {
      const keys = Array.from(pending.keys()).sort((a, b) => a - b);
      for (const k of keys) {
        const c = pending.get(k);
        if (c.id && c.name) {
          sink.toolCall(c.id, c.name, parseJsonSafe(c.args));
        }
      }
      pending.clear();
    };

    for await (const evt of sseEvents(stream)) {
      if (evt.__done) {
        break;
      }
      if (evt.error) {
        const err = evt.error;
        throw new Error((err.type || "error") + ": " + (err.message || JSON.stringify(err)));
      }
      const choice = (evt.choices && evt.choices[0]) || {};
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        sink.text(delta.content);
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        sink.thinking(reasoning);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!pending.has(idx)) {
            pending.set(idx, { id: "", name: "", args: "" });
          }
          const c = pending.get(idx);
          if (tc.id) {
            c.id = tc.id;
          }
          if (tc.function && tc.function.name) {
            c.name = tc.function.name;
          }
          if (tc.function && typeof tc.function.arguments === "string") {
            c.args += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) {
        flush();
      }
    }
    flush(); // in case the stream ended without an explicit finish_reason
  },
};

/* ------------------------------------------------------------------ */
/* OpenAI Responses API                                                */
/* ------------------------------------------------------------------ */

const responses = {
  defaultPath: "responses",
  defaultAuth: "authorization",

  headers(apiKey, authHeader) {
    return chatCompletions.headers(apiKey, authHeader);
  },

  buildBody(ctx) {
    const input = [];
    for (const m of ctx.neutral) {
      if (m.role === "system") {
        continue;
      }
      if (m.role === "assistant") {
        const text = m.parts
          .filter((p) => p.kind === "text")
          .map((p) => p.text)
          .join("");
        if (text) {
          input.push({
            role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }
        for (const p of m.parts) {
          if (p.kind === "toolCall") {
            input.push({
              type: "function_call",
              call_id: p.id,
              name: p.name,
              arguments: JSON.stringify(p.input || {}),
            });
          }
        }
        continue;
      }
      // user turn
      for (const p of m.parts) {
        if (p.kind === "toolResult") {
          input.push({
            type: "function_call_output",
            call_id: p.id,
            output: p.text || "(no output)",
          });
        }
      }
      const content = [];
      for (const p of m.parts) {
        if (p.kind === "text" && p.text.length > 0) {
          content.push({ type: "input_text", text: p.text });
        } else if (p.kind === "image") {
          content.push({
            type: "input_image",
            image_url: "data:" + p.mime + ";base64," + p.b64,
          });
        }
      }
      if (content.length > 0) {
        input.push({ role: "user", content });
      }
    }

    const body = {
      model: ctx.modelId,
      stream: true,
      max_output_tokens: ctx.maxOutputTokens,
      input,
    };
    const system = joinSystemText(ctx.neutral);
    if (system) {
      body.instructions = system;
    }
    if (ctx.tools.length > 0) {
      body.tools = ctx.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description || "",
        parameters: t.inputSchema || { type: "object", properties: {} },
      }));
      if (ctx.toolsRequired) {
        body.tool_choice = "required";
      }
    }
    const reasoning = {};
    if (ctx.effort) {
      reasoning.effort = ctx.effort;
    }
    if (ctx.thinking) {
      reasoning.summary = "auto";
    }
    if (Object.keys(reasoning).length > 0) {
      body.reasoning = reasoning;
    }
    return body;
  },

  async parseStream(stream, sink) {
    for await (const evt of sseEvents(stream)) {
      if (evt.__done) {
        break;
      }
      switch (evt.type) {
        case "response.output_text.delta": {
          if (typeof evt.delta === "string" && evt.delta.length > 0) {
            sink.text(evt.delta);
          }
          break;
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          if (typeof evt.delta === "string" && evt.delta.length > 0) {
            sink.thinking(evt.delta);
          }
          break;
        }
        case "response.output_item.done": {
          const item = evt.item || {};
          if (item.type === "function_call" && item.call_id && item.name) {
            sink.toolCall(item.call_id, item.name, parseJsonSafe(item.arguments));
          }
          break;
        }
        case "response.failed": {
          const err = (evt.response && evt.response.error) || {};
          throw new Error((err.code || "response.failed") + ": " + (err.message || "unknown"));
        }
        case "error": {
          throw new Error((evt.code || "error") + ": " + (evt.message || "unknown"));
        }
        default:
          break;
      }
    }
  },
};

const PROTOCOLS = {
  anthropic,
  "chat-completions": chatCompletions,
  responses,
};

/** Resolve endpoint URL from base + protocol path (per-model url wins as-is). */
function resolveEndpoint(baseUrl, apiType, modelUrl) {
  if (modelUrl && modelUrl.trim()) {
    return modelUrl.trim();
  }
  const path = (PROTOCOLS[apiType] || anthropic).defaultPath;
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (base.endsWith("/v1/" + path) || base.endsWith("/" + path)) {
    return base;
  }
  if (/\/v1$/.test(base)) {
    return base + "/" + path;
  }
  return base + "/v1/" + path;
}

module.exports = { PROTOCOLS, resolveEndpoint };
