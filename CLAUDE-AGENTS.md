# Multi-Agent Development Guide
## Cómo usar agentes paralelos en Claude Code para este proyecto

### Concepto
Este proyecto tiene DOS capas de agentes:

1. **Agentes de debate** (el producto) — viven en debate-manager.cjs
   - Son los que charlan en Figma Make (arquitecto, crítico, moderador, etc.)
   - Se orquestan via MCP tools (turno, ronda_completa, situacion)

2. **Agentes desarrolladores** (aceleración de dev) — son sub-procesos de Claude Code
   - Cada uno es un programador especialista
   - Trabajan en paralelo en copias aisladas del código (worktrees)
   - No se pisan entre sí

### Arquitectura del Proyecto (para contexto de agentes dev)

```
debate-manager.cjs    — Motor de debates (lógica de negocio)
mcp-server.js         — Servidor MCP (18 tools + endpoints HTTP)
sub-groups.cjs        — Sub-grupos y pipelines
sub-groups-tools.cjs  — Tools MCP para sub-grupos
validators.cjs        — Validaciones y safe wrappers
dashboard-v2.html     — Dashboard mejorado
test-suite.cjs        — 91 tests automatizados
debates.json          — Estado persistente
```

### Roles de Agentes Desarrolladores

Cuando pidas mejoras al sistema, estos son los especialistas sugeridos:

**Agente Motor** — debate-manager.cjs
- Fases, roles, intensidad, KB, rondas
- Performance (saveState, batch ops)
- Nuevas mecánicas de debate

**Agente MCP** — mcp-server.js
- Tools MCP (schema, descripciones, handlers)
- Endpoints HTTP (SSE, StreamableHTTP, dashboard)
- Integración con Figma Make

**Agente UI** — dashboard-v2.html
- Visualización en tiempo real
- UX, charts, responsive design
- WebSocket/SSE client

**Agente Testing** — test-suite.cjs
- Tests unitarios, integración, edge cases
- Coverage de nuevas features
- Performance benchmarks

**Agente Features** — sub-groups.cjs, validators.cjs
- Sub-grupos, pipelines, mesas
- Validaciones, error handling
- Nuevos módulos

### Cómo Pedirlo en Claude Code

Ejemplo de prompt efectivo:

```
Necesito mejorar el sistema de debates en paralelo:
1. En debate-manager.cjs: agregar soporte para votaciones
2. En mcp-server.js: nuevo tool "votar"
3. En dashboard-v2.html: mostrar resultados de votación
4. En test-suite.cjs: tests para votaciones

Lanzá agentes especializados en paralelo, uno por archivo.
```

Claude Code entonces lanza 4 sub-agentes simultáneos, cada uno
en su worktree, y al terminar integra los cambios.

### Comando para correr tests después de cambios

```bash
cd multi-agent-chat
echo '{"debates":{},"nextId":1}' > debates.json
node test-suite.cjs
```

### Comando para arrancar el server

```bash
node mcp-server.js --http 3000
# Dashboard v1: http://localhost:3000/dashboard
# Dashboard v2: http://localhost:3000/dashboard-v2
# MCP endpoint:  http://localhost:3000/mcp
```
