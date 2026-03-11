/**
 * Quality Gate — Experto-Quiz
 *
 * Mide calidad de respuestas de agentes en modo observacional.
 * NUNCA bloquea — solo loggea métricas para análisis posterior.
 *
 * Dimensiones: relevance, novelty, specificity
 */

const vectorStore = require('./memoria/vector-store.cjs');

/**
 * Mide relevancia: cosine similarity entre respuesta y tema
 * @param {string} response
 * @param {string} topic
 * @returns {Promise<number>} 0-1
 */
async function measureRelevance(response, topic) {
  try {
    const results = await vectorStore.searchMemories(topic, 1);
    // Embed the response and compare to topic
    // We use a proxy: search the response against the topic as if it were a memory
    const tempResults = await vectorStore.searchMemories(response.slice(0, 500), 1);
    // If the response matches existing memories about the topic, it's relevant
    return tempResults.length > 0 ? Math.min(tempResults[0].score, 1) : 0.5;
  } catch {
    return 0.5; // Default if Ollama unavailable
  }
}

/**
 * Mide novedad: 1 - max similarity contra memorias existentes
 * @param {string} response
 * @returns {Promise<number>} 0-1 (1 = totalmente nuevo)
 */
async function measureNovelty(response) {
  try {
    const results = await vectorStore.searchMemories(response.slice(0, 500), 3);
    if (!results.length) return 1.0; // No memories = everything is novel

    const maxSimilarity = Math.max(...results.map(r => r.score));
    return Math.max(0, 1 - maxSimilarity);
  } catch {
    return 0.5;
  }
}

/**
 * Mide especificidad: cuenta referencias a archivos, funciones, paths
 * @param {string} response
 * @returns {number} 0-1
 */
function measureSpecificity(response) {
  const patterns = [
    /src\/[\w/.-]+\.[tj]sx?/g,          // File paths
    /\b\w+\.(tsx?|cjs|mjs|json)\b/g,    // File names
    /\buse[A-Z]\w+/g,                    // Hook names
    /\b(endpoint|POST|GET|PUT)\s+\/\w+/g, // Endpoints
    /`[^`]+`/g,                          // Inline code
    /\b(function|const|type|interface)\s+\w+/g, // Code identifiers
  ];

  let totalMatches = 0;
  for (const pattern of patterns) {
    const matches = response.match(pattern);
    if (matches) totalMatches += matches.length;
  }

  // Normalize: 0 matches = 0, 20+ matches = 1
  return Math.min(totalMatches / 20, 1);
}

/**
 * Puntúa una respuesta completa
 * @param {string} response
 * @param {string} topic
 * @param {string} agentName
 * @param {number} round
 * @param {number} speakingOrder
 * @returns {Promise<Object>} QualityScore
 */
async function scoreResponse(response, topic, agentName, round, speakingOrder) {
  const [relevance, novelty] = await Promise.all([
    measureRelevance(response, topic),
    measureNovelty(response),
  ]);
  const specificity = measureSpecificity(response);

  return {
    agentName,
    round,
    relevance: parseFloat(relevance.toFixed(3)),
    novelty: parseFloat(novelty.toFixed(3)),
    specificity: parseFloat(specificity.toFixed(3)),
    speakingOrder,
    composite: parseFloat(((relevance + novelty + specificity) / 3).toFixed(3)),
  };
}

module.exports = {
  measureRelevance,
  measureNovelty,
  measureSpecificity,
  scoreResponse,
};
