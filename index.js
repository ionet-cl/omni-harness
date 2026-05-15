/**
 * index.js — Entry point modular del bridge.
 *
 * Carga config desde config/index.js,
 * inicializa el cache desde cache/reasoning-cache.js,
 * y delega el servidor HTTP a server.js (que mantiene compatibilidad total).
 *
 * Uso: node index.js [--config ./config.json]
 */

const { loadConfig } = require("./config/index.js");
const reasoningCache = require("./cache/reasoning-cache.js");

// 1. Cargar configuración
const CONFIG = loadConfig();

// 2. Inicializar caché de razonamiento
reasoningCache.setConfig(CONFIG);
reasoningCache.loadReasoningCache();

// 3. Iniciar servidor (server.js modificado para recibir CONFIG y cache)
const { createServer, startServer } = require("./server.js");

// Override: pasar CONFIG y cache al server.js
// server.js exporta startServer() que lee CONFIG global.
// La forma limpia es que server.js importe desde nuestros módulos.
// Pero para mantener compatibilidad total, usamos la función startServer() exportada.

startServer();

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
