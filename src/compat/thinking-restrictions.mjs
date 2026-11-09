import { bindSelector } from "./selector.mjs";

const ACCEPTED_DISPLAYS = new Set(["summarized", "omitted"]);

// Some Anthropic-compatible gateways validate `thinking` against an older
// schema than Claude Code speaks. Web LiteLLM (2026-11) rejects
// `display: "updates"` ("Input should be 'summarized', 'omitted'") and
// `type: "disabled"` for every Claude 5.x deployment it fronts, while the same
// requests succeed without the display value and without `thinking` at all.
// For the providers a profile lists, drop exactly those two shapes; every
// other byte is forwarded untouched so large integers and escapes in history
// survive, and an unchanged body is returned as the same object.
export function normalizeRestrictedThinking(rawBody, providers, restrictedProviders) {
  if (!Array.isArray(restrictedProviders) || restrictedProviders.length === 0) return rawBody;
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string") return rawBody;
  let source;
  let body;
  try {
    source = Buffer.isBuffer(rawBody)
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody)
      : rawBody;
    if (!source.includes('"thinking"')) return rawBody;
    body = JSON.parse(source);
  } catch { return rawBody; }
  const thinking = body?.thinking;
  if (!isRecord(thinking)) return rawBody;
  const bound = bindSelector(body.model, providers);
  if (bound?.provider.type !== "anthropic_messages" || !restrictedProviders.includes(bound.provider.name)) {
    return rawBody;
  }

  let replacement;
  if (thinking.type === "disabled") {
    replacement = null;
  } else if (thinking.type === "adaptive" && Object.hasOwn(thinking, "display") &&
    !ACCEPTED_DISPLAYS.has(thinking.display)) {
    const { display: _display, ...rest } = thinking;
    replacement = JSON.stringify(rest);
  } else {
    return rawBody;
  }

  let members;
  try { members = topLevelMembers(source); } catch { return rawBody; }
  const matches = members.filter(({ key }) => key === "thinking");
  if (matches.length !== 1) return rawBody;
  const [member] = matches;
  let encoded;
  if (replacement !== null) {
    encoded = source.slice(0, member.valueStart) + replacement + source.slice(member.valueEnd);
  } else {
    // Remove the member with exactly one of its neighbouring commas.
    const index = members.indexOf(member);
    const start = index > 0 ? members[index - 1].valueEnd : member.keyStart;
    const end = index > 0 ? member.valueEnd : (members[index + 1]?.keyStart ?? member.valueEnd);
    encoded = source.slice(0, start) + source.slice(end);
  }
  return Buffer.isBuffer(rawBody) ? Buffer.from(encoded) : encoded;
}

// Offsets of each top-level member of a JSON object. Nested values are
// skipped, not interpreted; JSON.parse has already proven the text valid.
function topLevelMembers(source) {
  let cursor = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(source[cursor] ?? "")) cursor++; };
  const skipString = () => {
    cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") cursor += 2;
      else if (source[cursor++] === '"') return;
    }
    throw new Error("invalid string");
  };
  const skipValue = () => {
    let depth = 0;
    for (;;) {
      const char = source[cursor];
      if (char === undefined) throw new Error("truncated value");
      if (char === '"') {
        skipString();
        if (depth === 0) return;
      } else if (char === "{" || char === "[") {
        depth++;
        cursor++;
      } else if (char === "}" || char === "]") {
        if (depth === 0) return;
        depth--;
        cursor++;
        if (depth === 0) return;
      } else if (depth === 0 && /[,\t\r\n ]/.test(char)) {
        return;
      } else {
        cursor++;
      }
    }
  };

  whitespace();
  if (source[cursor] !== "{") throw new Error("not an object");
  cursor++;
  const members = [];
  whitespace();
  if (source[cursor] === "}") return members;
  for (;;) {
    whitespace();
    const keyStart = cursor;
    skipString();
    const key = JSON.parse(source.slice(keyStart, cursor));
    whitespace();
    if (source[cursor++] !== ":") throw new Error("missing colon");
    whitespace();
    const valueStart = cursor;
    skipValue();
    members.push({ key, keyStart, valueStart, valueEnd: cursor });
    whitespace();
    const separator = source[cursor++];
    if (separator === "}") return members;
    if (separator !== ",") throw new Error("missing separator");
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
