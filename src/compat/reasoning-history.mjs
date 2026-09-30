// Plaintext Anthropic thinking is history, not a replayable OpenAI reasoning item.
// The Responses upstream rejects nonempty reasoning.content. Keep the text as
// ordinary assistant context; signed and opaque blocks are never rewritten.
export function normalizeResponsesThinkingHistory(rawBody, providers) {
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string") return rawBody;
  let source;
  let body;
  try {
    source = Buffer.isBuffer(rawBody) ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody) : rawBody;
    body = JSON.parse(source);
  } catch { return rawBody; }
  if (typeof body?.model !== "string" || !Array.isArray(body.messages)) return rawBody;
  let selector = body.model;
  const encodedSelector = /^(?:anthropic\/)?claude-ccr-h([0-9a-f]{2,4096})(?:\[1m\])?$/i.exec(selector);
  if (encodedSelector) {
    if (encodedSelector[1].length % 2 !== 0) return rawBody;
    try {
      selector = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(Buffer.from(encodedSelector[1], "hex"));
    } catch { return rawBody; }
  }
  const separator = selector.indexOf("/");
  if (separator < 1) return rawBody;
  const name = selector.slice(0, separator);
  const model = selector.slice(separator + 1);
  const provider = providers.find((entry) => entry.name === name);
  if (provider?.type !== "openai_responses" || !provider.models?.includes(model)) return rawBody;

  let replacements;
  try { replacements = thinkingRanges(source, body); } catch { return rawBody; }
  if (replacements.length === 0) return rawBody;
  const parts = [];
  let cursor = 0;
  for (const { start, end, text } of replacements.sort((a, b) => a.start - b.start)) {
    parts.push(source.slice(cursor, start), text);
    cursor = end;
  }
  parts.push(source.slice(cursor));
  const encoded = parts.join("");
  return Buffer.isBuffer(rawBody) ? Buffer.from(encoded) : encoded;
}

function thinkingRanges(source, body) {
  let cursor = 0;
  let nodes = 0;
  const replacements = [];
  const whitespace = () => { while (/[\t\r\n ]/.test(source[cursor] ?? "")) cursor++; };
  const string = () => {
    const start = cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") cursor += 2;
      else if (source[cursor++] === '"') return source.slice(start, cursor);
    }
    throw new Error("invalid string");
  };
  const walk = (path) => {
    if (++nodes > 200_000 || path.length > 128) throw new Error("history limit");
    whitespace();
    const start = cursor;
    if (source[cursor] === "{") {
      cursor++;
      whitespace();
      const fields = new Map();
      while (source[cursor] !== "}") {
        const keySource = string();
        const key = JSON.parse(keySource);
        if (fields.has(key)) throw new Error("duplicate key");
        whitespace();
        cursor++;
        whitespace();
        const valueStart = cursor;
        walk([...path, key]);
        fields.set(key, { keySource, valueSource: source.slice(valueStart, cursor) });
        whitespace();
        if (source[cursor] !== ",") break;
        cursor++;
        whitespace();
      }
      cursor++;
      if (path.length === 4 && path[0] === "messages" && path[2] === "content") {
        const message = body.messages[path[1]];
        const block = message?.content?.[path[3]];
        if (message?.role === "assistant" && Array.isArray(message.content) && block?.type === "thinking" &&
            typeof block.thinking === "string" && !fields.has("text") &&
            (block.signature === undefined || block.signature === "")) {
          const extra = [...fields].filter(([key]) => !["type", "thinking", "signature"].includes(key))
            .map(([, value]) => `${value.keySource}:${value.valueSource}`);
          const text = `{"type":"text","text":${fields.get("thinking").valueSource}${extra.length ? "," + extra.join(",") : ""}}`;
          replacements.push({ start, end: cursor, text });
        }
      }
    } else if (source[cursor] === "[") {
      cursor++;
      whitespace();
      let index = 0;
      while (source[cursor] !== "]") {
        walk([...path, index++]);
        whitespace();
        if (source[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (source[cursor] === '"') string();
    else while (cursor < source.length && !/[\t\r\n ,}\]]/.test(source[cursor])) cursor++;
  };
  walk([]);
  return replacements;
}
