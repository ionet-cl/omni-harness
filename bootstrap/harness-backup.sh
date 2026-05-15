#!/bin/bash
# =============================================================================
# ioHarness Backup — Respaldo portátil de toda la configuración del sistema
#
# Crea un único archivo .tar.gz con todas las skills, plugins, configs,
# dotfiles, y scripts. Excluye cache, node_modules, sesiones y DBs pesadas.
#
# Uso:
#   ./harness-backup.sh                      # Crea ./ioharness-backup-*.tar.gz
#   ./harness-backup.sh --restore backup.tar.gz  # Restaura desde un backup
#   ./harness-backup.sh --list backup.tar.gz     # Lista contenido sin restaurar
# =============================================================================

set -euo pipefail

BACKUP_FILE="${2:-ioharness-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"
MODE="${1:-backup}"
BOOTSTRAP_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$MODE" in
  backup)
    echo "═══════════════════════════════════════════"
    echo "  ioHarness Backup — Creando respaldo"
    echo "═══════════════════════════════════════════"
    echo ""

    INCLUDE=()
    EXCLUDE=()

    # DeepSeek TUI
    if [ -d "$HOME/.deepseek" ]; then
      INCLUDE+=("$HOME/.deepseek")
      EXCLUDE+=("--exclude=.deepseek/sessions")
      EXCLUDE+=("--exclude=.deepseek/.*.db*")
      echo "  📦 .deepseek/ — config + skills ($(find "$HOME/.deepseek/skills" -name 'SKILL.md' 2>/dev/null | wc -l) skills)"
    fi

    # Claude Code
    if [ -d "$HOME/.claude" ]; then
      INCLUDE+=("$HOME/.claude")
      EXCLUDE+=("--exclude=.claude/cache")
      EXCLUDE+=("--exclude=.claude/sessions")
      EXCLUDE+=("--exclude=.claude/shell-snapshots")
      EXCLUDE+=("--exclude=.claude/downloads")
      EXCLUDE+=("--exclude=.claude/agent-memory/*.db*")
      EXCLUDE+=("--exclude=.claude/.claude")
      echo "  📦 .claude/ — config + skills ($(find "$HOME/.claude/skills" -name 'SKILL.md' 2>/dev/null | wc -l) skills)"
    fi

    # OMP
    if [ -d "$HOME/.omp" ]; then
      INCLUDE+=("$HOME/.omp")
      EXCLUDE+=("--exclude=.omp/agent/agent.db*")
      EXCLUDE+=("--exclude=.omp/agent/history.db*")
      EXCLUDE+=("--exclude=.omp/agent/models.db*")
      EXCLUDE+=("--exclude=.omp/agent/sessions")
      EXCLUDE+=("--exclude=.omp/agent/blobs")
      EXCLUDE+=("--exclude=.omp/agent/terminal-sessions")
      EXCLUDE+=("--exclude=.omp/agent/pygateway")
      EXCLUDE+=("--exclude=.omp/plugins/node_modules")
      EXCLUDE+=("--exclude=.omp/plugins/package-lock.json")
      EXCLUDE+=("--exclude=.omp/puppeteer/node_modules")
      EXCLUDE+=("--exclude=.omp/pi-gateway/sessions")
      EXT_COUNT=$(ls "$HOME/.omp/extensions" 2>/dev/null | wc -l)
      PLUG_COUNT=$(ls "$HOME/.omp/plugins" 2>/dev/null | wc -l)
      echo "  📦 .omp/ — config + plugins ($PLUG_COUNT) + extensions ($EXT_COUNT)"
    fi

    # Claude config.json (separado porque tiene keys)
    if [ -f "$HOME/.claude/config.json" ]; then
      cp "$HOME/.claude/config.json" "$BOOTSTRAP_DIR/templates/claude-config-source.json" 2>/dev/null || true
    fi

    # Scripts locales
    if [ -d "$HOME/.local/bin" ]; then
      INCLUDE+=("$HOME/.local/bin")
      echo "  📦 .local/bin/ — scripts ($(ls "$HOME/.local/bin" 2>/dev/null | wc -l) scripts)"
    fi

    # Systemd services
    if [ -f "$HOME/.config/systemd/user/deepseek-bridge.service" ]; then
      INCLUDE+=("$HOME/.config/systemd/user/deepseek-bridge.service")
      echo "  📦 deepseek-bridge.service"
    fi

    # Shell config
    for f in .bashrc .bash_aliases .profile .tmux.conf; do
      if [ -f "$HOME/$f" ]; then
        INCLUDE+=("$HOME/$f")
        echo "  📦 $f"
      fi
    done

    # Alias para comandos (deepseek, omp, ccd)
    echo ""
    echo "  🔍 Buscando alias de comandos..."
    for cmd in deepseek omp ccd; do
      if command -v "$cmd" &>/dev/null; then
        echo "    ✅ $cmd → $(which "$cmd")"
      fi
    done

    echo ""
    echo "─── Creando archivo: $BACKUP_FILE ───"
    tar -czf "$BACKUP_FILE" \
      --exclude=node_modules \
      --exclude=.npm \
      --exclude=.cache \
      "${EXCLUDE[@]}" \
      "${INCLUDE[@]}" \
      2>&1 | tail -1 || true

    # Verificar
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo ""
    echo "═══════════════════════════════════════════"
    echo "  ✅ Backup creado: $BACKUP_FILE ($SIZE)"
    echo "═══════════════════════════════════════════"
    echo "  Para restaurar: ./harness-backup.sh --restore $BACKUP_FILE"
    echo "  Para listar:    ./harness-backup.sh --list $BACKUP_FILE"
    ;;

  restore)
    if [ ! -f "$BACKUP_FILE" ]; then
      echo "❌ Archivo no encontrado: $BACKUP_FILE"
      exit 1
    fi
    echo "═══════════════════════════════════════════"
    echo "  ioHarness Backup — Restaurando"
    echo "═══════════════════════════════════════════"
    echo ""
    echo "  Archivo: $BACKUP_FILE"
    echo "  Destino: $HOME"
    echo ""
    echo "  ⚠️  Esto SOBREESCRIBIRÁ configuraciones existentes."
    echo "  Los backups previos se guardan con extensión .pre-restore"
    echo ""
    read -p "  ¿Continuar? (s/N): " CONFIRM
    if [ "$CONFIRM" != "s" ] && [ "$CONFIRM" != "S" ]; then
      echo "  Cancelado."
      exit 0
    fi

    # Backup previo automático
    PREVIOUS="$HOME/.ioharness-pre-restore-$(date +%Y%m%d-%H%M%S).tar.gz"
    echo "  📦 Respaldando config actual en $PREVIOUS..."

    PREV_INCLUDE=()
    for p in .deepseek .claude .omp .local/bin .config/systemd/user/deepseek-bridge.service; do
      [ -e "$HOME/$p" ] && PREV_INCLUDE+=("$HOME/$p")
    done
    if [ ${#PREV_INCLUDE[@]} -gt 0 ]; then
      tar -czf "$PREVIOUS" "${PREV_INCLUDE[@]}" 2>/dev/null || true
    fi

    echo "  📂 Restaurando..."
    tar -xzf "$BACKUP_FILE" -C "$HOME" 2>&1 | tail -3

    # Post-restore: asegurar permisos
    chmod 600 "$HOME/.deepseek/mcp.json" 2>/dev/null || true
    chmod 600 "$HOME/.omp/mcp_config.json" 2>/dev/null || true
    chmod 600 "$HOME/.claude/mcp.json" 2>/dev/null || true

    echo ""
    echo "═══════════════════════════════════════════"
    echo "  ✅ Restauración completa"
    echo "═══════════════════════════════════════════"
    echo "  Respaldo previo: $PREVIOUS"
    echo "  Corre bootstrap.sh para reinstalar servicios"
    ;;

  list)
    if [ ! -f "$BACKUP_FILE" ]; then
      echo "❌ Archivo no encontrado: $BACKUP_FILE"
      exit 1
    fi
    echo "═══ Contenido del backup: $BACKUP_FILE ═══"
    tar -tzf "$BACKUP_FILE" | head -50
    echo "... ($(tar -tzf "$BACKUP_FILE" | wc -l) archivos totales)"
    ;;

  *)
    echo "Uso:"
    echo "  $0                     Crear backup"
    echo "  $0 --restore archivo   Restaurar backup"
    echo "  $0 --list archivo      Listar contenido"
    exit 1
    ;;
esac
