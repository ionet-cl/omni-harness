/**
 * Reasoning Cache — Caché persistente de reasoning_content de DeepSeek V4.
 *
 * Tres buckets de caché:
 *   - toolCallReasoning:   reasoning asociado a tool_call por ID
 *   - assistantTextReasoning: reasoning asociado a texto de assistant
 *   - toolContextReasoning: reasoning asociado a contexto de herramientas
 *
 * Persiste en disco como JSON con version stamp.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── Estado interno ────────────────────────────────────────────────

const reasoningByToolCallId = new Map();
const reasoningByAssistantText = new Map();
const reasoningByToolContext = new Map();
let reasoningCacheDirty = false;
let saveReasoningTimer = null;

// El CONFIG se setea externamente después de cargar config
let CONFIG = null;

function setConfig(cfg) {
  CONFIG = cfg;
}

// ── Helpers ───────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function sha256(text) {
  return crypto.createHash("sha256").update(text || "", "utf8").digest("hex");
}

function cacheFileMtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; }
  catch { return Date.now(); }
}

function normalizeReasoningEntry(value, fallbackUpdatedAt = Date.now()) {
  if (typeof value === "string") {
    return { reasoning: value, updatedAt: fallbackUpdatedAt };
  }
  if (!value || typeof value !== "object" || typeof value.reasoning !== "string") return null;
  const updatedAt = Number(value.updatedAt);
  return {
    reasoning: value.reasoning,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : fallbackUpdatedAt,
  };
}

function isReasoningEntryExpired(entry, now = Date.now()) {
  const maxAgeMs = CONFIG.reasoningCacheMaxAgeMs;
  return Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - entry.updatedAt > maxAgeMs;
}

function trimMap(map) {
  const maxEntries = CONFIG.reasoningCacheMaxEntries;
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return;
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function trimExpiredMap(map, now) {
  for (const [key, entry] of map.entries()) {
    if (isReasoningEntryExpired(entry, now)) map.delete(key);
  }
}

// ── Persistencia ──────────────────────────────────────────────────

function reasoningCachePayloadObject() {
  return {
    version: 2,
    note: "DeepSeek V4 reasoning_content cache for the OpenCode Go Claude Code bridge.",
    updatedAt: Date.now(),
    maxEntriesPerBucket: CONFIG.reasoningCacheMaxEntries,
    maxAgeMs: CONFIG.reasoningCacheMaxAgeMs,
    maxSizeBytes: CONFIG.reasoningCacheMaxSizeBytes,
    toolCallReasoning: Object.fromEntries(reasoningByToolCallId.entries()),
    assistantTextReasoning: Object.fromEntries(reasoningByAssistantText.entries()),
    toolContextReasoning: Object.fromEntries(reasoningByToolContext.entries()),
  };
}

function reasoningCachePayload() {
  trimReasoningCaches();
  return reasoningCachePayloadObject();
}

function reasoningCacheSerializedSize() {
  return Buffer.byteLength(JSON.stringify(reasoningCachePayloadObject()), "utf8");
}

function deleteOldestReasoningEntry() {
  const candidates = [
    { name: "tool", map: reasoningByToolCallId },
    { name: "assistant", map: reasoningByAssistantText },
    { name: "context", map: reasoningByToolContext },
  ];
  let oldest = null;
  for (const candidate of candidates) {
    for (const [key, entry] of candidate.map.entries()) {
      if (!oldest || entry.updatedAt < oldest.entry.updatedAt) {
        oldest = { ...candidate, key, entry };
      }
    }
  }
  if (!oldest) return false;
  oldest.map.delete(oldest.key);
  return true;
}

function trimReasoningCacheSize() {
  const maxSizeBytes = CONFIG.reasoningCacheMaxSizeBytes;
  if (!Number.isFinite(maxSizeBytes) || maxSizeBytes <= 0) return;
  while (reasoningCacheSerializedSize() > maxSizeBytes) {
    if (!deleteOldestReasoningEntry()) return;
  }
}

function trimReasoningCaches() {
  const now = Date.now();
  trimExpiredMap(reasoningByToolCallId, now);
  trimExpiredMap(reasoningByAssistantText, now);
  trimExpiredMap(reasoningByToolContext, now);
  trimMap(reasoningByToolCallId);
  trimMap(reasoningByAssistantText);
  trimMap(reasoningByToolContext);
  trimReasoningCacheSize();
}

// ── API pública ───────────────────────────────────────────────────

function loadReasoningCache() {
  const cache = readJson(CONFIG.reasoningCachePath);
  if (!cache || typeof cache !== "object") return;
  const fallbackUpdatedAt = Number.isFinite(Number(cache.updatedAt))
    ? Number(cache.updatedAt)
    : cacheFileMtimeMs(CONFIG.reasoningCachePath);

  for (const [id, value] of Object.entries(cache.toolCallReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof id === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByToolCallId, id, entry, { touch: false });
    }
  }
  for (const [hash, value] of Object.entries(cache.assistantTextReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof hash === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByAssistantText, hash, entry, { touch: false });
    }
  }
  for (const [hash, value] of Object.entries(cache.toolContextReasoning || {})) {
    const entry = normalizeReasoningEntry(value, fallbackUpdatedAt);
    if (typeof hash === "string" && entry && !isReasoningEntryExpired(entry)) {
      setMapRecent(reasoningByToolContext, hash, entry, { touch: false });
    }
  }
  trimReasoningCaches();
}

function saveReasoningCacheNow() {
  try {
    const data = JSON.stringify(reasoningCachePayload(), null, 2);
    const tmp = `${CONFIG.reasoningCachePath}.tmp`;
    fs.mkdirSync(path.dirname(CONFIG.reasoningCachePath), { recursive: true });
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, CONFIG.reasoningCachePath);
    reasoningCacheDirty = false;
    return true;
  } catch (error) {
    console.error(`Failed to save reasoning cache: ${error.message}`);
    return false;
  }
}

function flushReasoningCache() {
  if (saveReasoningTimer) {
    clearTimeout(saveReasoningTimer);
    saveReasoningTimer = null;
  }
  if (reasoningCacheDirty) saveReasoningCacheNow();
}

function scheduleSaveReasoningCache() {
  reasoningCacheDirty = true;
  if (saveReasoningTimer) return;
  saveReasoningTimer = setTimeout(() => {
    saveReasoningTimer = null;
    saveReasoningCacheNow();
  }, 100);
}

function setMapRecent(map, key, value, options = {}) {
  const entry = normalizeReasoningEntry(value);
  if (!entry) return;
  if (options.touch !== false) entry.updatedAt = Date.now();
  if (map.has(key)) map.delete(key);
  map.set(key, entry);
  trimMap(map);
}

function getMapRecent(map, key) {
  if (!map.has(key)) return null;
  const entry = map.get(key);
  if (isReasoningEntryExpired(entry)) {
    map.delete(key);
    scheduleSaveReasoningCache();
    return null;
  }
  setMapRecent(map, key, entry);
  return entry.reasoning;
}

// ── Reasoning: tool call ──────────────────────────────────────────

function setToolReasoning(id, reasoning) {
  if (!id || !reasoning) return;
  setMapRecent(reasoningByToolCallId, id, reasoning);
  scheduleSaveReasoningCache();
}

function getToolReasoning(id) {
  if (!id) return null;
  return getMapRecent(reasoningByToolCallId, id);
}

// ── Reasoning: assistant text ─────────────────────────────────────

function getAssistantReasoning(text) {
  return getMapRecent(reasoningByAssistantText, sha256(text));
}

function setAssistantReasoning(text, reasoning) {
  if (!text || !reasoning) return;
  setMapRecent(reasoningByAssistantText, sha256(text), reasoning);
  scheduleSaveReasoningCache();
}

// ── Reasoning: tool context ───────────────────────────────────────

function toolUseSignature(tool) {
  return `tool_use:${tool.id || ""}:${tool.name || ""}:${JSON.stringify(tool.input || {})}`;
}

function toolResultSignature(result) {
  return `tool_result:${result.tool_use_id || result.id || ""}:${stringifyToolResultContent(result.content)}`;
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && b.text ? b.text : JSON.stringify(b)))
      .join("\n");
  }
  return JSON.stringify(content || "");
}

function toolContextKey(parts, assistantText) {
  if (!parts || !parts.length || !assistantText) return null;
  return sha256(`${parts.join("\n")}\nassistant:${assistantText}`);
}

function getToolContextReasoning(parts, assistantText) {
  const key = toolContextKey(parts, assistantText);
  return key ? getMapRecent(reasoningByToolContext, key) : null;
}

function setToolContextReasoning(parts, assistantText, reasoning) {
  const key = toolContextKey(parts, assistantText);
  if (!key || !reasoning) return;
  setMapRecent(reasoningByToolContext, key, reasoning);
  scheduleSaveReasoningCache();
}

function currentToolContextParts(messages) {
  let hadToolCall = false;
  let parts = [];

  for (const msg of messages || []) {
    const blocks = Array.isArray(msg && msg.content) ? msg.content : [];
    const text = typeof (msg && msg.content) === "string"
      ? msg.content
      : blocks
          .filter((block) => block && block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n");
    const toolResults = blocks.filter((block) => block && block.type === "tool_result");
    const toolUses = blocks.filter((block) => block && block.type === "tool_use");

    if (msg && msg.role === "user") {
      if (!toolResults.length && text) {
        hadToolCall = false;
        parts = [];
      }
      for (const result of toolResults) {
        if (hadToolCall) parts.push(toolResultSignature(result));
      }
      if (text) parts.push(`USER: ${text}`);
    } else if (msg && msg.role === "assistant") {
      if (text) parts.push(`ASSISTANT: ${text}`);
      for (const toolUse of toolUses) {
        parts.push(toolUseSignature(toolUse));
        hadToolCall = true;
      }
    }
  }
  return hadToolCall ? parts : [];
}

module.exports = {
  setConfig,
  loadReasoningCache,
  saveReasoningCacheNow,
  flushReasoningCache,
  scheduleSaveReasoningCache,
  setToolReasoning,
  getToolReasoning,
  getAssistantReasoning,
  setAssistantReasoning,
  getToolContextReasoning,
  setToolContextReasoning,
  currentToolContextParts,
  toolUseSignature,
  toolResultSignature,
  reasoningCachePayload,
  // Exports for testing
  reasoningByToolCallId,
  reasoningByAssistantText,
  reasoningByToolContext,
};
