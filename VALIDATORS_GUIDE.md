# Validators Module Guide

## Overview

The `validators.cjs` module provides a comprehensive robustness and validation layer for the Multi-Agent Debate System. It acts as a defensive wrapper around all `debate-manager.cjs` operations, catching errors before they corrupt state.

**File Location:** `/sessions/laughing-serene-maxwell/mnt/multi-agent-chat/validators.cjs`
**Size:** 1,285 lines

## Features

### 1. Input Validation
All debate-manager operations have dedicated validators that check:
- Null/undefined values
- Type correctness
- String length constraints
- Numeric ranges
- Enum validity
- Debate existence and status
- Participant existence
- Message word counts (based on intensity level)

### 2. Safe Wrappers
Each debate-manager function has a corresponding `safe*` wrapper that:
1. Runs input validation
2. Checks rate limits
3. Wraps call in try/catch
4. Returns standardized response format: `{ success: boolean, data?: any, error?: string, code?: string }`

### 3. State Health Checks
```javascript
const { healthy, issues } = validators.healthCheck();
```
Validates:
- State file existence and parsability
- State structure (debates object, nextId)
- Debate field completeness
- Participant array integrity
- Message structure validity

### 4. Automatic State Recovery
```javascript
const { recovered, actions } = validators.recoverState();
```
Automatically:
- Rebuilds corrupted state from default
- Removes debates with missing fields
- Cleans null/undefined entries from arrays
- Recalculates nextId based on existing debates
- Persists recovered state to disk

### 5. Rate Limiting
```javascript
const { allowed, remaining, retryAfter } = validators.rateLimit(operation, key, maxPerMinute);
```
In-memory rate limiter with per-operation, per-key tracking:
- `createDebate`: 10 per minute per topic
- `joinDebate`: 20 per minute per participant
- `say`: 30 per minute per participant
- `autoDebate`: 5 per minute per topic
- `sayBatch`: 10 per minute per debate
- `crearSituacion`: 10 per minute per situacion type

## Error Codes

The module defines 24 error codes covering all failure scenarios:

```javascript
// Debate-related
DEBATE_NOT_FOUND
DEBATE_FINISHED
DEBATE_FULL
DEBATE_ALREADY_ACTIVE

// Participant-related
PARTICIPANT_NOT_FOUND
PARTICIPANT_ALREADY_EXISTS

// Input validation
INVALID_TOPIC
INVALID_ROUNDS
INVALID_INTENSITY
INVALID_SITUACION_TYPE
INVALID_NUM_AGENTS

// Message-related
MESSAGE_EMPTY
MESSAGE_TOO_SHORT
MESSAGE_TOO_LONG

// Knowledge base
KB_SOURCE_NOT_FOUND
KB_SOURCE_DUPLICATE
KB_INVALID_SOURCE

// System
STATE_CORRUPTED
UNKNOWN_ERROR
RATE_LIMITED
INVALID_NULL
INVALID_TYPE
INVALID_RANGE
INVALID_ENUM
```

## Usage Examples

### Creating a Debate (Safe)
```javascript
const validators = require('./validators.cjs');

const result = validators.safeCreateDebate(
  'How should we handle technical debt?',
  10,
  null,
  'adversarial'
);

if (result.success) {
  console.log('Debate created:', result.data.id);
} else {
  console.error(`Error [${result.code}]: ${result.error}`);
}
```

### Joining a Debate (Safe)
```javascript
const result = validators.safeJoinDebate(
  'debate-001',
  'Alice',
  'architect-software'
);

if (!result.success) {
  console.error(result.code, result.error);
}
```

### Posting a Message (Safe)
```javascript
const result = validators.safeSay(
  'debate-001',
  'Alice',
  'Technical debt is a strategic investment that allows us to move faster. We can always refactor later. The cost of perfect code now is opportunity cost.'
);

if (!result.success && result.code === validators.ERROR_CODES.MESSAGE_TOO_SHORT) {
  console.error('Your message is too short for adversarial intensity (min 150 words)');
}
```

### Health Check & Recovery
```javascript
const health = validators.healthCheck();

if (!health.healthy) {
  console.log('State issues found:', health.issues);
  
  // Attempt recovery
  const recovery = validators.recoverState();
  console.log('Recovery actions:', recovery.actions);
  
  // Check again
  const recheck = validators.healthCheck();
  console.log('State is now:', recheck.healthy ? 'healthy' : 'still corrupted');
}
```

### Rate Limiting
```javascript
const { allowed, remaining, retryAfter } = validators.rateLimit(
  'say',
  'participant-name',
  30 // max per minute
);

if (!allowed) {
  console.error(`Rate limited. Retry after ${retryAfter} seconds`);
} else {
  console.log(`Message posted. ${remaining} messages remaining this minute.`);
}
```

## Validators Available

### Input Validators (return `{valid: boolean, error?: string, code?: string}`)

```javascript
validateCreateDebate(topic, maxRounds, customRoles, intensidad)
validateJoinDebate(debateId, name, role)
validateSay(debateId, participantName, text)
validateRead(debateId, sinceIndex, limit)
validateNextRound(debateId)
validateFinishDebate(debateId)
validateAutoDebate(topic, numAgents, intensidad)
validateSayBatch(debateId, messages)
validateAddContext(debateId, source, text)
validateCrearSituacion(tipo, contexto, numAgents)

// Utility validators
validateString(value, fieldName, minLength, maxLength)
validateNumber(value, fieldName, minValue, maxValue)
validateEnum(value, fieldName, validValues)
validateDebateExists(debateId)
validateParticipantExists(debateId, participantName)
```

### Safe Wrappers (return `{success: boolean, data?: any, error?: string, code?: string}`)

```javascript
safeCreateDebate(topic, maxRounds, customRoles, intensidad)
safeJoinDebate(debateId, name, role)
safeSay(debateId, participantName, text)
safeRead(debateId, sinceIndex, limit)
safeNextRound(debateId, force)
safeFinishDebate(debateId, synthesis)
safeAutoDebate(topic, numAgents, maxRounds, intensidad)
safeSayBatch(debateId, messages)
safeAddContext(debateId, source, text, category)
safeCrearSituacion(tipo, contexto, numAgents)

// Passthrough wrappers (minimal validation)
safeListDebates()
safeGetActiveDebate()
safeSuggestRoles(topic)
safeGetCurrentPhase(round, phases)
safeGetNextTurn(debateId)
safeGetAllPendingTurns(debateId)
safeGetKnowledgeBase(debateId)
safeGetKnowledgeSource(debateId, sourceId)
safeListSituaciones()
safeGetWorkflowStatus(debateId)
saveSaveStateNow()
```

## Validation Rules

### Message Length Requirements
Messages must meet intensity-based word count minimums:
- **casual:** 50 words minimum
- **moderado:** 100 words minimum
- **adversarial:** 150 words minimum

Additionally:
- Maximum 10,000 characters per message
- Minimum 5 characters to start validation
- Maximum 50 messages in a batch

### Topic Requirements
- 3-500 characters
- Non-empty when trimmed

### Rounds Requirements
- 0-100 valid range
- 0 = continuous mode
- 1+ = fixed number of rounds

### Intensity Values
- `casual`
- `moderado`
- `adversarial`

### Situacion Types
- `libre`
- `identificar_problemas`
- `arquitectura`
- `ejecucion`

### Participant Requirements
- 1-100 characters name
- Must exist in debate
- No duplicate names in same debate

## State Structure Validation

The `healthCheck()` function validates:

```javascript
state = {
  debates: {
    [debateId]: {
      id: string,
      topic: string,
      status: 'active' | 'finished',
      category: string,
      participants: [{
        name: string,
        role: string,
        index: number
      }, ...],
      messages: [{
        index: number,
        name: string,
        text: string,
        timestamp: number
      }, ...],
      currentRound: number,
      maxRounds: number,
      // ... other fields
    }
  },
  nextId: number
}
```

## Integration Pattern

Recommended pattern for using validators in your application:

```javascript
const validators = require('./validators.cjs');

// At startup
const health = validators.healthCheck();
if (!health.healthy) {
  console.warn('State issues detected:', health.issues);
  const recovery = validators.recoverState();
  console.log('Recovery attempted:', recovery.actions);
}

// For all operations
const result = validators.safeCreateDebate(topic, rounds, roles, intensity);
if (!result.success) {
  // Handle error with specific code
  if (result.code === validators.ERROR_CODES.RATE_LIMITED) {
    // Return 429 Too Many Requests
  } else if (result.code === validators.ERROR_CODES.INVALID_TOPIC) {
    // Return 400 Bad Request
  } else {
    // Return 500 Internal Server Error
  }
} else {
  // Use result.data
  const debate = result.data;
}
```

## Performance Notes

- **Rate limiter:** O(1) per-key lookup via Map
- **Validators:** All input validators run in O(n) where n is content length
- **Health check:** O(d + p + m) where d=debates, p=participants, m=messages
- **State recovery:** O(d + p + m) with one disk write at end

## Thread Safety

The module is **NOT thread-safe** in Node.js due to:
- Rate limiter uses in-memory Map without locks
- No mutex on state file operations
- Multiple simultaneous calls could cause race conditions

For multi-threaded/clustered deployments, consider:
- Using Redis for rate limiting
- Adding file locks for state persistence
- Using process isolation with IPC

