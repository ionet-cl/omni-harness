/**
 * index.js — Entry point modular del bridge.
 *
 * Carga tracing, config, cache, y arranca el servidor HTTP
 * envuelto en trazabilidad OpenTelemetry.
 *
 * Uso: node index.js [--config ./config.json]
 */

// Cargar tracing ANTES que cualquier otro módulo (requisito de OTel)
require("./observability/tracing.js");

const { loadConfig } = require("./config/index.js");
const reasoningCache = require("./cache/reasoning-cache.js");
const { withTrace } = require("./middleware/trace.js");
const http = require("http");

// 1. Cargar configuración
const CONFIG = loadConfig();

// 2. Inicializar caché de razonamiento
reasoningCache.setConfig(CONFIG);
reasoningCache.loadReasoningCache();

// 3. Cargar server.js
const serverModule = require("./server.js");

// 4. Envolver createServer con tracing OTel
//    Necesitamos interceptar el handler interno para agregar spans.
//    La estrategia: crear un server, envolver el event listener 'request'.
const originalCreateServer = serverModule.createServer;

// Wrapper: intercepta internamente la creación del handler HTTP
// para envolverlo con withTrace. Hacemos monkey-patch a http.createServer
// temporalmente para capturar el handler antes de que se conecte al server.
function createServerWithTrace() {
  console.error('[index] createServerWithTrace llamado');
  const originalHttpCreateServer = http.createServer;
  let capturedHandler = null;

  // Interceptar http.createServer para capturar el handler
  http.createServer = function (handler) {
    console.error('[index] http.createServer interceptado! type:', typeof handler);
    capturedHandler = withTrace(handler);
    const server = originalHttpCreateServer(capturedHandler);
    http.createServer = originalHttpCreateServer; // restaurar
    return server;
  };

  const server = originalCreateServer();

  // Restaurar por si acaso
  http.createServer = originalHttpCreateServer;

  return server;
}

// Reemplazar createServer con nuestra versión
serverModule.createServer = createServerWithTrace;

// Reemplazar startServer para que use nuestro createServer
const originalStartServer = serverModule.startServer;
serverModule.startServer = function () {
  // loadReasoningCache ya fue llamado arriba
  const server = createServerWithTrace();
  server.listen(CONFIG.port, CONFIG.listenHost, () => {
    console.log(`DeepSeek V4 OpenCode Claude Code bridge listening on http://${CONFIG.listenHost}:${CONFIG.port}`);
    console.log(`Config: ${CONFIG.configPath}`);
    console.log(`Upstream: ${CONFIG.upstreamBaseUrl}/chat/completions`);
  });
  return server;
};

// 5. Arrancar
serverModule.startServer();

// ── Shutdown handlers ─────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[Bridge] ${signal}: flusheando cache y cerrando.`);
  reasoningCache.flushReasoningCache();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
  console.error("[Bridge] Uncaught exception:", error);
  reasoningCache.flushReasoningCache();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Bridge] Unhandled rejection:", reason);
});
