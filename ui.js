"use strict";
/**
 * QuickPick-based management UI — add/edit providers and models without
 * touching settings.json (which remains available as the advanced path).
 */
const vscode = require("vscode");

const EFFORT_CHOICES = [
  { label: "minimal", description: "OpenAI 系最省档" },
  { label: "low", description: "快、省 token" },
  { label: "medium", description: "均衡" },
  { label: "high", description: "Claude 默认档，日常编码推荐" },
  { label: "xhigh", description: "Opus 4.7+/Sonnet 5/GPT 部分型号支持" },
  { label: "max", description: "Claude 系最高档" },
];

const API_TYPES = [
  { label: "anthropic", description: "Anthropic Messages 协议（/v1/messages）" },
  { label: "chat-completions", description: "OpenAI Chat Completions（/v1/chat/completions）" },
  { label: "responses", description: "OpenAI Responses（/v1/responses）" },
];

function cfg() {
  return vscode.workspace.getConfiguration("polyBridge");
}

function readProviders() {
  return JSON.parse(JSON.stringify(cfg().get("providers") || []));
}

async function writeProviders(providers) {
  await cfg().update("providers", providers, vscode.ConfigurationTarget.Global);
}

function modelsEndpoint(baseUrl) {
  let base = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!/\/v1$/.test(base)) {
    base += "/v1";
  }
  return base + "/models";
}

/** GET /v1/models and return an array of model id strings ([] on failure). */
async function fetchModelIds(provider, apiKey) {
  const headers = {};
  if (apiKey) {
    const apiType = provider.apiType || "anthropic";
    const auth = provider.authHeader || (apiType === "anthropic" ? "x-api-key" : "authorization");
    if (auth === "x-api-key") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["authorization"] = "Bearer " + apiKey;
    }
  }
  try {
    const res = await fetch(modelsEndpoint(provider.baseUrl), { headers });
    if (!res.ok) {
      return [];
    }
    const json = await res.json();
    const list = Array.isArray(json) ? json : json.data || json.models || [];
    return list
      .map((m) => (typeof m === "string" ? m : m && m.id))
      .filter((id) => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

async function inputBaseUrl(initial) {
  return vscode.window.showInputBox({
    title: "中转站 Base URL",
    prompt: "例如 https://api.example.com（协议路径 /v1/messages 等会自动拼接）",
    value: initial || "",
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^https?:\/\/\S+$/.test(v.trim()) ? undefined : "请输入 http(s):// 开头的地址",
  });
}

async function pickApiType(title, current) {
  const pick = await vscode.window.showQuickPick(
    API_TYPES.map((t) => ({
      ...t,
      description: t.description + (t.label === current ? "（当前）" : ""),
    })),
    { title, ignoreFocusOut: true }
  );
  return pick && pick.label;
}

/** Multi-select models fetched from the endpoint, with manual fallback. */
async function pickNewModels(provider, chatProvider) {
  const apiKey = await chatProvider.getApiKey(provider.name);
  const fetched = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在从中转站拉取模型列表…" },
    () => fetchModelIds(provider, apiKey)
  );
  const existing = new Set(provider.models.map((m) => m.id));
  const candidates = fetched.filter((id) => !existing.has(id));

  if (candidates.length > 0) {
    const picks = await vscode.window.showQuickPick(
      candidates.map((id) => ({ label: id })),
      {
        title: `选择要添加的模型（${provider.name}）`,
        canPickMany: true,
        ignoreFocusOut: true,
        placeHolder: "空格勾选，回车确认",
      }
    );
    return picks ? picks.map((p) => p.label) : undefined;
  }

  // endpoint doesn't expose /v1/models (or nothing new) — manual input
  const manual = await vscode.window.showInputBox({
    title: `手动输入模型 ID（${provider.name}）`,
    prompt: "中转站未提供模型列表接口。输入模型 ID，多个用逗号分隔",
    ignoreFocusOut: true,
  });
  if (!manual) {
    return undefined;
  }
  return manual
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s && !existing.has(s));
}

async function addProviderWizard(chatProvider) {
  const providers = readProviders();

  const name = await vscode.window.showInputBox({
    title: "添加中转站 1/4：名称",
    prompt: "给这个中转站起个名字（用于分组显示和 Key 存储）",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) {
        return "名称不能为空";
      }
      if (providers.some((p) => p.name === t)) {
        return "已存在同名中转站";
      }
      return undefined;
    },
  });
  if (!name) {
    return;
  }

  const baseUrl = await inputBaseUrl();
  if (!baseUrl) {
    return;
  }

  const apiType = await pickApiType("添加中转站 3/4：默认协议");
  if (!apiType) {
    return;
  }

  const provider = { name: name.trim(), baseUrl: baseUrl.trim(), apiType, models: [] };

  const key = await chatProvider.promptForApiKey(provider.name);
  if (key === undefined) {
    // allowed: key-less endpoints or set later
  }

  const ids = await pickNewModels(provider, chatProvider);
  if (ids && ids.length > 0) {
    provider.models = ids.map((id) => ({ id }));
  }

  providers.push(provider);
  await writeProviders(providers);
  vscode.window.showInformationMessage(
    `已添加中转站 "${provider.name}"（${provider.models.length} 个模型）。` +
      (provider.models.length ? "去模型选择器 Manage Models 里勾选即可使用。" : "")
  );
}

async function editModelMenu(providers, provider, chatProvider) {
  const mPick = await vscode.window.showQuickPick(
    provider.models.map((m) => ({
      label: m.name || m.id,
      description:
        (m.apiType ? m.apiType + " · " : "") +
        (m.efforts ? "efforts: " + m.efforts.join("/") : "") +
        (m.thinking ? " · thinking" : ""),
      id: m.id,
    })),
    { title: `选择要编辑的模型（${provider.name}）`, ignoreFocusOut: true }
  );
  if (!mPick) {
    return;
  }
  const model = provider.models.find((m) => m.id === mPick.id);

  const action = await vscode.window.showQuickPick(
    [
      { label: "$(symbol-string) 显示名", action: "name", description: model.name || "（未设置，显示模型 ID）" },
      { label: "$(dashboard) Effort 档位", action: "efforts", description: (model.efforts || []).join("/") || "（未配置）" },
      { label: "$(sparkle) 深度思考 thinking", action: "thinking", description: model.thinking ? "已开启" : "已关闭" },
      {
        label: "$(symbol-numeric) 上下文窗口 / 输出上限",
        action: "tokens",
        description:
          "输入 " + (model.maxInputTokens || 200000) + " · 输出 " + (model.maxOutputTokens || 16000),
      },
      { label: "$(arrow-swap) 协议覆盖", action: "apiType", description: model.apiType || "（跟随中转站默认）" },
    ],
    { title: `编辑 ${model.name || model.id}`, ignoreFocusOut: true }
  );
  if (!action) {
    return;
  }

  if (action.action === "name") {
    const v = await vscode.window.showInputBox({
      title: "显示名（留空恢复为模型 ID）",
      value: model.name || "",
      ignoreFocusOut: true,
    });
    if (v === undefined) {
      return;
    }
    if (v.trim()) {
      model.name = v.trim();
    } else {
      delete model.name;
    }
  } else if (action.action === "efforts") {
    const picks = await vscode.window.showQuickPick(
      EFFORT_CHOICES.map((e) => ({
        ...e,
        picked: (model.efforts || []).includes(e.label),
      })),
      {
        title: "勾选 effort 档位（每档一个选择器条目；全不选 = 不发送 effort）",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    if (!picks) {
      return;
    }
    if (picks.length > 0) {
      model.efforts = picks.map((p) => p.label);
    } else {
      delete model.efforts;
    }
  } else if (action.action === "thinking") {
    model.thinking = !model.thinking;
    if (!model.thinking) {
      delete model.thinking;
    }
  } else if (action.action === "tokens") {
    const parsePositiveInt = (v) => {
      const n = parseInt(v.trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const inTok = await vscode.window.showInputBox({
      title: "上下文窗口（maxInputTokens）",
      prompt: "该模型实际支持的最大输入 token 数，按厂商文档填写；Copilot 用它决定塞多少历史/文件进请求",
      value: String(model.maxInputTokens || 200000),
      ignoreFocusOut: true,
      validateInput: (v) => (parsePositiveInt(v) ? undefined : "请输入正整数"),
    });
    if (inTok === undefined) {
      return;
    }
    const outTok = await vscode.window.showInputBox({
      title: "单次输出上限（maxOutputTokens）",
      prompt: "作为 max_tokens 一类字段发给中转站，直接限制单次回复长度",
      value: String(model.maxOutputTokens || 16000),
      ignoreFocusOut: true,
      validateInput: (v) => (parsePositiveInt(v) ? undefined : "请输入正整数"),
    });
    if (outTok === undefined) {
      return;
    }
    model.maxInputTokens = parsePositiveInt(inTok);
    model.maxOutputTokens = parsePositiveInt(outTok);
  } else if (action.action === "apiType") {
    const t = await pickApiType("此模型单独使用的协议", model.apiType);
    if (!t) {
      return;
    }
    if (t === (provider.apiType || "anthropic")) {
      delete model.apiType;
    } else {
      model.apiType = t;
    }
  }

  await writeProviders(providers);
  vscode.window.showInformationMessage(`已更新 ${model.name || model.id}。`);
}

async function providerMenu(providerName, chatProvider) {
  const providers = readProviders();
  const provider = providers.find((p) => p.name === providerName);
  if (!provider) {
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      { label: "$(key) 设置 / 更新 API Key", action: "key" },
      { label: "$(add) 添加模型（自动拉取列表）", action: "addModels" },
      { label: "$(edit) 编辑模型（effort / thinking / 协议）", action: "editModel" },
      { label: "$(trash) 移除模型", action: "removeModels" },
      { label: "$(globe) 修改 Base URL", action: "baseUrl", description: provider.baseUrl },
      { label: "$(arrow-swap) 修改默认协议", action: "apiType", description: provider.apiType || "anthropic" },
      { label: "$(beaker) 测试连接", action: "test" },
      { label: "$(x) 删除此中转站", action: "delete" },
    ],
    { title: `管理中转站：${provider.name}`, ignoreFocusOut: true }
  );
  if (!pick) {
    return;
  }

  switch (pick.action) {
    case "key": {
      await chatProvider.promptForApiKey(provider.name);
      break;
    }
    case "addModels": {
      const ids = await pickNewModels(provider, chatProvider);
      if (ids && ids.length > 0) {
        provider.models.push(...ids.map((id) => ({ id })));
        await writeProviders(providers);
        vscode.window.showInformationMessage(
          `已添加 ${ids.length} 个模型到 "${provider.name}"，去 Manage Models 勾选即可使用。`
        );
      }
      break;
    }
    case "editModel": {
      await editModelMenu(providers, provider, chatProvider);
      break;
    }
    case "removeModels": {
      const picks = await vscode.window.showQuickPick(
        provider.models.map((m) => ({ label: m.name || m.id, id: m.id })),
        { title: "勾选要移除的模型", canPickMany: true, ignoreFocusOut: true }
      );
      if (picks && picks.length > 0) {
        const remove = new Set(picks.map((p) => p.id));
        provider.models = provider.models.filter((m) => !remove.has(m.id));
        await writeProviders(providers);
        vscode.window.showInformationMessage(`已移除 ${picks.length} 个模型。`);
      }
      break;
    }
    case "baseUrl": {
      const v = await inputBaseUrl(provider.baseUrl);
      if (v) {
        provider.baseUrl = v.trim();
        await writeProviders(providers);
      }
      break;
    }
    case "apiType": {
      const t = await pickApiType("默认协议", provider.apiType);
      if (t) {
        provider.apiType = t;
        await writeProviders(providers);
      }
      break;
    }
    case "test": {
      const apiKey = await chatProvider.getApiKey(provider.name);
      const ids = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "正在测试连接…" },
        () => fetchModelIds(provider, apiKey)
      );
      if (ids.length > 0) {
        vscode.window.showInformationMessage(
          `连接正常：${provider.name} 返回了 ${ids.length} 个模型。`
        );
      } else {
        vscode.window.showWarningMessage(
          `未能从 ${modelsEndpoint(provider.baseUrl)} 拉到模型列表——` +
            "可能是 Key 未设置/无效，或该中转站不提供 /v1/models 接口（不影响聊天请求）。"
        );
      }
      break;
    }
    case "delete": {
      const confirm = await vscode.window.showWarningMessage(
        `删除中转站 "${provider.name}"（${provider.models.length} 个模型）？其 API Key 也会一并清除。`,
        { modal: true },
        "删除"
      );
      if (confirm === "删除") {
        await writeProviders(providers.filter((p) => p.name !== provider.name));
        await chatProvider.deleteApiKey(provider.name);
        vscode.window.showInformationMessage(`已删除 "${provider.name}"。`);
      }
      break;
    }
  }
}

/** Top-level management hub. */
async function manageHub(chatProvider) {
  const providers = readProviders();
  const items = providers.map((p) => ({
    label: "$(server) " + p.name,
    description: (p.apiType || "anthropic") + " · " + p.baseUrl,
    detail: p.models.length + " 个模型",
    provider: p.name,
  }));
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(add) 添加中转站…", action: "add" },
    { label: "$(json) 编辑原始配置 (settings.json)", action: "json" }
  );

  if (providers.length === 0) {
    // nothing to manage yet — jump straight into the add wizard
    await addProviderWizard(chatProvider);
    return;
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: "Poly Model Bridge：中转站管理",
    placeHolder: "选择一个中转站进行管理，或添加新的",
    ignoreFocusOut: true,
  });
  if (!pick) {
    return;
  }
  if (pick.action === "add") {
    await addProviderWizard(chatProvider);
  } else if (pick.action === "json") {
    await vscode.commands.executeCommand("workbench.action.openSettingsJson");
  } else if (pick.provider) {
    await providerMenu(pick.provider, chatProvider);
  }
}

function fmtTokens(n) {
  if (n >= 1000000) {
    return n / 1000000 + "M";
  }
  return Math.round(n / 1000) + "K";
}

const CONTEXT_PRESETS = [32000, 64000, 128000, 200000, 400000, 1000000];

/**
 * Status-bar quick panel: pick a model, then its reasoning effort and
 * context window — the Claude Code style dial, applied instantly.
 */
async function quickSettings(chatProvider) {
  const providers = readProviders();
  const all = [];
  for (const p of providers) {
    for (const m of p.models) {
      all.push({ p, m });
    }
  }
  if (all.length === 0) {
    await addProviderWizard(chatProvider);
    return;
  }

  const last = chatProvider.lastUsed;
  const isLast = ({ p, m }) =>
    last && last.providerName === p.name && last.modelId === m.id;
  all.sort((a, b) => (isLast(b) ? 1 : 0) - (isLast(a) ? 1 : 0));

  const mPick = await vscode.window.showQuickPick(
    all.map(({ p, m }) => ({
      label: (isLast({ p, m }) ? "$(history) " : "") + (m.name || m.id),
      description:
        (m.effort
          ? "effort: " + m.effort
          : m.efforts
            ? "efforts: " + m.efforts.join("/")
            : "effort: 默认(high)") +
        " · ctx " + fmtTokens(m.maxInputTokens || 200000) +
        " · " + p.name,
      key: p.name + "\u001F" + m.id,
    })),
    { title: "快速设置：选择要调整的模型", placeHolder: "最近使用的模型排在最前" }
  );
  if (!mPick) {
    return;
  }
  const [pName, mId] = mPick.key.split("\u001F");
  const provider = providers.find((p) => p.name === pName);
  const model = provider.models.find((m) => m.id === mId);

  // step 2: effort
  const effortItems = [
    {
      label: "(不发送 effort)",
      description: "由服务端用默认档" + (model.efforts ? "；将同时移除多档条目配置" : ""),
      value: "",
    },
    ...EFFORT_CHOICES.map((e) => ({
      label: e.label,
      description: e.description + (model.effort === e.label ? "（当前）" : ""),
      value: e.label,
    })),
    { label: "$(chevron-right) 保持不变", value: undefined },
  ];
  const ePick = await vscode.window.showQuickPick(effortItems, {
    title: `思考工作量（${model.name || model.id}）`,
  });
  if (!ePick) {
    return;
  }
  if (ePick.value !== undefined) {
    delete model.efforts; // quick panel uses the single-dial mode
    if (ePick.value) {
      model.effort = ePick.value;
    } else {
      delete model.effort;
    }
  }

  // step 3: context window
  const current = model.maxInputTokens || 200000;
  const ctxItems = [
    ...CONTEXT_PRESETS.map((n) => ({
      label: fmtTokens(n),
      description: n + " tokens" + (n === current ? "（当前）" : ""),
      value: n,
    })),
    { label: "$(edit) 自定义…", value: "custom" },
    { label: "$(chevron-right) 保持不变", value: undefined },
  ];
  const cPick = await vscode.window.showQuickPick(ctxItems, {
    title: `上下文窗口（${model.name || model.id}）`,
    placeHolder: "决定 Copilot 向该模型发送多少历史/文件内容，请不要超过模型实际支持的窗口",
  });
  if (!cPick) {
    return;
  }
  if (cPick.value === "custom") {
    const v = await vscode.window.showInputBox({
      title: "自定义上下文窗口（tokens）",
      value: String(current),
      validateInput: (s) =>
        Number.isFinite(parseInt(s, 10)) && parseInt(s, 10) > 0 ? undefined : "请输入正整数",
    });
    if (v === undefined) {
      return;
    }
    model.maxInputTokens = parseInt(v, 10);
  } else if (cPick.value !== undefined) {
    model.maxInputTokens = cPick.value;
  }

  await writeProviders(providers);
  vscode.window.setStatusBarMessage(
    `${model.name || model.id}: effort ${model.effort || "默认"} · ctx ${fmtTokens(model.maxInputTokens || 200000)}`,
    4000
  );
}

module.exports = { manageHub, addProviderWizard, quickSettings, fmtTokens };
