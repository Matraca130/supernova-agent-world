/**
 * SessionTypes — Tipos y validadores del sistema Multi-Agent Chat
 *
 * @typedef {Object} Checkpoint
 * @property {string} agentName
 * @property {number} round
 * @property {string[]} consenso
 * @property {string[]} divergencias
 * @property {string[]} preguntas
 * @property {string[]} accionable
 * @property {boolean} structured
 * @property {string} raw
 *
 * @typedef {Object} ActionItem
 * @property {string} id
 * @property {string} description
 * @property {'new'|'pending'|'done'|'discarded'} status
 * @property {string} createdSession
 * @property {string|null} closedBy
 * @property {'P0'|'P1'|'P2'} priority
 * @property {string} assignedAgent
 *
 * @typedef {Object} SessionMetrics
 * @property {string} sessionId
 * @property {string} date
 * @property {number} duration
 * @property {number} tokensEstimated
 * @property {string[][]} agentOrder
 * @property {number[]} roundTimes
 */

/**
 * Valida que un objeto sea un Checkpoint válido
 * @param {any} obj
 * @returns {boolean}
 */
function isValidCheckpoint(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.agentName !== 'string') return false;
  if (typeof obj.round !== 'number') return false;
  if (!Array.isArray(obj.consenso)) return false;
  if (!Array.isArray(obj.accionable)) return false;
  if (typeof obj.structured !== 'boolean') return false;
  return true;
}

/**
 * Crea un Checkpoint vacío (fallback)
 * @param {string} agentName
 * @param {number} round
 * @param {string} raw
 * @returns {Checkpoint}
 */
function emptyCheckpoint(agentName, round, raw) {
  return {
    agentName,
    round,
    consenso: [],
    divergencias: [],
    preguntas: [],
    accionable: [],
    structured: false,
    raw,
  };
}

/**
 * Valida que un objeto sea un ActionItem válido
 * @param {any} obj
 * @returns {boolean}
 */
function isValidActionItem(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.id !== 'string') return false;
  if (typeof obj.description !== 'string') return false;
  if (!['new', 'pending', 'done', 'discarded'].includes(obj.status)) return false;
  if (!['P0', 'P1', 'P2'].includes(obj.priority)) return false;
  return true;
}

module.exports = {
  isValidCheckpoint,
  isValidActionItem,
  emptyCheckpoint,
};
