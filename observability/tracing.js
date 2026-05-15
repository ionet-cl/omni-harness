/**
 * Tracing — Inicialización de OpenTelemetry para el bridge.
 *
 * Carga al inicio para instrumentar todas las operaciones del bridge
 * con tracing distribuido. Los spans se exportan a la consola en formato
 * JSON (fácil de grepear) y opcionalmente a OTLP endpoint (Jaeger, Grafana).
 *
 * Variables de entorno:
 *   OTLP_ENDPOINT       — URL del collector OTLP (ej: http://localhost:4318/v1/traces)
 *   OTEL_SERVICE_NAME   — nombre del servicio (default: "deepseek-bridge")
 *   OTEL_DEBUG          — logging detallado de OTel si se define
 */

const { diag, DiagConsoleLogger, DiagLogLevel, trace } = require("@opentelemetry/api");
if (process.env.OTEL_DEBUG) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const { BasicTracerProvider, SimpleSpanProcessor, ConsoleSpanExporter } = require("@opentelemetry/sdk-trace-base");

const spanProcessors = [new SimpleSpanProcessor(new ConsoleSpanExporter())];

if (process.env.OTLP_ENDPOINT) {
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");
  spanProcessors.push(
    new SimpleSpanProcessor(new OTLPTraceExporter({ url: process.env.OTLP_ENDPOINT }))
  );
}

const provider = new BasicTracerProvider({
  serviceName: process.env.OTEL_SERVICE_NAME || "deepseek-bridge",
  spanProcessors,
});

trace.setGlobalTracerProvider(provider);

console.error(`[Tracing] Inicializado. Exportadores: ${spanProcessors.length}`);
if (process.env.OTLP_ENDPOINT) {
  console.error(`[Tracing] OTLP endpoint: ${process.env.OTLP_ENDPOINT}`);
}

module.exports = provider;
