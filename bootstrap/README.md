# ioHarness Bootstrap

Configuración portable del harness multi-agente.

## Cómo usar

```bash
# 1. En la máquina nueva
git clone https://github.com/ionet-cl/omni-harness.git
cd deepseek-v4-opencode-claude-code-bridge/bootstrap

# 2. Copiar y completar API keys
cp .env.example .env
nano .env   # pegar tus API keys

# 3. Ejecutar bootstrap
chmod +x bootstrap.sh
./bootstrap.sh
```

## Lo que instala

- 3 repos clonados (bridge fork, omni-pi, ioDesk-3)
- Dotfiles: DeepSeek TUI, OMP, Claude Code
- Blackboard MCP server
- Bridge systemd service
- Pi-Serena Bridge (vía omni-pi)

## Actualizar configuración

```bash
cd /ruta/al/repo/bootstrap
./bootstrap.sh --fast
```
