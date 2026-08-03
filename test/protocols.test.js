"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PROTOCOLS, applyAnthropicToolCacheTtl, normalizeUsage } = require("../protocols");

function streamOf(events) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return (async function* () {
    yield new TextEncoder().encode(text);
  })();
}

function context(overrides = {}) {
  return {
    modelId: "claude-test",
    maxOutputTokens: 128,
    neutral: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
    tools: [],
    toolsRequired: false,
    anthropicCacheTtl: "off",
    thinking: false,
    ...overrides,
  };
}

const tools = [
  { name: "first", description: "first tool", inputSchema: { type: "object" } },
  { name: "last", description: "last tool", inputSchema: { type: "object" } },
];

test("Anthropic cache compatibility is off by default", () => {
  const body = PROTOCOLS.anthropic.buildBody(context({ tools }));
  assert.equal(body.tools.length, 2);
  assert.equal(body.tools[0].cache_control, undefined);
  assert.equal(body.tools[1].cache_control, undefined);
});

test("Anthropic 1h mode marks only the last tool", () => {
  const body = PROTOCOLS.anthropic.buildBody(
    context({ tools, anthropicCacheTtl: "1h" })
  );
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.tools[1].cache_control, {
    type: "ephemeral",
    ttl: "1h",
  });
});

test("Anthropic 5m mode marks only the last tool", () => {
  const body = PROTOCOLS.anthropic.buildBody(
    context({ tools, anthropicCacheTtl: "5m" })
  );
  assert.deepEqual(body.tools[1].cache_control, {
    type: "ephemeral",
    ttl: "5m",
  });
});

test("invalid TTL and empty tools are ignored", () => {
  const invalid = [{ name: "tool" }];
  applyAnthropicToolCacheTtl(invalid, "2h");
  assert.equal(invalid[0].cache_control, undefined);

  const empty = [];
  applyAnthropicToolCacheTtl(empty, "1h");
  assert.deepEqual(empty, []);
});

test("OpenAI protocol bodies do not receive Anthropic cache_control", () => {
  const chatBody = PROTOCOLS["chat-completions"].buildBody(
    context({ tools, anthropicCacheTtl: "1h" })
  );
  assert.equal(chatBody.tools[0].cache_control, undefined);

  const responsesBody = PROTOCOLS.responses.buildBody(
    context({ tools, anthropicCacheTtl: "1h" })
  );
  assert.equal(responsesBody.tools[0].cache_control, undefined);
});

test("usage is normalized across upstream protocols", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 12, output_tokens: 5 }, "anthropic"), {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
  });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 20 }, "chat"), {
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 20,
  });
});

test("Anthropic parser reports final usage", async () => {
  const usages = [];
  await PROTOCOLS.anthropic.parseStream(streamOf([
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "message_delta", usage: { output_tokens: 4 } },
  ]), { text() {}, thinking() {}, toolCall() {}, usage(value) { usages.push(value); } });
  assert.deepEqual(usages.at(-1), {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
  });
});

test("Chat Completions requests usage and reports it", async () => {
  const body = PROTOCOLS["chat-completions"].buildBody(context({ usageMode: "auto" }));
  assert.deepEqual(body.stream_options, { include_usage: true });
  const usages = [];
  await PROTOCOLS["chat-completions"].parseStream(streamOf([
    { choices: [{ delta: { content: "ok" } }] },
    { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
    { __done: true },
  ]), { text() {}, thinking() {}, toolCall() {}, usage(value) { usages.push(value); } });
  assert.deepEqual(usages.at(-1), {
    prompt_tokens: 8,
    completion_tokens: 2,
    total_tokens: 10,
  });
});

test("Responses parser reports response.completed usage", async () => {
  const usages = [];
  await PROTOCOLS.responses.parseStream(streamOf([
    { type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } },
  ]), { text() {}, thinking() {}, toolCall() {}, usage(value) { usages.push(value); } });
  assert.deepEqual(usages.at(-1), {
    prompt_tokens: 9,
    completion_tokens: 3,
    total_tokens: 12,
  });
});