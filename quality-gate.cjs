/**
 * Quality Gate — Experto-Quiz
 *
 * Mide calidad de respuestas de agentes en modo observacional.
 * NUNCA bloquea — solo loggea métricas para análisis posterior.
 *
 * Dimensiones: relevance, novelty, concreteness, argumentQuality
 *
 * Uses OpenAI embeddings via embeddings.cjs (text-embedding-3-small).
 */

const { callEmbeddingAPI, cosineSimilarity, search } = require('./embeddings.cjs');

/**
 * Mide relevancia con enfoque híbrido: keyword overlap + embedding similarity.
 * Diseñado para NO penalizar respuestas innovadoras que aún mencionan el tema.
 * @param {string} response
 * @param {string} topic
 * @returns {Promise<number>} 0-1
 */
async function measureRelevance(response, topic) {
  // --- Keyword overlap ---
  const topicWords = topic
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3);
  const responseLower = response.toLowerCase();
  const matchedKeywords = topicWords.filter(w => responseLower.includes(w)).length;
  // 0 keywords = 0, 5+ = 1
  const keywordScore = Math.min(matchedKeywords / 5, 1);

  // --- Embedding similarity with softer curve ---
  let embeddingScore = 0.5; // fallback
  try {
    const [responseVec, topicVec] = await Promise.all([
      callEmbeddingAPI(response.slice(0, 500)),
      callEmbeddingAPI(topic.slice(0, 500)),
    ]);
    const similarity = cosineSimilarity(responseVec, topicVec);
    // Map 0.3-0.8 range to 0.5-1.0 (softer curve)
    if (similarity >= 0.8) {
      embeddingScore = 1.0;
    } else if (similarity >= 0.3) {
      embeddingScore = 0.5 + ((similarity - 0.3) / (0.8 - 0.3)) * 0.5;
    } else {
      embeddingScore = (similarity / 0.3) * 0.5;
    }
  } catch (err) {
    console.warn('[quality-gate] measureRelevance embedding failed, using keyword only:', err.message);
  }

  // Either one passing is enough
  return Math.max(keywordScore, embeddingScore);
}

/**
 * Mide novedad: 1 - max similarity contra mensajes existentes en el embedding store
 * @param {string} response
 * @returns {Promise<number>} 0-1 (1 = totalmente nuevo)
 */
async function measureNovelty(response) {
  try {
    const results = await search(response.slice(0, 500), 3);
    if (!results.length) return 1.0; // No embeddings stored = everything is novel

    const maxSimilarity = Math.max(...results.map(r => r.similarity));
    // If top match > 0.8, novelty is low
    return Math.max(0, 1 - maxSimilarity);
  } catch (err) {
    console.warn('[quality-gate] measureNovelty failed, defaulting to 0.5:', err.message);
    return 0.5;
  }
}

/**
 * Mide concretitud general: números, entidades, comparaciones, ejemplos,
 * estructura, y referencias a código.
 * Reemplaza a measureSpecificity (que solo medía patrones de código Axon).
 * @param {string} response
 * @returns {number} 0-1
 */
function measureConcreteness(response) {
  let totalMatches = 0;

  // 1. Numbers/quantities
  const numbers = response.match(/\b\d+\b/g);
  if (numbers) totalMatches += numbers.length;

  // 2. Named entities (proper nouns — uppercase words mid-text, 3+ lowercase chars)
  const namedEntities = response.match(/\b[A-Z][a-z]{2,}\b/g);
  if (namedEntities) totalMatches += namedEntities.length;

  // 3. Comparisons (ES + EN)
  const comparisonPatterns = [
    /\bmejor que\b/gi,
    /\bmás que\b/gi,
    /\bcompared to\b/gi,
    /\bunlike\b/gi,
    /\ba diferencia de\b/gi,
  ];
  for (const pattern of comparisonPatterns) {
    const matches = response.match(pattern);
    if (matches) totalMatches += matches.length;
  }

  // 4. Examples (ES + EN)
  const examplePatterns = [
    /\bpor ejemplo\b/gi,
    /\bfor example\b/gi,
    /\be\.g\./gi,
    /\bcomo cuando\b/gi,
    /\bsuch as\b/gi,
  ];
  for (const pattern of examplePatterns) {
    const matches = response.match(pattern);
    if (matches) totalMatches += matches.length;
  }

  // 5. Lists/structure (bullet points, numbered items)
  const listPatterns = [
    /^[\s]*[-*•]\s/gm,          // Bullet points
    /^[\s]*\d+[.)]\s/gm,        // Numbered items
  ];
  for (const pattern of listPatterns) {
    const matches = response.match(pattern);
    if (matches) totalMatches += matches.length;
  }

  // 6. Code references (keep from original)
  const codePatterns = [
    /src\/[\w/.-]+\.[tj]sx?/g,          // File paths
    /\b\w+\.(tsx?|cjs|mjs|json)\b/g,    // File names
    /\buse[A-Z]\w+/g,                    // Hook names
    /\b(endpoint|POST|GET|PUT)\s+\/\w+/g, // Endpoints
    /`[^`]+`/g,                          // Inline code
  ];
  for (const pattern of codePatterns) {
    const matches = response.match(pattern);
    if (matches) totalMatches += matches.length;
  }

  // Normalize: 0 matches = 0, 15+ matches = 1
  return Math.min(totalMatches / 15, 1);
}

/**
 * Mide calidad argumentativa: referencias a otros participantes,
 * contraargumentos, propuestas concretas de acción, y preguntas de engagement.
 * @param {string} response
 * @param {string[]} [participantNames] — nombres de otros agentes en el debate
 * @returns {number} 0-1
 */
function measureArgumentQuality(response, participantNames = []) {
  let score = 0;
  const text = response.toLowerCase();

  // 1. References to other participants by name (max 3 points)
  let nameRefs = 0;
  for (const name of participantNames) {
    if (name && text.includes(name.toLowerCase())) {
      nameRefs++;
    }
  }
  score += Math.min(nameRefs, 3);

  // 2. Counterargument markers (max 3 points)
  const counterPatterns = [
    /\bpero\b/gi,
    /\bsin embargo\b/gi,
    /\bobjeción\b/gi,
    /\bhowever\b/gi,
    /\bbut\b/gi,
    /\bno obstante\b/gi,
    /\ben cambio\b/gi,
    /\bpor el contrario\b/gi,
    /\bon the other hand\b/gi,
  ];
  let counterMatches = 0;
  for (const pattern of counterPatterns) {
    const matches = response.match(pattern);
    if (matches) counterMatches += matches.length;
  }
  score += Math.min(counterMatches, 3);

  // 3. Concrete action proposals (max 3 points)
  const actionPatterns = [
    /\bdebemos\b/gi,
    /\bpropongo\b/gi,
    /\brecomiendo\b/gi,
    /\bshould\b/gi,
    /\bmust\b/gi,
    /\bsugiero\b/gi,
    /\bhay que\b/gi,
    /\bnecesitamos\b/gi,
    /\blet's\b/gi,
    /\bwe need to\b/gi,
    /\bI recommend\b/gi,
    /\bI propose\b/gi,
  ];
  let actionMatches = 0;
  for (const pattern of actionPatterns) {
    const matches = response.match(pattern);
    if (matches) actionMatches += matches.length;
  }
  score += Math.min(actionMatches, 3);

  // 4. Questions showing engagement (max 3 points)
  const questionPatterns = [
    /¿/g,
    /\?/g,
    /\bpor qué\b/gi,
    /\bwhy\b/gi,
    /\bhow would\b/gi,
  ];
  let questionMatches = 0;
  for (const pattern of questionPatterns) {
    const matches = response.match(pattern);
    if (matches) questionMatches += matches.length;
  }
  score += Math.min(questionMatches, 3);

  // Normalize: 0 = 0, 12 = 1 (was 9, now 12 with questions category)
  return Math.min(score / 12, 1);
}

/**
 * Puntúa una respuesta completa con composite ponderado y innovation shield.
 * @param {string} response
 * @param {string} topic
 * @param {string} agentName
 * @param {number} round
 * @param {number} speakingOrder
 * @param {string[]} [participantNames] — nombres de otros agentes
 * @returns {Promise<Object>} QualityScore
 */
async function scoreResponse(response, topic, agentName, round, speakingOrder, participantNames = []) {
  const [relevance, novelty] = await Promise.all([
    measureRelevance(response, topic),
    measureNovelty(response),
  ]);
  const concreteness = measureConcreteness(response);
  const argumentQuality = measureArgumentQuality(response, participantNames);

  // Weighted composite — novelty and argumentQuality matter most for debate
  const weights = { relevance: 0.2, novelty: 0.3, concreteness: 0.2, argumentQuality: 0.3 };
  let composite = relevance * weights.relevance +
                  novelty * weights.novelty +
                  concreteness * weights.concreteness +
                  argumentQuality * weights.argumentQuality;

  // Innovation shield: high novelty compensates for other weaknesses
  const innovationShield = novelty > 0.6;
  if (innovationShield) {
    composite = Math.min(composite + 0.15, 1.0);
  }

  return {
    agentName,
    round,
    relevance: parseFloat(relevance.toFixed(3)),
    novelty: parseFloat(novelty.toFixed(3)),
    concreteness: parseFloat(concreteness.toFixed(3)),
    argumentQuality: parseFloat(argumentQuality.toFixed(3)),
    speakingOrder,
    composite: parseFloat(composite.toFixed(3)),
    innovationShield,
  };
}

/**
 * Devuelve una razón legible de por qué una respuesta fue rechazada.
 * @param {Object} score — objeto retornado por scoreResponse
 * @param {number} [threshold=0.35] — umbral de composite para rechazo
 * @returns {string|null} null si no fue rechazada, string con razón si sí
 */
function getRejectReason(score, threshold = 0.35) {
  if (score.composite >= threshold) return null;

  const weak = [];
  if (score.relevance < 0.3) weak.push(`baja relevancia al tema (${score.relevance})`);
  if (score.concreteness < 0.2) weak.push(`falta concretitud — agregá ejemplos, datos, o referencias específicas (${score.concreteness})`);
  if (score.argumentQuality < 0.2) weak.push(`baja calidad argumentativa — respondé a otros participantes y proponé acciones concretas (${score.argumentQuality})`);
  if (score.novelty < 0.2) weak.push(`repetitivo — aporta ideas nuevas (${score.novelty})`);

  return weak.length > 0 ? weak.join('; ') : 'score compuesto bajo';
}

/**
 * Sanitiza output de agentes para prevenir prompt injection entre agentes.
 * NO borra contenido sospechoso — lo envuelve en markers visibles pero no ejecutables.
 * @param {string} text — texto del agente a sanitizar
 * @returns {{ sanitized: string, flagged: boolean, patterns: string[] }}
 */
function sanitizeAgentOutput(text) {
  const INJECTION_PATTERNS = [
    /IGNORE\s+PREVIOUS/gi,
    /SYSTEM\s+PROMPT/gi,
    /YOU\s+ARE\s+NOW/gi,
    /FORGET\s+EVERYTHING/gi,
    /DISREGARD\s+(ALL|PREVIOUS)/gi,
    /NEW\s+INSTRUCTIONS?:/gi,
    /OVERRIDE\s+SYSTEM/gi,
    /ACT\s+AS\s+(IF|A)/gi,
  ];
  let sanitized = text;
  const flaggedPatterns = [];
  for (const pattern of INJECTION_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        sanitized = sanitized.replace(match, `[CONTENIDO-MARCADO: ${match}]`);
        flaggedPatterns.push(match);
      }
    }
  }
  return {
    sanitized,
    flagged: flaggedPatterns.length > 0,
    patterns: flaggedPatterns,
  };
}

/**
 * Sanitiza nombres de participantes para prevenir inyección via nombres.
 * Solo permite alfanuméricos, guiones y underscores.
 * @param {string[]} names
 * @returns {string[]}
 */
function sanitizeParticipantNames(names) {
  return names.map(n => n.replace(/[^a-zA-Z0-9-_]/g, ''));
}

module.exports = {
  measureRelevance,
  measureNovelty,
  measureConcreteness,
  measureSpecificity: measureConcreteness, // backward compat alias
  measureArgumentQuality,
  scoreResponse,
  getRejectReason,
  sanitizeAgentOutput,
  sanitizeParticipantNames,
};
