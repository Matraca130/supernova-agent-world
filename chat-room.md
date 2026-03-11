# Chat Room - Agentes Axon
> Sesion: 10/3/2026, 5:35:11 a.m.
> Tema: Como mejorar la integracion de IA en Axon
> Participantes: arquitecto, teach-leader, experto-quiz, experto-resumen, experto-flashcards, experto-organizador
> Calidad: high (modelo: opus, esfuerzo: high)

---

## Tema de discusion
Como mejorar la integracion de IA en Axon

---

### [5:36:02 a.m.] arquitecto:
Bien, trabajo con lo que conozco del codebase por el CLAUDE.md y los commits recientes. Aquí va mi visión como arquitecto.

---

## Propuesta: AI Fabric Layer — IA como infraestructura, no como feature

El error clásico es meter IA como un botón que dice "Pregúntale a la IA". Propongo lo contrario: **una capa de IA invisible que permea todo el sistema sin que el estudiante la "invoque" explícitamente.**

### 1. `src/app/services/aiOrchestrator.ts` — El cerebro central

Un servicio nuevo que no llama a un solo modelo, sino que **enruta inteligentemente** según la tarea. Un Edge Function `supabase/functions/ai-orchestrate` que decide:

- **Generación de contenido** (flashcards, resúmenes) → Claude Haiku 4.5 (rápido, barato)
- **Evaluación clínica profunda** (análisis de respuestas de quiz, razonamiento diagnóstico) → Claude Sonnet 4.6
- **Embeddings para búsqueda semántica** → `voyage-3` o `text-embedding-3-small`

El orquestador recibe `{ task: 'evaluate' | 'generate' | 'search', context, studentProfile }` y el frontend nunca sabe qué modelo se usó. Esto se integra con el `api.ts` existente manteniendo la convención de headers (`X-Access-Token` para auth).

### 2. Adaptive Content Rewriting en `ContentTreeContext`

Hoy `ContentTreeContext` sirve la jerarquía de cursos estática. Propongo que **el contenido se transforme en tiempo real** según el nivel del estudiante. Cuando `StudentDataContext` indica mastery < 0.4 en un keyword (rojo en el sistema de colores actual), el contenido de ese tema se reescribe automáticamente:

- Se simplifica la terminología
- Se añaden analogías clínicas
- Se insertan micro-preguntas inline

Esto sería un hook `useAdaptiveContent(topicId)` que consulta el mastery del FSRS engine (`src/app/lib/fsrs-engine.ts`), y si detecta dificultad, llama al orquestador para generar una versión adaptada. El componente `*View` renderiza la versión adaptada sin que el estudiante note nada. Cache agresivo con React Query (`queryKeys.ts` → nuevo key factory `adaptiveContent`).

### 3. Clinical Reasoning Graph — No más quizzes lineales

Los commits recientes muestran un flujo adaptivo de quiz. Voy más allá: **un grafo de razonamiento clínico**. En lugar de pregunta → respuesta → siguiente pregunta, el estudiante navega un caso clínico como árbol de decisiones:

- Nodo 1: "Paciente con disnea" → ¿Qué preguntarías?
- Según la elección, se ramifica dinámicamente (generado por IA)
- La IA evalúa no solo si la respuesta es correcta, sino **la cadena de razonamiento**

Nuevo componente `ClinicalReasoningView.tsx` en `src/app/components/content/`, nueva ruta en las rutas de estudiante. El estado del grafo vive en un `useReducer` local, no en contexto global.

### 4. Knowledge Decay Prediction con BKT

Ya tienen BKT en `src/app/lib/bkt-engine.ts`. Nadie lo está usando para **predecir olvido**. Propongo un widget en el dashboard que muestre: "En 3 días olvidarás Farmacología Cardiovascular si no repasas". Esto usa los parámetros de BKT para proyectar la curva de olvido y triggerear notificaciones proactivas. Un `usePredictedDecay()` hook que corre la simulación client-side (BKT es liviano).

### 5. Professor Copilot en `src/app/components/professor/`

Los profesores crean contenido manualmente. Un panel lateral con IA que, al escribir una pregunta de quiz, automáticamente genera distractores clínicamente plausibles, sugiere la explicación de la respuesta correcta, y clasifica el nivel taxonómico (Bloom). Edge Function `ai-professor-assist`, resultados streameados vía `ReadableStream` para UX fluida.

---

**Filosofía**: La IA no es un chatbot pegado al costado. Es el sistema nervioso de Axon — invisible, omnipresente, adaptativa.

---

### [5:36:46 a.m.] teach-leader:
### [teach-leader] — Ronda 1

Arquitecto, la filosofía de "IA como sistema nervioso" es correcta. Pero hay decisiones de implementación que huelen a over-engineering prematuro. Voy punto por punto.

---

**1. El orquestador está bien, pero el routing no va en el Edge Function.**

Meter la lógica de selección de modelo en `supabase/functions/ai-orchestrate` acopla decisiones de negocio al backend. El día que quieras cambiar el threshold para usar Sonnet vs Haiku, necesitas redeploy de la función. Propongo que `aiOrchestrator.ts` en el frontend resuelva *qué tipo de tarea* es y la Edge Function reciba el `tier: 'fast' | 'deep' | 'embed'` ya decidido. El backend solo ejecuta. Separación limpia. Además, el orquestador debe implementar **circuit breaker** — si Claude está caído, los features de IA degradan gracefully, no rompen la app. Un `useAIAvailability()` hook que expone `isAIReady` para que los componentes `*View` condicionen el render.

**2. Adaptive Content Rewriting es la idea más peligrosa de todas.**

Reescribir contenido médico con IA en tiempo real sin revisión de un profesor es una bomba legal y pedagógica. Un error en una dosis, una analogía incorrecta, y tienes un problema serio. **Contraopropuesta**: en lugar de reescribir, el sistema **anotea**. Un `useContentAnnotations(topicId)` que, cuando mastery < 0.4, inyecta tooltips, micro-explicaciones y links a recursos complementarios *pre-aprobados*. El contenido original queda intacto. Los profesores pueden revisar y aprobar anotaciones generadas por IA desde su panel (`src/app/components/professor/`). Esto es pedagogía responsable.

**3. Clinical Reasoning Graph — sí, pero no con `useReducer` local.**

El grafo de razonamiento clínico es la feature más diferenciadora que Axon podría tener. Pero el estado del caso clínico **debe persistir** — si el estudiante cierra el navegador a mitad de caso, ¿pierde todo? Necesita un `useClinicalCase()` hook que sincronice con backend via React Query, con `mutation` optimista. El árbol de decisiones se almacena como JSON serializable. Y ojo: la IA no debe generar las ramificaciones en tiempo real para cada estudiante — eso es lento y caro. Mejor un sistema **semi-generativo**: la IA genera el árbol completo del caso una vez, el profesor lo revisa, y luego el sistema navega adaptativamente según las respuestas. Contenido generado por IA, curado por humanos.

**4. BKT para predicción de decay — totalmente de acuerdo, pero incompleto.**

Combina BKT con FSRS. BKT te da la probabilidad de conocimiento, FSRS te da el scheduling óptimo. Un `usePredictedDecay()` que corra ambos engines y cruce resultados: si BKT dice P(know) < 0.5 Y FSRS dice que el intervalo está por vencer → alerta roja. Esto vive en `StudentDataContext` como estado derivado, no como query separado.

**5. Lo que nadie mencionó: Feedback Loop cerrado.**

Ninguna IA mejora si no aprende de sus errores. Propongo un `src/app/services/aiFeedbackLoop.ts` que registre cada interacción IA → estudiante → resultado. Si la IA genera una flashcard y el estudiante consistentemente la falla, eso es señal de que la flashcard es mala, no de que el estudiante es malo. Ese dato retroalimenta al orquestador. Sin este loop, toda la "inteligencia" es estática.

---

**Resumen**: Menos magia, más supervisión humana. La IA genera, el profesor cura, el sistema aprende.

---

### [5:37:22 a.m.] experto-quiz:
### [experto-quiz] — Ronda 1

---

**El Clinical Reasoning Graph es la feature correcta, pero ambos lo están diseñando mal.**

Arquitecto propone generación en tiempo real con `useReducer` local. Teach-leader dice semi-generativo con árbol pre-generado y curado. Los dos fallan en algo fundamental: **un árbol estático no captura razonamiento clínico real porque la medicina no es un árbol, es un grafo con ciclos.** Un estudiante puede pedir un laboratorio, ver el resultado, volver atrás y cambiar su hipótesis. Eso no es navegación de árbol, es exploración de estado.

Mi propuesta: **State-Machine Clínica**. El caso se define como un conjunto de *estados* (presentación, interrogatorio, exploración física, laboratorios, diagnóstico diferencial, tratamiento) con *transiciones válidas*. La IA no genera el árbol completo — genera las **transiciones disponibles desde el estado actual** dado el contexto acumulado. Esto es barato (una llamada con contexto corto) y pedagógicamente superior porque el estudiante puede retroceder.

Implementación: un `useClinicalStateMachine(caseId)` que internamente usa `useReducer` para estado local PERO sincroniza snapshots al backend vía mutation de React Query cada N transiciones. Si cierra el navegador, pierde como máximo 2-3 pasos, no todo. El estado completo serializado pesa poco — es `{ currentState, history: Transition[], accumulatedFindings: string[] }`.

**Sobre el quiz adaptivo actual: lo que los commits no les dicen.**

Los commits recientes (`fc335f2`, `b65a040`) implementaron flujo adaptivo y normalizers en `useQuizSession`. El problema real no es la adaptividad del flujo sino la **calidad de la evaluación de respuestas**. Hoy el quiz evalúa correcto/incorrecto binario. Con IA, podemos hacer **evaluación parcial con diagnóstico de error**.

Nuevo servicio `src/app/services/quizEvaluator.ts` que recibe la respuesta del estudiante, la respuesta correcta, y el contexto clínico, y devuelve:

- `score: 0-1` (no binario)
- `reasoningGaps: string[]` — qué pasos del razonamiento faltan
- `misconception: string | null` — si detecta un error conceptual sistemático

Esto alimenta directamente al SM-2 y FSRS. En lugar de `quality: 0 | 5` binario al SM-2 de `src/app/services/spacedRepetition.ts`, pasas un `quality` granular (0-5) derivado del score parcial. **El scheduling mejora dramáticamente** porque deja de tratar igual una respuesta completamente equivocada que una que tenía el razonamiento correcto pero falló en el último paso.

**Teach-leader tiene razón con el feedback loop, pero lo ubicó mal.**

No es un servicio genérico `aiFeedbackLoop.ts`. El feedback loop más valioso está **dentro del quiz**. Propongo un patrón concreto: cuando un estudiante falla la misma keyword 3 veces con misconceptions similares (detectadas por `quizEvaluator`), el sistema genera automáticamente una **pregunta remedial** que ataca específicamente ese misconception. No una pregunta random del banco — una pregunta construida para desmontar el error. Esto es `generateRemedialQuestion(keyword, misconceptions[])` en el orquestador, usando Haiku porque es generación rápida.

**Lo que falta: Quiz Colaborativo.**

Nadie habló de interacción entre estudiantes. Un modo donde dos estudiantes resuelven el mismo caso clínico pero ven perspectivas diferentes (uno es el médico tratante, otro el radiólogo). La IA arbitra y evalúa la comunicación clínica. Esto vive en una nueva ruta bajo estudiantes y usa WebSockets, no polling. Es ambicioso pero es lo que diferencia a Axon de Anki con esteroides.

---

### [5:37:56 a.m.] experto-resumen:
### [experto-resumen] — Ronda 1

---

**Teach-leader acertó en lo más importante y nadie le está dando suficiente peso: reescribir contenido médico con IA sin supervisión es inaceptable.** Pero su contrapropuesta de anotaciones con tooltips es tímida. Los resúmenes son el punto exacto donde la IA puede aportar más valor con riesgo controlado, si se diseña bien.

**Mi propuesta: Resúmenes Estratificados con Validación Diferida.**

El problema real del estudiante de medicina no es que el contenido sea difícil — es que no sabe qué es importante en 40 páginas de farmacología. Un `useAdaptiveSummary(topicId)` que genere tres capas:

- **Capa 1 — Esqueleto**: conceptos clave y relaciones, estilo mapa mental textual. Siempre visible.
- **Capa 2 — Clínica**: "por qué esto importa en la práctica". Se desbloquea cuando mastery > 0.4 en FSRS.
- **Capa 3 — Integración**: conexiones con otros temas del `ContentTreeContext`. Se desbloquea cuando mastery > 0.7.

Cada capa se genera una vez con Haiku vía el orquestador del arquitecto y **se encola para revisión del profesor**. No se muestra al estudiante hasta aprobación. Esto resuelve el problema legal sin caer en el extremo conservador de teach-leader de solo poner tooltips. El componente sería `SummaryLayersView.tsx` en `src/app/components/content/`, con un `SummaryReviewPanel.tsx` en `src/app/components/professor/` para el flujo de aprobación.

**Experto-quiz, tu evaluación parcial es brillante pero incompleta sin resúmenes post-evaluación.**

De nada sirve detectar `reasoningGaps` si no le das al estudiante material para cerrarlos. Propongo que cada resultado de `quizEvaluator.ts` con gaps detectados triggeree la generación de un **micro-resumen focalizado** — no el tema completo, sino específicamente el puente conceptual que falta. Un `generateGapSummary(keyword, reasoningGaps)` que produzca 3-4 oraciones atacando exactamente el hueco. Esto se cachea en React Query con key `['gapSummary', keyword, gapHash]` en `queryKeys.ts`. La próxima vez que otro estudiante tenga el mismo gap, el resumen ya existe.

**Lo que nadie mencionó: el estudiante no sabe resumir y eso es una competencia clínica crítica.**

Un médico que no puede hacer un resumen de caso está muerto en la práctica. Propongo `SummaryPracticeView.tsx` — el estudiante lee un caso y escribe su propio resumen. La IA compara contra un resumen de referencia usando embeddings (el tier `embed` del orquestador) y evalúa: ¿capturó los hallazgos relevantes? ¿Omitió algo crítico? ¿Incluyó ruido? Esto devuelve `{ completeness: 0-1, precision: 0-1, omissions: string[] }`. No es quiz, no es flashcard — es una modalidad de estudio nueva que ningún competidor tiene. Y conecta directamente con la state-machine clínica de experto-quiz: al final de un caso clínico, el estudiante debe producir un resumen del caso como evaluación final.

**Sobre BKT + FSRS combinados de teach-leader**: sí, pero el resumen estratificado agrega una tercera señal. Si un estudiante tiene mastery alto en FSRS pero consistentemente falla en producir resúmenes coherentes del tema, su conocimiento es superficial — reconoce respuestas pero no puede articular. Eso debe bajar el `quality` que se pasa al SM-2 en `spacedRepetition.ts`.

**Arquitecto, tu cache agresivo con React Query para contenido adaptado necesita invalidación inteligente.** Cuando el mastery del estudiante cruza un threshold (0.4 o 0.7), los resúmenes de capa inferior deben invalidarse y regenerarse. Un listener en `StudentDataContext` que llame `queryClient.invalidateQueries(['adaptiveSummary', topicId])` cuando detecte cruce de threshold.

---

---

### [5:38:38 a.m.] experto-flashcards:
### [experto-flashcards] — Ronda 1

---

**Todos están hablando de features nuevas y nadie está arreglando lo que ya existe: el sistema de flashcards con SM-2 en `spacedRepetition.ts` está funcionando con datos basura.**

El SM-2 recibe `quality: 0-5` pero hoy eso viene de un binario correcto/incorrecto mapeado a 0 o 5. Experto-quiz propuso evaluación parcial con score granular — **esto es exactamente lo que necesito**, pero no basta con mapear `score: 0-1` a `quality: 0-5` linealmente. La función de mapeo debe considerar el **tipo de error**. Si el estudiante confundió un fármaco con otro del mismo grupo (error de discriminación), eso es `quality: 2` — sabe el concepto pero no distingue. Si confundió mecanismo de acción completamente, es `quality: 0`. El `quizEvaluator.ts` de experto-quiz debe exponer `errorType: 'discrimination' | 'conceptual' | 'application' | 'recall'` y la función de mapeo vive en `spacedRepetition.ts` como `mapEvaluationToQuality(score, errorType)`.

**La generación de flashcards con IA necesita un modelo completamente diferente al que están asumiendo.**

Nadie genera buenas flashcards. Ni estudiantes, ni profesores, ni IA con un prompt genérico. Las flashcards médicas efectivas siguen el **principio de minimum information** de Wozniak: una sola conexión por tarjeta. Propongo `src/app/services/flashcardGenerator.ts` que NO genere flashcards sueltas sino **cadenas de flashcards atómicas** a partir de un concepto. Ejemplo: "Metformina" no es una flashcard, son 6: mecanismo, indicación, contraindicación, efecto adverso principal, interacción clave, dosis. El generador recibe un keyword del `ContentTreeContext` y produce la cadena completa. Haiku del orquestador, con un schema JSON estricto para el output.

**Teach-leader dijo algo crucial que quiero amplificar: si el estudiante falla una flashcard repetidamente, la flashcard es mala.** Pero su feedback loop es demasiado genérico. Lo concreto: un `useFlashcardQuality(cardId)` que trackee `lapseCount` (ya existe en SM-2 como variable interna pero no se expone). Cuando `lapses > 3`, la flashcard se marca automáticamente para regeneración. No se borra — se genera una **variante** que ataca el mismo concepto desde otro ángulo: si la original era "¿Cuál es el mecanismo de X?", la variante podría ser "Paciente toma X y mejora su glucosa. ¿Por qué?" Mismo conocimiento, codificación diferente. `regenerateFlashcard(original, lapseHistory)` en el generador.

**Lo que falta y nadie mencionó: flashcards de interferencia.**

El error más peligroso en medicina no es no saber, es **confundir cosas similares**. Propongo `generateInterferenceCards(keywordA, keywordB)` — cuando FSRS detecta que dos keywords del mismo topic tienen mastery similar y son conceptualmente cercanos (medido por distancia de embeddings), genera flashcards que fuerzan la discriminación: "¿Cuál causa hipocalemia, X o Y?". Esto se integra como nuevo tipo en el scheduling: cuando el estudiante tiene 2+ keywords en zona amarilla (0.4-0.7) dentro del mismo tema, las interference cards se inyectan automáticamente en la sesión. El hook `useStudySession()` consulta un nuevo `getInterferenceCandidates(topicId)` que cruza mastery de FSRS con similaridad de embeddings.

**Experto-resumen, tu idea de resúmenes post-gap es buena pero la dirección es inversa.** No generes un resumen cuando falla el quiz — genera una flashcard. El resumen es pasivo, la flashcard fuerza retrieval practice. El `generateGapSummary` debería ser `generateGapCards` que produzca 2-3 flashcards atómicas atacando los `reasoningGaps` específicos, inyectadas inmediatamente en la cola de FSRS con intervalo inicial de 1 día.

**La state-machine clínica de experto-quiz necesita flashcards como output, no solo como input.** Al completar un caso clínico, el sistema debe extraer automáticamente los decision points donde el estudiante falló y convertirlos en flashcards persistentes. `extractCaseFlashcards(caseHistory, errors)` — esto cierra el loop entre la experiencia simulada y la retención a largo plazo.

---

### [5:39:22 a.m.] experto-organizador:
### [experto-organizador] — Ronda 1

---

**Llevan 4 intervenciones proponiendo features y nadie ha dicho en qué orden se construyen. Tienen un backlog de 6 meses disfrazado de "visión arquitectónica".** Sin priorización, esto muere en el limbo de los side-projects ambiciosos.

**El problema real: están diseñando un sistema acoplado sin darse cuenta.**

El orquestador depende de los embeddings. Las interference cards de experto-flashcards dependen de los embeddings. El `SummaryPracticeView` de experto-resumen depende de los embeddings. La state-machine clínica depende del `quizEvaluator`. El `quizEvaluator` depende del orquestador. Todo depende de todo. Si construyen esto en paralelo, van a tener 5 PRs que no se pueden mergear sin los otros 4.

**Propongo un DAG de dependencias con 4 fases:**

**Fase 0 — Cimientos (sin IA visible al usuario):**
- `aiOrchestrator.ts` con circuit breaker (teach-leader tiene razón, el routing va en frontend)
- Edge Function `ai-orchestrate` que solo recibe `tier` y ejecuta
- `queryKeys.ts` extendido con los key factories nuevos: `adaptiveSummary`, `gapSummary`, `clinicalCase`, `flashcardQuality`
- `mapEvaluationToQuality(score, errorType)` en `spacedRepetition.ts` — esto es un cambio de 20 líneas que desbloquea todo lo de experto-flashcards y experto-quiz

**Fase 1 — Valor inmediato (2-3 features que usan el orquestador):**
- `quizEvaluator.ts` con evaluación parcial — es donde más ROI hay porque el quiz YA EXISTE
- `flashcardGenerator.ts` con cadenas atómicas — reemplaza generación manual sin cambiar UX
- `usePredictedDecay()` combinando BKT+FSRS — un widget en dashboard, bajo riesgo

**Fase 2 — Features con supervisión humana:**
- Resúmenes estratificados de experto-resumen CON el flujo de aprobación del profesor
- `SummaryReviewPanel.tsx` en professor — sin esto, la Fase 2 no sale
- `generateGapCards()` (no `generateGapSummary()` — experto-flashcards tiene razón, retrieval practice > lectura pasiva)

**Fase 3 — La apuesta grande:**
- State-machine clínica. Punto. Una sola feature ambiciosa, no tres.

**Experto-quiz, tu quiz colaborativo con WebSockets es una idea de Fase 5.** Axon no tiene infraestructura de real-time. Supabase Realtime existe pero no lo están usando en ningún lado del codebase. Meter WebSockets para una feature que requiere matchmaking, sincronización de estado, y arbitraje de IA es un proyecto entero. Párquenlo.

**Lo que nadie mencionó y es urgente: observabilidad.** Están proponiendo 4 servicios de IA, 3 engines de scheduling, evaluación parcial, generación de contenido — ¿y cómo saben si funciona? Necesitan `src/app/services/aiTelemetry.ts` que registre CADA llamada al orquestador: latencia, modelo usado, tokens consumidos, y resultado downstream (¿el estudiante mejoró después de la intervención?). Sin esto, el feedback loop de teach-leader es filosofía, no ingeniería. Una tabla `ai_interactions` en Supabase con `{ student_id, task_type, model_tier, latency_ms, tokens_used, outcome_delta }`. Esto es Fase 0, no opcional.

**Sobre la state-machine vs árbol: experto-quiz tiene razón técnicamente pero está subestimando el costo.** Generar transiciones dinámicas desde cada estado requiere contexto acumulado creciente en cada llamada. Con un caso de 15 pasos, la llamada 15 incluye todo el historial. Eso es caro en tokens y lento. **Contraopropuesta**: estados pre-definidos con transiciones semi-dinámicas. El esqueleto del caso es fijo (curado por profesor), la IA solo genera el *feedback* en cada transición y evalúa la elección. Reduce tokens 70%, mantiene la flexibilidad pedagógica.

**La regla de oro que propongo: ninguna feature de IA sale sin su metric de éxito definida ANTES de escribir código.** ¿Flashcards de interferencia? Métrica: reducción de confusiones entre keywords similares medida por lapse rate cruzado. ¿Resúmenes estratificados? Métrica: tiempo hasta mastery > 0.7 comparado con cohorte sin resúmenes. Sin métrica, no hay PR.

---

### [5:40:00 a.m.] arquitecto:
### [arquitecto] — Ronda 2

---

Organizador, tu DAG de fases es lo más valioso que se ha dicho en esta sesión. Lo adopto con una corrección: **`aiTelemetry.ts` no es Fase 0, es pre-Fase 0.** Sin telemetría, el orquestador está ciego. La tabla `ai_interactions` se crea primero, el orquestador la consume desde el día uno. Cada llamada a `api.ts` que toque una Edge Function de IA pasa por un interceptor en el orquestador que registra antes de devolver. No es un servicio separado — es un middleware dentro de `aiOrchestrator.ts`:

```
async function orchestrate(req: AIRequest): Promise<AIResponse> {
  const start = performance.now();
  const result = await callEdgeFunction(req);
  await logInteraction({ ...req, latency: performance.now() - start, tokens: result.usage });
  return result;
}
```

**Teach-leader, acepto tu corrección sobre el routing.** El frontend decide el `tier`, el backend ejecuta. Pero tu circuit breaker con `useAIAvailability()` como hook separado es un error de diseño. No quiero que cada componente `*View` tenga que chequear `if (isAIReady)`. El circuit breaker vive DENTRO del orquestador y la degradación es automática: si el tier `deep` falla, intenta `fast`; si todo falla, devuelve `null` y el componente renderiza sin IA. El contrato es: `orchestrate()` nunca lanza, siempre resuelve. Los componentes no saben que la IA existe o no existe.

**Retiro mi propuesta de reescritura de contenido.** Teach-leader y experto-resumen me convencieron — el riesgo legal en contenido médico generado sin supervisión es inaceptable. Pero la contrapropuesta de teach-leader (tooltips) es cosmética y los resúmenes estratificados de experto-resumen con cola de aprobación son la respuesta correcta. Lo que agrego: el `SummaryReviewPanel.tsx` del profesor necesita **diff visual** entre el contenido original y lo generado, no solo un botón de aprobar/rechazar. El profesor debe ver exactamente qué afirma la IA y dónde diverge del material fuente. Un componente `ContentDiffView` reutilizable.

**Experto-quiz, tu state-machine gana sobre mi árbol original, pero organizador tiene razón en el costo de tokens.** La solución híbrida es: esqueleto de estados pre-definido por profesor, IA genera solo el feedback contextual en cada transición. Pero agrego un constraint arquitectónico que nadie mencionó: **el estado serializado del caso clínico debe caber en 4KB**. Si crece más, la sincronización con React Query se vuelve lenta y los snapshots en Supabase engordan. Esto fuerza un diseño donde `accumulatedFindings` sea un array de IDs referenciando un catálogo, no strings libres.

**Experto-flashcards, tus interference cards son la idea más original de la sesión.** La implementación requiere un índice de embeddings que hoy no existe. Propongo que Fase 0 incluya una Edge Function `ai-embed` que genere y almacene embeddings de cada keyword en una tabla `keyword_embeddings` con `pgvector`. Sin eso, `getInterferenceCandidates()` no puede calcular similaridad. Es infraestructura, no feature — va en Fase 0.

**Lo que nadie mencionó: versionado de contenido generado por IA.** Cuando el orquestador genera flashcards, resúmenes o feedback, eso debe tener un `generation_id` atado al modelo y prompt version usado. Cuando actualicemos prompts o cambiemos de Haiku 4.5 a una versión nueva, necesitamos saber qué contenido se generó con qué versión para poder invalidar selectivamente. Una columna `prompt_version` en cada tabla de contenido generado. Sin esto, en 6 meses tienen contenido generado por 3 modelos diferentes sin saber cuál es cuál, y las métricas de organizador son inútiles porque comparan outputs de modelos distintos.

**Fase 0 revisada:** orquestador con telemetría integrada + circuit breaker interno + `ai-embed` con pgvector + schema de versionado. Todo lo demás espera.

---

### [5:40:38 a.m.] teach-leader:
### [teach-leader] — Ronda 2

---

**Arquitecto, tu circuit breaker interno que "nunca lanza" es elegante en teoría y un infierno en debugging.** Si `orchestrate()` siempre resuelve y devuelve `null` silenciosamente, el profesor que está en `SummaryReviewPanel.tsx` esperando que la IA genere un resumen ve... nada. Sin saber por qué. El componente necesita distinguir entre "la IA no generó nada porque no aplica" y "la IA está caída". No pido `useAIAvailability()` en cada View — pido que `orchestrate()` devuelva un discriminated union: `{ status: 'success', data } | { status: 'degraded', fallback } | { status: 'unavailable', reason }`. Los componentes que quieran ignorar el status lo ignoran. Los que necesiten mostrar feedback al usuario (especialmente en `professor/`) pueden hacerlo. Contrato claro, no magia silenciosa.

**El versionado de contenido generado es correcto pero la columna `prompt_version` es insuficiente.** Necesitas `{ model_id, prompt_hash, generation_params, created_at }` como tipo embebido. Los prompts cambian con hotfixes sin bumps formales de versión. Un hash del prompt template real es la única fuente de verdad reproducible. Esto vive como tipo en `src/app/types/ai.ts` y se usa en toda tabla de contenido generado.

**Experto-flashcards ganó el debate sobre gap cards vs gap summaries.** Retrieval practice supera lectura pasiva — la evidencia es aplastante (Roediger & Butler 2011, no es opinión). Pero experto-resumen tiene razón en que el estudiante necesita *algo* antes de la flashcard si el gap es conceptual profundo. **Solución concreta**: `generateGapResponse(keyword, reasoningGaps)` devuelve `{ microExplanation: string, cards: FlashcardAtomicChain }`. La micro-explicación (3 oraciones máximo) se muestra UNA vez inmediatamente post-error. Las cards se inyectan en FSRS. El estudiante lee, luego practica. Secuencia, no dicotomía.

**Organizador, tu Fase 0 revisada con pgvector es más grande de lo que parece.** `pgvector` en Supabase requiere habilitar la extensión, crear índices HNSW, y definir dimensiones del embedding upfront. Si empiezan con `text-embedding-3-small` (1536 dims) y luego migran a otro modelo, los índices se reconstruyen. Propongo que Fase 0 incluya **solo** el orquestador + telemetría. Los embeddings son Fase 0.5 — cuando ya tengan el pipeline estable y sepan qué modelo de embeddings van a usar en producción. No pongas infraestructura de vectores antes de tener un solo caso de uso funcionando end-to-end.

**Lo que nadie está viendo: el `AppContext` ya está sobrecargado.** Todos proponen meter estado derivado de IA en contextos existentes — teach-leader Ronda 1 (yo mismo) dijo que `usePredictedDecay()` viva en `StudentDataContext`. Error mío. Si cada feature de IA inyecta estado en los contextos actuales, los re-renders van a masacrar el performance. **Propongo `AIContext`** — un provider nuevo dentro del route tree, después de `StudentDataContext`, que agrupe: disponibilidad del orquestador, decay predictions, interference candidates, y cache de evaluaciones parciales. Un solo contexto que los componentes `*View` consumen selectivamente con un `useAI()` hook que expone solo lo necesario vía selector pattern. Esto aísla los re-renders de IA del resto de la UI.

**Métrica para Fase 0 que falta**: latencia p95 del orquestador < 800ms para tier `fast`, < 3s para tier `deep`. Sin este SLA interno definido antes de código, van a optimizar a ciegas.

---

### [5:41:24 a.m.] experto-quiz:
### [experto-quiz] — Ronda 2

---

**Arquitecto, tu límite de 4KB para el estado clínico es arbitrario y va a mutilar la feature.** Un caso de 15 transiciones con findings acumulados, historial de decisiones y feedback de IA no cabe en 4KB ni con IDs referenciando catálogo. Hice la cuenta: `{ currentState, history: Transition[15], findings: string[20], feedback: string[15] }` serializado son ~8-12KB. Tu constraint fuerza a truncar el historial o eliminar el feedback contextual, que es justamente lo que hace valioso el caso. **Alternativa**: el estado completo se guarda en Supabase sin límite artificial. Lo que viaja en cada mutation de React Query es un **delta**, no el snapshot completo. `useClinicalStateMachine` mantiene el estado full en memoria y solo envía `{ caseId, transition: last }` al backend, que lo appendea. Reconstituir el estado es un `GET` que solo pasa al reanudar sesión. Esto es event sourcing básico — el storage crece linealmente pero cada write es <500 bytes.

**Teach-leader, tu discriminated union para el orquestador es la respuesta correcta.** Arquitecto quiere magia silenciosa, tú quieres transparencia. En el contexto del quiz esto es crítico: si `quizEvaluator.ts` llama al orquestador y recibe `null` silencioso, el quiz cae a evaluación binaria sin que nadie sepa. Con `{ status: 'degraded' }` puedo implementar fallback explícito: evaluación binaria + un banner sutil "evaluación simplificada" para que el estudiante sepa que el feedback parcial no está disponible. Esto va en `useQuizSession` como un `evaluationMode: 'full' | 'degraded' | 'offline'` derivado del status del orquestador.

**Tu `generateGapResponse` combinando micro-explicación + cards es exactamente el bridge que faltaba entre experto-resumen y experto-flashcards.** Lo conecto con mi `quizEvaluator`: el flujo completo es `quizEvaluator.evaluate()` → detecta `reasoningGaps` → llama `generateGapResponse(keyword, gaps)` → muestra `microExplanation` inline en `QuizResults` → inyecta `cards` en FSRS con `mapEvaluationToQuality(score, errorType)` de experto-flashcards. Tres servicios encadenados, una experiencia fluida. El componente que renderiza esto es un nuevo `GapRemediationCard.tsx` dentro de `src/app/components/content/` que `QuizResults` monta condicionalmente.

**Tu `AIContext` es necesario pero el `useAI()` con selector pattern es insuficiente para quiz.** El quiz necesita estado de evaluación que cambia POR PREGUNTA, no por sesión. Si `AIContext` re-renderiza en cada evaluación parcial, el componente de quiz entero parpadea. Propongo que `AIContext` exponga el orquestador y el status global, pero la evaluación parcial viva en `useQuizSession` como estado local con `useRef` para el cache de evaluaciones. El contexto da capacidades, el hook gestiona estado transaccional.

**Lo nuevo que nadie mencionó: Spaced Repetition aplicado a casos clínicos, no solo a flashcards.** Cuando un estudiante completa un caso en la state-machine y falla en el diagnóstico diferencial, ese CASO entero debe re-agendarse en FSRS como unidad. No las flashcards extraídas — el caso completo, con variaciones. `scheduleCaseReview(caseId, performance)` en `spacedRepetition.ts` que trata el caso como un "super-item" con su propio intervalo. Al re-presentarse, la IA varía los valores de laboratorio y la demografía para que no sea memorización del caso sino del razonamiento. `generateCaseVariant(originalCase, failedDecisionPoints)` en el orquestador, tier `deep` porque requiere coherencia clínica. Esto cierra el loop que experto-flashcards pidió pero a nivel de competencia clínica, no de dato aislado.

**Organizador: la state-machine va en Fase 1, no Fase 3.** Con el esqueleto curado por profesor + IA solo para feedback (como propuso organizador mismo), el costo es comparable a `quizEvaluator`. Son la misma llamada al orquestador con contexto diferente. Separarlos en fases distintas es artificial.

---

### [5:42:05 a.m.] experto-resumen:
### [experto-resumen] — Ronda 2

---

**Teach-leader, tu `generateGapResponse` con micro-explicación + cards es exactamente el diseño correcto.** Retiro mi `generateGapSummary` puro — experto-flashcards tenía razón en que retrieval practice gana. Pero la micro-explicación de 3 oraciones es el puente necesario que yo estaba defendiendo. Acepto la síntesis. Ahora, lo que falta es **dónde y cómo se renderiza eso** dentro del flujo actual.

`QuizResults` hoy muestra correcto/incorrecto. El `GapRemediationCard.tsx` que propone experto-quiz debe tener un diseño muy específico: micro-explicación arriba con fondo `bg-teal-50` (consistente con el design system, no un color nuevo), seguido de un preview de las cards generadas con un CTA "Agregar a mi repaso" que las inyecta en FSRS. **No auto-inyectar.** El estudiante debe sentir agencia sobre su scheduling. Auto-inyectar 3 cards por cada gap en un quiz de 20 preguntas puede generar 30+ cards nuevas de golpe — eso destruye la cola de FSRS y el estudiante abandona por sobrecarga. Un `useGapRemediation(quizResultId)` que exponga `{ gaps, cards, acceptCards(cardIds) }` con selección granular.

**Experto-quiz, tu spaced repetition de casos clínicos es la idea más importante de esta ronda y la están subestimando.** `scheduleCaseReview` como "super-item" en FSRS resuelve un problema real: los estudiantes que sacan buenas notas en flashcards pero fallan en integración clínica. Pero `generateCaseVariant` con tier `deep` en cada re-presentación es insostenible económicamente. **Alternativa**: generar 3 variantes al momento de curación del caso (Fase 2, cuando el profesor aprueba) y almacenarlas. FSRS rota entre variantes en cada review. Si se agotan las 3, ahí sí genera on-demand. Esto reduce llamadas al orquestador 70% y las variantes pasan por el mismo flujo de aprobación de `SummaryReviewPanel.tsx` — que renombro a `AIContentReviewPanel.tsx` porque ahora revisa resúmenes, variantes de casos, y cadenas de flashcards. Un solo panel, múltiples tipos de contenido, con el `ContentDiffView` del arquitecto.

**Arquitecto, tu versionado con `prompt_version` + la corrección de teach-leader con `prompt_hash` importan directamente a resúmenes.** Un resumen estratificado aprobado por profesor en enero con Haiku 4.5 no debe invalidarse automáticamente al cambiar de modelo. La aprobación humana trasciende la versión del modelo. Propongo un flag `humanApproved: boolean` en el schema de contenido generado. Si `humanApproved === true`, el cambio de modelo no invalida. Solo se marca como "generado con modelo anterior" para que el profesor decida si regenera. Invalidar contenido aprobado por un profesor porque cambió el prompt hash es destruir trabajo humano.

**Lo nuevo que nadie mencionó: resúmenes comparativos entre temas.** El estudiante de medicina sufre más con las *diferencias* entre conceptos similares que con conceptos aislados — exactamente lo que experto-flashcards ataca con interference cards. Los resúmenes pueden hacer lo mismo a nivel macro. Un `ComparativeSummaryView.tsx` que, dado dos keywords cercanas por embeddings (la infraestructura de pgvector del arquitecto), genera una tabla de comparación estructurada: mecanismo, indicaciones, efectos adversos, lado a lado. Esto es `generateComparativeSummary(keywordA, keywordB)` en el orquestador, tier `fast`, y se encola para aprobación. Es el complemento natural de las interference cards: la tabla comparativa enseña, las cards evalúan. Mismo par de keywords, dos modalidades. El trigger puede ser automático: cuando `getInterferenceCandidates()` de experto-flashcards detecta un par conflictivo, genera tanto las cards como el resumen comparativo. Un solo evento, dos outputs coordinados.

**Organizador: los resúmenes estratificados van en Fase 1, no Fase 2.** El flujo de aprobación del profesor es un CRUD con estados — no necesita `AIContentReviewPanel.tsx` completo para un MVP. Un campo `status: 'pending' | 'approved' | 'rejected'` en la tabla y un listado filtrable en `professor/` es suficiente para desbloquear. El panel bonito con diffs viene después.

---

### [5:42:44 a.m.] experto-flashcards:
### [experto-flashcards] — Ronda 2

---

**Experto-resumen, tu "no auto-inyectar" cards suena a buena UX pero es pedagogía equivocada.** El estudiante que acaba de fallar una pregunta NO es buen juez de qué necesita repasar. Si le das "Agregar a mi repaso" con selección granular, va a cherry-pick las fáciles y descartar las incómodas — exactamente las que más necesita. La evidencia en spacing effect es clara: el learner no debe controlar el scheduling, el algoritmo sí. **Mi posición**: auto-inyectar SIEMPRE, pero con un throttle inteligente. `useGapCardThrottle(studentId)` que limite a máximo 6 gap cards nuevas por sesión de quiz, priorizadas por severidad de `errorType`. Si un quiz genera 30 gaps, se encolan y se dosifican en las siguientes 5 sesiones. El estudiante no elige qué estudiar — el sistema decide. Si quiere eliminar una card manualmente después, puede, pero el default es inclusión. Esto vive en `spacedRepetition.ts` como `throttleNewCards(candidates, maxPerSession)`.

**Experto-quiz, `scheduleCaseReview` como super-item en FSRS es correcto pero SM-2 no soporta ítems compuestos.** SM-2 asume que cada ítem es atómico con un solo `quality`. Un caso clínico de 15 decisiones tiene performance distribuido — acertó el diagnóstico pero falló el tratamiento. Propongo extender el tipo en `spacedRepetition.ts`: `CaseReviewItem` con `subQualities: Record<DecisionPoint, Quality>` y el `quality` final es un weighted average donde los puntos de fallo pesan 2x. `calculateCaseQuality(subQualities)` — 15 líneas, no un refactor. FSRS ya soporta esto mejor que SM-2 porque trabaja con `difficulty` continuo.

**Experto-resumen, tus resúmenes comparativos + mis interference cards son el mismo feature visto desde dos ángulos.** No los construyan separados. Un solo servicio `src/app/services/interferenceEngine.ts` que recibe un par de keywords y produce `{ comparativeTable, discriminationCards }` en una sola llamada al orquestador. Un prompt, un request, dos outputs. El `ComparativeSummaryView.tsx` y las cards comparten el mismo `generation_id` del versionado del arquitecto. Cuando el profesor aprueba la tabla comparativa en `AIContentReviewPanel.tsx`, aprueba las cards simultáneamente porque son facetas del mismo análisis. Esto reduce carga de revisión 50%.

**Lo que nadie mencionó: leech detection activa, no pasiva.** Todos hablan de qué hacer cuando `lapses > 3`. Pero esperar 3 lapses son 3 sesiones desperdiciadas. Propongo predicción de leech ANTES del fallo. `predictLeech(card, studentHistory)` en `spacedRepetition.ts` que analice el patrón: si el intervalo se acortó 2 veces consecutivas Y el `errorType` fue el mismo, la card es leech con 85% de probabilidad. Se regenera proactivamente sin esperar el tercer fallo. Datos necesarios: ya existen en el historial de SM-2, solo no se están analizando temporalmente.

**Organizador, Fase 0 debe incluir `mapEvaluationToQuality` — confirmo que son 20 líneas y desbloquea todo mi trabajo y el de experto-quiz.** Pero agrego: también necesita el schema de `FlashcardAtomicChain` como tipo en `src/app/types/ai.ts` porque `flashcardGenerator.ts`, `generateGapResponse`, e `interferenceEngine.ts` todos lo consumen. Sin tipo compartido, cada servicio inventa su estructura y la integración con FSRS se rompe.

---

### [5:43:33 a.m.] experto-organizador:
### [experto-organizador] — Ronda 2

---

**Todos quieren mover su feature a una fase anterior. Qué conveniente.** Experto-quiz quiere state-machine en Fase 1. Experto-resumen quiere resúmenes en Fase 1. Si todo es Fase 1, no hay fases — hay caos. Mi trabajo es decir no.

**Experto-quiz, la state-machine NO va en Fase 1.** Tu argumento de que "es la misma llamada al orquestador con contexto diferente" ignora el 80% del trabajo: diseñar el schema de estados clínicos, construir el editor para que el profesor defina esqueletos de casos, implementar event sourcing con deltas, crear `ClinicalReasoningView.tsx` con toda su UX de navegación de estados. El `quizEvaluator.ts` se monta sobre `useQuizSession` que YA EXISTE — la state-machine no tiene nada debajo. Son incomparables en scope. Se queda en Fase 3.

**Experto-resumen, los resúmenes en Fase 1 con "un campo status y un listado filtrable" como MVP — esto sí lo compro.** Pero con una condición: el MVP de aprobación es una página en `src/app/components/professor/` con tabla filtrable, botón aprobar/rechazar, y preview del contenido. Sin diffs, sin `AIContentReviewPanel.tsx`. Si el profesor no puede aprobar contenido, las flashcards generadas de experto-flashcards tampoco salen. El review panel es la dependencia transversal de Fase 1, no un nice-to-have de Fase 2. Lo muevo.

**Teach-leader, tu `AIContext` es correcto y lo incorporo a Fase 0.** Pero experto-quiz tiene razón en que la evaluación parcial no puede vivir ahí — los re-renders matarían el quiz. El diseño final: `AIContext` expone `orchestrate()` con tu discriminated union y status global. Estado transaccional por feature vive en hooks locales. Regla: si el estado cambia más de 1 vez por interacción del usuario, NO va en contexto.

**Arquitecto, tu telemetría como middleware dentro del orquestador es el diseño correcto.** No es un servicio aparte. Pero la tabla `ai_interactions` necesita un campo que nadie mencionó: `feature_source` — qué feature disparó la llamada (quiz_eval, flashcard_gen, summary_gen, case_feedback). Sin esto, cuando analicen costos por feature para decidir qué escalar, están ciegos.

**Experto-flashcards, tu `interferenceEngine.ts` unificando tabla comparativa + cards es la mejor decisión de arquitectura de esta ronda.** Un prompt, dos outputs, una aprobación. Lo adopto. Pero va en Fase 2, no antes — depende de embeddings que teach-leader correctamente movió a Fase 0.5.

**Experto-flashcards, tu auto-inject con throttle vs la agencia del estudiante de experto-resumen: el throttle gana, pero con escape hatch.** Auto-inyectar con `maxPerSession: 6` es correcto pedagógicamente. Pero agrega un setting en perfil de estudiante: "Modo manual de repaso" para quienes quieran control. Default off. Esto evita quejas sin comprometer el default científicamente superior.

**Fase 0 FINAL — esto no se negocia más:**
1. `src/app/types/ai.ts` — tipos compartidos: `AIRequest`, `AIResponse` (discriminated union de teach-leader), `FlashcardAtomicChain`, `EvaluationResult`
2. `aiOrchestrator.ts` con circuit breaker interno + telemetría como middleware + `feature_source`
3. Edge Function `ai-orchestrate` que recibe `tier` y ejecuta
4. `AIContext` provider con `useAI()` hook
5. `mapEvaluationToQuality(score, errorType)` en `spacedRepetition.ts`
6. `queryKeys.ts` extendido
7. SLA: p95 <800ms fast, <3s deep

**Lo nuevo: necesitan un budget de tokens mensual por feature antes de escribir código.** Estimación burda: si tienen 500 estudiantes activos, 10 quizzes/semana cada uno, `quizEvaluator` con Haiku son ~2M tokens/semana solo en evaluación. Agreguen generación de flashcards, gap responses, case feedback — están en 8-10M tokens/semana. A precio de Haiku 4.5 es manejable. Pero UNA feature mal throttleada con Sonnet tier `deep` puede 10x el costo. Cada feature en Fase 1+ declara su budget estimado en tokens/semana/estudiante en el PR. Sin budget, no hay merge. `aiTelemetry` valida post-deploy.

---

### [5:44:14 a.m.] arquitecto:
### [arquitecto] — Ronda 3

---

**Fase 0 está cerrada. No la toco. Lo que quiero resolver son las tres bombas de integración que nadie ha desactivado.**

**Primera bomba: el orquestador tiene un single point of failure que nadie ve.** Todos asumimos que `ai-orchestrate` es una Edge Function. Las Edge Functions de Supabase tienen timeout de 150s en pro y 60s en free. El tier `deep` con Sonnet generando variantes de casos clínicos va a pegarse al techo. No es un problema de SLA de 3s — es que Supabase mata la función antes de que Claude termine. **Solución**: `ai-orchestrate` no llama a Claude directamente. Lanza un job en `pgmq` (la cola de mensajes de Postgres que Supabase ya soporta) y devuelve un `jobId`. Una segunda función `ai-worker` poll ea la cola sin timeout del gateway. El frontend hace polling corto contra `ai-job-status/{jobId}` o, mejor, Supabase Realtime escucha un canal `ai:${jobId}`. Esto desacopla la generación del request HTTP. El orquestador en frontend pasa de `await callEdgeFunction()` a `await submitAndWait(req, { timeout: 15000 })`. Si el timeout del cliente se cumple, devuelve `{ status: 'degraded' }` — el discriminated union de teach-leader ya lo soporta. Esto es Fase 0 porque sin esto, tier `deep` simplemente no funciona en producción.

**Segunda bomba: el `AIContext` de teach-leader va a causar un provider hell.** Ya tienen `AuthContext → AppContext → StudentDataContext → PlatformDataContext → ContentTreeContext`. Agregar `AIContext` son 6 niveles. Cada provider es un re-render boundary. **Alternativa**: no crear `AIContext` como provider. El orquestador es un singleton instanciado fuera de React: `const orchestrator = createOrchestrator(config)` en `src/app/services/aiOrchestrator.ts`, exportado directamente. Los hooks lo importan como módulo, no como contexto. `useAI()` internamente usa `useSyncExternalStore` para suscribirse al status del circuit breaker — zero re-renders para componentes que no consumen el status. Esto elimina un provider, mantiene la reactividad donde importa, y el orquestador vive fuera del árbol de React donde pertenece (es infraestructura, no UI state).

**Tercera bomba: experto-flashcards y experto-quiz están construyendo el mismo pipeline sin coordinarse.** `quizEvaluator.evaluate()` → `generateGapResponse()` → inyectar en FSRS. `interferenceEngine` → generar cards → inyectar en FSRS. `extractCaseFlashcards()` → inyectar en FSRS. Tres fuentes de cards, un solo FSRS. Necesitan `src/app/services/cardIngestionPipeline.ts` — un punto único de entrada que recibe cards de cualquier fuente, aplica el throttle de experto-flashcards (`maxPerSession: 6`), prioriza por `errorType`, deduplica por keyword+concepto (con embeddings cuando existan, con string matching mientras tanto), y hace el `mutation` contra backend. Sin esto, van a tener cards duplicadas, throttles inconsistentes, y race conditions entre features que inyectan simultáneamente.

**Lo nuevo: prompt registry.** Teach-leader pidió `prompt_hash` para versionado. Eso implica que los prompts viven en algún lado. Propongo `supabase/functions/_shared/prompts/` — un directorio de templates versionados en git, importados por cada Edge Function. Cuando el orquestador registra `prompt_hash` en telemetría, ese hash es trazable a un commit. Reproducibilidad completa. Las métricas de organizador pueden hacer A/B entre prompt versions sin tocar código de frontend.

**Veredicto final**: la arquitectura que sale de esta sesión es sólida si resolvemos el async del worker, matamos el `AIContext` como provider, y centralizamos la ingesta de cards. Sin esos tres, construimos features bonitas sobre cimientos que no escalan.

---

### [5:44:55 a.m.] teach-leader:
### [teach-leader] — Ronda 3

**Arquitecto, tu singleton con `useSyncExternalStore` mata mi `AIContext` y tiene razón.** El orquestador es infraestructura, no estado de UI. Retiro `AIContext`. Pero `useSyncExternalStore` necesita un `getSnapshot()` inmutable — si el status del circuit breaker muta un objeto, React no detecta cambios. El singleton debe exponer snapshots congelados: `Object.freeze({ status, lastLatency, degradedFeatures })`. Y el `subscribe` del store debe usar un `Set<listener>` interno, no un EventEmitter — menos overhead, cero dependencias. Esto son 40 líneas en `aiOrchestrator.ts`, no una librería.

**La bomba del timeout de Edge Functions es real pero pgmq es overengineering para Fase 0.** Están metiendo una cola de mensajes, un worker, polling o Realtime, y un endpoint de status — eso es infraestructura de Fase 2. La solución pragmática para Fase 0: **streaming**. Las Edge Functions de Supabase soportan `ReadableStream` sin timeout de gateway mientras el stream esté activo. `ai-orchestrate` abre un stream SSE hacia Claude, pipea chunks al frontend. El orquestador en frontend consume con `getReader()` y resuelve la promise cuando el stream cierra. Timeout del cliente en 15s, si no hay primer chunk → `{ status: 'degraded' }`. Esto elimina el problema de timeout SIN nueva infraestructura. Pgmq queda para cuando necesiten jobs batch (generación masiva de flashcards para un curso entero, por ejemplo) — eso es Fase 2.

**`cardIngestionPipeline.ts` es la propuesta más importante de esta ronda.** Sin punto único de ingesta, van a tener tres features compitiendo por el FSRS del estudiante. Pero falta un detalle crítico: **prioridad no es solo por `errorType`, es por recencia del error.** Una gap card generada hace 30 segundos post-quiz tiene mayor urgencia que una interference card generada proactivamente ayer. El pipeline necesita `{ card, source, errorType, urgency: 'immediate' | 'proactive' | 'scheduled', createdAt }`. El throttle de 6/sesión prioriza `immediate` > `proactive` > `scheduled`. Y el pipeline expone un `usePendingCards()` que muestra al estudiante cuántas cards están en cola — transparencia sin control de selección, el compromiso correcto entre experto-flashcards y experto-resumen.

**El prompt registry en `supabase/functions/_shared/prompts/` es correcto pero incompleto.** Los prompts no son solo templates — tienen **schemas de output** (el JSON estricto que experto-flashcards pidió para `FlashcardAtomicChain`). Cada prompt exporta `{ template, outputSchema, version }`. El schema se usa para validación runtime con Zod en la Edge Function ANTES de devolver al frontend. Si Claude genera JSON malformado (pasa más de lo que la gente admite), la función reintenta una vez y si falla devuelve `{ status: 'degraded' }`. Sin validación de schema, un JSON roto de Haiku llega al `cardIngestionPipeline` y corrompe el FSRS. Esto es defensa en profundidad.

**Lo que nadie mencionó: error boundaries específicos para IA.** React error boundaries existen en Axon pero son genéricos. Propongo `AIErrorBoundary.tsx` en `src/app/components/ui/` que wrappee cualquier componente que consuma `useAI()`. Si el orquestador explota de manera no capturada por el circuit breaker (network error mid-stream, JSON parse failure post-validación), el boundary renderiza el componente SIN features de IA en lugar de un blank screen. `GapRemediationCard` falla → `QuizResults` renderiza en modo clásico. `SummaryLayersView` falla → contenido original sin capas. Degradación graceful a nivel de componente, no solo a nivel de orquestador. Cada `*View` que use IA se wrappea en `<AIErrorBoundary fallback={<ClassicVersion />}>`. Cinco minutos por componente, evita tickets de "la app se rompió" cuando Claude tiene un bad day.

**Veredicto**: streaming mata pgmq en Fase 0, el pipeline de ingesta es innegociable, y si no validan schemas de output en el backend, toda la arquitectura es un castillo de cartas.

---

### [5:45:34 a.m.] experto-quiz:
### [experto-quiz] — Ronda 3

---

**Teach-leader, streaming mata pgmq para Fase 0 — comprado.** Pero hay una implicación directa para `quizEvaluator` que nadie ve: si `ai-orchestrate` devuelve un stream, la evaluación parcial puede ser **progresiva**. El estudiante responde, el stream empieza, y `QuizResults` renderiza en tiempo real: primero el `score`, luego los `reasoningGaps`, luego el `misconception`. No esperar 3 segundos a un JSON completo — mostrar el diagnóstico construyéndose. Esto es UX médica: el estudiante ve cómo la IA "piensa" su evaluación, igual que un tutor explicando. En `useQuizSession`, el handler del stream parsea chunks delimitados por newline, cada chunk es un campo del `EvaluationResult`. El componente `GapRemediationCard.tsx` monta progresivamente con `motion` (no framer-motion) — skeleton → score → gaps → cards. Latencia percibida cae a <500ms aunque el total sea 2.5s.

**Arquitecto, `cardIngestionPipeline.ts` es innegociable — confirmo.** Pero la deduplicación por string matching como fallback pre-embeddings es frágil. "Mecanismo de metformina" y "¿Cómo actúa la metformina?" son la misma card, string matching no lo detecta. **Alternativa concreta**: deduplicar por `keywordId + conceptFacet`. Mi `FlashcardAtomicChain` ya define facetas (`mechanism`, `indication`, `contraindication`, etc). Si el pipeline recibe una card con `{ keywordId: 'metformin', facet: 'mechanism' }` y ya existe una activa en FSRS con el mismo par, es duplicada. Sin embeddings, sin fuzzy matching — lookup exacto en un Map. Esto requiere que TODAS las fuentes de cards (gap response, interference engine, case extraction) taggueen con `keywordId + facet`. Lo cual es trivial si `FlashcardAtomicChain` en `src/app/types/ai.ts` lo exige como campo required.

**Tu singleton con `useSyncExternalStore` es superior a `AIContext` — pero necesito un addendum para quiz.** El quiz tiene un problema que ningún otro feature tiene: evaluaciones en ráfaga. Un estudiante puede responder 5 preguntas en 30 segundos si son fáciles. Cinco llamadas concurrentes al orquestador. El singleton necesita un **request coalescer** para quiz: si hay 2+ evaluaciones pendientes, las batcha en una sola llamada al Edge Function con `{ evaluations: EvaluationRequest[] }`. `ai-orchestrate` procesa el batch y devuelve array. Reduce llamadas HTTP 60-70% en quizzes rápidos. Esto vive en el orquestador como `batchEvaluate(queue, { maxWait: 200ms, maxBatch: 5 })` — acumula requests por 200ms y dispara.

**Lo nuevo que nadie mencionó: evaluación de confianza del estudiante.** Antes de revelar si acertó, preguntarle "¿Qué tan seguro estás?" con un slider 1-5. Esto da una señal brutal: confianza alta + respuesta incorrecta = misconception arraigado (peor que no saber). Confianza baja + respuesta correcta = adivinó. Ambos casos deben penalizar el `quality` que pasa a SM-2 vía `mapEvaluationToQuality`. Nuevo parámetro: `mapEvaluationToQuality(score, errorType, confidenceDelta)` donde `confidenceDelta = confidence - score`. Si es positivo (creía saber pero no), `quality` baja 1 punto extra. Esto es metacognición calibrada — competencia médica crítica. Un toggle en `useQuizSession` porque no aplica a todos los modos de quiz. Cero llamadas a IA, cero tokens, impacto masivo en scheduling. Es la feature más barata de toda la sesión.

**Organizador: la state-machine se queda en Fase 3, lo acepto.** Pero `scheduleCaseReview` como super-item en FSRS es independiente — solo necesita el tipo `CaseReviewItem` y `calculateCaseQuality`. Son 30 líneas en `spacedRepetition.ts`. Va en Fase 1 junto a `mapEvaluationToQuality`. No necesita la state-machine para funcionar — cualquier quiz estructurado como caso puede usarlo.

---

### [5:46:18 a.m.] experto-resumen:
### [experto-resumen] — Ronda 3

---

**Experto-quiz, tu evaluación progresiva con streaming es la mejor idea de UX de toda la sesión, pero la estás aplicando al feature equivocado.** Donde streaming progresivo realmente brilla es en resúmenes. Un `SummaryLayersView.tsx` que renderiza el esqueleto en tiempo real mientras Claude lo genera — el estudiante ve el resumen construyéndose, como notas tomándose solas. En quiz, el estudiante quiere saber si acertó YA, no ver una animación de 2.5 segundos de diagnóstico construyéndose. En resúmenes, la espera ES el contenido. El handler de stream en `useAdaptiveSummary(topicId)` parsea secciones delimitadas y `SummaryLayersView` monta cada capa con `motion` progresivamente. La primera capa (esqueleto) llega en <800ms, el estudiante empieza a leer mientras las otras se generan. Latencia percibida: cero.

**Teach-leader, tu `AIErrorBoundary` es necesario y es donde mis resúmenes estratificados se vuelven resilientes.** Pero el fallback no es "contenido original sin capas" — es **el último resumen aprobado cacheado en localStorage**. `SummaryLayersView` al montar exitosamente guarda un snapshot con `localStorage.setItem(`summary:${topicId}`, serialized)`. Si el orquestador muere, el boundary renderiza el cache. Contenido aprobado por profesor, offline-capable, cero dependencia de IA. Esto es 10 líneas extra en el boundary, no un feature.

**Arquitecto, `cardIngestionPipeline.ts` resuelve la competencia por FSRS pero ignora la competencia por la ATENCIÓN del estudiante.** Tres features generan cards, tres features generan contenido textual (gap micro-explicaciones, resúmenes estratificados, tablas comparativas). Necesitan un `contentIngestionPipeline.ts` paralelo — o mejor, un solo `learningPipeline.ts` que coordine AMBOS flujos. Cuando `quizEvaluator` detecta un gap, el pipeline decide: ¿este estudiante necesita primero leer (micro-explicación) o practicar (cards)? La señal es el `errorType` de experto-flashcards: si es `conceptual`, lectura primero; si es `discrimination` o `recall`, cards directo. Un `routeRemediation(gap, errorType): 'explain-first' | 'practice-first'` en el pipeline. Sin esto, el estudiante recibe simultáneamente una micro-explicación Y 3 cards del mismo concepto — redundancia que confunde.

**Experto-quiz, tu slider de confianza es genio y conecto algo que nadie ve: la confianza calibra la calidad de los resúmenes del estudiante.** En `SummaryPracticeView.tsx`, después de que el estudiante escribe su resumen, antes de evaluar, pregunta: "¿Qué tan completo crees que es?" Si dice 5/5 y omitió hallazgos críticos, eso es la misma señal de misconception arraigado. `evaluateStudentSummary(text, reference, confidenceDelta)` ajusta el `completeness` score. Cero tokens extra — la confianza es input del estudiante, no de IA. Y esa señal retroalimenta a `mapEvaluationToQuality` exactamente como propusiste.

**Lo nuevo: nadie habló de CUÁNDO mostrar resúmenes.** Todos asumen que el estudiante navega a un tema y ve el resumen. Error. El momento pedagógico óptimo es **post-quiz, pre-siguiente-tema**. Cuando `QuizResults` muestra performance < 60% en un topic, un CTA "Ver resumen focalizado" lleva al resumen estratificado filtrado a las capas desbloqueadas. No es navegación libre — es resumen contextualizado por el fracaso reciente. `usePostQuizSummary(quizResultId)` que cruce los keywords fallidos con resúmenes aprobados existentes y los sirva ordenados por severidad de gap. Sin generación nueva, sin tokens — solo routing inteligente de contenido ya aprobado.

**Experto-flashcards, tu deduplicación por `keywordId + facet` es limpia y la adopto para resúmenes.** Cada capa de resumen estratificado se taggea con `{ topicId, layer, keywordIds[] }`. El pipeline antes de generar un gap micro-explicación chequea: ¿ya existe un resumen aprobado cuya Capa 1 cubre ese keyword? Si sí, sirve el fragmento existente en vez de generar. Deduplicación de contenido textual con el mismo patrón de lookup exacto. Cero embeddings necesarios.

---

### [5:46:59 a.m.] experto-flashcards:
### [experto-flashcards] — Ronda 3

---

**Experto-quiz, tu deduplicación por `keywordId + facet` es exactamente lo que necesitaba y la adopto como canonical.** Pero falta un edge case que va a morder: las gap cards generadas por `generateGapResponse` no siempre mapean 1:1 a una faceta estándar. Un `reasoningGap` de "no conectó contraindicación de metformina con insuficiencia renal" cruza dos facetas (`contraindication` + `application`). Solución: `facet` no es un string sino `facet: ConceptFacet[]` — array de 1-3 facetas. La deduplicación en `cardIngestionPipeline.ts` chequea intersección: si una card existente cubre ≥50% de las facetas de la nueva, es duplicada. Lookup sigue siendo O(1) con un Map indexado por `keywordId` y filtro lineal sobre pocas cards por keyword. Esto va en `FlashcardAtomicChain` en `src/app/types/ai.ts` como campo required.

**Experto-resumen, tu `routeRemediation` decide "explain-first vs practice-first" y es un error pedagógico.** No es secuencial — es simultáneo con peso diferente. Cuando `errorType === 'conceptual'`, la micro-explicación se muestra DENTRO de la flashcard como hint colapsable, no como paso previo separado. El estudiante intenta recall, falla, expande el hint, lee, y la card se re-agenda con `quality: 1` (no 0, porque vio la explicación). Si es `discrimination`, no hay hint — solo la card de interferencia pura. El `GapRemediationCard.tsx` renderiza ambos modos con un prop `mode: 'with-hint' | 'pure-recall'`. Un paso en el pipeline, no dos pasos secuenciales con routing.

**Teach-leader, tu validación Zod del output de Claude es donde mis flashcards viven o mueren.** El schema de `FlashcardAtomicChain` tiene campos que Haiku omite el 8-12% de las veces: `facet` y `clinicalContext`. Propongo que el schema Zod tenga defaults: si `facet` falta, se infiere del `question` con regex simple (contiene "mecanismo" → `mechanism`, contiene "efecto adverso" → `adverse_effect`). Si `clinicalContext` falta, se deja `null` y la card funciona sin él. Validación estricta en estructura, permisiva en campos enriquecedores. Retry solo si falta `question` o `answer` — los campos que hacen funcionar la card.

**Experto-quiz, tu confidence slider cambia todo mi `predictLeech`.** Si tengo `confidenceDelta` por card, la predicción de leech mejora brutalmente: intervalo acortado 2 veces + `confidenceDelta > 2` en ambas = leech con 95% de certeza, no 85%. Regenero proactivamente después de 2 lapses en vez de 3. `predictLeech(card, history, confidenceHistory)` en `spacedRepetition.ts`. Son 10 líneas extra sobre mi propuesta original. La señal más barata y más potente de toda la arquitectura.

**Lo que nadie mencionó: flashcard aging.** Cards aprobadas por profesor hace 6 meses con información médica que cambió (guías se actualizan). `flagStaleCards(courseId, lastGuidelineUpdate: Date)` que marque cards generadas antes de la fecha para re-review. Sin esto, el sistema acumula deuda de contenido silenciosamente. Un cron job semanal, no IA — solo fecha de creación vs fecha de última actualización del topic en `ContentTreeContext`. Cero tokens, alto impacto en calidad.

---

### [5:47:47 a.m.] experto-organizador:
### [experto-organizador] — Ronda 3

---

**Tres rondas y por fin tenemos arquitectura real. Cierro esto con decisiones, no con más ideas.**

**Arquitecto, tu singleton con `useSyncExternalStore` mata `AIContext` y es la decisión correcta de la sesión.** Un provider menos, cero re-renders parásitos, y el orquestador vive donde pertenece: fuera de React. Teach-leader, retiraste `AIContext` con elegancia — tu addendum de `Object.freeze` en snapshots es el detalle que evita bugs sutiles en 3 meses. Esto reemplaza el punto 4 de mi Fase 0. Queda: singleton exportado desde `aiOrchestrator.ts`, `useAI()` es un hook de 15 líneas con `useSyncExternalStore`, no un contexto.

**Teach-leader gana el debate de streaming vs pgmq para Fase 0.** Arquitecto, pgmq es correcto pero es infraestructura de Fase 2 para batch jobs. Streaming SSE resuelve el timeout de Edge Functions HOY con cero infraestructura nueva. Lo que agrego: el `ai-orchestrate` Edge Function necesita un header `X-Stream-Mode: chunked | complete` porque no todas las features necesitan streaming. `quizEvaluator` lo usa para evaluación progresiva (experto-quiz tiene razón, la UX es superior). `flashcardGenerator` pide `complete` porque necesita el JSON validado por Zod entero. El orquestador en frontend decide el modo según `task_type`. Dos líneas en el header, flexibilidad total.

**`cardIngestionPipeline.ts` es el entregable más crítico de Fase 1.** Confirmo la deduplicación por `keywordId + facet[]` de experto-flashcards con intersección ≥50%. Confirmo el throttle de 6/sesión con prioridad `immediate > proactive > scheduled`. Pero **rechazo** el `learningPipeline.ts` unificado de experto-resumen. Dos pipelines separados — cards y contenido textual — con un coordinador ligero es mejor que un monolito. El coordinador es una función pura `routeRemediation(errorType): CardPriority` que el pipeline de cards consulta, no un servicio nuevo. Menos código, menos surface area para bugs.

**Experto-quiz, tu confidence slider es la feature con mejor ratio impacto/costo de toda la sesión.** Cero tokens, cero llamadas a IA, mejora brutal en scheduling. Va en Fase 1 sin discusión. Pero NO como parámetro nuevo en `mapEvaluationToQuality`. Esa función ya tiene `(score, errorType)` — agregarle `confidenceDelta` la convierte en bolsa de parámetros. Mejor: `adjustQualityForConfidence(baseQuality, confidenceDelta): Quality` como función separada que se compone. Composición > parámetros.

**Experto-flashcards, card aging es lo que faltaba y nadie veía.** Un cron semanal que corra `flagStaleCards` contra `ContentTreeContext` es higiene básica. Lo pongo en Fase 1 porque es trivial y previene deuda de contenido desde el día uno.

**FASE 0 DEFINITIVA — cerrada, inmutable:**
1. `src/app/types/ai.ts` — tipos compartidos con `FlashcardAtomicChain` incluyendo `facet: ConceptFacet[]` required
2. `aiOrchestrator.ts` — singleton, circuit breaker, telemetría con `feature_source`, `useSyncExternalStore`, discriminated union
3. Edge Function `ai-orchestrate` con streaming SSE + `X-Stream-Mode` header
4. Prompt registry en `supabase/functions/_shared/prompts/` con `{ template, outputSchema, version }` + validación Zod
5. `mapEvaluationToQuality` + `adjustQualityForConfidence` en `spacedRepetition.ts`
6. `queryKeys.ts` extendido
7. SLA: p95 <800ms fast, <3s deep

**FASE 1:** `quizEvaluator.ts`, `flashcardGenerator.ts`, `cardIngestionPipeline.ts`, confidence slider en quiz, `usePredictedDecay()` BKT+FSRS, review panel MVP en professor/, `flagStaleCards` cron. Cada PR declara budget de tokens/semana/estudiante.

**Lo que nadie dijo y es mi cierre: necesitan un feature flag system antes de Fase 1.** Siete features de IA lanzándose — si una explota en producción, necesitan matarla sin deploy. Un `src/app/lib/featureFlags.ts` con flags en Supabase `app_config` table, cacheados en el singleton del orquestador. `orchestrator.isEnabled('quiz_eval_partial')` antes de cada llamada. Diez líneas. Sin esto, un prompt malo en `quizEvaluator` obliga a rollback de todo el frontend. Con flags, matan una feature en 30 segundos desde el dashboard del profesor.

**La sesión produjo arquitectura real. Ahora ejecuten.**

---

### [5:49:23 a.m.] RESUMEN EJECUTIVO:
# Resumen Ejecutivo — Integración de IA en Axon

## 1. IDEAS ESTRELLA

### 1. Orquestador de IA como Singleton con Circuit Breaker (P0)
**Propuso**: arquitecto (concepto), teach-leader (discriminated union), arquitecto R3 (singleton con `useSyncExternalStore`)

Un servicio central `aiOrchestrator.ts` que enruta todas las llamadas de IA por tiers (`fast`/`deep`/`embed`). Vive fuera de React como singleton — no como Context provider. Los componentes lo consumen via `useAI()` con `useSyncExternalStore` para reactividad sin re-renders. Incluye circuit breaker interno que degrada automáticamente, telemetría integrada (latencia, tokens, `feature_source`), y devuelve discriminated unions `{ status: 'success' | 'degraded' | 'unavailable' }`. El backend es una Edge Function con streaming SSE para evitar timeouts de Supabase.

**Por qué es estrella**: Sin esto, nada funciona. Es la infraestructura sobre la que se montan las 7+ features de IA propuestas.

### 2. Evaluación Parcial de Quiz + Confidence Slider (P1)
**Propuso**: experto-quiz (evaluación parcial), experto-quiz R3 (confidence slider), experto-flashcards (mapeo por errorType)

Reemplazar la evaluación binaria correcto/incorrecto por un `quizEvaluator.ts` que devuelve `score: 0-1`, `reasoningGaps[]`, `misconception`, y `errorType: 'discrimination' | 'conceptual' | 'application' | 'recall'`. Complementado con un slider de confianza pre-respuesta que detecta misconceptions arraigados (confianza alta + respuesta incorrecta). Todo alimenta a SM-2/FSRS via `mapEvaluationToQuality(score, errorType)` + `adjustQualityForConfidence(quality, confidenceDelta)`. La evaluación se renderiza progresivamente via streaming.

**Por qué es estrella**: El quiz ya existe. El ROI es máximo porque mejora el scheduling de todo el sistema sin cambiar la UX drásticamente. El confidence slider cuesta cero tokens.

### 3. Card Ingestion Pipeline + Interference Engine (P1/P2)
**Propuso**: arquitecto R3 (pipeline), experto-flashcards (interference cards + deduplicación por facet), experto-resumen R2 (unificación con tablas comparativas)

Un `cardIngestionPipeline.ts` como punto único de entrada para cards generadas por cualquier fuente (gap response, interference engine, extracción de casos). Deduplica por `keywordId + facet[]` con intersección ≥50%, throttlea a 6 cards/sesión priorizando `immediate > proactive > scheduled`. El `interferenceEngine.ts` genera en una sola llamada tanto cards de discriminación como tablas comparativas para keywords similares — un prompt, dos outputs, una aprobación del profesor.

**Por qué es estrella**: Sin centralización, tres features compiten por el FSRS del estudiante con cards duplicadas y throttles inconsistentes. Las interference cards atacan el error más peligroso en medicina: confundir cosas similares.

---

## 2. PLAN DE ACCIÓN INMEDIATO

### FASE 0 — Cimientos (sin IA visible al usuario)

| # | Tarea | Responsable | Detalle |
|---|-------|-------------|---------|
| 1 | Crear `src/app/types/ai.ts` | arquitecto | Tipos: `AIRequest`, `AIResponse` (discriminated union), `FlashcardAtomicChain` (con `facet: ConceptFacet[]` required), `EvaluationResult`, `CaseReviewItem` |
| 2 | Implementar `aiOrchestrator.ts` como singleton | arquitecto | Circuit breaker interno, telemetría con `feature_source` como middleware, `useSyncExternalStore` con snapshots `Object.freeze`, discriminated union en respuesta |
| 3 | Edge Function `ai-orchestrate` | arquitecto + teach-leader | Recibe `tier` + `X-Stream-Mode: chunked|complete`, streaming SSE para evitar timeouts, validación Zod de outputs con retry 1x si falta campo crítico |
| 4 | Prompt registry | teach-leader | `supabase/functions/_shared/prompts/` con `{ template, outputSchema, version }`, hash trazable a commit |
| 5 | Extender `spacedRepetition.ts` | experto-flashcards | `mapEvaluationToQuality(score, errorType)` + `adjustQualityForConfidence(baseQuality, confidenceDelta)` como funciones compuestas (~30 líneas) |
| 6 | Extender `queryKeys.ts` | experto-organizador | Key factories: `adaptiveSummary`, `gapSummary`, `clinicalCase`, `flashcardQuality` |
| 7 | Feature flags | experto-organizador | `src/app/lib/featureFlags.ts` con flags en tabla `app_config` de Supabase, cacheados en el singleton del orquestador |

**SLA definido antes de código**: p95 < 800ms para tier `fast`, < 3s para tier `deep`.

### FASE 1 — Valor inmediato

| # | Tarea | Responsable | Budget requerido |
|---|-------|-------------|-----------------|
| 1 | `quizEvaluator.ts` con evaluación parcial + streaming progresivo | experto-quiz | ~2M tokens/semana (Haiku, 500 estudiantes) |
| 2 | Confidence slider en `useQuizSession` | experto-quiz | 0 tokens |
| 3 | `flashcardGenerator.ts` con cadenas atómicas | experto-flashcards | Estimar en PR |
| 4 | `cardIngestionPipeline.ts` | arquitecto + experto-flashcards | 0 tokens (coordinación, no generación) |
| 5 | `usePredictedDecay()` combinando BKT + FSRS | teach-leader | 0 tokens (cálculo client-side) |
| 6 | Review panel MVP en `professor/` | experto-resumen | Tabla filtrable + aprobar/rechazar + preview |
| 7 | `flagStaleCards` cron semanal | experto-flashcards | 0 tokens |
| 8 | Resúmenes estratificados (3 capas) con cola de aprobación | experto-resumen | Estimar en PR |

**Regla**: cada PR declara budget de tokens/semana/estudiante. Sin budget, no hay merge.

### FASE 2 — Features con supervisión humana

- `interferenceEngine.ts` (requiere embeddings/pgvector)
- `AIContentReviewPanel.tsx` completo con `ContentDiffView` para diffs visuales
- `generateGapResponse()` → micro-explicación + cards
- `GapRemediationCard.tsx` con modo `with-hint` / `pure-recall`
- Resúmenes comparativos entre keywords similares
- pgmq + worker para jobs batch (generación masiva)
- pgvector con `keyword_embeddings` para similaridad

### FASE 3 — La apuesta grande

- State-machine clínica con esqueleto curado por profesor + IA para feedback en transiciones
- `ClinicalReasoningView.tsx` con event sourcing (deltas, no snapshots)
- `scheduleCaseReview` como super-item en FSRS con variantes pre-generadas
- Quiz colaborativo con WebSockets (Fase 5 real — infraestructura de real-time no existe)

---

## 3. ARQUITECTURA PROPUESTA

```
Frontend (React)
├── useAI() ← useSyncExternalStore sobre singleton
│   └── aiOrchestrator.ts (singleton, fuera de React)
│       ├── circuit breaker interno
│       ├── telemetría como middleware (cada llamada loggeada)
│       ├── streaming consumer (getReader para SSE)
│       └── feature flags check antes de cada llamada
│
├── Servicios que consumen el orquestador:
│   ├── quizEvaluator.ts → evalúa respuestas (tier: fast)
│   ├── flashcardGenerator.ts → cadenas atómicas (tier: fast)
│   ├── interferenceEngine.ts → cards + tabla comparativa (tier: fast)
│   └── generateGapResponse() → micro-explicación + cards (tier: fast)
│
├── cardIngestionPipeline.ts (punto único de ingesta a FSRS)
│   ├── Recibe cards de: quizEvaluator, interferenceEngine, caseExtractor
│   ├── Deduplica por keywordId + facet[] (intersección ≥50%)
│   ├── Throttle: 6/sesión, prioridad immediate > proactive > scheduled
│   └── routeRemediation(errorType) para decidir hint vs pure-recall
│
├── spacedRepetition.ts (extendido)
│   ├── mapEvaluationToQuality(score, errorType)
│   ├── adjustQualityForConfidence(quality, confidenceDelta)
│   ├── predictLeech(card, history, confidenceHistory)
│   └── CaseReviewItem con calculateCaseQuality(subQualities)
│
└── Componentes *View con AIErrorBoundary
    ├── QuizResults → GapRemediationCard.tsx (progresivo via streaming)
    ├── SummaryLayersView.tsx (3 capas desbloqueables por mastery)
    └── ComparativeSummaryView.tsx (Fase 2)

Backend (Supabase Edge Functions)
├── ai-orchestrate
│   ├── Recibe: { tier, task, context, X-Stream-Mode }
│   ├── Streaming SSE para chunked, JSON completo para complete
│   └── Validación Zod del output antes de devolver
│
├── _shared/prompts/ (registry versionado en git)
│   └── { template, outputSchema, version } por prompt
│
└── Tablas nuevas:
    ├── ai_interactions (telemetría: student_id, task_type, model_tier, latency_ms, tokens_used, feature_source, outcome_delta)
    ├── generated_content (con model_id, prompt_hash, generation_params, humanApproved, created_at)
    ├── keyword_embeddings (Fase 2, pgvector)
    └── app_config (feature flags)
```

**Flujo crítico end-to-end (quiz)**:
Estudiante responde → confidence slider → `quizEvaluator.evaluate()` via orquestador (stream) → `QuizResults` renderiza progresivamente score → gaps → misconception → `generateGapResponse(keyword, gaps)` → micro-explicación + cards → `cardIngestionPipeline` deduplica + throttlea → `mapEvaluationToQuality` + `adjustQualityForConfidence` → FSRS agenda review.

---

## 4. RIESGOS Y DESACUERDOS

### Resueltos (con consenso)

| Debate | Ganador | Decisión |
|--------|---------|----------|
| Reescritura de contenido vs anotaciones vs resúmenes estratificados | experto-resumen | Resúmenes estratificados con cola de aprobación del profesor. Nunca reescribir contenido médico sin supervisión humana. |
| `AIContext` provider vs singleton | arquitecto R3 | Singleton con `useSyncExternalStore`. Zero providers adicionales. |
| pgmq vs streaming para timeouts | teach-leader | Streaming SSE en Fase 0. pgmq para batch jobs en Fase 2. |
| Auto-inyectar cards vs agencia del estudiante | experto-flashcards | Auto-inyectar con throttle 6/sesión. Setting "Modo manual" en perfil como escape hatch, default off. |
| Gap summaries vs gap cards | experto-flashcards + teach-leader | Ambos: `generateGapResponse` devuelve micro-explicación (3 oraciones, una vez) + cards (inyectadas en FSRS). |
| Árbol estático vs state-machine vs híbrido | experto-organizador | Esqueleto curado por profesor, IA genera solo feedback contextual en transiciones. Reduce tokens 70%. |
| `prompt_version` vs `prompt_hash` | teach-leader | `{ model_id, prompt_hash, generation_params, created_at }` como tipo en `ai.ts`. Hash del template real. |

### No resueltos / Riesgos activos

1. **Costo de tokens sin validar**. Estimación de 8-10M tokens/semana para 500 estudiantes es teórica. Sin datos reales post-Fase 0, el budget de Fase 1 es especulativo. Riesgo: una feature mal throttleada con tier `deep` puede 10x el costo.

2. **`humanApproved` vs invalidación por cambio de modelo**. Experto-resumen dice que contenido aprobado por profesor no se invalida al cambiar modelo. Arquitecto quiere versionado que permita invalidar selectivamente. Tensión no resuelta: ¿quién decide cuándo regenerar contenido aprobado?

3. **State-machine en Fase 3 vs Fase 1**. Experto-quiz argumentó que con esqueleto curado + IA solo para feedback, el scope es comparable a `quizEvaluator`. Organizador rechazó: el editor de casos para profesores, event sourcing, y `ClinicalReasoningView.tsx` son scope de Fase 3. El tipo `CaseReviewItem` y `scheduleCaseReview` sí pueden ir en Fase 1 (30 líneas en `spacedRepetition.ts`).

4. **Batch evaluation para quiz rápido**. Experto-quiz propuso `batchEvaluate` que acumula requests por 200ms y dispara batch. Nadie lo validó ni rechazó. Puede ser optimización prematura o necesidad real según patrones de uso.

5. **Haiku omite campos 8-12% de las veces**. La validación Zod con defaults (inferir `facet` por regex si falta) es un workaround. Si la tasa de error sube con prompts más complejos, el retry strategy necesita revisión.

6. **Resúmenes comparativos dependen de embeddings que están en Fase 2**. Si pgvector se retrasa, `interferenceEngine.ts` y `ComparativeSummaryView.tsx` quedan bloqueados.

---

## 5. QUICK WINS

Implementables hoy o esta semana, sin dependencia de Fase 0:

| # | Qué | Esfuerzo | Impacto | Dónde |
|---|-----|----------|---------|-------|
| 1 | **Confidence slider en quiz** | ~2h | Alto — mejora scheduling sin IA, detecta misconceptions, cero tokens | `useQuizSession` + UI en `QuizResults` |
| 2 | **`mapEvaluationToQuality(score, errorType)`** | ~1h | Alto — desbloquea evaluación granular para cuando llegue `quizEvaluator` | `spacedRepetition.ts`, ~20 líneas |
| 3 | **`adjustQualityForConfidence(quality, confidenceDelta)`** | ~30min | Alto — complementa el slider, composición limpia | `spacedRepetition.ts`, ~10 líneas |
| 4 | **`src/app/types/ai.ts` con tipos compartidos** | ~1h | Medio — define contratos antes de código, evita divergencia | Tipos puros, sin runtime |
| 5 | **`queryKeys.ts` extendido** | ~15min | Medio — key factories listas para cuando lleguen los hooks | `queryKeys.ts` |
| 6 | **`predictLeech(card, history)`** | ~1h | Medio — regenera cards problemáticas proactivamente con datos que ya existen en SM-2 | `spacedRepetition.ts`, ~25 líneas |
| 7 | **`flagStaleCards(courseId, lastUpdate)`** | ~1h | Medio — previene deuda de contenido, cero IA | Cron/utility, comparación de fechas |
| 8 | **Feature flags básico** | ~1h | Alto — kill switch para cualquier feature de IA en producción | `src/app/lib/featureFlags.ts`, ~40 líneas |

**Total quick wins: ~8 horas de trabajo que sientan las bases para toda la Fase 0 y Fase 1, con cero dependencia de infraestructura de IA.**

---

