#!/bin/bash
# =============================================================================
# ioHarness Bootstrap — Instalación completa del harness multi-agente
#
# Clona/configura los 3 repos + dotfiles + servicios para que cualquier
# máquina (oficina, home, servidor) quede con la misma configuración.
#
# Uso:
#   ./bootstrap.sh                    # Instalación interactiva
#   ./bootstrap.sh --fast             # Solo verificar que está todo ok
#   API_KEY="sk-..." ./bootstrap.sh   # Con API key inline
# =============================================================================

set -euo pipefail

REPO_BRIDGE="https://github.com/ionet-cl/omni-harness.git"
REPO_OMNIPI="https://github.com/iodevs-net/omni-pi.git"
REPO_IODESK="https://github.com/iodevs-net/iodesk-3.git"

REPO_DIR="$HOME/dev/repos/omni-harness"
OMNIPI_DIR="$HOME/dev/proyectos/omni-pi"
IODESK_DIR="$HOME/dev/proyectos/helpdesk-ionet/iodesk-3"
BLACKBOARD_DIR="$REPO_DIR/harness-blackboard"
BOOTSTRAP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "═══════════════════════════════════════════"
echo "  ioHarness Bootstrap v1"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Clone repos ─────────────────────────────────────────────
echo "[1/6] Clonando repositorios..."

clone_or_pull() {
  local dir="$1" url="$2" name="$3"
  if [ -d "$dir/.git" ]; then
    echo "  ✅ $name ya clonado, actualizando..."
    cd "$dir" && git pull 2>/dev/null || true
  else
    echo "  📥 Clonando $name..."
    mkdir -p "$(dirname "$dir")"
    git clone "$url" "$dir" 2>/dev/null || {
      echo "  ❌ No se pudo clonar $name (¿sin acceso?)"
      return 1
    }
    echo "  ✅ $name clonado"
  fi
}

clone_or_pull "$REPO_DIR" "$REPO_BRIDGE" "omni-harness"
clone_or_pull "$OMNIPI_DIR" "$REPO_OMNIPI" "omni-pi"
clone_or_pull "$IODESK_DIR" "$REPO_IODESK" "ioDesk-3"

echo ""

# ── 2. Instalar dotfiles ──────────────────────────────────────
echo "[2/6] Instalando configuraciones..."

TEMPLATES="$BOOTSTRAP_DIR/templates"

install_template() {
  local src="$1" dst="$2" desc="$3"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
    echo "  ✅ $desc"
  else
    echo "  ⚠️  Template no encontrado: $src"
  fi
}

# DeepSeek TUI
install_template "$TEMPLATES/deepseek-config.toml" "$HOME/.deepseek/config.toml" "DeepSeek TUI config"
install_template "$TEMPLATES/deepseek-mcp.json" "$HOME/.deepseek/mcp.json" "DeepSeek TUI MCP"
install_template "$TEMPLATES/deepseek-instructions.md" "$HOME/.deepseek/instructions.md" "DeepSeek TUI instructions"

# OMP
install_template "$TEMPLATES/omp-settings.json" "$HOME/.omp/agent/settings.json" "OMP agent settings"
install_template "$TEMPLATES/omp-mcp_config.json" "$HOME/.omp/mcp_config.json" "OMP MCP config"

# Claude Code
install_template "$TEMPLATES/claude-mcp.json" "$HOME/.claude/mcp.json" "Claude Code MCP"
install_template "$TEMPLATES/claude-CLAUDE.md" "$HOME/.claude/CLAUDE.md" "Claude Code CLAUDE.md"

# Systemd + start script
install_template "$TEMPLATES/deepseek-bridge.service" "$HOME/.config/systemd/user/deepseek-bridge.service" "Systemd service"
install_template "$TEMPLATES/start-deepseek-bridge" "$HOME/.local/bin/start-deepseek-bridge" "Start script"
chmod +x "$HOME/.local/bin/start-deepseek-bridge" 2>/dev/null || true

# Pi-Serena Bridge (symlink o copy de la extensión)
if [ -d "$OMNIPI_DIR/omp/extensions/pi-serena-bridge" ]; then
  # Ya debería estar linkeado por OMP
  echo "  ✅ Pi-Serena Bridge disponible en omni-pi"
fi

echo ""

# ── 3. Harness blackboard ─────────────────────────────────────
echo "[3/6] Configurando blackboard..."

BLACKBOARD_LINK="$HOME/harness-blackboard"
if [ ! -L "$BLACKBOARD_LINK" ] && [ ! -d "$BLACKBOARD_LINK" ]; then
  ln -sf "$BLACKBOARD_DIR" "$BLACKBOARD_LINK"
  echo "  ✅ Symlink creado: $BLACKBOARD_LINK → $HARNESS_DIR"
elif [ -d "$BLACKBOARD_LINK" ] && [ ! -L "$BLACKBOARD_LINK" ]; then
  echo "  ⚠️  $BLACKBOARD_LINK ya existe (no symlink), se deja como está"
else
  echo "  ✅ Blackboard ya configurado"
fi

# Instalar dependencias
if [ -f "$BLACKBOARD_DIR/package.json" ]; then
  cd "$BLACKBOARD_DIR" && npm install --silent 2>/dev/null
  echo "  ✅ Dependencias del blackboard instaladas"
fi

echo ""

# ── 4. Configurar API keys ────────────────────────────────────
echo "[4/6] Verificando API keys..."

if [ -z "${API_KEY:-}" ]; then
  # Buscar en archivo .env
  if [ -f "$BOOTSTRAP_DIR/.env" ]; then
    source "$BOOTSTRAP_DIR/.env"
    echo "  ✅ API keys cargadas desde .env"
  else
    echo "  ⚠️  No se encontraron API keys."
    echo "  ℹ️  Crea un archivo $BOOTSTRAP_DIR/.env con:"
    echo "       API_KEY_DEEPSEEK=\"sk-tu-key\""
    echo "       API_KEY_OPENCODE=\"sk-tu-key\""
    echo "       API_KEY_TAVILY=\"tvly-tu-key\""
    echo "       API_KEY_CONTEXT7=\"ctx7sk-tu-key\""
  fi
fi

# Inyectar keys en los templates si están disponibles
if [ -n "${API_KEY_DEEPSEEK:-}" ]; then
  sed -i "s/PLACEHOLDER_DEEPSEEK_API_KEY/$API_KEY_DEEPSEEK/g" "$HOME/.deepseek/config.toml" 2>/dev/null || true
fi
if [ -n "${API_KEY_OPENCODE:-}" ]; then
  sed -i "s/PLACEHOLDER_OPENCODE_API_KEY/$API_KEY_OPENCODE/g" "$HOME/.deepseek/config.toml" 2>/dev/null || true
fi
if [ -n "${API_KEY_TAVILY:-}" ]; then
  for f in "$HOME/.deepseek/mcp.json" "$HOME/.omp/mcp_config.json" "$HOME/.claude/mcp.json"; do
    sed -i "s/PLACEHOLDER_TAVILY_API_KEY/$API_KEY_TAVILY/g" "$f" 2>/dev/null || true
  done
fi

echo ""

# ── 5. Iniciar servicios ──────────────────────────────────────
echo "[5/6] Iniciando servicios..."

# Bridge service
if command -v systemctl &>/dev/null; then
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable deepseek-bridge.service 2>/dev/null || true
  systemctl --user restart deepseek-bridge.service 2>/dev/null || true
  echo "  ✅ Bridge service iniciado (systemd)"
else
  # Fallback: start script
  "$HOME/.local/bin/start-deepseek-bridge" 2>/dev/null || true
  echo "  ✅ Bridge iniciado (start script)"
fi

echo ""

# ── 6. Verificar ──────────────────────────────────────────────
echo "[6/6] Verificando instalación..."

sleep 2
if curl -sf http://localhost:8787/health >/dev/null 2>&1; then
  echo "  ✅ Bridge responde en :8787"
else
  echo "  ⚠️  Bridge no responde aún (puede estar arrancando)"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  ioHarness Bootstrap — COMPLETADO"
echo "═══════════════════════════════════════════"
echo ""
echo "  Comandos disponibles:"
echo "    deepseek    → DeepSeek TUI"
echo "    omp         → Oh-My-Pi"
echo "    ccd         → Claude Code + bridge"
echo ""
echo "  Para actualizar config: cd bootstrap/ && ./bootstrap.sh --fast"
