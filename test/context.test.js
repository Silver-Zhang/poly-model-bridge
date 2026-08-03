"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estimateTokenCount,
  truncateText,
  completeUsage,
  pruneNeutralToBudget,
} = require("../context");

test("conservative estimate accounts for CJK and high entropy text", () => {
  assert.ok(estimateTokenCount("你好世界") > 1);
  assert.ok(estimateTokenCount("eyJrZXkiOiAidmFsdWUifQ==") > 5);
  assert.ok(estimateTokenCount("const value = { answer: true }; ") > 5);
});

test("large tool output keeps both ends and adds a marker", () => {
  const value = "HEAD-" + "x".repeat(3000) + "-TAIL";
  const result = truncateText(value, 512);
  assert.ok(result.startsWith("HEAD-"));
  assert.ok(result.endsWith("-TAIL"));
  assert.match(result, /工具输出过长/);
});

test("history pruning preserves system and latest user message", () => {
  const neutral = [
    { role: "system", parts: [{ kind: "text", text: "system" }] },
    { role: "user", parts: [{ kind: "text", text: "old ".repeat(200) }] },
    { role: "assistant", parts: [{ kind: "text", text: "old answer ".repeat(200) }] },
    { role: "user", parts: [{ kind: "text", text: "latest" }] },
  ];
  const result = pruneNeutralToBudget(neutral, 40, (messages) => ({ messages }));
  assert.equal(result.neutral[0].role, "system");
  assert.equal(result.neutral.at(-1).parts[0].text, "latest");
  assert.equal(result.pruned, true);
});

test("missing upstream usage falls back to conservative estimates", () => {
  assert.deepEqual(completeUsage(undefined, 120, 8), {
    prompt_tokens: 120,
    completion_tokens: 8,
    total_tokens: 128,
  });
  assert.deepEqual(completeUsage({ prompt_tokens: 100, completion_tokens: 4 }, 120, 8), {
    prompt_tokens: 100,
    completion_tokens: 4,
    total_tokens: 104,
  });
});
