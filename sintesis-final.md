# Sintesis Final — v4
> 10/3/2026, 2:12:04 p.m.
> Tema: Como mejorar la integracion de IA en Axon

---

# SÍNTESIS EJECUTIVA — Integración de IA en Axon

## Debate Paralelo: 5 Agentes × 3 Rondas | Convergencia Final: 100% contradicciones resueltas

---

## 1. LAS 5 MEJORES IDEAS (Priorizadas)

### 🥇 #1 — EventBus + Inferencia de Confianza Implícita
| | |
|---|---|
| **Qué es** | Sistema nervioso de telemetría: `eventBus.ts` captura cada interacción del estudiante, enriquece con confianza implícita (`responseTimeMs`, `answerChanges`, `eliminatedOptions`), bufferiza en IndexedDB, y flushea en batch a Edge Function `/events/batch`. `confidenceInference.ts` calcula `impliedConfidence` que **gobierna FSRS/BKT** — el slider explícito post-respuesta es solo dato metacognitivo. |
| **Quién** | **Organizador** (infraestructura EventBus) + **Quiz** (algoritmo `inferConfidence()`) — co-autoría. Validado por Arquitecto, Resumen, Flashcards. |
| **Impacto** | 🔴 **Crítico** — Sin esto, nada funciona. Todo downstream (flashcards inteligentes, digest, probes, grafo de confusiones) depende de eventos ricos fluyendo. |
| **Esfuerzo** | **M** (2-3 días) — Tipos + EventBus + heurísticas + Edge Function en un solo PR. |
| **Prioridad** | **P0** — PR-1 (tipos) + PR-2 (bus+inferencia). Merge primero, sin debate. |

**Decisión clave:** El slider de confianza se muestra post-respuesta desde día 1 (4/5 agentes). No hay gaming porque el estudiante ya respondió. Pero `impliedConfidence` (señales implícitas) es lo que entra al loop de scheduling — el slider nunca toca FSRS.

---

### 🥈 #2 — Flashcards Polimórficas: 4 Templates + 3 IA
| | |
|---|---|
| **Qué es** | `FlashcardUnion` discriminado por 7 `cardType`: **4 determinísticos** (cloze, differential, reversal, image-occlusion) que funcionan día 1 sin IA + **3 generados por IA** (clinical-scenario, mechanism-chain, vertical-integration) que se activan con datos suficientes. `DifferentialCard` usa `confusion_edges` para atacar exactamente los pares de conceptos confundidos. |
| **Quién** | **Flashcards** (diseño completo del sistema de tipos + factories). Potenciado por Quiz (confusionGraph alimenta DifferentialCard) y Arquitecto (shouldCallAI=false para cold-start). |
| **Impacto** | 🔴 **Alto** — Valor inmediato sin costo de IA. Los templates determinísticos cubren ~80% de cards. DifferentialCard es la killer feature: flashcards quirúrgicas basadas en errores reales. |
| **Esfuerzo** | **M** (3-4 días) — Tipos + 4 factories + SQL tabla `flashcards` con `card_data jsonb`. |
| **Prioridad** | **P1** — PR-4, paralelo con PR-3. Depende de PR-1. |

---

### 🥉 #3 — ConfusionGraph con Cold-Start Poblacional
| | |
|---|---|
| **Qué es** | Tabla `confusion_edges` en Supabase que mapea keyword↔keyword por patrones de co-error. Columna `population_count` permite que estudiantes nuevos vean confusiones típicas de la cohorte antes de tener datos propios. Materialización en React Query (`staleTime: 10min`). Edge Function cron procesa eventos del EventBus. |
| **Quién** | **Arquitecto** (grafo original como InferenceGraph) + **Quiz** (ErrorTopology con datos poblacionales) — fusionados por teach-leader en Ronda 1. |
| **Impacto** | 🔴 **Alto** — Sin esto, la IA es genérica. Con esto, es quirúrgica. Alimenta DifferentialCards, probes diagnósticos, y la sección "Attention" del digest. |
| **Esfuerzo** | **M** (3-4 días) — SQL + Edge Function + service + hook. |
| **Prioridad** | **P1** — PR-3, paralelo con PR-4. Depende de PR-1. |

---

### #4 — InsightDigest con Fallback Determinístico
| | |
|---|---|
| **Qué es** | Al abrir la app, el estudiante ve un digest de 4 secciones fijas: **Strength** (top keywords), **Attention** (keywords débiles + confusiones), **Pattern** (arquetipo de estudio), **NextAction** (UNA sola acción recomendada — no lista). Lazy on open, no cron. Fallback para cold-start (<10 eventos): `archetype: 'cold-start'`, insight motivacional honesto, nextAction = `take-quiz`. |
| **Quién** | **Resumen** (diseño completo del tipo + hook + fallback). Refinado por Organizador (Pattern honesto, no inventado) y Arquitecto (nextAction accionable). |
| **Impacto** | 🟡 **Medio-Alto** — Es la interfaz visible de toda la IA. Cierra el feedback loop metacognitivo. Pero depende de que haya eventos fluyendo (PR-1+PR-2). |
| **Esfuerzo** | **S** (2 días) — Tipo + hook con fallback + conexión al endpoint cuando exista. |
| **Prioridad** | **P1** — PR-5. Depende de PR-1 + PR-2. |

---

### #5 — Learner Profile + AI Orchestrator (Facade Client-Side)
| | |
|---|---|
| **Qué es** | `learner-profile.ts` clasifica estudiantes en 5 arquetipos por umbrales heurísticos (cramming, steady, coasting, struggling, cold-start) — **reemplaza XGBoost/ONNX** que se mató en Ronda 2. `ai-orchestrator.ts` es facade client-side que decide cuál de los 3 endpoints llamar basándose en FSRS + BKT locales. `shouldCallAI()` retorna `false` para cold-start = cero costo de IA para estudiantes nuevos. |
| **Quién** | **Arquitecto** (diseño completo). Validado cuando todos acordaron matar ONNX (5/5). |
| **Impacto** | 🟡 **Medio** — Es el cerebro que decide "¿qué necesita este estudiante ahora?". Pero el valor tangible lo entregan los endpoints que orquesta (PR-7). |
| **Esfuerzo** | **S** (2 días) — Heurísticas simples + facade con switch por arquetipo. |
| **Prioridad** | **P1** — PR-6. Depende de PR-1 + PR-2. |

---

## 2. CONEXIONES ENTRE AGENTES

```
┌─────────────────────────────────────────────────────────────────┐
│                    MAPA DE SINERGIAS                            │
│                                                                 │
│   ORGANIZADOR ──────────────── QUIZ                             │
│   (EventBus, tipos P0)        (confidenceInference)             │
│        │  co-autoría PR-2          │                            │
│        │                           │                            │
│        ▼                           ▼                            │
│   LearningEvent ──────────► ConfusionGraph ◄──── ARQUITECTO    │
│   (alimenta todo)           (Supabase tabla)     (InferenceGraph│
│        │                         │                 original)    │
│        │                         │                     │        │
│        ▼                         ▼                     ▼        │
│   FLASHCARDS ◄──────── DifferentialCard        ai-orchestrator  │
│   (4 templates)         (killer feature:       (facade que      │
│                          usa confusion_edges)   decide endpoint) │
│        │                         │                     │        │
│        │                         ▼                     │        │
│        └────────────────► InsightDigest ◄──────────────┘        │
│                           (RESUMEN)                             │
│                           (muestra todo al estudiante)          │
└─────────────────────────────────────────────────────────────────┘
```

### Sinergias clave:

| Conexión | Descripción | Potenciación |
|----------|-------------|--------------|
| **Quiz → Flashcards** | `confusion_edges` alimenta `DifferentialCard` | Un error en quiz genera automáticamente una flashcard que ataca exactamente esa confusión |
| **Organizador → Todos** | `LearningEvent` enriquecido es el contrato compartido | Un solo tipo fundacional que todos consumen — cero duplicación |
| **Quiz ↔ Arquitecto** | `confidenceInference` + `learner-profile` | Señales implícitas clasifican al estudiante sin preguntarle nada |
| **Resumen ← Todos** | InsightDigest consume datos de todos los demás | El digest es la "ventana" — muestra strengths (FSRS), attention (confusionGraph), pattern (learner-profile), nextAction (orchestrator) |
| **Arquitecto → Flashcards** | `shouldCallAI()=false` para cold-start | Los 4 templates determinísticos cubren 100% de estudiantes nuevos sin gastar en IA |

### Fusiones realizadas (teach-leader):
1. **InferenceGraph** (Arquitecto) + **ErrorTopology** (Quiz) = **ConfusionGraph** — mismo concepto, una sola implementación
2. **ConfidenceCalibration** (Quiz) + **CalibrationChart** (Resumen) = un hook + un componente
3. **Endpoint unificado** (Organizador R1) → **Endpoints especializados** (Flashcards ganó el argumento, Organizador retractó)

---

## 3. ROADMAP

### Fase 1 — Fundamento (Semanas 1-2)

```
Semana 1                          Semana 2
─────────────────────────────     ─────────────────────────────
PR-1: Tipos fundacionales         PR-2: EventBus + Inferencia
  ├─ learningEvent.ts               ├─ eventBus.ts (IndexedDB buffer)
  ├─ aiAction.ts                     ├─ confidenceInference.ts
  ├─ aiContract.ts                   ├─ Edge Function /events/batch
  ├─ queryKeys.ts (ai.*)             └─ Tests end-to-end
  ├─ SQL: learning_events
  └─ SQL: confusion_edges
  
  Owner: Organizador                 Owner: Organizador + Quiz
  Depende: Nada                      Depende: PR-1
  Review: Todo el equipo             Review: Todo el equipo
```

**Entregable Fase 1:** Eventos ricos fluyen del cliente al servidor. Confianza implícita calculada automáticamente. Base de datos lista para todos los PRs downstream. **Cero IA involucrada todavía.**

### Fase 2 — Features Core (Semanas 3-6)

```
Semana 3-4 (paralelos)            Semana 5-6 (paralelos)
─────────────────────────────     ─────────────────────────────
PR-3: ConfusionGraph               PR-5: InsightDigest
  ├─ confusionGraph.ts                ├─ insightDigest.ts
  ├─ useConfusionGraph hook           ├─ useInsightDigest.ts
  ├─ Edge Fn process-events           ├─ buildDeterministicFallback()
  └─ Vercel cron trigger              └─ barrel ai/index.ts

PR-4: Flashcards                   PR-6: Orchestration
  ├─ flashcard.ts (7 tipos)          ├─ learner-profile.ts (5 arquetipos)
  ├─ flashcard-generator.ts          └─ ai-orchestrator.ts (facade)
  ├─ 4 template factories
  └─ SQL: flashcards (jsonb)

  PR-3 Owner: Arquitecto + Quiz    PR-5 Owner: Resumen
  PR-4 Owner: Flashcards           PR-6 Owner: Arquitecto
```

**Entregable Fase 2:** Flashcards determinísticas funcionando. Grafo de confusiones computándose. Digest con fallback visible. Orchestrator decidiendo acciones. **Todo funciona sin IA — templates y heurísticas cubren el 80%.**

### Fase 3 — IA + Integración (Semanas 7-12)

```
Semana 7-8                         Semana 9-12
─────────────────────────────     ─────────────────────────────
PR-7: Edge Functions IA            P2: Prototipos
  ├─ ai-shared/prompt-context.ts     ├─ Triage Mode (Flashcards)
  ├─ ai-generate-deck (Haiku)        ├─ Modo Radiografía (Arquitecto)
  ├─ ai-generate-probe (Haiku)       ├─ Profesor Fantasma (Organizador)
  ├─ ai-generate-digest (Haiku)      └─ PeerInsight (Resumen)
  └─ Sonnet para batch nocturno
  
  Owner: Todos contribuyen          Validar con usuarios primero
```

**Entregable Fase 3:** IA activa — 3 tipos de flashcard generados por Haiku, probes diagnósticos, digest enriquecido por LLM. Modelo económico: ~$0.02/día/estudiante. Prototipos P2 en validación UX.

---

## 4. ARQUITECTURA PROPUESTA

```
╔══════════════════════════════════════════════════════════════════════════╗
║                        AXON AI ARCHITECTURE                            ║
╠══════════════════════════════════════════════════════════════════════════╣
║                                                                        ║
║  ┌─────────────────────── CLIENTE (React) ────────────────────────┐    ║
║  │                                                                 │    ║
║  │  ┌──────────┐    ┌──────────────┐    ┌─────────────────────┐   │    ║
║  │  │ Quiz UI  │    │ Flashcard UI │    │ InsightDigest UI    │   │    ║
║  │  │          │    │              │    │ (4 secciones fijas)  │   │    ║
║  │  └────┬─────┘    └──────┬───────┘    └──────────┬──────────┘   │    ║
║  │       │                 │                       │               │    ║
║  │       ▼                 ▼                       ▼               │    ║
║  │  ┌─────────────────────────────────────────────────────────┐   │    ║
║  │  │              ai-orchestrator.ts (FACADE)                │   │    ║
║  │  │  ┌─────────────────┐  ┌──────────────────────────────┐ │   │    ║
║  │  │  │ learner-profile │  │ shouldCallAI(profile,events) │ │   │    ║
║  │  │  │ 5 arquetipos    │  │ false → template/heurística  │ │   │    ║
║  │  │  │ heurísticos     │  │ true  → endpoint IA          │ │   │    ║
║  │  │  └─────────────────┘  └──────────────────────────────┘ │   │    ║
║  │  └──────────────┬─────────────────────┬────────────────────┘   │    ║
║  │                 │                     │                         │    ║
║  │       ┌─────────▼──────────┐   ┌─────▼──────────────────┐     │    ║
║  │       │ FALLBACK LOCAL     │   │ React Query (ai.*)     │     │    ║
║  │       │ • FSRS scheduling  │   │ • useInsightDigest     │     │    ║
║  │       │ • BKT diagnosis    │   │   (staleTime: 30min)   │     │    ║
║  │       │ • 4 template       │   │ • useConfusionGraph    │     │    ║
║  │       │   factories        │   │   (staleTime: 10min)   │     │    ║
║  │       │ • Deterministic    │   │ • useAIRecommendation  │     │    ║
║  │       │   fallback         │   │   (staleTime: 5min)    │     │    ║
║  │       │ [MANEJA EL 80%]    │   │ • useFlashcardDeck     │     │    ║
║  │       └────────────────────┘   └─────────┬──────────────┘     │    ║
║  │                                          │                     │    ║
║  │  ┌───────────────────────────────────────┼─────────────────┐  │    ║
║  │  │          eventBus.ts                  │                 │  │    ║
║  │  │  ┌────────────┐  ┌────────────────┐   │                 │  │    ║
║  │  │  │ IndexedDB  │  │ confidenceInf. │   │                 │  │    ║
║  │  │  │ buffer     │→ │ enrich pipeline│   │                 │  │    ║
║  │  │  └────────────┘  └───────┬────────┘   │                 │  │    ║
║  │  └──────────────────────────┼────────────┼─────────────────┘  │    ║
║  └─────────────────────────────┼────────────┼─────────────────────┘    ║
║                                │            │                          ║
║ ═══════════════════════════════╪════════════╪════════════════ HTTP ═══ ║
║                                │            │                          ║
║  ┌─────────────────── SUPABASE EDGE FUNCTIONS ────────────────────┐   ║
║  │                             │            │                      │   ║
║  │  ┌──────────────────────────▼──┐  ┌──────▼──────────────────┐  │   ║
║  │  │  /events/batch              │  │  ai-shared/             │  │   ║
║  │  │  • Validate & persist       │  │  prompt-context.ts      │  │   ║
║  │  │  • Rate limit               │  │  (LearningContext →     │  │   ║
║  │  │  • Enrich server-side       │  │   prompt para Haiku)    │  │   ║
║  │  └──────────────┬──────────────┘  └──────┬──────────────────┘  │   ║
║  │                 │                        │                      │   ║
║  │                 ▼                        ▼                      │   ║
║  │  ┌──────────────────────┐  ┌─────────────────────────────────┐ │   ║
║  │  │ process-learning-    │  │  3 Endpoints Especializados     │ │   ║
║  │  │ events (Vercel cron) │  │  ┌───────────┐ ┌────────────┐  │ │   ║
║  │  │ • Compute confusion  │  │  │ai-generate│ │ai-generate │  │ │   ║
║  │  │   edges              │  │  │-deck      │ │-probe      │  │ │   ║
║  │  │ • Update population  │  │  │(Haiku)    │ │(Haiku)     │  │ │   ║
║  │  │   counts             │  │  └───────────┘ └────────────┘  │ │   ║
║  │  └──────────┬───────────┘  │  ┌────────────┐                │ │   ║
║  │             │              │  │ai-generate │                │ │   ║
║  │             ▼              │  │-digest     │                │ │   ║
║  │  ┌──────────────────────┐ │  │(Haiku/     │                │ │   ║
║  │  │     SUPABASE DB      │ │  │ Sonnet)    │                │ │   ║
║  │  │  ┌────────────────┐  │ │  └────────────┘                │ │   ║
║  │  │  │learning_events │  │ └─────────────────────────────────┘ │   ║
║  │  │  │(metadata jsonb)│  │                                      │   ║
║  │  │  ├────────────────┤  │                                      │   ║
║  │  │  │confusion_edges │  │                                      │   ║
║  │  │  │(population_cnt)│  │                                      │   ║
║  │  │  ├────────────────┤  │                                      │   ║
║  │  │  │flashcards      │  │                                      │   ║
║  │  │  │(card_data jsonb)│ │                                      │   ║
║  │  │  └────────────────┘  │                                      │   ║
║  │  └──────────────────────┘                                      │   ║
║  └────────────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════════════════════════════════════════════════╝
```

### Principios arquitectónicos (consenso 5/5):

1. **El cliente es el cerebro** — `ai-orchestrator.ts` decide; el servidor solo ejecuta
2. **80% sin IA** — FSRS + BKT + templates determinísticos son el camino feliz
3. **React Query es la ÚNICA capa de estado para IA** — no hay AIContext, no se extiende StudentDataContext
4. **Haiku para real-time, Sonnet para batch** — ~$0.02/día/estudiante
5. **Eventos primero, features después** — sin `learning_events` nada downstream funciona

---

## 5. RIESGOS Y DECISIONES PENDIENTES

### Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigación |
|---|--------|-------------|---------|------------|
| R1 | **BKT engine no expone pKnown por keyword** — orchestrator pierde granularidad | Media | Alto | Verificar `src/app/lib/bkt-engine.ts` antes de PR-6. Fallback: usar solo FSRS per-keyword, BKT como señal agregada |
| R2 | **No existe UI de flashcards** — PR-4 es greenfield, esfuerzo subestimado | Media | Medio | Verificar `src/app/components/content/` antes de estimar. Si es greenfield, PR-4 sube a esfuerzo L |
| R3 | **FSRS opera keyword-level, no card-level** — flashcards necesitan adapter | Media | Medio | Verificar `src/app/lib/fsrs-engine.ts`. Si es keyword-level, crear adapter `fsrs_state` por card en PR-4c |
| R4 | **Vercel cron tiene límite de frecuencia en plan actual** | Baja | Medio | `process-learning-events` puede correr cada 5min sin problema. Si no, manual trigger desde `/events/batch` |
| R5 | **Presupuesto Haiku escala con usuarios activos** — $0.02/día × 10K estudiantes = $200/día | Baja (por ahora) | Alto (a escala) | `shouldCallAI()=false` para cold-start + cache agresivo (staleTime 30min en digest) limitan llamadas reales |

### Decisiones técnicas pendientes (no bloqueantes para PR-1)

| # | Decisión | Cuándo resolver | Quién verifica |
|---|----------|----------------|----------------|
| D1 | ¿BKT expone pKnown per-keyword? | Antes de PR-6 | Arquitecto revisa `bkt-engine.ts` |
| D2 | ¿Hay UI de flashcards existente? | Antes de PR-4 | Flashcards revisa `components/content/` |
| D3 | ¿FSRS opera card-level o keyword-level? | Antes de PR-4c | Flashcards revisa `fsrs-engine.ts` |
| D4 | Keywords por curso exactos | Durante PR-3 | Arquitecto revisa `src/app/data/` |
| D5 | ¿`expectedTimeMs` existe en el modelo? | Durante PR-2 | Quiz — si no, usar heurística: `{MCQ: 45s, clinicalCase: 90s, imageId: 30s}` |

---

## 6. SIGUIENTE PASO INMEDIATO

### 👉 Abrir PR-1 ahora — Crear los tipos fundacionales

**Owner: Organizador. Review: todo el equipo.**

**Archivos a crear (en orden):**

```
1. src/app/types/learningEvent.ts
   ├─ LearningEvent (con confidenceLevel opcional, responseTimeMs,
   │   eliminatedOptions[], answerChanges[], metadata: JsonB,
   │   sessionId, eventType union, affectsScheduling boolean)
   └─ Exportar como tipo fundacional

2. src/app/types/aiAction.ts
   └─ AIAction union: 'review-keyword' | 'attempt-quiz' |
      'synthesis-flashcard' | 'take-break' | 'escalate-professor'

3. src/app/types/aiContract.ts
   └─ LearningContext (input compartido para los 3 endpoints)
      + response types por endpoint

4. src/app/hooks/queries/queryKeys.ts
   └─ Agregar: ai.digest(courseId), ai.flashcards.deck(courseId),
      ai.probes(keywordId), ai.recommendation(studentId),
      ai.confusionGraph(courseId)

5. SQL migration: learning_events
   └─ (student_id, course_id, keyword_id, event_type, session_id,
       response_time_ms, confidence_level, implied_confidence,
       metadata jsonb, created_at)
   └─ Índices: (student_id, created_at), (course_id, keyword_id)

6. SQL migration: confusion_edges
   └─ (course_id, keyword_a, keyword_b, student_id nullable,
       co_error_count, population_count, updated_at)
   └─ Índice: (course_id, keyword_a, keyword_b)
```

**Criterio de merge:** TypeScript compila (`npx tsc --noEmit` pasa), SQL migrations son válidas, tipos son importables desde `@/app/types/`. No requiere tests de runtime — son solo contratos.

**Después del merge de PR-1:** Quiz y Organizador abren PR-2 en paralelo. El equipo nunca está bloqueado más de 2 días.

---

*Debate cerrado. Cero contradicciones pendientes. Plan ejecutable. A codear.*
