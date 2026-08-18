"use strict";

const vscode = acquireVsCodeApi();

const API_TYPES = [
  { value: "anthropic", label: "Anthropic（Claude 中转站最常见）" },
  { value: "chat-completions", label: "OpenAI 对话格式（/v1/chat/completions）" },
  { value: "responses", label: "OpenAI Responses 格式（/v1/responses）" },
];

const CACHE_TTLS = [
  { value: "off", label: "关闭（默认，遇到报错再改）" },
  { value: "5m", label: "5 分钟" },
  { value: "1h", label: "1 小时" },
];

const USAGE_MODES = [
  { value: "auto", label: "自动（推荐）" },
  { value: "on", label: "始终请求" },
  { value: "off", label: "关闭" },
];

const TOKEN_ESTIMATORS = [
  { value: "conservative", label: "保守（推荐）" },
  { value: "balanced", label: "平衡" },
];

const EFFORTS = [
  { value: "minimal", label: "minimal（最省）" },
  { value: "low", label: "low（低）" },
  { value: "medium", label: "medium（中）" },
  { value: "high", label: "high（高）" },
  { value: "xhigh", label: "xhigh（超高）" },
  { value: "max", label: "max（最高）" },
];

const CONTEXT_WINDOWS = [
  { value: "32000", label: "32K" },
  { value: "64000", label: "64K" },
  { value: "128000", label: "128K" },
  { value: "200000", label: "200K" },
  { value: "400000", label: "400K" },
  { value: "1000000", label: "1M" },
];

let providers = [];
let keyStates = {};
let dirty = false;
let routing = null;
let routableModels = [];
/**
 * Collapsed by default: both panels are opt-in tuning, and the provider list is
 * what people come here for. Module-level so a re-render keeps them as they are.
 */
let panelOpen = { routing: false, cli: false };
/** Copilot CLI card state. The snippet is rendered by the extension host. */
let cli = {
  enabled: false,
  pickerId: "",
  shell: "pwsh",
  snippet: "",
  warnings: [],
  siblings: [],
};

function esc(value) {
  return String(value === undefined || value === null ? "" : value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
  );
}

function shortLabel(list, value) {
  const found = list.find((item) => item.value === value);
  return (found ? found.label : value).replace(/（.*）$/, "");
}

function selectHtml(key, list, current, inheritLabel) {
  const inherit = inheritLabel
    ? `<option value="" ${current ? "" : "selected"}>${esc(inheritLabel)}</option>`
    : "";
  const items = list.map((item) =>
    `<option value="${item.value}" ${item.value === current ? "selected" : ""}>${esc(item.label)}</option>`
  ).join("");
  return `<select data-k="${key}">${inherit}${items}</select>`;
}

function contextWindowHtml(current) {
  const value = String(current || 200000);
  const known = CONTEXT_WINDOWS.some((item) => item.value === value);
  return `<div class="context-choice">
    <select data-context-preset>
      ${CONTEXT_WINDOWS.map((item) =>
        `<option value="${item.value}" ${item.value === value ? "selected" : ""}>${item.label}（${Number(item.value).toLocaleString()} tokens）</option>`
      ).join("")}
      <option value="custom" ${known ? "" : "selected"}>其他长度…</option>
    </select>
    <input type="number" min="1" data-context-custom value="${known ? "" : esc(value)}" placeholder="选择“其他长度”后填写">
  </div>`;
}

function defaultModel(id) {
  return {
    id: id || "",
    name: "",
    efforts: [],
    thinking: false,
    maxInputTokens: 200000,
    maxOutputTokens: 16000,
    usageMode: "auto",
    tokenEstimator: "conservative",
    toolCalling: true,
    vision: true,
    _open: !id,
  };
}

function defaultProvider() {
  return {
    name: "我的中转站",
    _originalName: "",
    baseUrl: "",
    apiType: "anthropic",
    anthropicCacheTtl: "off",
    usageMode: "auto",
    requiresApiKey: true,
    models: [],
    _open: true,
  };
}

function modelHtml(model, providerIndex, modelIndex) {
  const efforts = Array.isArray(model.efforts) ? model.efforts : [];
  const knownEfforts = new Set(EFFORTS.map((item) => item.value));
  const customEfforts = efforts.filter((effort) => !knownEfforts.has(effort));
  const summary = [];
  if (efforts.length) summary.push("推理 " + efforts.join(" / "));
  if (model.thinking) summary.push("思考模式");
  summary.push("上下文 " + (Number(model.maxInputTokens || 200000) / 1000) + "K");

  const effortBoxes = EFFORTS.map((item) =>
    `<label class="check"><input type="checkbox" data-effort="${item.value}" ${efforts.includes(item.value) ? "checked" : ""}><span>${item.label}</span></label>`
  ).join("");
  const customFixedEffort = model.effort && !knownEfforts.has(model.effort)
    ? `<option value="${esc(model.effort)}" selected>${esc(model.effort)}（当前自定义值）</option>`
    : "";

  return `<div class="model ${model._open ? "open" : ""}" data-model="${modelIndex}">
  <div class="model-head" data-toggle-model="${modelIndex}">
    <span class="twisty">›</span>
    <span class="title">${esc(model.name || model.id || "未命名模型")}</span>
    <span class="muted">${esc(summary.join(" · "))}</span>
    <button class="danger remove-model" data-p="${providerIndex}" data-m="${modelIndex}">删除</button>
  </div>
  <div class="model-body">
    <div class="grid">
      <div class="field">
        <label>模型编号</label>
        <input data-k="id" value="${esc(model.id)}" placeholder="例如 claude-sonnet-4-5">
        <span class="hint">中转站文档里写的模型名称，会原样发送给服务器。</span>
      </div>
      <div class="field">
        <label>显示名称</label>
        <input data-k="name" value="${esc(model.name || "")}" placeholder="留空则显示模型编号">
        <span class="hint">只影响 Copilot 模型列表里看到的名字。</span>
      </div>
      <div class="field">
        <label>接口格式</label>
        ${selectHtml("apiType", API_TYPES, model.apiType || "", "和上面中转站保持一致")}
        <span class="hint">这个模型如果用的格式和中转站不一样，才需要单独改。</span>
      </div>
      <div class="field">
        <label>缓存时长兼容</label>
        ${selectHtml("anthropicCacheTtl", CACHE_TTLS, model.anthropicCacheTtl || "", "和上面中转站保持一致")}
        <span class="hint">只对 Anthropic 格式有效，用来避开中转站的缓存时长冲突报错。</span>
      </div>
      <div class="field full">
        <label>推理强度档位</label>
        <div class="effort-grid">${effortBoxes}</div>
        <input data-custom-efforts value="${esc(customEfforts.join(", "))}" placeholder="其他档位（可选，用逗号分开）">
        <span class="hint">不同模型支持的档位不同。OpenAI 常见 minimal / low / medium / high / xhigh，Claude 或中转站还可能支持 max。只选服务器明确支持的档位；其他模型的特殊名称可填在“其他档位”中。不选则由服务器自动决定。</span>
      </div>
      <div class="field">
        <label>Token 估算</label>
        ${selectHtml("tokenEstimator", TOKEN_ESTIMATORS, model.tokenEstimator || "conservative", "")}
        <span class="hint">保守模式会为中文、JSON、代码和工具结果预留更多空间，能减少上下文超限。</span>
      </div>
      <div class="field full">
        <label>可发送的上下文长度</label>
        ${contextWindowHtml(model.maxInputTokens)}
        <span class="hint">选择模型实际支持的长度。越大可发送的历史和文件越多，但费用和等待时间也可能增加；不确定时请查中转站的模型说明。</span>
      </div>
      <div class="field check-option">
        <label><input type="checkbox" data-k="thinking" ${model.thinking ? "checked" : ""}> 开启推理 / 思考模式</label>
        <span class="hint">Anthropic 会请求自适应思考，OpenAI Responses 会请求推理摘要。这里不会展示模型的完整隐藏思维过程；OpenAI 对话格式通常主要由上面的推理强度控制。</span>
      </div>
      <div class="field check-option">
        <label><input type="checkbox" data-k="vision" ${model.vision !== false ? "checked" : ""}> 支持发送图片</label>
      </div>
      <div class="field check-option">
        <label><input type="checkbox" data-k="toolCalling" ${model.toolCalling !== false ? "checked" : ""}> 支持工具调用（Agent 模式必需）</label>
      </div>
    </div>
    <details class="advanced">
      <summary>更多设置（一般不用改）</summary>
      <div class="grid">
        <div class="field">
          <label>固定推理强度</label>
          <select data-k="effort">
            <option value="" ${!model.effort ? "selected" : ""}>由服务器自动决定（推荐）</option>
            ${customFixedEffort}
            ${EFFORTS.map((item) => `<option value="${item.value}" ${model.effort === item.value ? "selected" : ""}>${item.label}</option>`).join("")}
          </select>
          <span class="hint">只有上面的推理强度档位全都没选时，这项才会生效。</span>
        </div>
        <div class="field">
          <label>上游 Token 用量</label>
          ${selectHtml("usageMode", USAGE_MODES, model.usageMode || "", "跟随中转站设置")}
          <span class="hint">自动模式会请求 OpenAI 流式 usage；上游不返回 usage 时，Copilot 仍可能显示 0。</span>
        </div>
        <div class="field">
          <label>单个工具结果上限</label>
          <input type="number" min="512" data-k="toolResultMaxTokens" value="${esc(model.toolResultMaxTokens || "")}" placeholder="自动（按上下文计算）">
          <span class="hint">超长命令输出会保留开头和结尾，中间替换为截断提示。</span>
        </div>
        <div class="field">
          <label>单次回复长度上限</label>
          <input type="number" min="1" data-k="maxOutputTokens" value="${esc(model.maxOutputTokens || 16000)}">
          <span class="hint">一次回答最多生成多长。</span>
        </div>
        <div class="field">
          <label>长度参数的写法</label>
          <select data-k="maxTokensField">
            <option value="" ${!model.maxTokensField ? "selected" : ""}>自动（推荐）</option>
            <option value="max_tokens" ${model.maxTokensField === "max_tokens" ? "selected" : ""}>使用旧写法 max_tokens</option>
          </select>
          <span class="hint">只对 OpenAI 对话格式有效。如果服务器提示不认识 max_completion_tokens，就切到旧写法。</span>
        </div>
        <div class="field">
          <label>这个模型单独的网址</label>
          <input data-k="url" value="${esc(model.url || "")}" placeholder="留空即可">
          <span class="hint">通常留空。只有这个模型不在中转站同一个网址下，才填写完整请求地址。</span>
        </div>
      </div>
    </details>
  </div>
</div>`;
}

function providerHtml(provider, providerIndex) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  const hasKey = !!keyStates[provider.name];
  const keyBadge = provider.requiresApiKey === false
    ? '<span class="badge">无需密钥</span>'
    : hasKey
      ? '<span class="badge ok">密钥已保存</span>'
      : '<span class="badge warn">未填密钥</span>';

  return `<section class="card ${provider._open ? "open" : ""}" data-provider="${providerIndex}">
  <div class="card-head" data-toggle-provider="${providerIndex}">
    <span class="twisty">›</span>
    <h2>${esc(provider.name || "未命名中转站")}</h2>
    <span class="badge">${esc(shortLabel(API_TYPES, provider.apiType || "anthropic"))}</span>
    <span class="badge">${models.length} 个模型</span>
    ${keyBadge}
    <button class="secondary key" data-p="${providerIndex}">填写密钥</button>
    <button class="danger remove-provider" data-p="${providerIndex}">删除</button>
  </div>
  <div class="card-body">
    <div class="grid">
      <div class="field">
        <label>名称</label>
        <input data-k="name" value="${esc(provider.name)}">
        <span class="hint">随便起个好认的名字，只给你自己看。</span>
      </div>
      <div class="field">
        <label>接口地址</label>
        <input data-k="baseUrl" value="${esc(provider.baseUrl)}" placeholder="https://api.example.com">
        <span class="hint">填中转站给你的网址即可，后面的请求路径会自动补全。</span>
      </div>
      <div class="field">
        <label>接口格式</label>
        ${selectHtml("apiType", API_TYPES, provider.apiType || "anthropic", "")}
        <span class="hint">不确定就选 Anthropic，这是 Claude 类中转站最常用的格式。</span>
      </div>
      <div class="field">
        <label>缓存时长兼容</label>
        ${selectHtml("anthropicCacheTtl", CACHE_TTLS, provider.anthropicCacheTtl || "off", "")}
        <span class="hint">只对 Anthropic 格式有效。聊天时报 cache_control 冲突时，改成 1 小时通常就好了。</span>
      </div>
      <div class="field">
        <label>上游 Token 用量</label>
        ${selectHtml("usageMode", USAGE_MODES, provider.usageMode || "auto", "")}
        <span class="hint">用于让 Copilot 显示真实上下文用量；需要中转站在流式响应中返回 usage。</span>
      </div>
      <div class="field check-option">
        <label><input type="checkbox" data-k="requiresApiKey" ${provider.requiresApiKey !== false ? "checked" : ""}> 这个中转站需要密钥</label>
      </div>
      <div class="field">
        <label>密钥的发送方式</label>
        <select data-k="authHeader">
          <option value="" ${!provider.authHeader ? "selected" : ""}>自动判断（推荐）</option>
          <option value="x-api-key" ${provider.authHeader === "x-api-key" ? "selected" : ""}>x-api-key（Anthropic 常用）</option>
          <option value="authorization" ${provider.authHeader === "authorization" ? "selected" : ""}>Authorization: Bearer（OpenAI 常用）</option>
        </select>
        <span class="hint">保持自动判断即可，只有登录一直失败时才需要手动换一种。</span>
      </div>
      <div class="field full">
        <label>自定义请求头</label>
        <textarea data-k="extraHeaders" rows="2" placeholder="一般留空">${esc(Object.entries(provider.extraHeaders || {}).map(([key, value]) => key + ": " + value).join("\n"))}</textarea>
        <span class="hint">绝大多数情况留空。只有中转站文档明确要求每次请求带某字段时才填，一行一条，写成“名称: 值”。</span>
      </div>
    </div>
    <div class="section">
      <div class="section-title">
        <h3>模型列表</h3>
        <div class="actions">
          <button class="secondary fetch" data-p="${providerIndex}">向中转站查询可用模型</button>
          <button class="secondary add-model" data-p="${providerIndex}">手动添加模型</button>
        </div>
      </div>
      <div class="models">${models.length
        ? models.map((model, modelIndex) => modelHtml(model, providerIndex, modelIndex)).join("")
        : '<div class="hint">还没有模型。可以向中转站查询可用模型，也可以手动添加。</div>'}</div>
    </div>
  </div>
</section>`;
}

const UTILITY_MODES = [
  {
    value: "mainAgent",
    label: "跟随主会话模型",
    hint: "辅助调用直接复用你在模型选择器里选的 PolyBridge 模型。",
  },
  {
    value: "model",
    label: "指定一个模型",
    hint: "辅助调用固定走下面选中的模型，适合挑一个便宜的型号专门干杂活。",
  },
  {
    value: "none",
    label: "禁止（宁可报错）",
    hint: "不允许辅助调用走 Copilot 订阅；没有可用模型时直接报错，绝不静默扣额度。",
  },
  {
    value: "copilot",
    label: "使用 Copilot 订阅（VS Code 默认）",
    hint: "保持 VS Code 出厂行为，辅助调用消耗 GitHub Copilot 订阅额度。",
  },
];

function modelOptions(selected) {
  const options = routableModels.map((model) =>
    `<option value="${esc(model.pickerId)}" ${model.pickerId === selected ? "selected" : ""}>${esc(model.name)}</option>`
  ).join("");
  return `<option value="" ${selected ? "" : "selected"}>（未选择）</option>${options}`;
}

/** Head of a collapsible panel, so a closed card still says what it is set to. */
function panelHeadHtml(key, title, badges) {
  return `<div class="card-head" data-toggle-panel="${key}">
    <span class="twisty">›</span>
    <h2>${esc(title)}</h2>
    ${badges.filter(Boolean).join("")}
  </div>`;
}

function routingHtml() {
  if (!routing) return "";
  if (!routableModels.length) {
    return `<section class="card panel routing ${panelOpen.routing ? "open" : ""}">
  ${panelHeadHtml("routing", "Copilot 路由", ['<span class="badge">还不可用</span>'])}
  <div class="card-body"><div class="section"><div class="hint">先添加并保存至少一个支持工具调用的模型，这里才能选择路由目标。</div></div></div>
</section>`;
  }

  const modeBoxes = UTILITY_MODES.map((mode) =>
    `<label class="radio ${routing.utility === mode.value ? "on" : ""}">
      <input type="radio" name="utility" value="${mode.value}" ${routing.utility === mode.value ? "checked" : ""}>
      <span class="radio-text"><strong>${esc(mode.label)}</strong><span class="hint">${esc(mode.hint)}</span></span>
    </label>`
  ).join("");

  const utilityMode = UTILITY_MODES.find((mode) => mode.value === routing.utility);
  const badges = [
    `<span class="badge${routing.utility === "copilot" ? " warn" : " ok"}">辅助调用：${esc(utilityMode ? utilityMode.label : "未设置")}</span>`,
    routing.subagentRedirect ? '<span class="badge ok">子 Agent 强制改道</span>' : "",
  ];

  return `<section class="card panel routing ${panelOpen.routing ? "open" : ""}">
  ${panelHeadHtml("routing", "Copilot 路由", badges)}
  <div class="card-body">
    <p class="muted">Copilot 有几类请求不走模型选择器，默认会落到 GitHub 订阅模型上。在这里一次设好，PolyBridge 会替你写进对应的 VS Code 设置。</p>

    <div class="section">
      <div class="section-title"><h3>辅助调用</h3></div>
      <p class="hint">应用代码块（mapCode）、生成标题、压缩历史等后台请求。数量很多，是订阅额度的主要消耗来源。</p>
      <div class="radio-grid">${modeBoxes}</div>
      <div class="grid ${routing.utility === "model" ? "" : "disabled"}" id="utility-models">
        <div class="field">
          <label>辅助调用使用的模型</label>
          <select data-routing="utilityModel">${modelOptions(routing.utilityModel)}</select>
          <span class="hint">对应设置 <code>chat.utilityModel</code>。</span>
        </div>
        <div class="field">
          <label>轻量辅助调用使用的模型</label>
          <select data-routing="utilitySmallModel">${modelOptions(routing.utilitySmallModel)}</select>
          <span class="hint">对应设置 <code>chat.utilitySmallModel</code>；留空则跟随上一项。</span>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><h3>内置子 Agent</h3></div>
      <div class="grid">
        <div class="field check-option">
          <label><input type="checkbox" data-routing="executionSubagent" ${routing.executionSubagent === "inherit" ? "checked" : ""}> 执行子 Agent 继承主会话模型</label>
          <span class="hint">不勾选时它固定使用 Copilot 的 gemini-3-flash，与你选的模型无关。</span>
        </div>
        <div class="field check-option">
          <label><input type="checkbox" data-routing="searchSubagent" ${routing.searchSubagent === "inherit" ? "checked" : ""}> 搜索子 Agent 继承主会话模型</label>
          <span class="hint">它本来就默认继承，勾上可以防止被远程实验配置改掉。</span>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><h3>子 Agent 使用的模型</h3></div>
      <p class="hint">主 Agent 委派任务（runSubagent）时使用哪个模型。VS Code 的解析顺序是：调用时自带的 model 参数 &gt; 自定义 Agent 的 model 字段 &gt; 继承主会话。下面这一项写进自定义 Agent 文件，是客户端能做到的最强绑定。</p>
      <div class="grid">
        <div class="field">
          <label>委派任务时使用</label>
          <select data-routing="subagentModel">${modelOptions(routing.subagentModel)}</select>
          <span class="hint">选好后点右边按钮生成 Agent 文件；之后在聊天里让主 Agent 用它委派即可。</span>
        </div>
        <div class="field">
          <label>生成配置文件</label>
          <div class="actions">
            <button class="secondary" id="write-agent">生成子 Agent 文件</button>
            <button class="secondary" id="write-instructions">写入项目指令</button>
          </div>
          <span class="hint">分别写入 <code>.github/agents/poly-subagent.agent.md</code> 和 <code>.github/copilot-instructions.md</code>。</span>
        </div>
      </div>
      <div class="grid">
        <div class="field check-option">
          <label><input type="checkbox" data-routing="subagentRedirect" ${routing.subagentRedirect ? "checked" : ""}> 强制改道：主 Agent 没点名时也用上面这个模型</label>
          <span class="hint">上面两个文件只在主 Agent 主动传 <code>agentName</code> 时才生效；不传时 VS Code 会直接继承主会话模型。勾上后，PolyBridge 在发请求前自行识别子 Agent 回合（其工具列表里没有 <code>runSubagent</code>），把上游模型换成你选的那个。<strong>注意 VS Code 界面仍会显示继承来的模型名</strong>，真实去向见 PolyBridge 输出面板。</span>
        </div>
      </div>
      <p class="hint">注意：模型调用时如果自己传了 model 参数，优先级高于上面的设置，客户端无法强制拦截——而 VS Code 给模型看的工具说明里写着「vendor 通常是 copilot」，它因此容易选到订阅模型。项目指令就是用来抵消这句提示的。</p>
      <p class="hint">另外，模型名里的「· 中转站名」后缀只在配置了多个中转站时才出现。VS Code 按完整字符串精确匹配，所以<strong>增删中转站之后，请回到这里重新生成上面两个文件</strong>，否则旧名字会匹配不上并悄悄退回主会话模型。</p>
    </div>

    <div class="actions routing-actions">
      <button class="save" id="save-routing">保存路由设置</button>
    </div>
  </div>
</section>`;
}

const CLI_SHELLS = [
  { value: "pwsh", label: "PowerShell" },
  { value: "bash", label: "bash / zsh" },
  { value: "cmd", label: "cmd" },
];

function cliHtml() {
  if (!routableModels.length) {
    return `<section class="card panel cli ${panelOpen.cli ? "open" : ""}">
  ${panelHeadHtml("cli", "Copilot CLI", ['<span class="badge">还不可用</span>'])}
  <div class="card-body"><div class="section"><div class="hint">先添加并保存至少一个支持工具调用的模型，这里才能生成 CLI 配置。</div></div></div>
</section>`;
  }

  const modelPicks = routableModels.map((model) =>
    `<option value="${esc(model.pickerId)}" ${model.pickerId === cli.pickerId ? "selected" : ""}>${esc(model.name)}</option>`
  ).join("");
  const shellPicks = CLI_SHELLS.map((item) =>
    `<option value="${item.value}" ${item.value === cli.shell ? "selected" : ""}>${esc(item.label)}</option>`
  ).join("");

  const chosen = routableModels.find((model) => model.pickerId === cli.pickerId);
  const badges = [
    `<span class="badge${cli.enabled ? " ok" : ""}">${cli.enabled ? "终端已接管" : "未启用"}</span>`,
    cli.enabled && chosen ? `<span class="badge">${esc(chosen.name)}</span>` : "",
  ];

  return `<section class="card panel cli ${panelOpen.cli ? "open" : ""}">
  ${panelHeadHtml("cli", "Copilot CLI", badges)}
  <div class="card-body">
    <p class="muted">终端里的 <code>copilot</code> 是独立进程，看不到 VS Code 里注册的模型。好在它自带 BYOK，认的三种协议和这里配的完全一致，所以 PolyBridge 把中转站翻译成一组环境变量交给它就行。</p>

    <div class="section">
      <label class="switch${cli.enabled ? " on" : ""}">
        <input type="checkbox" id="cli-enabled" ${cli.enabled ? "checked" : ""}>
        <span class="switch-text">
          <strong>让 VS Code 终端里的 copilot 走中转站</strong>
          <span class="hint">打开后，这个窗口新开的每个终端都会自动带上下面这组变量，直接敲 <code>copilot</code> 就行——不用改 shell 配置文件，也不用手动 export。关掉即恢复 GitHub 订阅模型。</span>
        </span>
      </label>
      <div class="grid">
        <div class="field">
          <label>CLI 使用的模型</label>
          <select data-cli="pickerId">${modelPicks}</select>
          <span class="hint">只列出支持工具调用的模型——CLI 强制要求工具调用和流式输出。</span>
        </div>
      </div>
      <p class="hint">API key 从 SecretStorage 现取现用，只交给终端进程，不写进任何文件；VS Code 关掉后这组变量随之消失。已经开着的终端要重开一次才会生效。</p>
      <div class="actions routing-actions">
        <button class="secondary" id="launch-cli">新开一个终端并启动</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title"><h3>换模型</h3></div>
      <p class="hint">CLI 配了自定义 provider 之后模型列表为空，<strong>会话中途的 <code>/model</code> 用不了</strong>。CLI 内部确实有支持多模型和会话内切换的注册表，但只对 SDK 开放，交互式的 <code>copilot</code> 没有任何环境变量、命令行参数或配置项能喂给它。</p>
      <p class="hint">好在同一个中转站内换模型很便宜：<code>COPILOT_MODEL</code> 只是默认值，<strong>退出后直接运行 <code>copilot --model &lt;模型ID&gt;</code></strong> 就换掉了，环境变量不用重设。换中转站或换协议才需要回到这里重选。</p>
      <div id="cli-siblings">${cliSiblingsHtml()}</div>
    </div>

    <details class="advanced cli-advanced">
      <summary>手动配置（外部终端、Windows Terminal、CI 等）</summary>
      <div class="section">
        <div class="grid">
          <div class="field">
            <label>片段写法</label>
            <select data-cli="shell">${shellPicks}</select>
            <span class="hint">只影响下面片段和「复制」按钮的写法，上面的开关不受影响。</span>
          </div>
        </div>
        <pre class="snippet" id="cli-snippet">${esc(cli.snippet)}</pre>
        <div class="actions routing-actions">
          <button class="secondary" id="copy-cli">复制环境变量</button>
        </div>
        <p class="hint">出于安全考虑，复制出来的片段里 API key 是占位符，粘贴后请自行替换。</p>
        <div id="cli-warnings">${cliWarningsHtml()}</div>
      </div>
    </details>

    <div class="section">
      <div class="section-title"><h3>一处取舍</h3></div>
      <p class="hint"><strong>启用后 GitHub 自带模型不再可用。</strong>设了自定义端点之后所有请求都走中转站，每月的 AI Credits 也不会被消耗——这既是省额度的办法，也意味着订阅模型在这些终端里用不了。</p>
      <p class="hint">好消息是 CLI 内置的子 Agent（explore / task / code-review）会自动继承这套配置，不像插件那边还要单独指定。</p>
    </div>
  </div>
</section>`;
}

function cliSiblingsHtml() {
  if (!cli.siblings.length) return "";
  return `<p class="snippet-label">这个中转站里，同一组变量下还能直接切到：</p>
  <pre class="snippet">${cli.siblings
    .map((id) => esc("copilot --model " + id))
    .join("\n")}</pre>`;
}

function cliWarningsHtml() {
  if (!cli.warnings.length) return "";
  return `<ul class="warnings">${cli.warnings.map((text) => `<li>${esc(text)}</li>`).join("")}</ul>`;
}

function render() {
  const content = document.getElementById("content");
  const modelCount = providers.reduce(
    (total, provider) => total + (Array.isArray(provider.models) ? provider.models.length : 0),
    0
  );
  content.innerHTML = providers.length
    ? `<div class="group-title">中转站 · ${providers.length} 个 / ${modelCount} 个模型</div>` +
      providers.map(providerHtml).join("")
    : `<div class="empty"><h2>还没有添加中转站</h2><p class="muted">添加一个中转站，把它提供的模型接入 Copilot。全部设置都在这个界面完成。</p><button id="empty-add">添加第一个中转站</button></div>`;
  // Both panels are collapsed by default, so they sit under one heading rather
  // than competing with the provider list for attention. They stay in separate
  // containers because bindRouting/bindCli scope their queries to each id.
  const routingCard = providers.length ? routingHtml() : "";
  document.getElementById("routing").innerHTML = routingCard
    ? '<div class="group-title">进阶设置</div>' + routingCard
    : "";
  document.getElementById("cli").innerHTML = providers.length ? cliHtml() : "";
  document.getElementById("savebar").style.display = providers.length ? "flex" : "none";
  bind();
}

function parseHeaders(text) {
  const result = {};
  String(text || "").split(/\r?\n/).forEach((line) => {
    const index = line.indexOf(":");
    if (index > 0) {
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key && value) result[key] = value;
    }
  });
  return result;
}

function sync() {
  document.querySelectorAll("[data-provider]").forEach((card) => {
    const provider = providers[Number(card.dataset.provider)];
    card.querySelectorAll(":scope > .card-body > .grid [data-k]").forEach((element) => {
      const key = element.dataset.k;
      if (key === "requiresApiKey") provider[key] = element.checked;
      else if (key === "extraHeaders") provider[key] = parseHeaders(element.value);
      else provider[key] = element.value;
    });
    card.querySelectorAll("[data-model]").forEach((row) => {
      const model = provider.models[Number(row.dataset.model)];
      row.querySelectorAll("[data-k]").forEach((element) => {
        const key = element.dataset.k;
        if (["thinking", "vision", "toolCalling"].includes(key)) model[key] = element.checked;
        else model[key] = element.value;
      });
      const selectedEfforts = [...row.querySelectorAll("[data-effort]")]
        .filter((element) => element.checked)
        .map((element) => element.dataset.effort);
      const customEfforts = row.querySelector("[data-custom-efforts]").value
        .split(/[,，]/).map((value) => value.trim()).filter(Boolean);
      model.efforts = [...new Set([...selectedEfforts, ...customEfforts])];
      const preset = row.querySelector("[data-context-preset]").value;
      const custom = row.querySelector("[data-context-custom]").value;
      model.maxInputTokens = preset === "custom" ? custom : preset;
    });
  });
}

function mutate(change) {
  sync();
  change();
  dirty = true;
  render();
}

function bind() {
  // Scoped to #content: the routing panel saves separately, so edits there
  // must not light up the provider save bar or the unsaved-changes guard.
  document.querySelectorAll("#content input,#content select,#content textarea").forEach((element) => {
    element.addEventListener("input", () => { dirty = true; });
  });
  document.querySelectorAll("[data-context-preset]").forEach((select) => {
    select.addEventListener("change", () => {
      const input = select.parentElement.querySelector("[data-context-custom]");
      input.disabled = select.value !== "custom";
      if (select.value === "custom") input.focus();
    });
    select.parentElement.querySelector("[data-context-custom]").disabled = select.value !== "custom";
  });
  document.querySelectorAll("[data-toggle-provider]").forEach((head) => {
    head.onclick = (event) => {
      if (event.target.closest("button")) return;
      const provider = providers[Number(head.dataset.toggleProvider)];
      provider._open = !provider._open;
      head.parentElement.classList.toggle("open", provider._open);
    };
  });
  document.querySelectorAll("[data-toggle-model]").forEach((head) => {
    head.onclick = (event) => {
      if (event.target.closest("button")) return;
      const card = head.closest("[data-provider]");
      const model = providers[Number(card.dataset.provider)].models[Number(head.dataset.toggleModel)];
      model._open = !model._open;
      head.parentElement.classList.toggle("open", model._open);
    };
  });
  document.querySelectorAll(".remove-provider").forEach((button) => {
    button.onclick = () => {
      const provider = providers[Number(button.dataset.p)];
      if (confirm(`确定删除中转站“${provider.name}”及其所有模型吗？`)) {
        mutate(() => providers.splice(Number(button.dataset.p), 1));
      }
    };
  });
  document.querySelectorAll(".add-model").forEach((button) => {
    button.onclick = () => mutate(() => providers[Number(button.dataset.p)].models.push(defaultModel()));
  });
  document.querySelectorAll(".remove-model").forEach((button) => {
    button.onclick = () => mutate(() => providers[Number(button.dataset.p)].models.splice(Number(button.dataset.m), 1));
  });
  document.querySelectorAll(".key").forEach((button) => {
    button.onclick = () => {
      sync();
      vscode.postMessage({ type: "setKey", providerName: providers[Number(button.dataset.p)].name });
    };
  });
  document.querySelectorAll(".fetch").forEach((button) => {
    button.onclick = () => {
      sync();
      vscode.postMessage({ type: "fetchModels", provider: providers[Number(button.dataset.p)] });
    };
  });
  document.querySelectorAll("[data-toggle-panel]").forEach((head) => {
    head.onclick = (event) => {
      // The switch and its label live inside the body, never the head, so a
      // click here is always a collapse — except on the buttons we host there.
      if (event.target.closest("button")) return;
      const key = head.dataset.togglePanel;
      panelOpen[key] = !panelOpen[key];
      head.parentElement.classList.toggle("open", panelOpen[key]);
    };
  });
  const emptyAdd = document.getElementById("empty-add");
  if (emptyAdd) emptyAdd.onclick = () => mutate(() => providers.push(defaultProvider()));
  bindRouting();
  bindCli();
}

function requestCliPreview() {
  if (!cli.pickerId) return;
  vscode.postMessage({ type: "cliPreview", pickerId: cli.pickerId, shell: cli.shell });
}

function bindCli() {
  const panel = document.getElementById("cli");
  if (!panel) return;
  panel.querySelectorAll("[data-cli]").forEach((element) => {
    element.addEventListener("change", () => {
      cli[element.dataset.cli] = element.value;
      // Only the preview changes, so patch it in place rather than re-rendering
      // — a full render would rebuild the provider cards and drop focus.
      requestCliPreview();
      // The switch is live: changing the model while it is on re-applies it,
      // so there is nothing extra to press.
      if (cli.enabled && element.dataset.cli === "pickerId") saveCliState();
    });
  });
  const toggle = document.getElementById("cli-enabled");
  if (toggle) {
    toggle.onchange = () => {
      cli.enabled = toggle.checked;
      saveCliState();
    };
  }
  const launch = document.getElementById("launch-cli");
  if (launch) {
    launch.onclick = () =>
      vscode.postMessage({ type: "launchCli", pickerId: cli.pickerId });
  }
  const copy = document.getElementById("copy-cli");
  if (copy) {
    copy.onclick = () =>
      vscode.postMessage({ type: "copyCliEnv", pickerId: cli.pickerId, shell: cli.shell });
  }
}

function saveCliState() {
  vscode.postMessage({
    type: "saveCliState",
    enabled: cli.enabled,
    pickerId: cli.pickerId,
  });
}

/** Read routing controls back into `routing` without touching provider state. */
const BOOLEAN_ROUTING_KEYS = new Set(["subagentRedirect"]);

function syncRouting() {
  if (!routing) return;
  const panel = document.getElementById("routing");
  const checked = panel.querySelector('input[name="utility"]:checked');
  if (checked) routing.utility = checked.value;
  panel.querySelectorAll("[data-routing]").forEach((element) => {
    const key = element.dataset.routing;
    if (element.type === "checkbox") {
      // The built-in subagent toggles map onto a model name VS Code parses,
      // where "" means inherit; this one is a plain PolyBridge boolean.
      routing[key] = BOOLEAN_ROUTING_KEYS.has(key)
        ? element.checked
        : element.checked ? "inherit" : "default";
    } else {
      routing[key] = element.value;
    }
  });
}

function bindRouting() {
  const panel = document.getElementById("routing");
  if (!panel || !routing) return;
  // Switching the utility mode toggles the model pickers, so re-render — but
  // sync provider edits first so an in-progress form isn't discarded.
  panel.querySelectorAll('input[name="utility"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      sync();
      syncRouting();
      render();
    });
  });
  const write = document.getElementById("write-instructions");
  if (write) {
    write.onclick = () => vscode.postMessage({ type: "writeInstructions" });
  }
  const writeAgent = document.getElementById("write-agent");
  if (writeAgent) {
    writeAgent.onclick = () => {
      syncRouting();
      // Persist the choice alongside the file, so reopening the panel shows it.
      vscode.postMessage({ type: "saveRouting", routing });
      vscode.postMessage({ type: "writeAgentFile", pickerId: routing.subagentModel });
    };
  }
  const save = document.getElementById("save-routing");
  if (save) {
    save.onclick = () => {
      syncRouting();
      vscode.postMessage({ type: "saveRouting", routing });
    };
  }
}

function notice(text, isError) {
  const element = document.getElementById("notice");
  element.textContent = text;
  element.className = "notice show" + (isError ? " error" : "");
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { element.className = "notice"; }, 5000);
}

document.getElementById("add").onclick = () => mutate(() => providers.push(defaultProvider()));
document.getElementById("raw").onclick = () => vscode.postMessage({ type: "openSettings" });
document.querySelectorAll(".save").forEach((button) => {
  button.onclick = () => {
    sync();
    vscode.postMessage({ type: "save", providers });
  };
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "state") {
    const openProviders = new Set(providers.filter((provider) => provider._open).map((provider) => provider.name));
    providers = (message.providers || []).map((provider) => ({
      ...provider,
      _open: openProviders.size ? openProviders.has(provider.name) : false,
      models: (provider.models || []).map((model) => ({ ...model, _open: false })),
    }));
    keyStates = message.keyStates || {};
    routing = message.routing || null;
    routableModels = message.models || [];
    if (message.cliShell) cli.shell = message.cliShell;
    if (message.cliState) {
      cli.enabled = message.cliState.enabled === true;
      if (message.cliState.pickerId) cli.pickerId = message.cliState.pickerId;
    }
    // Keep the chosen model across saves, but fall back when it was renamed
    // or removed — its picker id embeds the provider and model names.
    if (!routableModels.some((model) => model.pickerId === cli.pickerId)) {
      cli.pickerId = routableModels.length ? routableModels[0].pickerId : "";
      cli.snippet = "";
      cli.warnings = [];
      cli.siblings = [];
    }
    dirty = false;
    render();
    requestCliPreview();
  } else if (message.type === "cliPreview") {
    cli.snippet = message.snippet || "";
    cli.warnings = message.warnings || [];
    cli.siblings = message.siblings || [];
    const snippet = document.getElementById("cli-snippet");
    const warnings = document.getElementById("cli-warnings");
    const siblings = document.getElementById("cli-siblings");
    if (snippet) snippet.textContent = cli.snippet;
    if (warnings) warnings.innerHTML = cliWarningsHtml();
    if (siblings) siblings.innerHTML = cliSiblingsHtml();
  } else if (message.type === "cliStateSaved") {
    notice(
      message.message ||
        (message.active
          ? "已启用：新开的终端里 copilot 会走中转站。"
          : "已关闭：终端里的 copilot 恢复使用 GitHub 订阅模型。"),
      !!message.message
    );
  } else if (message.type === "routingSaved") {
    notice(message.message || "路由设置已保存。");
  } else if (message.type === "saved") {
    dirty = false;
    notice("已保存，模型列表已刷新。");
  } else if (message.type === "error") {
    notice(message.message, true);
  } else if (message.type === "models") {
    const provider = providers.find((item) => item.name === message.providerName);
    if (!provider) return;
    const existing = new Set(provider.models.map((model) => model.id));
    const added = message.ids.filter((id) => !existing.has(id));
    added.forEach((id) => provider.models.push(defaultModel(id)));
    dirty = true;
    render();
    notice(added.length
      ? `中转站返回 ${message.ids.length} 个模型，新增了 ${added.length} 个，记得保存。`
      : `中转站返回 ${message.ids.length} 个模型，都已经在列表里了。`);
  }
});

window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

vscode.postMessage({ type: "ready" });
