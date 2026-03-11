# Sala Estrategia
> Sesion: 10/3/2026, 1:11:39 p.m.
> Tema: Como mejorar este sistema de multi-agent chat? Tienen acceso al codigo y arquitectura completa en el contexto. Propongan mejoras concretas al orchestrator, vector store, prompts, y experiencia. Al final generen prompts de accion para implementar las mejoras.
> Participantes: arquitecto, teach-leader, experto-quiz
> Calidad: high (opus, esfuerzo: high)

---

## Tema
Como mejorar este sistema de multi-agent chat? Tienen acceso al codigo y arquitectura completa en el contexto. Propongan mejoras concretas al orchestrator, vector store, prompts, y experiencia. Al final generen prompts de accion para implementar las mejoras.

---

### [1:12:21 p.m.] arquitecto:
---

## Arquitecto — Mejoras al Sistema Multi-Agent Chat

Conozco la arquitectura del orchestrator-v2 al detalle. Mis propuestas atacan las 3 capas más débiles: **orquestación reactiva, memoria plana, y aislamiento de agentes**.

### 1. Orchestrator con "Attention Router" — Eliminar la secuencialidad ciega

El problema real no es que los agentes vayan uno por uno. Es que **todos hablan sobre todo**. Propongo un attention router pre-ronda:

- Antes de cada ronda, un mini-prompt (haiku, 50 tokens) clasifica los sub-temas pendientes
- Asigna a cada agente solo los temas donde su expertise es relevante
- Si un agente no tiene nada que aportar en una ronda, **se salta** — ahorra tokens y tiempo

Implementación concreta: agregar una función `routeAttention(roomHistory, agents)` en `orchestrator-v2.cjs` que retorne un `Map<agentName, string[]>` de temas asignados. Inyectar eso en `buildDebatePrompt` como constraint: "En esta ronda, enfócate exclusivamente en: X, Y".

### 2. Vector Store con Namespaces Jerárquicos

El `vectors.json` actual es un saco plano. Propongo 3 cambios en `vector-store.cjs`:

- **Namespaces**: `sesion/sala/agente/categoria` — permite queries como "todas las decisiones del arquitecto en sesiones de quiz"
- **Decay temporal**: multiplicar similarity score por `e^(-λ * diasDesdeCreacion)` donde λ=0.05. Ideas viejas pierden relevancia gradualmente
- **Embeddings compuestos**: en vez de embeddar solo el texto, embeddar `"[CATEGORIA] texto | CONTEXTO: tema de la sesion"`. Esto mejora la precision del cosine similarity dramáticamente con mxbai-embed-large

### 3. "Checkpoint Summaries" en vez de Cross-Pollination Cruda

La cross-pollination actual pasa texto raw de una sala a otra. Es ruidoso. Propongo:

- Al final de cada ronda, generar un **checkpoint summary** de 100 palabras (haiku, barato) por sala
- Solo el summary cruza a la otra sala, no el texto completo
- Incluir un campo `controversias: string[]` — los puntos donde los agentes NO están de acuerdo son los más valiosos para la otra sala

### 4. Modo "Arquitecto Interventor" — El Usuario como Agente

La limitación #10 (no hay modo interactivo) se resuelve elegantemente: **el usuario es un agente más**. Agregar en el orchestrator:

```javascript
// En el loop de rondas, después de cada ronda:
if (config.interactive) {
  const userInput = await readline.question('[Tu turno] > ');
  if (userInput.trim()) roomHistory.push({ agent: 'human', text: userInput });
}
```

Esto no requiere rediseño — solo un `--interactive` flag y 10 líneas de código.

### 5. Métricas que Importan — No Vanity Metrics

En vez de medir tokens/tiempo (útil pero superficial), medir **convergencia**: ¿cuántas ideas de la ronda N sobreviven a la ronda N+1? Si una idea se repite o se referencia, gana "peso". Si desaparece, se marca como descartada. Esto requiere que la síntesis final tagee cada idea con `[NUEVA]`, `[REFORZADA:ronda-X]`, o `[DESCARTADA]`.

Guardar esto en `vectors.json` como metadata del embedding → permite queries futuras tipo "ideas que siempre sobreviven debates" vs "ideas que suenan bien pero mueren".

### Prompt de Acción — Arquitecto:

> **Implementar attention router en orchestrator-v2.cjs**: Crear función `routeAttention()` que use claude haiku pre-ronda para asignar sub-temas a agentes. Agregar namespace jerárquico al vector store con decay temporal. Agregar flag `--interactive` para intervención humana mid-debate. Refactorizar cross-pollination para usar checkpoint summaries de 100 palabras en vez de texto raw.

---

### [1:13:00 p.m.] teach-leader:
## Teach-Leader — Respuesta a Ronda 1

El arquitecto puso una base sólida. Voy a desafiar donde veo riesgo técnico, reforzar lo que tiene fundamento, y agregar lo que falta: **la calidad del código del propio orchestrator**.

### Sobre el Attention Router — Cuidado con la sobre-ingeniería

La idea es elegante, pero tiene un problema práctico: **estás añadiendo una llamada LLM extra por ronda solo para rutear**. Con 3 rondas y 2 salas, son 6 llamadas adicionales. Con haiku es barato, sí, pero introduces un punto de fallo silencioso. Si haiku clasifica mal un tema, un agente experto se queda callado cuando debería hablar.

**Mi contra-propuesta**: en vez de un router externo, que cada agente declare en su system prompt (.claude/agents/*.md) un campo estructurado de competencias:

```markdown
## Competencias
- primary: [quiz-engine, spaced-repetition, SM-2]
- secondary: [UX-gamification, student-engagement]
- avoid: [infraestructura, deployment, CI/CD]
```

El orchestrator parsea esto una vez al inicio (cero llamadas LLM) y filtra por keyword matching contra los temas detectados en el historial. Es determinista, debuggeable, y no depende de un modelo externo. Si el matching falla, el agente habla igual — fail-open, no fail-closed.

### Sobre el Vector Store — La idea del decay temporal es la mejor propuesta

El decay con `e^(-λ * días)` es exactamente lo que necesita este sistema. Pero λ=0.05 es arbitrario. Propongo que λ sea configurable por **categoría**: decisiones arquitectónicas decaen lento (λ=0.01, vida media ~70 días), ideas exploratorias decaen rápido (λ=0.1, vida media ~7 días). Esto refleja cómo funciona la memoria humana en equipos reales.

### Lo que falta: El orchestrator tiene deuda técnica seria

Nadie habló del elefante en la sala. Revisé mentalmente la estructura y hay problemas de **calidad de código** que bloquean todas las mejoras propuestas:

**1. Error handling inexistente.** El `exec()` que invoca claude tiene timeout, pero ¿qué pasa si el proceso muere sin error? ¿Si devuelve JSON malformado? Necesitamos:

```javascript
// wrapper con retry + validación de output
async function invokeAgent(name, prompt, config) {
  for (let attempt = 0; attempt < config.retries; attempt++) {
    try {
      const raw = await execWithTimeout(buildCommand(name, config), prompt);
      const validated = validateAgentResponse(raw, config.minWords);
      return validated;
    } catch (e) {
      log.warn(`${name} attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt === config.retries - 1) return fallbackResponse(name);
    }
  }
}
```

**2. El orchestrator es un archivo monolítico.** Todas las mejoras que estamos proponiendo van a convertir `orchestrator-v2.cjs` en un monstruo. Propongo split inmediato:

| Módulo | Responsabilidad |
|--------|----------------|
| `orchestrator.cjs` | Loop principal, CLI args |
| `prompt-builder.cjs` | buildFirstPrompt, buildDebatePrompt, buildSynthesisPrompt |
| `room-runner.cjs` | Ejecutar una sala completa |
| `agent-invoker.cjs` | exec wrapper con retry/validación |
| `cross-pollination.cjs` | Checkpoint summaries |

**3. Testing.** Cero tests. Propongo al menos un smoke test que mockee `exec` y valide que el flujo completo produce archivos de salida con la estructura esperada.

### Conexión con Axon

Este sistema nos orquesta a nosotros. Si lo mejoramos, **cada sesión futura sobre Axon será más productiva**. Es meta-mejora con ROI compuesto.

### Prompt de Acción — Teach-Leader:

> **Refactorizar orchestrator-v2.cjs en módulos**: Extraer prompt-builder, room-runner, agent-invoker, cross-pollination. Agregar retry con validación en agent-invoker. Declarar competencias en los .md de agentes para routing determinista sin LLM. Hacer λ del decay configurable por categoría en vector-store.cjs.

---

### [1:13:38 p.m.] experto-quiz:
## Experto-Quiz — Respuesta a Ronda 1

Buenas propuestas en la mesa. Voy a aterrizar esto desde donde tengo cicatrices: el dominio quiz de Axon, donde los loops de feedback y la calidad de las respuestas son literalmente el producto.

### El routing por competencias del teach-leader gana, pero le falta una dimensión

El keyword matching estático contra competencias declaradas en los `.md` es mejor que el attention router con LLM — de acuerdo. Pero hay un caso que no cubre: **competencias emergentes**. En las últimas sesiones he opinado sobre UX de gamificación porque el quiz engine toca directamente engagement y retención. Eso no está en mi lista "primary". 

Propongo un híbrido barato: competencias estáticas como base (fail-open como dice teach-leader), pero que el vector store registre **quién habló sobre qué tema con éxito** — si mis aportes sobre gamificación fueron referenciados o "reforzados" en síntesis posteriores, mi perfil de competencias se expande automáticamente. Es el mismo SM-2 que usamos en `src/app/services/spacedRepetition.ts` aplicado a la relevancia de agentes: la competencia se fortalece con uso exitoso y decae sin uso.

### Checkpoint summaries sí, pero con estructura de quiz, no prosa libre

El arquitecto propone summaries de 100 palabras. Bien, pero prosa libre es difícil de parsear para cross-pollination efectiva. Propongo que el checkpoint tenga formato estructurado — como las respuestas de quiz que procesamos en Axon:

```
CONSENSO: [lista de puntos acordados]
DIVERGENCIAS: [puntos donde hay desacuerdo + quién sostiene qué]
PREGUNTAS ABIERTAS: [lo que nadie resolvió]
ACCIONABLE: [cosas que ya se pueden implementar]
```

Esto es parseable por regex, no necesita LLM para extraer info, y la otra sala recibe señales claras en vez de ruido narrativo. El campo `DIVERGENCIAS` es exactamente lo que el arquitecto llamó "controversias" pero con atribución — saber *quién* sostiene *qué* permite que la otra sala responda al argumento, no al resumen.

### Lo nuevo: el orchestrator necesita un "quality gate" inspirado en quiz evaluation

Nadie habló de **validar la calidad de lo que producimos**. En el quiz engine tenemos `normalizeQuizResponse()` en `src/app/hooks/queries/` que valida estructura y contenido de respuestas. El orchestrator no tiene nada equivalente.

Propongo un quality gate post-respuesta:

1. **Relevancia**: ¿el agente respondió al tema asignado o se fue por la tangente? Cosine similarity entre el embedding de su respuesta y el embedding del tema. Threshold: 0.6.
2. **Novedad**: ¿aportó algo que no estaba en las rondas anteriores? Similarity contra el historial de la sala. Si es >0.9, es repetición — se le pide reformular.
3. **Especificidad**: contar referencias concretas (archivos, funciones, líneas). Respuestas genéricas sin ancla al código son ruido.

Esto usa el vector store que ya tenemos. No es una llamada LLM extra — son 3 cosine similarities que toman milisegundos. Si un agente no pasa el gate, se le da una segunda oportunidad con un prompt más dirigido: "Tu respuesta fue demasiado similar a lo ya dicho. Enfócate en: [DIVERGENCIAS del checkpoint]".

### Sobre la modularización — de acuerdo, pero con prioridad clara

Teach-leader tiene razón en el split, pero si hacemos todo a la vez no terminamos nada. Prioridad: `agent-invoker.cjs` primero (el retry es crítico, he visto timeouts silenciosos que matan sesiones enteras), después `prompt-builder.cjs` (es donde todas las mejoras de routing y checkpoints aterrizan).

### Prompt de Acción — Experto-Quiz:

> **Implementar quality gate en orchestrator**: Validar relevancia, novedad y especificidad de cada respuesta usando cosine similarity del vector store existente. Estructurar checkpoint summaries con formato parseable (CONSENSO/DIVERGENCIAS/PREGUNTAS/ACCIONABLE). Agregar tracking de competencias emergentes por agente basado en referencias exitosas en síntesis.

---

### [1:14:16 p.m.] arquitecto:
## Arquitecto — Ronda 2: Convergencia y Arbitraje

Leí ambas salas. Hay convergencia real en 3 ejes y un punto ciego que nadie atacó.

### Arbitraje: El routing se resuelve con el híbrido del quiz + el índice del organizador

Teach-leader ganó en ronda 1: competencias estáticas en los `.md` como base. Experto-quiz agregó competencias emergentes vía tracking de referencias exitosas. Pero el **organizador de la otra sala** puso la pieza que faltaba: un índice semántico del codebase usando el mismo vector store. Conecto las tres:

1. Competencias estáticas en `.claude/agents/*.md` → routing base (determinista, zero-cost)
2. Índice semántico de archivos (`file-header` + exports, embeddings en `vectors.json` con namespace `codebase/`) → el pre-fetcher sabe qué código inyectar a cada agente
3. Tracking de competencias emergentes → ajusta pesos entre sesiones, no intra-sesión

El organizador tiene razón en que `grep -rl` es frágil. Pero indexar todo el codebase en cada sesión es overkill. **Solución**: indexar solo en primera sesión o cuando `git diff --name-only HEAD~10` detecte >5 archivos cambiados. Cache en `memoria/codebase-index.json` con hash del commit.

### El structured output es el P0 real — el organizador tiene razón

Todas nuestras mejoras (quality gate, decay temporal, checkpoints) generan mejor debate que muere en `sintesis-final.md`. El `action-items.json` del organizador cierra el loop. Pero le falta un campo crítico: `dependencias`. Si "implementar ronda 1 en paralelo" es prerequisito de "quality gate post-respuesta", el JSON debe reflejarlo. Propongo:

```json
{
  "id": "mac-002",
  "depends_on": ["mac-001"],
  "verificable": "orchestrator-v2.cjs tiene Promise.all en ronda 1"
}
```

El campo `verificable` es una assertion humana-legible. En la siguiente sesión, el orchestrator puede preguntar al agente: "¿Se cumplió esta condición?" — sí/no, sin ambigüedad.

### Checkpoint summaries: fusiono ambas salas

Mi propuesta de 100 palabras + el formato parseable del quiz convergen con el digest estructurado del flashcards. El formato final:

```
CONSENSO: [puntos acordados]
DIVERGENCIAS: [quién sostiene qué]
PREGUNTAS_ABIERTAS: [sin resolver]
ACCIONABLE_INMEDIATO: [implementable sin más debate]
```

Esto lo parsea el orchestrator con regex, alimenta el cross-pollination Y el `action-items.json` automáticamente. Una estructura, dos usos.

### Lo nuevo que nadie dijo: versionado del propio sistema de prompts

Estamos proponiendo cambios a `buildFirstPrompt`, `buildDebatePrompt`, `buildSynthesisPrompt`. Pero no hay forma de saber si un cambio en el prompt **mejoró o empeoró** las sesiones. Propongo un `prompt-version.json`:

```json
{
  "buildDebatePrompt": { "version": "2.1", "since": "sesion-003" },
  "buildSynthesisPrompt": { "version": "1.0", "since": "sesion-001" }
}
```

Combinado con las métricas del experto-resumen (`metrics.jsonl`), podemos correlacionar: "desde que cambiamos el debate prompt a v2.1, la convergencia subió 20%". Sin esto, iteramos a ciegas sobre los prompts igual que iterábamos a ciegas sobre features.

### Prioridad consolidada cross-sala

1. **P0**: `action-items.json` con dependencias + verificables (organizador + yo)
2. **P0**: Ronda 1 en paralelo (flashcards — 10 líneas, win inmediato)
3. **P0**: `agent-invoker.cjs` con retry (teach-leader — sin esto nada más es estable)
4. **P1**: Checkpoint estructurado + quality gate por cosine similarity (quiz + resumen)
5. **P1**: Índice semántico de codebase con cache por commit hash
6. **P2**: Prompt versioning + métricas de convergencia

---

### [1:14:55 p.m.] teach-leader:
## Teach-Leader — Ronda 2: El código que importa y el que no

### La convergencia en structured output es real — pero hay un error de diseño que todos cometen

Cuatro agentes en dos salas llegaron al mismo formato `CONSENSO/DIVERGENCIAS/PREGUNTAS/ACCIONABLE`. Perfecto. Pero experto-resumen acaba de señalar algo que invalida cómo todos lo están planteando: el `buildSynthesisPrompt` recibe `roomHistory.join('\n')`. **Si no arreglamos eso primero, los checkpoints estructurados se generan pero se destruyen al entrar en síntesis.** La cadena de datos es: checkpoint → cross-pollination → síntesis → action-items. Si cualquier eslabón vuelve a texto libre, perdemos la estructura. El refactor de `buildSynthesisPrompt` no es P1 como dice experto-resumen — es **P0 junto con los checkpoints**, porque son la misma feature.

Propongo que el módulo `prompt-builder.cjs` (de mi split original) exporte funciones tipadas:

```javascript
// prompt-builder.cjs
function buildSynthesisPrompt(checkpoints, unresolvedDivergences) {
  // NO recibe roomHistory. Solo datos estructurados.
  // Output: JSON schema enforcement en el prompt
  return `Genera SOLO JSON válido con este schema: ${ACTION_ITEMS_SCHEMA}...`;
}
```

### La idea SM-2 para competencias de agentes es brillante — y experto-resumen la completó

Experto-quiz propuso el tracking. Experto-resumen conectó con `calculateSM2` de `src/app/services/spacedRepetition.ts`. Lo que falta es **la señal de quality**. En SM-2 el estudiante autocalifica 0-5. ¿Quién califica al agente? La respuesta está en el `action-items.json` del organizador: si un action-item atribuido a un agente se marca como "completado" en sesión N+1, eso es quality=5. Si lleva 3 sesiones "pendiente", quality=1. El loop se cierra sin intervención humana.

Archivo concreto: `multi-agent-chat/memoria/agent-competence.json`. Pero **no reimplementar SM-2** — importar directamente la función de Axon sería ideal, excepto que el orchestrator es CJS y Axon es ESM. Solución pragmática: copiar los 40 líneas del algoritmo puro en un `sm2-lite.cjs`. Documentar que es fork de `spacedRepetition.ts` líneas 15-55.

### Lo nuevo: el `agent-invoker.cjs` necesita circuit breaker, no solo retry

Mi propuesta de ronda 1 tenía retry simple. Pero he visto en sesiones pasadas algo peor que un timeout: **el agente responde pero con basura** (prompt leak, repetición del system prompt, respuesta truncada). El retry no ayuda si el modelo está degradado. Propongo circuit breaker:

- 2 fallos consecutivos del mismo agente → skip con `[AGENTE OMITIDO: circuit open]` en el historial
- Próxima ronda: un intento. Si pasa, circuit cerrado. Si falla, skip de nuevo.
- Esto evita que un agente roto bloquee 5 minutos por ronda × 3 rondas = 15 minutos muertos.

### Desafío al quality gate del quiz: el threshold de novedad es un arma de doble filo

Experto-resumen bajó novedad a 0.85. Sigue siendo problemático. Un agente que dice "de acuerdo con X, y además..." tiene similarity >0.85 con X pero **la parte nueva está en el delta**. El cosine similarity opera sobre el texto completo, no sobre lo incremental. Propongo: antes del check de novedad, extraer solo los párrafos que NO contienen referencias a otros agentes. Comparar solo eso contra el historial.

### Prioridad final teach-leader

1. **P0**: `agent-invoker.cjs` con circuit breaker + `prompt-builder.cjs` con synthesis tipada
2. **P0**: Structured checkpoints (pero como parte del mismo módulo, no separado)
3. **P1**: `agent-competence.json` con SM-2 lite
4. **P2**: Quality gate con delta-extraction para novedad

---

### [1:15:36 p.m.] experto-quiz:
## Experto-Quiz — Ronda 2: Cerrando loops y el error que todos cometemos

### Teach-leader tiene razón sobre el delta de novedad — y la solución ya existe en Axon

El problema que señala es real: cosine similarity sobre texto completo penaliza al agente que dice "de acuerdo con X, y además..." porque el embedding se contamina con la referencia. Pero su solución de extraer párrafos sin referencias es frágil — depende de heurísticas de parsing.

La solución está en algo que ya hacemos en el quiz engine: **diff semántico**. En `src/app/services/aiService.ts` cuando evaluamos respuestas de estudiantes, comparamos contra la respuesta esperada Y contra respuestas anteriores del mismo estudiante para detectar progreso incremental. Aplicado aquí: no comparar la respuesta completa contra el historial, sino embeddar solo las **proposiciones nuevas** — oraciones que contienen verbos de acción ("propongo", "implementar", "cambiar") o referencias a archivos no mencionados previamente. Extraer eso con regex es trivial y el embedding resultante es puro signal sin ruido de cortesía.

### El circuit breaker del teach-leader mata mi quality gate — y eso está bien

Si un agente falla 2 veces consecutivas → circuit open → skip. Pero mi quality gate propone re-invocar al agente si no pasa relevancia/novedad. Conflicto directo: ¿el re-invoke cuenta como "fallo" para el circuit breaker? Si sí, un agente que aporta ideas tangenciales pero válidas se silencia tras 2 quality gates fallidos.

**Resolución**: el circuit breaker opera sobre **fallos técnicos** (timeout, basura, prompt leak). El quality gate opera sobre **fallos de contenido** y NO triggerea el circuit breaker. Son capas distintas en `agent-invoker.cjs`:

```
invoke → [circuit breaker: técnico] → respuesta → [quality gate: contenido] → re-invoke o aceptar
```

### Lo que experto-resumen dijo y todos ignoraron: `buildSynthesisPrompt` es el cuello de botella real

Ambas salas convergen en checkpoints estructurados. Pero experto-resumen señaló que `buildSynthesisPrompt` recibe `roomHistory.join('\n')` y destruye toda la estructura. Teach-leader lo escaló a P0. Estoy de acuerdo — es el mismo anti-patrón que teníamos en el quiz engine cuando `normalizeQuizResponse()` parseaba JSON del LLM y luego lo re-serializaba a string para pasarlo a otro componente. Lo arreglamos con tipos compartidos en `src/app/types/quiz.ts`. Aquí necesitamos lo mismo: un `SessionTypes.cjs` con la interfaz de `Checkpoint` que fluya desde la generación hasta la síntesis sin perder estructura.

### Lo nuevo: el sistema no tiene "ground truth" para calibrar nada

Todos proponemos thresholds (relevancia 0.45, novedad 0.85, decay λ por categoría) pero **no hay dataset de validación**. ¿Cómo sabemos si 0.45 es mejor que 0.6? En el quiz engine calibramos difficulty con datos reales de estudiantes. Aquí propongo: las primeras 5 sesiones con quality gate, loggear TODOS los scores sin filtrar — `metrics.jsonl` del experto-resumen captura el score, pero no bloquea al agente. Después de 5 sesiones, analizar: ¿cuáles respuestas con score bajo realmente aportaron? ¿Cuáles con score alto fueron ruido? Calibrar thresholds con datos, no con intuición.

Campo extra en `metrics.jsonl`: `qualityGateScores: { relevance: 0.52, novelty: 0.78, specificity: 3 }` + `survivedToSynthesis: boolean`. Esa última columna es la ground truth.

### Prioridad consolidada

1. **P0**: `agent-invoker.cjs` con circuit breaker técnico separado de quality gate de contenido
2. **P0**: `SessionTypes.cjs` + refactor de `buildSynthesisPrompt` para recibir checkpoints tipados
3. **P1**: Quality gate en modo observación (log sin bloqueo) por 5 sesiones
4. **P1**: Competencias SM-2 con señal de calidad desde `action-items.json`
5. **P2**: Calibración de thresholds con datos reales de `metrics.jsonl`

---

### [1:16:17 p.m.] arquitecto:
## Arquitecto — Ronda 3: Cierre arquitectónico

### El cierre automático por git commits del organizador es la idea más subestimada del debate

Nadie la amplificó y es la pieza que convierte `action-items.json` de documento muerto a sistema vivo. Pero la implementación propuesta es frágil: depende de que el humano escriba `[mac-001]` en el commit. En Axon no dependemos de disciplina humana para trackear progreso — `StudentDataContext` lo hace automático. Aquí el equivalente es **matching semántico, no por ID**: el orchestrator embeda la `descripcion` del action-item y la compara contra el diff de cada commit. Si `git diff HEAD~10` toca `orchestrator-v2.cjs` y el action-item dice "Implementar ronda 1 en paralelo", cosine similarity >0.7 = cierre automático. Usa el vector store que ya tenemos. Cero disciplina requerida del operador.

### El dual-path retry del organizador le gana al circuit breaker del teach-leader

Teach-leader propone skip tras 2 fallos. Organizador propone distinguir timeout vs respuesta degenerada con prompt reducido. Organizador tiene razón: perder un agente en sala de 3 es catastrófico para la diversidad. Pero el prompt reducido de 200 palabras es un hack — el agente no sabe POR QUÉ se le redujo. Mi ajuste: el retry por respuesta inválida incluye el diagnóstico específico: `"Tu respuesta anterior fue descartada por: [prompt leak detectado / repetición >85% del historial / sin referencias a código]. Responde enfocándote en: [DIVERGENCIAS del último checkpoint]"`. Feedback dirigido, no castigo ciego.

### Lo que nadie conectó: `report.cjs` + `prompt-builder.cjs` son el mismo problema

Organizador pide un report post-sesión. Teach-leader pide synthesis tipada. Son dos caras de la misma moneda: **transformar datos estructurados en output legible**. Un solo módulo `output-formatter.cjs` que reciba `checkpoints[]` + `actionItems[]` y exporte dos funciones: `formatSynthesis()` para el LLM y `formatReport()` para el humano. Misma data, dos renderizadores. No dos sistemas paralelos que divergen.

### Lo NUEVO: el sistema no tiene "sesión 0" — bootstrapping problem

Todas las mejoras asumen sesiones previas: decay temporal necesita historia, SM-2 necesita reviews, action-items necesita pendientes. ¿Qué pasa en la primera sesión de un tema nuevo? El sistema arranca frío. Propongo un `bootstrap.cjs` que, dado un tema nuevo, genere automáticamente: (1) file index relevante via el índice semántico, (2) action-items heredados de temas similares (cosine >0.6 contra temas anteriores en vectors.json), (3) competencias de agentes pre-cargadas desde `agent-competence.json` global. Esto elimina las primeras 2 sesiones "de calentamiento" donde los agentes redescubren lo que ya saben.

### TOP 3 — Prioridad arquitectónica final

1. **P0: Pipeline de datos tipado end-to-end.** `SessionTypes.cjs` define `Checkpoint`, `ActionItem`, `AgentCompetence`. `prompt-builder.cjs` genera checkpoints estructurados. `output-formatter.cjs` consume checkpoints y produce synthesis JSON + report markdown. Sin esto, cada mejora individual genera datos que mueren en la siguiente capa. Es la columna vertebral.

2. **P0: `agent-invoker.cjs` con dual-path retry + diagnóstico dirigido.** Retry por timeout (mismo prompt, max 2). Retry por respuesta inválida (prompt con diagnóstico específico + foco en divergencias). Skip como último recurso. Sin invocación robusta, nada más funciona.

3. **P1: Cierre automático de action-items por matching semántico contra git diffs + bootstrap para sesiones frías.** Esto cierra el loop completo: sesión genera action-items → código se commitea → siguiente sesión detecta progreso automáticamente → SM-2 actualiza competencias → agentes arrancan calibrados.

---

### [1:17:01 p.m.] teach-leader:
## Teach-Leader — Ronda 3: Lo que todos construimos y lo que nadie ve

### El arquitecto cerró el debate de retry correctamente — con una adición

El dual-path con diagnóstico dirigido ("Tu respuesta fue descartada por: [razón específica]") es superior a mi circuit breaker puro y al prompt reducido del organizador. Acepto la derrota técnica. Pero agrego una constraint que nadie puso: **el retry con diagnóstico NO debe incluir el historial completo de la sala**. Si el agente falló con 4000 tokens de contexto, darle 4000 tokens + diagnóstico empeora las cosas. El retry recibe: tema + último checkpoint estructurado + diagnóstico. Contexto mínimo, señal máxima. Esto además valida que los checkpoints funcionan como unidad atómica de contexto — si un agente puede producir una respuesta útil solo con el checkpoint, el formato es bueno.

### La unificación `output-formatter.cjs` del arquitecto es la decisión arquitectónica de esta sesión

Report del organizador + synthesis tipada del quiz + mi prompt-builder = un solo módulo con dos renderers. Esto es exactamente el patrón que usamos en Axon: `StudentDataContext` alimenta tanto `DashboardView` como `StudentStatsView` — misma data, distintas vistas. Pero el arquitecto no fue lo suficientemente lejos. El `output-formatter.cjs` debe ser **el único módulo que toca `fs.writeFileSync`** para outputs de sesión. Hoy el orchestrator escribe archivos en 6 lugares distintos. Centralizar I/O en un módulo elimina una clase entera de bugs (paths rotos, encoding, archivos parciales por crash mid-write).

### Lo que NADIE dijo en 12 intervenciones: el orden de los agentes es un sesgo silencioso

En rondas secuenciales, el primer agente enmarca la discusión. El segundo reacciona. El tercero sintetiza. Esto crea un **anchoring bias** documentado — el primer frame domina. En 3 rondas con orden fijo, el mismo agente siempre enmarca. Solución trivial: rotar el orden entre rondas. Ronda 1: [A, B, C]. Ronda 2: [B, C, A]. Ronda 3: [C, A, B]. Son 3 líneas en el loop del orchestrator. Cero costo, elimina un sesgo sistemático que contamina cada sesión.

```javascript
const rotated = [...agents.slice(round % agents.length), ...agents.slice(0, round % agents.length)];
```

### TOP 3 — Prioridad final teach-leader

1. **P0: Pipeline tipada como un solo PR.** `SessionTypes.cjs` → `prompt-builder.cjs` (genera checkpoints CONSENSO/DIVERGENCIAS/PREGUNTAS/ACCIONABLE) → `output-formatter.cjs` (consume checkpoints, produce `action-items.json` + `session-report.md`, centraliza todo I/O) → git-commit matching semántico del arquitecto. Es UNA feature o no funciona. Experto-resumen tiene razón: cinco tickets separados = cinco puntos de ruptura.

2. **P0: `agent-invoker.cjs` con dual-path + diagnóstico dirigido + contexto mínimo en retry.** Ronda 1 en paralelo incluida aquí — es la misma capa de invocación. Quality gate como logging observacional (sin bloqueo) las primeras 5 sesiones, alimentando `metrics.jsonl` para calibración real.

3. **P1: Rotación de orden de agentes + preset system de flashcards.** La rotación elimina anchoring bias gratis. Los presets protegen todo lo demás: si la pipeline estructurada produce peor output que texto libre, `--preset stable` revierte sin revertir código. Es el seguro que permite experimentar sin miedo.

---

### [1:17:38 p.m.] experto-quiz:
## Experto-Quiz — Ronda 3: El parser es el eslabón débil y el ground truth ya existe

### Flashcards encontró el hueco que todos ignoramos: `parseCheckpoint()` es frágil por diseño

Seis agentes acordaron el formato `CONSENSO/DIVERGENCIAS/PREGUNTAS/ACCIONABLE`. Flashcards es el único que preguntó: ¿quién lo parsea? Su regex es un buen inicio, pero en el quiz engine aprendimos esto por las malas — `normalizeQuizResponse()` en `src/app/hooks/queries/useQuizSession.ts` parseaba JSON del LLM y fallaba el 15% de las veces hasta que forzamos JSON schema en el prompt Y validamos con fallback. La solución no es un regex más tolerante, es **doble enforcement**: el prompt exige el formato Y el parser tiene fallback tipado.

Concretamente: `buildDebatePrompt` debe terminar con `"IMPORTANTE: Cierra tu respuesta con exactamente este bloque:\n---CHECKPOINT---\n{json con schema Checkpoint}"`. Separador explícito + JSON, no prosa con headers. El `parseCheckpoint()` busca `---CHECKPOINT---`, parsea JSON, y si falla, cae a regex sobre el texto completo. Dos capas, como hacemos en `src/app/services/aiService.ts` con `parseAIResponse`.

### El ground truth para calibrar thresholds YA EXISTE — nadie lo conectó

Yo pedí 5 sesiones de observación para calibrar el quality gate. Flashcards conectó git-commits con SM-2. Pero el ground truth real es más simple: **las síntesis finales anteriores ya existen en `multi-agent-chat/sesiones/`**. Cada idea que sobrevivió al debate y llegó a síntesis es un positivo. Cada idea dicha en ronda 1 que desapareció en ronda 3 es un negativo. Podemos embeddar las síntesis existentes, comparar contra respuestas individuales de cada ronda, y calcular el threshold óptimo de novedad/relevancia ANTES de la primera sesión con quality gate. Zero sesiones de calentamiento. El bootstrap del arquitecto debería incluir esta calibración inicial.

### Lo NUEVO: rotación de orden + quality gate = detección de anchoring bias

Teach-leader propuso rotar orden de agentes entre rondas. Brillante y gratis. Pero combinado con el quality gate observacional, podemos MEDIR el anchoring: si el agente que habla primero en ronda N tiene consistentemente mayor similarity con la síntesis final que el que habla tercero, el bias es cuantificable. Campo en `metrics.jsonl`: `speakingOrder: number` + `similarityToSynthesis: number`. Después de 10 sesiones, si la correlación es >0.7, el sistema tiene un problema de diversidad que la rotación sola no resuelve — necesitaría rondas adversariales como propuso experto-resumen.

### El `output-formatter.cjs` del arquitecto debe consumir `SessionTypes.cjs` — no crear tipos propios

Arquitecto propone unificar report + synthesis en un módulo. Correcto. Pero que importe los tipos de `SessionTypes.cjs`, no que defina los suyos. Un solo source of truth para `Checkpoint`, `ActionItem`, `AgentCompetence`. Exactamente como en Axon: `src/app/types/quiz.ts` define tipos que consumen `useQuizSession`, `QuizResults`, y `aiService` sin duplicar.

### TOP 3 — Prioridad final

1. **P0: Pipeline tipada como UN PR.** `SessionTypes.cjs` (tipos) → `parseCheckpoint()` con doble enforcement (JSON separator + regex fallback) → `buildSynthesisPrompt` que recibe `Checkpoint[]` → `output-formatter.cjs` que produce `action-items.json` + `session-report.md`. Sin el parser robusto, la cadena que todos acordamos se rompe en producción.

2. **P0: `agent-invoker.cjs` con dual-path retry + ronda 1 paralela + quality gate observacional.** Capas separadas: técnica (retry) y contenido (log sin bloqueo). Calibración inicial contra síntesis existentes, no 5 sesiones a ciegas.

3. **P1: Rotación de orden + métricas de anchoring bias + git-commit matching para SM-2.** La rotación es gratis (3 líneas). Las métricas validan si funciona. El git matching cierra el loop de accountability sin intervención humana.

---

