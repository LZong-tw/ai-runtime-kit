const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function createGptActivitySseTransform() {
  let remainder = "";
  let gptResponse = false;
  let indexShift = 0;

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
      return raw;
    }
    if (!gptResponse || !Number.isInteger(data?.index)) return raw;

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
