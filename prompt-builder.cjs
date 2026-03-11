/**
 * Prompt Builder — Construye prompts y parsea checkpoints
 *
 * Centraliza toda la lógica de construcción de prompts y
 * extracción de datos estructurados de las respuestas.
 */

// NOTE: This module is used by the Figma Make MCP flow (via external AI clients).
// orchestrator-engine.cjs has its own buildAgentPrompt for the autonomous flow (run_debate).
// Both flows should maintain feature parity where practical.
// Shared features: principles injection, checkpoint extraction
// Orchestrator-only: moderator instructions, quality gate retry, competence ordering

const { emptyCheckpoint } = require('./SessionTypes.cjs');

// ── Dialogue Frame definitions by role (Claude Opus 4.6 optimization) ────
const DIALOGUE_FRAMES = {
  'analista-codigo': '[HALLAZGO] -> [EVIDENCIA-CODIGO] -> [IMPACTO] -> [RECOMENDACION]',
  'arquitecto-guardian': '[EVALUACION] -> [RIESGO-BENEFICIO] -> [PATRON-PROPUESTO] -> [VALIDACION]',
  'proponedor-mejora': '[ANALISIS] -> [EVIDENCIA] -> [PROPUESTA] -> [TRADE-OFFS] -> [PREGUNTA-DESAFIO]',
  'revisor-seguridad': '[VULNERABILIDAD] -> [VECTOR-ATAQUE] -> [MITIGACION] -> [VERIFICACION]',
  'revisor-calidad': '[METRICA] -> [COMPARACION] -> [SUGERENCIA] -> [CRITERIO-ACEPTACION]',
  'coordinador-merge': '[ESTADO] -> [PRIORIDADES] -> [DECISION] -> [ASIGNACION]',
  'default': '[POSICION] -> [ARGUMENTO] -> [EVIDENCIA] -> [PROPUESTA] -> [PREGUNTA]',
};

/**
 * Obtiene el dialogue frame para un rol especifico.
 * @param {string} role
 * @returns {string}
 */
function getDialogueFrame(role) {
  return DIALOGUE_FRAMES[role] || DIALOGUE_FRAMES['default'];
}

// ── Checkpoint instructions (se agrega al final de cada prompt) ─────────
const CHECKPOINT_INSTRUCTIONS = `

IMPORTANTE: Tu respuesta DEBE terminar con un bloque estructurado:
---CHECKPOINT---
{"consenso":["punto 1","punto 2"],"divergencias":["punto 1"],"preguntas":["pregunta 1"],"accionable":["accion 1","accion 2"],"reasoning_chain":["paso 1","paso 2","conclusion"],"builds_on":["nombre_agente: idea que extiende"],"confidence":0.85,"uncertainty_areas":["area donde no tengo certeza"],"meta_observation":"nota sobre la calidad del debate"}
---END---

- consenso: ideas con las que estas de acuerdo o que refuerzas
- divergencias: ideas con las que NO estas de acuerdo
- preguntas: dudas que quedan abiertas
- accionable: cosas concretas que se deben implementar
- reasoning_chain: tu cadena de razonamiento paso a paso (permite que otros objeten pasos individuales)
- builds_on: lista de ideas de OTROS agentes que estas extendiendo (formato "nombre: idea")
- confidence: 0.0-1.0 que tan seguro estas de tu posicion
- uncertainty_areas: areas especificas donde NO tienes certeza y necesitas input
- meta_observation: observacion sobre el PROCESO del debate (bias, perspectivas faltantes, calidad del dialogo)`;

// ── Parse checkpoint from response ──────────────────────────────────────

/**
 * Intenta extraer un Checkpoint de la respuesta del agente.
 * Path 1: JSON entre ---CHECKPOINT--- y ---END---
 * Path 2: Regex fallback buscando CONSENSO:, DIVERGENCIAS:, etc.
 * Path 3: Retorna checkpoint vacío con raw text
 *
 * @param {string} raw - Respuesta completa del agente
 * @param {string} agentName
 * @param {number} round
 * @returns {import('./SessionTypes.cjs').Checkpoint}
 */
function parseCheckpoint(raw, agentName, round) {
  if (!raw || typeof raw !== 'string') {
    return emptyCheckpoint(agentName, round, raw || '');
  }

  // Path 1: JSON parse
  const jsonMatch = raw.match(/---CHECKPOINT---\s*([\s\S]*?)\s*---END---/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      return {
        agentName,
        round,
        consenso: Array.isArray(parsed.consenso) ? parsed.consenso : [],
        divergencias: Array.isArray(parsed.divergencias) ? parsed.divergencias : [],
        preguntas: Array.isArray(parsed.preguntas) ? parsed.preguntas : [],
        accionable: Array.isArray(parsed.accionable) ? parsed.accionable : [],
        // ── Structured Thought fields (Claude Opus 4.6 optimization) ──
        reasoning_chain: Array.isArray(parsed.reasoning_chain) ? parsed.reasoning_chain : [],
        builds_on: Array.isArray(parsed.builds_on) ? parsed.builds_on : [],
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : null,
        uncertainty_areas: Array.isArray(parsed.uncertainty_areas) ? parsed.uncertainty_areas : [],
        meta_observation: typeof parsed.meta_observation === 'string' ? parsed.meta_observation.slice(0, 500) : null,
        structured: true,
        raw,
      };
    } catch {}
  }

  // Path 2: Regex fallback
  const consenso = extractSection(raw, 'CONSENSO');
  const divergencias = extractSection(raw, 'DIVERGENCIAS');
  const preguntas = extractSection(raw, 'PREGUNTAS');
  const accionable = extractSection(raw, 'ACCIONABLE');

  const hasContent = consenso.length > 0 || accionable.length > 0;
  if (hasContent) {
    return {
      agentName,
      round,
      consenso,
      divergencias,
      preguntas,
      accionable,
      structured: true,
      raw,
    };
  }

  // Path 3: Unstructured fallback
  return emptyCheckpoint(agentName, round, raw);
}

/**
 * Extrae una sección del texto por header
 * @param {string} text
 * @param {string} header
 * @returns {string[]}
 */
function extractSection(text, header) {
  const regex = new RegExp(header + ':\\s*([\\s\\S]*?)(?=(?:CONSENSO|DIVERGENCIAS|PREGUNTAS|ACCIONABLE|---CHECKPOINT|$))', 'i');
  const match = text.match(regex);
  if (!match) return [];

  return match[1]
    .split('\n')
    .map(line => line.replace(/^[\s\-\*\d.]+/, '').trim())
    .filter(line => line.length > 5);
}

// ── Prompt builders ─────────────────────────────────────────────────────

/**
 * Construye el prompt para el primer mensaje de la sesión
 */
function buildFirstPrompt({ agent, agents, topic, salaName, otherSalaName, maxWords, contextContent, memory, principles }) {
  const others = agents.filter(a => a !== agent).join(', ');

  let prompt = `Eres ${agent} en la "${salaName}" del proyecto Axon (plataforma educativa medica, React+TypeScript+Vite+Supabase).

CONTEXTO:
- Tema: "${topic}"
- Tus companeros en esta sala: ${others}
- Hay otra sala ("${otherSalaName}") debatiendo el mismo tema en paralelo.
`;

  if (contextContent) {
    prompt += `\nDOCUMENTACION DEL SISTEMA A DISCUTIR:\n${contextContent}\n`;
  }

  if (memory) {
    prompt += `\nMEMORIA DE SESIONES ANTERIORES:\n${memory}\nIMPORTANTE: NO repitas ideas anteriores. Construye SOBRE ellas.\n`;
  }

  if (principles && principles.length > 0) {
    prompt += `\nPRINCIPIOS APRENDIDOS DE DEBATES ANTERIORES:\n`;
    for (const p of principles) {
      prompt += `- ${p.text}\n`;
    }
    prompt += `Tené en cuenta estos principios al formular tu respuesta.\n`;
  }

  prompt += `
TU TAREA:
Da tu perspectiva CREATIVA e INNOVADORA. Se especifico para Axon:
- Propone ideas CONCRETAS (menciona componentes, servicios, hooks reales)
- Piensa en UX/UI especificos, flujos de usuario
- Si propones IA, detalla: que modelo, que endpoint, que datos de entrada/salida
- Se AUDAZ — propone cosas que nadie esperaria

Maximo ${maxWords} palabras. Responde con texto.${CHECKPOINT_INSTRUCTIONS}`;

  return prompt;
}

/**
 * Construye el prompt para rondas de debate (2+)
 */
function buildDebatePrompt({ agent, agents, topic, salaName, ownHistory, otherHistory, otherSalaName, round, totalRounds, maxWords, contextContent, memory, principles, retrospectives }) {
  const others = agents.filter(a => a !== agent).join(', ');

  let prompt = `Eres ${agent} en la "${salaName}" del proyecto Axon.\n`;

  if (contextContent && round <= 2) {
    prompt += `\nDOCUMENTACION DEL SISTEMA A DISCUTIR:\n${contextContent}\n`;
  }

  if (memory) {
    prompt += `\n${memory}\nIMPORTANTE: NO repitas ideas de sesiones anteriores. Construye SOBRE ellas.\n`;
  }

  if (principles && principles.length > 0) {
    prompt += `\nPRINCIPIOS APRENDIDOS DE DEBATES ANTERIORES:\n`;
    for (const p of principles) {
      prompt += `- ${p.text}\n`;
    }
    prompt += `Tené en cuenta estos principios al formular tu respuesta.\n`;
  }

  if (retrospectives && retrospectives.length > 0) {
    prompt += `\nINSIGHTS DE DEBATES ANTERIORES:\n`;
    for (const r of retrospectives) {
      prompt += `- ${r.agent}: "${r.retro}"\n`;
    }
    prompt += `Tené en cuenta estas lecciones.\n`;
  }

  prompt += `\nHISTORIAL DE TU SALA:\n${ownHistory}\n`;

  if (otherHistory) {
    prompt += `\nHISTORIAL DE LA OTRA SALA ("${otherSalaName}"):\n${otherHistory}\nIMPORTANTE: Lee la otra sala. Conecta ideas, desafia o amplifica.\n`;
  }

  prompt += `
CONTEXTO: Ronda ${round}/${totalRounds}. Companeros: ${others}.

TU TAREA:
- RESPONDE a lo que dijeron — no repitas, AVANZA la discusion
- Si ves una idea brillante, amplificala con detalles concretos
- Si NO estas de acuerdo, di POR QUE y propone alternativa
- Propone CONEXIONES entre ideas de ambas salas
- Agrega algo NUEVO que nadie haya dicho
- Se especifico: archivos, componentes, hooks, servicios reales
${round === totalRounds ? '- ULTIMA RONDA: Cierra con tus TOP 3 propuestas priorizadas\n' : ''}
Maximo ${maxWords} palabras. Responde con texto.${CHECKPOINT_INSTRUCTIONS}`;

  return prompt;
}

/**
 * Construye el prompt de síntesis final
 */
function buildSynthesisPrompt(history1, history2, topic, checkpoints) {
  let checkpointSummary = '';
  if (checkpoints && checkpoints.length > 0) {
    const structured = checkpoints.filter(c => c.structured);
    if (structured.length > 0) {
      checkpointSummary = '\n\nCHECKPOINTS ESTRUCTURADOS:\n';
      for (const cp of structured) {
        checkpointSummary += `\n[${cp.agentName} R${cp.round}]`;
        if (cp.consenso.length) checkpointSummary += `\n  Consenso: ${cp.consenso.join('; ')}`;
        if (cp.accionable.length) checkpointSummary += `\n  Accionable: ${cp.accionable.join('; ')}`;
        if (cp.divergencias.length) checkpointSummary += `\n  Divergencias: ${cp.divergencias.join('; ')}`;
      }
    }
  }

  return `Eres el facilitador que sintetiza dos discusiones paralelas sobre el proyecto Axon.

SALA ESTRATEGIA:
${history1}

SALA IMPLEMENTACION:
${history2}
${checkpointSummary}

TEMA: ${topic}

Genera una SINTESIS EJECUTIVA:

## 1. LAS 5 MEJORES IDEAS (combinando ambas salas)
Para cada una: idea, quien la propuso, impacto, esfuerzo (S/M/L), prioridad (P0/P1/P2)

## 2. CONEXIONES ENTRE SALAS
Ideas que se complementan o potencian

## 3. ROADMAP
Fase 1 (1-2 semanas), Fase 2 (1 mes), Fase 3 (2-3 meses)

## 4. ARQUITECTURA PROPUESTA
Diagrama textual de como se integran los cambios

## 5. RIESGOS Y DECISIONES PENDIENTES

## 6. SIGUIENTE PASO INMEDIATO

Se concreto y accionable. Responde SOLO con texto.`;
}

/**
 * Construye el prompt para generar prompts de acción por agente
 */
function buildActionPromptsPrompt(synthesis, history1, history2) {
  return `Basandote en la sintesis final y el debate de ambas salas, genera un PROMPT COMPLETO para cada agente.

SINTESIS:
${synthesis}

SALA ESTRATEGIA (resumen):
${history1.slice(0, 3000)}

SALA IMPLEMENTACION (resumen):
${history2.slice(0, 3000)}

Genera un prompt para CADA agente. Cada prompt debe ser autocontenido:

## ARQUITECTO
## EXPERTO-QUIZ
## EXPERTO-FLASHCARDS
## EXPERTO-RESUMEN
## EXPERTO-ORGANIZADOR
## TEACH-LEADER

REGLAS:
- Archivos EXACTOS del proyecto (paths reales)
- Tipos TypeScript si necesarios
- Endpoints con request/response
- Orden de implementacion
- Criterios de "done"
- Max 500 palabras por agente
- Empieza con: "Tu tarea es..."

Responde SOLO con texto markdown.`;
}

module.exports = {
  CHECKPOINT_INSTRUCTIONS,
  DIALOGUE_FRAMES,
  getDialogueFrame,
  parseCheckpoint,
  buildFirstPrompt,
  buildDebatePrompt,
  buildSynthesisPrompt,
  buildActionPromptsPrompt,
};
