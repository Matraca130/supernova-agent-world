# Prompts de Accion — v4
> 10/3/2026, 2:14:26 p.m.
> Tema: Como mejorar la integracion de IA en Axon

---

# PROMPTS POR AGENTE — Integración IA en Axon

---

## EXPERTO-ORGANIZADOR

Tu tarea es implementar **PR-1 (tipos fundacionales)** y co-implementar **PR-2 (EventBus + batch endpoint)**. Eres el owner de la infraestructura que alimenta todo el sistema de IA.

### PR-1 — Tipos Fundacionales

Crea estos archivos exactos:

**`src/app/types/learningEvent.ts`**
```typescript
export type EventType = 'quiz-answer' | 'flashcard-review' | 'content-view' | 'topic-complete' | 'session-start' | 'session-end';

export interface LearningEvent {
  id?: string;
  studentId: string;
  courseId: string;
  keywordId: string | null;
  eventType: EventType;
  sessionId: string;
  responseTimeMs: number | null;
  confidenceLevel: number | null;       // slider explícito (0-1), solo metacognitivo
  impliedConfidence: number | null;     // calculado por confidenceInference.ts
  eliminatedOptions: string[];
  answerChanges: number;
  correct: boolean | null;
  metadata: Record<string, unknown>;
  affectsScheduling: boolean;
  createdAt: string;
}
```

**`src/app/types/aiAction.ts`**
```typescript
export type AIAction = 'review-keyword' | 'attempt-quiz' | 'synthesis-flashcard' | 'take-break' | 'escalate-professor';
```

**`src/app/types/aiContract.ts`**
```typescript
import type { LearningEvent } from './learningEvent';

export interface LearningContext {
  studentId: string;
  courseId: string;
  recentEvents: LearningEvent[];
  keywordMasteries: Record<string, number>;
  confusionEdges: { keywordA: string; keywordB: string; coErrorCount: number }[];
  archetype: 'cramming' | 'steady' | 'coasting' | 'struggling' | 'cold-start';
}

export interface DigestResponse { strength: string[]; attention: string[]; pattern: string; nextAction: AIAction; }
export interface DeckResponse { cards: import('./flashcard').FlashcardUnion[]; }
export interface ProbeResponse { question: string; options: string[]; targetKeywords: string[]; }
```

**`src/app/hooks/queries/queryKeys.ts`** — Agrega al archivo existente:
```typescript
ai: {
  digest: (courseId: string) => ['ai', 'digest', courseId] as const,
  flashcardsDeck: (courseId: string) => ['ai', 'flashcards', 'deck', courseId] as const,
  probes: (keywordId: string) => ['ai', 'probes', keywordId] as const,
  recommendation: (studentId: string) => ['ai', 'recommendation', studentId] as const,
  confusionGraph: (courseId: string) => ['ai', 'confusionGraph', courseId] as const,
},
```

Crea barrel export en **`src/app/types/ai.ts`**: re-exporta todo desde `learningEvent`, `aiAction`, `aiContract`.

### PR-2 — EventBus (co-autoría con Quiz)

**`src/app/lib/eventBus.ts`**: Clase singleton que: (1) recibe `LearningEvent`, (2) almacena en buffer IndexedDB vía `idb-keyval`, (3) cada 30s o al alcanzar 20 eventos, flushea a endpoint. Usa `navigator.sendBeacon` como fallback en `beforeunload`.

**`src/app/services/eventService.ts`**: Función `flushEvents(events: LearningEvent[]): Promise<void>` que llama `POST /events/batch` vía `api.ts`. Headers: `Authorization: Bearer <ANON_KEY>`, `X-Access-Token: <jwt>`. Body: `{ events: LearningEvent[] }`. Response: `{ accepted: number }`.

### Orden
1. PR-1: tipos + queryKeys → `npx tsc --noEmit` pasa
2. PR-2: eventBus + service + IndexedDB buffer

### Done
- [ ] `npx tsc --noEmit` sin errores
- [ ] Tipos importables desde `@/app/types/ai`
- [ ] EventBus persiste en IndexedDB y flushea correctamente
- [ ] `import { queryKeys } from '@/app/hooks/queries/queryKeys'` incluye `ai.*`

---

## EXPERTO-QUIZ

Tu tarea es implementar **`confidenceInference.ts`** (co-autoría PR-2) y alimentar el **ConfusionGraph** con datos de co-error desde quizzes existentes.

### PR-2 (tu parte) — Inferencia de Confianza

**`src/app/lib/confidenceInference.ts`**:
```typescript
import type { LearningEvent } from '@/app/types/ai';

interface RawSignals {
  responseTimeMs: number;
  expectedTimeMs: number;       // heurística: MCQ=45000, clinicalCase=90000, imageId=30000
  answerChanges: number;
  eliminatedOptions: string[];
  totalOptions: number;
  correct: boolean;
}

export function inferConfidence(signals: RawSignals): number {
  // Retorna 0-1. Algoritmo:
  // 1. timeRatio = responseTimeMs / expectedTimeMs → sigmoid invertida (rápido=confiado)
  // 2. changePenalty = min(answerChanges * 0.15, 0.45)
  // 3. eliminationBonus = eliminatedOptions.length > 0 ? 0.1 : 0 (eliminó=razonó)
  // 4. correctBonus = correct ? 0.2 : -0.2
  // 5. raw = 0.5 + (1 - sigmoid(timeRatio)) * 0.3 - changePenalty + eliminationBonus + correctBonus
  // 6. return clamp(raw, 0, 1)
}
```

Integra `inferConfidence` en el flujo de quiz existente. Localiza el handler de respuesta en `src/app/components/content/` (busca componentes con `*QuizView*` o `*Quiz*`). Después de que el estudiante responde:

1. Calcula `impliedConfidence` con las señales capturadas
2. Muestra slider de confianza explícita (1-5 mapeado a 0-1) — post-respuesta, no antes
3. Emite evento vía `eventBus.emit({ ...event, impliedConfidence, confidenceLevel })`

**`src/app/lib/expectedTime.ts`**:
```typescript
export const EXPECTED_TIME_MS: Record<string, number> = {
  MCQ: 45_000,
  clinicalCase: 90_000,
  imageIdentification: 30_000,
  trueFalse: 20_000,
};
```

### Decisión pendiente D5
Verifica si el modelo de quiz actual tiene `expectedTimeMs`. Busca en `src/app/types/` archivos relacionados con quiz/question. Si no existe, usa la heurística de arriba.

### Alimentación del ConfusionGraph
Cuando un estudiante responde incorrectamente, identifica el `keywordId` correcto y el `keywordId` que el distractor representaba. Emite un `LearningEvent` con `metadata: { selectedDistractorKeyword }`. Esto es lo que PR-3 (ConfusionGraph) consumirá para calcular `co_error_count`.

### Orden
1. `confidenceInference.ts` + `expectedTime.ts` (puro, sin dependencias UI)
2. Integración en quiz UI existente + slider post-respuesta
3. Emisión de eventos con `eventBus`

### Done
- [ ] `inferConfidence()` retorna 0-1 para todos los edge cases (respuesta instantánea, timeout, sin eliminaciones)
- [ ] Slider de confianza visible post-respuesta, valor guardado en `confidenceLevel`
- [ ] Cada respuesta de quiz emite `LearningEvent` completo vía EventBus
- [ ] `metadata.selectedDistractorKeyword` presente en respuestas incorrectas
- [ ] `npx tsc --noEmit` pasa

---

## EXPERTO-FLASHCARDS

Tu tarea es implementar **PR-4: Sistema de Flashcards Polimórficas** — 7 tipos de card con union discriminado, 4 factories determinísticas que funcionan sin IA, y la tabla SQL.

### Tipos — `src/app/types/flashcard.ts`
```typescript
export type CardType =
  | 'cloze' | 'differential' | 'reversal' | 'image-occlusion'  // determinísticos
  | 'clinical-scenario' | 'mechanism-chain' | 'vertical-integration'; // IA

interface CardBase {
  id: string;
  courseId: string;
  keywordId: string;
  cardType: CardType;
  createdAt: string;
  source: 'template' | 'ai-generated';
  fsrsState: { stability: number; difficulty: number; lastReview: string | null; nextReview: string; reps: number };
}

export interface ClozeCard extends CardBase { cardType: 'cloze'; cardData: { sentence: string; blanks: { index: number; answer: string }[] } }
export interface DifferentialCard extends CardBase { cardType: 'differential'; cardData: { keywordA: string; keywordB: string; sharedFeatures: string[]; distinctFeatures: { a: string[]; b: string[] }; coErrorCount: number } }
export interface ReversalCard extends CardBase { cardType: 'reversal'; cardData: { term: string; definition: string; direction: 'term→def' | 'def→term' } }
export interface ImageOcclusionCard extends CardBase { cardType: 'image-occlusion'; cardData: { imageUrl: string; regions: { x: number; y: number; w: number; h: number; label: string }[] } }
export interface ClinicalScenarioCard extends CardBase { cardType: 'clinical-scenario'; cardData: { vignette: string; question: string; options: string[]; correctIndex: number; explanation: string } }
export interface MechanismChainCard extends CardBase { cardType: 'mechanism-chain'; cardData: { steps: string[]; missingStepIndex: number } }
export interface VerticalIntegrationCard extends CardBase { cardType: 'vertical-integration'; cardData: { basicScience: string; clinicalApplication: string; question: string; answer: string } }

export type FlashcardUnion = ClozeCard | DifferentialCard | ReversalCard | ImageOcclusionCard | ClinicalScenarioCard | MechanismChainCard | VerticalIntegrationCard;
```

### Factories — `src/app/lib/flashcard-generator.ts`
```typescript
import type { FlashcardUnion } from '@/app/types/flashcard';

export function generateClozeCard(keywordId: string, sentence: string, answers: string[]): ClozeCard { /* ... */ }
export function generateDifferentialCard(keywordA: string, keywordB: string, confusionEdge: ConfusionEdge): DifferentialCard { /* ... */ }
export function generateReversalCard(keywordId: string, term: string, definition: string): ReversalCard { /* ... */ }
export function generateImageOcclusionCard(keywordId: string, imageUrl: string, regions: Region[]): ImageOcclusionCard { /* ... */ }
```

`DifferentialCard` es la **killer feature**: consume `confusion_edges` de PR-3 para generar cards que atacan exactamente los pares de conceptos que el estudiante confunde.

### Decisiones pendientes antes de implementar
- **D2**: Revisa `src/app/components/content/` — ¿existe UI de flashcards? Si es greenfield, el esfuerzo sube a L.
- **D3**: Revisa `src/app/lib/fsrs-engine.ts` — ¿opera card-level o keyword-level? Si keyword-level, crea adapter `fsrsState` por card en el tipo `CardBase`.

### Hook — `src/app/hooks/queries/useFlashcardDeck.ts`
Usa `queryKeys.ai.flashcardsDeck(courseId)`, `staleTime: 5 * 60_000`. Fetches desde service, fallback a factories determinísticas si `shouldCallAI() === false`.

### Orden
1. `flashcard.ts` (tipos) — depende de PR-1
2. `flashcard-generator.ts` (4 factories determinísticas)
3. `useFlashcardDeck.ts` (hook React Query)
4. UI components (si no existen — verificar D2 primero)

### Done
- [ ] `FlashcardUnion` discrimina por `cardType` con exhaustive check
- [ ] 4 factories generan cards válidas con datos estáticos de `src/app/data/`
- [ ] `DifferentialCard` consume `confusion_edges` (mockeable hasta PR-3)
- [ ] `fsrsState` en cada card con valores iniciales sensatos
- [ ] `npx tsc --noEmit` pasa

---

## EXPERTO-RESUMEN

Tu tarea es implementar **PR-5: InsightDigest** — la interfaz visible de toda la IA. Al abrir la app, el estudiante ve un digest de 4 secciones fijas con fallback determinístico para cold-start.

### Tipo — `src/app/types/insightDigest.ts`
```typescript
import type { AIAction } from './aiAction';

export interface InsightDigest {
  strength: { keywords: string[]; message: string };
  attention: { keywords: string[]; confusions: { a: string; b: string }[]; message: string };
  pattern: { archetype: 'cramming' | 'steady' | 'coasting' | 'struggling' | 'cold-start'; description: string };
  nextAction: { action: AIAction; label: string; route: string };
  generatedAt: string;
  source: 'deterministic' | 'ai';
}
```

### Fallback determinístico — `src/app/lib/digest-builder.ts`
```typescript
import type { InsightDigest } from '@/app/types/insightDigest';
import type { LearningEvent } from '@/app/types/ai';

export function buildDeterministicDigest(
  events: LearningEvent[],
  keywordMasteries: Record<string, number>,
  confusionEdges: { keywordA: string; keywordB: string; coErrorCount: number }[]
): InsightDigest {
  // Si events.length < 10 → archetype: 'cold-start'
  //   strength: { keywords: [], message: "Aún estamos conociéndote..." }
  //   attention: { keywords: [], confusions: [], message: "Completa algunos quizzes para ver insights" }
  //   pattern: { archetype: 'cold-start', description: "Necesitamos más datos" }
  //   nextAction: { action: 'attempt-quiz', label: 'Hacer tu primer quiz', route: '/student/quiz' }
  //
  // Si events.length >= 10 → calcular:
  //   strength: top 5 keywords con mastery > 0.7
  //   attention: bottom 5 keywords + top 3 confusion_edges por coErrorCount
  //   pattern: clasificar por heurística (ver learner-profile.ts de PR-6)
  //   nextAction: UNA sola acción, la más impactante
}
```

**Regla crítica**: `nextAction` es UNA sola acción, nunca una lista. El estudiante no debe elegir — el sistema le dice qué hacer.

### Hook — `src/app/hooks/queries/useInsightDigest.ts`
```typescript
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import { buildDeterministicDigest } from '@/app/lib/digest-builder';

export function useInsightDigest(courseId: string) {
  return useQuery({
    queryKey: queryKeys.ai.digest(courseId),
    queryFn: async () => {
      // Fase 2: intentar endpoint /ai-generate-digest
      // Fase 1: siempre fallback determinístico
      return buildDeterministicDigest(events, masteries, edges);
    },
    staleTime: 30 * 60_000,   // 30 min — no refetch agresivo
    gcTime: 60 * 60_000,
  });
}
```

### UI Component — `src/app/components/content/InsightDigestView.tsx`
4 secciones fijas como cards. Usa convenciones del proyecto: `rounded-2xl shadow-sm` white cards, iconos `bg-teal-50 text-teal-500`, títulos en Georgia serif, body en Inter. Animaciones con `motion` (`import { motion } from 'motion/react'`). Botones `rounded-full` teal para `nextAction`.

### Orden
1. `insightDigest.ts` (tipo) — depende de PR-1
2. `digest-builder.ts` (fallback determinístico)
3. `useInsightDigest.ts` (hook)
4. `InsightDigestView.tsx` (UI)

### Done
- [ ] Cold-start (<10 eventos) muestra digest honesto, no inventado
- [ ] Con datos suficientes, `strength` y `attention` reflejan datos reales
- [ ] `nextAction` es siempre UNA acción con `route` navegable
- [ ] `staleTime: 30min` — no spam al servidor
- [ ] UI sigue design system: Georgia títulos, Inter body, teal primary, `rounded-2xl` cards
- [ ] `npx tsc --noEmit` pasa

---

## ARQUITECTO

Tu tarea es implementar **PR-3 (ConfusionGraph)** y **PR-6 (Learner Profile + AI Orchestrator)**. Eres el owner de la lógica de inferencia y orquestación.

### PR-3 — ConfusionGraph

**`src/app/lib/confusionGraph.ts`**:
```typescript
export interface ConfusionEdge {
  courseId: string;
  keywordA: string;
  keywordB: string;
  studentId: string | null;    // null = población
  coErrorCount: number;
  populationCount: number;
  updatedAt: string;
}

export function mergePersonalAndPopulation(
  personal: ConfusionEdge[],
  population: ConfusionEdge[],
  minPersonalEvents: number = 5
): ConfusionEdge[] {
  // Si personal tiene < minPersonalEvents edges → usar population como fallback
  // Si personal tiene suficientes → priorizar personal, enriquecer con population
  // Retornar top 20 edges ordenados por coErrorCount descendente
}
```

**`src/app/services/confusionGraphService.ts`**: Llama `GET /confusion-graph?courseId={id}` vía `api.ts`. Response: `{ personal: ConfusionEdge[], population: ConfusionEdge[] }`.

**`src/app/hooks/queries/useConfusionGraph.ts`**: `queryKey: queryKeys.ai.confusionGraph(courseId)`, `staleTime: 10 * 60_000`.

**Decisión D4**: Revisa `src/app/data/` para identificar keywords exactos por curso — necesarios para validar edges.

### PR-6 — Learner Profile + AI Orchestrator

**`src/app/lib/learner-profile.ts`**:
```typescript
import type { LearningEvent } from '@/app/types/ai';

export type Archetype = 'cramming' | 'steady' | 'coasting' | 'struggling' | 'cold-start';

export function classifyLearner(events: LearningEvent[], dayWindow: number = 14): Archetype {
  if (events.length < 10) return 'cold-start';
  // cramming: >60% de eventos en últimas 48h antes de sesión intensa
  // steady: distribución uniforme de eventos a lo largo de dayWindow
  // coasting: mastery alta pero frecuencia de estudio decreciente
  // struggling: mastery baja + alta frecuencia = esfuerzo sin resultado
}
```

**`src/app/lib/ai-orchestrator.ts`**:
```typescript
import type { LearningContext } from '@/app/types/aiContract';
import { classifyLearner } from './learner-profile';

export function shouldCallAI(eventsCount: number, archetype: Archetype): boolean {
  if (archetype === 'cold-start') return false;
  if (eventsCount < 30) return false;
  return true;
}

export async function orchestrate(context: LearningContext): Promise</* endpoint-specific response */> {
  // Facade: decide qué endpoint llamar basándose en archetype + datos disponibles
  // Si shouldCallAI=false → retorna resultado de templates/heurísticas locales
  // Si shouldCallAI=true → llama endpoint especializado vía service
}
```

**Decisión D1**: Revisa `src/app/lib/bkt-engine.ts` — ¿expone `pKnown` per-keyword? Si no, usa solo FSRS per-keyword en el orchestrator.

### Orden
1. PR-3: `confusionGraph.ts` → service → hook (depende PR-1)
2. PR-6: `learner-profile.ts` → `ai-orchestrator.ts` (depende PR-1 + PR-2)

### Done
- [ ] `mergePersonalAndPopulation()` prioriza datos personales, fallback a población
- [ ] `classifyLearner()` retorna los 5 arquetipos correctamente
- [ ] `shouldCallAI()` retorna `false` para cold-start — cero gasto IA
- [ ] `orchestrate()` es facade pura — no lógica de negocio, solo routing
- [ ] `npx tsc --noEmit` pasa

---

## TEACH-LEADER

Tu tarea es **coordinar la ejecución de PR-1 a PR-7**, resolver bloqueos entre agentes, y garantizar la coherencia del sistema completo.

### Responsabilidades

1. **Revisar PR-1 antes de merge**: Verificar que `LearningEvent`, `AIAction`, `LearningContext` son consistentes. Que `queryKeys.ai.*` no colisiona con keys existentes en `src/app/hooks/queries/queryKeys.ts`. Que los tipos son importables desde `@/app/types/ai`.

2. **Coordinar dependencias**:
   ```
   PR-1 (Organizador) → bloquea todo
   PR-2 (Organizador+Quiz) → depende PR-1 → bloquea PR-5, PR-6
   PR-3 (Arquitecto+Quiz) ──┐
   PR-4 (Flashcards)       ──┤ paralelos, dependen PR-1
   PR-5 (Resumen)           → depende PR-1 + PR-2
   PR-6 (Arquitecto)        → depende PR-1 + PR-2
   PR-7 (Todos)             → depende PR-3 + PR-4 + PR-5 + PR-6
   ```

3. **Resolver decisiones pendientes**:
   - D1: Pedir a Arquitecto que revise `src/app/lib/bkt-engine.ts` y reporte si `pKnown` es per-keyword
   - D2: Pedir a Flashcards que revise `src/app/components/content/` y reporte si hay UI de flashcards
   - D3: Pedir a Flashcards que revise `src/app/lib/fsrs-engine.ts` y reporte nivel de operación
   - D5: Pedir a Quiz que busque `expectedTimeMs` en `src/app/types/`

4. **Verificar coherencia de contratos**: Cuando PR-3 y PR-4 se abren en paralelo, verificar que `ConfusionEdge` en `confusionGraph.ts` (Arquitecto) es compatible con `DifferentialCard.cardData` en `flashcard.ts` (Flashcards). Los campos `keywordA`, `keywordB`, `coErrorCount` deben coincidir exactamente.

5. **Barrel export final**: Después de Fase 2, crear `src/app/lib/ai/index.ts` que re-exporta: `eventBus`, `confidenceInference`, `confusionGraph`, `learnerProfile`, `aiOrchestrator`, `digestBuilder`, `flashcardGenerator`.

6. **Gate de calidad por PR**:
   - `npx tsc --noEmit` pasa — obligatorio
   - Tipos importables desde alias `@/` — obligatorio
   - Nuevos hooks usan keys de `queryKeys.ts` — obligatorio
   - UI sigue design system: Georgia títulos, Inter body, teal primary, `rounded-full` buttons, `rounded-2xl` cards — obligatorio
   - Animaciones con `motion/react`, nunca `framer-motion` — obligatorio

### Criterio de éxito global
- [ ] Fase 1 completa: eventos fluyen cliente→servidor, confianza implícita calculada
- [ ] Fase 2 completa: flashcards determinísticas, confusionGraph, digest con fallback, orchestrator
- [ ] 80% de funcionalidad opera sin llamadas a IA
- [ ] Cero `AIContext` o extensión de `StudentDataContext` — todo vía React Query
- [ ] Cada PR pasa `npx tsc --noEmit` antes de merge
