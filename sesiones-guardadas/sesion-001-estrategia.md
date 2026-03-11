# Sala Estrategia
> Sesion: 10/3/2026, 12:54:25 p.m.
> Tema: Como mejorar la integracion de IA en Axon
> Participantes: arquitecto, teach-leader, experto-quiz
> Calidad: high (opus, esfuerzo: high)

---

## Tema
Como mejorar la integracion de IA en Axon

---

### [12:55:50 p.m.] arquitecto:
Let me explore the codebase first to ground my proposals in what actually exists.

<tool_calls>
<tool_call>
<tool_name>Agent</tool_name>
<tool_input>{"prompt":"Explore the AI-related code in the project: look at src/app/services/ for any AI service files, src/app/hooks/queries/ for AI-related hooks, and any components related to AI or quiz generation. Also check src/app/lib/ for any AI/ML engines. Report file names, key functions, and data structures.","subagent_type":"Explore"}
</tool_input>
</tool_call>
<tool_call>
<tool_name>Agent</tool_name>
<tool_input>{"prompt":"Explore the student-facing components and data flow: look at src/app/components/content/ for View components, src/app/services/spacedRepetition.ts, src/app/lib/fsrs-engine.ts, src/app/lib/bkt-engine.ts, src/app/types/ for key type definitions related to student progress and mastery. Report the key data structures and how student knowledge is tracked.","subagent_type":"Explore"}
</tool_input>
</tool_call>
</tool_calls>

Here are the results:
<tool_results>
<tool_result>
<tool_name>Agent</tool_name>
<output>Here's a comprehensive overview of the AI-related code in the project:

## AI Service Files (`src/app/services/`)

### `aiService.ts`
This is the main AI service file with the following key functions and types:

**Types:**
- `AIQuizConfig` - Configuration for AI quiz generation with fields: `topicId`, `subtopicId`, `difficulty`, `questionCount`, `questionTypes`, `focusAreas`, `studentContext`
- `AIFeedbackRequest` - Request for AI feedback with: `questionId`, `studentAnswer`, `correctAnswer`, `questionContext`, `studentLevel`
- `AIStudyRecommendation` - Recommendation structure with: `topicId`, `priority`, `reason`, `suggestedActivities`, `estimatedTime`
- `AIQuizQuestion` - Generated question with: `question`, `options`, `correctAnswer`, `explanation`, `difficulty`, `type`, `relatedKeywords`
- `AIFeedbackResponse` - Feedback response with: `isCorrect`, `feedback`, `detailedExplanation`, `relatedConcepts`, `encouragement`, `masteryImpact`

**Functions:**
- `generateAIQuiz(config: AIQuizConfig)` - Generates quiz using AI via POST to `/ai/generate-quiz`
- `getAIFeedback(request: AIFeedbackRequest)` - Gets personalized feedback via POST to `/ai/feedback`
- `getStudyRecommendations(studentId: string)` - Gets study recommendations via POST to `/ai/recommendations`
- `generateExplanation(keywordId: string, studentLevel: string)` - Generates adaptive explanations via POST to `/ai/explain`
- `analyzeStudentPerformance(studentId: string, timeRange?: string)` - Analyzes performance via POST to `/ai/analyze-performance`

### `quizService.ts`
Contains quiz-related service functions:
- `fetchQuizQuestions(params)` - Fetches quiz questions from backend
- `submitQuizAnswer(params)` - Submits quiz answers
- `getQuizResults(quizId)` - Gets quiz results

## AI-Related Hooks (`src/app/hooks/queries/`)

### `useAIQuiz.ts`
Contains hooks for AI quiz functionality:
- `useGenerateAIQuiz` - TanStack mutation hook wrapping `generateAIQuiz`
- `useAIFeedback` - Hook for getting AI feedback on answers
- `useStudyRecommendations(studentId)` - Query hook for fetching study recommendations
- Uses query keys from `queryKeys.ts`

### `queryKeys.ts`
Contains AI-related query keys:
- `queryKeys.ai.quiz` - For AI quiz generation
- `queryKeys.ai.feedback` - For AI feedback
- `queryKeys.ai.recommendations(studentId)` - For study recommendations
- `queryKeys.ai.explanation(keywordId)` - For AI explanations

## AI/ML Engines (`src/app/lib/`)

### `fsrs-engine.ts`
Free Spaced Repetition Scheduler implementation:
- `FSRSEngine` class with methods for calculating review intervals
- Uses the FSRS-5 algorithm parameters
- Key methods: `review(card, rating)`, `calculateStability()`, `calculateDifficulty()`
- Card states: New, Learning, Review, Relearning

### `bkt-engine.ts`
Bayesian Knowledge Tracing engine:
- `BKTEngine` class implementing the BKT algorithm
- Parameters: `pInit` (initial knowledge), `pLearn` (learning rate), `pGuess`, `pSlip`
- Key methods: `update(isCorrect)`, `getMastery()`, `predictCorrect()`
- Used for tracking per-keyword mastery probability

### Other relevant files in `src/app/lib/`:
- `adaptive-engine.ts` - Adaptive difficulty engine that combines FSRS and BKT signals to adjust quiz difficulty dynamically

## AI-Related Components

### `src/app/components/content/quiz/`
- `QuizView.tsx` - Main quiz view component
- `QuizResults.tsx` - Results display with AI feedback integration
- `QuizQuestion.tsx` - Individual question component
- `AdaptiveQuizFlow.tsx` - Adaptive quiz flow using AI difficulty adjustment
- `useQuizSession.ts` - Hook managing quiz session state

### `src/app/components/content/`
- `KeywordDetailView.tsx` - Shows keyword details, may include AI explanations
- `StudyRecommendationsView.tsx` - Displays AI-generated study recommendations

No direct model specifications (like "GPT-4" or "Claude") were found in the frontend code - the AI model selection appears to be handled on the backend (Supabase Edge Functions).
</output>
</tool_result>
<tool_result>
<tool_name>Agent</tool_name>
<output>Here's a comprehensive overview of the student-facing components and data flow:

## Student View Components (`src/app/components/content/`)

### Key View Components:
- **`DashboardView.tsx`** - Main student dashboard showing progress overview, recent activity, and quick actions
- **`CourseView.tsx`** - Course overview with topics listing
- **`TopicView.tsx`** - Topic detail view with subtopics and progress
- **`SubtopicView.tsx`** - Individual subtopic content display
- **`KeywordDetailView.tsx`** - Detailed keyword view with mastery info and explanations
- **`StudyView.tsx`** - Study session interface
- **`QuizView.tsx`** - Quiz taking interface (in `quiz/` subdirectory)
- **`WelcomeView.tsx`** - Onboarding/welcome screen
- **`StudyRecommendationsView.tsx`** - AI-powered study recommendations display
- **`ProgressView.tsx`** - Detailed progress analytics view

## Spaced Repetition (`src/app/services/spacedRepetition.ts`)

### Key Types:
- **`ReviewCard`**: `{ id, keyword_id, easeFactor, interval, repetitions, nextReview, lastReview, lapses }`
- **`ReviewRating`**: Enum with values `Again = 1, Hard = 2, Good = 3, Easy = 4`
- **`ReviewResult`**: `{ card: ReviewCard, nextReview: Date, interval: number }`

### Key Functions:
- **`calculateNextReview(card, rating)`** - SM-2 algorithm implementation that calculates next review date
- **`getCardsForReview(cards, date?)`** - Filters cards due for review
- **`initializeCard(keywordId)`** - Creates a new review card
- **`getDueCardCount(cards)`** - Returns count of cards due today

### SM-2 Algorithm Parameters:
- Minimum ease factor: 1.3
- Default ease factor: 2.5
- Initial intervals: 1 day, 6 days for first repetitions
- Ease factor adjustments based on rating

## FSRS Engine (`src/app/lib/fsrs-engine.ts`)

### Key Structure:
- **`FSRSCard`**: `{ due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, state }`
- **`FSRSState`** enum: `New, Learning, Review, Relearning`
- **`FSRSRating`** enum: `Again = 1, Hard = 2, Good = 3, Easy = 4`

### Key Methods:
- `review(card, rating, now?)` - Process a review and return updated card + scheduling
- Internal: stability/difficulty calculations using FSRS-5 parameters (19 optimized weights)
- Retrievability calculation: `Math.pow(1 + elapsed / (9 * stability), -1)`

## BKT Engine (`src/app/lib/bkt-engine.ts`)

### Key Structure:
- **`BKTParams`**: `{ pInit, pLearn, pGuess, pSlip }` - all probabilities 0-1
- **`BKTState`**: `{ pKnown, history: boolean[] }`

### Key Methods:
- `update(state, isCorrect, params?)` - Bayesian update of knowledge probability
- `getMastery(state)` - Returns current mastery probability (0-1)
- `predictCorrect(state, params?)` - Predicts probability of correct response
- `isLearned(state, threshold?)` - Whether mastery exceeds threshold (default 0.95)

### Default Parameters:
- `pInit: 0.3` (prior knowledge probability)
- `pLearn: 0.1` (learning rate per opportunity)  
- `pGuess: 0.25` (probability of correct guess)
- `pSlip: 0.1` (probability of incorrect despite knowing)

## Key Type Definitions (`src/app/types/`)

### Student-Related Types:
- **`Student`**: `{ id, user_id, first_name, last_name, email, career, semester, university, avatar_url, created_at }`
- **`StudentProgress`**: `{ student_id, course_id, topic_id, subtopic_id, keyword_id, mastery_level, review_count, last_reviewed, next_review, streak }`
- **`StudentStats`**: `{ total_keywords, mastered_keywords, in_progress_keywords, weak_keywords, study_streak, total_study_time, quizzes_completed, average_score }`

### Content Types:
- **`Course`**: `{ id, name, description, icon, color, topic_count }`
- **`Topic`**: `{ id, course_id, name, description, order, subtopic_count }`
- **`Subtopic`**: `{ id, topic_id, name, description, order, keyword_count }`
- **`Keyword`**: `{ id, subtopic_id, term, definition, explanation, examples, related_keywords, mastery_level?, review_data? }`

### Mastery Color Coding (from components):
- **Red** (`text-red-500`): mastery < 0.4
- **Yellow** (`text-yellow-500`): mastery 0.4 - 0.7  
- **Green** (`text-green-500`): mastery > 0.7
- Hysteresis applied to prevent flickering between states

### Knowledge Tracking Flow:
1. Student interacts with keywords (study, quiz)
2. `spacedRepetition.ts` (SM-2) calculates review scheduling
3. `bkt-engine.ts` updates mastery probability per keyword
4. `fsrs-engine.ts` provides alternative scheduling with stability tracking
5. `adaptive-engine.ts` combines signals for quiz difficulty adjustment
6. `StudentProgress` records are updated via backend calls
7. `StudentDataContext` provides cached student data to components
8. Dashboard and Progress views render mastery visualization
</output>
</tool_result>
</tool_results>

## Mi perspectiva como Arquitecto — Sala Estrategia

Conozco la base de código. Aquí van mis propuestas, de más práctica a más audaz:

---

### 1. "Tutor Socrático" en tiempo real — `KeywordDetailView.tsx`

En vez de mostrar explicaciones estáticas, insertar un componente `<SocraticChat>` dentro de `KeywordDetailView`. El estudiante ve la definición del keyword, pero puede hacer preguntas. El truco: el endpoint `/ai/explain` ya existe en `aiService.ts`, pero solo devuelve texto plano. Propongo cambiar `generateExplanation()` para que acepte un array de `messages` (historial conversacional) y el `BKTState` actual del keyword. Si `pKnown < 0.4`, el modelo responde con analogías simples; si `> 0.7`, responde con casos clínicos complejos. Modelo: Claude Haiku 4.5 para latencia baja. Entrada: `{ keywordId, bktState, messages[] }`. Salida: `{ response, relatedKeywordIds[], suggestedNextAction }`.

---

### 2. "Radiografía de Errores" — Repensar `QuizResults.tsx`

Actualmente `AIFeedbackResponse` devuelve feedback por pregunta. Propongo un análisis **transversal**: un nuevo endpoint `/ai/error-pattern` que reciba los últimos 50 intentos del estudiante (de `StudentProgress`) y detecte **patrones de error**, no errores individuales. Ejemplo: "Confundes consistentemente fármacos antagonistas con agonistas parciales — esto sugiere un gap conceptual en receptología". El componente `QuizResults` mostraría un panel `<ErrorPatternCard>` con estos insights. Datos de entrada: `{ studentId, recentAttempts[], keywordMasteryMap }`. Modelo: Claude Sonnet 4.6 (necesita razonamiento más profundo).

---

### 3. "Modo Residencia" — Simulación de guardia hospitalaria

Esto es lo audaz. Un nuevo view `ResidencySimView.tsx` que presente **escenarios clínicos secuenciales** donde cada decisión afecta el siguiente escenario. Usa `adaptive-engine.ts` para seleccionar la dificultad, pero en vez de preguntas aisladas, el estudiante recibe un paciente virtual con historia clínica evolutiva. Cada paso consulta `/ai/generate-quiz` con un `AIQuizConfig` modificado que incluya `scenarioContext` (estado actual del paciente) y `previousDecisions[]`. El BKT se actualiza por **competencia clínica** (un keyword compuesto), no por keyword individual. Esto requiere un nuevo tipo `ClinicalCompetency` en `src/app/types/` que agrupe keywords relacionados. Visualmente: tarjetas estilo expediente médico, con la tipografía Georgia para encabezados clínicos y transiciones `motion` que simulen el paso del tiempo entre eventos.

---

### 4. "Spaced Repetition Predictiva" — Fusionar FSRS + BKT + IA

Tenemos tres engines (`spacedRepetition.ts`, `fsrs-engine.ts`, `bkt-engine.ts`) operando semi-independientes. Propongo un nuevo servicio `intelligentScheduler.ts` que alimente los tres estados a un endpoint `/ai/optimize-schedule`. El modelo recibe: `{ fsrsStability, bktPKnown, sm2EaseFactor, studentStudyPatterns }` y devuelve intervalos optimizados que ningún algoritmo individual calcularía. Modelo: Claude Haiku 4.5 (decisión rápida). El hook `useStudyRecommendations` en `useAIQuiz.ts` consumiría este scheduler en lugar de recomendaciones genéricas.

---

### 5. Generación de contenido por profesores con IA

Un componente `<AIContentAssistant>` dentro de `src/app/components/professor/` que permita al profesor pegar un fragmento de paper o guía clínica y genere automáticamente: keywords con definiciones, preguntas de quiz, y relaciones entre conceptos. Endpoint: `/ai/content-from-source`. Entrada: texto libre + `courseId`. Salida: `{ keywords[], quizQuestions[], conceptMap }`. Esto reduce la barrera de entrada para poblar la plataforma.

---

### [12:56:28 p.m.] teach-leader:
## Respuesta como Teach-Leader — Ronda 1

Arquitecto, hay oro aquí pero también trampas. Voy propuesta por propuesta.

---

**1. Tutor Socrático — Sí, pero con guardarraíles.** El instinto de condicionar la respuesta al `bktPKnown` es correcto. Pero hay un riesgo pedagógico serio: si el modelo "regala" la respuesta ante `pKnown < 0.4`, el estudiante nunca cruza el umbral. Propongo que `<SocraticChat>` tenga un **modo andamiaje** con 3 niveles de pista antes de revelar. El endpoint no devuelve `response` directo sino `{ hint1, hint2, fullExplanation, scaffoldLevel }`. El componente renderiza progresivamente. Además, cada interacción en el chat debe generar un `BKTEngine.update()` implícito — si el estudiante formula bien la pregunta, eso es señal de conocimiento parcial. Nadie está midiendo las *preguntas* del estudiante, solo sus respuestas.

**2. Radiografía de Errores — La mejor propuesta.** Esto ataca el problema real: los estudiantes de medicina fallan en *patrones*, no en hechos aislados. Pero desafío el modelo elegido: Sonnet 4.6 para cada análisis post-quiz es caro y lento. Propongo pre-computar los patrones con un batch job nocturno vía `/ai/error-pattern-batch` y cachear en `StudentDataContext`. El componente `<ErrorPatternCard>` consume datos pre-calculados; solo cuando el estudiante pide "explicar más" se invoca Sonnet en tiempo real. Esto reduce costos 10x y mejora UX. El hook sería `useErrorPatterns(studentId)` en `queryKeys.ai.errorPatterns(studentId)` con `staleTime: 24h`.

**3. Modo Residencia — Demasiado pronto.** No porque la idea sea mala, sino porque no tenemos el tipo `ClinicalCompetency` ni la estructura de datos para escenarios encadenados. Antes de construir `ResidencySimView.tsx`, necesitamos que los profesores hayan mapeado qué keywords forman cada competencia clínica. Eso es la propuesta 5. **El orden correcto es: 5 → 3.** Sin contenido estructurado por competencias, la IA generará escenarios genéricos que los profesores rechazarán.

**4. Scheduler unificado — Innecesario usar IA aquí.** Tenemos tres algoritmos determinísticos bien estudiados. Usar Claude Haiku para interpolar entre FSRS, BKT y SM-2 es como usar un bisturí láser para cortar pan. Propongo en su lugar un `intelligentScheduler.ts` que sea un **ensemble determinístico**: peso ponderado configurable entre los tres engines, sin llamada a API. Reservemos los tokens de IA para donde realmente aportan — comprensión de lenguaje natural y generación de contenido.

**5. Content Assistant para profesores — Alto impacto, prioridad uno.** Pero falta algo crítico: **validación humana en el loop**. El flujo debe ser: profesor pega texto → IA genera draft → profesor revisa/edita en una UI tipo `<ContentReviewEditor>` → solo entonces se persiste. El endpoint devuelve `status: 'draft'` y necesita un `PUT /ai/content-approve` explícito. Sin esto, entrará contenido erróneo al sistema y los estudiantes aprenderán mal. En medicina eso no es un bug, es un riesgo ético.

---

**Mi propuesta nueva: "Evaluación Formativa Continua"**

Nadie ha mencionado evaluar *durante* el estudio, no solo en quizzes. En `SubtopicView.tsx` y `KeywordDetailView.tsx`, insertar micro-checkpoints invisibles: después de leer 30 segundos, aparece una pregunta de verificación de 1 click (tipo "¿Cuál de estos es correcto?"). Esto alimenta `BKTEngine` con datos **10x más frecuentes** sin fricción percibida. Hook: `useMicroAssessment(keywordId)`, endpoint: `/ai/micro-check`. Modelo: Haiku, una sola pregunta, latencia < 500ms.

---

