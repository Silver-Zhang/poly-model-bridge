"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// provider.js imports vscode at load time; enumerateModels only needs the
// configuration reader, so a minimal shim covers it.
const Module = require("node:module");
const originalLoad = Module._load;
let configuredProviders = [];
let configuredSettings = {};
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      workspace: {
        getConfiguration: () => ({
          get: (key) =>
            key === "providers" ? configuredProviders : configuredSettings[key],
        }),
      },
      LanguageModelChatMessageRole: {},
      EventEmitter: class {
        constructor() {
          this.event = () => {};
        }
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  enumerateModels,
  SEP,
  isSubagentRequest,
  resolveSubagentEntry,
} = require("../provider");
Module._load = originalLoad;

const TWO_PROVIDERS = [
  { name: "Main", baseUrl: "https://a.example", models: [{ id: "big" }] },
  { name: "Cheap", baseUrl: "https://b.example", models: [{ id: "small" }] },
];
const AGENTIC = { tools: [{ name: "readFile" }, { name: "runSubagent" }] };
const DELEGATED = { tools: [{ name: "readFile" }, { name: "editFile" }] };

test("a subagent turn is the agentic request that cannot itself delegate", () => {
  assert.equal(isSubagentRequest(AGENTIC), false);
  assert.equal(isSubagentRequest(DELEGATED), true);
});

test("utility calls carry no tools and are left to chat.utilityModel", () => {
  assert.equal(isSubagentRequest({ tools: [] }), false);
  assert.equal(isSubagentRequest({}), false);
  assert.equal(isSubagentRequest(undefined), false);
});

test("redirect swaps the upstream model only for delegated turns", () => {
  configuredProviders = TWO_PROVIDERS;
  const entries = enumerateModels();
  const main = entries.find((e) => e.pickerId.startsWith("Main"));
  const cheap = entries.find((e) => e.pickerId.startsWith("Cheap"));

  configuredSettings = { subagentRedirect: true, subagentModel: cheap.pickerId };
  assert.equal(resolveSubagentEntry(main, DELEGATED, entries), cheap);
  assert.equal(resolveSubagentEntry(main, AGENTIC, entries), main);
});

test("redirect stays off unless explicitly enabled with a target", () => {
  configuredProviders = TWO_PROVIDERS;
  const entries = enumerateModels();
  const main = entries.find((e) => e.pickerId.startsWith("Main"));
  const cheap = entries.find((e) => e.pickerId.startsWith("Cheap"));

  configuredSettings = { subagentRedirect: false, subagentModel: cheap.pickerId };
  assert.equal(resolveSubagentEntry(main, DELEGATED, entries), main);

  configuredSettings = { subagentRedirect: true, subagentModel: "" };
  assert.equal(resolveSubagentEntry(main, DELEGATED, entries), main);
});

test("a stale target picker id falls back to the inherited model", () => {
  configuredProviders = TWO_PROVIDERS;
  const entries = enumerateModels();
  const main = entries.find((e) => e.pickerId.startsWith("Main"));

  configuredSettings = { subagentRedirect: true, subagentModel: "Deleted::gone::" };
  assert.equal(resolveSubagentEntry(main, DELEGATED, entries), main);
});

test("picker ids are printable so they can be written into chat.utilityModel", () => {
  configuredProviders = [{
    name: "REAL GPT",
    baseUrl: "https://a.example",
    apiType: "chat-completions",
    models: [{ id: "gpt-5.6-sol", efforts: ["xhigh"] }],
  }];
  const [entry] = enumerateModels();
  assert.equal(entry.pickerId, "REAL GPT::gpt-5.6-sol::xhigh");
  assert.doesNotMatch(entry.pickerId, /[\x00-\x1f]/);
  assert.equal(entry.utilityRef, "poly-bridge/REAL GPT::gpt-5.6-sol::xhigh");
});

test("qualified name matches VS Code's `${name} (${vendor})` lookup format", () => {
  // matchesQualifiedName() in VS Code core compares this string exactly, so the
  // display name and the vendor suffix must be joined with a single space.
  configuredProviders = [{
    name: "REAL GPT",
    baseUrl: "https://a.example",
    models: [{ id: "gpt-5.6-sol", efforts: ["xhigh"] }],
  }];
  const [entry] = enumerateModels();
  assert.equal(entry.qualifiedName, entry.info.name + " (poly-bridge)");
  assert.equal(entry.qualifiedName, "gpt-5.6-sol (xhigh) (poly-bridge)");
});

test("adding a second provider appends the provider suffix to every name", () => {
  // Display names are disambiguated only when more than one provider exists,
  // so qualified names are NOT stable across that transition — generated
  // .agent.md / instructions must be rewritten when providers are added or
  // removed, since VS Code matches them by exact string equality.
  configuredProviders = [
    {
      name: "REAL GPT",
      baseUrl: "https://a.example",
      models: [{ id: "gpt-5.6-sol", efforts: ["xhigh"] }],
    },
    { name: "Other", baseUrl: "https://b.example", models: [{ id: "m" }] },
  ];
  const [entry] = enumerateModels();
  assert.equal(entry.qualifiedName, "gpt-5.6-sol (xhigh) · REAL GPT (poly-bridge)");
  // the picker id, and therefore chat.utilityModel, is unaffected
  assert.equal(entry.pickerId, "REAL GPT::gpt-5.6-sol::xhigh");
});

test("the effort segment is always present, keeping ids unambiguous", () => {
  // Trailing SEP is deliberate: without it, provider "A" + model "B::x" would
  // collide with provider "A" + model "B" + effort "x".
  configuredProviders = [{
    name: "A",
    baseUrl: "https://a.example",
    models: [{ id: "B" }],
  }];
  const [entry] = enumerateModels();
  assert.equal(entry.pickerId, "A" + SEP + "B" + SEP);
});

test("each effort variant gets its own addressable entry", () => {
  configuredProviders = [{
    name: "Relay",
    baseUrl: "https://a.example",
    models: [{ id: "m", efforts: ["low", "high"] }],
  }];
  const ids = enumerateModels().map((entry) => entry.pickerId);
  assert.deepEqual(ids, ["Relay::m::low", "Relay::m::high"]);
});
