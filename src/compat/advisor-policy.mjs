export const NON_CLAUDE_ADVISOR_PROMPT = "Do not call Advisor at the start or end of routine work, nor once per user turn. Call it only after two different approaches to the same problem failed, or before an irreversible architectural decision.";

export const ADVISOR_CONFIG_KEYS = Object.freeze(["models", "gate"]);
export const DEFAULT_ADVISOR_GATE = Object.freeze({
  failedToolResults: 2,
  minToolCalls: 20,
  maxCallsPerConversation: 3,
  enabled: true,
});
export const ADVISOR_BLOCKED_TEXT = "Advisor is reserved for when you are genuinely stuck: try at least two approaches first.";

const APPROACH_CHANGE = /different approach|switch(?:ing)? approach|try another approach|new approach|換個方法|換方法/i;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"];

export function isClaudeExecutor(model) {
  if (typeof model !== "string") return false;
  // Routed selectors look like "provider,model" or "provider/model"; only the
  // model part decides, so a provider named after Claude cannot bypass gating.
  return /claude/i.test(model.slice(Math.max(model.indexOf(","), model.indexOf("/")) + 1));
}

function mappedAdvisorRoute(requested, advisorModels) {
  if (typeof requested !== "string") return null;
  const normalized = requested.toLowerCase();
  const aliases = [normalized];
  if (normalized.startsWith("claude-")) {
    aliases.push(...CLAUDE_FAMILIES.filter((family) => normalized.includes(family)));
  }
  const alias = aliases.find((candidate) => Object.hasOwn(advisorModels, candidate));
  return alias === undefined ? null : advisorModels[alias];
}

export function resolveAdvisorRoute(requested, { advisorModels, familyFallbacks, fallback }) {
  return mappedAdvisorRoute(requested, advisorModels) ?? familyFallbacks.advisor ?? fallback;
}

// A requested Advisor model with no advisor.models entry runs on the fallback route.
export function isAdvisorRouteSubstituted(requested, { advisorModels }) {
  return typeof requested === "string" && mappedAdvisorRoute(requested, advisorModels) === null;
}

export function isAdvisorAllowed({ model, messages = [], gate = {} }) {
  const limits = { ...DEFAULT_ADVISOR_GATE, ...gate };
  if (isClaudeExecutor(model) || !limits.enabled) return true;

  // Blocked or failed Advisor attempts never reached a reviewer, so they must
  // neither consume the conversation cap nor reset the "since last call" window.
  const discounted = new Set();
  for (const message of messages) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === "advisor_tool_result" && !isConsultation(block.content)) {
        discounted.add(block.tool_use_id);
      }
    }
  }
  const seenCalls = new Set();
  let calls = 0;
  let toolCalls = 0;
  let failures = 0;
  let changedApproach = false;
  let latestUserText = "";
  for (const message of messages) {
    const blocks = typeof message?.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message?.content) ? message.content : [];
    if (message?.role === "user") {
      const text = blocks.filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text.replace(SYSTEM_REMINDER, "")).join("\n");
      if (text.trim() !== "") latestUserText = text;
    }
    for (const block of blocks) {
      const advisorUse = message?.role === "assistant" && (
        (block?.type === "server_tool_use" && block.name === "advisor") ||
        (block?.type === "tool_use" && block.name === "airkit_advisor")
      );
      if (advisorUse || block?.type === "advisor_tool_result") {
        const id = advisorUse ? block.id : block.tool_use_id;
        if (id !== undefined && discounted.has(id)) continue;
        if (id === undefined || !seenCalls.has(id)) {
          calls += 1;
          if (id !== undefined) seenCalls.add(id);
        }
        toolCalls = 0;
        failures = 0;
        changedApproach = false;
        continue;
      }
      if (block?.type === "tool_use") toolCalls += 1;
      if (block?.type === "tool_result" && block.is_error === true) failures += 1;
      if (message?.role === "assistant" && block?.type === "text" &&
          typeof block.text === "string" && APPROACH_CHANGE.test(block.text)) {
        changedApproach = true;
      }
    }
  }
  if (calls >= limits.maxCallsPerConversation) return false;
  if (/advisor|顧問/i.test(latestUserText)) return true;
  return toolCalls >= limits.minToolCalls &&
    (failures >= limits.failedToolResults || changedApproach);
}

function isConsultation(content) {
  if (content?.type === "advisor_redacted_result") return true;
  return content?.type === "advisor_result" && content.text !== ADVISOR_BLOCKED_TEXT;
}
