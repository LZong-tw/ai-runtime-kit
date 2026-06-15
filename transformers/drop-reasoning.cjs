const crypto = require("node:crypto");

class DropReasoningTransformer {
  constructor(options = {}) {
    this.name = "drop-reasoning";
    this.restoreModel = options.restoreModel || "claude-sonnet-4-6";
    this.providerToolNameByOriginal = new Map();
    this.originalToolNameByProvider = new Map();
  }

  async transformRequestIn(request) {
    if (!request || typeof request !== "object") return request;

    delete request.reasoning;
    delete request.thinking;
    delete request.enable_thinking;

    this.normalizeRequestToolNames(request);

    for (const message of request.messages ?? []) {
      if (message && typeof message === "object") {
        delete message.thinking;
        this.mapToolNamesIn(message);
      }
    }

    return request;
  }

  async transformResponseOut(response, context) {
    const contentType = response.headers?.get?.("Content-Type") || response.headers?.get?.("content-type") || "";
    const inputEstimate = this.estimateInputTokens(context);

    if (contentType.includes("application/json")) {
      const body = await response.json();
      this.maskModel(body);
      this.restoreProviderToolNames(body);
      this.normalizeContentBlocks(body);
      this.fillJsonUsage(body, inputEstimate);
      return new Response(JSON.stringify(body), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (contentType.includes("text/event-stream") && response.body) {
      return this.maskStreamingResponse(response, inputEstimate);
    }

    return response;
  }

  maskModel(payload) {
    if (payload && typeof payload === "object" && typeof payload.model === "string") {
      payload.model = this.restoreModel;
    }
    return payload;
  }

  tokensFromChars(chars) {
    return chars > 0 ? Math.ceil(chars / 4) : 0;
  }

  estimateInputTokens(context) {
    const body = context?.req?.body;
    if (!body || typeof body !== "object") return 0;
    let chars = 0;
    const add = (value) => {
      if (value == null) return;
      chars += typeof value === "string" ? value.length : JSON.stringify(value).length;
    };
    add(body.system);
    for (const message of body.messages ?? []) add(message?.content);
    if (Array.isArray(body.tools) && body.tools.length) add(body.tools);
    return this.tokensFromChars(chars);
  }

  isMissingTokenCount(value) {
    return typeof value !== "number" || !Number.isFinite(value) || value <= 0;
  }

  fillJsonUsage(payload, inputEstimate) {
    if (!payload || typeof payload !== "object") return payload;
    const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : (payload.usage = {});
    if (inputEstimate > 0 && this.isMissingTokenCount(usage.input_tokens)) usage.input_tokens = inputEstimate;
    if (this.isMissingTokenCount(usage.output_tokens)) {
      const outChars = this.outputCharsFromContent(payload.content);
      usage.output_tokens = Math.max(outChars > 0 ? 1 : 0, this.tokensFromChars(outChars));
    }
    return payload;
  }

  outputCharsFromContent(content) {
    if (!Array.isArray(content)) return 0;
    let chars = 0;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") chars += block.text.length;
      if (block.input != null) chars += JSON.stringify(block.input).length;
    }
    return chars;
  }

  fillStreamUsage(payload, state) {
    if (!payload || typeof payload !== "object") return payload;

    // OpenAI chat.completion.chunk path. The provider streams OpenAI events and CCR converts
    // them to Anthropic afterward, reading usage.prompt_tokens / usage.completion_tokens. Many
    // gateways omit usage from the stream entirely, so synthesize it on the final chunk.
    if (Array.isArray(payload.choices)) {
      const usage = payload.usage;
      const hasProviderUsage =
        usage && typeof usage === "object" &&
        (!this.isMissingTokenCount(usage.prompt_tokens) || !this.isMissingTokenCount(usage.completion_tokens));
      if (hasProviderUsage) {
        state.sawProviderUsage = true;
        return payload;
      }
      const finished = payload.choices.some((choice) => choice && choice.finish_reason != null);
      if (finished && !state.sawProviderUsage && state.inputEstimate > 0) {
        const completionTokens = Math.max(state.outputChars > 0 ? 1 : 0, this.tokensFromChars(state.outputChars));
        payload.usage = {
          prompt_tokens: state.inputEstimate,
          completion_tokens: completionTokens,
          total_tokens: state.inputEstimate + completionTokens,
        };
      }
      return payload;
    }

    const eventType = payload.type || state.currentEvent;
    if (eventType === "message_start" && payload.message && typeof payload.message === "object") {
      const usage = payload.message.usage && typeof payload.message.usage === "object" ? payload.message.usage : (payload.message.usage = {});
      if (state.inputEstimate > 0 && this.isMissingTokenCount(usage.input_tokens)) usage.input_tokens = state.inputEstimate;
      return payload;
    }
    if (eventType === "message_delta") {
      const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : (payload.usage = {});
      if (this.isMissingTokenCount(usage.output_tokens)) {
        usage.output_tokens = Math.max(state.outputChars > 0 ? 1 : 0, this.tokensFromChars(state.outputChars));
      }
    }
    return payload;
  }

  countStreamOutput(payload, state) {
    if (!payload || typeof payload !== "object") return;

    // OpenAI chat.completion.chunk: choices[].delta.content (and streamed tool-call arguments).
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        const delta = choice?.delta;
        if (!delta || typeof delta !== "object") continue;
        if (typeof delta.content === "string") state.outputChars += delta.content.length;
        for (const call of delta.tool_calls ?? []) {
          const args = call?.function?.arguments;
          if (typeof args === "string") state.outputChars += args.length;
        }
      }
      return;
    }

    // Anthropic streaming: content_block_delta.
    const eventType = payload.type || state.currentEvent;
    if (eventType !== "content_block_delta") return;
    const delta = payload.delta;
    if (!delta || typeof delta !== "object") return;
    if (typeof delta.text === "string") state.outputChars += delta.text.length;
    if (typeof delta.partial_json === "string") state.outputChars += delta.partial_json.length;
  }

  normalizeRequestToolNames(request) {
    if (Array.isArray(request.tools)) {
      for (const tool of request.tools) this.mapToolNamesIn(tool, { annotate: true });
    }
    if (Array.isArray(request.functions)) {
      for (const fn of request.functions) this.mapFunctionNameIn(fn, { annotate: true });
    }
    this.mapToolNamesIn(request.tool_choice);
    this.mapToolNamesIn(request.function_call);
  }

  mapToolNamesIn(value, options = {}) {
    if (!value || typeof value !== "object") return;
    this.mapFunctionNameIn(value.function, options);
    this.mapFunctionNameIn(value.function_call, options);
    if (typeof value.name === "string") value.name = this.providerToolName(value.name);
    for (const call of value.tool_calls ?? []) this.mapToolNamesIn(call, options);
  }

  mapFunctionNameIn(value, options = {}) {
    if (value && typeof value === "object" && typeof value.name === "string") {
      const original = value.name;
      const providerName = this.providerToolName(original);
      if (providerName !== original && options.annotate) this.annotateToolDescription(value, original);
      value.name = providerName;
    }
  }

  annotateToolDescription(fn, original) {
    const maxDescriptionLength = 1024;
    const note = "Original Claude Code tool name: " + original + ".";
    const description = typeof fn.description === "string" ? fn.description : "";
    if (description.includes(note)) {
      fn.description = description.slice(0, maxDescriptionLength);
      return;
    }

    const separator = description ? " " : "";
    const remaining = maxDescriptionLength - note.length - separator.length;
    fn.description = remaining > 0 ? note + separator + description.slice(0, remaining) : note.slice(0, maxDescriptionLength);
  }

  providerToolName(original) {
    if (this.isProviderSafeToolName(original)) return original;

    const existing = this.providerToolNameByOriginal.get(original);
    if (existing) return existing;

    const parts = original.split("__").filter(Boolean);
    const readable = (parts[parts.length - 1] || original)
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
    const hash = crypto.createHash("sha1").update(original).digest("hex").slice(0, 10);
    const prefix = "airtool_";
    const suffix = "_" + hash;
    const maxReadable = 64 - prefix.length - suffix.length;
    const base = (readable || "tool").slice(0, maxReadable).replace(/_+$/g, "") || "tool";
    const candidate = prefix + base + suffix;

    this.providerToolNameByOriginal.set(original, candidate);
    this.originalToolNameByProvider.set(candidate, original);
    return candidate;
  }

  isProviderSafeToolName(name) {
    return typeof name === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  }

  restoreProviderToolNames(payload) {
    if (!payload || typeof payload !== "object") return payload;
    this.mapToolNamesOut(payload);
    for (const choice of payload.choices ?? []) {
      this.mapToolNamesOut(choice?.message);
      this.mapToolNamesOut(choice?.delta);
    }
    return payload;
  }

  mapToolNamesOut(value) {
    if (!value || typeof value !== "object") return;
    this.restoreFunctionName(value.function);
    this.restoreFunctionName(value.function_call);
    if (typeof value.name === "string") value.name = this.originalToolName(value.name);
    for (const call of value.tool_calls ?? []) this.mapToolNamesOut(call);
  }

  restoreFunctionName(value) {
    if (value && typeof value === "object" && typeof value.name === "string") {
      value.name = this.originalToolName(value.name);
    }
  }

  originalToolName(providerName) {
    return this.originalToolNameByProvider.get(providerName) || providerName;
  }

  normalizeContentBlocks(payload) {
    if (!payload || typeof payload !== "object") return payload;

    if (Array.isArray(payload.content)) {
      payload.content = payload.content.map((block) => this.normalizeContentBlock(block));
    }

    for (const choice of payload.choices ?? []) {
      const message = choice?.message;
      if (message && Array.isArray(message.content)) {
        message.content = message.content.map((block) => this.normalizeContentBlock(block));
      }
      if (message && typeof message.reasoning_content === "string") delete message.reasoning_content;
      const delta = choice?.delta;
      if (delta && typeof delta.reasoning_content === "string") delete delta.reasoning_content;
    }

    return payload;
  }

  normalizeContentBlock(block) {
    if (!block || typeof block !== "object") return block;
    if (!this.isReasoningBlockType(block.type)) return block;
    return { type: "text", text: "[reasoning omitted]" };
  }

  isReasoningBlockType(type) {
    return type === "thinking" || type === "redacted_thinking";
  }

  isReasoningDeltaType(type) {
    return type === "thinking_delta" || type === "redacted_thinking_delta" || type === "signature_delta";
  }

  maskStreamingResponse(response, inputEstimate = 0) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const state = {
      currentEvent: "",
      reasoningIndexes: new Set(),
      noticeIndexes: new Set(),
      inputEstimate,
      outputChars: 0,
      sawProviderUsage: false,
    };
    const rewriteLine = (line) => this.rewriteSseLine(line, state);
    let buffer = "";

    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) controller.enqueue(encoder.encode(rewriteLine(line) + "\n"));
          }
          buffer += decoder.decode();
          if (buffer) controller.enqueue(encoder.encode(rewriteLine(buffer)));
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  rewriteSseLine(line, state = {}) {
    if (line.startsWith("event: ")) {
      state.currentEvent = line.slice(7).trim();
      return line;
    }
    if (!line.startsWith("data: ")) return line;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") return line;

    try {
      const payload = JSON.parse(data);
      this.maskModel(payload);
      this.restoreProviderToolNames(payload);
      this.normalizeSsePayload(payload, state);
      this.countStreamOutput(payload, state);
      this.fillStreamUsage(payload, state);
      return "data: " + JSON.stringify(payload);
    } catch {
      return line;
    }
  }

  normalizeSsePayload(payload, state) {
    if (!payload || typeof payload !== "object") return payload;

    const eventType = payload.type || state.currentEvent;
    if (eventType === "content_block_start" && this.isReasoningBlockType(payload.content_block?.type)) {
      state.reasoningIndexes.add(payload.index);
      payload.content_block = { type: "text", text: "" };
      return payload;
    }

    if (
      eventType === "content_block_delta" &&
      state.reasoningIndexes.has(payload.index) &&
      this.isReasoningDeltaType(payload.delta?.type)
    ) {
      const text = state.noticeIndexes.has(payload.index) ? "" : "[reasoning omitted]";
      state.noticeIndexes.add(payload.index);
      payload.delta = { type: "text_delta", text };
      return payload;
    }

    if (eventType === "content_block_stop" && state.reasoningIndexes.has(payload.index)) {
      state.reasoningIndexes.delete(payload.index);
      state.noticeIndexes.delete(payload.index);
    }

    return payload;
  }
}

module.exports = DropReasoningTransformer;
