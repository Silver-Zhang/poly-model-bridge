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

function render() {
  const content = document.getElementById("content");
  content.innerHTML = providers.length
    ? providers.map(providerHtml).join("")
    : `<div class="empty"><h2>还没有添加中转站</h2><p class="muted">添加一个中转站，把它提供的模型接入 Copilot。全部设置都在这个界面完成。</p><button id="empty-add">添加第一个中转站</button></div>`;
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
  document.querySelectorAll("input,select,textarea").forEach((element) => {
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
  const emptyAdd = document.getElementById("empty-add");
  if (emptyAdd) emptyAdd.onclick = () => mutate(() => providers.push(defaultProvider()));
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
    dirty = false;
    render();
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
