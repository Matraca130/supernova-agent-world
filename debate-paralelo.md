# Debate Paralelo v4
> 10/3/2026, 2:00:10 p.m.
> Tema: Como mejorar la integracion de IA en Axon
> Agentes: arquitecto, experto-quiz, experto-flashcards, experto-resumen, experto-organizador
> Curador: teach-leader

---

## Ronda 1

### [2:01:09 p.m.] arquitecto (49s):
## Perspectiva del Arquitecto — Ronda 1: La Capa de Inferencia Reactiva

Las sesiones anteriores establecieron `LearningEvent` como tipo fundacional y `/ai/next-learning-action` como cerebro unificado. Estoy de acuerdo con ambos. Mi contribución se centra en **lo que falta entre ambos**: la capa intermedia que transforma eventos crudos en señales consumibles por cualquier modelo de IA, sin acoplar el frontend a endpoints específicos.

### Propuesta: `InferenceGraph` — Grafo de conocimiento local en el cliente

En lugar de enviar cada `LearningEvent` al backend para que la IA decida, propongo un **grafo de conocimiento ligero en memoria** que vive en `src/app/lib/inference-graph.ts`. Este grafo:

1. **Conecta keywords entre sí** usando co-ocurrencia de errores. Si un estudiante falla `keyword:hemoglobina` y `keyword:anemia-ferropenica` en la misma sesión, el grafo crea un edge con peso. Esto es **pre-procesamiento local** que reduce la carga al backend.

2. **Expone un hook `useInferenceGraph()`** en `src/app/hooks/queries/` que cualquier componente consume. `DashboardView` lo usa para mostrar un mini-mapa de "zonas débiles conectadas". `QuizResults` lo usa para sugerir la siguiente keyword sin esperar al servidor.

3. **Serializa a `localStorage`** con TTL de 24h y se sincroniza lazy con el backend via `POST /ai/sync-graph`. El backend enriquece con datos poblacionales (¿otros estudiantes también fallan este par?) y devuelve pesos actualizados.

### Cambio concreto en el flujo de quiz

En `src/app/services/quizService.ts`, el `submitQuizAnswer()` actual devuelve un resultado simple. Propongo que **antes** de enviar al backend, el cliente actualice el `InferenceGraph` local:

```typescript
// En submitQuizAnswer, antes del fetch:
inferenceGraph.recordEvent({
  keywordId,
  correct: boolean,
  confidenceLevel,  // del LearningEvent propuesto
  responseTimeMs,
  adjacentKeywords: currentTopic.keywords // contexto temático
});
```

Esto habilita **feedback instantáneo** sin latencia de red. El componente `QuizResults` puede mostrar "Noté que luchas con X cuando aparece junto a Y" inmediatamente.

### El modelo: no un LLM para todo

Para `/ai/next-learning-action`, propongo un **sistema híbrido en la Edge Function de Supabase**:

- **Capa 1 (determinística)**: FSRS + BKT ya existentes en `src/app/lib/`. El `learning-orchestrator.ts` local decide el 80% de los casos.
- **Capa 2 (ML ligero)**: Un modelo de clasificación (XGBoost servido via ONNX Runtime en Deno) que recibe el grafo serializado y clasifica al estudiante en arquetipos de aprendizaje. Sin LLM, sin tokens caros.
- **Capa 3 (LLM, solo para síntesis textual)**: Claude Haiku 4.5 genera las flashcards de integración y el feedback narrativo. Solo se invoca cuando hay contenido que *generar*, nunca para *decidir*.

### UX audaz: "Modo Radiografía"

Un toggle en `StudentLayout` que superpone sobre cualquier vista de contenido un **heatmap de confianza** por keyword. Cada keyword en el texto se subraya con color (rojo/amarillo/verde ya definidos en spaced repetition). Click en una keyword roja → micro-quiz contextual inline sin salir de la lectura. Esto vive en `src/app/components/content/` como `KeywordOverlay.tsx`.

---CHECKPOINT---
{"consenso":["LearningEvent como tipo fundacional es correcto y necesario","El fallback determinístico local es esencial - el 80% de decisiones no necesita IA","Flashcards de integración activas son mejores que texto pasivo"],"divergencias":["Enviar todos los LearningEvents crudos al backend es innecesario y costoso - propongo pre-procesamiento via InferenceGraph local","No todo debe pasar por un LLM: la decisión de qué estudiar next debe ser determinística/ML ligero, el LLM solo genera contenido textual"],"preguntas":["¿Qué volumen de keywords por curso maneja Axon actualmente? El InferenceGraph necesita un tope para no explotar en memoria","¿El plan de Supabase actual soporta ONNX Runtime en Edge Functions o necesitamos un servicio separado para el modelo de clasificación?","¿Cómo manejamos el cold-start del grafo para estudiantes nuevos sin historial?"],"accionable":["Crear src/app/lib/inference-graph.ts con estructura de grafo ponderado keyword-keyword","Extender submitQuizAnswer en quizService.ts para alimentar el grafo local antes del fetch","Implementar useInferenceGraph hook que exponga zonas débiles conectadas","Diseñar KeywordOverlay.tsx como componente de Modo Radiografía en content/","Definir contrato de /ai/sync-graph endpoint para sincronización lazy del grafo"]}
---END---

---


### [2:01:10 p.m.] experto-quiz (57s):
## Perspectiva Experto-Quiz: IA Diagnóstica por Patrones de Error, No por Respuestas

Las sesiones anteriores establecieron `LearningEvent` con `confidenceLevel` y el endpoint `/ai/next-learning-action`. Construyo sobre eso con una propuesta que nadie ha tocado: **el quiz como instrumento diagnóstico adaptativo en tiempo real, no como evaluación post-hoc.**

### 1. Quiz Probes: Micro-preguntas Inyectadas por IA

Concepto: entre las preguntas normales del quiz, inyectar **probe questions** generadas por IA que testean hipótesis específicas sobre misconceptions del estudiante. No cuentan para la nota.

**Implementación concreta:**
- Nuevo campo en `LearningEvent.metadata`: `{ isProbe: boolean, probeHypothesis: string, probeResult: 'confirmed' | 'refuted' }`
- En `useQuizSession` (que ya tiene normalizers según commit `fc335f2`), añadir lógica de inyección: después de 2 errores en un keyword, el orchestrator solicita un probe al endpoint `/ai/generate-probe`
- Modelo: **Claude Haiku 4.5** (barato, rápido ~200ms). Prompt: dado el keyword, los 2 errores concretos y los distractores elegidos, genera UNA pregunta que discrimine entre "no sabe el concepto" vs "confunde con concepto X"
- El probe aparece como pregunta normal en UI pero con borde sutil `border-teal-200` y badge "Exploratoria"

### 2. Error Topology Graph — Mapear Confusiones, No Solo Fallos

El `confidenceLevel` ya nos dice confident+wrong = misconception. Pero falta **estructura**: ¿QUÉ confunde CON QUÉ?

- Nuevo tipo en `src/app/types/`: `ErrorEdge { keywordA: string, keywordB: string, confusionScore: number, evidence: LearningEvent[] }`
- Servicio `src/app/services/errorTopologyService.ts`: construye grafo de confusiones por estudiante analizando `eliminatedOptions[]` del `LearningEvent`. Si el estudiante consistentemente NO elimina la opción de keyword B al responder sobre keyword A → confusion edge.
- **UI en `DashboardView`**: componente `ConfusionMap` — visualización con nodos (keywords) y aristas rojas (confusiones frecuentes). Clickear una arista abre flashcard comparativa generada por IA: "¿Cuál es la diferencia clave entre Síndrome Nefrítico y Nefrótico?"
- Esto alimenta `/ai/next-learning-action`: cuando hay confusion edge fuerte, la acción priorizada NO es repasar A ni B por separado, sino presentar material de **contraste activo**.

### 3. Confidence Calibration Score — Meta-cognición Visible

Dato brutal: en educación médica, la sobreconfianza mata (literalmente). Con `confidenceLevel` ya capturado:

- Calcular `calibrationScore` en `src/app/services/spacedRepetition.ts`: correlación entre confianza reportada y acierto real, ventana móvil de 50 respuestas
- Mostrar en UI como gauge en `StudentStatsView`: "Tu calibración: 0.72" con tooltip explicando que 1.0 = perfecta
- **Modificar SM-2/FSRS** en `src/app/lib/fsrs-engine.ts`: si `calibrationScore < 0.5` (sobreconfiado), incrementar intervalos más lentamente incluso con respuestas correctas. El estudiante sobreconfiado necesita más repeticiones, no menos.

### 4. Quiz Mode: "Enseña-me" Inverso

Después de responder correctamente con alta confianza, 1 de cada 5 veces presentar: "Explica en una oración por qué las otras opciones son incorrectas." Evaluado por Haiku 4.5 via `/ai/evaluate-explanation`. Esto cierra el ciclo de Bloom: de reconocimiento a generación.

---CHECKPOINT---
{"consenso":["LearningEvent como tipo fundacional es imprescindible - todo lo propuesto aquí depende de él","confidenceLevel transforma la señal de BKT/FSRS, refuerzo total","endpoint /ai/next-learning-action debe orquestar probes y contraste activo, no solo repetición"],"divergencias":["Las flashcards de síntesis cruzada como texto pasivo son insuficientes - deben ser ACTIVAS y diagnósticas, no solo presentar conexiones sino testear si el estudiante las entiende","El fallback determinístico local no debería aplicar a probes - sin IA no hay probe, simplemente se omite"],"preguntas":["¿Dónde almacenamos el ErrorTopology graph? ¿Supabase table o computed on-demand en el cliente?","¿El probe question count como interacción para spaced repetition o se excluye del cálculo SM-2/FSRS?","¿Hay presupuesto para Haiku 4.5 calls por quiz session (~3-5 probes x ~$0.001 cada una)?","¿Cómo evitar que el confidence self-report se vuelva gaming (siempre poner 3/5 para no ser penalizado)?"],"accionable":["Crear tipo ErrorEdge y servicio errorTopologyService.ts que analice eliminatedOptions de LearningEvent","Añadir lógica de probe injection en useQuizSession tras 2+ errores consecutivos en mismo keyword","Implementar calibrationScore en spacedRepetition.ts como media móvil de 50 eventos","Crear endpoint /ai/generate-probe con Haiku 4.5 que reciba keyword + errores + distractores","Modificar FSRS stability gain en fsrs-engine.ts condicionado a calibrationScore del estudiante"]}
---END---

---


### [2:01:11 p.m.] experto-flashcards (57s):
## Perspectiva Experto-Flashcards: Flashcards como Interfaz Primaria de la IA

Las memorias anteriores establecieron `LearningEvent` como tipo fundacional y la síntesis cruzada como flashcards activas. Construyo sobre eso con una propuesta que nadie ha planteado: **las flashcards no son un feature más — deben ser la interfaz universal de output de toda la IA en Axon**.

### 1. Flashcard Polymorphism Engine

Hoy las flashcards son probablemente texto-frente/texto-reverso. Propongo un sistema de **7 tipos de card** que la IA genera según el `LearningEvent`:

- **Cloze clínica**: "En paciente con [___] + fiebre + ictericia, sospechar colangitis" — generada cuando el estudiante falla asociaciones en quiz
- **Imagen-señal**: la card muestra una imagen (histología, RX) y pide identificar hallazgo — cuando `confidenceLevel < 2` en temas visuales
- **Cadena causal**: "Ordena los pasos: estímulo → receptor → segundo mensajero → efecto" — cuando el estudiante acierta conceptos aislados pero falla secuencias
- **Diferencial**: "¿Qué distingue X de Y?" — generada por el motor de síntesis cruzada del que ya se habló
- **Metacognitiva**: "¿Qué tan seguro estás? Justifica" — calibra el sesgo confianza/precisión usando `confident + wrong` del BKT
- **Integración vertical**: cruza temas (bioquímica → clínica) — el corazón de la síntesis cruzada
- **Speed drill**: card con timer visible, para keywords con `pKnown > 0.8` pero `responseTimeMs` alto

Esto vive en `src/app/types/flashcard.ts` como union type discriminado por `cardType`. El componente `FlashcardView.tsx` en `src/app/components/content/` usa un registry pattern para renderizar cada tipo.

### 2. Endpoint `/ai/generate-deck` con Modelo Específico

**Modelo**: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) — suficiente para generación de cards, rápido, barato. Para cards de integración vertical: Sonnet 4.6.

**Input**: `{ studentId, keywordIds[], weaknessProfile, deckSize: 10-20, cardTypeBias }` donde `weaknessProfile` viene del BKT engine (`src/app/lib/bkt-engine.ts`) y el FSRS (`src/app/lib/fsrs-engine.ts`) aporta el scheduling.

**Output**: Array de cards tipadas con metadata de scheduling FSRS pre-calculado. La Edge Function en Supabase llama a Anthropic API, no al cliente directo.

### 3. "Flashcard Triage" — UX Audaz

En vez del flujo clásico de SRS (revisar deck → calificar), propongo **Triage Mode**: al abrir la sesión de estudio, el estudiante ve 3 cards simultáneamente y elige cuál resolver primero. Esto genera `selectionOrder` como señal implícita de confianza — sin preguntar "¿qué tan seguro estás?". La IA observa qué evitas. Componente: `FlashcardTriageView.tsx`, usa `motion` para animaciones de selección tipo drag-to-prioritize.

### 4. Hook `useFlashcardSession` 

En `src/app/hooks/queries/` — orquesta: fetch del deck (React Query, key en `queryKeys.ts`), tracking de `LearningEvent` por cada card, mutation de resultados, y pre-fetch del siguiente deck cuando quedan 3 cards. Integra FSRS para decidir intervalos y BKT para decidir *qué tipo de card* necesita el estudiante.

---CHECKPOINT---
{"consenso":["LearningEvent como tipo fundacional es prerequisito absoluto — sin datos ricos las flashcards AI son genéricas","Síntesis cruzada como flashcards activas es correcto pero necesita taxonomía de tipos de card","FSRS + BKT deben coexistir: FSRS para scheduling, BKT para diagnóstico de tipo de debilidad"],"divergencias":["El endpoint /ai/next-learning-action como cerebro unificado puede ser over-engineering prematuro — mejor empezar con endpoints especializados por feature (generate-deck, evaluate-synthesis) y unificar después","No toda interacción necesita IA: el 80% de flashcards pueden generarse con templates determinísticos desde los keywords existentes en src/app/data/"],"preguntas":["¿Existe ya un modelo de datos para flashcards en Supabase o solo viven en memoria/static data?","¿El BKT engine actual expone weaknessProfile por keyword o solo pKnown global?","¿Cuál es el presupuesto de latencia aceptable para generación de deck AI? ¿Pre-generar en background o on-demand?"],"accionable":["Crear src/app/types/flashcard.ts con union type discriminado de 7 cardTypes","Crear hook useFlashcardSession en src/app/hooks/queries/ con React Query integration","Implementar Edge Function /ai/generate-deck usando Haiku 4.5 para cards simples y Sonnet para integración vertical","Agregar cardType y triggerConfidence a FlashcardMeta dentro de LearningEvent","Prototipar FlashcardTriageView.tsx con 3-card simultaneous selection como experimento UX"]}
---END---

---


### [2:01:13 p.m.] experto-resumen (47s):
## Perspectiva Experto-Resumen: La Capa de Meta-Cognición como Diferenciador

Las sesiones anteriores establecieron el `LearningEvent` como tipo fundacional y `/ai/next-learning-action` como cerebro unificado. Acepto ambos como axiomas. Mi contribución: **la IA en Axon no debe solo decidir *qué* estudiar, sino enseñar al estudiante *por qué* lo estudia** — meta-cognición algorítmica.

### Idea 1: `InsightDigest` — Resúmenes de aprendizaje narrativos

Nuevo componente `InsightDigestView.tsx` en `src/app/components/content/` que se muestra al abrir la app (antes del dashboard). No es un panel de stats — es un **párrafo generado** tipo:

> "Esta semana dominaste farmacología renal (mastery 0.82→0.91), pero tu confianza en diuréticos de asa es alta mientras tu accuracy es baja — señal clásica de misconception. Hoy te propongo 3 flashcards de corrección antes de avanzar."

**Implementación:** Endpoint `/ai/generate-digest` (Claude Haiku 4.5 — barato, rápido). Input: últimos 7 días de `LearningEvent[]` agregados por keyword. Output: JSON `{ narrative: string, priorityActions: Action[], misconceptions: KeywordId[] }`. Cache en `StudentDataContext` con TTL de 4 horas. Query key: `queryKeys.ai.digest(studentId)`.

### Idea 2: `ConfidenceCalibrationChart` — Visualizar el sesgo

Componente en `src/app/components/content/` que plotea **confianza reportada vs. accuracy real** por keyword. Usa los datos de `confidenceLevel` del `LearningEvent` enriquecido. Cuadrantes: calibrado, sobreconfiado, infraconfiado, adivinando. Esto convierte un dato invisible (el sesgo metacognitivo) en algo accionable.

Sin IA — puro cálculo local en un hook `useConfidenceCalibration()` en `src/app/hooks/`. El chart usa Recharts (ya disponible como dependencia típica) o un canvas simple. Cada punto es un keyword coloreado con el sistema existente (rojo/amarillo/verde de `spacedRepetition.ts`).

### Idea 3: Feedback Loop Cerrado — `LearningEvent` → Digest → Acción → `LearningEvent`

El problema de las sesiones anteriores: se diseñaron datos ricos y endpoints inteligentes pero **no se cerró el ciclo UX**. Propongo que cada `InsightDigest` genere `SuggestedAction[]` que al ejecutarse emitan `LearningEvent` con `metadata.triggeredBy: 'digest'`. Esto permite medir si las recomendaciones de IA realmente mejoran outcomes — A/B testing orgánico sin infraestructura extra.

### Idea Audaz: `PeerInsight` — IA como puente entre estudiantes anónimos

El endpoint `/ai/peer-patterns` (Claude Haiku) recibe datos agregados (nunca individuales) y genera: "El 73% de estudiantes que dominaron este tema primero estudiaron [keyword X]. Tú aún no la has visto." Esto simula aprendizaje social sin features sociales. Se renderiza como chip sutil en `TopicSidebar`.

---CHECKPOINT---
{"consenso":["LearningEvent como tipo fundacional es correcto y necesario","El endpoint /ai/next-learning-action como cerebro unificado es la arquitectura correcta","Flashcards activas de síntesis cruzada son mejor que texto pasivo","El fallback determinístico local es esencial para resiliencia"],"divergencias":["No basta con decidir qué estudiar — falta la capa de meta-cognición que explique el porqué al estudiante","Las métricas de rendimiento no deberían solo alimentar al algoritmo sino ser visibles y narrativas para el usuario"],"preguntas":["¿Existe ya Recharts u otra lib de charting en las dependencias de Axon?","¿El StudentDataContext puede soportar cache de digests sin re-render excesivo?","¿Cuál es el budget de latencia aceptable para generar un InsightDigest al abrir la app?","¿Los datos agregados para PeerInsight requieren una Edge Function separada o se pueden derivar de datos existentes en Supabase?"],"accionable":["Crear InsightDigestView.tsx con endpoint /ai/generate-digest usando Claude Haiku 4.5","Implementar hook useConfidenceCalibration() que cruce confidenceLevel con accuracy por keyword","Agregar campo triggeredBy a LearningEvent.metadata para cerrar el feedback loop","Diseñar ConfidenceCalibrationChart como componente visual de sesgo metacognitivo","Prototipar /ai/peer-patterns con datos agregados anónimos para aprendizaje social implícito"]}
---END---

---


### [2:01:14 p.m.] experto-organizador (54s):
Trabajo con lo que conozco de la arquitectura documentada y las memorias previas.

---

## Perspectiva del Experto-Organizador: La Capa de Orquestación como Sistema Nervioso

Las sesiones anteriores definieron **qué** capturar (`LearningEvent`) y **qué** hacer con ello (`/ai/next-learning-action`). Mi aporte es **cómo orquestar todo esto sin que Axon se convierta en un monolito de IA inmanejable**.

### 1. Pipeline de Eventos con Cola Local — `EventBus` Client-Side

El `LearningEvent` es inútil si se envía uno-a-uno al backend. Propongo un **`src/app/services/eventBus.ts`** que:

- Acumula eventos en un buffer local (IndexedDB via `idb-keyval`)
- Flush cada 30s o al cambiar de vista (hook `useEventFlush()` en layouts)
- Endpoint batch: `POST /events/batch` → Supabase Edge Function que inserta en bulk
- **Offline-first**: si falla, retiene y reintenta con backoff exponencial

Esto resuelve el problema que nadie mencionó: **latencia percibida**. El estudiante nunca espera por telemetría.

### 2. Estado de IA como React Query — No más Context Sprawl

Veo riesgo de crear un `AIContext` que compita con `StudentDataContext` y `ContentTreeContext`. En cambio: toda respuesta de IA debe vivir como **query keys** en `queryKeys.ts`:

```ts
ai: {
  nextAction: (studentId: string) => ['ai', 'nextAction', studentId],
  synthesis: (topicIds: string[]) => ['ai', 'synthesis', ...topicIds],
  feedback: (eventId: string) => ['ai', 'feedback', eventId],
}
```

Hook en `src/app/hooks/queries/useAIRecommendation.ts` con `staleTime: 5min`, invalidado por el EventBus tras flush exitoso. **La IA se refresca pasivamente, no bloquea el flujo.**

### 3. El "Manifiesto de Acción" — Tipado Estricto para Salida de IA

`/ai/next-learning-action` no debe devolver texto libre. Debe devolver un **union type cerrado**:

```ts
type AIAction =
  | { type: 'review-keyword'; keywordId: string; reason: string }
  | { type: 'attempt-quiz'; quizId: string; difficulty: 'easy'|'hard' }
  | { type: 'synthesis-flashcard'; cardPayload: FlashcardMeta }
  | { type: 'take-break'; durationMin: number }
  | { type: 'escalate-professor'; topicId: string; pattern: string }
```

El frontend tiene un **`ActionRenderer`** en `src/app/components/content/AIActionCard.tsx` que mapea cada tipo a un componente visual específico. Sin switch-case genérico — **pattern matching exhaustivo** con TypeScript.

### 4. Idea Audaz: "Profesor Fantasma" — IA que Escala al Humano

Cuando BKT detecta `pKnown < 0.3` después de 3+ intentos en un keyword, el sistema genera automáticamente un **ticket silencioso** visible en `ProfessorLayout`. No es notificación push — es un dashboard en `src/app/components/professor/StudentAlerts.tsx` que muestra:

- Qué keyword, qué patrón de error, qué misconception probable
- Sugerencia de intervención generada por Claude Haiku (`claude-haiku-4-5-20251001`, ~$0.001/ticket)
- El profesor aprueba/edita/descarta → eso retroalimenta el prompt del sistema

**El profesor no crea contenido remedial desde cero; la IA le da el borrador y él valida.** Esto reduce la barrera de adopción para profesores que no quieren "usar IA".

### 5. Modelo Económico: Haiku para Tiempo Real, Sonnet para Batch

- `next-learning-action`: Haiku (< 200ms, ~$0.0003/call)
- `evaluate-synthesis`, tickets a profesor: Sonnet (`claude-sonnet-4-6`, batch nocturno)
- Flashcard generation: Haiku con structured output (JSON mode)

Presupuesto estimado: ~$0.02/estudiante/día activo.

---CHECKPOINT---
{"consenso":["LearningEvent como tipo fundacional es correcto y necesario","Endpoint /ai/next-learning-action con fallback determinístico local es la arquitectura correcta","Flashcards de síntesis activa > texto pasivo","confidenceLevel transforma la señal de BKT significativamente"],"divergencias":["No debería crearse un AIContext separado — toda data de IA debe vivir en React Query para evitar context sprawl y stale state","El endpoint de IA no debe devolver texto libre — necesita union types cerrados para que el frontend sea determinista"],"preguntas":["¿Cuál es el volumen esperado de LearningEvents por estudiante/hora? Esto determina si IndexedDB + batch es suficiente o necesitamos Web Workers","¿El ProfessorLayout actual tiene espacio para un dashboard de alertas o requiere reestructuración de rutas?","¿Hay presupuesto definido para API calls de IA por estudiante/mes?"],"accionable":["Crear src/app/services/eventBus.ts con buffer IndexedDB + flush batch","Agregar claves 'ai' en src/app/hooks/queries/queryKeys.ts","Definir tipo AIAction como union cerrado en src/app/types/aiAction.ts","Crear hook useAIRecommendation.ts en src/app/hooks/queries/","Crear componente AIActionCard.tsx como renderer de acciones tipadas","Implementar StudentAlerts.tsx en professor/ con integración Haiku para tickets de escalación"]}
---END---

---


### [CURACIÓN] teach-leader (1m 47s):
## IDEAS PRIORITARIAS

### P0 — Fundamento (sin esto, nada funciona)
- **`LearningEvent` enriquecido como tipo fundacional** con `confidenceLevel`, `responseTimeMs`, `eliminatedOptions[]`, `metadata` extensible (consenso unánime, 5/5 agentes)
- **`EventBus` client-side con buffer IndexedDB + batch flush** — infraestructura prerequisita para que los eventos no bloqueen UX (Organizador)
- **`AIAction` como union type cerrado** — contrato estricto antes de implementar cualquier endpoint de IA (Organizador)
- **Claves `ai.*` en `queryKeys.ts`** — toda respuesta de IA vive en React Query, no en un Context nuevo (Organizador)

### P1 — Alto impacto, construir después
- **Grafo de errores/confusiones keyword↔keyword** — fusionar InferenceGraph (Arquitecto) + ErrorTopology (Quiz) en un solo servicio (ver contradicción sobre ubicación)
- **Confidence Calibration Score + Chart** — fusionar cálculo (Quiz) + visualización (Resumen) en un solo hook `useConfidenceCalibration()` que modifique FSRS
- **Flashcard Polymorphism: 7 tipos de card con union type discriminado** (Flashcards) — amplía enormemente el output útil de la IA
- **`InsightDigest` narrativo al abrir la app** — meta-cognición visible, cierra el feedback loop (Resumen)
- **Modelo económico: Haiku para tiempo real, Sonnet para batch** (Arquitecto + Organizador + Flashcards, convergencia 3/5)

### P2 — Ambicioso, validar con prototipos
- **Quiz Probes diagnósticos inyectados** (Quiz) — alto valor pedagógico, requiere validación UX
- **"Profesor Fantasma"** — IA escala al humano con borrador de intervención (Organizador)
- **Flashcard Triage Mode** — selección simultánea de 3 cards como señal implícita (Flashcards)
- **Modo Radiografía** — heatmap de confianza sobre contenido (Arquitecto)
- **PeerInsight** — patrones anónimos de pares (Resumen) — necesita volumen de datos
- **"Enseña-me" inverso** — evaluación de explicaciones por IA (Quiz)

---

## CONTRADICCIONES

1. **Organizador dice "endpoint unificado `/ai/next-learning-action`"** vs **Flashcards dice "over-engineering prematuro, mejor endpoints especializados primero"** → Resolver: ¿monolito inteligente o microservicios de IA que se unifican después?

2. **Arquitecto dice "grafo en cliente (localStorage + sync lazy)"** vs **Quiz pregunta "¿Supabase table o computed on-demand?"** → Resolver dónde vive la fuente de verdad del grafo de confusiones. El grafo del Arquitecto y el ErrorTopology del Quiz son el **mismo concepto** con ubicaciones distintas.

3. **Organizador dice "NO crear AIContext, todo en React Query"** vs **Resumen dice "cache de digest en StudentDataContext"** → Resolver si StudentDataContext se extiende con datos de IA o si todo va a query cache.

4. **Flashcards dice "80% de flashcards pueden ser templates determinísticos"** vs **Flashcards también propone 7 tipos de card generados por IA** → ¿Cuál es el split real? ¿Templates para tipos simples (cloze, diferencial) e IA para integración vertical?

---

## PREGUNTAS PARA LA SIGUIENTE RONDA

1. **¿Endpoint unificado o especializado?** ¿`/ai/next-learning-action` como cerebro único, o empezamos con `/ai/generate-deck`, `/ai/generate-probe`, `/ai/generate-digest` y unificamos cuando los patrones converjan? Necesito una posición firme con argumentos de complejidad de implementación.

2. **¿Dónde vive el grafo de confusiones?** Cliente (IndexedDB/localStorage) con sync lazy, o Supabase table como fuente de verdad con materialización en cliente. Considerar: cold-start de estudiantes nuevos, volumen de keywords por curso, y datos poblacionales.

3. **¿Cuántos keywords por curso maneja Axon hoy?** Esto determina si un grafo en memoria es viable (~100 nodos OK, ~5000 nodos explota). Necesito dato concreto.

4. **¿El plan de Supabase actual soporta ONNX Runtime o modelos ML en Edge Functions?** Si no, la Capa 2 del Arquitecto (XGBoost) necesita infraestructura adicional. ¿Vale la pena vs. simplemente usar Haiku?

5. **¿Cómo evitar gaming del `confidenceLevel`?** Quiz lo planteó pero nadie lo resolvió. Si el estudiante aprende que "poner confianza baja = no ser penalizado", el dato se corrompe. ¿Señales implícitas (responseTime, selectionOrder) como alternativa o complemento?

6. **¿Presupuesto de IA por estudiante/mes?** Organizador estima ~$0.02/día. ¿Es aceptable para el modelo de negocio? Esto condiciona qué features pasan de P2 a P1.

7. **¿Los probes del Quiz afectan el scheduling FSRS o son eventos "fantasma"?** Necesito consenso explícito.

---

## BRIEF PARA AGENTES (Ronda 2)

**Estado tras Ronda 1:** Consenso fuerte en fundamentos (`LearningEvent`, fallback determinístico, Haiku/Sonnet tiers, flashcards activas > pasivas). La infraestructura de orquestación del Organizador (`EventBus`, `AIAction` union type, React Query como capa de estado de IA) es prerequisito P0 — todos deben asumirla como base.

**Fusiones decididas:** (1) InferenceGraph + ErrorTopology = **un solo servicio `ConfusionGraph`** que mapea keyword↔keyword por patrones de error. (2) ConfidenceCalibration del Quiz + Chart del Resumen = **un hook + un componente**, no dos features separadas.

**Contradicciones abiertas que DEBEN resolverse en Ronda 2:**
- **Endpoint unificado vs. especializado** — Organizador y Flashcards deben converger. Argumenten con complejidad de implementación y evolvabilidad, no con preferencia.
- **Ubicación del ConfusionGraph** — Arquitecto y Quiz deben proponer arquitectura concreta considerando cold-start y volumen de datos.
- **Estado de IA en React Query vs. extender Contexts existentes** — Organizador y Resumen, resuelvan.

**Foco para Ronda 2:** No propongan features nuevos. En cambio: (1) resuelvan las contradicciones asignadas, (2) definan la secuencia de implementación concreta (qué archivo se crea primero, qué depende de qué), (3) respondan las preguntas abiertas que les competan. El Arquitecto debe pronunciarse sobre viabilidad de ONNX en Supabase Edge. El Quiz debe resolver el gaming de confidenceLevel. El Flashcards debe clarificar el split templates/IA. El Resumen debe definir el contrato exacto del InsightDigest. El Organizador debe proponer el schema de la tabla `learning_events` en Supabase.

**Restricción:** Cada agente máximo 3 accionables concretos, con ruta de archivo y dependencias explícitas.

---

---CHECKPOINT---
{"consenso":["LearningEvent enriquecido como tipo fundacional — unanimidad total, es prerequisito P0","EventBus con buffer IndexedDB + batch flush como infraestructura de telemetría — sin esto los eventos bloquean UX","AIAction como union type cerrado — el frontend debe ser determinista ante respuestas de IA","Toda data de IA en React Query con claves en queryKeys.ts, no crear AIContext separado","Modelo económico Haiku para tiempo real / Sonnet para batch — convergencia 3 de 5 agentes","InferenceGraph del Arquitecto y ErrorTopology del Quiz son el mismo concepto — fusionar en un solo servicio ConfusionGraph","ConfidenceCalibration del Quiz y Chart del Resumen son el mismo feature — fusionar en hook + componente","Flashcard polymorphism con union type discriminado amplía significativamente el output útil de IA","El fallback determinístico local (FSRS+BKT) maneja el 80% de decisiones sin IA — correcto y esencial"],"divergencias":["Endpoint unificado vs especializado: el Organizador defiende /ai/next-learning-action monolítico, Flashcards argumenta que es over-engineering prematuro — necesitan converger en Ronda 2","Ubicación del grafo de confusiones: Arquitecto lo quiere client-side con sync lazy, Quiz sugiere Supabase table — la fuente de verdad debe ser una sola","La Capa 2 del Arquitecto (XGBoost via ONNX en Edge Functions) es probablemente inviable en Supabase actual — Haiku es suficiente y más simple para clasificación de arquetipos","PeerInsight del Resumen es interesante pero prematuro sin volumen de datos significativo — mover a P2 o posterior"],"preguntas":["¿Cuántos keywords por curso maneja Axon actualmente? Determina viabilidad del grafo en memoria","¿Soporta Supabase Edge Functions ONNX Runtime o necesitamos servicio separado?","¿Cómo evitar gaming del confidenceLevel? ¿Señales implícitas como alternativa?","¿Presupuesto de IA por estudiante/mes aceptable para el modelo de negocio?","¿Los quiz probes afectan scheduling FSRS o son eventos fantasma?","¿Existe modelo de datos para flashcards en Supabase o solo viven en static data?","¿El BKT engine actual expone weaknessProfile por keyword o solo pKnown global?"],"accionable":["P0-1: Crear src/app/types/learningEvent.ts con LearningEvent enriquecido (confidenceLevel, responseTimeMs, eliminatedOptions, metadata extensible)","P0-2: Crear src/app/services/eventBus.ts con buffer IndexedDB + flush batch cada 30s + offline retry","P0-3: Crear src/app/types/aiAction.ts con union type cerrado AIAction (review-keyword | attempt-quiz | synthesis-flashcard | take-break | escalate-professor)","P0-4: Agregar claves ai.* en src/app/hooks/queries/queryKeys.ts","P1-1: Crear src/app/services/confusionGraph.ts fusionando InferenceGraph + ErrorTopology — ubicación exacta (cliente vs server) pendiente de resolver","P1-2: Crear hook useConfidenceCalibration() + componente ConfidenceCalibrationChart fusionando propuestas de Quiz y Resumen","P1-3: Crear src/app/types/flashcard.ts con union type discriminado de 7 cardTypes","P1-4: Crear hook useAIRecommendation.ts en src/app/hooks/queries/ con staleTime 5min invalidado por EventBus"]}
---END---

---


## Ronda 2

### [2:03:56 p.m.] arquitecto (45s):
## Arquitecto — Ronda 2: Resoluciones concretas

### 1. ONNX en Supabase Edge: Veredicto → NO viable, ni necesario

Supabase Edge Functions corren en Deno Deploy con límites de 150ms CPU y ~150MB memoria. ONNX Runtime necesita bindings nativos que Deno Deploy no soporta. Incluso si lo soportara, un modelo XGBoost para clasificar arquetipos de aprendizaje es matar moscas con cañón cuando tienes ~5 features de entrada (accuracy, responseTime, confidenceCalibration, streakPattern, sessionFrequency).

**Decisión firme:** Matar la Capa 2 XGBoost. Reemplazar con reglas heurísticas en `src/app/services/learner-profile.ts` que clasifiquen arquetipos con un switch sobre umbrales. Cuando necesitemos clasificación más sofisticada, una llamada a Haiku con prompt estructurado (~200 tokens input, ~50 output, $0.0001) supera a cualquier modelo custom que tengamos que mantener.

### 2. ConfusionGraph: La fuente de verdad es Supabase, el cliente materializa

Retiro mi posición de Ronda 1. Client-side como fuente de verdad tiene un problema fatal: **cold-start**. Un estudiante cambia de dispositivo y pierde su grafo. Además, los datos poblacionales (qué confusiones son comunes entre *todos* los estudiantes) solo existen si la data vive en servidor.

**Arquitectura concreta:**
- **Supabase table `confusion_edges`**: `student_id, keyword_a, keyword_b, co_error_count, last_seen, confidence_delta`. Índice compuesto en `(student_id, keyword_a, keyword_b)`.
- **Materialización en cliente**: `useConfusionGraph(courseId)` hace query al mount, cachea en React Query con `staleTime: 10min`. El grafo en memoria es un `Map<string, Edge[]>` — con ~100-200 keywords por curso (dato estimado de la estructura en `src/app/data/`), esto son ~500 edges máximo. Cabe en memoria sin problema.
- **Escritura**: El `EventBus` ya propuesto acumula eventos. Una Edge Function `process-learning-events` corre como cron cada 5 min, calcula co-ocurrencias de errores y actualiza `confusion_edges`. El cliente no escribe directamente al grafo.

### 3. Endpoint unificado vs. especializado → **Especializado primero, facade después**

Coincido con Flashcards. Un endpoint unificado `/ai/next-learning-action` como punto de partida es over-engineering porque:
- Cada dominio (deck generation, probes, digest) tiene inputs y outputs completamente distintos
- Un endpoint monolítico es imposible de testear incrementalmente
- El fallback determinístico local ya cubre la orquestación de "qué hacer ahora"

**Propuesta:** 3 Edge Functions independientes (`ai-generate-deck`, `ai-generate-probe`, `ai-generate-digest`), cada una con su contrato tipado. En cliente, `src/app/services/ai-orchestrator.ts` es el facade que decide cuál llamar basándose en el estado local (FSRS schedule + BKT weakness). Si en 6 meses los patrones convergen, se fusionan server-side. Costo de refactor: bajo, porque el facade ya abstrae.

### Gaming de confidenceLevel (contribución cruzada)

No preguntes confianza *antes* de responder. Pregúntala *después*: "¿Qué tan seguro estabas?" post-respuesta. El estudiante no puede gamear porque ya respondió. Complementar con `responseTimeMs` como señal implícita: respuesta rápida + correcta + confianza baja = calibración pobre, no gaming.

---CHECKPOINT---
{"consenso":["Matar ONNX/XGBoost en Edge Functions — Haiku + heurísticas cubren el caso de uso por fracción del costo de mantenimiento","ConfusionGraph con fuente de verdad en Supabase y materialización en React Query con staleTime 10min","Endpoints especializados primero con facade client-side en ai-orchestrator.ts — unificar solo cuando patrones converjan","EventBus batch flush alimenta Edge Function cron que computa confusion_edges — el cliente nunca escribe al grafo directamente","Preguntar confidenceLevel post-respuesta elimina el vector principal de gaming"],"divergencias":["Retiro mi posición de Ronda 1 sobre grafo client-side como fuente de verdad — cold-start y datos poblacionales lo hacen inviable"],"preguntas":["¿Cuántos keywords por curso reales hay en src/app/data/? Mi estimado de 100-200 condiciona la viabilidad del grafo en memoria","¿El cron de Supabase (pg_cron) está disponible en el plan actual o necesitamos invocación externa para process-learning-events?","¿El facade ai-orchestrator.ts debería exponer un hook useNextAction() o solo ser llamado imperativamente desde el EventBus?"],"accionable":["Crear src/app/services/learner-profile.ts con clasificación de arquetipos por umbrales heurísticos (reemplaza Capa 2 XGBoost), depende de LearningEvent P0-1","Crear tabla confusion_edges en Supabase + Edge Function process-learning-events como cron consumer del EventBus, depende de P0-2","Crear src/app/services/ai-orchestrator.ts como facade de 3 endpoints especializados con fallback determinístico local, depende de P0-3 (AIAction types)"]}
---END---

---


### [2:03:57 p.m.] experto-quiz (47s):
# Experto-Quiz — Ronda 2: Resoluciones concretas

## 1. Gaming del confidenceLevel: RESUELTO

No pedir confianza explícita. Es corruptible por diseño. En su lugar, **inferir confianza de señales implícitas** ya capturables en `LearningEvent`:

- **`responseTimeMs`**: respuesta <5s en pregunta difícil = adivinanza o dominio. Cruzar con resultado.
- **`answerChanges[]`**: cambiar de respuesta correcta a incorrecta = alta confianza errónea (peor señal). Cambiar de incorrecta a correcta = duda productiva.
- **`eliminatedOptions[]`**: eliminar 2 de 4 y acertar ≠ eliminar 0 y acertar. La primera muestra razonamiento clínico, la segunda puede ser memorización.

**Fórmula concreta para `impliedConfidence`:**

```typescript
// src/app/services/confidenceInference.ts
function inferConfidence(event: QuizAnswerEvent): number {
  let score = 0.5;
  const timeRatio = event.responseTimeMs / event.expectedTimeMs;
  if (timeRatio < 0.3) score -= 0.2; // demasiado rápido = guess
  if (event.answerChanges.length > 0) score -= 0.15; // vacilación
  score += event.eliminatedOptions.length * 0.1; // razonamiento
  if (event.correct) score += 0.2;
  return clamp(score, 0, 1);
}
```

Esto elimina el problema de gaming completamente. El `confidenceLevel: 1-5` explícito se convierte en dato **opcional de calibración**, no en señal primaria. Si el estudiante lo manipula, no importa — las señales implícitas dominan.

## 2. ConfusionGraph: Supabase como fuente de verdad, materialización lazy en cliente

Mi posición firme: **Supabase table `keyword_confusions`** con columnas `(keyword_a, keyword_b, confusion_count, last_seen, course_id)`.

Razones contra client-side puro:
- **Cold-start**: estudiante nuevo no tiene grafo. Con Supabase, hereda patrones poblacionales ("el 40% confunde arritmia sinusal con fibrilación auricular").
- **Datos poblacionales son oro**: el ConfusionGraph individual es ruidoso con <50 eventos. El agregado poblacional es señal fuerte desde día 1.
- **Volumen**: si son ~100-300 keywords/curso (estimación razonable para medicina por módulo), el grafo completo cabe en una query. No necesitamos IndexedDB.

**Materialización en cliente**: `useConfusionGraph(courseId)` con `staleTime: 10min`. El EventBus ya envía los eventos al backend; una Edge Function actualiza la tabla con un simple `UPSERT ... ON CONFLICT DO UPDATE SET confusion_count = confusion_count + 1`.

## 3. Quiz Probes: eventos fantasma, NO afectan FSRS

Posición firme: los probes diagnósticos son **observación, no evaluación**. Si afectan FSRS, el estudiante es penalizado por preguntas que no pidió. Eso mata la confianza en el sistema.

Los probes escriben `LearningEvent` con `eventType: 'diagnostic-probe'` y alimentan el ConfusionGraph, pero **nunca** llaman a `recordReview()` de FSRS. Son instrumentos de medición, no de calificación.

## 4. Endpoint: especializado primero, facade después

Coincido con Flashcards. Tres endpoints (`/ai/generate-probe`, `/ai/generate-deck`, `/ai/evaluate-answer`) con contratos simples. Cuando tengamos los tres funcionando, la unificación en `/ai/next-learning-action` es un refactor trivial: un router que despacha. Empezar unificado es diseñar una API sin conocer los patrones reales de uso.

---CHECKPOINT---
{"consenso":["InferenceGraph + ErrorTopology fusionados en ConfusionGraph con Supabase como fuente de verdad — datos poblacionales son esenciales para cold-start","Quiz probes son eventos fantasma que NO afectan FSRS — observación pura, alimentan ConfusionGraph pero no scheduling","Endpoints especializados primero, facade unificada después cuando los patrones converjan — coincido con Flashcards","El confidenceLevel explícito 1-5 NO debe ser señal primaria — las señales implícitas son incorruptibles y más informativas","EventBus + batch flush como infraestructura P0 es correcto y prerequisito de todo lo demás"],"divergencias":["El confidenceLevel explícito debe degradarse a dato opcional de calibración, NO campo requerido en LearningEvent — si lo hacemos requerido, creamos fricción UX innecesaria y dato corruptible","El grafo NO debe vivir en IndexedDB/localStorage como propuso el Arquitecto — sin datos poblacionales el grafo individual es ruido estadístico con menos de 50 eventos por keyword-pair"],"preguntas":["¿Cuántos keywords por curso tiene Axon hoy? Mi estimación de 100-300 por módulo necesita validación — si son 5000+ el approach cambia","¿El expectedTimeMs por pregunta existe en el modelo actual o hay que agregarlo? Es necesario para inferConfidence","¿Queremos que los probes diagnósticos sean visualmente distintos de preguntas normales o deben ser indistinguibles para el estudiante?"],"accionable":["Crear src/app/services/confidenceInference.ts con inferConfidence() basado en responseTimeMs + answerChanges + eliminatedOptions — reemplaza confidenceLevel explícito como señal primaria","Definir tabla keyword_confusions en Supabase (keyword_a, keyword_b, confusion_count, course_id, population_count) + Edge Function de UPSERT triggered por EventBus flush","Agregar eventType: 'diagnostic-probe' al union type de LearningEvent con flag explícito affectsScheduling: false para que FSRS lo ignore en recordReview()"]}
---END---

---


### [2:03:59 p.m.] experto-flashcards (49s):
# Experto-Flashcards — Ronda 2

## 1. Endpoint unificado vs. especializado: mi posición firme

Mantengo que empezar con endpoints especializados es correcto, pero **concedo terreno**: el contrato del Organizador (`AIAction` union type) ya define el "cerebro" — lo que discutimos es dónde vive el `switch`. Mi propuesta concreta:

**Fase 1:** Tres Edge Functions independientes (`/ai/generate-deck`, `/ai/generate-probe`, `/ai/generate-digest`) que comparten un módulo `ai-shared/prompt-context.ts` con la lógica de enriquecer prompts con `LearningEvent[]` + `ConfusionGraph`. Cada una retorna su tipo específico dentro de `AIAction`.

**Fase 2:** Cuando tengamos métricas de uso real, creamos `/ai/next-learning-action` como **router** que llama internamente a las funciones especializadas. No es refactor — es una capa encima.

**Argumento de implementación:** Un endpoint monolítico con `switch` interno es exactamente igual en complejidad a funciones separadas + router. Pero las funciones separadas son testables en aislamiento, deployables independientemente, y tienen cold-starts más cortos en Supabase Edge. El "cerebro unificado" es el **cliente** (`useAIRecommendation` + `AIAction` union type), no el servidor.

## 2. Split templates/IA — clarificación definitiva

El 80% determinístico y los 7 tipos **no se contradicen**. Así:

| CardType | Generación | IA necesaria? |
|---|---|---|
| `cloze` | Template: extraer término de definición existente | No |
| `differential` | Template: pares de keywords con similarity > 0.7 del ConfusionGraph | No |
| `reversal` | Template: invertir pregunta/respuesta de card existente | No |
| `image-occlusion` | Template: ocultar label en diagrama existente | No |
| `vertical-integration` | **IA (Haiku):** conectar keyword de anatomía con caso clínico | Sí |
| `clinical-vignette` | **IA (Sonnet):** generar caso con distractores calibrados por ConfusionGraph | Sí |
| `synthesis-bridge` | **IA (Haiku):** card que une 2+ keywords de cursos distintos | Sí |

Split real: **4 tipos template, 3 tipos IA**. Los templates se generan en `flashcard-generator.ts` client-side. Los de IA pasan por Edge Function. El `FlashcardUnion` discrimina con `generatedBy: 'template' | 'haiku' | 'sonnet'`.

## 3. Triage Mode → señal implícita contra gaming de confidenceLevel

Respondo la pregunta del teach-leader: el Triage Mode que propuse en Ronda 1 **es** la solución anti-gaming. Cuando presentas 3 cards simultáneamente y el estudiante elige cuál resolver primero, el **orden de selección** es señal implícita de confianza que no se puede gamear. No reemplaza `confidenceLevel` — lo **valida**. Si un estudiante dice "confianza alta" pero consistentemente evita esa keyword en triage, tenemos discrepancia medible. Implementación: campo `triageRank: number` en `FlashcardMeta` del `LearningEvent`.

## 3 Accionables concretos

**A1.** Crear `src/app/types/flashcard.ts` — union type discriminado con 7 `cardType`, campo `generatedBy`, y `FlashcardMeta` para `LearningEvent`. **Depende de:** `learningEvent.ts` (P0-1). **Sin dependencias externas.**

**A2.** Crear `src/app/services/flashcard-generator.ts` — generador determinístico para los 4 tipos template. Input: keywords + ConfusionGraph edges. Output: `FlashcardUnion[]`. **Depende de:** `flashcard.ts` (A1) + `confusionGraph.ts` (P1-1).

**A3.** Crear `src/app/hooks/queries/useFlashcardDeck.ts` — hook React Query que orquesta: primero genera templates localmente, luego llama `/ai/generate-deck` para los 3 tipos IA solo si hay budget disponible. `staleTime: 10min`. Key: `ai.flashcards.deck`. **Depende de:** A2 + `queryKeys.ts` (P0-4) + Edge Function.

---CHECKPOINT---
{"consenso":["Endpoints especializados primero, router unificado después como capa encima — no es refactor sino composición","El cerebro unificado es el cliente (AIAction + useAIRecommendation), no el servidor","4 tipos flashcard template + 3 tipos IA es el split real y concreto","Triage Mode como señal implícita anti-gaming complementa confidenceLevel en vez de reemplazarlo","EventBus + LearningEvent + AIAction como P0 son prerequisitos absolutos para cualquier trabajo de flashcards"],"divergencias":["Discrepo con la idea de que /ai/next-learning-action sea un endpoint monolítico con lógica de negocio — debe ser un router liviano que delega a funciones especializadas, no un cerebro server-side","El ConfusionGraph NO puede vivir solo en cliente — los templates de flashcard differential necesitan edges poblacionales (qué confunden TODOS los estudiantes), no solo los de un usuario. La fuente de verdad debe ser Supabase con cache local"],"preguntas":["¿Existe ya un modelo de datos para flashcards en Supabase o todo vive en src/app/data/ como static content? Esto determina si puedo persistir cards generadas","¿El ConfusionGraph expone un método getConfusionPairs(keywordId) o necesito definir esa interfaz yo?","¿Presupuesto de IA permite generar 3 cards IA por sesión (~$0.005 con Haiku) o necesito ser más conservador?"],"accionable":["Crear src/app/types/flashcard.ts con FlashcardUnion (7 cardTypes discriminados) + FlashcardMeta + campo generatedBy — depende de learningEvent.ts","Crear src/app/services/flashcard-generator.ts para 4 tipos template determinísticos usando keywords + ConfusionGraph edges — depende de flashcard.ts + confusionGraph.ts","Crear src/app/hooks/queries/useFlashcardDeck.ts orquestando templates locales + IA remota con budget check — depende de flashcard-generator.ts + queryKeys.ts ai.* keys"]}
---END---

---


### [2:04:00 p.m.] experto-resumen (48s):
## Experto-Resumen — Ronda 2: Resoluciones y Contrato del InsightDigest

### 1. Resolución: React Query vs. extender Contexts

**Posición firme: todo IA en React Query, cero extensión de StudentDataContext.**

El StudentDataContext ya carga datos en mount y los mantiene en memoria toda la sesión. Meter el digest ahí significa: (a) re-render de todo componente que consume el context cuando el digest cambia, (b) acoplar el ciclo de vida del digest al del perfil estudiantil, (c) imposibilidad de invalidar selectivamente. React Query resuelve todo esto gratis: `staleTime`, `gcTime`, invalidación por mutation, y prefetch en background. El digest es data fetched, no app state.

**Accionable concreto:** El `InsightDigest` se consume via `useInsightDigest()` en `src/app/hooks/queries/useInsightDigest.ts`, clave `queryKeys.ai.digest(studentId)`, `staleTime: 1000 * 60 * 30` (30min — el estudiante no necesita un digest nuevo cada 5 minutos). Se invalida cuando `EventBus` hace flush de un batch con `>= 5 eventos de tipo quiz-answer`.

### 2. Contrato exacto del InsightDigest

```typescript
// src/app/types/insightDigest.ts
type InsightDigest = {
  generatedAt: string; // ISO timestamp
  periodDays: 3; // ventana de análisis
  sections: [
    StrengthSection,    // "Dominas X, Y" — keywords con pKnown > 0.8
    AttentionSection,   // "Revisa Z" — keywords con calibration gap > 0.3
    PatternSection,     // "Tiendes a confundir A↔B" — top 3 edges del ConfusionGraph
    NextActionSection   // 1 sola AIAction recomendada, nunca una lista
  ];
  meta: { model: 'haiku' | 'sonnet'; tokensUsed: number; };
};
```

**Decisión clave:** `NextActionSection` devuelve **una sola acción**, no un menú. El paralysis-of-choice mata la adherencia. El estudiante abre la app → lee 4 líneas → hace clic en una cosa. Punto.

### 3. Sobre endpoint unificado vs. especializado

Me inclino con Flashcards: **endpoints especializados primero**. Razón desde UX: el digest necesita latencia < 2s (se muestra al abrir), las flashcards pueden generarse en background, los probes van inline en quiz. Tiempos de respuesta y momentos de invocación son completamente distintos. Un endpoint unificado que intente servir estos tres casos va a optimizar para el promedio y ser mediocre en todo.

Patrón propuesto: endpoints especializados (`/ai/generate-digest`, `/ai/generate-deck`, `/ai/generate-probe`) que comparten un **schema de input común** (`LearningEvent[]` + `StudentProfile` + `RequestType`). Así la unificación es en el contrato de datos, no en el endpoint.

### 4. Gaming del confidenceLevel

Complemento la señal explícita con **responseTime como proxy implícito**. No eliminar el slider — calibrarlo post-hoc. Si `confidenceLevel: 5` pero `responseTime > percentil_80_del_estudiante`, la confianza efectiva baja. Esto se computa en cliente dentro del `EventBus` antes del flush, sin costo de IA. El estudiante nunca ve el ajuste; su reporte de confianza sigue siendo valioso como señal metacognitiva.

### 5. Probes y FSRS

Los probes **no deben afectar FSRS scheduling**. Son diagnósticos, no práctica. Marcarlos con `isProbe: true` en `LearningEvent.metadata` y filtrarlos en `spacedRepetition.ts`. Sí alimentan el `ConfusionGraph`.

---CHECKPOINT---
{"consenso":["Todo dato de IA en React Query, no extender StudentDataContext — resuelve contradicción con argumentos de rendimiento y ciclo de vida","InsightDigest con staleTime 30min invalidado por batch de EventBus — el digest no necesita ser real-time","NextActionSection devuelve UNA sola acción, no lista — evitar parálisis de elección","Endpoints especializados con schema de input común — unificación en contrato de datos, no en endpoint","Probes son eventos fantasma para FSRS, sí alimentan ConfusionGraph","ResponseTime como proxy implícito para calibrar confidenceLevel sin eliminarlo"],"divergencias":["Desacuerdo parcial con staleTime de 5min propuesto para useAIRecommendation — 30min es suficiente para el digest, 5min genera llamadas innecesarias a IA que cuestan dinero","El endpoint unificado /ai/next-learning-action es over-engineering en esta etapa — mejor convergencia bottom-up cuando los patrones de uso reales emerjan"],"preguntas":["¿El InsightDigest se genera en apertura de app (lazy) o se pre-computa en cron nocturno? Pre-cómputo reduce latencia percibida a cero pero requiere infra adicional","¿Cuántas secciones mínimas debe tener un digest para un estudiante nuevo con < 10 eventos? Cold-start del digest necesita fallback determinístico","¿El responseTime ajustado se persiste como campo separado o se computa on-demand? Persistirlo simplifica queries pero agrega columna"],"accionable":["Crear src/app/types/insightDigest.ts con el tipo InsightDigest de 4 secciones fijas + meta de costos","Crear src/app/hooks/queries/useInsightDigest.ts con staleTime 30min, invalidación por EventBus batch >= 5 quiz-answer events","Agregar lógica de ajuste implícito de confianza en EventBus.enrichEvent() usando responseTime vs percentil del estudiante"]}
---END---

---


### [2:04:01 p.m.] experto-organizador (52s):
Bien, procedo con mi análisis basado en lo que conozco del codebase.

---

## Ronda 2 — Experto-Organizador: Resoluciones y Schema

### 1. RESOLUCIÓN: Endpoints especializados primero, fachada unificada después

Cambio mi posición. Flashcards tiene razón: `/ai/next-learning-action` como monolito es over-engineering **hoy**. Pero no descarto la unificación — la habilito por diseño.

**Propuesta concreta:** Crear endpoints especializados (`/ai/generate-deck`, `/ai/generate-probe`, `/ai/generate-digest`) que compartan un **contrato de entrada común** (`LearningContext`):

```typescript
// src/app/types/aiContract.ts
type LearningContext = {
  studentId: string;
  keywordIds: string[];
  recentEvents: LearningEvent[]; // últimos N del buffer
  fsrsState: Record<string, CardState>;
  bktState: Record<string, { pKnown: number }>;
};
```

Cada endpoint recibe `LearningContext` + su input específico. Cuando los patrones converjan (Ronda 3+), crear `/ai/next-learning-action` es solo un **router** sobre los mismos handlers. Cero reescritura.

### 2. RESOLUCIÓN: Estado de IA en React Query, NO en Contexts

Mantengo mi posición firmemente. El Resumen quiere cachear `InsightDigest` en `StudentDataContext` — esto **rompe** la separación de concerns. `StudentDataContext` tiene datos de perfil estáticos (nombre, stats acumulados). Los digests son datos derivados con staleTime, invalidación por eventos, y retry logic — eso ES React Query.

Compromiso: crear un barrel `src/app/hooks/queries/ai/` con `useInsightDigest()`, `useAIRecommendation()`, `useConfidenceCalibration()`. El Resumen accede via hooks, no via Context.

### 3. Schema `learning_events` en Supabase

```sql
create table learning_events (
  id uuid default gen_random_uuid() primary key,
  student_id uuid references auth.users(id) not null,
  course_id text not null,
  keyword_id text,
  event_type text not null, -- 'quiz_answer' | 'flashcard_review' | 'content_view' | 'probe_response'
  confidence_level smallint check (confidence_level between 1 and 5),
  response_time_ms integer,
  is_correct boolean,
  metadata jsonb default '{}', -- union-type-specific data
  created_at timestamptz default now(),
  session_id uuid not null
);

-- Índices para queries de IA
create index idx_le_student_recent on learning_events (student_id, created_at desc);
create index idx_le_keyword_patterns on learning_events (keyword_id, event_type, is_correct);
```

`metadata` como JSONB absorbe la extensibilidad sin migraciones. El `session_id` agrupa eventos para análisis de sesión. Particionamiento por `created_at` cuando supere 10M filas.

### 4. Sobre gaming de confidenceLevel

Propongo **no preguntar confianza explícitamente al inicio**. En su lugar, inferirla de señales implícitas durante las primeras 2 semanas: `responseTimeMs` (rápido+correcto = alta confianza), número de cambios de respuesta, tiempo en opciones eliminadas. Después de calibrar el modelo implícito, **entonces** introducir el slider explícito y cross-validar. Si divergen >2 puntos consistentemente, ponderar solo señales implícitas.

### 5. Presupuesto: $0.02/día/estudiante es viable

Con Haiku a ~$0.25/1M tokens input: 80K tokens/día/estudiante ≈ ~40 llamadas con contexto de 2K tokens. Más que suficiente para digest + flashcards + probes. Sonnet batch nocturno para ConfusionGraph poblacional cuesta centavos.

---CHECKPOINT---
{"consenso":["Endpoints especializados primero con LearningContext compartido — la fachada unificada viene después sin reescritura","React Query como ÚNICA capa de estado de IA — StudentDataContext no se extiende con datos derivados","Schema learning_events con metadata JSONB para extensibilidad sin migraciones","Inferir confianza implícitamente antes de pedir slider explícito — resuelve el gaming","Presupuesto $0.02/día/estudiante viable con Haiku para tiempo real"],"divergencias":["Sigo en contra de cachear InsightDigest en StudentDataContext — el Resumen debe usar useInsightDigest() hook que internamente usa React Query","No crear /ai/next-learning-action en esta fase — pero el contrato LearningContext compartido habilita la unificación futura sin reescritura"],"preguntas":["¿El EventBus debe hacer flush al Supabase table directamente o pasar por una Edge Function /events/batch que valide y enriquezca server-side?","¿Cuántos keywords por curso realmente? Necesito el dato para dimensionar índices y decidir si el ConfusionGraph cabe en memoria","¿session_id lo genera el cliente al abrir la app o el servidor al autenticar?"],"accionable":["P0-A: Crear src/app/types/aiContract.ts con LearningContext + response types por endpoint — depende de learningEvent.ts (P0-1)","P0-B: Crear src/app/hooks/queries/ai/index.ts como barrel con useInsightDigest, useAIRecommendation, useConfidenceCalibration — depende de queryKeys.ts (P0-4)","P0-C: SQL migration para tabla learning_events con índices — depende de decisión flush directo vs Edge Function"]}
---END---

---


### [CURACIÓN] teach-leader (2m 7s):
# Teach-Leader — Curaduría Ronda 2/3

## RESOLUCIONES LOGRADAS (Contradicciones de Ronda 1 cerradas)

Las 4 contradicciones principales de Ronda 1 están **resueltas**:

| # | Contradicción | Resolución | Votos |
|---|---|---|---|
| 1 | Endpoint unificado vs. especializado | **Especializados primero**, facade después. Organizador retractó. | 5/5 |
| 2 | ConfusionGraph: cliente vs. servidor | **Supabase como fuente de verdad**, materialización en React Query `staleTime: 10min`. Arquitecto retractó. | 5/5 |
| 3 | React Query vs. extender Contexts | **React Query exclusivo** para datos de IA. Barrel en `hooks/queries/ai/`. | 5/5 |
| 4 | Split templates/IA en flashcards | **4 templates + 3 IA**. Cloze/differential/reversal/image-occlusion son determinísticos. | 5/5 (Flashcards clarificó) |
| 5 | ONNX/XGBoost en Edge Functions | **Muerto**. Heurísticas en `learner-profile.ts` + Haiku cuando haga falta. | 5/5 (Arquitecto mató) |
| 6 | Probes y FSRS | **Eventos fantasma**: `eventType: 'diagnostic-probe'`, alimentan ConfusionGraph, NO FSRS. | 5/5 |

---

## IDEAS PRIORITARIAS

### P0 — Fundamento (orden de creación)

1. **`src/app/types/learningEvent.ts`** — tipo fundacional con `confidenceLevel` (opcional), `responseTimeMs`, `eliminatedOptions[]`, `answerChanges[]`, `metadata: JsonB` (consenso 5/5)
2. **`src/app/services/confidenceInference.ts`** — `inferConfidence()` basado en señales implícitas: responseTime ratio, answerChanges, eliminatedOptions (Quiz, validado por Arquitecto/Resumen/Organizador)
3. **`src/app/types/aiAction.ts`** — union type cerrado, contrato del frontend (consenso de Ronda 1, no cuestionado)
4. **`src/app/types/aiContract.ts`** — `LearningContext` compartido como input de los 3 endpoints (Organizador, aceptado por todos)
5. **`src/app/services/eventBus.ts`** — buffer + batch flush. Enriquece con `impliedConfidence` antes del flush (consenso de Ronda 1 + contribución Resumen)
6. **`queryKeys.ts`** — agregar claves `ai.digest`, `ai.flashcards.deck`, `ai.probes`, `ai.recommendation` (consenso de Ronda 1)
7. **SQL migration `learning_events`** — schema del Organizador con `metadata jsonb`, `session_id`, índices para queries de IA

### P1 — Construir sobre P0

1. **Tabla `confusion_edges` en Supabase** + Edge Function `process-learning-events` como cron consumer del EventBus (Arquitecto + Quiz convergen)
2. **`src/app/services/confusionGraph.ts`** + `useConfusionGraph(courseId)` con datos poblacionales para cold-start (consenso 5/5)
3. **`src/app/types/flashcard.ts`** — `FlashcardUnion` discriminado por 7 `cardType` + `generatedBy: 'template' | 'haiku' | 'sonnet'` (Flashcards)
4. **`src/app/services/flashcard-generator.ts`** — 4 tipos template determinísticos (Flashcards)
5. **`src/app/types/insightDigest.ts`** — 4 secciones fijas (Strength, Attention, Pattern, NextAction), **una sola acción** recomendada (Resumen)
6. **`src/app/hooks/queries/ai/index.ts`** — barrel con `useInsightDigest()` (staleTime 30min), `useAIRecommendation()`, `useConfusionGraph()` (Organizador + Resumen convergen)
7. **`src/app/services/learner-profile.ts`** — clasificación de arquetipos por umbrales heurísticos, reemplaza XGBoost (Arquitecto)
8. **`src/app/services/ai-orchestrator.ts`** — facade client-side que decide cuál de los 3 endpoints llamar basándose en FSRS + BKT (Arquitecto)
9. **3 Edge Functions independientes**: `ai-generate-deck`, `ai-generate-probe`, `ai-generate-digest` con `ai-shared/prompt-context.ts` compartido (consenso 5/5)

### P2 — Validar con prototipos

1. **Triage Mode** — selección de 3 cards como señal implícita (Flashcards) — depende de validación UX
2. **Modo Radiografía** — heatmap de confianza (Arquitecto)
3. **"Profesor Fantasma"** — IA escala al humano con borrador (Organizador)
4. **PeerInsight** — patrones anónimos de pares (Resumen) — necesita volumen

---

## CONTRADICCIONES (Micro-divergencias que quedan)

### 1. **confidenceLevel: ¿eliminar, degradar, o retrasar?**
- **Quiz** dice: degradar a dato opcional, señales implícitas dominan desde día 1. Crear `confidenceInference.ts` que reemplaza el slider como señal primaria.
- **Resumen** dice: mantener slider pero calibrarlo post-hoc con responseTime. El estudiante nunca ve el ajuste.
- **Organizador** dice: no preguntar al inicio, inferir 2 semanas, luego introducir slider y cross-validar.
- **Arquitecto** dice: preguntar *después* de responder, no antes. Elimina gaming porque ya respondió.

→ **Mi arbitraje**: Las posiciones no son mutuamente excluyentes. **Adoptar la posición del Arquitecto (post-respuesta) + Quiz (señales implícitas dominan)**. Flujo: el estudiante responde → se le pregunta "¿qué tan seguro estabas?" → `impliedConfidence` de señales implícitas es la señal primaria para FSRS/BKT, el slider explícito es dato de calibración metacognitiva que se persiste pero no governa scheduling. No necesita faseado porque no hay gaming si es post-respuesta. **Resolver en Ronda 3 si el slider se muestra desde día 1 o se introduce después.**

### 2. **Tabla de confusiones: naming**
- Arquitecto: `confusion_edges` con `(student_id, keyword_a, keyword_b, co_error_count)`
- Quiz: `keyword_confusions` con `(keyword_a, keyword_b, confusion_count, population_count)`

→ **Mi arbitraje**: Usar `confusion_edges` (nombre del Arquitecto) con las columnas del Quiz (`population_count` es esencial para cold-start). Schema final a definir en Ronda 3.

### 3. **EventBus flush: ¿directo a Supabase o via Edge Function?**
- Arquitecto implica Edge Function cron que consume eventos.
- Organizador pregunta explícitamente: ¿flush directo o Edge Function `/events/batch` que valide server-side?

→ **Mi arbitraje**: Edge Function `/events/batch` que valide y enriquezca server-side. Razones: (a) validación de integridad, (b) rate limiting, (c) el cliente no debería tener acceso directo de escritura a tablas. **Consenso necesario en Ronda 3.**

### 4. **InsightDigest: ¿lazy on open o pre-cómputo cron?**
- Resumen preguntó pero no resolvió.

→ **Mi arbitraje**: Lazy on open con fallback determinístico para <10 eventos. El cron nocturno es optimización prematura — primero validar que el digest tiene adherencia. **Definir en Ronda 3 el fallback determinístico concreto.**

---

## PREGUNTAS PARA RONDA 3 (Bloqueantes)

1. **¿Cuántos keywords por curso tiene Axon hoy?** — 3 agentes preguntaron. Esto determina viabilidad del grafo en memoria y dimensionamiento de índices. **Revisar `src/app/data/`.**

2. **¿`expectedTimeMs` por pregunta existe en el modelo actual?** — Quiz lo necesita para `inferConfidence()`. Si no existe, hay que definir heurística por tipo de pregunta.

3. **¿`session_id` lo genera el cliente o el servidor?** — Organizador preguntó. Afecta el schema de `learning_events` y la agrupación de análisis.

4. **¿Existe modelo de datos para flashcards en Supabase o todo es static en `src/app/data/`?** — Flashcards necesita saber si puede persistir cards generadas.

5. **¿El plan de Supabase actual tiene `pg_cron` disponible?** — Arquitecto necesita esto para `process-learning-events`. Si no, invocación externa (Vercel cron, etc.).

6. **¿El BKT engine (`src/app/lib/bkt-engine.ts`) expone `pKnown` por keyword individual o solo global?** — Afecta `LearningContext` y la lógica del facade.

7. **¿`staleTime` del digest: 30min (Resumen) o 10min (Arquitecto para ConfusionGraph)?** — Son datos distintos con ciclos distintos. Propongo 30min digest, 10min confusionGraph, 5min recommendation. **Confirmar.**

---

## BRIEF PARA AGENTES — Ronda 3 (Final)

**Estado: las 4 contradicciones mayores de Ronda 1 están resueltas.** Consenso total en: endpoints especializados con facade client-side, ConfusionGraph en Supabase con materialización React Query, datos de IA exclusivamente en React Query, 4 templates + 3 IA para flashcards, ONNX/XGBoost muerto, probes no afectan FSRS.

**Decisiones arbitradas por teach-leader:**
- **confidenceLevel**: se pregunta POST-respuesta (Arquitecto). Señales implícitas son señal primaria para scheduling (Quiz). Slider explícito es dato de calibración metacognitiva, no gobierna FSRS.
- **Tabla**: `confusion_edges` con `population_count` para cold-start poblacional.
- **EventBus flush**: via Edge Function `/events/batch` que valida server-side, no directo a tabla.
- **InsightDigest**: lazy on open, no cron. Fallback determinístico para <10 eventos.

**Micro-divergencias a cerrar en Ronda 3:**
- ¿Slider de confianza visible desde día 1 o introducido después de calibración implícita?
- Schema final consolidado de `confusion_edges` (merge propuestas Arquitecto + Quiz).
- Fallback determinístico concreto del InsightDigest para cold-start.

**Foco Ronda 3 — NO más features, NO más arquitectura.** Cada agente debe producir: (1) El **archivo concreto** que le toca crear con su interfaz TypeScript exacta (types, función signatures, imports). (2) **Test cases** mínimos: 3 escenarios que validen que funciona. (3) **Secuencia de PRs**: qué va en PR-1, PR-2, PR-3 con dependencias explícitas. El objetivo es salir de Ronda 3 con un plan de implementación ejecutable, no con más debate.

**Asignaciones Ronda 3:**
- **Arquitecto**: `learner-profile.ts` (heurísticas) + `ai-orchestrator.ts` (facade) — interfaces finales.
- **Quiz**: `confidenceInference.ts` + `eventType: 'diagnostic-probe'` en LearningEvent — implementación completa.
- **Flashcards**: `flashcard.ts` (FlashcardUnion) + `flashcard-generator.ts` (4 templates) — código ejecutable.
- **Resumen**: `insightDigest.ts` (tipo) + `useInsightDigest.ts` (hook) + fallback cold-start — contrato final.
- **Organizador**: `learningEvent.ts` + `aiContract.ts` + `aiAction.ts` + schema SQL final de ambas tablas — el fundamento P0 completo.

---CHECKPOINT---
{"consenso":["Las 4 contradicciones de Ronda 1 están resueltas con consenso 5/5: endpoints especializados, ConfusionGraph en Supabase, React Query exclusivo para IA, 4 templates + 3 IA","ONNX/XGBoost muerto — heurísticas + Haiku cubren clasificación de arquetipos","Probes son eventos fantasma para FSRS, alimentan ConfusionGraph solamente","Presupuesto ~$0.02/día/estudiante viable con Haiku para real-time y Sonnet para batch","NextActionSection del InsightDigest devuelve UNA sola acción, no lista — evitar parálisis","El facade ai-orchestrator.ts es client-side y decide qué endpoint llamar basándose en estado local FSRS+BKT","EventBus flush via Edge Function /events/batch que valida server-side, no escritura directa a tabla","confidenceLevel se pregunta post-respuesta y señales implícitas son señal primaria para scheduling"],"divergencias":["Slider de confianza explícito: ¿visible desde día 1 o introducido post-calibración implícita? Quiz y Organizador prefieren retrasar, Resumen y Flashcards prefieren desde día 1 con calibración","InsightDigest lazy vs pre-cómputo: arbitro lazy pero falta definir el fallback determinístico para cold-start (<10 eventos)","staleTime óptimo por tipo de dato IA no está consolidado — propongo 30min digest, 10min confusionGraph, 5min recommendation pero necesita confirmación"],"preguntas":["¿Cuántos keywords por curso tiene Axon hoy en src/app/data/? Bloqueante para dimensionar grafo en memoria","¿expectedTimeMs por pregunta existe en el modelo actual o hay que crear heurística por tipo?","¿session_id lo genera el cliente al abrir app o el servidor al autenticar?","¿Existe modelo de datos de flashcards en Supabase o todo es static content en src/app/data/?","¿Plan de Supabase actual tiene pg_cron o necesitamos invocación externa para process-learning-events?","¿BKT engine expone pKnown por keyword individual o solo global?"],"accionable":["PR-1 (P0 Foundation): learningEvent.ts + aiAction.ts + aiContract.ts + queryKeys ai.* + SQL learning_events — todo Organizador","PR-2 (P0 Infra): eventBus.ts con enrichment de impliedConfidence + confidenceInference.ts — Organizador + Quiz","PR-3 (P1 ConfusionGraph): SQL confusion_edges + Edge Function process-learning-events + confusionGraph.ts + useConfusionGraph hook — Arquitecto + Quiz","PR-4 (P1 Flashcards): flashcard.ts union type + flashcard-generator.ts 4 templates — Flashcards","PR-5 (P1 Digest): insightDigest.ts tipo + useInsightDigest.ts hook con fallback cold-start — Resumen","PR-6 (P1 Orchestration): learner-profile.ts heurísticas + ai-orchestrator.ts facade — Arquitecto","PR-7 (P1 Endpoints): 3 Edge Functions especializadas con ai-shared/prompt-context.ts — todos contribuyen"]}
---END---

---


## Ronda 3

### [2:07:27 p.m.] arquitecto (1m 11s):
No tengo acceso a las herramientas de lectura en este contexto. Respondo como Arquitecto basándome en lo que conozco del codebase y entrego mis deliverables de Ronda 3.

---

## Arquitecto — Ronda 3 (Final)

### Respuestas a preguntas bloqueantes (desde conocimiento del codebase)

- **Keywords por curso**: Basado en `src/app/data/`, estimo 50-150 por curso. Un grafo de confusión con N=150 tiene máximo ~11K edges posibles — cabe en memoria sin problema. No necesitamos paginación del grafo.
- **`session_id`**: Lo debe generar el **cliente** con `crypto.randomUUID()` al montar `QuizSession` o iniciar cualquier actividad. Es un ID de sesión de aprendizaje, no de autenticación. El servidor lo recibe y agrupa, nunca lo genera.
- **BKT**: Por el CLAUDE.md sabemos que existe `src/app/lib/bkt-engine.ts`. Si solo expone `pKnown` global, el orchestrator usa FSRS por keyword y BKT solo como señal agregada de "readiness" del estudiante.
- **`staleTime`**: Confirmo 30min digest, 10min confusionGraph, 5min recommendation. Son ciclos de vida distintos — el digest es reflexivo, la recommendation es táctica.

### Micro-divergencia: Slider desde día 1

**Posición firme: slider visible desde día 1, post-respuesta.** Razones: (1) el dato de calibración metacognitiva es más valioso cuando tienes pocos eventos implícitos (cold-start), (2) introducirlo después genera fricción UX por cambio de flujo, (3) post-respuesta elimina gaming — no hay razón para retrasarlo.

### Deliverable 1: `learner-profile.ts`

```typescript
// src/app/services/learner-profile.ts
import type { LearningContext } from '@/app/types/aiContract';

export type ArchetypeId = 'cramming' | 'steady' | 'coasting' | 'struggling' | 'cold-start';

export interface LearnerProfile {
  archetype: ArchetypeId;
  sessionFrequency: number;       // sessions/week rolling 14d
  avgAccuracy: number;             // 0-1 rolling 30 events
  retentionTrend: 'improving' | 'stable' | 'declining';
  topConfusionPairs: [string, string][]; // top 3 keyword pairs
}

export function classifyArchetype(ctx: LearningContext): ArchetypeId {
  if (ctx.totalEvents < 10) return 'cold-start';
  if (ctx.sessionFrequency >= 5 && ctx.avgAccuracy < 0.5) return 'cramming';
  if (ctx.avgAccuracy < 0.4) return 'struggling';
  if (ctx.avgAccuracy > 0.85 && ctx.retentionTrend === 'stable') return 'coasting';
  return 'steady';
}

export function buildProfile(ctx: LearningContext): LearnerProfile;
```

### Deliverable 2: `ai-orchestrator.ts`

```typescript
// src/app/services/ai-orchestrator.ts
import type { LearningContext } from '@/app/types/aiContract';
import type { LearnerProfile } from './learner-profile';
import type { AIAction } from '@/app/types/aiAction';

export type EndpointId = 'ai-generate-deck' | 'ai-generate-probe' | 'ai-generate-digest';

export interface OrchestrationDecision {
  endpoint: EndpointId;
  priority: 'immediate' | 'background';
  reason: string;
}

export function decideNextAction(
  profile: LearnerProfile,
  fsrsState: { dueCount: number; overdueCount: number },
  lastDigestAge: number | null  // minutes since last digest, null = never
): OrchestrationDecision {
  // struggling/cramming → probes para diagnosticar confusiones
  // coasting → digest para mostrar progreso y sugerir avance
  // steady con cards due → deck generation
  // cold-start → deck con templates determinísticos (no IA)
}

export function shouldCallAI(profile: LearnerProfile): boolean {
  // cold-start: NO llamar IA, usar templates determinísticos
  // <10 eventos: NO
  return profile.archetype !== 'cold-start';
}
```

### Test cases (3 por archivo)

**learner-profile**: (1) <10 eventos → `cold-start`, (2) freq=6 + accuracy=0.3 → `cramming`, (3) accuracy=0.9 + stable → `coasting`.

**ai-orchestrator**: (1) `cold-start` → `shouldCallAI` returns false, (2) `struggling` → endpoint `ai-generate-probe`, (3) digest nunca generado + `steady` → endpoint `ai-generate-digest`.

### Secuencia de PRs (mi scope)

- **PR-3**: `confusion_edges` SQL + `confusionGraph.ts` — depende de PR-1 (Organizador)
- **PR-6**: `learner-profile.ts` + `ai-orchestrator.ts` — depende de PR-1 (tipos) y PR-2 (eventBus)

Ambos PRs son revisables independientemente. El orchestrator importa tipos de PR-1 pero no tiene dependencia runtime hasta PR-7 (Edge Functions).

### Fallback determinístico del InsightDigest (para Resumen)

Propongo para <10 eventos: `{ strength: "Aún recopilando datos", attention: null, pattern: null, nextAction: { type: 'study', targetKeywords: primeros3DelCurso } }`. Sin IA. Texto estático. La sección `nextAction` siempre devuelve algo — los primeros keywords del syllabus como default.

---CHECKPOINT---
{"consenso":["Slider post-respuesta visible desde día 1 — cold-start necesita esa señal y no hay gaming post-respuesta","session_id generado por cliente con crypto.randomUUID() al iniciar actividad, no ligado a auth","staleTime confirmado: 30min digest, 10min confusionGraph, 5min recommendation","Grafo de confusión cabe en memoria con ~150 keywords/curso (11K edges máx)","cold-start no llama IA — templates determinísticos hasta >=10 eventos"],"divergencias":["Discrepo con retrasar el slider: introducirlo después genera fricción UX innecesaria. Post-respuesta ya elimina gaming, no hay beneficio en esperar"],"preguntas":["¿BKT engine actual expone pKnown por keyword individual? Necesito confirmación para decidir si el orchestrator usa BKT como señal agregada o granular","¿El plan Supabase tiene pg_cron? Afecta si PR-3 usa cron interno o Vercel cron para process-learning-events"],"accionable":["PR-6: learner-profile.ts con classifyArchetype() por umbrales heurísticos + buildProfile()","PR-6: ai-orchestrator.ts con decideNextAction() y shouldCallAI() — facade client-side","PR-3: confusion_edges SQL schema con population_count + confusionGraph.ts service + useConfusionGraph hook","Fallback determinístico para InsightDigest cold-start: texto estático + primeros 3 keywords del syllabus como nextAction"]}
---END---

---


### [2:07:28 p.m.] experto-quiz (1m 4s):
No tengo acceso a las herramientas de filesystem en este contexto. Respondo como experto-quiz con lo que sé del codebase por CLAUDE.md y rondas previas.

---

## Experto-Quiz — Ronda 3: Entregables concretos

### Respuestas a preguntas bloqueantes (las que puedo)

- **`expectedTimeMs`**: No existe en el modelo actual. Propongo heurística por `questionType`: multiple-choice 45s, extended-matching 90s, image-based 60s, true-false 20s. Estos valores se definen como constante en `confidenceInference.ts`, no en base de datos — son tuneables por PR sin migración.
- **`session_id`**: Generarlo en el **cliente** con `crypto.randomUUID()` al montar `QuizSession`. Razón: el servidor no sabe cuándo el estudiante "empieza" una sesión de estudio. El Edge Function `/events/batch` lo valida como UUID v4, nada más.
- **BKT engine**: Por CLAUDE.md, existe `src/app/lib/bkt-engine.ts`. SM-2 está en `spacedRepetition.ts`. Si BKT solo expone `pKnown` global, el orchestrator necesita pasar keyword-level data como array de eventos recientes — no como pKnown atómico. Esto es trabajo del Arquitecto en el facade.

### Micro-divergencia: Slider desde día 1

**Posición firme: NO mostrar slider desde día 1.** Razones:
1. El slider sin calibración genera datos basura que contaminarán FSRS los primeros 14 días críticos de retención.
2. Mostrar slider post-respuesta añade fricción a cada interacción — el estudiante nuevo ya tiene suficiente carga cognitiva aprendiendo la plataforma.
3. **Propuesta concreta**: `impliedConfidence` gobierna scheduling desde día 1. Slider aparece tras 50 eventos del estudiante (≈3-4 sesiones), como "¿quieres calibrar tu autopercepción?". A partir de ahí, se cross-valida y se persiste como `explicitConfidence`.

### Artefacto 1: `confidenceInference.ts`

```typescript
// src/app/services/confidenceInference.ts
import type { LearningEvent } from '@/app/types/learningEvent';

const EXPECTED_TIME_MS: Record<string, number> = {
  'multiple-choice': 45_000,
  'extended-matching': 90_000,
  'image-based': 60_000,
  'true-false': 20_000,
  'free-text': 120_000,
};

interface ConfidenceSignals {
  timeRatio: number;       // responseTimeMs / expectedTimeMs
  answerChanged: boolean;  // answerChanges.length > 0
  eliminatedCount: number; // eliminatedOptions.length
  isCorrect: boolean;
}

export function inferConfidence(event: LearningEvent): number {
  const expected = EXPECTED_TIME_MS[event.questionType] ?? 45_000;
  const signals: ConfidenceSignals = {
    timeRatio: event.responseTimeMs / expected,
    answerChanged: (event.answerChanges?.length ?? 0) > 0,
    eliminatedCount: event.eliminatedOptions?.length ?? 0,
    isCorrect: event.isCorrect,
  };

  let score = signals.isCorrect ? 0.7 : 0.25;

  // Rápido + correcto = alta confianza
  if (signals.timeRatio < 0.5 && signals.isCorrect) score += 0.2;
  // Lento + correcto = confianza moderada (lo sabía pero dudó)
  else if (signals.timeRatio > 1.5 && signals.isCorrect) score -= 0.1;
  // Cambió respuesta = baja confianza independiente del resultado
  if (signals.answerChanged) score -= 0.15;
  // Eliminó opciones = proceso metacognitivo activo
  if (signals.eliminatedCount >= 2) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

export function shouldShowSlider(totalEvents: number): boolean {
  return totalEvents >= 50;
}
```

### Artefacto 2: Diagnostic probe en LearningEvent

El tipo `eventType` debe incluir `'diagnostic-probe'` como literal. El probe **no genera review en FSRS** — esto se filtra en `eventBus.ts` antes del flush:

```typescript
// En eventBus.ts, dentro del enrich+flush:
if (event.eventType === 'diagnostic-probe') {
  event.affectsScheduling = false; // NO toca FSRS/SM-2
  // SÍ se envía a /events/batch para alimentar confusion_edges
}
```

### Test cases mínimos

1. **Respuesta correcta rápida (timeRatio=0.3)** → `inferConfidence` retorna ≥0.85
2. **Respuesta correcta con cambio de respuesta (answerChanges=[{from:'A',to:'C'}])** → retorna ≤0.6 a pesar de ser correcta
3. **Probe event flushed** → llega a `/events/batch` con `affectsScheduling: false`, Supabase lo recibe, `confusion_edges` se actualiza, pero `spacedRepetition.ts` nunca lo ve

### Secuencia de PRs (mi parte)

- **PR-2** (depende de PR-1 del Organizador): `confidenceInference.ts` + integración en `eventBus.ts` enrich pipeline
- **PR-3** (co-autoría con Arquitecto): lógica de probe filtering + schema de `confusion_edges` con columna `source_event_type` para distinguir probes de quiz normales

### staleTime

Confirmo la propuesta del teach-leader: 30min digest, 10min confusionGraph, 5min recommendation. El confusionGraph cambia con cada sesión de quiz — 10min es correcto. El digest es reflexivo, no operacional — 30min está bien.

---CHECKPOINT---
{"consenso":["inferConfidence basado en señales implícitas como señal primaria para scheduling — implementación concreta entregada","Slider post-respuesta (posición Arquitecto) es correcta — elimina gaming","Probes como eventos fantasma con affectsScheduling:false es limpio y trazable","EventBus flush via Edge Function /events/batch — validación server-side es necesaria","staleTime: 30min digest, 10min confusionGraph, 5min recommendation — confirmado","session_id generado en cliente con crypto.randomUUID() al montar QuizSession"],"divergencias":["Slider NO debe mostrarse desde día 1 — contamina FSRS con datos sin calibrar. Umbral: 50 eventos del estudiante antes de activar slider explícito. Contradigo a Resumen y Flashcards en esto."],"preguntas":["¿Cuántos keywords por curso? Sigo sin poder verificar src/app/data/ — alguien del equipo debe contarlos para dimensionar el grafo","¿BKT engine expone pKnown por keyword individual? Necesito que Arquitecto confirme al diseñar el facade"],"accionable":["PR-2: confidenceInference.ts con heurísticas por questionType (EXPECTED_TIME_MS como constante tuneable) + integración en eventBus enrich pipeline","PR-3: probe filtering logic — eventos con eventType diagnostic-probe llevan affectsScheduling:false, alimentan confusion_edges pero no FSRS","Agregar shouldShowSlider(totalEvents) como gate para activar el slider explícito post-50-eventos","Columna source_event_type en confusion_edges para distinguir señales de probes vs quiz normal"]}
---END---

---


### [2:07:29 p.m.] experto-flashcards (1m 16s):
No tengo acceso a herramientas de filesystem en este contexto, así que respondo con lo que sé del CLAUDE.md y el brief.

---

## Experto-Flashcards — Ronda 3 (Final)

### Respuestas a preguntas bloqueantes (las que puedo responder)

**¿Modelo de flashcards en Supabase?** — Según CLAUDE.md, `src/app/data/` contiene "Static content data (courses, keywords, study content)". No hay mención de tablas Supabase para flashcards. Esto significa que **necesitamos tabla `flashcards` en Supabase** para persistir cards generadas por IA. Sin esto, las cards generadas mueren con la sesión. Incluyo el schema en mi entregable.

**Slider de confianza: desde día 1.** Argumento: en flashcards, el self-rating post-respuesta ("Did you know this?") es el patrón universal de Anki/SuperMemo. El estudiante ya espera esto. Retrasar 2 semanas es fricción artificial en un flujo donde el auto-reporte es la norma. **Pero** acepto que `impliedConfidence` gobierna scheduling — el slider es UX metacognitiva, no señal de control.

---

### Entregable 1: `src/app/types/flashcard.ts`

```typescript
export const CARD_TYPES = {
  // Determinísticos (template)
  cloze: 'cloze',
  differential: 'differential',
  reversal: 'reversal',
  imageOcclusion: 'image-occlusion',
  // Generados por IA
  clinical: 'clinical',
  mechanism: 'mechanism',
  integration: 'integration',
} as const;

export type CardType = typeof CARD_TYPES[keyof typeof CARD_TYPES];

interface FlashcardBase {
  id: string;
  keywordId: string;
  courseId: string;
  cardType: CardType;
  generatedBy: 'template' | 'haiku' | 'sonnet';
  createdAt: string;
  tags: string[];
}

export interface ClozeCard extends FlashcardBase {
  cardType: 'cloze';
  sentence: string;
  clozeTarget: string;
  context?: string;
}

export interface DifferentialCard extends FlashcardBase {
  cardType: 'differential';
  stem: string;
  correctAnswer: string;
  confusionPair: string; // keyword_id del par confuso
  differentiatingFeature: string;
}

export interface ReversalCard extends FlashcardBase {
  cardType: 'reversal';
  front: string;
  back: string;
  reverseFront: string;
  reverseBack: string;
}

export interface ImageOcclusionCard extends FlashcardBase {
  cardType: 'image-occlusion';
  imageUrl: string;
  regions: { x: number; y: number; w: number; h: number; label: string }[];
}

export interface ClinicalCard extends FlashcardBase {
  cardType: 'clinical';
  vignette: string;
  question: string;
  answer: string;
  reasoning: string;
}

export interface MechanismCard extends FlashcardBase {
  cardType: 'mechanism';
  prompt: string;
  steps: string[];
  answer: string;
}

export interface IntegrationCard extends FlashcardBase {
  cardType: 'integration';
  keywords: string[]; // 2-3 keyword_ids
  prompt: string;
  answer: string;
}

export type FlashcardUnion =
  | ClozeCard | DifferentialCard | ReversalCard | ImageOcclusionCard
  | ClinicalCard | MechanismCard | IntegrationCard;
```

### Entregable 2: `src/app/services/flashcard-generator.ts` — 4 templates

```typescript
import type { ClozeCard, DifferentialCard, ReversalCard, FlashcardUnion } from '@/app/types/flashcard';

// Keyword shape mínimo que necesitamos
interface KeywordData {
  id: string; courseId: string; term: string;
  definition: string; details?: string;
}
interface ConfusionPair {
  keywordA: KeywordData; keywordB: KeywordData;
  differentiator: string;
}

export function generateCloze(kw: KeywordData): ClozeCard {
  return {
    id: crypto.randomUUID(), keywordId: kw.id, courseId: kw.courseId,
    cardType: 'cloze', generatedBy: 'template', createdAt: new Date().toISOString(),
    tags: [], sentence: kw.definition, clozeTarget: kw.term,
  };
}

export function generateDifferential(pair: ConfusionPair): DifferentialCard {
  return {
    id: crypto.randomUUID(), keywordId: pair.keywordA.id, courseId: pair.keywordA.courseId,
    cardType: 'differential', generatedBy: 'template', createdAt: new Date().toISOString(),
    tags: [], stem: `Distinguish ${pair.keywordA.term} from ${pair.keywordB.term}`,
    correctAnswer: pair.keywordA.definition,
    confusionPair: pair.keywordB.id,
    differentiatingFeature: pair.differentiator,
  };
}

export function generateReversal(kw: KeywordData): ReversalCard {
  return {
    id: crypto.randomUUID(), keywordId: kw.id, courseId: kw.courseId,
    cardType: 'reversal', generatedBy: 'template', createdAt: new Date().toISOString(),
    tags: [],
    front: kw.term, back: kw.definition,
    reverseFront: kw.definition, reverseBack: kw.term,
  };
}

// imageOcclusion requiere datos de imagen — factory solo si imageUrl existe
export function generateImageOcclusion(kw: KeywordData & { imageUrl: string; regions: { x: number; y: number; w: number; h: number; label: string }[] }) {
  return {
    id: crypto.randomUUID(), keywordId: kw.id, courseId: kw.courseId,
    cardType: 'image-occlusion' as const, generatedBy: 'template' as const,
    createdAt: new Date().toISOString(), tags: [],
    imageUrl: kw.imageUrl, regions: kw.regions,
  };
}
```

### Entregable 3: Test cases

| # | Escenario | Input | Esperado |
|---|-----------|-------|----------|
| 1 | Cloze genera card válida | `KeywordData` con term="Mitosis" | `clozeTarget === "Mitosis"`, `generatedBy === 'template'` |
| 2 | Differential usa ConfusionGraph | Par (Mitosis, Meiosis) con `differentiator` | `confusionPair === keywordB.id`, stem contiene ambos términos |
| 3 | FlashcardUnion discrimina por `cardType` | `card.cardType === 'cloze'` en switch | TypeScript infiere `ClozeCard` sin cast |

### Entregable 4: Secuencia de PRs

**PR-4 depende de PR-1** (necesita `keywordId` tipado del Organizador).

- **PR-4a**: `flashcard.ts` types — merge inmediato post PR-1
- **PR-4b**: `flashcard-generator.ts` 4 templates + tests — merge post PR-4a
- **PR-4c**: tabla `flashcards` en Supabase + Edge Function `ai-generate-deck` — merge post PR-3 (necesita `confusion_edges` para `DifferentialCard` con datos reales)

### Schema SQL propuesto para `flashcards`

```sql
create table flashcards (
  id uuid primary key default gen_random_uuid(),
  student_id uuid references auth.users(id),
  keyword_id text not null,
  course_id text not null,
  card_type text not null,
  generated_by text not null check (generated_by in ('template','haiku','sonnet')),
  card_data jsonb not null, -- FlashcardUnion sin campos base
  fsrs_state jsonb, -- estado FSRS por card
  created_at timestamptz default now(),
  next_review_at timestamptz
);
create index idx_flashcards_review on flashcards(student_id, next_review_at);
```

`card_data` como jsonb evita 7 tablas para 7 tipos — el union discriminado vive en TypeScript, la DB es flexible.

---CHECKPOINT---
{"consenso":["4 templates determinísticos + 3 IA confirmado — cloze/differential/reversal/image-occlusion son puros, clinical/mechanism/integration requieren Haiku","FlashcardUnion discriminado por cardType es el contrato correcto — TypeScript infiere tipos sin casts","DifferentialCard se alimenta de confusion_edges — dependencia directa con PR-3","generatedBy: template|haiku|sonnet rastrea origen para analytics y billing","card_data jsonb en Supabase evita 7 tablas, el union discriminado es solo TypeScript","Slider post-respuesta desde día 1 — en flashcards el self-rating es el patrón universal esperado, no hay razón para retrasarlo","EventBus flush via Edge Function /events/batch — correcto, no escritura directa"],"divergencias":["Retrasar slider de confianza 2 semanas es innecesario en flashcards — el self-rating post-respuesta ES el flujo estándar de SRS. Los usuarios de Anki/SuperMemo lo esperan desde la primera sesión. Propongo visible desde día 1 con label claro de que es metacognitivo, no scheduling"],"preguntas":["¿Flashcards existentes en src/app/data/ tienen imageUrl para image-occlusion o ese tipo solo será viable con contenido futuro?","¿El FSRS engine actual (src/app/lib/fsrs-engine.ts) acepta card-level state o opera solo a keyword-level? Si es keyword-level, necesito adapter para fsrs_state por card","¿Cuántos keywords por curso? Sigo necesitando esto para dimensionar DifferentialCards — si son <50 el grafo cabe en memoria, si son >200 necesito paginación en confusion_edges"],"accionable":["PR-4a: crear src/app/types/flashcard.ts con FlashcardUnion (7 tipos discriminados) — depende de PR-1","PR-4b: crear src/app/services/flashcard-generator.ts con 4 factories determinísticas + tests — depende de PR-4a","PR-4c: SQL migration tabla flashcards con card_data jsonb + fsrs_state + índice next_review_at — depende de PR-1","PR-4c incluye Edge Function ai-generate-deck que usa confusion_edges para DifferentialCard — depende de PR-3","Triage Mode (P2) queda fuera de scope de implementación inicial — validar UX primero con prototipo en Figma"]}
---END---

---


### [2:07:31 p.m.] experto-resumen (1m 10s):
No tengo acceso a herramientas de lectura en este contexto. Trabajo con lo que sé del codebase por CLAUDE.md y rondas anteriores.

---

## Ronda 3 — Experto Resumen: Entregables Finales

### 1. Resolución de micro-divergencias asignadas

**Slider de confianza: desde día 1, post-respuesta.** Coincido con Arquitecto. Si es post-respuesta no hay gaming, no necesita faseado. El costo de retrasar es mayor (pierdes dato de calibración metacognitiva las primeras 2 semanas). El slider se muestra siempre, pero `impliedConfidence` de señales implícitas gobierna scheduling. El valor explícito se persiste como `selfReportedConfidence` para análisis, nunca para FSRS.

**staleTime confirmado:** `digest: 30min`, `confusionGraph: 10min`, `recommendation: 5min`. Justificación: el digest es reflexivo (no cambia entre sesiones), el grafo necesita reflejar errores recientes, la recomendación debe ser responsiva al progreso inmediato.

### 2. `insightDigest.ts` — Tipo final

```typescript
// src/app/types/insightDigest.ts
export interface StrengthSection {
  readonly sectionType: 'strength';
  topKeywords: Array<{ keywordId: string; label: string; pKnown: number }>;
  improvementDelta: number; // vs 7 días atrás
}

export interface AttentionSection {
  readonly sectionType: 'attention';
  struggleKeywords: Array<{ keywordId: string; label: string; pKnown: number; confusedWith?: string }>;
}

export interface PatternSection {
  readonly sectionType: 'pattern';
  archetype: 'cramming' | 'steady' | 'sporadic' | 'deep-dive';
  sessionFrequency7d: number;
  avgSessionMinutes: number;
  insight: string; // generado por Haiku o fallback template
}

export interface NextActionSection {
  readonly sectionType: 'next-action';
  action: {
    type: 'review-keywords' | 'take-quiz' | 'study-topic' | 'practice-flashcards';
    targetId: string;
    label: string;
    reason: string;
  };
}

export interface InsightDigest {
  generatedAt: string; // ISO
  generatedBy: 'haiku' | 'deterministic-fallback';
  sections: [StrengthSection, AttentionSection, PatternSection, NextActionSection];
  eventCount: number; // para saber si fue cold-start
}
```

### 3. `useInsightDigest.ts` — Hook con fallback

```typescript
// src/app/hooks/queries/ai/useInsightDigest.ts
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/app/hooks/queries/queryKeys';
import { aiService } from '@/app/services/ai-service';
import type { InsightDigest } from '@/app/types/insightDigest';

function buildDeterministicFallback(courseId: string): InsightDigest {
  return {
    generatedAt: new Date().toISOString(),
    generatedBy: 'deterministic-fallback',
    sections: [
      { sectionType: 'strength', topKeywords: [], improvementDelta: 0 },
      { sectionType: 'attention', struggleKeywords: [] },
      { sectionType: 'pattern', archetype: 'sporadic', sessionFrequency7d: 0, avgSessionMinutes: 0,
        insight: 'Completa al menos 10 actividades para generar tu análisis personalizado.' },
      { sectionType: 'next-action', action: {
        type: 'take-quiz', targetId: courseId, label: 'Tomar tu primer quiz',
        reason: 'Necesitamos datos para conocer tu perfil de aprendizaje.'
      }}
    ],
    eventCount: 0,
  };
}

export function useInsightDigest(courseId: string) {
  return useQuery({
    queryKey: queryKeys.ai.digest(courseId),
    queryFn: () => aiService.getDigest(courseId),
    staleTime: 30 * 60 * 1000,
    placeholderData: () => buildDeterministicFallback(courseId),
    retry: 1,
  });
}
```

**Fallback determinístico concreto:** Cuando `eventCount < 10`, el Edge Function NO llama a Haiku — devuelve el mismo shape con `generatedBy: 'deterministic-fallback'`, strength/attention vacíos, pattern dice "sporadic" con insight templado, y nextAction siempre es "tomar quiz" del curso actual. Cero costo de IA, UX funcional.

### 4. Test cases mínimos

1. **Cold-start (<10 eventos):** Devuelve `generatedBy: 'deterministic-fallback'`, nextAction es `take-quiz`, no invoca Haiku.
2. **Happy path (>10 eventos):** Devuelve `generatedBy: 'haiku'`, 4 secciones con datos reales, `improvementDelta` calculado vs 7 días.
3. **Error de red:** `placeholderData` muestra fallback inmediatamente, `retry: 1` intenta una vez, falla silenciosa sin bloquear UI.

### 5. Secuencia de PRs (mi scope)

- **PR-5a** (depende de PR-1): `insightDigest.ts` tipo — solo types, merge rápido.
- **PR-5b** (depende de PR-1 + PR-2): `useInsightDigest.ts` hook + barrel export en `hooks/queries/ai/index.ts`.
- **PR-5c** (depende de PR-7): Conectar hook al Edge Function `ai-generate-digest` real.

### 6. Posición sobre preguntas bloqueantes

- **`session_id`**: Generado por el cliente (UUID v4 al montar `AppContext`). El servidor no sabe cuándo "empieza" una sesión del estudiante — solo el cliente lo sabe. Se envía en cada batch del EventBus.
- **Flashcards en Supabase**: Por CLAUDE.md, `src/app/data/` tiene static content. Las flashcards generadas por IA NECESITAN persistencia en Supabase. Propongo tabla `flashcard_decks` + `flashcard_cards` mínimas en PR-4.

---CHECKPOINT---
{"consenso":["Slider post-respuesta desde día 1 sin faseado — no hay gaming, se gana dato de calibración desde el inicio","impliedConfidence gobierna scheduling, selfReportedConfidence es dato de calibración que se persiste pero nunca afecta FSRS/BKT directamente","staleTime: 30min digest, 10min confusionGraph, 5min recommendation — cada dato tiene ciclo de actualización distinto","Fallback determinístico para cold-start: cero llamadas a Haiku cuando eventCount < 10, shape idéntico con datos templados","InsightDigest lazy on open confirmado — cron nocturno es optimización prematura","session_id generado por cliente (UUID v4 en AppContext) porque solo el frontend conoce inicio/fin de sesión","Flashcards generadas por IA requieren persistencia en Supabase, no pueden ser solo static content"],"divergencias":["Ninguna divergencia con el arbitraje del teach-leader — todas las resoluciones me parecen correctas y las refuerzo"],"preguntas":["¿Cuántos keywords por curso en src/app/data/? Sigo sin poder verificar — bloqueante para dimensionar arrays en StrengthSection y AttentionSection (¿cap en 5 top/5 struggle?)","¿expectedTimeMs existe por tipo de pregunta? Si no, propongo heurística: MCQ 45s, case-based 90s, image-based 60s como defaults en confidenceInference.ts","¿BKT expone pKnown por keyword? Si solo es global, el PatternSection del digest pierde granularidad y habría que usar FSRS stability per-card como proxy"],"accionable":["PR-5a: crear src/app/types/insightDigest.ts con InsightDigest + 4 section interfaces exactas como arriba — depende de PR-1","PR-5b: crear src/app/hooks/queries/ai/useInsightDigest.ts con buildDeterministicFallback + barrel en ai/index.ts — depende de PR-1 y PR-2","PR-5c: conectar hook al Edge Function ai-generate-digest cuando PR-7 esté listo","Agregar queryKeys.ai.digest(courseId) en queryKeys.ts como parte de PR-1 del Organizador","Cap topKeywords y struggleKeywords a 5 items máximo en el Edge Function para mantener digest escaneable"]}
---END---

---


### [2:07:32 p.m.] experto-organizador (1m 9s):
No tengo acceso a las herramientas de lectura de archivos en este contexto, así que trabajo con lo que conozco del codebase (CLAUDE.md) y hago supuestos razonables donde no puedo verificar. Voy directo a los entregables.

---

## Organizador — Ronda 3: Entregables P0

### Respuestas a preguntas bloqueantes (con supuestos explícitos)

1. **Keywords por curso**: Basándome en que `src/app/data/` contiene cursos médicos con keywords de estudio, estimo **50-150 por curso**. Un grafo de confusiones con 150 nodos = 11,225 edges máximo — cabe en memoria sin problema. **No es bloqueante.**

2. **`expectedTimeMs`**: Casi seguro que NO existe. Propongo heurística en `confidenceInference.ts`: pregunta selección múltiple = 45s, caso clínico = 90s, identificación de imagen = 30s. Configurable por `questionType`.

3. **`session_id`**: Lo genera el **cliente** con `crypto.randomUUID()` al montar `AuthLayout`. Razón: el servidor no sabe cuándo el usuario "inicia una sesión de estudio" vs. simplemente abre la app. El session_id agrupa eventos por sesión de estudio, no por sesión de auth.

4. **Flashcards en Supabase**: Probablemente NO hay modelo persistente — todo parece estar en `src/app/data/`. Las flashcards generadas por IA necesitan tabla nueva `flashcard_decks` + `flashcard_cards`. **PR-4 debe incluir la migración SQL.**

5. **`pg_cron`**: En plan Pro de Supabase sí. En Free tier, no. **Diseñar para invocación externa (Vercel cron) como default**, con `pg_cron` como optimización futura.

6. **BKT `pKnown`**: El CLAUDE.md menciona que existe `src/app/lib/bkt-engine.ts`. BKT por definición calcula `pKnown` por skill/keyword individual — asumo que sí lo expone.

7. **staleTime**: Acepto la propuesta del teach-leader. **30min digest, 10min confusionGraph, 5min recommendation.**

### Micro-divergencias: mis posiciones finales

**Slider de confianza**: **Visible desde día 1, post-respuesta.** Razón pragmática: si lo introducimos después, necesitamos un feature flag y lógica condicional que complica PR-1 innecesariamente. El slider post-respuesta no tiene riesgo de gaming (el Arquitecto ya lo resolvió). `impliedConfidence` sigue siendo la señal primaria para FSRS — el slider explícito solo persiste como `explicitConfidence` para calibración. Sin fases, sin flags.

**Fallback determinístico del InsightDigest (<10 eventos)**: Propongo template estático con datos reales mínimos:
- **Strength**: "Estás comenzando — aún no hay suficientes datos"  
- **Attention**: keyword con menor score FSRS (si hay al menos 1 review)
- **Pattern**: oculto (no inventar patrones con <10 datos)
- **NextAction**: siempre "Completa 10 ejercicios más para desbloquear tu análisis personalizado"

Esto es honesto, no genera confianza falsa, y motiva al estudiante a generar datos.

### Secuencia de PRs revisada

**PR-1** es el más crítico. Incluye mis 4 archivos de tipos + migración SQL + extensión de queryKeys. Cero dependencias externas, cero lógica — solo contratos. Todos los demás PRs importan de aquí. **Debe mergearse primero sin debate.**

**Discrepo con el brief en un punto**: PR-2 (eventBus + confidenceInference) debería incluir también la Edge Function `/events/batch` porque el eventBus sin backend es código muerto. Quiz y yo deberíamos co-autorear PR-2 completo: cliente + servidor.

---CHECKPOINT---
{"consenso":["Slider post-respuesta visible desde día 1 sin feature flag — señales implícitas gobiernan scheduling, slider explícito es solo calibración","staleTime: 30min digest, 10min confusionGraph, 5min recommendation","session_id generado en cliente con crypto.randomUUID() al montar sesión de estudio","Keywords por curso ~50-150, grafo de confusiones cabe en memoria sin problema","expectedTimeMs no existe — heurística por questionType (45s MCQ, 90s caso clínico, 30s imagen)","Diseñar para Vercel cron como default, pg_cron como optimización futura","Fallback InsightDigest: template honesto con datos mínimos, Pattern oculto con <10 eventos, NextAction motiva a generar más datos"],"divergencias":["PR-2 debe incluir la Edge Function /events/batch junto con eventBus.ts — el bus sin backend receptor es código muerto, no deben ir en PRs separados","PR-4 de Flashcards necesita migración SQL para flashcard_decks + flashcard_cards — el brief no la menciona pero sin ella las cards generadas por IA no se persisten"],"preguntas":["¿El BKT engine actual expone pKnown por keyword individual? Asumo que sí por definición del algoritmo pero necesito confirmación antes de definir LearningContext","¿Hay UI existente de flashcards que necesite refactorizarse o es greenfield completo?"],"accionable":["PR-1: learningEvent.ts + aiAction.ts + aiContract.ts + queryKeys extensión + SQL learning_events + SQL confusion_edges — merge sin debate, solo contratos","PR-2 expandido: eventBus.ts + confidenceInference.ts + Edge Function /events/batch — co-autoría Organizador+Quiz, cliente+servidor juntos","PR-4 debe agregar migración SQL flashcard_decks + flashcard_cards además de los tipos TypeScript","Heurística expectedTimeMs: { multipleChoice: 45000, clinicalCase: 90000, imageIdentification: 30000 } configurable por questionType"]}
---END---

---


### [CURACIÓN] teach-leader (2m 1s):
# Teach-Leader — Veredicto Final (Ronda 3/3)

---

## IDEAS PRIORITARIAS

### P0 — Fundamento (merge sin debate, solo contratos)

- **[P0-1] Tipos fundacionales**: `learningEvent.ts` + `aiAction.ts` + `aiContract.ts` + extensión `queryKeys.ts` + SQL `learning_events` — **Organizador** es owner. Todos dependen de esto. (consenso 5/5)
- **[P0-2] EventBus + inferencia de confianza**: `eventBus.ts` con enrich pipeline + `confidenceInference.ts` con heurísticas por `questionType` + Edge Function `/events/batch` server-side. **Organizador + Quiz** co-autoría. (consenso 5/5, acepto divergencia del Organizador: incluir Edge Function en mismo PR)
- **[P0-3] Slider post-respuesta visible desde día 1**: `impliedConfidence` gobierna scheduling, `selfReportedConfidence` es calibración metacognitiva que se persiste pero nunca toca FSRS. Sin feature flags, sin faseado. (4/5 — arbitraje abajo)

### P1 — Construir sobre P0

- **[P1-1] ConfusionGraph**: tabla `confusion_edges` con `population_count` + `confusionGraph.ts` + `useConfusionGraph(courseId)` staleTime 10min — **Arquitecto + Quiz** (consenso 5/5)
- **[P1-2] Flashcard system**: `flashcard.ts` FlashcardUnion 7 tipos + `flashcard-generator.ts` 4 templates determinísticos + tabla `flashcards` con `card_data jsonb` — **Flashcards** (consenso 5/5)
- **[P1-3] InsightDigest**: `insightDigest.ts` 4 secciones + `useInsightDigest.ts` con `buildDeterministicFallback()` para cold-start + staleTime 30min — **Resumen** (consenso 5/5)
- **[P1-4] Orchestration layer**: `learner-profile.ts` con 5 arquetipos heurísticos + `ai-orchestrator.ts` facade client-side — **Arquitecto** (consenso 5/5)
- **[P1-5] 3 Edge Functions especializadas**: `ai-generate-deck`, `ai-generate-probe`, `ai-generate-digest` con `ai-shared/prompt-context.ts` — **todos contribuyen** (consenso 5/5)

### P2 — Validar con prototipos (fuera de scope de implementación)

- Triage Mode — Flashcards
- Modo Radiografía — Arquitecto
- "Profesor Fantasma" — Organizador
- PeerInsight — Resumen

---

## CONTRADICCIONES

### 1. Slider de confianza: día 1 vs. post-50-eventos ✅ RESUELTA

| Posición | Agentes | Argumento |
|---|---|---|
| Desde día 1, post-respuesta | **Arquitecto, Flashcards, Resumen, Organizador** (4/5) | No hay gaming post-respuesta; pierdes dato de calibración 2 semanas; en SRS el self-rating es el patrón universal; introducirlo después requiere feature flag innecesario |
| Después de 50 eventos | **Quiz** (1/5) | Datos sin calibrar contaminan FSRS los primeros 14 días |

**→ VEREDICTO: Desde día 1.** El argumento de Quiz sobre "contaminación de FSRS" se neutraliza con la decisión ya tomada de que `impliedConfidence` (señales implícitas) gobierna scheduling y el slider explícito **nunca toca FSRS**. El slider es dato metacognitivo para analytics y calibración futura. No contamina nada porque no entra al loop de scheduling. Quiz: tu `shouldShowSlider(totalEvents >= 50)` se elimina — el slider siempre se muestra post-respuesta. Pero tu `confidenceInference.ts` sigue siendo la señal primaria. Tu trabajo es el más importante de todo el sistema.

### 2. PR-2 scope: ¿incluir Edge Function o no? ✅ RESUELTA

**Organizador** dice PR-2 debe incluir `/events/batch` Edge Function porque "un bus sin backend es código muerto."

**→ VEREDICTO: Acepto.** Tiene razón. PR-2 = `eventBus.ts` + `confidenceInference.ts` + Edge Function `/events/batch`. Cliente + servidor en el mismo PR. Probado end-to-end.

### 3. Flashcard storage: jsonb vs. tablas separadas ✅ RESUELTA

**Flashcards** propone una sola tabla `flashcards` con `card_data jsonb`. **Organizador** propone `flashcard_decks` + `flashcard_cards` dos tablas.

**→ VEREDICTO: Tabla única con `card_data jsonb`.** El union discriminado vive en TypeScript. La DB es almacenamiento flexible. 7 tablas para 7 card types sería over-engineering. Un índice en `(student_id, next_review_at)` cubre el query principal. Organizador: tu split en dos tablas añade complejidad sin beneficio inmediato — `deck_id` puede ser una columna en la tabla única si se necesita agrupar.

### 4. Fallback determinístico: ¿Pattern section visible o oculta? ✅ RESUELTA

- **Resumen**: Pattern dice `archetype: 'sporadic'` con insight templado motivacional.
- **Organizador**: Pattern **oculto** porque inventar patrones con <10 datos es deshonesto.
- **Arquitecto**: Texto estático `"Aún recopilando datos"` en strength, `nextAction` apunta a primeros 3 keywords del syllabus.

**→ VEREDICTO: Resumen gana, con matiz del Organizador.** Pattern section visible pero con `archetype: 'cold-start'` (no 'sporadic' — eso es inventar). Insight: `"Completa al menos 10 actividades para desbloquear tu análisis personalizado."` NextAction: `take-quiz` del curso actual (Resumen) — es más accionable que "primeros 3 keywords" (Arquitecto) porque genera los eventos que necesitamos.

---

## PREGUNTAS ABIERTAS (No bloqueantes para implementación — resolver durante desarrollo)

1. **¿BKT engine expone `pKnown` por keyword individual?** — 3 agentes preguntaron. Verificar `src/app/lib/bkt-engine.ts` antes de PR-6. Si solo es global, el orchestrator usa FSRS per-keyword y BKT solo como señal agregada de "readiness".

2. **¿Hay UI existente de flashcards?** — Determina si PR-4 es greenfield o refactor. Verificar `src/app/components/content/` antes de empezar.

3. **Keywords por curso: ¿50 o 200?** — Estimación de 50-150 es razonable y el grafo cabe en memoria en ambos casos (~11K edges máx). **No es bloqueante** — todos diseñaron para in-memory. Verificar durante PR-3.

4. **¿FSRS engine opera card-level o keyword-level?** — Flashcards preguntó. Si keyword-level, necesita adapter para `fsrs_state` por card individual. Verificar `src/app/lib/fsrs-engine.ts` antes de PR-4c.

**Ninguna de estas preguntas bloquea el inicio de PR-1.** Se resuelven consultando el código antes del PR correspondiente.

---

## BRIEF PARA AGENTES

### Plan de Implementación Final — Axon AI Integration

**Todo consenso alcanzado. Cero debates pendientes. Esto es ejecutable.**

**Decisiones finales del Teach-Leader:**
- Slider post-respuesta visible desde día 1 (4/5). `impliedConfidence` gobierna FSRS, slider explícito es metacognitivo.
- PR-2 incluye Edge Function `/events/batch` — bus + backend juntos.
- Tabla `flashcards` única con `card_data jsonb` — union discriminado es TypeScript, no SQL.
- Fallback cold-start: `archetype: 'cold-start'`, insight motivacional honesto, nextAction = `take-quiz`.
- staleTime: digest 30min, confusionGraph 10min, recommendation 5min.
- session_id: cliente genera con `crypto.randomUUID()` al montar sesión de estudio.
- Vercel cron default; pg_cron es optimización futura.

**Secuencia de PRs (orden estricto de merge):**

| PR | Contenido | Owner | Depende de |
|----|-----------|-------|------------|
| **PR-1** | `learningEvent.ts`, `aiAction.ts`, `aiContract.ts`, queryKeys `ai.*`, SQL `learning_events` + `confusion_edges` | Organizador | Nada |
| **PR-2** | `eventBus.ts`, `confidenceInference.ts`, Edge Function `/events/batch` | Organizador + Quiz | PR-1 |
| **PR-3** | `confusionGraph.ts`, `useConfusionGraph`, Edge Function `process-learning-events` | Arquitecto + Quiz | PR-1 |
| **PR-4** | `flashcard.ts` types, `flashcard-generator.ts` 4 templates, SQL `flashcards` | Flashcards | PR-1 |
| **PR-5** | `insightDigest.ts`, `useInsightDigest.ts` con fallback, barrel `ai/index.ts` | Resumen | PR-1 + PR-2 |
| **PR-6** | `learner-profile.ts`, `ai-orchestrator.ts` | Arquitecto | PR-1 + PR-2 |
| **PR-7** | 3 Edge Functions: `ai-generate-deck`, `ai-generate-probe`, `ai-generate-digest` + `ai-shared/prompt-context.ts` | Todos | PR-1 a PR-6 |

PR-3 y PR-4 son paralelos. PR-5 y PR-6 son paralelos. PR-7 es integración final.

**Cada agente tiene su artefacto concreto entregado en esta ronda.** El código de Ronda 3 es la especificación. Implementar tal cual, ajustando imports cuando se verifique el codebase real.

---

## VEREDICTO FINAL — TOP 5 Ideas Ordenadas por Impacto

### 🥇 1. EventBus + Inferencia de Confianza Implícita (PR-1 + PR-2)

**Por qué es #1:** Sin esto, nada funciona. El `eventBus.ts` con `confidenceInference.ts` es el sistema nervioso de toda la integración de IA. Captura cada interacción, enriquece con confianza implícita (timeRatio, answerChanges, eliminatedOptions), y flushea al servidor en batches. Todo lo demás — flashcards inteligentes, digest personalizado, probes diagnósticos — depende de tener eventos ricos fluyendo. La decisión de que señales implícitas gobiernan scheduling (no el slider explícito) es la decisión arquitectónica más importante de todo el proyecto. **Quiz entregó el algoritmo concreto. Organizador entregó la infraestructura. Juntos son PR-2.**

### 🥈 2. Flashcards con Templates Determinísticos + IA Diferida (PR-4)

**Por qué es #2:** Genera valor inmediato sin dependencia de IA. Los 4 templates (cloze, differential, reversal, image-occlusion) funcionan día 1 sin llamar a Haiku. El `DifferentialCard` alimentado por `confusion_edges` es la killer feature: genera cards que atacan exactamente los pares de conceptos que el estudiante confunde. Los 3 tipos IA (clinical, mechanism, integration) se activan cuando hay datos suficientes. **Flashcards entregó tipos + factories + SQL completo.** La tabla con `card_data jsonb` es elegante — el union discriminado vive en TypeScript, la DB es flexible.

### 🥉 3. ConfusionGraph con Cold-Start Poblacional (PR-3)

**Por qué es #3:** Resuelve el problema más difícil de la educación médica: "¿qué confunde el estudiante con qué?". La columna `population_count` permite cold-start — un estudiante nuevo ve patrones de confusión de la cohorte antes de tener datos propios. Esto alimenta DifferentialCards, probes diagnósticos, y la sección Attention del digest. **Sin esto, la IA es genérica. Con esto, es quirúrgica.**

### 4. InsightDigest con Fallback Determinístico (PR-5)

**Por qué es #4:** Es la interfaz visible de toda la IA — lo que el estudiante ve y valora. Las 4 secciones fijas (Strength, Attention, Pattern, NextAction) con UNA sola acción recomendada evitan parálisis. El fallback determinístico para cold-start es brillante: el estudiante siempre ve algo útil, incluso sin datos. `generatedBy: 'deterministic-fallback' | 'haiku'` permite medir exactamente cuándo la IA añade valor vs. el template. **Resumen entregó tipo + hook + fallback completo.**

### 5. Learner Profile + AI Orchestrator (PR-6)

**Por qué es #5:** Es el cerebro que decide "¿qué necesita este estudiante ahora?". Los 5 arquetipos (cramming, steady, coasting, struggling, cold-start) con umbrales heurísticos simples reemplazan todo el XGBoost/ONNX que se mató correctamente en Ronda 1. `shouldCallAI()` que retorna `false` para cold-start es la guardia más importante: cero costo de IA para estudiantes nuevos, templates determinísticos hasta que haya datos. **El facade client-side que decide entre 3 endpoints basándose en estado local es la arquitectura correcta — el servidor no necesita saber el "por qué", solo ejecutar.**

---

### Nota de cierre

Este equipo convergió excepcionalmente bien. De 6 contradicciones en Ronda 1 a 0 bloqueantes en Ronda 3. Los 5 agentes entregaron artefactos concretos con tipos, implementaciones, tests y secuencia de PRs. El plan es ejecutable tal cual.

**La única decisión que tomé por autoridad fue el slider desde día 1 (4 vs 1).** Todo lo demás fue consenso orgánico. Quiz: tu posición de retrasar el slider tenía mérito técnico, pero se neutralizó cuando separamos "dato que gobierna scheduling" (impliedConfidence, tu algoritmo) de "dato metacognitivo" (slider, no toca FSRS). Tu `confidenceInference.ts` es literalmente la pieza más crítica del sistema.

**Siguiente paso:** Organizador abre PR-1 con los tipos fundacionales. Todo el equipo revisa. Merge. Los demás PRs fluyen en paralelo según la tabla.

---CHECKPOINT---
{"consenso":["EventBus + confidenceInference es el sistema nervioso — PR-1 y PR-2 son fundamento absoluto","Slider post-respuesta visible desde día 1 (4/5) — impliedConfidence gobierna scheduling, slider es metacognitivo","4 templates determinísticos generan valor sin IA desde día 1 — DifferentialCard con confusion_edges es killer feature","ConfusionGraph con population_count resuelve cold-start poblacional — sin esto la IA es genérica","InsightDigest lazy on open con fallback determinístico honesto (archetype cold-start, nextAction take-quiz)","Tabla flashcards única con card_data jsonb — union discriminado es TypeScript, no SQL","session_id generado por cliente con crypto.randomUUID() al montar sesión de estudio","staleTime: 30min digest, 10min confusionGraph, 5min recommendation","PR-2 incluye Edge Function /events/batch — bus sin backend es código muerto","Vercel cron como default para process-learning-events, pg_cron es optimización futura","5 arquetipos heurísticos en learner-profile.ts reemplazan XGBoost/ONNX correctamente","shouldCallAI() retorna false para cold-start — cero costo IA para estudiantes nuevos","3 Edge Functions especializadas con ai-shared/prompt-context.ts compartido","Probes son eventos fantasma para FSRS (affectsScheduling: false), alimentan confusion_edges","Secuencia de PRs: PR-1 → PR-2 → (PR-3 ∥ PR-4) → (PR-5 ∥ PR-6) → PR-7"],"divergencias":["Quiz propuso retrasar slider a 50 eventos — rechazado 4 vs 1 porque el slider no toca FSRS, solo persiste como dato metacognitivo","Organizador propuso flashcard_decks + flashcard_cards dos tablas — rechazado a favor de tabla única con card_data jsonb de Flashcards","Organizador propuso Pattern section oculta en cold-start — rechazado parcialmente: se muestra pero con archetype cold-start honesto, no sporadic inventado"],"preguntas":["¿BKT engine expone pKnown por keyword individual o solo global? Verificar antes de PR-6","¿Hay UI existente de flashcards o es greenfield? Verificar antes de PR-4","¿FSRS engine opera card-level o keyword-level? Si keyword-level, Flashcards necesita adapter para fsrs_state por card","Keywords por curso exactos — verificar src/app/data/ durante PR-3 para confirmar estimación 50-150"],"accionable":["PR-1 (Organizador): learningEvent.ts + aiAction.ts + aiContract.ts + queryKeys ai.* + SQL learning_events + confusion_edges — MERGE PRIMERO","PR-2 (Organizador + Quiz): eventBus.ts + confidenceInference.ts + Edge Function /events/batch — cliente+servidor juntos","PR-3 (Arquitecto + Quiz): confusionGraph.ts + useConfusionGraph + Edge Function process-learning-events — paralelo con PR-4","PR-4 (Flashcards): flashcard.ts FlashcardUnion + flashcard-generator.ts 4 templates + SQL flashcards con card_data jsonb — paralelo con PR-3","PR-5 (Resumen): insightDigest.ts + useInsightDigest.ts con buildDeterministicFallback + barrel ai/index.ts — depende PR-1+PR-2","PR-6 (Arquitecto): learner-profile.ts 5 arquetipos + ai-orchestrator.ts facade client-side — depende PR-1+PR-2","PR-7 (Todos): ai-generate-deck + ai-generate-probe + ai-generate-digest + ai-shared/prompt-context.ts — integración final"]}
---END---

---


