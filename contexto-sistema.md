# Arquitectura del Sistema Multi-Agent Chat v4

Este es el sistema que ustedes usan para comunicarse. Su tarea es mejorarlo.

## Arquitectura v4: Parallel + Curator

```
RONDA 1:  5 agentes piensan EN PARALELO
              ↓
          teach-leader CURA (filtra, prioriza, genera brief)
              ↓
RONDA 2:  5 agentes reciben el brief curado, piensan EN PARALELO
              ↓
          teach-leader CURA de nuevo
              ↓
RONDA N:  ... (repite)
              ↓
SÍNTESIS: teach-leader genera síntesis final + action items + prompts
```

**Diferencia clave vs v3:** No hay "salas". Todos los agentes ven todo. El teach-leader NO debate — arbitra y cura entre rondas.

## Estructura de archivos

```
multi-agent-chat/
├── orchestrator-v4.cjs      ← Motor principal (parallel + curator)
├── orchestrator-v3.cjs      ← v3 legacy (2 salas paralelas)
├── orchestrator-v2.cjs      ← v2 legacy
├── orchestrator.cjs          ← v1 legacy (secuencial)
│
├── agent-invoker.cjs         ← Invocación de agentes con retry
├── prompt-builder.cjs        ← Construcción de prompts y parseo de checkpoints
├── SessionTypes.cjs          ← Tipos y validadores (Checkpoint, ActionItem)
│
├── output-formatter.cjs      ← Genera action-items.json y session-report.md
├── quality-gate.cjs          ← Scoring observacional (relevance, novelty, specificity)
├── sm2-lite.cjs              ← Competencias de agentes (SM-2 spaced repetition)
├── git-tracker.cjs           ← Cierra action items por commits
├── analyze-bias.cjs          ← Análisis de sesgos (speaking order, dominancia)
├── report.cjs                ← Dashboard standalone: node report.cjs
├── presets.json              ← Configuraciones: quick, stable, high, experimental
├── agent-competence.json     ← Estado SM-2 de cada agente (persiste entre sesiones)
│
├── INVARIANTS.md             ← 15 reglas que nunca se rompen
├── TEST-PLAN.md              ← 8 tests manuales
├── contexto-sistema.md       ← Este archivo
│
├── debate-paralelo.md        ← Chat completo v4 (se regenera cada sesion)
├── sala-estrategia.md        ← Chat sala 1 (legacy v3)
├── sala-implementacion.md    ← Chat sala 2 (legacy v3)
├── sintesis-final.md         ← Síntesis del teach-leader
├── prompts-de-accion.md      ← Prompts generados para cada agente
├── metrics.jsonl             ← Métricas por turno y sesión
│
├── run-v4.bat                ← Lanzador v4
├── run-v3.bat                ← Lanzador v3
│
├── sessions/
│   ├── action-items.json     ← Action items acumulados entre sesiones
│   ├── session-report.md     ← Último reporte
│   └── v4-{timestamp}/      ← Archivos archivados por sesión
│
└── memoria/
    ├── historial.json        ← Sesiones en JSON (backup texto)
    ├── memoria-acumulada.md  ← Resumen legible (fallback)
    ├── vector-store.cjs      ← Motor de embeddings (Ollama + mxbai-embed-large)
    └── memories.json         ← Base de vectores (embeddings almacenados)
```

## Módulos del sistema

### orchestrator-v4.cjs — Motor principal
Flujo:
1. Parsea argumentos: --quality, --rounds, --agents, --context, tema
2. Carga competencias SM-2 y reordena agentes por competencia en el tema
3. Busca memorias semánticas relevantes vía vector-store (Ollama)
4. Por cada ronda:
   a. 5 agentes piensan EN PARALELO (Promise.all)
   b. teach-leader cura: filtra duplicados, marca contradicciones, prioriza, genera brief
   c. El brief se inyecta como contexto en la siguiente ronda
5. teach-leader genera síntesis final
6. Extrae ideas/decisiones → vector store con embeddings
7. Genera prompts de acción por agente
8. Git tracker cierra action items matcheados con commits
9. Extrae action items de checkpoints, deduplica, escala prioridades
10. Actualiza competencias SM-2 de cada agente
11. Genera session-report.md y archiva la sesión

### agent-invoker.cjs — Invocación de agentes
```javascript
// Invoca un agente con retry (max 2 intentos)
invokeAgent(agentName, prompt, { model, effort, timeout })
// → { response, attempts, elapsed }

// Invoca N agentes en paralelo
invokeParallel([{ agent, prompt }, ...], options)
// → [{ agent, response, attempts, elapsed }, ...]
```

Usa `exec()` con `shell: true` y pasa el prompt vía `stdin.write()`.

### prompt-builder.cjs — Prompts y checkpoints
- `parseCheckpoint(raw, agentName, round)` — 3 paths: JSON → regex → empty
- `buildFirstPrompt({...})` — ronda 1 con contexto + memoria
- `buildDebatePrompt({...})` — ronda 2+ con cross-pollination (v3)
- `buildSynthesisPrompt(...)` — síntesis con checkpoints
- `buildActionPromptsPrompt(...)` — prompts por agente
- `CHECKPOINT_INSTRUCTIONS` — formato estándar de checkpoint

### output-formatter.cjs — Escritura de outputs
- `formatActionItems(checkpoints, sessionId)` — extrae accionables, deduplica, escala P0
- `formatReport({...})` — genera session-report.md con tablas
- `archiveSession(sessionId)` — copia archivos a sessions/{id}/

### quality-gate.cjs — Scoring observacional (NUNCA bloquea)
- `measureRelevance(response, topic)` — cosine similarity vía vector store
- `measureNovelty(response)` — 1 - max similarity contra memorias
- `measureSpecificity(response)` — regex count de paths, hooks, endpoints
- `scoreResponse(...)` → composite score 0-1

### sm2-lite.cjs — Competencias de agentes
Fork del SM-2 de `src/app/services/spacedRepetition.ts` adaptado para agentes:
- quality 5 = checkpoint estructurado + accionables
- quality 3 = checkpoint estructurado sin accionables
- quality 1 = sin checkpoint
- `getAgentWeight(comp, topic)` — peso 0-1 por easeFactor + domain match
- `rankAgents(competences, topic)` — ordena agentes por competencia

### git-tracker.cjs — Cierre automático de action items
- Busca tags `[mac-XXX]` en commit messages
- Fuzzy match por similitud Jaccard de palabras
- Cierra items en action-items.json

### analyze-bias.cjs — Análisis de sesgos
Script standalone: `node analyze-bias.cjs`
- Speaking order bias: correlación Pearson orden vs quality score
- Dominance bias: ratio de action items por agente
- Novelty decay: novedad promedio por ronda

## Formato de Checkpoint (estable — no cambiar sin migrar)
```
---CHECKPOINT---
{"consenso":["punto 1"],"divergencias":["punto 1"],"preguntas":["pregunta 1"],"accionable":["accion 1"]}
---END---
```

## Formato de Action Item
```json
{
  "id": "mac-001",
  "description": "texto",
  "status": "new|pending|done",
  "priority": "P0|P1|P2",
  "assignedAgent": "arquitecto",
  "mentionedBy": ["arquitecto", "teach-leader"],
  "createdSession": "v4-123456",
  "closedBy": "abc1234",
  "sessionsPending": 0,
  "escalated": false
}
```

## Quality presets (presets.json)
| Preset | Modelo | Palabras | Esfuerzo | Timeout | Features |
|--------|--------|----------|----------|---------|----------|
| quick | sonnet | 200 | medium | 90s | minimal |
| stable | sonnet | 300 | high | 120s | sin quality gate ni competencias |
| normal | sonnet | 300 | medium | 120s | básico |
| high | opus | 500 | high | 300s | quality gate + competencias |
| experimental | opus | 800 | high | 300s | todo + bias analysis + shuffle |
| max | opus | 800 | max | 600s | todo al máximo |

## Como se invocan los agentes
```javascript
const child = exec(
  'claude -p --agent "nombre" --model opus --effort high --tools ""',
  { shell: true, timeout: 300000, cwd: PROJECT_DIR }
);
child.stdin.write(prompt);
child.stdin.end();
```
- `--tools ""` deshabilita herramientas (solo texto)
- `--agent` usa los .md de `.claude/agents/` como system prompt
- `shell: true` obligatorio para Windows (resuelve claude.cmd)
- Prompt por stdin para evitar problemas de encoding

## Memoria semántica (vector-store.cjs)
- Ollama local (http://localhost:11434) con modelo mxbai-embed-large
- Cada memoria = vector de 1024 dimensiones
- Búsqueda por cosine similarity
- Categorías: ideas, decisiones, conclusiones, pendientes, arquitectura
- Append-only: nunca se borran memorias

## Agentes disponibles (.claude/agents/)
| Agente | Rol en v4 | Dominios |
|--------|-----------|----------|
| teach-leader | **CURADOR** — filtra, prioriza, sintetiza | quality, patterns, validation, testing |
| arquitecto | Pensador — arquitectura, módulos, tipos | orchestrator, architecture, modules, types |
| experto-quiz | Pensador — quiz adaptativo, métricas | quiz, adaptive, metrics, assessment |
| experto-flashcards | Pensador — flashcards, SM-2, parsing | flashcards, spaced-repetition, parsing, sm2 |
| experto-resumen | Pensador — síntesis, contenido | summary, synthesis, content, formatting |
| experto-organizador | Pensador — dashboard, git, scheduling | dashboard, organization, git, scheduling |

## Tecnologías
- Node.js (CommonJS .cjs por "type": "module" en package.json)
- Claude Code CLI (`claude -p`)
- Ollama + mxbai-embed-large (embeddings locales)
- JSON files como base de datos
- exec/child_process para invocar claude

## Comandos útiles
```bash
# Ejecutar sesión v4
node multi-agent-chat/orchestrator-v4.cjs --quality high --rounds 3 "tema"

# Ver estado del sistema
node multi-agent-chat/report.cjs

# Analizar sesgos
node multi-agent-chat/analyze-bias.cjs

# Lanzadores Windows
multi-agent-chat\run-v4.bat
```
