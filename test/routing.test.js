"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// routing.js imports vscode for the settings I/O; the pure planners under test
// do not touch it, so a minimal shim is enough (same approach as manager.test.js).
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return { workspace: { getConfiguration: () => ({ inspect: () => undefined }) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const routing = require("../routing");
Module._load = originalLoad;

const refFor = (pickerId) => (pickerId ? "poly-bridge/" + pickerId : undefined);
const byKey = (writes) => new Map(writes.map((write) => [write.key, write.value]));

test("utility mode 'model' writes both slots and keeps the fallback off Copilot", () => {
  const writes = byKey(routing.planSettings(
    { utility: "model", utilityModel: "relay::gpt::high" },
    refFor
  ));
  assert.equal(writes.get("chat.utilityModel"), "poly-bridge/relay::gpt::high");
  // small slot falls back to the primary rather than staying on the subscription
  assert.equal(writes.get("chat.utilitySmallModel"), "poly-bridge/relay::gpt::high");
  assert.equal(writes.get("chat.byokUtilityModelDefault"), "mainAgent");
});

test("utility mode 'copilot' clears overrides instead of pinning the default", () => {
  const writes = byKey(routing.planSettings({ utility: "copilot" }, refFor));
  assert.equal(writes.get("chat.utilityModel"), undefined);
  assert.equal(writes.get("chat.utilitySmallModel"), undefined);
  assert.equal(writes.get("chat.byokUtilityModelDefault"), undefined);
});

test("utility modes 'mainAgent' and 'none' are written through", () => {
  assert.equal(
    byKey(routing.planSettings({ utility: "mainAgent" }, refFor))
      .get("chat.byokUtilityModelDefault"),
    "mainAgent"
  );
  assert.equal(
    byKey(routing.planSettings({ utility: "none" }, refFor))
      .get("chat.byokUtilityModelDefault"),
    "none"
  );
});

test("selecting 'model' without a model is rejected", () => {
  assert.throws(
    () => routing.planSettings({ utility: "model", utilityModel: "" }, refFor),
    /请先为「辅助调用」选择一个 PolyBridge 模型/
  );
});

test("built-in subagents inherit via empty string, not by removal", () => {
  const inherit = byKey(routing.planSettings(
    { utility: "copilot", executionSubagent: "inherit", searchSubagent: "inherit" },
    refFor
  ));
  // "" makes Copilot fall through to getChatEndpoint(request); removing the
  // key would restore the hard-coded gemini-3-flash default instead.
  assert.equal(inherit.get("github.copilot.chat.executionSubagent.model"), "");
  assert.equal(inherit.get("github.copilot.chat.searchSubagent.model"), "");

  const kept = byKey(routing.planSettings({ utility: "copilot" }, refFor));
  assert.equal(kept.get("github.copilot.chat.executionSubagent.model"), undefined);
});

test("unknown routing values fall back to defaults", () => {
  const normalized = routing.normalizeRouting({ utility: "bogus", executionSubagent: 42 });
  assert.equal(normalized.utility, "copilot");
  assert.equal(normalized.executionSubagent, "default");
});

test("agent file pins the qualified name in frontmatter", () => {
  const file = routing.buildAgentFile("gpt-5.6 (xhigh) · Relay (poly-bridge)");
  assert.match(file, /^---\n/);
  assert.match(file, /^name: poly-subagent$/m);
  assert.match(file, /^model: gpt-5\.6 \(xhigh\) · Relay \(poly-bridge\)$/m);
});

test("agent file omits the model line when no model is chosen", () => {
  assert.doesNotMatch(routing.buildAgentFile(""), /^model:/m);
});

test("instructions list the allowed models and forbid the copilot vendor", () => {
  const block = routing.buildInstructions(["A (poly-bridge)", "B (poly-bridge)"]);
  assert.match(block, /- `A \(poly-bridge\)`/);
  assert.match(block, /- `B \(poly-bridge\)`/);
  assert.match(block, /禁止使用任何以 `\(copilot\)` 结尾的模型/);
  assert.match(block, /agentName: poly-subagent/);
});

test("instructions merge is idempotent and preserves surrounding content", () => {
  const first = routing.mergeInstructions("# 项目说明\n\n原有内容。", routing.buildInstructions(["A (poly-bridge)"]));
  assert.match(first, /# 项目说明/);
  assert.match(first, /- `A \(poly-bridge\)`/);

  const second = routing.mergeInstructions(first, routing.buildInstructions(["B (poly-bridge)"]));
  assert.match(second, /# 项目说明/);
  assert.match(second, /- `B \(poly-bridge\)`/);
  assert.doesNotMatch(second, /- `A \(poly-bridge\)`/);
  // the block is spliced in place, never duplicated
  assert.equal(second.split("BEGIN Poly Model Bridge routing").length - 1, 1);
});

test("merging into an empty file yields just the block", () => {
  const block = routing.buildInstructions(["A (poly-bridge)"]);
  assert.equal(routing.mergeInstructions("", block), block + "\n");
});
