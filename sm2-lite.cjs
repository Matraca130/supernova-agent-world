/**
 * SM-2 Lite — Experto-Flashcards
 *
 * Fork mínimo del algoritmo SM-2 de src/app/services/spacedRepetition.ts
 * Adaptado para competencias de agentes en el sistema multi-agent chat.
 *
 * quality 5 = action item implementado (commit matcheado)
 * quality 3 = action item discutido pero no implementado
 * quality 1 = action item descartado o estancado
 * quality 0 = agente no produjo action items válidos
 *
 * // Fork de src/app/services/spacedRepetition.ts — mantener sincronizado
 */

const fs = require('fs');
const path = require('path');

const COMPETENCE_FILE = path.join(__dirname, 'agent-competence.json');

/**
 * Calcula el nuevo estado SM-2 para una competencia de agente
 * @param {Object} comp - AgentCompetence actual
 * @param {number} quality - 0-5 rating
 * @returns {Object} AgentCompetence actualizado
 */
function updateCompetence(comp, quality) {
  let { easeFactor, interval, repetitions } = comp;
  easeFactor = easeFactor || 2.5;
  interval = interval || 1;
  repetitions = repetitions || 0;

  if (quality >= 3) {
    // Correct response
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions++;
  } else {
    // Incorrect — reset
    repetitions = 0;
    interval = 1;
  }

  // Update ease factor (SM-2 formula)
  easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (easeFactor < 1.3) easeFactor = 1.3;

  return {
    ...comp,
    easeFactor: parseFloat(easeFactor.toFixed(2)),
    interval,
    repetitions,
    quality,
    lastReview: new Date().toISOString().split('T')[0],
  };
}

/**
 * Calcula un peso 0-1 para ordenar agentes por competencia en un tema
 * Agentes con alto easeFactor y dominio relevante hablan primero
 * @param {Object} comp - AgentCompetence
 * @param {string} topic - Tema actual
 * @returns {number} 0-1
 */
function getAgentWeight(comp, topic) {
  const topicLower = topic.toLowerCase();
  const domainMatch = comp.domains.some(d => topicLower.includes(d.toLowerCase()));

  // Base weight from easeFactor (normalized: 1.3-4.0 → 0-1)
  const efWeight = Math.min((comp.easeFactor - 1.3) / 2.7, 1);

  // Bonus for domain match
  const domainBonus = domainMatch ? 0.3 : 0;

  return Math.min(efWeight + domainBonus, 1);
}

/**
 * Carga competencias desde archivo
 * @returns {Object}
 */
function loadCompetences() {
  try {
    if (fs.existsSync(COMPETENCE_FILE)) {
      return JSON.parse(fs.readFileSync(COMPETENCE_FILE, 'utf-8'));
    }
  } catch {}
  return getDefaultCompetences();
}

/**
 * Guarda competencias a archivo
 * @param {Object} competences
 */
function saveCompetences(competences) {
  fs.writeFileSync(COMPETENCE_FILE, JSON.stringify(competences, null, 2), 'utf-8');
}

/**
 * Competencias por defecto (seed)
 */
function getDefaultCompetences() {
  return {
    'arquitecto': { domains: ['orchestrator', 'architecture', 'modules', 'types'], easeFactor: 2.5, interval: 1, repetitions: 0, quality: 3, lastReview: '2026-03-10' },
    'teach-leader': { domains: ['quality', 'patterns', 'validation', 'testing'], easeFactor: 2.5, interval: 1, repetitions: 0, quality: 3, lastReview: '2026-03-10' },
    'experto-quiz': { domains: ['quiz', 'adaptive', 'metrics', 'assessment'], easeFactor: 2.5, interval: 1, repetitions: 0, quality: 3, lastReview: '2026-03-10' },
    'experto-flashcards': { domains: ['flashcards', 'spaced-repetition', 'parsing', 'sm2'], easeFactor: 2.5, interval: 1, repetitions: 0, quality: 3, lastReview: '2026-03-10' },
    'experto-resumen': { domains: ['summary', 'synthesis', 'content', 'formatting'], easeFactor: 2.5, interval: 1, repetitions: 0, quality: 3, lastReview: '2026-03-10' },
    'experto-organizador': { domains: ['dashboard', 'organization', 'git', 'scheduling'], easeFactor: 2.5, interval: 1, repetitions: 0, quality: 3, lastReview: '2026-03-10' },
  };
}

/**
 * Ordena agentes por peso para un tema dado
 * @param {Object} competences
 * @param {string} topic
 * @returns {string[]} nombres ordenados (más competente primero)
 */
function rankAgents(competences, topic) {
  return Object.entries(competences)
    .map(([name, comp]) => ({ name, weight: getAgentWeight(comp, topic) }))
    .sort((a, b) => b.weight - a.weight)
    .map(a => a.name);
}

module.exports = {
  updateCompetence,
  getAgentWeight,
  loadCompetences,
  saveCompetences,
  getDefaultCompetences,
  rankAgents,
};
