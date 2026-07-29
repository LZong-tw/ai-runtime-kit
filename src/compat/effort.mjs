export function rewriteClaudeEffortForOpenAI(body) {
  if (!isRecord(body) || typeof body.model !== "string") return body;
  if (!isRecord(body.output_config) || typeof body.output_config.effort !== "string") {
    return body;
  }

  const effort = mappedEffort(modelName(body.model), body.output_config.effort);
  if (effort === null) return body;

  const rest = { ...body };
  delete rest.output_config;
  const outputConfig = { ...body.output_config };
  delete outputConfig.effort;
  return {
    ...rest,
    ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
    reasoning_effort: effort,
  };
}

function mappedEffort(model, effort) {
  const normalizedModel = model.toLowerCase();
  const normalizedEffort = effort.trim().toLowerCase();
  if (normalizedModel === "deepseek-v4-flash" || normalizedModel === "deepseek-v4-pro") {
    if (["low", "medium", "high"].includes(normalizedEffort)) return "high";
    if (["xhigh", "max"].includes(normalizedEffort)) return "max";
    return null;
  }
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
