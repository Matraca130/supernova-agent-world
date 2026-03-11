# Sala Implementacion
> Sesion: 10/3/2026, 12:54:25 p.m.
> Tema: Como mejorar la integracion de IA en Axon
> Participantes: experto-resumen, experto-flashcards, experto-organizador
> Calidad: high (opus, esfuerzo: high)

---

## Tema
Como mejorar la integracion de IA en Axon

---

### [12:54:59 p.m.] experto-resumen:
Let me explore the codebase first to ground my proposals in real components and services.

<tool_use>
<server_name>mcp-github</server_name>
<tool_name>search_repositories</tool_name>
<call_id>call_hEZABivr0aOJB0IwNUKxG4xP</call_id>
<input>{"query": "axon medical education"}
</input>
</tool_use>

<tool_use>
<server_name>filesystem</server_name>
<tool_name>list_directory</tool_name>
<call_id>call_Bp1D1OjJcFqAIU71x9SPAhub</call_id>
<input>{"path": "C:\\Users\\petri\\numero1_sseki_2325_55\\src\\app\\services"}
</input>
</tool_use>

<tool_use>
<server_name>filesystem</server_name>
<tool_name>list_directory</tool_name>
<call_id>call_aA3NjK8dqXPCKN0RCZ8t8YHk</call_id>
<input>{"path": "C:\\Users\\petri\\numero1_sseki_2325_55\\src\\app\\hooks\\queries"}
</input>
</tool_use>

<tool_use>
<server_name>filesystem</server_name>
<tool_name>list_directory</tool_name>
<call_id>call_L9kkIQfaZfMxK3l9c2c6c1O5</call_id>
<input>{"path": "C:\\Users\\petri\\numero1_sseki_2325_55\\src\\app\\components\\content"}
</input>
</tool_use>

---

Aquí va mi perspectiva como **experto-resumen**:

---

## 1. "Resumen Vivo" — Generación contextual post-estudio

Después de que el estudiante termina una sesión en cualquier `*View` (ej. `KeywordsView`, `FlashcardsView`, `QuizView`), el sistema genera automáticamente un **resumen personalizado** basado en:

- **Entrada**: keywords estudiadas (del `ContentTreeContext`), respuestas del quiz (`useQuizSession`), tarjetas falladas, tiempo por sección, y el mastery score del `spacedRepetition.ts`.
- **Salida**: un resumen de 150-300 palabras en lenguaje médico preciso, con énfasis en lo que el estudiante falló o le tomó más tiempo.
- **Modelo**: Claude Haiku 4.5 vía Supabase Edge Function (`/functions/v1/generate-summary`), con el header `X-Access-Token` del usuario.
- **UX**: Aparece como un panel deslizable (`motion` de `motion/react`) al cerrar la sesión de estudio. Diseño: card blanca `rounded-2xl shadow-sm`, título en Georgia, cuerpo en Inter, ícono `bg-teal-50 text-teal-500`.

**Lo audaz**: el resumen incluye **analogías clínicas generadas por IA**. Si estudiaste farmacología de beta-bloqueadores, te da: "Piensa en el propranolol como un portero de discoteca — solo deja pasar lo que le conviene al corazón."

## 2. "Síntesis Cruzada" entre temas

Nuevo hook `useAISynthesis` que, dado un array de `topicId`s del `StudentDataContext`, llama a un endpoint `/functions/v1/cross-synthesis` y genera conexiones entre temas que el estudiante ya dominó. Por ejemplo: "Tu conocimiento de histología renal + tu progreso en farmaco nefro te permite entender por qué los IECA protegen el glomérulo."

Esto se renderiza en el `DashboardView` como tarjetas de "Conexión Descubierta" — gamificación cognitiva pura.

## 3. "Resumen de Examen Predictivo"

Antes de un examen, un botón en `StudyPlanView` llama a `/functions/v1/predictive-summary` con:
- Todos los mastery scores < 0.7 del estudiante (zona amarilla/roja del sistema SM-2)
- Historial de quizzes fallados
- Peso del tema en el programa

Devuelve un **documento de estudio priorizado**: "Tienes 3 horas antes del examen. Enfócate en: (1) Ciclo de Krebs — tu mastery es 0.35, (2) Farmacocinética de aminoglucósidos — fallaste 4/5 preguntas."

## 4. Lo que nadie espera: "Resumen por Voz"

Integrar Web Speech API en un nuevo componente `AudioSummaryPlayer`. El resumen generado por IA se convierte en audio. El estudiante médico puede escuchar sus resúmenes personalizados mientras camina al hospital. El componente vive en `src/app/components/content/AudioSummaryPlayer.tsx`, usa `motion` para la animación del waveform, y cachea el audio en IndexedDB para offline.

---

**Mi tesis central**: la IA en Axon no debe ser un chatbot genérico. Debe ser un **motor de síntesis invisible** que transforma datos de rendimiento del estudiante en conocimiento destilado, entregado en el momento exacto y en el formato correcto.

---

### [12:55:45 p.m.] experto-flashcards:
Let me explore the flashcard-related code to ground my response.

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/**/*lashcard*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/**/*spaced*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/**/*fsrs*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/**/*bkt*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/services/spacedRepetition.ts"}
</input>
</tool_use>

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/components/content/Flashcard*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/services/ai*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/lib/fsrs-engine.ts"}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/lib/bkt-engine.ts"}
</input>
</tool_use>

Let me also check the existing AI service and flashcard views.

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/services/ai*.ts", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/components/content/*Flash*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/components/content/*flash*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Glob</tool_name>
<input>{"pattern": "src/app/**/*Flash*", "path": "C:/Users/petri/numero1_sseki_2325_55"}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/services/aiService.ts"}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/components/content/FlashcardsView.tsx", "offset": 1, "limit": 80}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/components/content/FlashcardsView.tsx", "offset": 80, "limit": 160}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/hooks/queries/queryKeys.ts"}
</input>
</tool_use>

Now let me look at the keyword mastery and student data context for flashcard-relevant state.

<tool_use>
<tool_name>Grep</tool_name>
<input>{"pattern": "mastery", "path": "C:/Users/petri/numero1_sseki_2325_55/src/app/services/spacedRepetition.ts"}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/components/content/FlashcardsView.tsx", "offset": 160, "limit": 280}
</input>
</tool_use>

<tool_use>
<tool_name>Grep</tool_name>
<input>{"pattern": "flashcard|Flashcard", "path": "C:/Users/petri/numero1_sseki_2325_55/src/app/services/aiService.ts"}
</input>
</tool_use>

<tool_use>
<tool_name>Read</tool_name>
<input>{"file_path": "C:/Users/petri/numero1_sseki_2325_55/src/app/components/content/FlashcardsView.tsx", "offset": 280, "limit": 400}
</input>
</tool_use>

Now I have enough context. Here's my response as **experto-flashcards**:

---

Experto-resumen, tu propuesta del "Resumen Vivo" tiene mérito, pero hay un problema de fondo: **la IA genera texto, pero el estudiante necesita retrieval practice, no lectura pasiva**. Un resumen post-sesión es consumo pasivo — la evidencia cognitiva dice que recordar activamente supera a releer por un factor de 2-3x en retención. Mi propuesta es que ese resumen no se entregue como texto, sino como **flashcards generadas dinámicamente**.

## 1. "Flashcards Reactivas" — generación post-fallo

Ahora mismo `FlashcardsView.tsx` renderiza tarjetas estáticas del `ContentTreeContext`. Cuando el estudiante califica con "Again" o "Hard" (líneas donde se llama `reviewCard` con quality < 3 en `spacedRepetition.ts`), el sistema ya recalcula intervalos SM-2. Lo que falta: **en ese momento exacto**, disparar una llamada a `/functions/v1/generate-flashcards` que tome el keyword fallado + su contexto clínico y genere 2-3 tarjetas complementarias con ángulos distintos. Si fallaste "mecanismo de acción de metformina", te genera: (1) una tarjeta de comparación vs sulfonilureas, (2) una tarjeta de caso clínico, (3) una tarjeta de efecto adverso relacionado. Esto se inyecta en la cola de revisión actual via el estado local del `FlashcardsView`.

## 2. Conexión con FSRS y BKT — scheduling inteligente de contenido IA

Veo que ya existen `fsrs-engine.ts` y `bkt-engine.ts` como motores alternativos al SM-2. La oportunidad es enorme: **BKT estima la probabilidad de que el estudiante "sepa" un concepto** (`pKnown`). Cuando `pKnown` cae debajo de 0.4 pero el SM-2 aún no programa revisión (porque el intervalo no venció), hay una brecha. Ahí es donde la IA interviene: genera una flashcard de "reactivación" que aparece como tarjeta bonus en la siguiente sesión. Nuevo hook: `useAdaptiveFlashcards` que combina `getBKTState()` + el scheduling de FSRS para decidir **cuándo** inyectar contenido generado vs. contenido estático.

## 3. Desafío a la "Síntesis Cruzada"

Experto-resumen, tu idea de conexiones entre temas es potente, pero una tarjeta de texto estático en el Dashboard es débil cognitivamente. Propongo que esas "Conexiones Descubiertas" se conviertan en **flashcards de integración** — tarjetas que el estudiante debe resolver activamente: "¿Por qué los IECA protegen el glomérulo? Relaciona con lo que sabes de histología renal." El front muestra pregunta, el estudiante formula respuesta mental, y luego la IA evalúa con un endpoint `/functions/v1/evaluate-synthesis`. Esto vive como un modo especial dentro del `FlashcardsView` activado desde `DashboardView`.

## 4. Lo nuevo: "Flashcard Adversarial"

El `aiService.ts` ya tiene infraestructura para llamadas IA. Mi propuesta disruptiva: **tarjetas que intentan engañarte**. La IA genera flashcards con respuestas sutilmente incorrectas (ej. "La metformina actúa inhibiendo la gluconeogénesis **hepática y renal**" — lo renal es debatible). El estudiante debe identificar el error. Esto entrena pensamiento crítico médico, no solo memorización. Se implementa como un nuevo tipo `CardType = 'standard' | 'adversarial'` en los tipos de flashcard, con UI diferenciada (borde amarillo de advertencia).

**Mi tesis**: la IA en Axon debe generar **desafíos activos**, no resúmenes pasivos. Cada output de IA debe exigir que el estudiante piense, no que lea.

---

### [12:56:36 p.m.] experto-organizador:
Bien, trabajo con el contexto que ya tenemos del codebase. Aquí va mi respuesta como **experto-organizador**:

---

Ambos tienen razón y ambos están incompletos. Experto-resumen propone output pasivo valioso; experto-flashcards lo desafía con retrieval practice. La respuesta correcta no es elegir — es **orquestar**. El problema real de Axon no es "qué genera la IA" sino **cuándo, dónde y en qué orden lo entrega**.

## 1. El Orquestador de IA — `useAIOrchestrator`

Ni resúmenes ni flashcards deberían decidir aisladamente cuándo aparecer. Propongo un hook central `useAIOrchestrator` que consuma datos de `StudentDataContext` (mastery scores), `ContentTreeContext` (keywords activas), y el estado de sesión actual. Este hook decide el **formato óptimo** de intervención IA según el momento cognitivo:

- **Post-sesión inmediata** (fatiga alta): resumen breve del experto-resumen. El estudiante acaba de estudiar 45 minutos — no le pongas más flashcards.
- **Inicio de sesión siguiente** (energía alta): flashcards reactivas del experto-flashcards. Aquí sí, retrieval practice agresivo.
- **Entre sesiones** (modo pasivo): la síntesis cruzada como notificación push o tarjeta en `DashboardView`.

La evidencia cognitiva apoya ambos formatos — el **spacing effect** necesita retrieval, pero el **consolidation** post-estudio se beneficia de resúmenes organizados. Experto-flashcards, tu crítica al resumen pasivo ignora que el momento post-sesión es precisamente donde la elaboración (no el recall) consolida mejor.

## 2. Pipeline unificado de Edge Functions

Veo un riesgo arquitectónico: experto-resumen propone `/generate-summary`, `/cross-synthesis`, `/predictive-summary`; experto-flashcards propone `/generate-flashcards`, `/evaluate-synthesis`. Son **5 Edge Functions separadas** que comparten el 80% de la lógica (obtener datos del estudiante, construir prompt, llamar a Claude, parsear respuesta). Propongo un único endpoint `/functions/v1/ai-generate` con un parámetro `type: 'summary' | 'flashcards' | 'synthesis' | 'predictive' | 'adversarial'` que internamente rutea a handlers específicos. Un solo servicio en frontend: extender el `aiService.ts` existente con métodos tipados, y un único query key en `queryKeys.ts`: `aiGeneration(type, params)`.

## 3. Presupuesto cognitivo y de tokens

Nadie habló de **límites**. Si cada fallo genera 2-3 flashcards IA y cada sesión genera un resumen, un estudiante activo dispara 20+ llamadas/día a Claude. Propongo un sistema de `AIBudget` en `AppContext`: máximo N generaciones/día por estudiante, con priorización. El orquestador decide si gastar el presupuesto en un resumen o en flashcards según el delta de mastery. Esto también controla costos de API en producción.

## 4. Lo que falta: **Feedback Loop cerrado**

Ninguno propuso medir si la IA funciona. Nuevo campo en el modelo de `StudentDataContext`: `aiInteractionLog`. Cada vez que el estudiante interactúa con contenido generado (lee resumen, responde flashcard IA, resuelve adversarial), se registra. Después de 2 semanas, comparamos mastery scores de keywords donde intervino IA vs. donde no. Esto alimenta al orquestador: si los resúmenes no mejoran mastery pero las flashcards sí, el sistema pivotea automáticamente. Sin este loop, estamos adivinando.

## 5. Sobre la "Flashcard Adversarial"

Experto-flashcards, es la idea más arriesgada y la más valiosa. Pero necesita **calibración por BKT**: solo mostrar adversariales cuando `pKnown > 0.7`. Debajo de eso, confundes al estudiante en vez de retarlo. El orquestador controla esto.

**Mi tesis**: la IA no necesita más features — necesita un **cerebro que decida qué feature activar en cada momento**. Ese cerebro es el orquestador.

---

