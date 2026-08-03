"use strict";

const CJK_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4}){4,}={0,2}$/;

function estimateTokenCount(value, strategy = "conservative") {
  const text = String(value || "");
  if (!text) return 0;
  if (BASE64_RE.test(text.replace(/\s/g, ""))) {
    return Math.ceil(text.length / 1.2);
  }
  let tokens = 0;
  let run = 0;
  for (const char of text) {
    if (CJK_RE.test(char)) {
      tokens += 1.5;
      run = 0;
    } else if (CONTROL_RE.test(char)) {
      tokens += 2;
      run = 0;
    } else if (/\s/.test(char)) {
      tokens += 0.34;
      run = 0;
    } else if (/[\u0080-\uffff]/.test(char)) {
      tokens += 1;
      run = 0;
    } else if (/[{}[\](),.:;!?<>/\\=+*#@_$%&|`~"']/.test(char)) {
      tokens += 0.55;
      run = 0;
    } else {
      run++;
      if (run >= 4) {
        tokens += 1;
        run = 0;
      }
    }
  }
  tokens += run / 4;
  const ratio = strategy === "balanced" ? 0.9 : 1;
  return Math.max(1, Math.ceil(tokens * ratio));
}

function truncateText(text, maxTokens) {
  const value = String(text || "");
  const limit = Math.max(256, Number(maxTokens) || 8000);
  if (estimateTokenCount(value) <= limit) return value;
  const marker = "\n\n[PolyBridge: 工具输出过长，已截断；如需完整内容请缩小结果后重试。]\n\n";
  const available = Math.max(100, Math.floor(limit * 2.4) - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = Math.max(0, available - head);
  return value.slice(0, head) + marker + (tail ? value.slice(-tail) : "");
}

function sanitizeNeutral(neutral, toolResultMaxTokens) {
  return neutral.map((message) => ({
    role: message.role,
    parts: message.parts.map((part) =>
      part.kind === "toolResult"
        ? { ...part, text: truncateText(part.text, toolResultMaxTokens) }
        : part
    ),
  }));
}

function estimateNeutralTokens(neutral) {
  let total = 8;
  for (const message of neutral) {
    total += 4;
    for (const part of message.parts || []) {
      if (part.kind === "text" || part.kind === "toolResult") {
        total += estimateTokenCount(part.text);
      } else if (part.kind === "toolCall") {
        total += 16 + estimateTokenCount(JSON.stringify({
          name: part.name,
          input: part.input || {},
        }));
      } else if (part.kind === "image") {
        total += 256 + Math.ceil(String(part.b64 || "").length / 1.5);
      }
    }
  }
  return total;
}

function completeUsage(upstream, promptTokens, completionTokens) {
  const prompt = Number(upstream && upstream.prompt_tokens);
  const completion = Number(upstream && upstream.completion_tokens);
  const normalizedPrompt = Number.isFinite(prompt)
    ? Math.max(0, Math.round(prompt))
    : Math.max(1, Math.round(Number(promptTokens) || 1));
  const normalizedCompletion = Number.isFinite(completion)
    ? Math.max(0, Math.round(completion))
    : Math.max(0, Math.round(Number(completionTokens) || 0));
  return {
    ...(upstream || {}),
    prompt_tokens: normalizedPrompt,
    completion_tokens: normalizedCompletion,
    total_tokens: normalizedPrompt + normalizedCompletion,
  };
}

function relatedToolIds(message) {
  return new Set((message.parts || [])
    .filter((part) => part.kind === "toolCall" || part.kind === "toolResult")
    .map((part) => part.id)
    .filter(Boolean));
}

function pruneNeutralToBudget(neutral, maxTokens, buildBody) {
  const budget = Math.max(1, Number(maxTokens) || 1);
  let current = neutral.slice();
  const estimate = () => estimateTokenCount(JSON.stringify(buildBody(current)));
  if (estimate() <= budget) return { neutral: current, pruned: false, estimatedTokens: estimate() };

  const protectedMessages = new Set();
  current.forEach((message) => {
    if (message.role === "system") protectedMessages.add(message);
  });
  for (let index = current.length - 1; index >= 0; index--) {
    if (current[index].role === "user") {
      protectedMessages.add(current[index]);
      break;
    }
  }
  const protectedToolIds = new Set();
  for (const message of protectedMessages) {
    for (const id of relatedToolIds(message)) protectedToolIds.add(id);
  }
  current.forEach((message) => {
    if ([...relatedToolIds(message)].some((id) => protectedToolIds.has(id))) {
      protectedMessages.add(message);
    }
  });

  let pruned = false;
  while (estimate() > budget) {
    const candidate = current.find((message) => !protectedMessages.has(message));
    if (!candidate) break;
    const ids = relatedToolIds(candidate);
    const remove = new Set([candidate]);
    if (ids.size) {
      current.forEach((message) => {
        if ([...relatedToolIds(message)].some((id) => ids.has(id))) remove.add(message);
      });
    }
    current = current.filter((message) => !remove.has(message));
    pruned = true;
  }
  const estimatedTokens = estimate();
  return { neutral: current, pruned, estimatedTokens };
}

module.exports = {
  estimateTokenCount,
  truncateText,
  sanitizeNeutral,
  estimateNeutralTokens,
  completeUsage,
  pruneNeutralToBudget,
};
