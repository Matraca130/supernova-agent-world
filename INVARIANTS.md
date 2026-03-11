# INVARIANTS — Multi-Agent Chat System

Reglas que NUNCA deben romperse. Si un cambio viola un invariante, el PR no se mergea.

---

## 1. Archivos siempre .cjs
Todos los módulos del sistema multi-agent usan extensión `.cjs` porque el `package.json` raíz tiene `"type": "module"`.

## 2. Shell: true obligatorio
Toda invocación de `exec()`/`execFile()` que llame a `claude` DEBE usar `{ shell: true }` para que Windows resuelva `claude.cmd`.

## 3. stdin via input, nunca cat
Los prompts se pasan a `claude -p` mediante la propiedad `input` de `exec()`, NO mediante `cat file | claude`.

## 4. Quality Gate nunca bloquea
`quality-gate.cjs` es observacional. NUNCA debe rechazar, filtrar, o modificar una respuesta de agente. Solo mide y loggea.

## 5. Checkpoint format es estable
```
---CHECKPOINT---
{ "consenso": [], "divergencias": [], "accionable": [], "preguntas": [] }
---END---
```
El formato de checkpoint NO cambia sin migrar todos los parsers.

## 6. Vector store es append-only
`memoria/memories.json` solo crece. Nunca se borran memorias existentes. Solo se agregan nuevas.

## 7. Action items ID format
IDs siguen el formato `mac-XXX` (e.g., `mac-001`). Los IDs son únicos y monotónicamente crecientes.

## 8. SM-2 easeFactor mínimo 1.3
Nunca permitir `easeFactor < 1.3` (piso del algoritmo SM-2).

## 9. Prompts no hardcodean nombres de agente
Los prompts deben usar el nombre del agente como parámetro, no hardcodear "arquitecto" o "teach-leader".

## 10. Sessions dir siempre existe
Antes de escribir cualquier archivo en `sessions/`, verificar que el directorio existe con `mkdirSync({ recursive: true })`.

## 11. Timeout con fallback
Si un agente no responde dentro del timeout, se usa `emptyCheckpoint()`. NUNCA se cuelga el orchestrator esperando indefinidamente.

## 12. No secrets en outputs
Los archivos de sesión (`sala-*.md`, `session-report.md`) NUNCA deben contener tokens, API keys, o paths absolutos del usuario.

## 13. Métricas son idempotentes
Escribir la misma métrica dos veces no debe corromper `metrics.jsonl`. Cada línea es independiente.

## 14. Cross-pollination solo desde round 2
En round 1, cada sala trabaja independientemente. La cross-pollination solo inyecta contexto de la otra sala a partir de round 2+.

## 15. Competencias se persisten entre sesiones
`agent-competence.json` se carga al inicio y se guarda al final de cada sesión. Las competencias son acumulativas.
