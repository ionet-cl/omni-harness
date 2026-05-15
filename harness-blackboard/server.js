#!/usr/bin/env node
/**
 * Harness Blackboard v2 — MCP Server
 *
 * Shared state between agents with optimistic locking, operation log,
 * y schema validation por tipo de entrada.
 *
 * Los agentes NO se hablan entre sí. Leen y escriben en este blackboard.
 * La coordinación emerge del estado compartido, no de la comunicación directa.
 *
 * Tools:
 *   read_blackboard(key?)       → entrada específica o resumen global
 *   write_blackboard(key, data, expected_version?) → compare-and-swap
 *   list_blackboard(prefix?)    → metadatos de entradas
 *   delete_blackboard(key, confirm) → borrado con confirmación
 *   history_blackboard(key?)    → log de operaciones
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";

// ── Config ────────────────────────────────────────────────────────

const STATE_PATH = process.env.BLACKBOARD_PATH ||
  "/home/leonardo/harness-blackboard/state.json";
const MAX_LOG_ENTRIES = 1000;

// ── Schemas de validación por tipo de entrada ────────────────────

const ENTRY_SCHEMAS = {
  focus: {
    required: ["value"],
    description: "Tarea activa actual. value: descripción del foco.",
  },
  decision: {
    required: ["value", "context"],
    description: "Decisión arquitectónica. value: resumen. context: por qué.",
  },
  blocker: {
    required: ["value"],
    description: "Bloqueo activo. value: descripción. Opcional: severity (low|medium|critical).",
  },
  note: {
    required: ["value"],
    description: "Nota informativa entre agentes. value: contenido.",
  },
  session: {
    required: ["value", "agent"],
    description: "Estado de sesión. value: 'active'|'idle'|'closed'. agent: quién.",
  },
};

// ── State Management ──────────────────────────────────────────────

function loadState() {
  let state;
  if (!existsSync(STATE_PATH)) {
    state = { version: 0, entries: {}, log: [], last_updated: new Date().toISOString() };
  } else {
    try {
      state = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    } catch {
      console.error("[Blackboard] Estado corrupto, reiniciando.");
      state = { version: 0, entries: {}, log: [], last_updated: new Date().toISOString() };
    }
  }
  // Backward compat: asegurar que log existe (v1 → v2)
  if (!Array.isArray(state.log)) state.log = [];
  return state;
}

function saveState(state) {
  state.last_updated = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// ── Operaciones atómicas ──────────────────────────────────────────

function getEntry(state, key) {
  const entry = state.entries[key];
  if (!entry) throw new Error(`Key not found: ${key}`);

  // TTL check
  if (entry.ttl) {
    const age = (Date.now() - new Date(entry.created_at).getTime()) / 1000;
    if (age > entry.ttl) {
      delete state.entries[key];
      appendLog(state, key, "expire", entry.trace_id);
      saveState(state);
      throw new Error(`Key expired: ${key} (TTL was ${entry.ttl}s)`);
    }
  }
  return entry;
}

function appendLog(state, key, action, traceId) {
  state.log.push({
    trace_id: traceId || randomUUID(),
    key,
    action,
    version: state.version,
    timestamp: new Date().toISOString(),
  });
  // Trim log
  if (state.log.length > MAX_LOG_ENTRIES) {
    state.log = state.log.slice(-MAX_LOG_ENTRIES);
  }
}

function validateData(type, data) {
  const schema = ENTRY_SCHEMAS[type];
  if (!schema) return `Unknown entry type: ${type}. Allowed: ${Object.keys(ENTRY_SCHEMAS).join(", ")}`;

  const missing = schema.required.filter((f) => {
    const val = data[f];
    return val === undefined || val === null || val === "";
  });

  if (missing.length > 0) {
    return `Entry type '${type}' requires: ${missing.join(", ")}`;
  }
  return null;
}

function setEntry(state, key, data, ttl, traceId, expectedVersion) {
  // Optimistic locking: compare-and-swap
  if (expectedVersion !== undefined && expectedVersion !== null) {
    const expVer = Number(expectedVersion);
    if (!Number.isInteger(expVer)) {
      throw new Error(`expected_version must be an integer, got: ${expectedVersion}`);
    }
    if (state.version !== expVer) {
      throw new Error(
        `Version conflict: expected ${expVer}, current ${state.version}. ` +
        `Reload and retry.`
      );
    }
  }

  // Validate schema
  const type = data.type || "note";
  const validationError = validateData(type, data);
  if (validationError) {
    throw new Error(validationError);
  }

  const existing = state.entries[key];
  const trace_id = traceId || randomUUID();

  const entry = {
    type,
    data,
    trace_id,
    created_at: existing ? existing.created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (ttl && Number.isFinite(Number(ttl))) {
    entry.ttl = Number(ttl);
  }

  state.entries[key] = entry;
  state.version += 1;
  appendLog(state, key, "write", trace_id);
  saveState(state);
  return entry;
}

// ── MCP Server ────────────────────────────────────────────────────

const server = new Server(
  { name: "harness-blackboard", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_blackboard",
      description:
        "Lee una entrada del blackboard compartido. " +
        "Si no se especifica key, devuelve resumen con version, entradas disponibles y última actualización. " +
        "Usar list_blackboard para ver metadatos sin valores.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Clave a leer (ej: 'focus/current'). Omitir para resumen global.",
          },
        },
      },
    },
    {
      name: "write_blackboard",
      description:
        "Escribe o actualiza una entrada con optimistic locking. " +
        "Si se especifica expected_version, el write solo succeeds si coincide con la versión actual. " +
        "Si hay conflicto (otro agente escribió antes), devuelve error 409. " +
        "Cada tipo de entrada tiene validación de schema.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Clave. Convención:\n" +
              "- 'focus/current' → tarea activa\n" +
              "- 'decision/DEC-XXX' → decisión arquitectónica\n" +
              "- 'blocker/BLK-XXX' → bloqueo\n" +
              "- 'note/NOTE-XXX' → nota entre agentes\n" +
              "- 'session/SESSION-XXX' → estado de sesión",
          },
          data: {
            type: "object",
            description: "Contenido. type define qué campos son requeridos.",
            properties: {
              type: {
                type: "string",
                enum: Object.keys(ENTRY_SCHEMAS),
                description: `Tipos: ${Object.keys(ENTRY_SCHEMAS).join(", ")}`,
              },
              value: { type: "string", description: "Valor principal" },
              context: { type: "string", description: "Contexto (requerido para decision)" },
              agent: { type: "string", description: "Nombre del agente (requerido para session)" },
              severity: {
                type: "string",
                enum: ["low", "medium", "critical"],
                description: "Severidad (opcional, blocker)",
              },
            },
            required: ["type", "value"],
          },
          expected_version: {
            type: "number",
            description:
              "Versión esperada para optimistic locking. " +
              "Si la versión actual difiere, el write se rechaza. " +
              "Omitir para write incondicional (no recomendado en concurrencia).",
          },
          ttl: {
            type: "number",
            description: "TTL en segundos. Si se omite, no expira.",
          },
          trace_id: {
            type: "string",
            description: "Opcional. Se genera automáticamente si se omite.",
          },
        },
        required: ["key", "data"],
      },
    },
    {
      name: "list_blackboard",
      description:
        "Lista las claves del blackboard con metadatos (tipo, creado por, cuándo, TTL). " +
        "No devuelve valores completos. Opcionalmente filtrar por prefijo.",
      inputSchema: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description: "Prefijo para filtrar (ej: 'focus/', 'decision/')",
          },
        },
      },
    },
    {
      name: "delete_blackboard",
      description:
        "Elimina una entrada. Requiere confirm: true explícito. " +
        "Queda registrada en el log de operaciones.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Clave a eliminar" },
          confirm: {
            type: "boolean",
            description: "Debe ser true para confirmar",
          },
        },
        required: ["key", "confirm"],
      },
    },
    {
      name: "history_blackboard",
      description:
        "Devuelve el historial de operaciones (writes, deletes, expiraciones). " +
        "Opcionalmente filtrar por key para ver el historial de una entrada específica.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Filtrar por clave específica (ej: 'focus/current')",
          },
          limit: {
            type: "number",
            description: "Máximo de entradas a devolver (default: 50, max: 1000)",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ── READ ─────────────────────────────────────────────────
      case "read_blackboard": {
        const state = loadState();
        if (args?.key) {
          const entry = getEntry(state, args.key);
          return {
            content: [{ type: "text", text: JSON.stringify(entry, null, 2) }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  version: state.version,
                  last_updated: state.last_updated,
                  entry_count: Object.keys(state.entries).length,
                  entries: Object.keys(state.entries),
                  log_count: state.log.length,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ── WRITE (optimistic locking) ──────────────────────────
      case "write_blackboard": {
        const state = loadState();
        const entry = setEntry(
          state,
          args.key,
          args.data,
          args.ttl,
          args.trace_id,
          args.expected_version
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  version: state.version,
                  key: args.key,
                  trace_id: entry.trace_id,
                  created_at: entry.created_at,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // ── LIST ─────────────────────────────────────────────────
      case "list_blackboard": {
        const state = loadState();
        const prefix = args?.prefix || "";
        const entries = Object.entries(state.entries)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, entry]) => ({
            key,
            type: entry.type,
            trace_id: entry.trace_id,
            created_at: entry.created_at,
            updated_at: entry.updated_at,
            expires: entry.ttl
              ? new Date(
                  new Date(entry.created_at).getTime() + entry.ttl * 1000
                ).toISOString()
              : null,
          }));
        return {
          content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
        };
      }

      // ── DELETE ──────────────────────────────────────────────
      case "delete_blackboard": {
        if (!args?.confirm) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "confirm must be true to delete",
                }),
                isError: true,
              },
            ],
          };
        }
        const state = loadState();
        if (!state.entries[args.key]) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: `Key not found: ${args.key}` }),
                isError: true,
              },
            ],
          };
        }
        const traceId = randomUUID();
        delete state.entries[args.key];
        state.version += 1;
        appendLog(state, args.key, "delete", traceId);
        saveState(state);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                key: args.key,
                version: state.version,
                trace_id: traceId,
              }),
            },
          ],
        };
      }

      // ── HISTORY ─────────────────────────────────────────────
      case "history_blackboard": {
        const state = loadState();
        const keyFilter = args?.key;
        const limit = Math.min(args?.limit || 50, MAX_LOG_ENTRIES);
        let log = state.log;
        if (keyFilter) {
          log = log.filter((entry) => entry.key === keyFilter);
        }
        log = log.slice(-limit);
        return {
          content: [{ type: "text", text: JSON.stringify(log, null, 2) }],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: error.message }),
          isError: true,
        },
      ],
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[Blackboard v2] Servidor listo. Estado: ${STATE_PATH}`);
}

main().catch((error) => {
  console.error("[Blackboard v2] Error fatal:", error);
  process.exit(1);
});
