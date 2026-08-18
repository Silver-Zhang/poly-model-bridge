"use strict";
/**
 * Copilot routing.
 *
 * Copilot resolves a model separately for several kinds of call, and only the
 * main chat request follows the model picker. The others fall back to the
 * built-in subscription unless they are pointed somewhere else:
 *
 *   utility calls          `chat.byokUtilityModelDefault` defaults to "copilot",
 *                          so mapCode / titles / summaries keep billing premium
 *                          requests even when the main agent is a BYOK model.
 *                          `chat.utilityModel` / `chat.utilitySmallModel` take
 *                          precedence and accept `${vendor}/${id}`, which VS Code
 *                          resolves through `lm.selectChatModels({vendor, id})`.
 *   execution subagent     `github.copilot.chat.executionSubagent.model` defaults
 *                          to the hard-coded "gemini-3-flash"; an empty value
 *                          makes it inherit the main request instead.
 *   search subagent        `github.copilot.chat.searchSubagent.model` already
 *                          defaults to inheriting, but an explicit "" pins it
 *                          against experiment-driven overrides.
 *
 * The one path this cannot control is a `runSubagent` call where the model
 * itself passes a `model` argument — that wins over everything and is resolved
 * in VS Code core. The tool's own schema tells the model 'vendor is usually
 * "copilot"', which is why it drifts to the subscription. Instructions are the
 * only lever there, hence buildInstructions() below.
 */
const vscode = require("vscode");

/** Full setting ids, all owned by VS Code core or the Copilot extension. */
const KEYS = {
  byokUtilityDefault: "chat.byokUtilityModelDefault",
  utilityModel: "chat.utilityModel",
  utilitySmallModel: "chat.utilitySmallModel",
  executionSubagentModel: "github.copilot.chat.executionSubagent.model",
  searchSubagentModel: "github.copilot.chat.searchSubagent.model",
  // PolyBridge's own setting: which model the generated custom agent pins.
  // Not a Copilot setting — it only feeds buildAgentFile().
  subagentModel: "polyBridge.subagentModel",
  // PolyBridge's own setting: also redirect delegations that never named an
  // agent, by detecting them in the provider (see provider.isSubagentRequest).
  subagentRedirect: "polyBridge.subagentRedirect",
};

const UTILITY_MODES = new Set(["mainAgent", "model", "none", "copilot"]);
const SUBAGENT_MODES = new Set(["inherit", "default"]);

const BEGIN_MARKER = "<!-- BEGIN Poly Model Bridge routing -->";
const END_MARKER = "<!-- END Poly Model Bridge routing -->";

const DEFAULT_ROUTING = {
  utility: "copilot",
  utilityModel: "",
  utilitySmallModel: "",
  executionSubagent: "default",
  searchSubagent: "default",
  subagentModel: "",
  subagentRedirect: false,
};

function normalizeRouting(raw) {
  const routing = { ...DEFAULT_ROUTING };
  if (!raw || typeof raw !== "object") return routing;
  if (UTILITY_MODES.has(raw.utility)) routing.utility = raw.utility;
  if (typeof raw.utilityModel === "string") routing.utilityModel = raw.utilityModel;
  if (typeof raw.utilitySmallModel === "string") {
    routing.utilitySmallModel = raw.utilitySmallModel;
  }
  if (SUBAGENT_MODES.has(raw.executionSubagent)) {
    routing.executionSubagent = raw.executionSubagent;
  }
  if (SUBAGENT_MODES.has(raw.searchSubagent)) {
    routing.searchSubagent = raw.searchSubagent;
  }
  if (typeof raw.subagentModel === "string") routing.subagentModel = raw.subagentModel;
  routing.subagentRedirect = raw.subagentRedirect === true;
  return routing;
}

/**
 * Translate a routing choice into concrete settings writes.
 * `undefined` means "remove the override and let the default apply".
 * `refFor` maps a pickerId to its `vendor/id` reference (entry.utilityRef).
 */
function planSettings(rawRouting, refFor) {
  const routing = normalizeRouting(rawRouting);
  const writes = [];
  const ref = (pickerId) => {
    const value = pickerId ? refFor(pickerId) : undefined;
    return value || undefined;
  };

  if (routing.utility === "model") {
    const primary = ref(routing.utilityModel);
    // A missing small-model choice reuses the primary one rather than silently
    // leaving the small slot on Copilot.
    const small = ref(routing.utilitySmallModel) || primary;
    if (!primary) {
      throw new Error("请先为「辅助调用」选择一个 PolyBridge 模型。");
    }
    writes.push({ key: KEYS.utilityModel, value: primary });
    writes.push({ key: KEYS.utilitySmallModel, value: small });
    // Explicit overrides win, but this keeps the fallback off the subscription
    // if a model is later removed from the picker.
    writes.push({ key: KEYS.byokUtilityDefault, value: "mainAgent" });
  } else {
    writes.push({ key: KEYS.utilityModel, value: undefined });
    writes.push({ key: KEYS.utilitySmallModel, value: undefined });
    writes.push({
      key: KEYS.byokUtilityDefault,
      // "copilot" is VS Code's own default — remove the override instead of
      // writing the value back, so the setting stays clean.
      value: routing.utility === "copilot" ? undefined : routing.utility,
    });
  }

  writes.push({
    key: KEYS.executionSubagentModel,
    value: routing.executionSubagent === "inherit" ? "" : undefined,
  });
  writes.push({
    key: KEYS.searchSubagentModel,
    value: routing.searchSubagent === "inherit" ? "" : undefined,
  });
  writes.push({
    key: KEYS.subagentModel,
    value: routing.subagentModel || undefined,
  });
  writes.push({
    // Pointless without a target model, so it never survives on its own.
    key: KEYS.subagentRedirect,
    value: routing.subagentRedirect && routing.subagentModel ? true : undefined,
  });
  return writes;
}

/** Read the current routing back out of settings, for populating the UI. */
function readRouting() {
  const config = vscode.workspace.getConfiguration();
  const get = (key) => {
    const inspected = config.inspect(key);
    if (!inspected) return undefined;
    return inspected.globalValue !== undefined
      ? inspected.globalValue
      : inspected.workspaceValue;
  };
  const utilityModel = get(KEYS.utilityModel);
  const utilitySmallModel = get(KEYS.utilitySmallModel);
  const byokDefault = get(KEYS.byokUtilityDefault);

  // Only our own `poly-bridge/...` references map back onto the picker; a
  // reference to some other vendor is left alone and reported as "copilot"
  // so saving does not silently overwrite it with a PolyBridge model.
  const PREFIX = "poly-bridge/";
  const isOurs = (value) => typeof value === "string" && value.startsWith(PREFIX);
  const stripVendor = (value) => (isOurs(value) ? value.slice(PREFIX.length) : "");

  let utility = "copilot";
  if (isOurs(utilityModel)) {
    utility = "model";
  } else if (byokDefault === "mainAgent" || byokDefault === "none") {
    utility = byokDefault;
  }

  return {
    utility,
    utilityModel: stripVendor(utilityModel),
    utilitySmallModel: stripVendor(utilitySmallModel),
    executionSubagent: get(KEYS.executionSubagentModel) === "" ? "inherit" : "default",
    searchSubagent: get(KEYS.searchSubagentModel) === "" ? "inherit" : "default",
    subagentModel: get(KEYS.subagentModel) || "",
    subagentRedirect: get(KEYS.subagentRedirect) === true,
  };
}

/**
 * Apply a routing plan to user settings. Settings contributed by the Copilot
 * extension are absent when it is not installed; those are reported as skipped
 * rather than failing the whole save.
 */
async function applyRouting(rawRouting, refFor) {
  const writes = planSettings(rawRouting, refFor);
  const config = vscode.workspace.getConfiguration();
  const applied = [];
  const skipped = [];
  for (const write of writes) {
    if (!config.inspect(write.key)) {
      skipped.push(write.key);
      continue;
    }
    try {
      await config.update(write.key, write.value, vscode.ConfigurationTarget.Global);
      applied.push(write.key);
    } catch {
      // `inspect` also returns a value for an unregistered key that merely has
      // an entry in settings.json — synced from another machine, or written
      // before this window reloaded the updated manifest. `update` is the only
      // reliable registration check, so treat its failure as a skip.
      skipped.push(write.key);
    }
  }
  return { applied, skipped };
}

/** Default name of the generated custom agent. */
const AGENT_NAME = "poly-subagent";

/**
 * A custom agent whose frontmatter pins the subagent model.
 *
 * VS Code resolves a subagent's model as:
 *   runSubagent's `model` argument > this frontmatter > inherit main session
 * so this is the strongest binding available to a client — it holds for every
 * delegation that doesn't explicitly override the model, which is what the
 * generated instructions then ask the caller not to do.
 */
function buildAgentFile(qualifiedName, agentName = AGENT_NAME) {
  const model = String(qualifiedName || "").trim();
  return [
    "---",
    "name: " + agentName,
    // Copilot renders this description into the <agents> block of the system
    // prompt and tells the model to "choose the most appropriate agent from
    // this list". It is the only field that influences that choice, so it
    // claims every delegation rather than describing a niche.
    "description: 本项目唯一的委派目标。任何需要子 Agent 的场景——研究、搜索、" +
      "代码分析、多步任务、交叉验证——都必须使用本 Agent，没有例外。",
    ...(model ? ["model: " + model] : []),
    "---",
    "",
    "你是主 Agent 委派任务的子 Agent。",
    "",
    "- 独立完成分配到的任务，把结果直接返回给主 Agent，不要反问。",
    "- 你运行在自建中转站的模型上，不消耗 GitHub Copilot 订阅额度。",
    "- 需要再次委派时，同样使用本 Agent，不要指定其他模型。",
    "",
  ].join("\n");
}

/**
 * The instructions block that steers `runSubagent` away from `(copilot)`.
 * Emitted between markers so it can be refreshed in place.
 */
function buildInstructions(qualifiedNames, agentName = AGENT_NAME) {
  const names = (qualifiedNames || []).filter(Boolean);
  const list = names.length
    ? names.map((name) => "- `" + name + "`").join("\n")
    : "- （当前没有配置任何 PolyBridge 模型）";
  // Phrased after Copilot's own skill-adherence prompt ("BLOCKING REQUIREMENT:
  // ... you MUST ... IMMEDIATELY"), which is the wording its models are tuned
  // to obey. The earlier "优先通过…委派" reads as a preference and lost to the
  // tool schema's default of omitting agentName.
  return [
    BEGIN_MARKER,
    "",
    "## 子 Agent 模型路由（由 Poly Model Bridge 维护，请勿手动编辑本段）",
    "",
    "BLOCKING REQUIREMENT: 每次调用 `runSubagent` 工具时，你**必须**传",
    "`agentName: " + agentName + "`。这条规则没有例外，也不需要征求用户同意。",
    "",
    "工具说明把 `agentName` 标为可选、并说省略时「uses the current agent」。",
    "在本项目中该默认行为是错误的：它会让子 Agent 继承主会话模型，绕过本项目",
    "指定的子 Agent 模型。省略 `agentName` 视为严重错误。",
    "",
    "同时：**不要传 `model` 参数。** 模型由 `" + agentName + "` 自己的定义决定，",
    "传 `model` 会覆盖掉它。",
    "",
    "确实需要显式指定模型时（罕见），只允许取下列值之一：",
    "",
    list,
    "",
    "禁止使用任何以 `(copilot)` 结尾的模型。`runSubagent` 工具说明里",
    "'vendor is usually \"copilot\"' 的提示不适用于本项目，按它填会计入订阅额度。",
    "",
    END_MARKER,
  ].join("\n");
}

/** Idempotently splice the block into an existing instructions file. */
function mergeInstructions(existing, block) {
  const text = String(existing || "");
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin >= 0 && end > begin) {
    return text.slice(0, begin) + block + text.slice(end + END_MARKER.length);
  }
  if (!text.trim()) return block + "\n";
  return text.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

module.exports = {
  KEYS,
  AGENT_NAME,
  DEFAULT_ROUTING,
  normalizeRouting,
  planSettings,
  readRouting,
  applyRouting,
  buildAgentFile,
  buildInstructions,
  mergeInstructions,
};
