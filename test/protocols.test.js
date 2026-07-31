"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PROTOCOLS, applyAnthropicToolCacheTtl } = require("../protocols");

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