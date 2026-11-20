import { bindSelector } from "./selector.mjs";

// CCR's ai-gateway (1.0.21, normalizeAnthropicToolResultContent in
// src/adapters/builtins/source/parsers.ts) flattens a tool_result content
// array to one string when it converts an Anthropic request for another
// protocol. Image parts are dropped when the result also has text, and an
// image-only result is JSON.stringify'd, so the base64 reaches the model as
// text tokens. Image blocks in ordinary user content are converted properly.
// So each image a tool_result carries moves out of it, to just after the last
// tool_result of the same user message, with a marker left in its place
// unless that would hide a sibling block (see leavesMarkers); no message is
// added, so role alternation holds. A label naming the tool_use_id
// precedes each moved image so several results stay distinguishable. The
// marker does not say "below": the Responses builder emits the user item
// before function_call_output.
//
// Anthropic Messages targets are left alone: for the same protocol the
// gateway by default forwards the request body as is
// (canPassthroughWithoutProtocolConversion in src/gateway/handler.ts). It
// rebuilds the body from the lossy parse only when a beforeUpstream request
// transform plugin is loaded or transparentToolExecution is enabled; CCR sets
// neither. A model this profile cannot bind to a provider is still rewritten,
// because the hoisted form is valid Anthropic either way. Only changed
// `content` arrays are re-encoded; every other byte is kept and an unchanged
// body is returned as the same object.
export function hoistToolResultImages(rawBody, providers) {
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== "string") return rawBody;
  let source;
  let body;
  try {
    source = Buffer.isBuffer(rawBody)
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBody)
      : rawBody;
    if (!source.includes('"tool_result"') || !source.includes('"image"')) return rawBody;
    body = JSON.parse(source);
  } catch { return rawBody; }
  if (!isRecord(body) || !Array.isArray(body.messages)) return rawBody;
  if (bindSelector(body.model, providers)?.provider.type === "anthropic_messages") return rawBody;

  const changed = new Map();
  body.messages.forEach((message, index) => {
    const content = hoistMessageImages(message);
    if (content !== null) changed.set(index, content);
  });
  if (changed.size === 0) return rawBody;

  let spans;
  try { spans = contentSpans(source, changed); } catch { return rawBody; }
  if (spans.length !== changed.size) return rawBody;
  const parts = [];
  let cursor = 0;
  for (const { start, end, index } of spans) {
    parts.push(source.slice(cursor, start), JSON.stringify(changed.get(index)));
    cursor = end;
  }
  parts.push(source.slice(cursor));
  const encoded = parts.join("");
  return Buffer.isBuffer(rawBody) ? Buffer.from(encoded) : encoded;
}

function hoistMessageImages(message) {
  if (message?.role !== "user" || !Array.isArray(message.content)) return null;
  const hoisted = [];
  let lastToolResult = -1;
  const content = message.content.map((block, position) => {
    if (block?.type !== "tool_result") return block;
    lastToolResult = position;
    if (!Array.isArray(block.content)) return block;
    const total = block.content.filter(isImage).length;
    if (total === 0) return block;
    const markers = leavesMarkers(block.content);
    let seen = 0;
    const kept = block.content.flatMap((item) => {
      if (!isImage(item)) return [item];
      seen++;
      const from = typeof block.tool_use_id === "string" ? `tool result ${block.tool_use_id}` : "a tool result";
      hoisted.push(
        { type: "text", text: `[image ${seen} of ${total} from ${from}]` },
        item,
      );
      if (!markers) return [];
      return [{
        type: "text",
        text: `[image ${seen} of ${total} from this tool result is attached separately as user content]`,
      }];
    });
    return { ...block, content: kept };
  });
  if (hoisted.length === 0) return null;
  content.splice(lastToolResult + 1, 0, ...hoisted);
  return content;
}

// The gateway keeps only the text of a tool_result once any part yields text,
// reading just a top-level text/input_text/output_text string. A marker beside
// a document or search_result with no such text would therefore discard that
// block, which before the hoist reached the model inside the JSON.stringify'd
// array. Markers stay only when the other blocks already carry text (opaque
// ones are dropped either way) or are all plain text.
function leavesMarkers(content) {
  const others = content.filter((item) => !isImage(item) && item?.type !== "tool_reference");
  return others.some(yieldsText) || others.every((item) => typeof item === "string" || item?.type === "text");
}

function yieldsText(item) {
  if (typeof item === "string") return item.trim() !== "";
  if (!isRecord(item)) return false;
  return ["text", "input_text", "output_text"].some((key) => typeof item[key] === "string" && item[key].trim() !== "");
}

function isImage(item) {
  return isRecord(item) && item.type === "image";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Offsets of `messages[i].content` for each index in `wanted`, in source
// order. Only the path down to those arrays is walked; other values are
// skipped. Duplicate keys on that path make the parsed body ambiguous, so
// they throw and the caller forwards the original bytes.
function contentSpans(source, wanted) {
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
  // Calls visit(key) at each member's value; visit consumes the value or
  // returns false to have it skipped.
  const object = (visit) => {
    whitespace();
    if (source[cursor++] !== "{") throw new Error("not an object");
    const keys = new Set();
    whitespace();
    if (source[cursor] === "}") { cursor++; return; }
    for (;;) {
      whitespace();
      const keyStart = cursor;
      skipString();
      const key = JSON.parse(source.slice(keyStart, cursor));
      if (keys.has(key)) throw new Error("duplicate key");
      keys.add(key);
      whitespace();
      if (source[cursor++] !== ":") throw new Error("missing colon");
      whitespace();
      if (!visit(key)) skipValue();
      whitespace();
      const separator = source[cursor++];
      if (separator === "}") return;
      if (separator !== ",") throw new Error("missing separator");
    }
  };

  const spans = [];
  object((key) => {
    if (key !== "messages") return false;
    if (source[cursor++] !== "[") throw new Error("messages is not an array");
    whitespace();
    if (source[cursor] === "]") { cursor++; return true; }
    for (let index = 0; ; index++) {
      whitespace();
      if (wanted.has(index)) {
        object((member) => {
          if (member !== "content") return false;
          const start = cursor;
          skipValue();
          spans.push({ start, end: cursor, index });
          return true;
        });
      } else {
        skipValue();
      }
      whitespace();
      const separator = source[cursor++];
      if (separator === "]") return true;
      if (separator !== ",") throw new Error("missing separator");
    }
  });
  return spans;
}
