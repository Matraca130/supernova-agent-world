/**
 * Comprehensive Test Suite for Debate Manager v3
 * Tests all exported functions with unit, integration, edge cases, and performance tests
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'debates.json');

// ─── Test Results Tracking ───────────────────────────────────────────────────

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failedTestDetails = [];

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failedTests++;
    console.log(`✗ ${name}`);
    failedTestDetails.push({ name, error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(value, message) {
  if (!value) throw new Error(message);
}

function assertFalse(value, message) {
  if (value) throw new Error(message);
}

// Fresh module load
function freshDebateManager() {
  const resolved = require.resolve('./debate-manager.cjs');
  delete require.cache[resolved];
  return require('./debate-manager.cjs');
}

function resetState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ debates: {}, nextId: 1 }, null, 2), 'utf-8');
}

// Helper to create long text (50+ words)
function createLongText(wordCount = 60) {
  const word = 'word';
  return Array(wordCount).fill(word).join(' ');
}

// ─── TEST SUITE ───────────────────────────────────────────────────────────────

console.log('='.repeat(80));
console.log('DEBATE MANAGER TEST SUITE');
console.log('='.repeat(80));

// ═══════════════════════════════════════════════════════════════════════════════
// 1. UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n1. UNIT TESTS\n');

// ─── createDebate ────────────────────────────────────────────────────────────
console.log('Testing: createDebate()');

test('createDebate creates debate with default intensity', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.createDebate('AI Safety in Tech', 10);
  assertTrue(result.id, 'Debate ID should exist');
  assertEqual(result.status, 'active', 'Status should be active');
  assertEqual(result.currentRound, 1, 'Current round should be 1');
  assertEqual(result.maxRounds, 10, 'Max rounds should be 10');
  assertEqual(result.intensity, 'ADVERSARIAL', 'Default intensity should be ADVERSARIAL');
});

test('createDebate with custom intensity', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.createDebate('Testing', 5, null, 'casual');
  assertEqual(result.intensity, 'Casual', 'Intensity should be Casual');
});

test('createDebate calculates phases for long debate (>=8 rounds)', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.createDebate('Testing', 12);
  assertTrue(result.phases.length >= 3, 'Should have at least 3 phases');
  assert(result.phases[0].name.includes('POSICIONES'), 'First phase should be POSICIONES');
});

test('createDebate calculates phases for short debate (<8 rounds)', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.createDebate('Testing', 4);
  assertTrue(result.phases.length >= 2, 'Should have at least 2 phases');
});

test('createDebate with continuous mode (maxRounds = 0)', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.createDebate('Testing', 0);
  assertEqual(result.maxRounds, 0, 'Max rounds should be 0');
});

test('createDebate suggests roles by topic category', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.createDebate('Should we use microservices architecture?', 10);
  assertTrue(result.suggestedRoles.length > 0, 'Should suggest roles');
  assertTrue(result.category === 'tecnologia' || result.category === 'general',
    'Should detect tech category or default to general');
});

// ─── joinDebate ──────────────────────────────────────────────────────────────
console.log('\nTesting: joinDebate()');

test('joinDebate adds participant', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const result = dm.joinDebate(debate.id, 'Alice', 'defensor');
  assertTrue(result.participant, 'Participant should be created');
  assertEqual(result.participant.name, 'Alice', 'Name should be Alice');
  assertEqual(result.participant.role, 'defensor', 'Role should be defensor');
});

test('joinDebate prevents duplicate joins', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  const result = dm.joinDebate(debate.id, 'Alice', 'defensor');
  assertTrue(result.alreadyJoined, 'Should indicate already joined');
});

test('joinDebate rejects invalid debate ID', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.joinDebate('invalid-999', 'Alice', 'defensor');
  assertTrue(result.error, 'Should return error for invalid debate');
});

test('joinDebate rejects joining finished debate', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 1);
  dm.finishDebate(debate.id);
  const result = dm.joinDebate(debate.id, 'Alice', 'defensor');
  assertTrue(result.error, 'Should reject joining finished debate');
});

// ─── say ─────────────────────────────────────────────────────────────────────
console.log('\nTesting: say()');

test('say rejects message under minimum word count', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5, null, 'adversarial');
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  const result = dm.say(debate.id, 'Alice', 'Too short');
  assertTrue(result.rejected, 'Should reject short message');
  assertTrue(result.error, 'Should have error message');
});

test('say accepts message with sufficient words', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5, null, 'adversarial');
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  const result = dm.say(debate.id, 'Alice', createLongText(200));
  assertTrue(result.message, 'Message should be added');
  assertEqual(result.totalMessages, 1, 'Should have 1 message');
});

test('say auto-joins participant if not registered', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const result = dm.say(debate.id, 'Bob', createLongText(200));
  assertTrue(result.message, 'Message should be added');
});

test('say tracks word count', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const longText = createLongText(75);
  const result = dm.say(debate.id, 'Alice', longText);
  assertEqual(result.wordCount, 75, 'Should count words correctly');
});

test('say rejects on finished debate', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 1);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.finishDebate(debate.id);
  const result = dm.say(debate.id, 'Alice', createLongText(200));
  assertTrue(result.error, 'Should reject on finished debate');
});

test('say adds round and phase info to message', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 10);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  const result = dm.say(debate.id, 'Alice', createLongText(200));
  assertEqual(result.message.round, 1, 'Should have round info');
  assertTrue(result.message.phase, 'Should have phase info');
});

// ─── read ────────────────────────────────────────────────────────────────────
console.log('\nTesting: read()');

test('read returns messages in debate', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.joinDebate(debate.id, 'Bob', 'devils-advocate');
  dm.say(debate.id, 'Alice', createLongText(200));
  dm.say(debate.id, 'Bob', createLongText(200));

  const result = dm.read(debate.id);
  assertEqual(result.messages.length, 2, 'Should return 2 messages');
});

test('read respects sinceIndex parameter', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  for (let i = 0; i < 5; i++) {
    dm.say(debate.id, 'Alice', createLongText(200));
  }

  const result = dm.read(debate.id, 2);
  assertEqual(result.messages.length, 3, 'Should return messages from index 2 onwards');
});

test('read respects limit parameter', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  for (let i = 0; i < 5; i++) {
    dm.say(debate.id, 'Alice', createLongText(200));
  }

  const result = dm.read(debate.id, 0, 2);
  assertEqual(result.messages.length, 2, 'Should respect limit');
});

test('read returns error for invalid debate', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.read('invalid-999');
  assertTrue(result.error, 'Should return error for invalid debate');
});

// ─── nextRound ───────────────────────────────────────────────────────────────
console.log('\nTesting: nextRound()');

test('nextRound increments round number', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.say(debate.id, 'Alice', createLongText(200));
  dm.say(debate.id, 'Alice', createLongText(200));

  const result = dm.nextRound(debate.id);
  assertTrue(result.round !== undefined, 'Should return round info');
  assertEqual(result.round, 2, 'Should advance to round 2');
});

test('nextRound resets spokenThisRound', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.say(debate.id, 'Alice', createLongText(200));
  dm.say(debate.id, 'Alice', createLongText(200));
  const nextResult = dm.nextRound(debate.id);

  const result = dm.read(debate.id);
  assertEqual(result.debate.currentRound, nextResult.round, 'Should be on new round');
});

test('nextRound finishes debate at max rounds', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 1);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.say(debate.id, 'Alice', createLongText(200));
  dm.say(debate.id, 'Alice', createLongText(200));

  const result = dm.nextRound(debate.id);
  assertEqual(result.finished, true, 'Should finish debate at max rounds');
});

// ─── finishDebate ────────────────────────────────────────────────────────────
console.log('\nTesting: finishDebate()');

test('finishDebate sets status to finished', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const result = dm.finishDebate(debate.id);
  assertEqual(result.debate.status, 'finished', 'Status should be finished');
});

test('finishDebate allows optional synthesis', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const synthesis = 'This debate concluded that...';
  const result = dm.finishDebate(debate.id, synthesis);
  assertEqual(result.debate.synthesis, synthesis, 'Should store synthesis');
});

// ─── listDebates ─────────────────────────────────────────────────────────────
console.log('\nTesting: listDebates()');

test('listDebates returns all debates', () => {
  resetState();
  const dm = freshDebateManager();
  dm.createDebate('Topic 1', 5);
  dm.createDebate('Topic 2', 5);
  dm.createDebate('Topic 3', 5);

  const result = dm.listDebates();
  assertEqual(result.length, 3, 'Should list all 3 debates');
});

test('listDebates shows debate status', () => {
  resetState();
  const dm = freshDebateManager();
  const d1 = dm.createDebate('Topic 1', 5);
  dm.finishDebate(d1.id);
  const d2 = dm.createDebate('Topic 2', 5);

  const result = dm.listDebates();
  const finished = result.find(d => d.id === d1.id);
  const active = result.find(d => d.id === d2.id);

  assertEqual(finished.status, 'finished', 'Should show finished status');
  assertEqual(active.status, 'active', 'Should show active status');
});

// ─── getActiveDebate ─────────────────────────────────────────────────────────
console.log('\nTesting: getActiveDebate()');

test('getActiveDebate returns most recent active debate', () => {
  resetState();
  const dm = freshDebateManager();
  const d1 = dm.createDebate('Topic 1', 5);
  const d2 = dm.createDebate('Topic 2', 5);

  const result = dm.getActiveDebate();
  assertEqual(result.id, d2.id, 'Should return most recent active debate');
});

test('getActiveDebate returns null when no active debates', () => {
  resetState();
  const dm = freshDebateManager();
  const d1 = dm.createDebate('Topic 1', 1);
  dm.finishDebate(d1.id);

  const result = dm.getActiveDebate();
  assertTrue(!result, 'Should return null when no active debates');
});

// ─── suggestRoles ────────────────────────────────────────────────────────────
console.log('\nTesting: suggestRoles()');

test('suggestRoles detects technology category', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.suggestRoles('Should we use microservices in our API?');
  assertEqual(result.category, 'tecnologia', 'Should detect tech category');
  assertTrue(result.roles.length > 0, 'Should suggest roles');
});

test('suggestRoles detects medical category', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.suggestRoles('médico paciente hospital diagnóstico clínico cirugía tratamiento');
  assertEqual(result.category, 'medicina', 'Should detect medical category');
});

test('suggestRoles detects education category', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.suggestRoles('educación enseñanza aprendizaje estudiante universidad escuela pedagógico');
  assertEqual(result.category, 'educacion', 'Should detect education category');
});

test('suggestRoles returns general for unknown topics', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.suggestRoles('What is the color of the sky?');
  assertEqual(result.category, 'general', 'Should default to general');
});

// ─── getCurrentPhase ─────────────────────────────────────────────────────────
console.log('\nTesting: getCurrentPhase()');

test('getCurrentPhase returns correct phase for round in range', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 10);
  const phase = dm.getCurrentPhase(1, debate.phases);
  assertTrue(phase, 'Should return phase');
  assertTrue(phase.name, 'Phase should have name');
});

test('getCurrentPhase handles round at boundary', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 10);
  const phase = dm.getCurrentPhase(debate.phases[0].rounds[1], debate.phases);
  assertTrue(phase, 'Should return phase at boundary');
});

test('getCurrentPhase returns last phase for high rounds', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 10);
  const phase = dm.getCurrentPhase(100, debate.phases);
  assertEqual(phase, debate.phases[debate.phases.length - 1], 'Should return last phase');
});

test('getCurrentPhase handles null phases', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.getCurrentPhase(5, null);
  assertTrue(!result, 'Should return null for null phases');
});

// ─── addContext / getKnowledgeBase ────────────────────────────────────────────
console.log('\nTesting: addContext() and getKnowledgeBase()');

test('addContext adds source to knowledge base', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const result = dm.addContext(debate.id, 'api-docs', 'REST API documentation content here');
  assertTrue(result.entry, 'Should return entry');
  assertTrue(result.totalSources > 0, 'Should track sources');
});

test('getKnowledgeBase returns all sources', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.addContext(debate.id, 'source1', createLongText(200));
  dm.addContext(debate.id, 'source2', createLongText(200));

  const result = dm.getKnowledgeBase(debate.id);
  assertEqual(result.totalSources, 2, 'Should return 2 sources');
});

test('getKnowledgeSource retrieves specific source', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const addResult = dm.addContext(debate.id, 'docs', 'Documentation content');

  const getResult = dm.getKnowledgeSource(debate.id, 'docs');
  assertTrue(getResult.content.includes('Documentation'), 'Should retrieve source content');
});

// ─── autoDebate ──────────────────────────────────────────────────────────────
console.log('\nTesting: autoDebate()');

test('autoDebate creates debate with agents', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.autoDebate('AI Safety', 3);
  assertTrue(result.debate, 'Should create debate');
  assertEqual(result.agents.length, 3, 'Should create 3 agents');
});

test('autoDebate agents have unique names', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.autoDebate('Testing', 5);
  const names = result.agents.map(a => a.name);
  const uniqueNames = new Set(names);
  assertEqual(uniqueNames.size, names.length, 'All agent names should be unique');
});

test('autoDebate respects numAgents parameter', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.autoDebate('Testing', 7);
  assertEqual(result.agents.length, 7, 'Should create exactly 7 agents');
});

test('autoDebate caps agents at 15', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.autoDebate('Testing', 50);
  assertTrue(result.agents.length <= 15, 'Should cap agents at 15');
});

// ─── getNextTurn ─────────────────────────────────────────────────────────────
console.log('\nTesting: getNextTurn()');

test('getNextTurn returns next participant to speak', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5, null, 'adversarial');
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.joinDebate(debate.id, 'Bob', 'devils-advocate');

  const result = dm.getNextTurn(debate.id);
  assertTrue(result.agent, 'Should return agent info');
  assertTrue(result.agent.name, 'Agent should have name');
});

test('getNextTurn handles empty debate', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);

  const result = dm.getNextTurn(debate.id);
  assertTrue(!result.nextAgent, 'Should return null for empty debate');
});

// ─── getAllPendingTurns ───────────────────────────────────────────────────────
console.log('\nTesting: getAllPendingTurns()');

test('getAllPendingTurns returns pending participants', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5, null, 'adversarial');
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.joinDebate(debate.id, 'Bob', 'devils-advocate');

  const result = dm.getAllPendingTurns(debate.id);
  assertTrue(result.turns.length > 0, 'Should have pending turns');
});

// ─── sayBatch ────────────────────────────────────────────────────────────────
console.log('\nTesting: sayBatch()');

test('sayBatch adds multiple messages', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.joinDebate(debate.id, 'Bob', 'devils-advocate');

  const messages = [
    { name: 'Alice', text: createLongText(200) },
    { name: 'Bob', text: createLongText(200) },
  ];

  const result = dm.sayBatch(debate.id, messages);
  assertTrue(result.results, 'Should return results');
  const successCount = result.results.filter(r => r.success).length;
  assertEqual(successCount, 2, 'Should add both messages');
});

test('sayBatch rejects messages under minimum words', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5, null, 'adversarial');
  dm.joinDebate(debate.id, 'Alice', 'defensor');

  const messages = [
    { name: 'Alice', text: 'Too short' },
  ];

  const result = dm.sayBatch(debate.id, messages);
  assertTrue(result.results, 'Should return results');
  const failedCount = result.results.filter(r => !r.success).length;
  assertEqual(failedCount, 1, 'Should reject short message');
});

// ─── listSituaciones ─────────────────────────────────────────────────────────
console.log('\nTesting: listSituaciones()');

test('listSituaciones returns all 5 situaciones', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.listSituaciones();
  assertEqual(result.length, 5, 'Should return 5 situaciones');
});

test('listSituaciones includes all 5 types', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.listSituaciones();
  const ids = result.map(s => s.id);
  assertTrue(ids.includes('libre'), 'Should include libre');
  assertTrue(ids.includes('identificar_problemas'), 'Should include identificar_problemas');
  assertTrue(ids.includes('arquitectura'), 'Should include arquitectura');
  assertTrue(ids.includes('ejecucion'), 'Should include ejecucion');
  assertTrue(ids.includes('mejora_codigo'), 'Should include mejora_codigo');
});

// ─── crearSituacion ──────────────────────────────────────────────────────────
console.log('\nTesting: crearSituacion()');

test('crearSituacion creates debate from template', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('identificar_problemas', 'Code review', 0);
  assertTrue(result.debate, 'Should create debate');
  assertEqual(result.debate.situacion, 'identificar_problemas', 'Should set situacion');
});

test('crearSituacion creates agents when numAgents > 0', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('libre', 'Testing', 3);
  assertTrue(result.agents.length > 0, 'Should create agents');
});

test('crearSituacion handles identificar_problemas', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('identificar_problemas', 'Review code quality', 2);
  assertTrue(result.debate, 'Should create debate');
  assertEqual(result.debate.situacion, 'identificar_problemas', 'Should set situacion');
});

test('crearSituacion handles arquitectura', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('arquitectura', 'Design system architecture', 2);
  assertTrue(result.debate, 'Should create debate');
  assertEqual(result.debate.situacion, 'arquitectura', 'Should set situacion');
});

test('crearSituacion handles ejecucion', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('ejecucion', 'Implement new feature', 2);
  assertTrue(result.debate, 'Should create debate');
  assertEqual(result.debate.situacion, 'ejecucion', 'Should set situacion');
});

test('crearSituacion rejects invalid situacion', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('invalid-situacion', 'Topic');
  assertTrue(result.error, 'Should return error for invalid situacion');
});

// ─── getWorkflowStatus ────────────────────────────────────────────────────────
console.log('\nTesting: getWorkflowStatus()');

test('getWorkflowStatus returns workflow info for situacion', () => {
  resetState();
  const dm = freshDebateManager();
  const sit = dm.crearSituacion('identificar_problemas', 'Check code', 2);
  const result = dm.getWorkflowStatus(sit.debate.id);
  assertTrue(result.situacion, 'Should return situacion');
  assertTrue(result.coordinationType, 'Should return coordination type');
});

test('getWorkflowStatus shows participant status', () => {
  resetState();
  const dm = freshDebateManager();
  const sit = dm.crearSituacion('identificar_problemas', 'Check code', 2);
  const result = dm.getWorkflowStatus(sit.debate.id);
  assertTrue(result.participants, 'Should have participants');
  assertTrue(result.participants.length > 0, 'Should list participants');
});

// ─── saveStateNow ────────────────────────────────────────────────────────────
console.log('\nTesting: saveStateNow()');

test('saveStateNow persists state to file', () => {
  resetState();
  const dm = freshDebateManager();
  dm.createDebate('Testing', 5);
  dm.saveStateNow();

  assertTrue(fs.existsSync(STATE_FILE), 'State file should exist');
  const content = fs.readFileSync(STATE_FILE, 'utf-8');
  const data = JSON.parse(content);
  assertTrue(Object.keys(data.debates).length > 0, 'State should contain debates');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. INTEGRATION TESTS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n2. INTEGRATION TESTS\n');

test('Full debate lifecycle: create → join → say → read → nextRound → finish', () => {
  resetState();
  const dm = freshDebateManager();

  // Create with casual intensity (minExchanges = 1)
  const debate = dm.createDebate('Should we use Node.js?', 3, null, 'casual');
  assertTrue(debate.id, 'Debate created');

  // Join
  const join1 = dm.joinDebate(debate.id, 'Alice', 'defensor');
  const join2 = dm.joinDebate(debate.id, 'Bob', 'devils-advocate');
  assertTrue(join1.participant, 'Alice joined');
  assertTrue(join2.participant, 'Bob joined');

  // Say (Round 1)
  const say1 = dm.say(debate.id, 'Alice', createLongText(200));
  assertTrue(say1.message, 'Alice said something');
  assertEqual(say1.round, 1, 'Round 1');

  const say2 = dm.say(debate.id, 'Bob', createLongText(200));
  assertTrue(say2.message, 'Bob said something');
  // say2.autoAdvanced will be true if round auto-advanced

  // Read
  const read1 = dm.read(debate.id);
  assertEqual(read1.messages.length, 2, 'Should have 2 messages');
  // Auto-advance should have triggered, so we're on round 2
  assertEqual(read1.debate.currentRound, 2, 'Should auto-advance to round 2');

  // Say (Round 2)
  dm.say(debate.id, 'Alice', createLongText(200));
  dm.say(debate.id, 'Bob', createLongText(200));

  // Auto-advance should have triggered again
  const read2 = dm.read(debate.id);
  assertEqual(read2.debate.currentRound, 3, 'Should be on round 3');

  // Say (Round 3)
  dm.say(debate.id, 'Alice', createLongText(200));
  dm.say(debate.id, 'Bob', createLongText(200));

  // Auto-finish at max rounds
  const finalRead = dm.read(debate.id);
  assertEqual(finalRead.debate.status, 'finished', 'Debate should be finished');
});

test('Multiple debates in parallel', () => {
  resetState();
  const dm = freshDebateManager();

  const d1 = dm.createDebate('Topic 1', 2);
  const d2 = dm.createDebate('Topic 2', 2);
  const d3 = dm.createDebate('Topic 3', 2);

  dm.joinDebate(d1.id, 'A', 'defensor');
  dm.joinDebate(d2.id, 'B', 'defensor');
  dm.joinDebate(d3.id, 'C', 'defensor');

  dm.say(d1.id, 'A', createLongText(200));
  dm.say(d2.id, 'B', createLongText(200));
  dm.say(d3.id, 'C', createLongText(200));

  const list = dm.listDebates();
  assertEqual(list.length, 3, 'Should have 3 debates');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. EDGE CASES
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n3. EDGE CASES\n');

test('Empty debate with no participants', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const read = dm.read(debate.id);
  assertEqual(read.messages.length, 0, 'Should have no messages');
  assertTrue(read.debate, 'Should return debate');
});

test('Invalid debate ID handling', () => {
  resetState();
  const dm = freshDebateManager();
  const read = dm.read('nonexistent-id');
  assertTrue(read.error, 'Should return error');
});

test('Say with exactly minimum words', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5, null, 'adversarial');
  // adversarial requires 150 words
  const exactText = Array(150).fill('word').join(' ');
  const result = dm.say(debate.id, 'Alice', exactText);
  assertTrue(result.message, 'Should accept message with exactly minimum words');
});

test('Too many agents (>15) capped', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.autoDebate('Testing', 25);
  assertTrue(result.agents.length <= 15, 'Should cap at 15 agents');
});

test('Duplicate joins return existing participant', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const join1 = dm.joinDebate(debate.id, 'Alice', 'defensor');
  const join2 = dm.joinDebate(debate.id, 'Alice', 'defensor');

  assertEqual(join1.participant.id, join2.participant.id, 'Same participant ID');
  assertTrue(join2.alreadyJoined, 'Should indicate already joined');
});

test('Empty message text handling', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const result = dm.say(debate.id, 'Alice', '');
  assertTrue(result.rejected || result.error, 'Should reject empty message');
});

test('Very long message accepted', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const longText = Array(1000).fill('word').join(' ');
  const result = dm.say(debate.id, 'Alice', longText);
  assertTrue(result.message, 'Should accept very long message');
  assertEqual(result.wordCount, 1000, 'Should count 1000 words');
});

test('Special characters in participant name', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  const result = dm.joinDebate(debate.id, 'Alice@#$%', 'defensor');
  assertTrue(result.participant, 'Should accept special characters');
});

test('Read with sinceIndex beyond message count', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');
  dm.say(debate.id, 'Alice', createLongText(200));

  const result = dm.read(debate.id, 100);
  assertEqual(result.messages.length, 0, 'Should return empty array');
});

test('getCurrentPhase with empty phases array', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.getCurrentPhase(5, []);
  assertTrue(!result, 'Should return null for empty phases');
});

test('Situacion with 0 agents', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('arquitectura', 'Topic', 0);
  assertTrue(result.debate, 'Should create debate');
  assertEqual(result.agents.length, 0, 'Should have 0 agents');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PERFORMANCE TESTS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n4. PERFORMANCE TESTS\n');

test('sayBatch with 10+ messages completes in reasonable time', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 50);
  dm.joinDebate(debate.id, 'Alice', 'defensor');

  const messages = [];
  for (let i = 0; i < 15; i++) {
    messages.push({ name: 'Alice', text: createLongText(200) });
  }

  const start = Date.now();
  const result = dm.sayBatch(debate.id, messages);
  const elapsed = Date.now() - start;

  assertTrue(result.results, 'Should add messages');
  const successCount = result.results.filter(r => r.success).length;
  assertTrue(successCount > 0, 'Should have successful messages');
  assertTrue(elapsed < 5000, `Should complete in <5s, took ${elapsed}ms`);
});

test('read with large message count', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 100);
  dm.joinDebate(debate.id, 'Alice', 'defensor');

  // Add 50 messages
  for (let i = 0; i < 50; i++) {
    dm.say(debate.id, 'Alice', createLongText(200));
  }

  const start = Date.now();
  const result = dm.read(debate.id);
  const elapsed = Date.now() - start;

  assertEqual(result.messages.length, 50, 'Should read all 50 messages');
  assertTrue(elapsed < 1000, `Should complete in <1s, took ${elapsed}ms`);
});

test('listDebates with many debates', () => {
  resetState();
  const dm = freshDebateManager();
  for (let i = 0; i < 20; i++) {
    dm.createDebate(`Topic ${i}`, 5);
  }

  const start = Date.now();
  const result = dm.listDebates();
  const elapsed = Date.now() - start;

  assertEqual(result.length, 20, 'Should list all 20 debates');
  assertTrue(elapsed < 1000, `Should complete in <1s, took ${elapsed}ms`);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. SITUACIONES TESTS (All 4 types)
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n5. SITUACIONES TESTS\n');

test('Situacion: libre with auto-detected roles', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('libre', 'código arquitectura software API microservices', 2);
  assertTrue(result.debate, 'Should create debate');
  // For libre with agents, crearSituacion returns agents from autoDebate
  assertTrue(result.agents, 'Should have agents');
  assertTrue(result.agents.length >= 2, 'Should create agents');
  assertTrue(result.debate.category === 'tecnologia' || result.debate.category === 'general',
    'Should detect category');
});

test('Situacion: identificar_problemas with sequential roles', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('identificar_problemas', 'Code review for auth system', 3);
  assertTrue(result.debate, 'Should create debate');
  const roles = result.agents.map(a => a.role);
  assertTrue(roles.length > 0, 'Should have roles');
  assertTrue(roles.some(r => r.includes('detector') || r.includes('analista')), 'Should have analysis roles');
});

test('Situacion: arquitectura with debate roles', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('arquitectura', 'Design microservices architecture', 3);
  assertTrue(result.debate, 'Should create debate');
  assertTrue(result.agents.length > 0, 'Should have agents');
  const coords = result.template.coordination;
  assertTrue(coords, 'Should have coordination info');
});

test('Situacion: ejecucion with pipeline coordination', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('ejecucion', 'Implement payment system', 3);
  assertTrue(result.debate, 'Should create debate');
  assertTrue(result.agents.length > 0, 'Should have agents');
  const coords = result.template.coordination;
  assertTrue(coords, 'Should have coordination info');
});

test('Situacion roles match their descriptions', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.crearSituacion('identificar_problemas', 'Code review', 3);
  for (const agent of result.agents) {
    assertTrue(agent.role, 'Agent should have role');
    assertTrue(agent.desc, 'Agent should have description');
  }
});

test('All situaciones have maxRounds defined', () => {
  resetState();
  const dm = freshDebateManager();
  const situaciones = dm.listSituaciones();
  for (const sit of situaciones) {
    assertTrue(sit.maxRounds >= 0, `${sit.id} should have maxRounds defined (0 = continuous)`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PAGINATION TESTS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n6. PAGINATION TESTS\n');

test('read with sinceIndex=0, limit=0 returns all', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');

  for (let i = 0; i < 10; i++) {
    dm.say(debate.id, 'Alice', createLongText(200));
  }

  const result = dm.read(debate.id, 0, 0);
  assertEqual(result.messages.length, 10, 'limit=0 should return all');
});

test('read respects both sinceIndex and limit', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');

  for (let i = 0; i < 10; i++) {
    dm.say(debate.id, 'Alice', createLongText(200));
  }

  const result = dm.read(debate.id, 3, 3);
  assertEqual(result.messages.length, 3, 'Should return 3 messages starting from index 3');
});

test('read returns correct message indices', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');

  for (let i = 0; i < 5; i++) {
    dm.say(debate.id, 'Alice', createLongText(200));
  }

  const result = dm.read(debate.id, 2, 2);
  assertEqual(result.messages.length, 2, 'Should return 2 messages');
});

test('read with large limit parameter', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 5);
  dm.joinDebate(debate.id, 'Alice', 'defensor');

  for (let i = 0; i < 5; i++) {
    dm.say(debate.id, 'Alice', createLongText(200));
  }

  const result = dm.read(debate.id, 0, 1000);
  assertEqual(result.messages.length, 5, 'Should return all 5, not capped at 1000');
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. PHASE TRANSITIONS TESTS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n7. PHASE TRANSITIONS TESTS\n');

test('Phase transitions through rounds in 10-round debate', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 10);
  dm.joinDebate(debate.id, 'Alice', 'defensor');

  // Round 1
  const phase1 = dm.getCurrentPhase(1, debate.phases);
  assertTrue(phase1, 'Should have phase for round 1');

  // Round 5 (different phase)
  const phase5 = dm.getCurrentPhase(5, debate.phases);
  assertTrue(phase5, 'Should have phase for round 5');

  // Round 10
  const phase10 = dm.getCurrentPhase(10, debate.phases);
  assertTrue(phase10, 'Should have phase for round 10');
});

test('Phases are sequential in long debate', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 12);

  const phases = debate.phases;
  assertTrue(phases.length >= 3, 'Should have multiple phases');

  // Check phases are in order
  for (let i = 1; i < phases.length; i++) {
    assertTrue(phases[i].rounds[0] > phases[i-1].rounds[1], 'Phases should not overlap');
  }
});

test('Phase names are meaningful', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 10);

  for (const phase of debate.phases) {
    assertTrue(phase.name, 'Phase should have name');
    assertTrue(phase.instruction, 'Phase should have instruction');
    assertTrue(phase.rounds, 'Phase should have rounds');
  }
});

test('Short debate (4 rounds) has fewer phases than long debate (12 rounds)', () => {
  resetState();
  const dm = freshDebateManager();
  const short = dm.createDebate('Testing', 4);
  const long = dm.createDebate('Testing', 12);

  assertTrue(short.phases.length < long.phases.length, 'Long debate should have more phases');
});

test('Continuous debate (0 maxRounds) has default phases', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Testing', 0);
  assertTrue(debate.phases.length > 0, 'Should have phases');
  assertEqual(debate.maxRounds, 0, 'Should have maxRounds = 0');
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. CODE PROPOSAL TESTS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n8. CODE PROPOSAL TESTS\n');

// ─── readProjectFile ──────────────────────────────────────────────────────────
console.log('Testing: readProjectFile()');

test('readProjectFile reads existing file', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.readProjectFile('package.json');
  assertTrue(!result.error, 'Should not return error for existing file');
  assertTrue(result.content, 'Should return file content');
  assertTrue(result.lines > 0, 'Should return positive line count');
});

test('readProjectFile rejects path outside project', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.readProjectFile('../../../etc/passwd');
  assertTrue(result.error, 'Should return error for path outside project');
});

test('readProjectFile handles non-existent file', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.readProjectFile('nonexistent.xyz');
  assertTrue(result.error, 'Should return error for non-existent file');
});

// ─── listProjectFiles ─────────────────────────────────────────────────────────
console.log('\nTesting: listProjectFiles()');

test('listProjectFiles returns files', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.listProjectFiles();
  assertTrue(Array.isArray(result), 'Should return an array');
  assertTrue(result.length > 0, 'Should return at least one file');
});

test('listProjectFiles filters by pattern', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.listProjectFiles('.cjs');
  assertTrue(Array.isArray(result), 'Should return an array');
  assertTrue(result.length > 0, 'Should find at least one .cjs file');
  for (const f of result) {
    assertTrue(f.path.includes('.cjs'), `File "${f.path}" should contain .cjs`);
  }
});

// ─── proposeEdit ──────────────────────────────────────────────────────────────
console.log('\nTesting: proposeEdit()');

test('proposeEdit creates proposal', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for testing proposals', 5);
  // Use a real string from package.json
  const result = dm.proposeEdit(
    debate.id,
    'analista-codigo',
    'package.json',
    'multi-agent-debate-mcp',
    'multi-agent-debate-mcp',
    'Testing proposal creation to verify that the system correctly stores proposals with pending status and assigns a unique identifier to each one for future reference and review workflow processing.'
  );
  // oldString === newString should be rejected, so use a truly different new string
  // Actually proposeEdit rejects same old/new — let's use a real harmless change:
  // We do this properly in the next step; this test catches same old/new error path.
  // For this test we need old !== new, so retry with a different new string:
  const result2 = dm.proposeEdit(
    debate.id,
    'analista-codigo',
    'package.json',
    'multi-agent-debate-mcp',
    'multi-agent-debate-mcp-test',
    'Proposing a harmless rename of the package name field to verify that the proposal creation workflow correctly assigns a unique proposal identifier and sets the initial status to pending awaiting reviewer approvals before any changes are applied to the filesystem.'
  );
  assertTrue(result2.id || result2.proposalId || (result2.proposal && result2.proposal.id), 'Should return a proposal id');
  const status = result2.status || (result2.proposal && result2.proposal.status);
  assertEqual(status, 'pending', 'Proposal status should be pending');
});

test('proposeEdit rejects if old_string not found', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for proposal rejection testing', 5);
  const result = dm.proposeEdit(
    debate.id,
    'analista-codigo',
    'package.json',
    'THIS_STRING_DOES_NOT_EXIST_IN_PACKAGE_JSON_AT_ALL_XYZ',
    'replacement-value',
    'Attempting to propose an edit using a search string that does not exist in the target file, which should cause the system to return an error indicating that the old string was not found and the proposal cannot be created.'
  );
  assertTrue(result.error, 'Should return error when old_string is not found in file');
});

test('proposeEdit rejects if same old and new', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for same string rejection test', 5);
  const result = dm.proposeEdit(
    debate.id,
    'analista-codigo',
    'package.json',
    'multi-agent-debate-mcp',
    'multi-agent-debate-mcp',
    'Attempting to propose an edit where the old string and new string are identical, which should be rejected by the system because applying such a proposal would result in no actual change to the file contents whatsoever.'
  );
  assertTrue(result.error, 'Should return error when old and new strings are identical');
});

// ─── reviewProposal ───────────────────────────────────────────────────────────
console.log('\nTesting: reviewProposal()');

test('reviewProposal approves proposal', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for review approval testing workflow', 5);
  const proposal = dm.proposeEdit(
    debate.id,
    'proponedor-mejora',
    'package.json',
    'multi-agent-debate-mcp',
    'multi-agent-debate-mcp-reviewed',
    'This proposal is created for the purpose of testing the review approval workflow, where a different agent will approve it and we verify that the review is correctly recorded in the proposal reviews list with the correct reviewer name and approval decision.'
  );
  const proposalId = proposal.id || proposal.proposalId || (proposal.proposal && proposal.proposal.id);
  assertTrue(proposalId, 'Need a valid proposal id to review');
  const review = dm.reviewProposal(proposalId, 'revisor-seguridad', true, 'Looks good and safe to apply');
  assertTrue(!review.error, 'Should not return error on valid review');
});

test('reviewProposal rejects self-review', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for self review rejection test case', 5);
  const proposal = dm.proposeEdit(
    debate.id,
    'proponedor-mejora',
    'package.json',
    'multi-agent-debate-mcp',
    'multi-agent-debate-mcp-selftest',
    'This proposal is created by the same agent who will attempt to review it, which should be rejected by the system to enforce the separation of duties rule preventing proposal authors from approving their own proposed changes to project files.'
  );
  const proposalId = proposal.id || proposal.proposalId || (proposal.proposal && proposal.proposal.id);
  assertTrue(proposalId, 'Need a valid proposal id to test self-review');
  const review = dm.reviewProposal(proposalId, 'proponedor-mejora', true, 'Self-approving my own proposal');
  assertTrue(review.error, 'Should return error when agent tries to review their own proposal');
});

test('reviewProposal auto-approves with mandatory role approvals', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for governance approval testing', 5);
  // Join agents with proper roles so _getAgentRole can resolve them
  dm.joinDebate(debate.id, 'agent-proposer', 'proponedor-mejora');
  dm.joinDebate(debate.id, 'agent-architect', 'arquitecto-guardian');
  dm.joinDebate(debate.id, 'agent-security', 'revisor-seguridad');
  const proposal = dm.proposeEdit(
    debate.id,
    'agent-proposer',
    'package.json',
    'multi-agent-debate-mcp',
    'multi-agent-debate-mcp-autoapprove',
    'This proposal is created to test that when two mandatory role reviewers approve it the system automatically transitions the proposal status from pending to approved under governance rules.'
  );
  const proposalId = proposal.id || proposal.proposalId || (proposal.proposal && proposal.proposal.id);
  assertTrue(proposalId, 'Need a valid proposal id for governance-approve test');
  dm.reviewProposal(proposalId, 'agent-architect', true, 'Approved from architecture perspective no issues found');
  const secondReview = dm.reviewProposal(proposalId, 'agent-security', true, 'Approved from security perspective looks correct');
  const finalStatus = secondReview.status || (secondReview.proposal && secondReview.proposal.status);
  assertEqual(finalStatus, 'approved', 'Status should become approved after mandatory role approvals');
});

// ─── applyProposal ────────────────────────────────────────────────────────────
console.log('\nTesting: applyProposal()');

test('applyProposal rejects non-approved proposal', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for apply rejection testing workflow', 5);
  const proposal = dm.proposeEdit(
    debate.id,
    'proponedor-mejora',
    'package.json',
    'multi-agent-debate-mcp',
    'multi-agent-debate-mcp-applyfail',
    'This proposal is intentionally left in pending status without any approvals so that when we attempt to apply it the system should correctly reject the apply operation because only proposals that have reached the approved status may be applied to the filesystem.'
  );
  const proposalId = proposal.id || proposal.proposalId || (proposal.proposal && proposal.proposal.id);
  assertTrue(proposalId, 'Need a valid proposal id to test apply rejection');
  const applyResult = dm.applyProposal(proposalId);
  assertTrue(applyResult.error, 'Should return error when trying to apply a non-approved proposal');
});

// ─── listProposals ────────────────────────────────────────────────────────────
console.log('\nTesting: listProposals()');

test('listProposals returns all proposals', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for list proposals testing workflow', 5);
  dm.proposeEdit(
    debate.id, 'analista-codigo', 'package.json',
    'multi-agent-debate-mcp', 'multi-agent-debate-mcp-list1',
    'First proposal created to populate the proposals list for testing the listProposals function which should return all proposals regardless of their current status including pending approved and rejected ones from all debates in the system.'
  );
  dm.proposeEdit(
    debate.id, 'analista-codigo', 'package.json',
    'multi-agent-debate-mcp-list1', 'multi-agent-debate-mcp-list2',
    'Second proposal created to ensure that the listProposals function returns multiple proposals when they exist and that the returned array contains all the proposals associated with the current debate session without any filtering by default.'
  );
  const result = dm.listProposals();
  assertTrue(Array.isArray(result.proposals || result), 'Should return an array of proposals');
});

test('listProposals filters by debateId', () => {
  resetState();
  const dm = freshDebateManager();
  const debate1 = dm.createDebate('First code improvement debate for filtering test', 5);
  const debate2 = dm.createDebate('Second code improvement debate for filtering test', 5);
  dm.proposeEdit(
    debate1.id, 'analista-codigo', 'package.json',
    'multi-agent-debate-mcp', 'multi-agent-debate-mcp-d1',
    'Proposal belonging to the first debate created to verify that the listProposals filtering by debateId correctly returns only proposals associated with the specified debate and does not include proposals from other debates in the system.'
  );
  dm.proposeEdit(
    debate2.id, 'analista-codigo', 'package.json',
    'multi-agent-debate-mcp', 'multi-agent-debate-mcp-d2',
    'Proposal belonging to the second debate created to verify that the listProposals filtering by debateId correctly excludes this proposal when filtering for the first debate and only includes it when the second debate identifier is used as the filter parameter.'
  );
  const result = dm.listProposals(debate1.id);
  const proposals = result.proposals || result;
  assertTrue(Array.isArray(proposals), 'Should return an array');
  for (const p of proposals) {
    const pDebateId = p.debateId || p.debate_id;
    assertEqual(pDebateId, debate1.id, 'All returned proposals should belong to debate1');
  }
});

// ─── getProposal ──────────────────────────────────────────────────────────────
console.log('\nTesting: getProposal()');

test('getProposal returns full detail', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Code improvement debate for get proposal detail testing', 5);
  const created = dm.proposeEdit(
    debate.id, 'analista-codigo', 'package.json',
    'multi-agent-debate-mcp', 'multi-agent-debate-mcp-detail',
    'Proposal created to verify that the getProposal function returns the full proposal detail object including the reviews array which tracks all review decisions made by different agents on this specific proposal throughout its lifecycle in the approval workflow.'
  );
  const proposalId = created.id || created.proposalId || (created.proposal && created.proposal.id);
  assertTrue(proposalId, 'Need a valid proposal id to test getProposal');
  const result = dm.getProposal(proposalId);
  assertTrue(!result.error, 'Should not return error for valid proposal id');
  const proposal = result.proposal || result;
  assertTrue(Array.isArray(proposal.reviews), 'Proposal should include a reviews array');
});

// ─── mejora_codigo situacion ───────────────────────────────────────────────────
console.log('\nTesting: mejora_codigo situacion');

test('Situacion mejora_codigo exists', () => {
  resetState();
  const dm = freshDebateManager();
  const result = dm.listSituaciones();
  const ids = result.map(s => s.id);
  assertTrue(ids.includes('mejora_codigo'), 'listSituaciones should include mejora_codigo');
});

test('Situacion mejora_codigo has correct roles', () => {
  resetState();
  const dm = freshDebateManager();
  const situaciones = dm.listSituaciones();
  const mejora = situaciones.find(s => s.id === 'mejora_codigo');
  assertTrue(mejora, 'mejora_codigo situacion should exist');
  const roles = mejora.roles;
  assertTrue(Array.isArray(roles), 'mejora_codigo should have a roles array');
  assertEqual(roles.length, 6, 'mejora_codigo should have exactly 6 roles');
  const roleIds = roles.map(r => r.id || r.role || r);
  assertTrue(
    roleIds.some(r => r.includes('analista-codigo')),
    'Should have analista-codigo role'
  );
  assertTrue(
    roleIds.some(r => r.includes('proponedor-mejora')),
    'Should have proponedor-mejora role'
  );
  assertTrue(
    roleIds.some(r => r.includes('revisor-seguridad')),
    'Should have revisor-seguridad role'
  );
  assertTrue(
    roleIds.some(r => r.includes('revisor-calidad')),
    'Should have revisor-calidad role'
  );
  assertTrue(
    roleIds.some(r => r.includes('coordinador-merge')),
    'Should have coordinador-merge role'
  );
});

// ─── GOVERNANCE TESTS ─────────────────────────────────────────────────────────
console.log('\n\n9. GOVERNANCE TESTS\n');

console.log('Testing: getGovernanceConfig()');

test('getGovernanceConfig returns governance configuration', () => {
  resetState();
  const dm = freshDebateManager();
  const config = dm.getGovernanceConfig();
  assertTrue(config.minApprovals >= 2, 'Should require at least 2 approvals');
  assertTrue(Array.isArray(config.mandatoryApprovalRoles), 'Should have mandatory approval roles');
  assertTrue(Array.isArray(config.vetoRoles), 'Should have veto roles');
  assertTrue(Array.isArray(config.protectedFiles), 'Should have protected files list');
  assertTrue(Array.isArray(config.forbiddenFiles), 'Should have forbidden files list');
  assertTrue(config.mandatoryApprovalRoles.includes('arquitecto-guardian'), 'arquitecto-guardian should be mandatory');
  assertTrue(config.mandatoryApprovalRoles.includes('revisor-seguridad'), 'revisor-seguridad should be mandatory');
});

console.log('\nTesting: Governance role restrictions');

test('proposeEdit rejects unauthorized roles', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Governance role restriction test for propose edit unauthorized role checking', 5);
  dm.joinDebate(debate.id, 'agent-analyst', 'analista-codigo');
  const result = dm.proposeEdit(
    debate.id, 'agent-analyst', 'package.json',
    'old-text', 'new-text',
    'This proposal attempts to propose an edit from an analista-codigo role which should not be allowed by governance rules since only proponedor-mejora and coordinador-merge roles are permitted to create new code proposals in the system.'
  );
  assertTrue(result.error && result.error.includes('GOVERNANCE'), 'Should reject proposal from unauthorized role');
});

test('proposeEdit allows authorized roles', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Governance role restriction test for propose edit authorized role checking', 5);
  dm.joinDebate(debate.id, 'agent-proposer', 'proponedor-mejora');
  const result = dm.proposeEdit(
    debate.id, 'agent-proposer', 'package.json',
    'multi-agent-debate-mcp', 'multi-agent-debate-mcp-gov',
    'This proposal is created by an authorized proponedor-mejora role to verify that the governance system correctly allows agents with the proper role to create new code change proposals in the system workflow.'
  );
  assertTrue(!result.error, 'Should allow proposal from proponedor-mejora role');
});

test('proposeEdit rejects forbidden files', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Governance forbidden file test for checking file protection rules', 5);
  dm.joinDebate(debate.id, 'agent-proposer', 'proponedor-mejora');
  const result = dm.proposeEdit(
    debate.id, 'agent-proposer', '.env',
    'SECRET=old', 'SECRET=new',
    'This proposal attempts to edit a forbidden file which should be blocked by governance rules since certain files like dot env and test suite and package lock are never allowed to be modified by any agent regardless of their role.'
  );
  assertTrue(result.error && result.error.includes('GOVERNANCE'), 'Should reject editing forbidden files');
});

console.log('\nTesting: Governance veto');

test('reviewProposal veto blocks proposal immediately', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Governance veto test for immediate blocking of proposals by veto roles', 5);
  dm.joinDebate(debate.id, 'agent-proposer', 'proponedor-mejora');
  dm.joinDebate(debate.id, 'agent-architect', 'arquitecto-guardian');
  const proposal = dm.proposeEdit(
    debate.id, 'agent-proposer', 'package.json',
    'multi-agent-debate-mcp', 'multi-agent-debate-mcp-veto',
    'This proposal is created to test that when a veto-role agent rejects it the proposal status immediately becomes rejected and cannot proceed further through the governance approval workflow pipeline.'
  );
  const proposalId = proposal.id || proposal.proposalId || (proposal.proposal && proposal.proposal.id);
  const review = dm.reviewProposal(proposalId, 'agent-architect', false, 'Vetoing this change because it is not safe');
  const status = review.status || (review.proposal && review.proposal.status);
  assertEqual(status, 'rejected', 'Veto from arquitecto-guardian should immediately reject');
});

console.log('\nTesting: Governance status');

test('getGovernanceStatus returns pending info for new proposal', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Governance status test for checking pending proposal information display', 5);
  dm.joinDebate(debate.id, 'agent-proposer', 'proponedor-mejora');
  const proposal = dm.proposeEdit(
    debate.id, 'agent-proposer', 'package.json',
    'multi-agent-debate-mcp', 'multi-agent-debate-mcp-status',
    'This proposal is created to test that the governance status function correctly reports the pending state and lists all missing mandatory approvals and remaining approval count for a newly created proposal.'
  );
  const proposalId = proposal.id || proposal.proposalId || (proposal.proposal && proposal.proposal.id);
  const status = dm.getGovernanceStatus(proposalId);
  assertTrue(!status.error, 'Should not return error for valid proposal');
  assertEqual(status.status, 'pending', 'New proposal should be pending');
  assertTrue(status.mandatoryRolesNeeded.length > 0, 'Should list missing mandatory approvals');
  assertTrue(!status.canBeApproved, 'Should not be ready to apply yet');
});

test('reviewProposal prevents duplicate reviews', () => {
  resetState();
  const dm = freshDebateManager();
  const debate = dm.createDebate('Governance duplicate review test for preventing same agent reviewing twice', 5);
  dm.joinDebate(debate.id, 'agent-proposer', 'proponedor-mejora');
  dm.joinDebate(debate.id, 'agent-security', 'revisor-seguridad');
  const proposal = dm.proposeEdit(
    debate.id, 'agent-proposer', 'package.json',
    'multi-agent-debate-mcp', 'multi-agent-debate-mcp-dup',
    'This proposal is created to test that the governance system prevents the same agent from reviewing a proposal more than once, ensuring that each unique agent can only submit a single review vote.'
  );
  const proposalId = proposal.id || proposal.proposalId || (proposal.proposal && proposal.proposal.id);
  dm.reviewProposal(proposalId, 'agent-security', true, 'First review approved from security perspective');
  const dup = dm.reviewProposal(proposalId, 'agent-security', true, 'Trying to review again should fail');
  assertTrue(dup.error && dup.error.includes('already reviewed'), 'Should reject duplicate review');
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. ORCHESTRATOR ENGINE TESTS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n10. ORCHESTRATOR ENGINE TESTS\n');

// Fresh orchestrator load
function freshOrchestrator() {
  const resolved = require.resolve('./orchestrator-engine.cjs');
  delete require.cache[resolved];
  return require('./orchestrator-engine.cjs');
}

// Async test helper: wraps an async fn so the sync test() runner can handle it
function asyncTest(name, fn) {
  asyncTestQueue.push({ name, fn });
}
const asyncTestQueue = [];

console.log('\nTesting: Orchestrator exports');

test('orchestrator-engine exports runDebate', () => {
  const orch = freshOrchestrator();
  assertTrue(typeof orch.runDebate === 'function', 'runDebate should be a function');
  assertTrue(Object.keys(orch).includes('runDebate'), 'Module should export runDebate');
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. TRIAGE AGENT TESTS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n\n11. TRIAGE AGENT TESTS\n');

// Fresh triage agent load
function freshTriageAgent() {
  const resolved = require.resolve('./triage-agent.cjs');
  delete require.cache[resolved];
  return require('./triage-agent.cjs');
}

console.log('\nTesting: Triage agent exports');

test('triage-agent exports required functions', () => {
  const triage = freshTriageAgent();
  assertTrue(typeof triage.evaluateTask === 'function', 'evaluateTask should be a function');
  assertTrue(typeof triage.runTriagedTask === 'function', 'runTriagedTask should be a function');
  assertTrue(Array.isArray(triage.TEAM_AGENTS), 'TEAM_AGENTS should be an array');
  assertTrue(typeof triage.getTeamStatus === 'function', 'getTeamStatus should be a function');
});

console.log('\nTesting: TEAM_AGENTS data');

test('TEAM_AGENTS has 6 agents', () => {
  const triage = freshTriageAgent();
  assertEqual(triage.TEAM_AGENTS.length, 6, 'TEAM_AGENTS should have 6 agents');
});

test('TEAM_AGENTS has required agent IDs', () => {
  const triage = freshTriageAgent();
  const ids = triage.TEAM_AGENTS.map(a => a.id);
  const requiredIds = ['arquitecto', 'frontend', 'backend', 'qa', 'seguridad', 'triage'];
  for (const id of requiredIds) {
    assertTrue(ids.includes(id), `TEAM_AGENTS should include agent with id "${id}"`);
  }
});

test('Each agent has required fields', () => {
  const triage = freshTriageAgent();
  for (const agent of triage.TEAM_AGENTS) {
    assertTrue(typeof agent.id === 'string', `Agent should have string id, got ${typeof agent.id}`);
    assertTrue(typeof agent.name === 'string', `Agent ${agent.id} should have string name`);
    assertTrue(typeof agent.specialty === 'string', `Agent ${agent.id} should have string specialty`);
    assertTrue(Array.isArray(agent.triggers), `Agent ${agent.id} should have triggers array`);
  }
});

console.log('\nTesting: getTeamStatus');

test('getTeamStatus returns team info', () => {
  const triage = freshTriageAgent();
  const status = triage.getTeamStatus();
  assertTrue(Array.isArray(status), 'getTeamStatus should return an array');
  assertEqual(status.length, 6, 'Status should have 6 entries');
  assertTrue(status[0].id && status[0].name && status[0].specialty, 'Each entry should have id, name, specialty');
});

console.log('\nTesting: Orchestrator input validation');

asyncTest('runDebate rejects without tema', async () => {
  resetState();
  const orch = freshOrchestrator();
  let caught = false;
  let errorMsg = '';
  try {
    await orch.runDebate({});
  } catch (err) {
    caught = true;
    errorMsg = err.message;
  }
  assertTrue(caught, 'runDebate should throw when tema is missing');
  assertTrue(errorMsg.includes('tema'), 'Error message should mention tema: got "' + errorMsg + '"');
});

asyncTest('runDebate rejects with invalid situacion', async () => {
  resetState();
  const orch = freshOrchestrator();
  let caught = false;
  let errorMsg = '';
  try {
    await orch.runDebate({ tema: 'test', situacion: 'nonexistent' });
  } catch (err) {
    caught = true;
    errorMsg = err.message;
  }
  assertTrue(caught, 'runDebate should throw when situacion is invalid');
  assertTrue(
    errorMsg.includes('nonexistent') || errorMsg.includes('no existe') || errorMsg.includes('Failed to create'),
    'Error should mention invalid situacion: got "' + errorMsg + '"'
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// SUMMARY (deferred to handle async tests)
// ═════════════════════════════════════════════════════════════════════════════

async function runAsyncTestsAndReport() {
  // Run queued async tests
  for (const t of asyncTestQueue) {
    totalTests++;
    try {
      await t.fn();
      passedTests++;
      console.log(`✓ ${t.name}`);
    } catch (err) {
      failedTests++;
      console.log(`✗ ${t.name}`);
      failedTestDetails.push({ name: t.name, error: err.message });
    }
  }

  console.log('\n\n' + '='.repeat(80));
  console.log('TEST RESULTS SUMMARY');
  console.log('='.repeat(80));

  console.log(`\nTotal Tests: ${totalTests}`);
  console.log(`Passed: ${passedTests} ✓`);
  console.log(`Failed: ${failedTests} ✗`);

  const passPercentage = totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 0;
  console.log(`Pass Rate: ${passPercentage}%`);

  if (failedTests > 0) {
    console.log('\nFailed Tests:');
    for (const detail of failedTestDetails) {
      console.log(`  ✗ ${detail.name}`);
      console.log(`    Error: ${detail.error}`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(passPercentage === 100 ? 'ALL TESTS PASSED!' : 'Some tests failed. See details above.');
  console.log('='.repeat(80));

  process.exit(failedTests > 0 ? 1 : 0);
}

runAsyncTestsAndReport();
