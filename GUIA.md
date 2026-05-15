# Guía de Configuración: Claude Code + DeepSeek V4 vía OpenCode Go

> **Versión:** 1.0 — Mayo 2026
> **Propósito:** Reconfigurar `ccd` desde cero para usar Claude Code con DeepSeek V4 Pro/Flash a través de OpenCode Go.
> **Tiempo estimado:** 10-15 minutos.

---

## Índice

1. [Requisitos previos](#1-requisitos-previos)
2. [Paso 1: Verificar/Instalar Node.js y Claude Code](#paso-1-verificarinstalar-nodejs-y-claude-code)
3. [Paso 2: Obtener API Key de OpenCode Go](#paso-2-obtener-api-key-de-opencode-go)
4. [Paso 3: Clonar el bridge de DeepSeek](#paso-3-clonar-el-bridge-de-deepseek)
5. [Paso 4: Configurar el bridge](#paso-4-configurar-el-bridge)
6. [Paso 5: Iniciar el bridge](#paso-5-iniciar-el-bridge)
7. [Paso 6: Verificar que el bridge funciona](#paso-6-verificar-que-el-bridge-funciona)
8. [Paso 7: Configurar el comando `ccd`](#paso-7-configurar-el-comando-ccd)
9. [Paso 8: Configurar Claude Code (settings.json)](#paso-8-configurar-claude-code-settingsjson)
10. [Paso 9: Probar todo](#paso-9-probar-todo)
11. [Paso 10: Autostart (opcional)](#paso-10-autostart-opcional)
12. [Solución de problemas](#solucion-de-problemas)
13. [Arquitectura resumida](#arquitectura-resumida)
14. [Referencias](#referencias)

---

## 1. Requisitos previos

Antes de empezar, necesitas:

- **Node.js** v18 o superior
- **Claude Code** instalado globalmente
- **Git** instalado
- Una **cuenta activa en OpenCode Go** (suscripción $10/mes)
- La **API Key de OpenCode Go** (se obtiene en https://opencode.ai/auth)

### Verificar requisitos

Abre una terminal y ejecuta:

```bash
# Node.js
node --version
# Debe mostrar: v18.x.x o superior

# npm
npm --version

# Claude Code
claude --version
# Debe mostrar: 2.x.x o superior

# Git
git --version
```

Si alguno falla, instálalo antes de continuar.

---

## 2. Obtener API Key de OpenCode Go

*(Si ya tienes la key, sáltate este paso)*

1. Ve a https://opencode.ai/auth
2. Inicia sesión con tu cuenta (o crea una nueva)
3. Si no tienes suscripción GO, actívala (cuesta $10/mes)
4. En el dashboard, busca "API Keys" o "API Key"
5. Copia la key. **Guárdala en un lugar seguro.** Tiene este formato:

```
sk-opencode-go-key-aqui
```

**⚠️ Importante:** Esta key es de OpenCode Go, NO de DeepSeek. Son diferentes.

---

## 3. Instalar/actualizar el bridge de DeepSeek

El bridge es un proxy local que traduce el protocolo de Anthropic (el que habla Claude Code) al protocolo de OpenAI (el que entiende OpenCode Go). También maneja el **reasoning cache** necesario para sesiones multi-turno con DeepSeek V4.

```bash
# Ir al directorio de repos
cd ~/dev/repos

# Si ya existe, borrarlo y clonar fresco
rm -rf deepseek-v4-opencode-claude-code-bridge

# Clonar
git clone https://github.com/superheroYu/deepseek-v4-opencode-claude-code-bridge.git

# Entrar al directorio
cd deepseek-v4-opencode-claude-code-bridge
```

Verifica que hayas descargado estos archivos:

```bash
ls -la
# Debe mostrar: config.json, server.js, package.json, start.sh, ...
```

---

## 4. Configurar el bridge

Crea/edita el archivo `config.json` dentro del directorio del bridge:

```bash
nano ~/dev/repos/deepseek-v4-opencode-claude-code-bridge/config.json
```

Pega EXACTAMENTE este contenido:

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "upstream": {
    "baseUrl": "https://opencode.ai/zen/go/v1"
  },
  "models": [
    "deepseek-v4-pro[1m]",
    "deepseek-v4-flash"
  ],
  "reasoningContent": "auto",
  "reasoningCacheMaxEntries": 0,
  "reasoningCacheMaxAgeMs": 2592000000,
  "reasoningCacheMaxSizeBytes": 209715200,
  "reasoningCachePath": "~/.claude/deepseek-v4-bridge-reasoning-cache.json",
  "requestBodyLimitBytes": 104857600,
  "upstreamTimeoutMs": 600000
}
```

**Explicación de cada campo:**

| Campo | Valor | ¿Qué hace? |
|-------|-------|------------|
| `listen.host` | `127.0.0.1` | Solo escucha en tu PC (seguro) |
| `listen.port` | `8787` | Puerto del proxy local |
| `upstream.baseUrl` | `https://opencode.ai/zen/go/v1` | Endpoint de OpenCode Go |
| `models` | `[...]` | Modelos disponibles (pro y flash) |
| `reasoningContent` | `auto` | Cachea reasoning_content para DeepSeek |
| `reasoningCacheMaxEntries` | `0` | Sin límite de entradas en caché |
| `reasoningCachePath` | `~/.claude/...` | Archivo donde se guarda el caché |

Guarda el archivo (Ctrl+O, Enter, Ctrl+X en nano).

---

## 5. Iniciar el bridge

Hay dos formas:

### Opción A: Manual (recomendada para pruebas)

```bash
cd ~/dev/repos/deepseek-v4-opencode-claude-code-bridge

# Reemplaza TU_API_KEY con tu key real de OpenCode Go
OPENCODE_GO_API_KEY="TU_API_KEY" \
nohup node server.js --config ./config.json > /tmp/deepseek-bridge.log 2>&1 &
```

### Opción B: Usando el script helper

```bash
# Crear el script (solo la primera vez)
nano ~/.local/bin/start-deepseek-bridge
```

Pega esto (reemplaza `TU_API_KEY`):

```bash
#!/bin/bash
PID_FILE="/tmp/deepseek-bridge.pid"
if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo "Bridge ya está corriendo (PID: $(cat $PID_FILE))"
    exit 0
fi

cd ~/dev/repos/deepseek-v4-opencode-claude-code-bridge
OPENCODE_GO_API_KEY="TU_API_KEY" \
nohup node server.js --config ./config.json > /tmp/deepseek-bridge.log 2>&1 &
echo $! > "$PID_FILE"
echo "Bridge iniciado (PID: $!)"
```

Guarda, hazlo ejecutable y ejecútalo:

```bash
chmod +x ~/.local/bin/start-deepseek-bridge
start-deepseek-bridge
```

### Cómo detener el bridge

```bash
# Con el script
kill $(cat /tmp/deepseek-bridge.pid) 2>/dev/null
rm -f /tmp/deepseek-bridge.pid

# O buscando el proceso
ps aux | grep "server.js" | grep -v grep
# y matas el PID correspondiente
```

---

## 6. Verificar que el bridge funciona

```bash
curl -s http://127.0.0.1:8787/v1/models
```

**Respuesta esperada:**

```json
{
  "object": "list",
  "data": [
    { "id": "deepseek-v4-pro[1m]", "object": "model", "owned_by": "opencode-go" },
    { "id": "deepseek-v4-flash",   "object": "model", "owned_by": "opencode-go" }
  ]
}
```

Si ves esto: **el bridge está funcionando.** Si no: revisa el log:

```bash
cat /tmp/deepseek-bridge.log
```

---

## 7. Configurar el comando `ccd`

El comando `ccd` es un script que lanza Claude Code con todas las variables de entorno correctas.

```bash
nano ~/.local/bin/ccd
```

Pega EXACTAMENTE este contenido (reemplaza `TU_API_KEY`):

```bash
#!/bin/bash
# ccd — Claude Code via DeepSeek V4 + OpenCode Go
# Bridge: deepseek-v4-opencode-claude-code-bridge (puerto 8787)

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# --- Bridge local (debe estar corriendo) ---
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="TU_API_KEY"
unset ANTHROPIC_AUTH_TOKEN

# --- Routing de modelos ---
# Pro[1m]  → tareas complejas (Opus-level)
# Flash    → tareas rápidas/sub-agentes (Sonnet/Haiku-level)
export ANTHROPIC_MODEL="deepseek-v4-flash"
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-flash"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro[1m]"
export CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-flash"
export DISABLE_INTERLEAVED_THINKING="1"
export CLAUDE_CODE_EFFORT_LEVEL="medium"

exec claude --dangerously-skip-permissions "$@"
```

Hazlo ejecutable:

```bash
chmod +x ~/.local/bin/ccd
```

**Prueba rápida:**

```bash
ccd -p 'responde exactamente: "ccd configurado correctamente"'
```

Si ves el mensaje: **ccd funciona.**

---

## 8. Configurar Claude Code (settings.json)

Esto configura las mismas variables para cuando uses `claude` directamente (sin `ccd`).

```bash
nano ~/.claude/settings.json
```

Busca la sección `"env": { ... }` y déjala así:

```json
"env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "TU_API_KEY",
    "ANTHROPIC_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash",
    "DISABLE_INTERLEAVED_THINKING": "1",
    "CLAUDE_CODE_EFFORT_LEVEL": "medium",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_PLUGIN_MARKETPLACE": "1",
    "ENABLE_LSP_TOOL": "1"
}
```

⚠️ **IMPORTANTE:** No borres el resto del archivo (permissions, hooks, plugins, etc.). Solo modifica la sección `"env"`.

**Diferencia entre `ANTHROPIC_API_KEY` y `ANTHROPIC_AUTH_TOKEN`:**

| Variable | Dónde se usa |
|----------|-------------|
| `ANTHROPIC_API_KEY` | El bridge deepseek la necesita (se envía como header `x-api-key`) |
| `ANTHROPIC_AUTH_TOKEN` | Se usa con oc-go-cc (proxy alternativo). Dejarla `unset` |

**En este setup usamos `ANTHROPIC_API_KEY` porque el bridge deepseek la necesita.**

---

## 9. Probar todo

### Test 1: Conexión básica

```bash
ccd -p 'di exactamente: "sistema operativo"'
# Deberías ver → sistema operativo
```

### Test 2: Tool call (lectura de archivo)

```bash
cd /tmp && echo "test-content" > test-ccd.txt
ccd -p 'lee el archivo /tmp/test-ccd.txt y dime su contenido'
# Deberías ver → test-content
```

### Test 3: Multi-turno (razonamiento encadenado)

```bash
cd /tmp
echo "10" > a.txt
echo "20" > b.txt

ccd -p '
Paso 1: Lee a.txt y b.txt
Paso 2: Suma los dos números
Paso 3: Crea resultado.txt con la suma
Paso 4: Lee resultado.txt para confirmar
'
# Debería leer ambos archivos, sumar, crear y confirmar
```

### Test 4: Ver los logs del bridge

```bash
tail -30 /tmp/deepseek-bridge.log
```

Deberías ver líneas como:

```
POST /v1/messages?beta=true -> 200 3000ms
POST /v1/messages?beta=true -> 200 3500ms
```

Si ves `-> 200`: funcionó. Si ves `-> 400` o `-> 500`: algo falló.

### Test 5: Verificar el reasoning cache

```bash
ls -la ~/.claude/deepseek-v4-bridge-reasoning-cache.json 2>/dev/null && echo "Cache existe" || echo "Cache no existe"
```

Después de usar `ccd` con tool calls, este archivo debe existir.

---

## 10. Autostart (opcional)

Para que el bridge arranque automáticamente al iniciar sesión:

### Opción A: Agregar a los programas de inicio de XFCE

1. Abre "Inicio de sesión y autoarranque" (desde el menú)
2. Ve a "Autoarranque de aplicaciones"
3. Añade:
   - **Nombre:** DeepSeek Bridge
   - **Comando:** `/home/leonardo/.local/bin/start-deepseek-bridge`
   - **Descripción:** Bridge para Claude Code + DeepSeek V4

### Opción B: Agregar al final de `~/.bashrc`

```bash
echo '# DeepSeek bridge autostart
if [ -z "$SSH_CONNECTION" ] && [ -x "$HOME/.local/bin/start-deepseek-bridge" ]; then
    $HOME/.local/bin/start-deepseek-bridge 2>/dev/null
fi' >> ~/.bashrc
```

### Opción C: Usar systemd (si tienes D-Bus disponible)

```bash
# Crear el servicio
mkdir -p ~/.config/systemd/user

nano ~/.config/systemd/user/deepseek-bridge.service
```

Pega (reemplaza `TU_API_KEY`):

```ini
[Unit]
Description=DeepSeek V4 OpenCode Claude Code Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/leonardo/dev/repos/deepseek-v4-opencode-claude-code-bridge
Environment=OPENCODE_GO_API_KEY=TU_API_KEY
ExecStart=/usr/bin/node /home/leonardo/dev/repos/deepseek-v4-opencode-claude-code-bridge/server.js --config /home/leonardo/dev/repos/deepseek-v4-opencode-claude-code-bridge/config.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable deepseek-bridge.service
systemctl --user start deepseek-bridge.service
systemctl --user status deepseek-bridge.service
```

---

## Solución de problemas

### ❌ "Bridge no responde"

```bash
curl -s http://127.0.0.1:8787/v1/models
# Si no responde:
cat /tmp/deepseek-bridge.log
# Busca errores
start-deepseek-bridge  # Reiniciar
```

### ❌ "401 Unauthorized" en los logs del bridge

**Causa:** La API Key de OpenCode Go es incorrecta o expiró.

**Solución:**
1. Ve a https://opencode.ai/auth
2. Copia la API Key actual
3. Actualízala en:
   - `~/.local/bin/ccd`
   - `~/.claude/settings.json`
   - `~/.local/bin/start-deepseek-bridge`
4. Reinicia el bridge

### ❌ "reasoning_content must be passed back"

**Causa:** El reasoning cache se perdió (archivo borrado, bridge reiniciado entre turnos, etc.)

**Solución:**
- Generalmente el bridge lo maneja automáticamente
- Si ocurre, inicia una nueva sesión de `ccd`
- El fallback a Kimi K2.6/Qwen toma el control automáticamente

### ❌ "Bridge PID exists but not running"

```bash
rm -f /tmp/deepseek-bridge.pid
start-deepseek-bridge
```

### ❌ "claude: command not found"

```bash
# Cargar nvm primero
source ~/.nvm/nvm.sh
# O instalar Claude Code
npm install -g @anthropic-ai/claude-code
```

### ❌ Error: "No se puede conectar a localhost:8787"

```bash
# 1. Verificar que el bridge está corriendo
ps aux | grep server.js | grep -v grep

# 2. Si no está: iniciarlo
start-deepseek-bridge

# 3. Verificar puerto
ss -tlnp | grep 8787
# Debe mostrar: LISTEN 127.0.0.1:8787
```

### ❌ DeepSeek tarda mucho o respuestas lentas

DeepSeek V4 Pro puede tardar 5-15 segundos en tareas complejas (thinking mode). Es normal. Si es excesivo:

- Revisa tu conexión a Internet
- Verifica que no haya límites de uso en OpenCode Go
- Prueba con `deepseek-v4-flash` que es más rápido

### ❌ Error al hacer git clone

```bash
# Si git clone falla, descarga el ZIP manualmente:
wget https://github.com/superheroYu/deepseek-v4-opencode-claude-code-bridge/archive/refs/heads/main.zip
unzip main.zip
mv deepseek-v4-opencode-claude-code-bridge-main deepseek-v4-opencode-claude-code-bridge
```

---

## Arquitectura resumida

```
┌─────────────────────────────────────────────────────────┐
│                      TU TERMINAL                         │
│                                                          │
│   $ ccd "haz X"                                          │
│       │                                                   │
│       ▼                                                   │
│   ┌──────────┐                                           │
│   │ ccd script│  Variables de entorno                     │
│   │ (bash)    │  → ANTHROPIC_BASE_URL=http://127.0.0.1:8787│
│   └─────┬─────┘  → ANTHROPIC_API_KEY=sk-...              │
│         │         → ANTHROPIC_MODEL=deepseek-v4-flash     │
│         ▼                                                 │
│   ┌──────────────────────────────────────┐                │
│   │       Claude Code (claude CLI)       │                │
│   │  Habla protocolo Anthropic /v1/messages│               │
│   └─────────────────┬────────────────────┘                │
│                     │ HTTP :8787                          │
│                     ▼                                     │
│   ┌──────────────────────────────────────┐                │
│   │  deepseek-v4-opencode-claude-code-   │                │
│   │  bridge (server.js - Node.js)        │                │
│   │                                      │                │
│   │  ● Traduce Anthropic → OpenAI        │                │
│   │  ● Cachea reasoning_content          │                │
│   │  ● Escucha en 127.0.0.1:8787         │                │
│   └─────────────────┬────────────────────┘                │
│                     │ HTTPS (Internet)                    │
│                     ▼                                     │
│   ┌──────────────────────────────────────┐                │
│   │       OpenCode Go (opencode.ai)       │                │
│   │  API Key: sk-opencode-go-key...       │                │
│   │  Endpoint: /zen/go/v1/chat/completions│               │
│   └─────────────────┬────────────────────┘                │
│                     │                                     │
│                     ▼                                     │
│   ┌──────────────────────────────────────┐                │
│   │       DeepSeek V4                     │                │
│   │  ● deepseek-v4-pro[1m] (complejo)    │                │
│   │  ● deepseek-v4-flash (rápido)        │                │
│   └──────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────┘
```

**Routing de oc-go-cc (en el bridge NO, pero se menciona):**
- El bridge NO hace routing por contenido (a diferencia de oc-go-cc). El modelo se define por el nombre que Claude Code envía.
- `ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]` → tareas complejas
- `ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash` → tareas normales

---

## Referencias

| Recurso | URL |
|---------|-----|
| OpenCode Go | https://opencode.ai/go |
| Dashboard API Keys | https://opencode.ai/auth |
| DeepSeek Bridge (GitHub) | https://github.com/superheroYu/deepseek-v4-opencode-claude-code-bridge |
| DeepSeek API Docs | https://api-docs.deepseek.com/guides/coding_agents |
| OpenCode Docs | https://opencode.ai/docs/go/ |
| oc-go-cc (proxy alternativo) | https://github.com/samueltuyizere/oc-go-cc |

---

## Checklist rápida (si todo falla)

Si el sistema deja de funcionar por completo, ejecuta esto en orden:

```bash
# 1. Verificar bridge
curl -s http://127.0.0.1:8787/v1/models || start-deepseek-bridge

# 2. Verificar ccd
ccd -p "test" || chmod +x ~/.local/bin/ccd

# 3. Verificar API key
# En OpenCode Go dashboard: https://opencode.ai/auth

# 4. Verificar variables
echo "URL: $ANTHROPIC_BASE_URL"
echo "Key: ${ANTHROPIC_API_KEY:0:10}..."

# 5. Último recurso: reinstalar todo el bridge
rm -rf ~/dev/repos/deepseek-v4-opencode-claude-code-bridge
git clone https://github.com/superheroYu/deepseek-v4-opencode-claude-code-bridge.git ~/dev/repos/deepseek-v4-opencode-claude-code-bridge
# Luego repetir pasos 4, 5, 6, 7
```

---

> **Tip:** Guarda este archivo en un lugar seguro para futura referencia:
> ```bash
> cp ~/dev/repos/deepseek-v4-opencode-claude-code-bridge/GUIA.md ~/Documentos/
> ```
