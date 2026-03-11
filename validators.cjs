/**
 * Robustness Layer for Multi-Agent Debate System
 *
 * Provides comprehensive validation, error handling, and state recovery
 * for all debate-manager operations.
 *
 * Features:
 * - Input validation for all operations
 * - Safe wrappers with try/catch
 * - State health checks
 * - Automatic state recovery
 * - Rate limiting (in-memory)
 */

const fs = require('fs');
const path = require('path');
const dm = require('./debate-manager.cjs');

// ── Error Code Definitions ──────────────────────────────────────────────

const ERROR_CODES = {
  // Debate-related errors
  DEBATE_NOT_FOUND: 'DEBATE_NOT_FOUND',
  DEBATE_FINISHED: 'DEBATE_FINISHED',
  DEBATE_FULL: 'DEBATE_FULL',
  DEBATE_ALREADY_ACTIVE: 'DEBATE_ALREADY_ACTIVE',

  // Participant-related errors
  PARTICIPANT_NOT_FOUND: 'PARTICIPANT_NOT_FOUND',
  PARTICIPANT_ALREADY_EXISTS: 'PARTICIPANT_ALREADY_EXISTS',

  // Input validation errors
  INVALID_TOPIC: 'INVALID_TOPIC',
  INVALID_ROUNDS: 'INVALID_ROUNDS',
  INVALID_INTENSITY: 'INVALID_INTENSITY',
  INVALID_SITUACION_TYPE: 'INVALID_SITUACION_TYPE',
  INVALID_NUM_AGENTS: 'INVALID_NUM_AGENTS',

  // Message-related errors
  MESSAGE_EMPTY: 'MESSAGE_EMPTY',
  MESSAGE_TOO_SHORT: 'MESSAGE_TOO_SHORT',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',

  // Knowledge base errors
  KB_SOURCE_NOT_FOUND: 'KB_SOURCE_NOT_FOUND',
  KB_SOURCE_DUPLICATE: 'KB_SOURCE_DUPLICATE',
  KB_INVALID_SOURCE: 'KB_INVALID_SOURCE',

  // State/system errors
  STATE_CORRUPTED: 'STATE_CORRUPTED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',

  // Generic validation errors
  INVALID_NULL: 'INVALID_NULL',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_RANGE: 'INVALID_RANGE',
  INVALID_ENUM: 'INVALID_ENUM',
};

// ── Constants (from debate-manager) ─────────────────────────────────────

const VALID_INTENSITIES = ['casual', 'moderado', 'adversarial'];

const VALID_SITUACION_TYPES = [
  'libre',
  'identificar_problemas',
  'arquitectura',
  'ejecucion',
];

const MESSAGE_LIMITS = {
  MIN_LENGTH: 5,      // Minimum characters before checking word count
  MAX_LENGTH: 10000,  // Maximum characters per message
};

const WORD_COUNT_LIMITS = {
  casual: 50,
  moderado: 100,
  adversarial: 150,
};

// ── Rate Limiter State ──────────────────────────────────────────────────

const rateLimitState = new Map(); // { key: { count, resetTime } }

function rateLimit(operation, key, maxPerMinute = 30) {
  const now = Date.now();
  const limitKey = `${operation}:${key}`;

  if (!rateLimitState.has(limitKey)) {
    rateLimitState.set(limitKey, {
      count: 0,
      resetTime: now + 60000, // 1 minute
    });
  }

  const entry = rateLimitState.get(limitKey);

  // Reset counter if window expired
  if (now >= entry.resetTime) {
    entry.count = 0;
    entry.resetTime = now + 60000;
  }

  entry.count++;

  if (entry.count > maxPerMinute) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
    return {
      allowed: false,
      retryAfter,
      error: `Rate limit exceeded. Retry after ${retryAfter}s.`,
      code: ERROR_CODES.RATE_LIMITED,
    };
  }

  return {
    allowed: true,
    remaining: maxPerMinute - entry.count,
  };
}

// ── Utility Validators ──────────────────────────────────────────────────

function validateString(value, fieldName, minLength = 1, maxLength = 10000) {
  if (value === null || value === undefined) {
    return {
      valid: false,
      error: `${fieldName} cannot be null or undefined`,
      code: ERROR_CODES.INVALID_NULL,
    };
  }
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `${fieldName} must be a string, got ${typeof value}`,
      code: ERROR_CODES.INVALID_TYPE,
    };
  }
  if (value.trim().length < minLength) {
    return {
      valid: false,
      error: `${fieldName} must be at least ${minLength} characters`,
      code: ERROR_CODES.INVALID_RANGE,
    };
  }
  if (value.length > maxLength) {
    return {
      valid: false,
      error: `${fieldName} must not exceed ${maxLength} characters`,
      code: ERROR_CODES.MESSAGE_TOO_LONG,
    };
  }
  return { valid: true };
}

function validateNumber(value, fieldName, minValue = null, maxValue = null) {
  if (value === null || value === undefined) {
    return {
      valid: false,
      error: `${fieldName} cannot be null or undefined`,
      code: ERROR_CODES.INVALID_NULL,
    };
  }
  if (typeof value !== 'number' || isNaN(value)) {
    return {
      valid: false,
      error: `${fieldName} must be a number`,
      code: ERROR_CODES.INVALID_TYPE,
    };
  }
  if (minValue !== null && value < minValue) {
    return {
      valid: false,
      error: `${fieldName} must be >= ${minValue}`,
      code: ERROR_CODES.INVALID_RANGE,
    };
  }
  if (maxValue !== null && value > maxValue) {
    return {
      valid: false,
      error: `${fieldName} must be <= ${maxValue}`,
      code: ERROR_CODES.INVALID_RANGE,
    };
  }
  return { valid: true };
}

function validateEnum(value, fieldName, validValues) {
  if (!validValues.includes(value)) {
    return {
      valid: false,
      error: `${fieldName} must be one of: ${validValues.join(', ')}`,
      code: ERROR_CODES.INVALID_ENUM,
    };
  }
  return { valid: true };
}

function validateDebateExists(debateId) {
  try {
    const debates = dm.listDebates();
    const debate = debates.find(d => d.id === debateId);
    if (!debate) {
      return {
        valid: false,
        error: `Debate "${debateId}" not found`,
        code: ERROR_CODES.DEBATE_NOT_FOUND,
      };
    }
    if (debate.status === 'finished') {
      return {
        valid: false,
        error: `Debate "${debateId}" is finished`,
        code: ERROR_CODES.DEBATE_FINISHED,
      };
    }
    return { valid: true, debate };
  } catch (err) {
    return {
      valid: false,
      error: `Error checking debate: ${err.message}`,
      code: ERROR_CODES.STATE_CORRUPTED,
    };
  }
}

function validateParticipantExists(debateId, participantName) {
  try {
    const debates = dm.listDebates();
    const debate = debates.find(d => d.id === debateId);
    if (!debate) {
      return {
        valid: false,
        error: `Debate "${debateId}" not found`,
        code: ERROR_CODES.DEBATE_NOT_FOUND,
      };
    }
    const participant = debate.participants.find(p => p.name === participantName);
    if (!participant) {
      return {
        valid: false,
        error: `Participant "${participantName}" not found in debate "${debateId}"`,
        code: ERROR_CODES.PARTICIPANT_NOT_FOUND,
      };
    }
    return { valid: true, participant };
  } catch (err) {
    return {
      valid: false,
      error: `Error checking participant: ${err.message}`,
      code: ERROR_CODES.STATE_CORRUPTED,
    };
  }
}

// ── Input Validators ────────────────────────────────────────────────────

function validateCreateDebate(topic, maxRounds, customRoles, intensidad) {
  // Validate topic
  const topicValidation = validateString(topic, 'topic', 3, 500);
  if (!topicValidation.valid) return topicValidation;

  // Validate maxRounds
  const roundsValidation = validateNumber(maxRounds, 'maxRounds', 0, 100);
  if (!roundsValidation.valid) return roundsValidation;

  // Validate intensity
  if (intensidad !== null && intensidad !== undefined) {
    const intensityValidation = validateEnum(
      intensidad,
      'intensidad',
      VALID_INTENSITIES
    );
    if (!intensityValidation.valid) return intensityValidation;
  }

  // Validate customRoles if provided
  if (customRoles !== null && customRoles !== undefined) {
    if (!Array.isArray(customRoles)) {
      return {
        valid: false,
        error: 'customRoles must be an array or null',
        code: ERROR_CODES.INVALID_TYPE,
      };
    }
    if (customRoles.length === 0) {
      return {
        valid: false,
        error: 'customRoles array cannot be empty',
        code: ERROR_CODES.INVALID_RANGE,
      };
    }
  }

  return { valid: true };
}

function validateJoinDebate(debateId, name, role) {
  // Validate debateId
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) return debateValidation;

  const debate = debateValidation.debate;

  // Validate name
  const nameValidation = validateString(name, 'name', 1, 100);
  if (!nameValidation.valid) return nameValidation;

  // Check if participant already exists
  if (debate.participants.some(p => p.name === name)) {
    return {
      valid: false,
      error: `Participant "${name}" already exists in debate "${debateId}"`,
      code: ERROR_CODES.PARTICIPANT_ALREADY_EXISTS,
    };
  }

  // Validate role if provided
  if (role !== null && role !== undefined) {
    const roleValidation = validateString(role, 'role', 1, 100);
    if (!roleValidation.valid) return roleValidation;
  }

  return { valid: true };
}

function validateSay(debateId, participantName, text) {
  // Validate debateId and check it exists
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) return debateValidation;

  const debate = debateValidation.debate;

  // Validate participant exists
  const participantValidation = validateParticipantExists(debateId, participantName);
  if (!participantValidation.valid) return participantValidation;

  // Validate message text
  const textValidation = validateString(
    text,
    'message text',
    MESSAGE_LIMITS.MIN_LENGTH,
    MESSAGE_LIMITS.MAX_LENGTH
  );
  if (!textValidation.valid) return textValidation;

  // Check word count based on intensity
  const wordCount = text.trim().split(/\s+/).length;
  const minWords = WORD_COUNT_LIMITS[debate.intensity] || 50;

  if (wordCount < minWords) {
    return {
      valid: false,
      error: `Message must be at least ${minWords} words (${debate.intensity} intensity). Got ${wordCount} words.`,
      code: ERROR_CODES.MESSAGE_TOO_SHORT,
    };
  }

  return { valid: true };
}

function validateRead(debateId, sinceIndex, limit) {
  // Validate debateId
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) return debateValidation;

  // Validate sinceIndex
  const sinceValidation = validateNumber(sinceIndex, 'sinceIndex', 0);
  if (!sinceValidation.valid) return sinceValidation;

  // Validate limit
  const limitValidation = validateNumber(limit, 'limit', 0, 1000);
  if (!limitValidation.valid) return limitValidation;

  return { valid: true };
}

function validateNextRound(debateId) {
  // Validate debateId
  return validateDebateExists(debateId);
}

function validateFinishDebate(debateId) {
  // Validate debateId
  return validateDebateExists(debateId);
}

function validateAutoDebate(topic, numAgents, intensidad) {
  // Validate topic
  const topicValidation = validateString(topic, 'topic', 3, 500);
  if (!topicValidation.valid) return topicValidation;

  // Validate numAgents
  const agentsValidation = validateNumber(numAgents, 'numAgents', 2, 20);
  if (!agentsValidation.valid) return agentsValidation;

  // Validate intensity
  if (intensidad) {
    const intensityValidation = validateEnum(
      intensidad,
      'intensidad',
      VALID_INTENSITIES
    );
    if (!intensityValidation.valid) return intensityValidation;
  }

  return { valid: true };
}

function validateSayBatch(debateId, messages) {
  // Validate debateId
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) return debateValidation;

  const debate = debateValidation.debate;

  // Validate messages is an array
  if (!Array.isArray(messages)) {
    return {
      valid: false,
      error: 'messages must be an array',
      code: ERROR_CODES.INVALID_TYPE,
    };
  }

  if (messages.length === 0) {
    return {
      valid: false,
      error: 'messages array cannot be empty',
      code: ERROR_CODES.INVALID_RANGE,
    };
  }

  if (messages.length > 50) {
    return {
      valid: false,
      error: 'messages array cannot exceed 50 items',
      code: ERROR_CODES.INVALID_RANGE,
    };
  }

  // Validate each message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (!msg || typeof msg !== 'object') {
      return {
        valid: false,
        error: `messages[${i}] must be an object`,
        code: ERROR_CODES.INVALID_TYPE,
      };
    }

    const { name, text } = msg;

    // Validate name
    const nameValidation = validateString(name, `messages[${i}].name`, 1, 100);
    if (!nameValidation.valid) return nameValidation;

    // Validate participant exists
    const participantValidation = validateParticipantExists(debateId, name);
    if (!participantValidation.valid) return participantValidation;

    // Validate text
    const textValidation = validateString(
      text,
      `messages[${i}].text`,
      MESSAGE_LIMITS.MIN_LENGTH,
      MESSAGE_LIMITS.MAX_LENGTH
    );
    if (!textValidation.valid) return textValidation;

    // Check word count
    const wordCount = text.trim().split(/\s+/).length;
    const minWords = WORD_COUNT_LIMITS[debate.intensity] || 50;

    if (wordCount < minWords) {
      return {
        valid: false,
        error: `messages[${i}] must be at least ${minWords} words. Got ${wordCount} words.`,
        code: ERROR_CODES.MESSAGE_TOO_SHORT,
      };
    }
  }

  return { valid: true };
}

function validateAddContext(debateId, source, text) {
  // Validate debateId
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) return debateValidation;

  // Validate source
  const sourceValidation = validateString(source, 'source', 1, 255);
  if (!sourceValidation.valid) return sourceValidation;

  // Validate text
  const textValidation = validateString(text, 'context text', 5, 100000);
  if (!textValidation.valid) return textValidation;

  return { valid: true };
}

function validateCrearSituacion(tipo, contexto, numAgents) {
  // Validate tipo
  const tipoValidation = validateEnum(tipo, 'tipo', VALID_SITUACION_TYPES);
  if (!tipoValidation.valid) return tipoValidation;

  // Validate numAgents
  const agentsValidation = validateNumber(numAgents, 'numAgents', 0, 20);
  if (!agentsValidation.valid) return agentsValidation;

  // Validate contexto
  if (contexto) {
    const contextoValidation = validateString(contexto, 'contexto', 1, 10000);
    if (!contextoValidation.valid) return contextoValidation;
  }

  return { valid: true };
}

// ── State Health Check ──────────────────────────────────────────────────

function healthCheck() {
  const issues = [];

  // Check if state file exists and is readable
  const stateFile = path.join(__dirname, 'debates.json');
  if (!fs.existsSync(stateFile)) {
    issues.push('State file (debates.json) does not exist');
    return { healthy: false, issues };
  }

  let state;
  try {
    const content = fs.readFileSync(stateFile, 'utf-8');
    state = JSON.parse(content);
  } catch (err) {
    issues.push(`State file is corrupted: ${err.message}`);
    return { healthy: false, issues };
  }

  // Check state structure
  if (!state || typeof state !== 'object') {
    issues.push('State is not a valid object');
  }

  if (!state.debates || typeof state.debates !== 'object') {
    issues.push('State.debates is missing or not an object');
  }

  if (typeof state.nextId !== 'number') {
    issues.push('State.nextId is missing or not a number');
  }

  // Check debates integrity
  if (state.debates) {
    Object.entries(state.debates).forEach(([debateId, debate]) => {
      // Check required fields
      const requiredFields = [
        'id',
        'topic',
        'status',
        'participants',
        'messages',
        'currentRound',
      ];
      requiredFields.forEach(field => {
        if (!(field in debate)) {
          issues.push(`Debate "${debateId}" missing field: ${field}`);
        }
      });

      // Check field types
      if (typeof debate.id !== 'string') {
        issues.push(`Debate "${debateId}" has invalid id type`);
      }
      if (!Array.isArray(debate.participants)) {
        issues.push(`Debate "${debateId}" participants is not an array`);
      }
      if (!Array.isArray(debate.messages)) {
        issues.push(`Debate "${debateId}" messages is not an array`);
      }

      // Check for null/undefined participants
      if (Array.isArray(debate.participants)) {
        debate.participants.forEach((p, i) => {
          if (!p) {
            issues.push(`Debate "${debateId}" has null/undefined participant at index ${i}`);
          }
        });
      }

      // Check message structure
      if (Array.isArray(debate.messages)) {
        debate.messages.forEach((msg, i) => {
          if (!msg || typeof msg !== 'object') {
            issues.push(`Debate "${debateId}" message[${i}] is invalid`);
          }
          if (msg && (!msg.name || !msg.text || typeof msg.timestamp !== 'number')) {
            issues.push(`Debate "${debateId}" message[${i}] has missing fields`);
          }
        });
      }
    });
  }

  return {
    healthy: issues.length === 0,
    issues,
  };
}

// ── State Recovery ──────────────────────────────────────────────────────

function recoverState() {
  const actions = [];
  const stateFile = path.join(__dirname, 'debates.json');

  try {
    // Step 1: Try to load and parse
    let state;
    if (fs.existsSync(stateFile)) {
      try {
        const content = fs.readFileSync(stateFile, 'utf-8');
        state = JSON.parse(content);
        actions.push('Loaded existing state');
      } catch (err) {
        actions.push(`State file corrupted, rebuilding: ${err.message}`);
        state = { debates: {}, nextId: 1 };
      }
    } else {
      actions.push('State file missing, creating new state');
      state = { debates: {}, nextId: 1 };
    }

    // Step 2: Fix state structure
    if (!state.debates || typeof state.debates !== 'object') {
      actions.push('Fixed corrupted debates object');
      state.debates = {};
    }

    if (typeof state.nextId !== 'number') {
      actions.push('Fixed corrupted nextId');
      state.nextId = 1;
    }

    // Step 3: Remove debates with missing required fields
    Object.entries(state.debates).forEach(([debateId, debate]) => {
      const requiredFields = [
        'id',
        'topic',
        'status',
        'participants',
        'messages',
        'currentRound',
      ];
      const hasAllFields = requiredFields.every(f => f in debate);
      const isValidType =
        Array.isArray(debate.participants) && Array.isArray(debate.messages);

      if (!hasAllFields || !isValidType) {
        delete state.debates[debateId];
        actions.push(`Removed debate "${debateId}" with corrupted fields`);
      }
    });

    // Step 4: Fix participant arrays with null entries
    Object.entries(state.debates).forEach(([debateId, debate]) => {
      const originalLength = debate.participants.length;
      debate.participants = debate.participants.filter(p => p !== null && p !== undefined);
      if (debate.participants.length < originalLength) {
        actions.push(
          `Debate "${debateId}" cleaned ${originalLength - debate.participants.length} null participants`
        );
      }
    });

    // Step 5: Fix message arrays with null entries
    Object.entries(state.debates).forEach(([debateId, debate]) => {
      const originalLength = debate.messages.length;
      debate.messages = debate.messages.filter(m => m !== null && m !== undefined);
      if (debate.messages.length < originalLength) {
        actions.push(
          `Debate "${debateId}" cleaned ${originalLength - debate.messages.length} null messages`
        );
      }
    });

    // Step 6: Recalculate nextId
    let maxId = 1;
    Object.keys(state.debates).forEach(debateId => {
      // Extract number from "debate-NNN" format
      const match = debateId.match(/debate-(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= maxId) {
          maxId = num + 1;
        }
      }
    });
    const oldNextId = state.nextId;
    state.nextId = maxId;
    if (oldNextId !== maxId) {
      actions.push(`Reset nextId from ${oldNextId} to ${maxId}`);
    }

    // Step 7: Write recovered state back
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
    actions.push('Recovered state saved to disk');

    return {
      recovered: true,
      actions,
    };
  } catch (err) {
    return {
      recovered: false,
      actions: [...actions, `Recovery failed: ${err.message}`],
    };
  }
}

// ── Safe Wrapper Functions ──────────────────────────────────────────────

function safeCreateDebate(topic, maxRounds = 10, customRoles = null, intensidad = 'adversarial') {
  // Rate limit by topic
  const rateLimitCheck = rateLimit('createDebate', topic, 10);
  if (!rateLimitCheck.allowed) {
    return {
      success: false,
      error: rateLimitCheck.error,
      code: rateLimitCheck.code,
    };
  }

  const validation = validateCreateDebate(topic, maxRounds, customRoles, intensidad);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.createDebate(topic, maxRounds, customRoles, intensidad);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeJoinDebate(debateId, name, role = null) {
  // Rate limit by participant name
  const rateLimitCheck = rateLimit('joinDebate', name, 20);
  if (!rateLimitCheck.allowed) {
    return {
      success: false,
      error: rateLimitCheck.error,
      code: rateLimitCheck.code,
    };
  }

  const validation = validateJoinDebate(debateId, name, role);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.joinDebate(debateId, name, role);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeSay(debateId, participantName, text) {
  // Rate limit by participant
  const rateLimitCheck = rateLimit('say', participantName, 30);
  if (!rateLimitCheck.allowed) {
    return {
      success: false,
      error: rateLimitCheck.error,
      code: rateLimitCheck.code,
    };
  }

  const validation = validateSay(debateId, participantName, text);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.say(debateId, participantName, text);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeRead(debateId, sinceIndex = 0, limit = 0) {
  const validation = validateRead(debateId, sinceIndex, limit);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.read(debateId, sinceIndex, limit);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeNextRound(debateId, force = false) {
  const validation = validateNextRound(debateId);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.nextRound(debateId, force);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeFinishDebate(debateId, synthesis = null) {
  const validation = validateFinishDebate(debateId);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.finishDebate(debateId, synthesis);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeAutoDebate(topic, numAgents = 3, maxRounds = 10, intensidad = 'adversarial') {
  // Rate limit by topic
  const rateLimitCheck = rateLimit('autoDebate', topic, 5);
  if (!rateLimitCheck.allowed) {
    return {
      success: false,
      error: rateLimitCheck.error,
      code: rateLimitCheck.code,
    };
  }

  const validation = validateAutoDebate(topic, numAgents, intensidad);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.autoDebate(topic, numAgents, maxRounds, intensidad);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeSayBatch(debateId, messages) {
  // Rate limit by debate
  const rateLimitCheck = rateLimit('sayBatch', debateId, 10);
  if (!rateLimitCheck.allowed) {
    return {
      success: false,
      error: rateLimitCheck.error,
      code: rateLimitCheck.code,
    };
  }

  const validation = validateSayBatch(debateId, messages);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.sayBatch(debateId, messages);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeAddContext(debateId, source, text, category = 'general') {
  const validation = validateAddContext(debateId, source, text);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.addContext(debateId, source, text, category);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeCrearSituacion(tipo, contexto, numAgents = 0) {
  // Rate limit by tipo
  const rateLimitCheck = rateLimit('crearSituacion', tipo, 10);
  if (!rateLimitCheck.allowed) {
    return {
      success: false,
      error: rateLimitCheck.error,
      code: rateLimitCheck.code,
    };
  }

  const validation = validateCrearSituacion(tipo, contexto, numAgents);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error,
      code: validation.code,
    };
  }

  try {
    const result = dm.crearSituacion(tipo, contexto, numAgents);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

// Passthrough wrappers for operations that don't need validation
function safeListDebates() {
  try {
    const result = dm.listDebates();
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeGetActiveDebate() {
  try {
    const result = dm.getActiveDebate();
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeSuggestRoles(topic) {
  const topicValidation = validateString(topic, 'topic', 3, 500);
  if (!topicValidation.valid) {
    return {
      success: false,
      error: topicValidation.error,
      code: topicValidation.code,
    };
  }

  try {
    const result = dm.suggestRoles(topic);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeGetCurrentPhase(round, phases) {
  if (typeof round !== 'number' || round < 0) {
    return {
      success: false,
      error: 'round must be a non-negative number',
      code: ERROR_CODES.INVALID_TYPE,
    };
  }

  if (!Array.isArray(phases)) {
    return {
      success: false,
      error: 'phases must be an array',
      code: ERROR_CODES.INVALID_TYPE,
    };
  }

  try {
    const result = dm.getCurrentPhase(round, phases);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeGetNextTurn(debateId) {
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) {
    return {
      success: false,
      error: debateValidation.error,
      code: debateValidation.code,
    };
  }

  try {
    const result = dm.getNextTurn(debateId);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeGetAllPendingTurns(debateId) {
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) {
    return {
      success: false,
      error: debateValidation.error,
      code: debateValidation.code,
    };
  }

  try {
    const result = dm.getAllPendingTurns(debateId);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeGetKnowledgeBase(debateId) {
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) {
    return {
      success: false,
      error: debateValidation.error,
      code: debateValidation.code,
    };
  }

  try {
    const result = dm.getKnowledgeBase(debateId);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeGetKnowledgeSource(debateId, sourceId) {
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) {
    return {
      success: false,
      error: debateValidation.error,
      code: debateValidation.code,
    };
  }

  if (typeof sourceId !== 'string') {
    return {
      success: false,
      error: 'sourceId must be a string',
      code: ERROR_CODES.INVALID_TYPE,
    };
  }

  try {
    const result = dm.getKnowledgeSource(debateId, sourceId);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeListSituaciones() {
  try {
    const result = dm.listSituaciones();
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function safeGetWorkflowStatus(debateId) {
  const debateValidation = validateDebateExists(debateId);
  if (!debateValidation.valid) {
    return {
      success: false,
      error: debateValidation.error,
      code: debateValidation.code,
    };
  }

  try {
    const result = dm.getWorkflowStatus(debateId);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

function saveSaveStateNow() {
  try {
    dm.saveStateNow();
    return { success: true, data: 'State saved' };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      code: ERROR_CODES.UNKNOWN_ERROR,
    };
  }
}

// ── Module Exports ──────────────────────────────────────────────────────

module.exports = {
  // Error codes
  ERROR_CODES,

  // Input validators
  validateCreateDebate,
  validateJoinDebate,
  validateSay,
  validateRead,
  validateNextRound,
  validateFinishDebate,
  validateAutoDebate,
  validateSayBatch,
  validateAddContext,
  validateCrearSituacion,

  // Utility validators
  validateString,
  validateNumber,
  validateEnum,
  validateDebateExists,
  validateParticipantExists,

  // Health & Recovery
  healthCheck,
  recoverState,

  // Rate limiting
  rateLimit,

  // Safe wrappers (all debate-manager operations)
  safeCreateDebate,
  safeJoinDebate,
  safeSay,
  safeRead,
  safeNextRound,
  safeFinishDebate,
  safeAutoDebate,
  safeSayBatch,
  safeAddContext,
  safeCrearSituacion,
  safeListDebates,
  safeGetActiveDebate,
  safeSuggestRoles,
  safeGetCurrentPhase,
  safeGetNextTurn,
  safeGetAllPendingTurns,
  safeGetKnowledgeBase,
  safeGetKnowledgeSource,
  safeListSituaciones,
  safeGetWorkflowStatus,
  saveSaveStateNow,
};
