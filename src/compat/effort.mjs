export function rewriteClaudeEffortForOpenAI(body) {
  if (!isRecord(body) || typeof body.model !== "string") return body;
  if (!isRecord(body.output_config) || typeof body.output_config.effort !== "string") {
    return body;
  }

  const model = modelName(body.model);
  if (isDeepSeek(model)) return withoutClaudeEffort(body);

  const effort = mappedEffort(model, body.output_config.effort);
  if (effort === null) return body;

  return { ...withoutClaudeEffort(body), reasoning_effort: effort };
}

// GPT reasoning models can spend a tiny completion allowance entirely on
// invisible reasoning. Claude Code uses 64-token requests for short internal
// summaries; give those requests enough room to produce the required text.
export function ensureGptMinimumOutputTokens(body) {
  if (!isRecord(body) || typeof body.model !== "string" || !isGpt(modelName(body.model)) || !Number.isInteger(body.max_tokens)) {
    return body;
  }
  if (body.max_tokens >= 1024) return body;
  return { ...body, max_tokens: 1024 };
}

function withoutClaudeEffort(body) {
  const rest = { ...body };
  delete rest.output_config;
  const outputConfig = { ...body.output_config };
  delete outputConfig.effort;
  return {
    ...rest,
    ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
  };
}

function isDeepSeek(model) {
  const normalized = model.toLowerCase();
  return normalized === "deepseek-v4-flash" || normalized === "deepseek-v4-pro";
}

function isGpt(model) {
  return typeof model === "string" && model.toLowerCase().startsWith("gpt-");
}

function mappedEffort(model, effort) {
  const normalizedModel = model.toLowerCase();
  const normalizedEffort = effort.trim().toLowerCase();
  if (normalizedModel === "glm-5.2" || normalizedModel === "kimi-k3") {
    return ["low", "medium", "high", "xhigh", "max"].includes(normalizedEffort)
      ? normalizedEffort
      : null;
  }
  return null;
}

function modelName(selector) {
  return selector.slice(selector.lastIndexOf("/") + 1);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
