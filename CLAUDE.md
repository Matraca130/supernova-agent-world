# Multi-Agent Debate System — Development Instructions

## Project Overview
MCP Server that orchestrates multi-agent debates. Connected to Figma Make via StreamableHTTP through ngrok. Includes a code proposal system where agents can analyze, propose, review, and apply code changes.

## Architecture

```
debate-manager.cjs    — Motor principal (fases, roles, KB, rondas, intensidad, proposals)
mcp-server.js         — Servidor MCP (33 tools, endpoints HTTP, dashboards)
sub-groups.cjs        — Sub-grupos (mesas) y pipelines
sub-groups-tools.cjs  — Tools MCP para sub-grupos/pipelines
validators.cjs        — Validaciones, safe wrappers, health check
dashboard-v2.html     — Dashboard con session management, drawer, stats
dashboard-world.html  — Vista isometrica 2D con agentes animados en habitaciones
test-suite.cjs        — 115 tests automatizados
embeddings.cjs        — Auto-embeddings con OpenAI text-embedding-3-small
orchestrator-engine.cjs — Motor autónomo de debates (OpenAI API, sin depender de Figma Make)
triage-agent.cjs      — Agente Triage (clasificación de complejidad, 6 agentes especializados)
embeddings.json       — Vector store (auto-generado)
.env                  — API keys (no commitear)
debates.json          — Estado persistente
SessionTypes.cjs      — Tipos y validadores (Checkpoint, ActionItem, SessionMetrics)
```

### Endpoints HTTP
| Ruta | Descripcion |
|------|-------------|
| `/dashboard` | Dashboard v1 (inline en mcp-server.js) |
| `/dashboard-v2` | Dashboard v2 con session management |
| `/world` | Agent World — vista isometrica |
| `/api/debate/live` | Debate activo en tiempo real |
| `/api/sessions` | Lista todas las sesiones |
| `/api/sessions/stats` | Estadisticas agregadas |
| `/api/sessions/:id` | Detalle completo de sesion |
| `/api/proposals` | Lista propuestas de codigo |
| `/mcp` | StreamableHTTP MCP endpoint |
| `/sse` | SSE MCP endpoint |
| `/api/orchestrator/events` | SSE stream for autonomous debate events |

### MCP Tools (38 total)
**Debate:** iniciar_debate, unirse, decir, leer, avanzar_ronda, finalizar, debates, estado, roles
**KB:** agregar_contexto, consultar_fuente, banco
**Orchestration:** turno, ronda_completa, decir_lote, run_debate
**Situaciones:** situaciones, situacion, workflow_status
**Sub-groups:** (via sub-groups-tools.cjs)
**Code Proposals:** read_project_file, list_project_files, propose_edit, review_proposal, apply_proposal, revert_proposal, list_proposals, run_tests
**Governance:** governance_status
**Embeddings:** buscar_similar, embedding_stats
**Triage:** evaluar_tarea, equipo
**System:** health_check

### Situaciones Disponibles (5)
| ID | Nombre | Flujo |
|----|--------|-------|
| `libre` | Debate libre | Todos participan sin orden |
| `identificar_problemas` | Identificar problemas | Detector → Analista → Priorizador → Fix |
| `arquitectura` | Arquitectura de solucion | Propuestas → Cross-exam → Refinamiento → Decision |
| `ejecucion` | Ejecucion coordinada | Coordinador → Implementador → Revisor → QA |
| `mejora_codigo` | Mejora de codigo | Analista → Proponedor → Revisores → Coordinador aplica |

### Server-Side Orchestration
- `run_debate` tool triggers autonomous debate execution via OpenAI API
- Server generates all agent responses (gpt-4o-mini by default)
- No dependency on Figma Make for the debate loop
- Real-time events via `/api/orchestrator/events` (SSE)
- Safety caps: 20 rounds max, 10-minute timeout
- Repetition detection via Jaccard similarity

### 6-Agent Team
- Arquitecto, Frontend Dev, Backend Dev, QA Engineer, Security Analyst, Triage Coordinator
- `evaluar_tarea` classifies tasks as simple/medium/complex
- Simple: direct instructions, 1 agent
- Medium: quick 2-3 agent consultation (3 rounds)
- Complex: full autonomous debate (4-6 agents, 10 rounds)

## IMPORTANT: Multi-Agent Development Pattern

When the user asks to modify, improve, or add features to this system, ALWAYS use the Agent tool to launch specialized sub-agents in parallel. Each agent works on its own file to avoid conflicts.

### Agent Roles

**Agent Motor** — Responsible for `debate-manager.cjs`
- Business logic: phases, roles, intensity, KB, rounds, proposals
- Performance: saveState debounce, batch operations
- New debate mechanics and situaciones

**Agent MCP** — Responsible for `mcp-server.js`
- MCP tool definitions (schema, descriptions, handlers)
- HTTP endpoints (SSE, StreamableHTTP, dashboard routes, API)
- Figma Make integration

**Agent UI** — Responsible for `dashboard-v2.html`, `dashboard-world.html`
- Real-time visualization, session management
- Agent World isometric view
- UX, charts, responsive design

**Agent Testing** — Responsible for `test-suite.cjs`
- Unit tests for all exported functions
- Integration tests for full debate lifecycle
- Edge cases and performance benchmarks
- Messages must be 50+ words to pass minWords validation

**Agent Features** — Responsible for `sub-groups.cjs`, `sub-groups-tools.cjs`, `validators.cjs`
- Sub-groups, pipelines, mesa system
- Validations, error handling, safe wrappers
- New modules

### How to Launch Agents

For ANY task that touches 2+ files, launch agents in parallel using the Agent tool. Example:

```
User: "Add voting system"
→ Launch 4 agents simultaneously:
  Agent Motor: add voting logic to debate-manager.cjs
  Agent MCP: add "votar" tool to mcp-server.js
  Agent UI: add voting display to dashboard-v2.html
  Agent Testing: add voting tests to test-suite.cjs
```

For single-file changes, edit directly without agents.

### After Changes
Always run the test suite to verify:
```bash
echo '{"debates":{},"nextId":1}' > debates.json
node test-suite.cjs
```

## Technical Notes

- debate-manager.cjs is CJS (require/module.exports)
- mcp-server.js is ESM (import/export) — uses createRequire to bridge
- saveState is debounced (3s timer) — use saveStateNow() for critical ops
- say() has _skipSave param for batch operations
- "libre" situacion has roles: null — always null-check
- Agent cap: 15 (with GENERIC_EXTRA_ROLES for 6-15)
- Min words per message varies by intensity (casual:50, moderado:80, adversarial:100)
- Phases: POSICIONES → CROSS-EXAMINATION → REBUTTALS → VEREDICTO
- Code proposals: propose → review (2 approvals needed) → apply → run_tests → revert if fail
- Proposals use path-jail security: only files within __dirname allowed
- dashboard-world.html uses Canvas 2D with isometric projection, pixel-art agents, idle animations
- dashboard-v2.html has session drawer, session info bar, session stats, polling every 3s/10s
- ESTÉTICA: Siempre estilo Roblox — personajes pixel-art blocky, colores vibrantes, proporciones cuadradas. Toda UI visual del proyecto debe mantener esta identidad. No cambiar a estilos realistas, flat, o minimalistas.

## Running the Server
```bash
node mcp-server.js --http 3000
ngrok http 3000
# MCP endpoint: https://<ngrok-url>/mcp
# Dashboard: http://localhost:3000/dashboard-v2
# Agent World: http://localhost:3000/world
```
