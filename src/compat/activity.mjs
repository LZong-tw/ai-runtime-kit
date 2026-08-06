const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function createGptActivitySseTransform({ body } = {}) {
  let remainder = "";
  let gptResponse = false;
  let indexShift = 0;
  let outputBytes = 0;
  const inputTokens = estimateInputTokens(body);

  return {
    push(chunk) {
      remainder += decoder.decode(chunk, { stream: true });
      const events = [];
      let boundary;
      while ((boundary = remainder.indexOf("\n\n")) !== -1) {
        events.push(transformEvent(remainder.slice(0, boundary + 2)));
        remainder = remainder.slice(boundary + 2);
      }
      return encoder.encode(events.join(""));
    },
    finish() {
      const tail = remainder + decoder.decode();
      remainder = "";
      return encoder.encode(tail);
    },
  };

  function transformEvent(raw) {
    const parsed = parseEvent(raw);
    if (parsed === null) return raw;
    const { event, data } = parsed;
    if (event === "message_start") {
      gptResponse = /^gpt-/i.test(String(data?.message?.model ?? ""));
      if (!gptResponse) return raw;
      const message = data.message && typeof data.message === "object" ? data.message : (data.message = {});
      const usage = message.usage && typeof message.usage === "object" ? message.usage : (message.usage = {});
      if (!hasPromptUsage(usage) && inputTokens > 0) usage.input_tokens = inputTokens;
      return eventBytes(event, data);
    }
    if (!gptResponse) return raw;

    outputBytes += countOutput(data, event);
    if (event === "message_delta") {
      const usage = data.usage && typeof data.usage === "object" ? data.usage : (data.usage = {});
      if (!hasPositiveCounter(usage.output_tokens)) usage.output_tokens = tokensFromBytes(outputBytes);
      return eventBytes(event, data);
    }
    if (!Number.isInteger(data?.index)) return eventBytes(event, data);

    const originalIndex = data.index;
    if (event === "content_block_start" && isToolUse(data.content_block)) {
      const activity = eventBytes("content_block_start", {
        type: "content_block_start",
        index: originalIndex + indexShift,
        content_block: { type: "text", text: "" },
      }) + eventBytes("content_block_delta", {
        type: "content_block_delta",
        index: originalIndex + indexShift,
        delta: { type: "text_delta", text: `Running tool: ${data.content_block.name}` },
      }) + eventBytes("content_block_stop", {
        type: "content_block_stop",
        index: originalIndex + indexShift,
      });
      indexShift += 1;
      return activity + eventBytes(event, { ...data, index: originalIndex + indexShift });
    }
    return eventBytes(event, { ...data, index: originalIndex + indexShift });
  }
}

function hasPromptUsage(usage) {
  return [
    usage?.prompt_tokens,
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.prompt_cache_hit_tokens,
    usage?.prompt_cache_miss_tokens,
    usage?.input_tokens,
    usage?.cache_read_input_tokens,
    usage?.cache_creation_input_tokens,
  ].some((value) => hasPositiveCounter(value));
}

function hasPositiveCounter(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function estimateInputTokens(body) {
  if (Buffer.isBuffer(body)) return tokensFromBytes(body.byteLength);
  if (typeof body === "string") return tokensFromBytes(Buffer.byteLength(body, "utf8"));
  return 0;
}

function tokensFromBytes(bytes) {
  return Math.max(1, Math.min(1_000_000, Math.ceil(Math.max(0, bytes) / 4)));
}

function countOutput(data, event) {
  let bytes = 0;
  if (event === "content_block_start") {
    const block = data.content_block;
    if (typeof block?.text === "string") bytes += Buffer.byteLength(block.text, "utf8");
    if (block?.input !== undefined) bytes += Buffer.byteLength(JSON.stringify(block.input), "utf8");
    return bytes;
  }
  if (event !== "content_block_delta") return bytes;
  const delta = data.delta;
  for (const value of [delta?.text, delta?.thinking, delta?.partial_json]) {
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
  }
  return bytes;
}

function parseEvent(raw) {
  const event = raw.match(/^event: ([^\n]+)$/m)?.[1];
  const text = raw.match(/^data: (.+)$/m)?.[1];
  if (!event || !text) return null;
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return null;
  }
}

function eventBytes(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isToolUse(block) {
  return block?.type === "tool_use" && typeof block.name === "string" && block.name.length > 0;
}
