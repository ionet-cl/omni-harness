/**
 * Config — Carga unificada de configuración del bridge.
 *
 * Soporta: archivo JSON + variables de entorno + CLI args.
 * Las env vars tienen prioridad sobre el archivo de config.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULTS = {
  baseUrl: "https://opencode.ai/zen/go/v1",
  models: ["deepseek-v4-pro[1m]", "deepseek-v4-flash"],
  reasoningCachePath: path.join(os.homedir(), ".claude", "deepseek-v4-opencode-claude-code-bridge-reasoning-cache.json"),
  reasoningCacheMaxEntries: 0,
  reasoningCacheMaxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  reasoningCacheMaxSizeBytes: 200 * 1024 * 1024,     // 200 MB
  reasoningContent: "auto",
  requestBodyLimitBytes: 100 * 1024 * 1024,           // 100 MB
  upstreamTimeoutMs: 10 * 60 * 1000,                  // 10 min
  listenHost: "127.0.0.1",
  listenPort: 8787,
};

// ── Helpers ───────────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function argValue(name) {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) return process.argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveMaybeRelative(value, baseDir) {
  const expanded = expandHome(value);
  if (!expanded || path.isAbsolute(expanded)) return expanded;
  return path.resolve(baseDir, expanded);
}

function configValue(config, keys, fallback) {
  let cursor = config;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return fallback;
    cursor = cursor[key];
  }
  return cursor === undefined || cursor === null ? fallback : cursor;
}

function numberConfig(name, value, fallback, opts = {}) {
  const n = Number(value === undefined || value === null ? fallback : value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric config ${name}: ${JSON.stringify(value)}`);
  }
  if (opts.integer && !Number.isInteger(n)) {
    throw new Error(`Invalid integer config ${name}: ${JSON.stringify(value)}`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`Invalid config ${name}: ${n} is below ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`Invalid config ${name}: ${n} is above ${opts.max}`);
  }
  return n;
}

function envValue(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : fallback;
}

function normalizeBaseUrl(url) {
  if (!url || typeof url !== "string") return DEFAULTS.baseUrl;
  url = url.trim();
  if (!url) return DEFAULTS.baseUrl;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, "");
}

// ── Load ──────────────────────────────────────────────────────────

function loadConfig() {
  const defaultPath = path.join(__dirname, "..", "config.json");
  const configPath = process.env.CLAUDE_OPENCODE_PROXY_CONFIG || argValue("--config") || defaultPath;
  const resolvedPath = path.resolve(configPath);
  const fileConfig = readJson(resolvedPath) || {};
  const configDir = path.dirname(resolvedPath);
  const up = fileConfig.upstream || {};

  const models = Array.isArray(fileConfig.models) && fileConfig.models.length
    ? fileConfig.models
    : DEFAULTS.models;

  return {
    configPath: resolvedPath,
    models,
    listenHost: envValue("CLAUDE_OPENCODE_PROXY_HOST", configValue(fileConfig, ["listen", "host"], DEFAULTS.listenHost)),
    port: numberConfig("listen.port",
      envValue("CLAUDE_OPENCODE_PROXY_PORT", configValue(fileConfig, ["listen", "port"], DEFAULTS.listenPort)),
      DEFAULTS.listenPort, { integer: true, min: 1, max: 65535 }),
    upstreamBaseUrl: normalizeBaseUrl(
      envValue("CLAUDE_OPENCODE_PROXY_UPSTREAM_BASE_URL",
        configValue(fileConfig, ["upstream", "baseUrl"], DEFAULTS.baseUrl))),
    reasoningCachePath: resolveMaybeRelative(
      envValue("CLAUDE_OPENCODE_REASONING_CACHE",
        configValue(fileConfig, ["reasoningCachePath"], DEFAULTS.reasoningCachePath)), configDir),
    reasoningCacheMaxEntries: numberConfig("reasoningCacheMaxEntries",
      envValue("CLAUDE_OPENCODE_REASONING_CACHE_MAX_ENTRIES",
        configValue(fileConfig, ["reasoningCacheMaxEntries"], DEFAULTS.reasoningCacheMaxEntries)),
      DEFAULTS.reasoningCacheMaxEntries, { integer: true, min: 0 }),
    reasoningCacheMaxAgeMs: numberConfig("reasoningCacheMaxAgeMs",
      envValue("CLAUDE_OPENCODE_REASONING_CACHE_MAX_AGE_MS",
        configValue(fileConfig, ["reasoningCacheMaxAgeMs"], DEFAULTS.reasoningCacheMaxAgeMs)),
      DEFAULTS.reasoningCacheMaxAgeMs, { integer: true, min: 0 }),
    reasoningCacheMaxSizeBytes: numberConfig("reasoningCacheMaxSizeBytes",
      envValue("CLAUDE_OPENCODE_REASONING_CACHE_MAX_SIZE_BYTES",
        configValue(fileConfig, ["reasoningCacheMaxSizeBytes"], DEFAULTS.reasoningCacheMaxSizeBytes)),
      DEFAULTS.reasoningCacheMaxSizeBytes, { integer: true, min: 0 }),
    reasoningContentMode: envValue("CLAUDE_OPENCODE_REASONING_CONTENT",
      configValue(fileConfig, ["reasoningContent"], DEFAULTS.reasoningContent)),
    requestBodyLimitBytes: numberConfig("requestBodyLimitBytes",
      envValue("CLAUDE_OPENCODE_REQUEST_BODY_LIMIT_BYTES",
        configValue(fileConfig, ["requestBodyLimitBytes"], DEFAULTS.requestBodyLimitBytes)),
      DEFAULTS.requestBodyLimitBytes, { integer: true, min: 1 }),
    upstreamTimeoutMs: numberConfig("upstreamTimeoutMs",
      envValue("CLAUDE_OPENCODE_UPSTREAM_TIMEOUT_MS",
        configValue(fileConfig, ["upstreamTimeoutMs"], DEFAULTS.upstreamTimeoutMs)),
      DEFAULTS.upstreamTimeoutMs, { integer: true, min: 0 }),
  };
}

module.exports = { loadConfig, DEFAULTS };
