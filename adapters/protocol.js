/**
 * Protocol Adapters — Traducción de schemas Anthropic ↔ OpenAI
 *
 * Convierte requests Anthropic (Claude Code) a formato OpenAI (DeepSeek/OpenCode)
 * y respuestas OpenAI de vuelta a formato Anthropic.
 *
 * Dependencias inyectadas (para testabilidad):
 *   deps.cache.getToolReasoning(id)
 *   deps.cache.setToolReasoning(id, reasoning)
 *   deps.cache.getAssistantReasoning(text)
 *   deps.cache.setAssistantReasoning(text, reasoning)
 *   deps.cache.getToolContextReasoning(parts, text)
 *   deps.cache.setToolContextReasoning(parts, text, reasoning)
 *   deps.cache.currentToolContextParts(messages)
 *   deps.cache.toolUseSignature(tool)
 *   deps.cache.toolResultSignature(result)
 *   deps.config           — CONFIG object
 *   deps.placeholderReasoning — string
 *   deps.warnedFinishReasons — Set
 *   deps.CHAT_COMPLETIONS_RESPONSE_HEADERS — string[]
 */

let CACHE, CONFIG, PLACEHOLDER_REASONING, warnedFinishReasons, CHAT_COMPLETIONS_RESPONSE_HEADERS;

function init(deps) {
  CACHE = deps.cache;
  CONFIG = deps.config;
  PLACEHOLDER_REASONING = deps.placeholderReasoning || "";
  warnedFinishReasons = deps.warnedFinishReasons || new Set();
  CHAT_COMPLETIONS_RESPONSE_HEADERS = deps.CHAT_COMPLETIONS_RESPONSE_HEADERS || ["content-type", "cache-control"];
}

// ── Helpers ───────────────────────────────────────────────────────

function textFromAnthropicContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function thinkingFromAnthropicContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking)
    .filter(Boolean)
    .join("\n");
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((b) => {
      if (!b) return "";
      if (b.type === "text") return b.text || "";
      return JSON.stringify(b);
    })
    .filter(Boolean)
    .join("\n");
}

function systemToOpenAi(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return textFromAnthropicContent(system);
  return String(system);
}

function shouldSendReasoningContent(model) {
  const mode = String(CONFIG.reasoningContentMode || "auto").toLowerCase();
  if (["always", "true", "on"].includes(mode)) return true;
  if (["never", "false", "off", "none"].includes(mode)) return false;
  return isDeepSeekModel(model);
}

function isDeepSeekModel(model) {
  return typeof model === "string" && /(^|[-_/])deepseek/i.test(model);
}

// ── Anthropic → OpenAI ────────────────────────────────────────────

function mergeAssistantContent(left, right) {
  const parts = [];
  if (typeof left === "string" && left) parts.push(left);
  if (typeof right === "string" && right) parts.push(right);
  return parts.length ? parts.join("\n") : null;
}

function coalesceAdjacentAssistantToolCalls(messages) {
  const out = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && msg && prev.role === "assistant" && msg.role === "assistant" &&
        Array.isArray(prev.tool_calls) && prev.tool_calls.length &&
        Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      prev.content = mergeAssistantContent(prev.content, msg.content);
      prev.tool_calls.push(...msg.tool_calls);
      if (msg.reasoning_content) {
        prev.reasoning_content = [prev.reasoning_content, msg.reasoning_content]
          .filter(Boolean).join("\n");
      }
      continue;
    }
    out.push(msg);
  }
  return out;
}

function assistantWithoutToolCalls(message) {
  if (!message || message.role !== "assistant") return null;
  const out = { ...message };
  delete out.tool_calls;
  return (out.content === null || out.content === undefined || out.content === "") ? null : out;
}

function orphanToolMessageToUser(message) {
  if (!message || message.role !== "tool") return null;
  const id = message.tool_call_id || "unknown";
  const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
  return { role: "user", content: `Tool result without a matching tool call (${id}):\n${content}` };
}

function sanitizeOpenAiToolMessageSequence(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const toolCalls = Array.isArray(message && message.tool_calls) ? message.tool_calls : [];
    if (message && message.role === "assistant" && toolCalls.length) {
      const toolMessages = [];
      let j = i + 1;
      while (j < messages.length && messages[j] && messages[j].role === "tool") {
        toolMessages.push(messages[j]);
        j += 1;
      }
      if (!toolMessages.length && j === messages.length) { out.push(message); continue; }
      const expectedIds = new Set(toolCalls.map((c) => c && c.id).filter(Boolean));
      const toolById = new Map();
      const orphanTools = [];
      for (const tm of toolMessages) {
        (expectedIds.has(tm.tool_call_id) && !toolById.has(tm.tool_call_id))
          ? toolById.set(tm.tool_call_id, tm)
          : orphanTools.push(tm);
      }
      const fulfilledCalls = toolCalls.filter((c) => c && toolById.has(c.id));
      if (fulfilledCalls.length) {
        out.push({ ...message, tool_calls: fulfilledCalls });
        for (const call of fulfilledCalls) out.push(toolById.get(call.id));
      } else {
        const fb = assistantWithoutToolCalls(message);
        if (fb) out.push(fb);
      }
      for (const orphan of orphanTools) {
        const um = orphanToolMessageToUser(orphan);
        if (um) out.push(um);
      }
      i = j - 1;
      continue;
    }
    if (message && message.role === "tool") {
      const um = orphanToolMessageToUser(message);
      if (um) out.push(um);
      continue;
    }
    out.push(message);
  }
  return out;
}

function anthropicMessagesToOpenAi(messages, includeReasoningContent) {
  const out = [];
  let currentUserTurnHadToolCall = false;
  let currentToolContext = [];

  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;
    if (typeof msg.content === "string") {
      if (msg.role === "user") currentUserTurnHadToolCall = false;
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = textFromAnthropicContent(blocks);
    const thinking = thinkingFromAnthropicContent(blocks);
    const toolResults = blocks.filter((b) => b && b.type === "tool_result");
    const toolUses = blocks.filter((b) => b && b.type === "tool_use");

    if (msg.role === "user") {
      if (toolResults.length) {
        for (const result of toolResults) {
          if (currentUserTurnHadToolCall) currentToolContext.push(CACHE.toolResultSignature(result));
          out.push({ role: "tool", tool_call_id: result.tool_use_id || result.id || "call_unknown",
            content: stringifyToolResultContent(result.content) });
        }
        if (text) { currentUserTurnHadToolCall = false; currentToolContext = []; out.push({ role: "user", content: text }); }
      } else {
        currentUserTurnHadToolCall = false; currentToolContext = [];
        if (text) out.push({ role: "user", content: text });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const assistant = { role: "assistant", content: text || null };
      if (toolUses.length) {
        currentUserTurnHadToolCall = true;
        currentToolContext = toolUses.map(CACHE.toolUseSignature);
        assistant.tool_calls = toolUses.map((tool, idx) => ({
          id: tool.id || `call_${idx}`, type: "function",
          function: { name: tool.name, arguments: JSON.stringify(tool.input || {}) },
        }));
        if (includeReasoningContent) {
          const reasoning = toolUses.map((t) => CACHE.getToolReasoning(t.id)).filter(Boolean).join("\n");
          assistant.reasoning_content = thinking || reasoning || PLACEHOLDER_REASONING;
        }
      } else if (text && currentUserTurnHadToolCall) {
        if (includeReasoningContent) {
          assistant.reasoning_content = thinking ||
            CACHE.getToolContextReasoning(currentToolContext, text) ||
            CACHE.getAssistantReasoning(text) || PLACEHOLDER_REASONING;
        }
      }
      out.push(assistant);
      continue;
    }
    out.push({ role: msg.role, content: text });
  }
  return sanitizeOpenAiToolMessageSequence(coalesceAdjacentAssistantToolCalls(out));
}

function anthropicToolsToOpenAi(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.filter((t) => t && t.name).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } },
  }));
}

function anthropicToolChoiceToOpenAi(choice, model) {
  if (!choice || typeof choice !== "object") return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "none") return "none";
  if (isDeepSeekModel(model)) return undefined;
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return undefined;
}

function toolChoiceInstruction(choice, model) {
  if (!choice || typeof choice !== "object" || !isDeepSeekModel(model)) return null;
  if (choice.type === "any") return "The caller requires a tool call for this turn. Call one of the available tools instead of answering directly.";
  if (choice.type === "tool" && choice.name) return `The caller requires a tool call for this turn. Call the available tool named ${JSON.stringify(choice.name)} instead of answering directly.`;
  return null;
}

function thinkingToOpenAi(thinking) {
  if (!thinking || typeof thinking !== "object") return undefined;
  return (thinking.type === "enabled" || thinking.type === "disabled") ? { type: thinking.type } : undefined;
}

function reasoningEffortToOpenAi(outputConfig) {
  const effort = outputConfig && typeof outputConfig === "object" ? outputConfig.effort : undefined;
  if (typeof effort !== "string") return undefined;
  const n = effort.toLowerCase();
  if (n === "max" || n === "xhigh") return "max";
  if (["high", "medium", "low"].includes(n)) return "high";
  return undefined;
}

function sanitizeModelName(model) {
  return typeof model === "string" ? model.replace(/\[.*?\]/g, "").trim() || model : model;
}

function anthropicToOpenAi(body, stream) {
  const messages = [];
  const cleanModel = sanitizeModelName(body.model);
  const sd = isDeepSeekModel(cleanModel);
  const extraSystem = toolChoiceInstruction(body.tool_choice, cleanModel);
  const system = [systemToOpenAi(body.system), extraSystem].filter(Boolean).join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  messages.push(...anthropicMessagesToOpenAi(body.messages, shouldSendReasoningContent(cleanModel)));
  const payload = {
    model: cleanModel, messages, stream,
    max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p,
    stop: body.stop_sequences,
    tools: anthropicToolsToOpenAi(body.tools),
    tool_choice: anthropicToolChoiceToOpenAi(body.tool_choice, cleanModel),
    thinking: sd ? thinkingToOpenAi(body.thinking) : undefined,
    reasoning_effort: sd ? reasoningEffortToOpenAi(body.output_config) : undefined,
    stream_options: stream ? { include_usage: true } : undefined,
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === null) delete payload[key];
  }
  if (Array.isArray(payload.tools) && payload.tools.length === 0) delete payload.tools;
  return payload;
}

// ── OpenAI → Anthropic ────────────────────────────────────────────

function parseJsonObject(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function reasoningFromMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.reasoning_content === "string") return message.reasoning_content;
  if (typeof message.reasoning === "string") return message.reasoning;
  if (message.reasoning && typeof message.reasoning.content === "string") return message.reasoning.content;
  if (typeof message.thinking === "string") return message.thinking;
  if (message.thinking && typeof message.thinking.content === "string") return message.thinking.content;
  return "";
}

function thinkingContentBlock(reasoning) {
  return { type: "thinking", thinking: reasoning, signature: "" };
}

function mapFinishReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  if (reason && !warnedFinishReasons.has(reason)) {
    warnedFinishReasons.add(reason);
    console.warn(`Unknown upstream finish_reason: ${reason}`);
  }
  return reason || "end_turn";
}

function openAiToAnthropic(body, originalModel, toolContextParts = []) {
  const out = { id: body.id || "", type: "message", role: "assistant", content: [], model: originalModel || body.model || "" };
  const choice = body.choices && body.choices[0];
  if (choice) {
    const delta = choice.delta || choice.message || {};
    const reasoning = reasoningFromMessage(delta);
    if (reasoning) {
      out.content.push(thinkingContentBlock(reasoning));
      if (toolContextParts && toolContextParts.length) {
        CACHE.setToolContextReasoning(toolContextParts, delta.content || "", reasoning);
      } else if (delta.content) {
        CACHE.setAssistantReasoning(delta.content, reasoning);
      }
    }
    if (delta.content) out.content.push({ type: "text", text: delta.content });
    const toolCalls = delta.tool_calls || [];
    for (const tc of toolCalls) {
      if (tc && tc.function) {
        const toolId = tc.id || "";
        const func = tc.function;
        const input = parseJsonObject(func.arguments);
        out.content.push({ type: "tool_use", id: toolId, name: func.name, input });
        if (reasoning) CACHE.setToolReasoning(toolId, reasoning);
      }
    }
    if (choice.finish_reason) out.stop_reason = mapFinishReason(choice.finish_reason);
    if (choice.stop_reason) out.stop_reason = mapFinishReason(choice.stop_reason);
    out.stop_sequence = choice.stop_sequence || null;
  }
  out.usage = openAiUsageToAnthropic(body.usage);
  return out;
}

function openAiUsageToAnthropic(usage) {
  if (!usage || typeof usage !== "object") return { input_tokens: 0, output_tokens: 0 };
  const out = {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
  };
  if (usage.prompt_cache_hit_tokens) out.cache_read_input_tokens = usage.prompt_cache_hit_tokens;
  if (usage.prompt_cache_miss_tokens) out.cache_creation_input_tokens = usage.prompt_cache_miss_tokens;
  return out;
}

// ── Stream handler ────────────────────────────────────────────────

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseOpenAiChunkAsAnthropic(res, chunk, model) {
  if (!chunk || !chunk.choices || !chunk.choices.length) return;
  const choice = chunk.choices[0];
  const delta = choice.delta || {};
  const index = choice.index || 0;

  if (choice.finish_reason === "tool_calls") {
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
    });
    return;
  }

  if (choice.finish_reason && choice.finish_reason !== "tool_calls") {
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    sse(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapFinishReason(choice.finish_reason), stop_sequence: null },
    });
    return;
  }

  if (delta.reasoning_content) {
    sse(res, "content_block_start", {
      type: "content_block_start", index,
      content_block: { type: "thinking", thinking: delta.reasoning_content, signature: "" },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta", index,
      delta: { type: "thinking", thinking: delta.reasoning_content },
    });
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    return;
  }

  if (delta.content) {
    sse(res, "content_block_start", {
      type: "content_block_start", index,
      content_block: { type: "text", text: delta.content },
    });
    sse(res, "content_block_delta", {
      type: "content_block_delta", index,
      delta: { type: "text", text: delta.content },
    });
    return;
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc && tc.function) {
        sse(res, "content_block_start", {
          type: "content_block_start", index,
          content_block: { type: "tool_use", id: tc.id || "", name: tc.function.name || "", input: parseJsonObject(tc.function.arguments || "{}") },
        });
        if (tc.function.arguments) {
          sse(res, "content_block_delta", {
            type: "content_block_delta", index,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments },
          });
        }
        sse(res, "content_block_stop", { type: "content_block_stop", index });
      }
    }
    return;
  }
}

function openAiToAnthropicStreamStart(res, model, usage) {
  const body = { type: "message_start", message: {
    id: "", type: "message", role: "assistant",
    content: [], model: model || "",
    stop_reason: null, stop_sequence: null,
    usage: openAiUsageToAnthropic(usage),
  }};
  sse(res, "message_start", body.message);
  sse(res, "ping", { type: "ping" });
}

function openAiToAnthropicStreamEnd(res, usage) {
  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: openAiUsageToAnthropic(usage),
  });
  sse(res, "message_stop", { type: "message_stop" });
}

async function streamOpenAiAsAnthropic(upstream, res, model, toolContextParts = [], upstreamContext = null, inputTokens = 0) {
  const decoder = new TextDecoder();
  let buffer = "";
  let pingSent = false;
  let usageSent = false;
  let usage = {};

  // Anthropic-style SSE preamble
  openAiToAnthropicStreamStart(res, model, usage);

  const processLine = (line) => {
    if (!line || line.startsWith(":")) return;
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;

      let chunk;
      try { chunk = JSON.parse(data); } catch { return; }

      if (!pingSent) {
        sse(res, "ping", { type: "ping" });
        pingSent = true;
      }

      if (chunk.usage) { usage = chunk.usage; usageSent = true; }

      if (upstreamContext && upstreamContext.signal.aborted) {
        if (processLine._cleanup) processLine._cleanup();
        return;
      }

      sseOpenAiChunkAsAnthropic(res, chunk, model);
    }
  };

  processLine._cleanup = () => { /* stream ended */ };

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    }
  } catch (error) {
    // Stream interrupted (e.g. upstream error or client disconnect)
    if (!res.writableEnded) {
      processLine(`data: {"choices":[{"finish_reason":"stop","delta":{},"index":0}]}`);
      try { openAiToAnthropicStreamEnd(res, usage); } catch {}
    }
    console.warn(`[Protocol] Stream interrupted: ${error.message}`);
    return;
  }

  if (buffer.trim()) processLine(buffer.trim());

  openAiToAnthropicStreamEnd(res, usage);

  if (upstreamContext) upstreamContext.cleanup();
}

// ── Exports ───────────────────────────────────────────────────────

module.exports = {
  init,
  // Anthropic → OpenAI
  anthropicMessagesToOpenAi,
  anthropicToolsToOpenAi,
  anthropicToolChoiceToOpenAi,
  anthropicToOpenAi,
  // OpenAI → Anthropic
  openAiToAnthropic,
  openAiUsageToAnthropic,
  reasoningFromMessage,
  mapFinishReason,
  // Streaming
  streamOpenAiAsAnthropic,
  openAiToAnthropicStreamStart,
  openAiToAnthropicStreamEnd,
  // Helpers
  isDeepSeekModel,
  sanitizeModelName,
  parseJsonObject,
  systemToOpenAi,
  stringifyToolResultContent,
};
