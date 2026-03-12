/**
 * Micro-Topics — Divide & Conquer for Multi-Agent Debates
 *
 * Enables 10 agents to work efficiently by:
 * 1. DECOMPOSING big topics into focused micro-subtopics
 * 2. SPAWNING quick micro-debates (2-3 rounds, 2-4 agents) per subtopic
 * 3. CONVERGING conclusions upward into a tree structure
 * 4. AUTO-SYNTHESIZING when micro-debates complete
 *
 * Architecture:
 *   Main Topic
 *   ├── Subtopic A (micro-debate: 2-3 agents, 2 rounds)
 *   │   ├── Conclusion A.1
 *   │   └── Conclusion A.2
 *   ├── Subtopic B (micro-debate: 3-4 agents, 3 rounds)
 *   │   └── Conclusion B.1
 *   └── Subtopic C
 *       └── (in progress...)
 *   → SYNTHESIS: Merge all conclusions → Final position
 */

const fs = require('fs');
const path = require('path');
const dm = require('./debate-manager.cjs');

const MICRO_TOPICS_FILE = path.join(__dirname, 'micro-topics.json');

let microState = {
  trees: {},     // { treeId: TopicTree }
  nextId: 1,
};

// ── Persistence ──────────────────────────────────────────────────────────

function loadMicroState() {
  try {
    if (fs.existsSync(MICRO_TOPICS_FILE)) {
      microState = JSON.parse(fs.readFileSync(MICRO_TOPICS_FILE, 'utf-8'));
    }
  } catch { /* default state */ }
}

let _saveTimer = null;
let _savePending = false;

function saveMicroStateNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _savePending = false;
  try {
    fs.writeFileSync(MICRO_TOPICS_FILE, JSON.stringify(microState, null, 2), 'utf-8');
  } catch (err) {
    console.error('[micro-topics] Save failed:', err.message);
  }
}

function saveMicroState() {
  _savePending = true;
  if (!_saveTimer) {
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      if (_savePending) saveMicroStateNow();
    }, 2000);
  }
}

process.on('exit', () => { if (_savePending) saveMicroStateNow(); });
process.on('SIGINT', () => { if (_savePending) saveMicroStateNow(); process.exit(); });
process.on('SIGTERM', () => { if (_savePending) saveMicroStateNow(); process.exit(); });

loadMicroState();

// ── Topic Tree Structure ─────────────────────────────────────────────────

/**
 * Create a new topic tree for divide & conquer debate
 *
 * @param {string} mainDebateId - The parent debate ID
 * @param {string} mainTopic - The main topic being debated
 * @param {Array} participants - All available agents [{name, role}]
 * @returns {object} The created tree
 */
function createTopicTree(mainDebateId, mainTopic, participants) {
  if (!mainDebateId || !mainTopic) {
    return { error: 'mainDebateId and mainTopic are required' };
  }

  const treeId = `tree-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const tree = {
    id: treeId,
    mainDebateId,
    mainTopic,
    participants: (participants || []).map(p => ({ name: p.name, role: p.role })),
    subtopics: [],       // Array of Subtopic nodes
    conclusions: [],     // Merged conclusions from completed subtopics
    status: 'active',    // active | synthesizing | completed
    createdAt: new Date().toISOString(),
    completedAt: null,
    synthesis: null,     // Final synthesis text
    stats: {
      totalSubtopics: 0,
      completedSubtopics: 0,
      totalMessages: 0,
      avgRoundsPerSubtopic: 0,
    },
  };

  microState.trees[treeId] = tree;
  saveMicroState();

  return {
    treeId,
    mainDebateId,
    mainTopic,
    participantCount: tree.participants.length,
    message: `Topic tree created. Use spawn_subtopic to decompose "${mainTopic}" into micro-debates.`,
  };
}

/**
 * Spawn a micro-debate for a specific subtopic within the tree
 *
 * @param {string} treeId - The topic tree ID
 * @param {string} subtopic - The focused subtopic to debate
 * @param {string[]} agentNames - Which agents should participate (2-4 recommended)
 * @param {object} options - { maxRounds, intensity, parentSubtopicId }
 * @returns {object} The created subtopic with its debate ID
 */
function spawnSubtopic(treeId, subtopic, agentNames, options = {}) {
  const tree = microState.trees[treeId];
  if (!tree) return { error: `Topic tree ${treeId} not found` };
  if (tree.status === 'completed') return { error: 'Topic tree already completed' };
  if (!subtopic || subtopic.trim().length < 5) return { error: 'Subtopic too short (min 5 chars)' };
  if (!agentNames || agentNames.length < 2) return { error: 'Need at least 2 agents for a micro-debate' };
  if (agentNames.length > 5) return { error: 'Max 5 agents per micro-debate (keep it focused)' };

  const {
    maxRounds = 3,     // Micro-debates are fast: 2-3 rounds
    intensity = 'micro',
    parentSubtopicId = null,
  } = options;

  // Create the micro-debate
  const debateResult = dm.createDebate(
    `[MICRO] ${subtopic}`,
    maxRounds,
    null,
    intensity === 'micro' ? 'moderado' : intensity // Fallback if 'micro' not registered yet
  );

  if (debateResult.error) {
    return { error: `Failed to create micro-debate: ${debateResult.error}` };
  }

  // Join the selected agents
  const joined = [];
  for (const agentName of agentNames) {
    const agentInfo = tree.participants.find(p => p.name === agentName);
    const role = agentInfo ? agentInfo.role : 'participant';
    const joinResult = dm.joinDebate(debateResult.id, agentName, role);
    if (!joinResult.error) {
      joined.push({ name: agentName, role });
    }
  }

  // Add context about the main topic and what this subtopic should focus on
  dm.addContext(debateResult.id, 'micro-topic-context', `
CONTEXTO: Este es un MICRO-DEBATE focalizado.

TEMA PRINCIPAL: ${tree.mainTopic}
SUBTEMA ESPECÍFICO: ${subtopic}

REGLAS DEL MICRO-DEBATE:
1. ENFOQUE: Solo discutan "${subtopic}". No se desvíen al tema principal completo.
2. VELOCIDAD: Tienen ${maxRounds} rondas. Sean concisos y concretos.
3. OBJETIVO: Llegar a 1-3 conclusiones específicas sobre este subtema.
4. FORMATO: Cada mensaje debe terminar con:
   CONCLUSIÓN-PARCIAL: [tu conclusión sobre este subtema específico]
   CONFIANZA: [alta/media/baja]
5. NO repitan lo que ya se dijo. Cada mensaje debe AGREGAR valor nuevo.

${parentSubtopicId ? `NOTA: Este subtema se derivó de otro micro-debate (${parentSubtopicId}).` : ''}
  `.trim(), 'micro-topic');

  const subtopicNode = {
    id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    treeId,
    debateId: debateResult.id,
    topic: subtopic,
    agents: joined,
    maxRounds,
    intensity,
    parentSubtopicId,
    childSubtopicIds: [],
    status: 'active',          // active | concluded | merged
    conclusions: [],            // Extracted conclusions when debate finishes
    confidenceScore: null,     // Average confidence of conclusions
    createdAt: new Date().toISOString(),
    completedAt: null,
    messageCount: 0,
  };

  // Link to parent if exists
  if (parentSubtopicId) {
    const parent = tree.subtopics.find(s => s.id === parentSubtopicId);
    if (parent) {
      parent.childSubtopicIds.push(subtopicNode.id);
    }
  }

  tree.subtopics.push(subtopicNode);
  tree.stats.totalSubtopics++;
  saveMicroState();

  return {
    subtopicId: subtopicNode.id,
    debateId: debateResult.id,
    topic: subtopic,
    agents: joined.map(a => a.name),
    maxRounds,
    parentSubtopicId,
    message: `Micro-debate spawned: "${subtopic}" with ${joined.length} agents for ${maxRounds} rounds.`,
  };
}

/**
 * Conclude a micro-debate and extract conclusions
 *
 * @param {string} treeId - The topic tree ID
 * @param {string} subtopicId - The subtopic to conclude
 * @returns {object} Extracted conclusions
 */
function concludeSubtopic(treeId, subtopicId) {
  const tree = microState.trees[treeId];
  if (!tree) return { error: `Topic tree ${treeId} not found` };

  const subtopic = tree.subtopics.find(s => s.id === subtopicId);
  if (!subtopic) return { error: `Subtopic ${subtopicId} not found` };
  if (subtopic.status === 'concluded') return { error: 'Subtopic already concluded' };

  // Read the debate messages
  const readResult = dm.read(subtopic.debateId, 0, 0);
  if (readResult.error) return { error: `Cannot read debate: ${readResult.error}` };

  const messages = readResult.messages || [];
  subtopic.messageCount = messages.length;

  // Extract conclusions from messages (look for CONCLUSIÓN-PARCIAL patterns)
  const conclusions = [];
  const confidences = [];

  for (const msg of messages) {
    const text = msg.text || '';

    // Extract CONCLUSIÓN-PARCIAL
    const conclusionMatch = text.match(/CONCLUSI[ÓO]N[- ]PARCIAL:\s*(.+?)(?=\n|CONFIANZA|---CHECKPOINT|$)/is);
    if (conclusionMatch) {
      const conclusion = conclusionMatch[1].trim();
      if (conclusion.length > 10) {
        conclusions.push({
          text: conclusion,
          author: msg.participantName,
          round: msg.round,
        });
      }
    }

    // Extract confidence
    const confMatch = text.match(/CONFIANZA:\s*(alta|media|baja)/i);
    if (confMatch) {
      const confMap = { alta: 0.9, media: 0.6, baja: 0.3 };
      confidences.push(confMap[confMatch[1].toLowerCase()] || 0.5);
    }
  }

  // If no explicit conclusions, take last messages as implicit conclusions
  if (conclusions.length === 0 && messages.length > 0) {
    const lastMsgs = messages.slice(-2);
    for (const msg of lastMsgs) {
      conclusions.push({
        text: (msg.text || '').slice(0, 300),
        author: msg.participantName,
        round: msg.round,
        implicit: true, // Not explicitly marked as conclusion
      });
    }
  }

  subtopic.conclusions = conclusions;
  subtopic.confidenceScore = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0.5;
  subtopic.status = 'concluded';
  subtopic.completedAt = new Date().toISOString();

  // Finalize the debate
  try {
    const synthesisText = conclusions.map(c => `- ${c.author}: ${c.text}`).join('\n');
    dm.finishDebate(subtopic.debateId, synthesisText, true);
  } catch (e) {
    // Ignore if already finished
  }

  tree.stats.completedSubtopics++;
  tree.stats.totalMessages += messages.length;

  // Add conclusions to tree-level collection
  tree.conclusions.push({
    subtopicId,
    topic: subtopic.topic,
    conclusions,
    confidence: subtopic.confidenceScore,
  });

  // Recalculate avg rounds
  const completedSubs = tree.subtopics.filter(s => s.status === 'concluded');
  tree.stats.avgRoundsPerSubtopic = completedSubs.length > 0
    ? completedSubs.reduce((sum, s) => sum + s.maxRounds, 0) / completedSubs.length
    : 0;

  saveMicroState();

  return {
    subtopicId,
    topic: subtopic.topic,
    conclusionCount: conclusions.length,
    conclusions: conclusions.map(c => ({ text: c.text, author: c.author })),
    confidence: subtopic.confidenceScore,
    messageCount: messages.length,
    treeProgress: `${tree.stats.completedSubtopics}/${tree.stats.totalSubtopics} subtopics completed`,
  };
}

/**
 * Auto-conclude all finished micro-debates in a tree
 *
 * @param {string} treeId - The topic tree ID
 * @returns {object} Summary of auto-concluded subtopics
 */
function autoConcludeFinished(treeId) {
  const tree = microState.trees[treeId];
  if (!tree) return { error: `Topic tree ${treeId} not found` };

  const autoConcluded = [];

  for (const subtopic of tree.subtopics) {
    if (subtopic.status !== 'active') continue;

    // Check if the debate has finished or reached max rounds
    const debates = dm.listDebates ? dm.listDebates() : [];
    const debate = debates.find(d => d.id === subtopic.debateId);

    if (!debate) continue;

    const shouldConclude =
      debate.status === 'finished' ||
      (debate.currentRound >= subtopic.maxRounds && debate.spokenThisRound && debate.spokenThisRound.length >= subtopic.agents.length);

    if (shouldConclude) {
      const result = concludeSubtopic(treeId, subtopic.id);
      if (!result.error) {
        autoConcluded.push({
          subtopicId: subtopic.id,
          topic: subtopic.topic,
          conclusions: result.conclusionCount,
        });
      }
    }
  }

  return {
    treeId,
    autoConcluded: autoConcluded.length,
    details: autoConcluded,
    remainingActive: tree.subtopics.filter(s => s.status === 'active').length,
  };
}

/**
 * Get the full status of a topic tree
 *
 * @param {string} treeId - The topic tree ID
 * @returns {object} Complete tree status
 */
function getTreeStatus(treeId) {
  const tree = microState.trees[treeId];
  if (!tree) return { error: `Topic tree ${treeId} not found` };

  // Auto-conclude any finished debates
  autoConcludeFinished(treeId);

  const active = tree.subtopics.filter(s => s.status === 'active');
  const concluded = tree.subtopics.filter(s => s.status === 'concluded');
  const allDone = active.length === 0 && tree.subtopics.length > 0;

  return {
    treeId,
    mainTopic: tree.mainTopic,
    mainDebateId: tree.mainDebateId,
    status: tree.status,
    stats: tree.stats,
    readyForSynthesis: allDone,
    subtopics: tree.subtopics.map(s => ({
      id: s.id,
      topic: s.topic,
      status: s.status,
      agents: s.agents.map(a => a.name),
      debateId: s.debateId,
      maxRounds: s.maxRounds,
      messageCount: s.messageCount,
      conclusionCount: s.conclusions.length,
      confidence: s.confidenceScore,
      parentId: s.parentSubtopicId,
      childIds: s.childSubtopicIds,
    })),
    conclusions: tree.conclusions,
    // Visual tree representation
    treeView: buildTreeView(tree),
  };
}

/**
 * Build a visual text representation of the topic tree
 */
function buildTreeView(tree) {
  const lines = [];
  lines.push(`📋 ${tree.mainTopic}`);
  lines.push(`${'─'.repeat(50)}`);

  // Root-level subtopics (no parent)
  const roots = tree.subtopics.filter(s => !s.parentSubtopicId);

  function renderNode(subtopic, indent = 0) {
    const prefix = '  '.repeat(indent);
    const statusIcon = subtopic.status === 'concluded' ? '✅' : subtopic.status === 'active' ? '🔄' : '📝';
    const confStr = subtopic.confidenceScore !== null ? ` (conf: ${(subtopic.confidenceScore * 100).toFixed(0)}%)` : '';

    lines.push(`${prefix}${statusIcon} ${subtopic.topic}${confStr}`);
    lines.push(`${prefix}   └─ ${subtopic.agents.map(a => a.name).join(', ')} | ${subtopic.messageCount} msgs | R${subtopic.maxRounds}`);

    if (subtopic.conclusions.length > 0) {
      for (const c of subtopic.conclusions.slice(0, 3)) {
        lines.push(`${prefix}   📌 ${c.text.slice(0, 100)}`);
      }
    }

    // Render children
    const children = tree.subtopics.filter(s => s.parentSubtopicId === subtopic.id);
    for (const child of children) {
      renderNode(child, indent + 1);
    }
  }

  for (const root of roots) {
    renderNode(root);
  }

  return lines.join('\n');
}

/**
 * Synthesize all conclusions into a final position for the main debate
 *
 * @param {string} treeId - The topic tree ID
 * @returns {object} Synthesis with all conclusions merged
 */
function synthesizeTree(treeId) {
  const tree = microState.trees[treeId];
  if (!tree) return { error: `Topic tree ${treeId} not found` };

  // Auto-conclude any finished debates first
  autoConcludeFinished(treeId);

  const active = tree.subtopics.filter(s => s.status === 'active');
  if (active.length > 0) {
    return {
      error: `Cannot synthesize: ${active.length} subtopic(s) still active`,
      activeSubtopics: active.map(s => ({ id: s.id, topic: s.topic, debateId: s.debateId })),
    };
  }

  if (tree.subtopics.length === 0) {
    return { error: 'No subtopics to synthesize. Use spawn_subtopic first.' };
  }

  // Build synthesis from all conclusions
  const conclusionsByTopic = {};
  for (const sub of tree.subtopics.filter(s => s.status === 'concluded')) {
    conclusionsByTopic[sub.topic] = {
      conclusions: sub.conclusions,
      confidence: sub.confidenceScore,
      agents: sub.agents.map(a => a.name),
      messageCount: sub.messageCount,
    };
  }

  // Generate synthesis prompt for the main debate
  const synthesisText = `
══════════════════════════════════════════════════
SÍNTESIS DEL ÁRBOL DE MICRO-DEBATES
══════════════════════════════════════════════════

TEMA PRINCIPAL: ${tree.mainTopic}
SUBTEMAS ANALIZADOS: ${tree.subtopics.length}
MENSAJES TOTALES: ${tree.stats.totalMessages}
AGENTES INVOLUCRADOS: ${tree.participants.length}

${Object.entries(conclusionsByTopic).map(([topic, data]) => `
─── ${topic} ───
  Confianza: ${(data.confidence * 100).toFixed(0)}%
  Agentes: ${data.agents.join(', ')}
  Conclusiones:
${data.conclusions.map(c => `    • [${c.author}] ${c.text}`).join('\n')}
`).join('\n')}

══════════════════════════════════════════════════
CONCLUSIONES INTEGRADAS:
══════════════════════════════════════════════════

${tree.subtopics
  .filter(s => s.status === 'concluded')
  .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0))
  .map((s, i) => `${i + 1}. [Conf: ${((s.confidenceScore || 0) * 100).toFixed(0)}%] ${s.topic}: ${s.conclusions[0]?.text || '(sin conclusión explícita)'}`)
  .join('\n')}

══════════════════════════════════════════════════
  `.trim();

  // Add synthesis as context to the main debate
  try {
    dm.addContext(tree.mainDebateId, `micro-synthesis-${treeId}`, synthesisText, 'micro-synthesis');
  } catch (e) {
    // Main debate might not exist anymore
  }

  tree.synthesis = synthesisText;
  tree.status = 'completed';
  tree.completedAt = new Date().toISOString();
  saveMicroState();

  return {
    treeId,
    mainDebateId: tree.mainDebateId,
    mainTopic: tree.mainTopic,
    subtopicsAnalyzed: tree.subtopics.length,
    totalMessages: tree.stats.totalMessages,
    synthesis: synthesisText,
    topConclusions: tree.subtopics
      .filter(s => s.status === 'concluded' && s.conclusions.length > 0)
      .sort((a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0))
      .slice(0, 5)
      .map(s => ({ topic: s.topic, conclusion: s.conclusions[0]?.text, confidence: s.confidenceScore })),
    contextAdded: true,
  };
}

/**
 * Suggest subtopic decomposition for a main topic (heuristic-based)
 *
 * @param {string} mainTopic - The main topic to decompose
 * @param {Array} participants - Available agents
 * @returns {object} Suggested subtopics with agent assignments
 */
function suggestDecomposition(mainTopic, participants) {
  const agentCount = participants.length;

  // Heuristic: create 3-5 subtopics, each with 2-3 agents
  const subtopicCount = Math.min(5, Math.max(3, Math.ceil(agentCount / 2)));
  const agentsPerSubtopic = Math.min(4, Math.max(2, Math.ceil(agentCount / subtopicCount)));

  // Suggest decomposition angles based on common patterns
  const angles = [
    { angle: 'Viabilidad técnica', desc: '¿Es posible implementar esto? ¿Qué restricciones existen?' },
    { angle: 'Impacto y beneficios', desc: '¿Qué problemas resuelve? ¿Cuál es el valor real?' },
    { angle: 'Riesgos y contraargumentos', desc: '¿Qué puede salir mal? ¿Cuáles son las objeciones?' },
    { angle: 'Implementación y pasos', desc: '¿Cómo se ejecuta? ¿En qué orden? ¿Con qué recursos?' },
    { angle: 'Alternativas y comparación', desc: '¿Hay mejores enfoques? ¿Qué se ha probado antes?' },
  ];

  const suggestions = angles.slice(0, subtopicCount).map((angle, i) => {
    // Round-robin agent assignment
    const startIdx = i * agentsPerSubtopic;
    const agents = [];
    for (let j = 0; j < agentsPerSubtopic; j++) {
      const idx = (startIdx + j) % participants.length;
      agents.push(participants[idx].name);
    }

    return {
      subtopic: `${mainTopic} — ${angle.angle}`,
      description: angle.desc,
      suggestedAgents: agents,
      suggestedRounds: 3,
    };
  });

  return {
    mainTopic,
    subtopicCount: suggestions.length,
    agentsPerSubtopic,
    totalAgents: agentCount,
    suggestions,
    message: `Suggested ${suggestions.length} subtopics for ${agentCount} agents. Use spawn_subtopic to create each one.`,
  };
}

/**
 * Get all active topic trees
 */
function listTrees() {
  return Object.values(microState.trees).map(t => ({
    id: t.id,
    mainTopic: t.mainTopic,
    mainDebateId: t.mainDebateId,
    status: t.status,
    subtopicCount: t.subtopics.length,
    completedCount: t.subtopics.filter(s => s.status === 'concluded').length,
    activeCount: t.subtopics.filter(s => s.status === 'active').length,
    createdAt: t.createdAt,
  }));
}

/**
 * Get a specific subtopic's debate details
 */
function getSubtopicDetail(treeId, subtopicId) {
  const tree = microState.trees[treeId];
  if (!tree) return { error: `Topic tree ${treeId} not found` };

  const subtopic = tree.subtopics.find(s => s.id === subtopicId);
  if (!subtopic) return { error: `Subtopic ${subtopicId} not found` };

  // Get current debate state
  const readResult = dm.read(subtopic.debateId, 0, 0);
  const messages = readResult.messages || [];
  const debate = readResult.debate || {};

  return {
    subtopicId: subtopic.id,
    topic: subtopic.topic,
    debateId: subtopic.debateId,
    status: subtopic.status,
    agents: subtopic.agents,
    currentRound: debate.currentRound || 0,
    maxRounds: subtopic.maxRounds,
    messageCount: messages.length,
    conclusions: subtopic.conclusions,
    confidence: subtopic.confidenceScore,
    recentMessages: messages.slice(-5).map(m => ({
      from: m.participantName,
      role: m.participantRole,
      text: (m.text || '').slice(0, 200),
      round: m.round,
    })),
    parentId: subtopic.parentSubtopicId,
    childIds: subtopic.childSubtopicIds,
  };
}

module.exports = {
  createTopicTree,
  spawnSubtopic,
  concludeSubtopic,
  autoConcludeFinished,
  getTreeStatus,
  synthesizeTree,
  suggestDecomposition,
  listTrees,
  getSubtopicDetail,
  saveMicroStateNow,
};
