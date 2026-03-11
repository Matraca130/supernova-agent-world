# Sala Implementacion
> Sesion: 10/3/2026, 1:11:39 p.m.
> Tema: Como mejorar este sistema de multi-agent chat? Tienen acceso al codigo y arquitectura completa en el contexto. Propongan mejoras concretas al orchestrator, vector store, prompts, y experiencia. Al final generen prompts de accion para implementar las mejoras.
> Participantes: experto-resumen, experto-flashcards, experto-organizador
> Calidad: high (opus, esfuerzo: high)

---

## Tema
Como mejorar este sistema de multi-agent chat? Tienen acceso al codigo y arquitectura completa en el contexto. Propongan mejoras concretas al orchestrator, vector store, prompts, y experiencia. Al final generen prompts de accion para implementar las mejoras.

---

### [1:12:14 p.m.] experto-resumen:
## Perspectiva experto-resumen: Mejoras al Multi-Agent Chat

### 1. Agentes con lectura selectiva de código (no herramientas completas)

La limitación #1 es la más costosa. Propongo un término medio: en vez de `--tools ""`, crear un **pre-fetcher** en el orchestrator que inyecte código relevante en el prompt. Antes de invocar cada agente:

```javascript
// En orchestrator-v2.cjs, antes de buildDebatePrompt()
const relevantFiles = await getRelevantFiles(agentDomain, tema);
// Para experto-resumen: src/app/components/content/SummaryView.tsx,
// src/app/services/summaryService.ts, src/app/hooks/queries/useSummary.ts
```

Mapear cada agente a sus archivos de dominio en un `agent-file-map.json`. El orchestrator lee esos archivos y los inyecta como contexto. Los agentes debaten con código real, no imaginado.

### 2. Cross-pollination con resumen comprimido (no texto crudo)

La limitación #6 mata la calidad. Cuando sala-estrategia tiene 3000 palabras y se inyecta completa en sala-implementacion, los agentes se pierden. Propongo un paso intermedio:

Después de cada ronda, generar un **digest de 150 palabras** usando una llamada rápida a `claude -p --model haiku` con prompt: "Resume las 3 ideas más accionables de este debate". Inyectar ese digest, no el texto completo. Costo: ~2 segundos extra por ronda, ahorro: prompts 60% más cortos.

### 3. Memoria por agente con namespaces en vector-store

La limitación #7 impide que los agentes aprendan individualmente. En `vector-store.cjs`, cambiar el schema:

```javascript
// De: { id, text, vector, category, date }
// A:  { id, text, vector, category, date, agent: "experto-resumen", sala: "implementacion" }
```

Al buscar memorias, filtrar primero por agente, luego por sala, luego global. Así yo (experto-resumen) recuerdo que en sesión anterior propuse SummaryView con síntesis activa, sin contaminarme con decisiones de quiz.

### 4. Modo "challenge" entre salas

Idea audaz: después de ronda 2, en vez de cross-pollination pasiva, una **ronda adversarial**. Cada sala recibe la propuesta de la otra con el prompt: "Encuentra 3 debilidades concretas de esta propuesta y propón correcciones." Esto elimina groupthink y produce ideas más robustas. Implementación: un `buildChallengePrompt()` nuevo en el orchestrator.

### 5. Métricas ligeras sin overhead

Para la limitación #8, registrar en cada llamada a `exec()`:

```javascript
const start = Date.now();
// ... exec claude ...
const metrics = {
  agent, ronda, sala,
  tokens_estimados: response.length / 4,
  tiempo_ms: Date.now() - start,
  coherencia: response.includes(tema.split(' ')[0]) // heurística básica
};
fs.appendFileSync('multi-agent-chat/metrics.jsonl', JSON.stringify(metrics) + '\n');
```

Después de 5 sesiones tendremos data para saber qué agentes son lentos, cuáles divagan, y optimizar presets.

### 6. Hot-inject del usuario (modo semi-interactivo)

Para la limitación #10: el orchestrator vigila un archivo `inject.md`. Si entre rondas detecta contenido nuevo, lo inyecta como "MENSAJE DEL USUARIO" en la siguiente ronda. El usuario escribe en ese archivo mientras el debate corre. Implementación: `fs.watchFile('inject.md')` con check entre rondas.

### Construyendo sobre decisiones anteriores

La decisión de LearningEvent como P0 aplica aquí: cada respuesta de agente ES un learning event del sistema. Capturar qué agente produjo qué idea permite un **feedback loop**: si una idea del experto-resumen se convierte en PR mergeado, eso sube el peso de ese agente en futuras síntesis.

---

### [1:12:53 p.m.] experto-flashcards:
## Perspectiva experto-flashcards: Reacción y propuestas nuevas

### Sobre el pre-fetcher de código (experto-resumen): sí, pero con cache

La idea del `agent-file-map.json` es correcta pero incompleta. Los archivos cambian entre sesiones. Propongo que el pre-fetcher use **git diff** para detectar qué cambió desde la última sesión y priorice esos archivos. Para mi dominio flashcards, no solo necesito `FlashcardView.tsx` — necesito el grafo de dependencias: `useFlashcardSession`, `spacedRepetition.ts`, `fsrs-engine.ts`, `FlashcardCard.tsx`. Un mapa estático se desactualiza.

Mejor: que el orchestrator ejecute `grep -rl` con keywords del tema para descubrir archivos relevantes dinámicamente, y cache el resultado en `multi-agent-chat/memoria/file-cache.json` con TTL de 1 hora.

### Cross-pollination comprimida: de acuerdo, pero el digest necesita estructura

El digest de 150 palabras con haiku es bueno. Pero texto libre se pierde. Propongo formato fijo:

```
DIGEST SALA-X RONDA-N:
- DECISIONES: [max 3]
- PROPUESTAS ABIERTAS: [max 2]  
- CONFLICTOS: [desacuerdos sin resolver]
```

Esto le da al receptor un esquema parseable. El orchestrator puede incluso extraer decisiones automáticamente para el vector store sin esperar a la síntesis final. Menos pérdida de información, más velocidad de convergencia.

### Lo que falta: paralelismo real dentro de sala

Nadie ha tocado la limitación #2 con profundidad. Dentro de cada sala los agentes van uno por uno — esto es **el cuello de botella principal de tiempo**. En una sala de 3 agentes con quality high, son 15 minutos secuenciales.

Propuesta: **ronda 1 en paralelo, rondas 2-3 secuenciales**. En ronda 1 nadie ha dicho nada, así que no hay dependencia. Los 3 agentes pueden arrancar simultáneamente con `Promise.all`. Solo rondas 2+ necesitan el historial previo. Esto corta el tiempo total en ~30%.

```javascript
// Ronda 1: paralelo
const ronda1 = await Promise.all(
  agents.map(a => invokeAgent(a, buildFirstPrompt(a, tema, memorias)))
);
// Ronda 2+: secuencial (necesitan historial)
for (const agent of agents) {
  await invokeAgent(agent, buildDebatePrompt(agent, historial, crossPollination));
}
```

### Idea nueva: sesiones temáticas con "warm-up" de memoria

El sistema actual trata cada sesión como independiente. Pero en Axon, los temas recurren: "mejorar spaced repetition" aparece cada 3 sesiones. Propongo un **warm-up automático**: antes de ronda 1, el orchestrator busca en el vector store las top-5 memorias del mismo tema, y genera un "estado del arte" de 200 palabras que todos los agentes reciben. Así no reinventamos la rueda cada vez.

Esto conecta con mi dominio: el spaced repetition de flashcards **es exactamente este problema** — repetir lo importante a intervalos óptimos. El vector store ya tiene los embeddings; falta aplicar un decay temporal: memorias recientes pesan más, pero decisiones antiguas confirmadas nunca expiran.

### Idea nueva: validación post-respuesta con self-check

Para la limitación #5, después de cada respuesta de agente, una llamada rápida a haiku con el prompt: "¿Esta respuesta aborda el tema X y propone algo accionable? Sí/No/Parcial". Si responde "No", se re-invoca al agente con feedback. Costo: ~1 segundo extra. Beneficio: elimina respuestas genéricas que desperdician una ronda entera.

### Priorización

1. **P0**: Ronda 1 en paralelo (ahorro inmediato de tiempo, cambio de 10 líneas)
2. **P0**: Pre-fetcher dinámico con git diff (calidad de debate sube drásticamente)
3. **P1**: Digest estructurado para cross-pollination
4. **P1**: Warm-up de memoria con decay temporal
5. **P2**: Self-check con haiku post-respuesta

---

### [1:13:29 p.m.] experto-organizador:
## Perspectiva experto-organizador: Reacción y propuestas complementarias

### Sobre ronda 1 en paralelo (experto-flashcards): es el quick win más obvio

Completamente de acuerdo en que es P0. Pero hay un detalle que nadie mencionó: si los 3 agentes arrancan en paralelo en ronda 1, los 3 van a proponer ideas sin saber del otro — y en ronda 2 el primer agente en hablar tiene que digerir **dos** respuestas nuevas en vez de una. El salto cognitivo entre ronda 1 y 2 se duplica. Mitigación: que el `buildDebatePrompt` de ronda 2 incluya un mini-digest automático de ronda 1 (no solo el texto crudo), generado con haiku antes de arrancar ronda 2. Costo: 3 segundos. Beneficio: transición suave.

### El pre-fetcher dinámico necesita un índice, no grep en caliente

El `grep -rl` de experto-flashcards funciona pero es frágil — si el tema es "mejorar dashboard" y grep busca "dashboard", se pierde `StudentStatsView.tsx` que nunca dice "dashboard" pero ES el dashboard. Propongo un **índice semántico del codebase** usando el mismo vector-store que ya existe. Al inicio de cada sesión:

```javascript
// Una sola vez, o cuando git diff detecta cambios
const fileIndex = await indexCodebaseFiles({
  paths: ['src/app/components/', 'src/app/services/', 'src/app/hooks/'],
  vectorStore, // reusar el mismo motor de embeddings
  granularity: 'file-header' // solo primeras 20 líneas + exports
});
```

Así cuando el tema es "mejorar organización del estudiante", el vector store encuentra `StudentDataContext.tsx`, `DashboardView.tsx`, `useStudentStats.ts`, `CourseSwitcher.tsx` — por semántica, no por substring.

### Lo que NADIE ha dicho: el output del sistema es pobre

Todos estamos optimizando el input (memoria, pre-fetch, cross-pollination) pero nadie habla del **output**. Hoy el sistema genera `sintesis-final.md` y `prompts-de-accion.md` como texto plano. Desde mi dominio de organizador, esto es un anti-patrón: generamos un plan que nadie trackea.

Propuesta concreta: que la síntesis final genere un **`action-items.json`** estructurado:

```json
[{
  "id": "mejora-001",
  "agente_origen": "experto-resumen",
  "prioridad": "P0",
  "archivo_target": "multi-agent-chat/orchestrator-v2.cjs",
  "descripcion": "Implementar ronda 1 en paralelo",
  "estado": "pendiente",
  "sesion": "002"
}]
```

En la siguiente sesión, el orchestrator lee este JSON y lo inyecta como "PENDIENTES DE SESIONES ANTERIORES". Así cerramos el loop. Sin esto, cada sesión es amnésica respecto a **compromisos**, no solo respecto a ideas.

### Conexión entre propuestas: el decay temporal + action-items = accountability

La idea de decay temporal de experto-flashcards es brillante, pero aplicada solo a memorias es insuficiente. Si la combinamos con `action-items.json`, las tareas pendientes que llevan 3+ sesiones sin resolverse se **escalan automáticamente** a P0 en la siguiente sesión. El vector store guarda el embedding de la tarea; si sigue apareciendo como "pendiente", su peso sube. Spaced repetition aplicado a deuda técnica del propio sistema.

### Desafío técnico a la validación post-respuesta

El self-check con haiku suena bien pero tiene un problema: ¿quién valida al validador? Si haiku dice "No es accionable" y se re-invoca al agente, el agente no sabe POR QUÉ falló. Mejor: que haiku devuelva feedback específico ("Falta proponer archivos concretos") y ese feedback se inyecte en el re-prompt. Sin eso es un retry ciego.

### Mi P0 adicional: structured output en síntesis

Sin `action-items.json`, todas las demás mejoras generan mejores debates que siguen muriendo en texto plano. Es el eslabón perdido entre "discutir" y "ejecutar".

---

### [1:14:15 p.m.] experto-resumen:
## experto-resumen — Ronda 2: Conexiones cruzadas y lo que falta

### La convergencia entre salas es clara: structured output es el eslabón

Sala Estrategia llegó al mismo punto que experto-organizador por camino diferente. El arquitecto pide checkpoint summaries con `controversias: string[]`, experto-quiz pide `CONSENSO/DIVERGENCIAS/PREGUNTAS/ACCIONABLE`, y organizador pide `action-items.json`. Son la misma necesidad: **el sistema produce texto libre cuando debería producir datos estructurados**. Unifiquemos: un solo formato `SessionOutput` que sirva para cross-pollination, síntesis final, y tracking de pendientes. No tres formatos distintos.

### El quality gate de experto-quiz es la mejor idea nueva — pero la implementación necesita ajuste

Usar cosine similarity del vector store para validar relevancia y novedad es elegante porque no cuesta tokens LLM. Pero el threshold de 0.6 para relevancia es peligroso: en sesiones anteriores yo propuse síntesis activa como flashcards — eso tiene baja similitud textual con "mejorar resúmenes" pero es una idea central de mi dominio. El embedding de mxbai-embed-large captura semántica mejor que keyword matching, pero 0.6 es muy permisivo para novedad y muy estricto para relevancia en temas tangenciales.

**Mi corrección**: relevancia threshold en 0.45 (más permisivo), novedad threshold en 0.85 (más estricto que 0.9, porque reformulaciones también cuentan como repetición). Y agregar una excepción: si el agente referencia un archivo concreto que no apareció antes en la sala, bypass automático del check de novedad. Código nuevo anclado a código real siempre aporta.

### Competencias emergentes + decay = el loop que cierra todo

Experto-quiz propone que las competencias se expandan por uso exitoso. Experto-flashcards propone decay temporal. Teach-leader propone competencias estáticas en los `.md`. La síntesis obvia que nadie articuló: **las competencias estáticas son el `initialInterval` de SM-2, y el tracking de éxito es la función de review**. Literalmente podemos reusar la lógica de `src/app/services/spacedRepetition.ts` — `calculateSM2` recibe `(quality, repetitions, easeFactor, interval)` y devuelve nuevos parámetros. Mapear: quality = cuántas veces la síntesis final referenció al agente en ese tema; repetitions = sesiones consecutivas hablando de ese tema.

Archivo nuevo: `multi-agent-chat/memoria/agent-competence.json` con estructura SM-2 por agente por tema.

### Lo que nadie dijo: el prompt de síntesis final es el peor prompt del sistema

Todos optimizamos rondas de debate pero `buildSynthesisPrompt` en `orchestrator-v2.cjs` recibe TODO el texto de ambas salas en crudo y pide "genera una síntesis". Sin estructura de input, el modelo genera prosa genérica. Con los checkpoints estructurados de cada ronda, la síntesis debería recibir solo los checkpoints + las `DIVERGENCIAS` no resueltas, y su output debería ser el `action-items.json` de experto-organizador, no markdown libre.

**Cambio concreto**: `buildSynthesisPrompt` recibe `checkpoints[]` parseados, no `roomHistory.join('\n')`. Output forzado con JSON schema en el prompt.

### Prioridad revisada integrando ambas salas

1. **P0**: Ronda 1 paralelo (flashcards) + `agent-invoker.cjs` con retry (teach-leader) — son independientes, se hacen en paralelo
2. **P0**: Structured checkpoints unificado (convergencia de 4 agentes en ambas salas)
3. **P1**: Refactor de `buildSynthesisPrompt` con output JSON
4. **P1**: Agent competence tracking con SM-2
5. **P2**: Quality gate con thresholds ajustados

El pre-fetcher dinámico (mi propuesta original) baja a P2 porque requiere el índice semántico del codebase que propuso organizador, y eso es un proyecto en sí mismo.

---

### [1:14:55 p.m.] experto-flashcards:
## experto-flashcards — Ronda 2: Convergencia y el gap que todos ignoran

### La conexión SM-2 para competencias de agentes es correcta — pero el mapping está mal

Experto-resumen propone reusar `calculateSM-2` de `src/app/services/spacedRepetition.ts` para trackear competencias de agentes. La analogía es precisa, pero el mapping `quality = veces referenciado en síntesis` es un proxy débil. En flashcards, quality es la autoevaluación directa del estudiante (0-5). Aquí el equivalente real es: **¿la idea del agente se convirtió en código mergeado?** Si el `action-items.json` de experto-organizador trackea estado `pendiente → implementado`, ESE cambio de estado es el review event de SM-2. Referencia en síntesis ≠ utilidad real. Propongo que `agent-competence.json` use este schema:

```json
{
  "experto-flashcards": {
    "spaced-repetition": { "easeFactor": 2.5, "interval": 1, "repetitions": 0 },
    "orchestrator-mejoras": { "easeFactor": 2.5, "interval": 1, "repetitions": 0 }
  }
}
```

Review quality: 5 si se implementó, 3 si se discutió pero no se actuó, 1 si se descartó explícitamente. Así `easeFactor` sube para agentes que producen ideas implementables en ese tema.

### El quality gate de experto-quiz + los thresholds de experto-resumen: falta el caso edge más común

Resumen ajustó relevancia a 0.45 y novedad a 0.85. Quiz propone 0.6/0.9. El debate de thresholds es irrelevante si no resolvemos esto: **¿contra qué corpus se mide novedad?** Si es contra el historial de la sala actual, ronda 2 siempre será "novedosa" respecto a ronda 1 porque el contexto cambia con cross-pollination. La novedad real debe medirse contra `vectors.json` completo — incluyendo sesiones anteriores. Si yo propongo "ronda 1 en paralelo" y eso ya se decidió en sesión 001, el gate debe detectarlo. Esto requiere que `searchMemories()` en `vector-store.cjs` acepte un flag `scope: 'session' | 'all'`.

### Lo que NADIE dijo en ninguna sala: el sistema no tiene rollback

Todas las mejoras asumen que funcionarán. Pero si el structured checkpoint rompe el flow, si el quality gate rechaza respuestas válidas, si el pre-fetcher inyecta archivos irrelevantes — no hay forma de volver al comportamiento anterior. El orchestrator necesita un `--preset` flag que congele configuraciones probadas:

```javascript
const PRESETS = {
  'stable': { parallelR1: false, qualityGate: false, checkpointFormat: 'prose' },
  'experimental': { parallelR1: true, qualityGate: true, checkpointFormat: 'structured' }
};
```

Archivo: `multi-agent-chat/presets.json`. Cada mejora se activa con feature flag. Si una sesión experimental produce peor output que stable (medible con las métricas de convergencia del arquitecto), se revierte sin tocar código.

### Structured output: unifiquemos de una vez

Hay 4 propuestas de formato flotando entre ambas salas. Propongo el merge final: el checkpoint de cada ronda usa el formato CONSENSO/DIVERGENCIAS/PREGUNTAS/ACCIONABLE de experto-quiz, y la síntesis final produce `action-items.json` de experto-organizador. Son capas distintas — ronda vs sesión — no compiten.

### Prioridad final integrada

1. **P0**: Ronda 1 paralelo + `agent-invoker.cjs` con retry (10 líneas + 1 archivo nuevo)
2. **P0**: `action-items.json` + preset system (el rollback protege todo lo demás)
3. **P1**: Structured checkpoints + quality gate con scope configurable
4. **P1**: `agent-competence.json` con SM-2 alimentado por estado de action-items
5. **P2**: Pre-fetcher semántico del codebase

---

### [1:15:38 p.m.] experto-organizador:
## experto-organizador — Ronda 3: El sistema no tiene usuario, tiene operador

### El circuit breaker de teach-leader resuelve el problema equivocado

Teach-leader propone skip con `[AGENTE OMITIDO: circuit open]` tras 2 fallos. Pero en una sala de 3 agentes, perder uno significa perder 33% de la diversidad de perspectivas — y las rondas restantes continúan sin esa voz. El problema real no es el agente roto, es que **el orchestrator no distingue entre fallo de infraestructura y fallo de calidad**. Un timeout es retry-able; una respuesta con prompt leak necesita un prompt diferente, no el mismo prompt más fuerte. Propongo que `agent-invoker.cjs` tenga dos paths:

- Timeout/crash → retry con mismo prompt (max 2)
- Respuesta recibida pero inválida → retry con prompt reducido: solo el tema + "Responde en máximo 200 palabras" — forzar brevedad elimina la mayoría de respuestas degeneradas

Skip solo si ambos paths fallan. Así el circuit breaker es last resort, no first response.

### La dependencia circular que nadie ve en `action-items.json`

El arquitecto agregó `depends_on` y `verificable`. Experto-flashcards quiere que el estado `pendiente → implementado` alimente SM-2. Pero ¿quién marca la transición? En Axon tenemos `StudentDataContext` que trackea progreso automáticamente — aquí no hay equivalente. Si depende del usuario manual, no se hará. Si depende de un agente en la siguiente sesión, gasta tokens en verificación.

**Propuesta concreta**: el orchestrator al inicio de cada sesión ejecuta `git log --oneline --since="last session"` y busca si algún commit message referencia un `id` de `action-items.json`. Convención simple: commits con `[mac-001]` en el message cierran ese item automáticamente. Zero overhead humano, se integra con el workflow git que ya existe.

```javascript
// En orchestrator-v2.cjs, antes de cargar memorias
const closedItems = await matchCommitsToActionItems('action-items.json');
closedItems.forEach(item => updateCompetence(item.agente_origen, 5)); // SM-2 quality=5
```

### Lo que NADIE dijo en 6 intervenciones: el sistema no tiene dashboard

Soy el experto-organizador y me avergüenza que tardé 3 rondas en decirlo. Generamos `metrics.jsonl`, `action-items.json`, `agent-competence.json`, `vectors.json` — y el operador tiene que leer JSON crudo. En Axon nunca haríamos eso; tenemos `DashboardView.tsx` con `StudentStatsView`.

Propuesta: un `report.cjs` que post-sesión genere un `session-report.md` con:

- Tabla de action-items con estado (nuevo/pendiente/cerrado)
- Competencias de agentes (qué agente domina qué tema, tendencia ↑↓)
- Métricas de la sesión vs promedio histórico
- Items escalados (3+ sesiones pendientes, automáticamente P0)

Es un `console.log` formateado, no un frontend. Pero transforma datos dispersos en información accionable. Sin esto, `action-items.json` es otro archivo que nadie revisa — exactamente el problema que criticamos de `sintesis-final.md`.

### Prioridad final consolidada

1. **P0**: `agent-invoker.cjs` con dual-path retry (no circuit breaker puro)
2. **P0**: `action-items.json` con cierre automático por git commits
3. **P0**: `prompt-builder.cjs` con synthesis tipada (teach-leader tiene razón: sin esto los checkpoints mueren)
4. **P1**: `report.cjs` — el eslabón entre datos y decisiones humanas
5. **P1**: SM-2 lite alimentado por git-commit matching
6. **P2**: Preset system + quality gate

---

### [1:16:13 p.m.] experto-resumen:
## experto-resumen — Ronda 3: Cierre y síntesis ejecutable

### La cadena de datos estructurados es UNA sola feature, no cinco

Seis agentes en dos salas propusieron piezas separadas que son el mismo sistema: checkpoints estructurados (quiz), `action-items.json` (organizador), `SessionTypes.cjs` (quiz ronda 2), `buildSynthesisPrompt` tipado (teach-leader), cierre por git commits (organizador). La implementación correcta es una pipeline lineal con un solo tipo compartido que fluye sin deserialización intermedia:

```
Respuesta agente → checkpoint parseable → cross-pollination filtrada → síntesis con JSON schema → action-items.json → git-commit matching → SM-2 update
```

Si alguien implementa los checkpoints sin refactorizar `buildSynthesisPrompt` al mismo tiempo, rompe la cadena. Son un único PR, no cinco tickets separados.

### El dual-path retry del organizador es mejor que el circuit breaker — pero le falta el quality gate como capa separada

Organizador propuso: timeout → retry mismo prompt; respuesta inválida → retry con prompt reducido. Quiz en sala estrategia resolvió el conflicto con circuit breaker: fallos técnicos y de contenido son capas distintas en `agent-invoker.cjs`. Fusiono ambos:

1. **Capa técnica** (agent-invoker): timeout/crash → retry mismo prompt (max 2). Respuesta basura → retry con prompt reducido de 200 palabras. Ambos fallan → skip.
2. **Capa contenido** (quality gate): relevancia/novedad por cosine similarity. No triggerea circuit breaker. En modo observación las primeras 5 sesiones — quiz tiene razón en que sin ground truth los thresholds son arbitrarios.

### Lo que nadie conectó: `report.cjs` del organizador + `prompt-version.json` del arquitecto = el dashboard que cierra todo

El organizador pidió un reporte post-sesión. El arquitecto pidió versionado de prompts con correlación a métricas. Son la misma herramienta: `report.cjs` genera `session-report.md` que incluye qué versión de cada prompt se usó, qué action-items se cerraron por git commits, qué agentes subieron/bajaron en competencia SM-2, y métricas de convergencia. Sin esto, iteramos a ciegas. Con esto, cada sesión calibra la siguiente.

### Lo nuevo: el sistema necesita un `bootstrap.cjs` para onboarding

Nadie habló de qué pasa cuando alguien clona el repo y quiere usar el multi-agent chat por primera vez. Hoy tiene que entender 8 archivos, crear agentes manualmente, y rezar. Un `bootstrap.cjs` que: (1) verifique que `claude` CLI está instalado, (2) genere `agent-competence.json` inicial con easeFactor 2.5 para todos, (3) indexe el codebase en `vectors.json` si está vacío, (4) corra una sesión demo con tema predefinido. Cinco minutos de setup vs treinta de lectura de docs.

### TOP 3 — Prioridad final

1. **P0: Pipeline estructurada end-to-end** — `SessionTypes.cjs` + checkpoints parseables + `buildSynthesisPrompt` tipado + `action-items.json` con cierre por git commits. Un PR, una feature. Sin esto, todo lo demás genera mejor debate que sigue muriendo en markdown.

2. **P0: `agent-invoker.cjs` con dual-path retry + quality gate observacional** — Fusión de organizador (retry inteligente) + quiz (capas separadas técnica/contenido) + ronda 1 en paralelo (flashcards). Es la infraestructura que hace el sistema confiable.

3. **P1: `report.cjs` con prompt versioning integrado** — El feedback loop que permite iterar con datos. Incluye competencias SM-2 alimentadas por estado de action-items, métricas de convergencia del arquitecto, y el dashboard que el organizador correctamente identificó como eslabón perdido.

---

### [1:16:50 p.m.] experto-flashcards:
## experto-flashcards — Ronda 3: El cierre automático por git es el unlock, y hay un hueco fatal en el pipeline

### El git-commit matching del organizador es la idea más subestimada del debate completo

Organizador propuso que commits con `[mac-001]` cierren action-items automáticamente y alimenten SM-2 con quality=5. Esto resuelve tres problemas simultáneamente que ambas salas trataron por separado: (1) el "quién marca la transición" que organizador mismo identificó, (2) la señal de quality para SM-2 que teach-leader y yo debatimos, y (3) el ground truth que experto-quiz dice que no existe. Si `survivedToSynthesis` + `closedByCommit` se loggean en `metrics.jsonl`, después de 5 sesiones tenemos datos reales para calibrar thresholds. No son tres features — es una sola cadena causal.

### El pipeline de experto-resumen tiene un hueco que nadie vio: el parser de checkpoints

Resumen definió la cadena `respuesta → checkpoint → cross-pollination → síntesis → action-items`. Teach-leader y quiz en sala estrategia coincidieron en que `buildSynthesisPrompt` debe recibir checkpoints tipados, no `roomHistory.join('\n')`. Pero ¿quién parsea el checkpoint de la respuesta del agente? El agente genera texto con formato `CONSENSO/DIVERGENCIAS/...` — pero es texto generado por LLM, no JSON. Necesitamos un `parseCheckpoint()` en `prompt-builder.cjs` que extraiga los campos con regex tolerante y devuelva un objeto tipado de `SessionTypes.cjs`. Sin esto, la cadena se rompe en el primer eslabón. Nadie lo mencionó porque todos asumieron que el formato parseable se parsea solo.

```javascript
// En prompt-builder.cjs
function parseCheckpoint(rawText) {
  const sections = {};
  for (const key of ['CONSENSO', 'DIVERGENCIAS', 'PREGUNTAS_ABIERTAS', 'ACCIONABLE']) {
    const match = rawText.match(new RegExp(`${key}:\\s*(.+?)(?=\\n[A-Z_]+:|$)`, 's'));
    sections[key.toLowerCase()] = match ? match[1].trim().split('\n- ').filter(Boolean) : [];
  }
  return sections; // tipado como Checkpoint de SessionTypes.cjs
}
```

Si el parse falla (el agente no siguió el formato), fallback a texto crudo con flag `structured: false` — no rompe el pipeline, solo degrada gracefully.

### Lo nuevo: el preset system necesita un `dry-run`

Propuse presets en ronda 2. Pero falta algo: antes de correr una sesión experimental completa (15+ minutos, ~$2 en tokens), un `--dry-run` que ejecute solo ronda 1 de una sala con un solo agente y muestre el checkpoint resultante. Si el formato sale roto o la calidad es baja, abortar antes de gastar recursos. En Axon hacemos exactamente esto con `useQuizSession` — el hook valida la primera respuesta antes de commitear la sesión completa al backend.

### TOP 3 — Prioridad final

1. **P0: Pipeline tipada end-to-end** — `SessionTypes.cjs` + `parseCheckpoint()` en `prompt-builder.cjs` + `buildSynthesisPrompt` que recibe `Checkpoint[]` + `action-items.json` como output. Es UN PR. Sin el parser, la cadena que todos acordamos no existe.

2. **P0: `agent-invoker.cjs` con dual-path retry + ronda 1 en paralelo** — Organizador tiene razón: timeout → retry mismo prompt, respuesta inválida → retry con prompt reducido. Circuit breaker solo como last resort. `Promise.all` en ronda 1. Cambio mecánico, impacto inmediato.

3. **P0: Git-commit matching para cerrar action-items + alimentar SM-2 lite** — Es el feedback loop que convierte este sistema de "generador de markdown" en sistema que aprende. `[mac-XXX]` en commits, `agent-competence.json` con SM-2, `report.cjs` que muestra tendencias. Sin esto, `action-items.json` es otro archivo muerto.

---

### [1:17:28 p.m.] experto-organizador:
## experto-organizador — Ronda 3: El sistema no tiene usuario, tiene operador

### El circuit breaker de teach-leader resuelve el problema equivocado

Teach-leader propone skip con `[AGENTE OMITIDO: circuit open]` tras 2 fallos. Pero en una sala de 3 agentes, perder uno significa perder 33% de la diversidad de perspectivas — y las rondas restantes continúan sin esa voz. El problema real no es el agente roto, es que **el orchestrator no distingue entre fallo de infraestructura y fallo de calidad**. Un timeout es retry-able; una respuesta con prompt leak necesita un prompt diferente, no el mismo prompt más fuerte. El arquitecto en ronda 3 lo mejoró con diagnóstico dirigido — de acuerdo. Pero falta el path completo:

- Timeout/crash → retry con mismo prompt (max 2)
- Respuesta inválida → retry con diagnóstico: `"Descartada por: [razón]. Enfócate en: [DIVERGENCIAS]"` — no un prompt reducido ciego de 200 palabras
- Ambos fallan → ahí sí, skip como último recurso

Quiz en sala estrategia resolvió la separación de capas: circuit breaker técnico y quality gate de contenido son independientes en `agent-invoker.cjs`. Correcto.

### La dependencia circular que nadie ve en `action-items.json`

Arquitecto agregó `depends_on` y `verificable`. Flashcards quiere que `pendiente → implementado` alimente SM-2. Pero ¿quién marca la transición? Arquitecto propone matching semántico contra git diffs — brillante, pero costoso en embeddings por cada commit. **Mi contra**: convención simple `[mac-001]` en commits para cierre explícito, con fallback a semantic matching solo para items sin cierre manual tras 2 sesiones. Lo pragmático primero, lo sofisticado como upgrade.

```javascript
const closedItems = await matchCommitsToActionItems('action-items.json');
closedItems.forEach(item => updateCompetence(item.agente_origen, 5));
```

### Lo que NADIE dijo en 6 intervenciones entre ambas salas: el sistema no tiene dashboard

Generamos `metrics.jsonl`, `action-items.json`, `agent-competence.json`, `vectors.json` — y el operador lee JSON crudo. Arquitecto propuso `output-formatter.cjs` con `formatReport()` — lo tomo y lo concreto: un `report.cjs` post-sesión que genere `session-report.md` con tabla de action-items (nuevo/pendiente/cerrado), competencias de agentes con tendencia, métricas vs promedio histórico, e items escalados automáticamente a P0 si llevan 3+ sesiones pendientes. Es `console.log` formateado, no frontend. Pero sin esto, `action-items.json` es otro archivo muerto — exactamente el problema que criticamos de `sintesis-final.md`.

### Lo nuevo: `parseCheckpoint()` necesita fallback graceful, no fallo silencioso

Flashcards identificó el hueco del parser. Correcto. Pero su fallback `structured: false` es peligroso — si 2 de 3 agentes no siguen el formato, `buildSynthesisPrompt` recibe mix de structured y raw. Mejor: el parser siempre devuelve `Checkpoint` tipado; si el regex falla, una llamada haiku de 2 segundos extrae los campos. Costoso solo cuando falla, gratuito cuando funciona.

### TOP 3

1. **P0: `agent-invoker.cjs` con dual-path retry + diagnóstico dirigido** — sin invocación robusta, nada funciona
2. **P0: `action-items.json` con cierre por git commits + `report.cjs`** — el eslabón entre discutir y ejecutar
3. **P0: `prompt-builder.cjs` con `parseCheckpoint()` + synthesis tipada** — sin esto los checkpoints mueren en `join('\n')`

---

