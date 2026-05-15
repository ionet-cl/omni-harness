/**
 * Trace — Middleware de trazabilidad distribuida.
 *
 * Inyecta trace_id, crea spans de OpenTelemetry, y loguea structured JSON
 * para cada request. Los spans tienen jerarquía padre-hijo.
 *
 * Uso:
 *   const { withTrace } = require("./middleware/trace.js");
 *   server.on("request", withTrace(handler));
 */

const { randomUUID } = require("crypto");
const { context, trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("deepseek-bridge/middleware/trace");

/**
 * Extrae o genera un trace_id para el request.
 */
function getOrCreateTraceId(req) {
  return req.headers["x-trace-id"] || randomUUID();
}

/**
 * Loguea un evento con trace_id y metadatos estructurados.
 */
function logTrace(traceId, event, meta = {}) {
  const entry = {
    t: new Date().toISOString(),
    trace_id: traceId,
    event,
    ...meta,
  };
  console.error(`[TRACE] ${JSON.stringify(entry)}`);
}

/**
 * Crea un middleware de trace con spans de OpenTelemetry.
 * Cada request crea un span raíz con hijos para auth, process, upstream.
 */
function withTrace(handler) {
  return (req, res, ...args) => {
    const traceId = getOrCreateTraceId(req);
    req.traceId = traceId;
    res.setHeader("x-trace-id", traceId);

    const parentContext = context.active();

    // Span raíz del request
    const span = tracer.startSpan(
      `${req.method} ${req.url?.split("?")[0] || "/unknown"}`,
      {
        attributes: {
          "http.method": req.method,
          "http.url": req.url,
          "trace_id": traceId,
          "service.name": process.env.OTEL_SERVICE_NAME || "deepseek-bridge",
        },
      },
      parentContext
    );

    // Contexto con el span activo para que los spans hijos herenden
    const ctx = trace.setSpan(parentContext, span);
    const prevContext = context.active();

    return context.with(ctx, async () => {
      logTrace(traceId, "request_start", {
        method: req.method,
        url: req.url,
        span_id: span.spanContext().spanId,
      });

      try {
        await handler(req, res, ...args);
        span.setStatus({ code: SpanStatusCode.OK });
        span.setAttribute("http.status_code", res.statusCode);
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message,
        });
        span.recordException(err);
        throw err;
      } finally {
        span.end();
        logTrace(traceId, "request_end", {
          status: res.statusCode,
          duration_ms: span.duration,
        });
      }
    });
  };
}

/**
 * Crea un span hijo para una sub-operación.
 * Útil para envolver operaciones como auth, upstream call, etc.
 */
function withChildSpan(parentSpan, name, fn, attrs = {}) {
  const ctx = trace.setSpan(context.active(), parentSpan);
  return context.with(ctx, () => {
    const span = tracer.startSpan(name, { attributes: attrs });
    try {
      const result = fn(span);
      if (result instanceof Promise) {
        return result.then(
          (val) => { span.end(); return val; },
          (err) => { span.recordException(err); span.end(); throw err; }
        );
      }
      span.end();
      return result;
    } catch (err) {
      span.recordException(err);
      span.end();
      throw err;
    }
  });
}

module.exports = { getOrCreateTraceId, logTrace, withTrace, withChildSpan, tracer };
