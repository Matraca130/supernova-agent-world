/**
 * Micro-Orchestrator — Automatic topic decomposition & micro-round execution
 *
 * Integrates into the main debate loop to automatically:
 * 1. DETECT when a topic should be decomposed (after round 2+)
 * 2. EXTRACT subtopics from conversation using heuristics + optional LLM
 * 3. ASSIGN agents to micro-debates based on role relevance
 * 4. RUN micro-debates in parallel (fast: 2-3 rounds, 2-4 agents)
 * 5. CONCLUDE and feed conclusions back as context to the main debate
 * 6. LEARN from decomposition quality via Strategy Genome
 *
 * Architecture:
 *   Main Debate Round 2 → [DECOMPOSITION PHASE] → Micro-Debates → [CONVERGENCE] → Main Debate Round 3
 *                                                                                    (enriched with conclusions)
 */

const dm = require('./debate-manager.cjs');
const mt = require('./micro-topics.cjs');

// ── Configuration ──────────────────────────────────────────────────────
const MICRO_CONFIG = {
  // When to trigger decomposition (round number in main debate)
  triggerAfterRound: 2,
  // How often to re-decompose (every N rounds after trigger)
  reDecomposeInterval: 4,
  // Max micro-debates per decomposition phase
  maxMicroDebates: 5,
  // Max rounds per micro-debate
  microMaxRounds: 3,
  // Min agents per micro-debate
  microMinAgents: 2,
  // Max agents per micro-debate
  microMaxAgents: 4,
  // Timeout per micro-debate agent turn (ms)
  microTurnTimeout: 60000,
  // Max total time for all micro-debates in a phase (ms)
  microPhaseTimeout: 5 * 60 * 1000, // 5 minutes
  // Min messages before decomposition makes sense
  minMessagesForDecompose: 4,
};

// ── Active micro-round state (per debate) ──────────────────────────────
const activeMicroRounds = {}; // { debateId: { treeId, phase, assignments, startedAt } }

/**
 * Get current micro-round assignments for a debate (used by dashboard)
 * @param {string} debateId
 * @returns {object|null} Current assignments or null if no micro-round active
 */
function getMicroRoundState(debateId) {
  return activeMicroRounds[debateId] || null;
}

/**
 * Get all active micro-round states (for dashboard world)
 * Returns agent → room mapping based on micro-debate assignments
 */
function getAgentMicroAssignments() {
  const assignments = {};
  for (const [debateId, state] of Object.entries(activeMicroRounds)) {
    if (state.phase === 'active' && state.assignments) {
      for (const [agentName, assignment] of Object.entries(state.assignments)) {
        assignments[agentName] = {
          microDebateId: assignment.debateId,
          subtopic: assignment.subtopic,
          room: assignment.room, // For dashboard world room routing
          status: assignment.status, // 'debating' | 'concluded' | 'waiting'
        };
      }
    }
  }
  return assignments;
}

// ── Subtopic Extraction (Heuristic — no LLM needed) ───────────────────

/**
 * Extract potential subtopics from debate messages using heuristic analysis.
 * Looks for:
 * - Disagreement clusters (where agents diverge)
 * - Questions raised but not answered
 * - Proposals that need deeper analysis
 * - CHECKPOINT data (divergencias, preguntas, accionable)
 *
 * @param {Array} messages - Recent debate messages
 * @param {string} mainTopic - The main debate topic
 * @param {Array} agents - All agents in the debate
 * @returns {Array} Suggested subtopics with relevance scores and agent assignments
 */
function extractSubtopics(messages, mainTopic, agents) {
  if (!messages || messages.length < MICRO_CONFIG.minMessagesForDecompose) {
    return [];
  }

  const subtopics = [];
  const seenTopics = new Set();

  // Strategy 1: Extract from CHECKPOINT divergencias & preguntas
  for (const msg of messages) {
    const text = msg.text || '';

    // Parse checkpoint if present
    const cpMatch = text.match(/---CHECKPOINT---\s*([\s\S]*?)\s*---END---/);
    if (cpMatch) {
      try {
        const cp = JSON.parse(cpMatch[1].trim());

        // Divergencias → subtopics to resolve
        if (Array.isArray(cp.divergencias)) {
          for (const div of cp.divergencias) {
            if (div.length > 15 && !isDuplicateTopic(div, seenTopics)) {
              seenTopics.add(normalizeForDedup(div));
              subtopics.push({
                topic: div.slice(0, 120),
                source: 'divergencia',
                sourceAgent: msg.participantName,
                relevance: 0.9,
                suggestedAgents: findRelevantAgents(div, agents, msg.participantName),
              });
            }
          }
        }

        // Preguntas abiertas → subtopics to explore
        if (Array.isArray(cp.preguntas)) {
          for (const q of cp.preguntas) {
            if (q.length > 15 && !isDuplicateTopic(q, seenTopics)) {
              seenTopics.add(normalizeForDedup(q));
              subtopics.push({
                topic: q.slice(0, 120),
                source: 'pregunta_abierta',
                sourceAgent: msg.participantName,
                relevance: 0.8,
                suggestedAgents: findRelevantAgents(q, agents, msg.participantName),
              });
            }
          }
        }

        // Uncertainty areas → subtopics needing expert input
        if (Array.isArray(cp.uncertainty_areas)) {
          for (const u of cp.uncertainty_areas) {
            if (u.length > 15 && !isDuplicateTopic(u, seenTopics)) {
              seenTopics.add(normalizeForDedup(u));
              subtopics.push({
                topic: u.slice(0, 120),
                source: 'incertidumbre',
                sourceAgent: msg.participantName,
                relevance: 0.7,
                suggestedAgents: findRelevantAgents(u, agents, msg.participantName),
              });
            }
          }
        }
      } catch { /* Invalid JSON, skip */ }
    }

    // Strategy 2: Detect disagreement patterns in text
    const disagreementPatterns = [
      /\b(?:no estoy de acuerdo|discrepo|me opongo|es incorrecto|es erróneo|no funciona|contraproducente)\b.*?:\s*(.{20,120})/gi,
      /\bPERO\b[.:,]\s*(.{20,120})/g,
      /\bSIN EMBARGO\b[.:,]\s*(.{20,120})/gi,
    ];

    for (const pattern of disagreementPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const topic = match[1].trim();
        if (topic.length > 20 && !isDuplicateTopic(topic, seenTopics)) {
          seenTopics.add(normalizeForDedup(topic));
          subtopics.push({
            topic: topic.slice(0, 120),
            source: 'desacuerdo',
            sourceAgent: msg.participantName,
            relevance: 0.75,
            suggestedAgents: findRelevantAgents(topic, agents, msg.participantName),
          });
        }
      }
    }

    // Strategy 3: Detect explicit questions not answered
    const questionPattern = /\?\s*(.{10,100}?)(?:\?|$)/g;
    let qMatch;
    while ((qMatch = questionPattern.exec(text)) !== null) {
      const question = qMatch[0].trim();
      if (question.length > 15 && !isDuplicateTopic(question, seenTopics)) {
        // Check if anyone answered this question in later messages
        const answered = messages.some(m =>
          m.participantName !== msg.participantName &&
          new Date(m.timestamp) > new Date(msg.timestamp) &&
          (m.text || '').toLowerCase().includes(question.toLowerCase().slice(0, 30))
        );
        if (!answered) {
          seenTopics.add(normalizeForDedup(question));
          subtopics.push({
            topic: question.slice(0, 120),
            source: 'pregunta_sin_respuesta',
            sourceAgent: msg.participantName,
            relevance: 0.65,
            suggestedAgents: findRelevantAgents(question, agents, msg.participantName),
          });
        }
      }
    }
  }

  // Sort by relevance, take top N
  subtopics.sort((a, b) => b.relevance - a.relevance);
  return subtopics.slice(0, MICRO_CONFIG.maxMicroDebates);
}

/**
 * Find the most relevant agents for a subtopic based on role matching
 */
function findRelevantAgents(topic, agents, sourceAgent) {
  const topicLower = topic.toLowerCase();
  const scored = agents.map(a => {
    let score = 0;
    const role = (a.role || '').toLowerCase();

    // Role-topic keyword matching
    if (topicLower.includes('seguridad') || topicLower.includes('security')) {
      if (role.includes('seguridad') || role.includes('security') || role.includes('hardliner')) score += 3;
    }
    if (topicLower.includes('arquitect') || topicLower.includes('diseño') || topicLower.includes('design')) {
      if (role.includes('arquitecto') || role.includes('ux') || role.includes('visual')) score += 3;
    }
    if (topicLower.includes('implement') || topicLower.includes('código') || topicLower.includes('code')) {
      if (role.includes('dev') || role.includes('implement') || role.includes('codigo') || role.includes('junior') || role.includes('ship')) score += 3;
    }
    if (topicLower.includes('costo') || topicLower.includes('roi') || topicLower.includes('presupuesto')) {
      if (role.includes('cfo') || role.includes('cost') || role.includes('operaciones')) score += 3;
    }
    if (topicLower.includes('usuario') || topicLower.includes('ux') || topicLower.includes('experiencia')) {
      if (role.includes('ux') || role.includes('product') || role.includes('paciente') || role.includes('estudiante')) score += 3;
    }

    // Source agent gets bonus (they raised the issue)
    if (a.name === sourceAgent) score += 2;

    // Critic/devil's advocate always relevant for disagreements
    if (role.includes('critic') || role.includes('devil') || role.includes('antagonist')) score += 1;

    // Base score so no one is completely excluded
    score += Math.random() * 0.5;

    return { name: a.name, role: a.role, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Take top 2-4 agents
  const count = Math.min(MICRO_CONFIG.microMaxAgents, Math.max(MICRO_CONFIG.microMinAgents, Math.ceil(agents.length / 3)));
  return scored.slice(0, count).map(a => a.name);
}

function normalizeForDedup(text) {
  return (text || '').toLowerCase().replace(/[^a-záéíóúñ\s]/g, '').split(/\s+/).filter(w => w.length > 3).sort().join(' ');
}

function isDuplicateTopic(topic, seenSet) {
  const normalized = normalizeForDedup(topic);
  for (const seen of seenSet) {
    // Jaccard similarity
    const setA = new Set(normalized.split(' '));
    const setB = new Set(seen.split(' '));
    const intersection = [...setA].filter(x => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;
    if (union > 0 && intersection / union > 0.5) return true;
  }
  return false;
}

// ── Room assignment for dashboard world ────────────────────────────────

const MICRO_ROOM_MAP = [
  'debate',   // First micro-debate → debate room
  'reason',   // Second → reasoning room
  'github',   // Third → github room
  'kb',       // Fourth → knowledge base
  'stats',    // Fifth → analytics
];

// ── Main Auto-Orchestration: shouldDecompose ──────────────────────────

/**
 * Check if the debate should enter a decomposition phase
 *
 * @param {object} debate - The debate object
 * @param {number} roundCount - Current round number
 * @returns {boolean}
 */
function shouldDecompose(debate, roundCount) {
  // Already running a micro-round for this debate
  if (activeMicroRounds[debate.id] && activeMicroRounds[debate.id].phase === 'active') {
    return false;
  }

  // First decomposition: after triggerAfterRound
  if (roundCount === MICRO_CONFIG.triggerAfterRound) return true;

  // Re-decomposition: every N rounds after trigger
  if (roundCount > MICRO_CONFIG.triggerAfterRound &&
      (roundCount - MICRO_CONFIG.triggerAfterRound) % MICRO_CONFIG.reDecomposeInterval === 0) {
    return true;
  }

  return false;
}

/**
 * Run a complete micro-round: decompose → spawn → run → conclude → feed back
 *
 * This is the main function called from orchestrator-engine.cjs
 *
 * @param {string} debateId - Main debate ID
 * @param {object} debate - Debate object with messages, participants, topic
 * @param {Array} agents - Agent list [{name, role}]
 * @param {Function} log - Logger function from orchestrator
 * @param {number} turnTimeout - Per-agent timeout
 * @returns {object} Results of the micro-round
 */
async function runMicroRound(debateId, debate, agents, log, turnTimeout) {
  const phaseStart = Date.now();

  log('micro_round_start', {
    debateId,
    round: debate.currentRound,
    message: `🔬 MICRO-ROUND: Analyzing conversation for subtopic decomposition...`,
  });

  // 1. Extract subtopics from recent messages
  const recentMessages = (debate.messages || []).slice(-20); // Last 20 messages
  const subtopics = extractSubtopics(recentMessages, debate.topic, agents);

  if (subtopics.length === 0) {
    log('micro_round_skip', {
      debateId,
      message: 'No subtopics identified for decomposition. Continuing main debate.',
    });
    return { skipped: true, reason: 'no_subtopics' };
  }

  log('micro_decomposition', {
    debateId,
    subtopicCount: subtopics.length,
    subtopics: subtopics.map(s => ({ topic: s.topic, source: s.source, agents: s.suggestedAgents })),
    message: `📊 Identified ${subtopics.length} subtopics: ${subtopics.map(s => s.topic.slice(0, 60)).join(' | ')}`,
  });

  // 2. Create topic tree
  const treeResult = mt.createTopicTree(debateId, debate.topic, agents);
  if (treeResult.error) {
    log('error', { message: `[micro] Tree creation failed: ${treeResult.error}` });
    return { skipped: true, reason: 'tree_error', error: treeResult.error };
  }

  const treeId = treeResult.treeId;

  // 3. Spawn micro-debates for each subtopic
  const microDebates = [];
  const assignments = {};

  for (let i = 0; i < subtopics.length; i++) {
    const st = subtopics[i];
    const room = MICRO_ROOM_MAP[i % MICRO_ROOM_MAP.length];

    const spawnResult = mt.spawnSubtopic(treeId, st.topic, st.suggestedAgents, {
      maxRounds: MICRO_CONFIG.microMaxRounds,
      intensity: 'micro',
    });

    if (spawnResult.error) {
      log('error', { message: `[micro] Spawn failed for "${st.topic}": ${spawnResult.error}` });
      continue;
    }

    microDebates.push({
      subtopicId: spawnResult.subtopicId,
      debateId: spawnResult.debateId,
      topic: st.topic,
      agents: st.suggestedAgents,
      room,
    });

    // Track agent assignments for dashboard
    for (const agentName of st.suggestedAgents) {
      assignments[agentName] = {
        debateId: spawnResult.debateId,
        subtopicId: spawnResult.subtopicId,
        subtopic: st.topic,
        room,
        status: 'debating',
      };
    }

    log('micro_spawn', {
      debateId: spawnResult.debateId,
      subtopic: st.topic,
      agents: st.suggestedAgents,
      room,
      message: `🔬 Micro-debate ${i + 1}: "${st.topic.slice(0, 60)}" → ${st.suggestedAgents.join(', ')} (room: ${room})`,
    });
  }

  if (microDebates.length === 0) {
    log('micro_round_skip', {
      debateId,
      message: 'All micro-debate spawns failed. Continuing main debate.',
    });
    return { skipped: true, reason: 'all_spawns_failed' };
  }

  // 4. Set active state (dashboard can read this)
  activeMicroRounds[debateId] = {
    treeId,
    phase: 'active',
    assignments,
    microDebates: microDebates.map(md => md.debateId),
    startedAt: Date.now(),
  };

  // 5. Wait for micro-debates to complete (poll-based with timeout)
  const microTimeout = Math.min(MICRO_CONFIG.microPhaseTimeout, (turnTimeout || 120000) * 2);
  const pollInterval = 3000; // Check every 3s
  let allConcluded = false;

  log('micro_wait_start', {
    debateId,
    microDebateCount: microDebates.length,
    timeoutMs: microTimeout,
    message: `⏳ Waiting for ${microDebates.length} micro-debates to complete (timeout: ${Math.round(microTimeout / 1000)}s)...`,
  });

  while (Date.now() - phaseStart < microTimeout) {
    // Check each micro-debate
    let activeCount = 0;
    let concludedCount = 0;

    for (const md of microDebates) {
      const debates = dm.listDebates ? dm.listDebates() : [];
      const microDebate = debates.find(d => d.id === md.debateId);

      if (!microDebate) continue;

      // Check if debate is finished or has enough rounds
      const isFinished = microDebate.status === 'finished';
      const hasEnoughRounds = microDebate.currentRound >= MICRO_CONFIG.microMaxRounds;
      const allSpoke = microDebate.spokenThisRound &&
        microDebate.spokenThisRound.length >= (microDebate.participants || []).length;

      if (isFinished || (hasEnoughRounds && allSpoke)) {
        // Auto-conclude this subtopic
        const concludeResult = mt.concludeSubtopic(treeId, md.subtopicId);
        if (!concludeResult.error) {
          concludedCount++;
          // Update agent assignments
          for (const agentName of md.agents) {
            if (assignments[agentName]) {
              assignments[agentName].status = 'concluded';
            }
          }
          log('micro_concluded', {
            subtopic: md.topic,
            conclusions: concludeResult.conclusionCount,
            confidence: concludeResult.confidence,
            message: `✅ Micro-debate concluded: "${md.topic.slice(0, 50)}" (${concludeResult.conclusionCount} conclusions, ${((concludeResult.confidence || 0) * 100).toFixed(0)}% confidence)`,
          });
        } else {
          concludedCount++; // Count it anyway to avoid infinite loop
        }
      } else {
        activeCount++;
      }
    }

    if (activeCount === 0) {
      allConcluded = true;
      break;
    }

    // Log progress
    if (Date.now() - phaseStart > 10000 && (Date.now() - phaseStart) % 15000 < pollInterval) {
      log('micro_progress', {
        debateId,
        active: activeCount,
        concluded: concludedCount,
        total: microDebates.length,
        elapsed: Math.round((Date.now() - phaseStart) / 1000),
        message: `🔄 Micro-round progress: ${concludedCount}/${microDebates.length} concluded (${activeCount} active)`,
      });
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  // 6. Force-conclude any remaining active micro-debates
  if (!allConcluded) {
    log('micro_timeout', {
      debateId,
      message: `⏰ Micro-round phase timed out. Force-concluding remaining micro-debates.`,
    });
    mt.autoConcludeFinished(treeId);
  }

  // 7. Synthesize all conclusions and inject into main debate
  const synthesisResult = mt.synthesizeTree(treeId);
  let synthesisSuccess = false;

  if (!synthesisResult.error) {
    synthesisSuccess = true;
    log('micro_synthesis', {
      debateId,
      treeId,
      subtopicsAnalyzed: synthesisResult.subtopicsAnalyzed,
      totalMessages: synthesisResult.totalMessages,
      topConclusions: synthesisResult.topConclusions,
      message: `🎯 MICRO-ROUND SYNTHESIS: ${synthesisResult.subtopicsAnalyzed} subtopics → ${synthesisResult.topConclusions.length} top conclusions injected into main debate`,
    });
  } else {
    log('micro_synthesis_partial', {
      debateId,
      error: synthesisResult.error,
      message: `⚠️ Partial synthesis: ${synthesisResult.error}. Injecting individual conclusions.`,
    });

    // Inject whatever conclusions we have individually
    const treeStatus = mt.getTreeStatus(treeId);
    if (treeStatus && treeStatus.conclusions) {
      const partialSynth = treeStatus.conclusions
        .map(c => `[${c.topic}]: ${c.conclusions.map(cc => cc.text).join('; ')}`)
        .join('\n');
      if (partialSynth.length > 0) {
        dm.addContext(debateId, `micro-partial-${treeId}`, partialSynth, 'micro-conclusions');
      }
    }
  }

  // 8. Clear active state
  activeMicroRounds[debateId] = {
    ...activeMicroRounds[debateId],
    phase: 'completed',
    completedAt: Date.now(),
  };

  const totalTime = Date.now() - phaseStart;

  log('micro_round_end', {
    debateId,
    treeId,
    microDebateCount: microDebates.length,
    synthesisSuccess,
    totalTimeMs: totalTime,
    message: `🔬 MICRO-ROUND COMPLETE: ${microDebates.length} micro-debates in ${Math.round(totalTime / 1000)}s. Conclusions injected. Main debate continues.`,
  });

  return {
    treeId,
    microDebateCount: microDebates.length,
    synthesisSuccess,
    totalTimeMs: totalTime,
    subtopicsAnalyzed: microDebates.map(md => ({
      topic: md.topic,
      debateId: md.debateId,
      agents: md.agents,
      room: md.room,
    })),
  };
}

// ── Strategy Genome Integration ───────────────────────────────────────

/**
 * Feed micro-round results into Strategy Genome for evolutionary learning.
 * Adds a new gene: decompositionQuality
 *
 * @param {object} microResults - Results from runMicroRound
 * @param {Array} qualityScores - Quality scores from the NEXT round (after micro-round)
 * @param {Function} log - Logger
 */
function feedbackToGenome(microResults, qualityScores, log) {
  try {
    const genome = require('./strategy-genome.cjs');
    const currentGenome = genome.loadGenome();

    if (!currentGenome || !microResults) return;

    // Compute decomposition fitness based on:
    // 1. Was synthesis successful?
    // 2. How many subtopics were identified?
    // 3. Did quality improve in the next round?
    let decompositionFitness = 0.5; // Baseline

    if (microResults.synthesisSuccess) decompositionFitness += 0.15;
    if (microResults.microDebateCount >= 3) decompositionFitness += 0.1;
    if (microResults.microDebateCount >= 5) decompositionFitness += 0.05;

    // Compare quality scores before vs after micro-round
    if (qualityScores && qualityScores.length > 0) {
      const avgQuality = qualityScores.reduce((s, q) => s + (q.composite || 0), 0) / qualityScores.length;
      if (avgQuality > 0.6) decompositionFitness += 0.1;
      if (avgQuality > 0.8) decompositionFitness += 0.1;
    }

    decompositionFitness = Math.min(1.0, Math.max(0, decompositionFitness));

    // Append to genome history with decomposition metadata
    genome.appendHistory({
      generation: currentGenome.generation,
      genes: { ...currentGenome.genes },
      fitness: decompositionFitness,
      signals: { decompositionQuality: decompositionFitness },
      debateId: microResults.treeId || 'unknown',
      type: 'micro-round',
      microDebateCount: microResults.microDebateCount,
      synthesisSuccess: microResults.synthesisSuccess,
    });

    if (log) {
      log('learning', {
        type: 'decomposition_feedback',
        fitness: decompositionFitness,
        microDebateCount: microResults.microDebateCount,
        synthesisSuccess: microResults.synthesisSuccess,
        message: `[genome] Decomposition fitness: ${decompositionFitness.toFixed(3)} (${microResults.microDebateCount} micro-debates, synthesis: ${microResults.synthesisSuccess})`,
      });
    }
  } catch (err) {
    if (log) log('error', { message: `[genome] Decomposition feedback failed: ${err.message}` });
  }
}

module.exports = {
  // Core orchestration
  shouldDecompose,
  runMicroRound,
  extractSubtopics,

  // Dashboard integration
  getMicroRoundState,
  getAgentMicroAssignments,

  // Genome feedback
  feedbackToGenome,

  // Config (can be overridden)
  MICRO_CONFIG,
};
