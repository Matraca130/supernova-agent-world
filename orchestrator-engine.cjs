/**
 * Orchestrator Engine — Server-side debate runner (coordinated mode)
 *
 * Figma Make agents provide ALL debate content via decir(). The server:
 * - Manages turns, rounds, timing
 * - Uses OpenAI as LOOP COORDINATOR: sends constant request signals to keep agents talking
 * - Uses OpenAI for SYNTHESIS at the end (summary of debate)
 * - Uses OpenAI for RETROSPECTIVES at the end (agent reflections, mejora continua)
 * - OpenAI NEVER speaks as an agent — only coordinates and summarizes
 *
 * Usage:
 *   const { runDebate } = require('./orchestrator-engine.cjs');
 *
 *   const result = await runDebate({
 *     situacion: 'mejora_codigo',
 *     tema: 'Refactorizar el sistema de autenticacion',
 *     numAgents: 4,
 *     maxRounds: 10,
 *     model: 'gpt-4o-mini',
 *     turnTimeout: 120000,
 *     onMessage: (msg) => console.log(msg)
 *   });
 */

const fs = require('fs');
const path = require('path');
const dm = require('./debate-manager.cjs');
const { buildRoundSynthesis, buildDebatePrompt } = require('./prompt-builder.cjs');
const { extractPerformanceSignals, autoUpdateCompetence, loadCompetences, saveCompetences } = require('./sm2-lite.cjs');
const { scoreResponse, generateFeedbackInstruction } = require('./quality-gate.cjs');

// Strategy genome functions (loaded with try/catch for backward compatibility)
let loadGenome, expressGenome, deepFreeze, mutateGenome, saveGenome, appendHistory, rollbackGenome;
try {
  const strategyGenome = require('./strategy-genome.cjs');
  loadGenome = strategyGenome.loadGenome;
  expressGenome = strategyGenome.expressGenome;
  deepFreeze = strategyGenome.deepFreeze;
  saveGenome = strategyGenome.saveGenome;
  // mutateGenome, appendHistory, rollbackGenome may not exist yet; define fallbacks
  mutateGenome = strategyGenome.mutateGenome || ((genome, signals) => ({ ...genome, genes: { ...genome.genes } }));
  appendHistory = strategyGenome.appendHistory || (() => {});
  rollbackGenome = strategyGenome.rollbackGenome || (() => null);
} catch (err) {
  // Strategy genome not available; define minimal no-ops (backward compat)
  loadGenome = () => null;
  expressGenome = () => '';
  deepFreeze = () => {};
  mutateGenome = (genome) => genome;
  saveGenome = () => {};
  appendHistory = () => {};
  rollbackGenome = () => null;
}

// --- Load API key from .env ---
let OPENAI_API_KEY = '';
try {
  const envPath = path.join(__dirname, '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^OPENAI_API_KEY=(.+)$/m);
  if (match) {
    OPENAI_API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
  }
} catch (err) {
  console.error('[orchestrator-engine] Failed to read .env file:', err.message);
}

// --- Constants ---
const SAFETY_CAP_ROUNDS = 30;
const DEBATE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const AGENT_DELAY_MS = 200;
const LOOP_COORDINATOR_INTERVAL = 1; // Run loop coordinator EVERY round (ADR-007: closer to Principal-Synthesizer pattern)

// --- ADR-009 Capa 1: Quality feedback storage per round ---
let lastRoundQualityScores = []; // Stores quality scores from the previous round for Loop Coordinator
let allDebateQualityScores = []; // ADR-009 Capa 2: Accumulates ALL quality scores across rounds for genome fitness

// --- Utility: sleep ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- OpenAI API call (for coordination, synthesis, retrospectives ONLY — never agent responses) ---

async function callLLM(prompt, model = 'gpt-4o-mini') {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not found in .env file');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error('Invalid response structure from OpenAI API');
  }
  return data.choices[0].message.content;
}

// --- Loop Coordinator: keeps Figma Make agents talking ---

function buildLoopCoordinatorPrompt(debate, recentMessages, agents, round, maxRounds, qualityFeedback) {
  const agentList = agents.map(a => `${a.name} (${a.role})`).join(', ');
  const msgBlock = recentMessages.length > 0
    ? recentMessages.map(m => `[${m.participantName} (${m.participantRole})]: ${(m.text || '').slice(0, 200)}`).join('\n')
    : '(No messages yet)';

  // ADR-009 Capa 1: Quality feedback from previous round
  let qualityBlock = '';
  if (qualityFeedback && qualityFeedback.length > 0) {
    qualityBlock = '\nQUALITY SCORES (previous round — use to give SPECIFIC feedback):\n' +
      qualityFeedback.map(s => {
        const weak = [];
        if (s.relevance < 0.4) weak.push(`relevance=${s.relevance}`);
        if (s.novelty < 0.3) weak.push(`novelty=${s.novelty}`);
        if (s.concreteness < 0.3) weak.push(`concreteness=${s.concreteness}`);
        if (s.argumentQuality < 0.3) weak.push(`argumentQuality=${s.argumentQuality}`);
        const weakStr = weak.length > 0 ? ` WEAK: ${weak.join(', ')}` : ' ALL GOOD';
        return `  ${s.agentName}: composite=${s.composite}${weakStr}`;
      }).join('\n') + '\n';
  }

  return `You are a LOOP COORDINATOR for a multi-agent debate with Claude Opus 4.6 agents. Your job is to generate a STRUCTURED coordination signal with 3 components. You do NOT participate in the debate.

TOPIC: ${debate.topic}
ROUND: ${round}/${maxRounds}
AGENTS: ${agentList}

RECENT MESSAGES:
${msgBlock}
${qualityBlock}
Generate a coordination signal (max 150 words) with EXACTLY these 3 sections:

DIRECTIVA: [Who should speak next and what specific action they must take. Name the agent and reference a concrete point from recent messages.]

TENSIONES: [List 1-2 unresolved disagreements or open questions from recent messages that need direct confrontation. Quote the conflicting positions.]

OPORTUNIDADES: [Identify 1 connection between messages that no one has made yet. Suggest a synthesis or unexpected angle.]

Examples:
DIRECTIVA: Arquitecto, respond directly to Frontend Dev's concern about coupling in message #5. Propose a concrete alternative with file paths.
TENSIONES: QA says auth flow is insecure (msg #3) but Arquitecto says it's sufficient (msg #4). This needs resolution.
OPORTUNIDADES: Frontend Dev's caching idea (msg #2) could solve QA's performance concern (msg #6) if combined.

YOUR SIGNAL:`;
}

// --- Synthesis prompt (end of debate) ---

function buildSynthesisPrompt(debate, pastRetrospectives) {
  const allMessages = debate.messages.map(m =>
    `[Round ${m.round}] ${m.participantName} (${m.participantRole}): ${m.text}`
  ).join('\n\n');

  let retroBlock = '';
  if (pastRetrospectives && pastRetrospectives.length > 0) {
    retroBlock = '\n\nINSIGHTS FROM PREVIOUS DEBATES:\n' +
      pastRetrospectives.map(r => `- ${r.agent}: "${r.retro}"`).join('\n') +
      '\nConsider these insights when synthesizing.\n';
  }

  return `You are a neutral debate moderator. Summarize the following debate comprehensively.

DEBATE TOPIC: ${debate.topic}
TOTAL ROUNDS: ${debate.currentRound}
PARTICIPANTS: ${debate.participants.map(p => `${p.name} (${p.role})`).join(', ')}

ALL MESSAGES:
${allMessages}
${retroBlock}
Provide a structured synthesis with:
1. KEY AGREEMENTS — Points where participants found common ground
2. KEY DISAGREEMENTS — Unresolved conflicts and opposing views
3. DECISIONS MADE — Any concrete conclusions or recommendations that emerged
4. OPEN QUESTIONS — Issues that remain unresolved and need further discussion
5. STRONGEST ARGUMENTS — The most compelling points made during the debate

Be concise but thorough. Write in the same language as the debate messages.`;
}

// --- Wait for external agent (coordinated mode) ---

// --- Agent heartbeat tracking ---
const agentHeartbeats = {}; // { agentName: { lastSeen: timestamp, status: 'thinking'|'composing'|'idle'|'dead' } }

function updateHeartbeat(agentName, status = 'thinking') {
  agentHeartbeats[agentName] = { lastSeen: Date.now(), status };
}

function getHeartbeat(agentName) {
  return agentHeartbeats[agentName] || { lastSeen: 0, status: 'unknown' };
}

function getAllHeartbeats() {
  const now = Date.now();
  const result = {};
  for (const [name, hb] of Object.entries(agentHeartbeats)) {
    const elapsed = now - hb.lastSeen;
    result[name] = {
      ...hb,
      elapsed,
      alive: elapsed < 60000, // Consider dead after 60s without heartbeat
      status: elapsed > 60000 ? 'dead' : elapsed > 30000 ? 'slow' : hb.status,
    };
  }
  return result;
}

async function waitForExternalAgent(debateId, agentName, log, timeoutMs = 120000) {
  const startWait = Date.now();
  const initialMsgCount = (dm.read(debateId, 0, 0).messages || []).length;

  // Mark agent as thinking (heartbeat)
  updateHeartbeat(agentName, 'thinking');

  log('turn_request', {
    debateId,
    agent: agentName,
    message: `Waiting for ${agentName} to respond via decir()`,
    timeout_seconds: Math.round(timeoutMs / 1000),
  });

  const agentNameLower = agentName.toLowerCase();
  let heartbeatCounter = 0;

  while (Date.now() - startWait < timeoutMs) {
    const current = dm.read(debateId, 0, 0);

    // Check if debate was finalized externally
    if (current.debate && (current.debate.status === 'finished' || current.debate.status === 'cancelled')) {
      updateHeartbeat(agentName, 'idle');
      log('system', { message: `Debate ${debateId} was finalized during wait for ${agentName}` });
      return null;
    }

    const messages = current.messages || [];

    if (messages.length > initialMsgCount) {
      const newMsgs = messages.slice(initialMsgCount);
      // Case-insensitive name matching to handle naming variations
      const agentMsg = newMsgs.find(m =>
        m.participantName === agentName ||
        (m.participantName && m.participantName.toLowerCase() === agentNameLower)
      );
      if (agentMsg) {
        updateHeartbeat(agentName, 'idle');
        return agentMsg;
      }
    }

    // Heartbeat: log progress every 10s so dashboard knows agent is alive
    heartbeatCounter++;
    if (heartbeatCounter % 5 === 0) { // Every 10s (5 * 2s poll)
      const elapsed = Math.round((Date.now() - startWait) / 1000);
      updateHeartbeat(agentName, 'composing');
      log('agent_heartbeat', {
        debateId,
        agent: agentName,
        elapsed_seconds: elapsed,
        status: 'composing',
        message: `${agentName} still composing (${elapsed}s elapsed)`,
      });
    }

    await sleep(2000); // Poll every 2s
  }

  updateHeartbeat(agentName, 'dead');
  return null; // Timeout — agent didn't respond
}

// --- Repetition detection ---

function areResponsesRepetitive(messages, windowSize = 8) {
  if (messages.length < windowSize) return false;

  const recent = messages.slice(-windowSize);
  const texts = recent.map(m => m.text.toLowerCase().trim());

  // Check for high similarity between consecutive messages from the same participant
  let similarPairs = 0;
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (recent[i].participantName === recent[j].participantName) {
        const similarity = computeJaccardSimilarity(texts[i], texts[j]);
        if (similarity > 0.7) similarPairs++;
      }
    }
  }

  // If more than half of same-participant pairs are highly similar, it's repetitive
  return similarPairs >= 3;
}

function computeJaccardSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// --- Consensus close detection ---

/**
 * Detects when a supermajority of agents have voted to close the debate.
 * Scans recent messages for close patterns (VOTO CIERRE, DONE, CERRAR, etc).
 * Requires 66%+ of agents OR N-1 agents (whichever is larger) to trigger.
 *
 * @param {Array} messages - All debate messages
 * @param {Array} agents - All debate agents
 * @param {number} windowSize - Number of recent messages to scan
 * @returns {boolean} True if consensus close detected
 */
function detectConsensusClose(messages, agents, windowSize = 12) {
  if (!messages || messages.length < agents.length) return false;

  const recentMsgs = messages.slice(-Math.min(windowSize, messages.length));
  const closePatterns = /\b(VOTO\s*CIERRE|\bDONE\b|\bCERRAR\b|\bFUERA\b|consenso.*cierre|cierre.*consenso|HANDOFF|CLOSING\s*STATEMENT)/i;

  const voterSet = new Set();
  for (const msg of recentMsgs) {
    if (msg.text && closePatterns.test(msg.text)) {
      voterSet.add(msg.participantName);
    }
  }

  // Require supermajority: 66% OR N-1, whichever is larger
  const threshold = Math.max(Math.ceil(agents.length * 0.66), agents.length - 1);
  return voterSet.size >= threshold;
}

// --- Build a structural summary (no AI, just facts) ---

function buildStructuralSummary(debateData) {
  if (!debateData || debateData.messages.length === 0) {
    return 'No messages were generated during this debate.';
  }

  const { topic, messages, currentRound, participants } = debateData;

  const participantLines = participants.map(p => `  - ${p.name} (${p.role})`).join('\n');

  // Count messages per participant
  const msgCounts = {};
  for (const msg of messages) {
    const name = msg.participantName || 'unknown';
    msgCounts[name] = (msgCounts[name] || 0) + 1;
  }
  const contributionLines = Object.entries(msgCounts)
    .map(([name, count]) => `  - ${name}: ${count} message${count !== 1 ? 's' : ''}`)
    .join('\n');

  return [
    `DEBATE SUMMARY`,
    `==============`,
    `Topic: ${topic}`,
    `Rounds completed: ${currentRound}`,
    `Total messages: ${messages.length}`,
    ``,
    `Participants:`,
    participantLines,
    ``,
    `Contributions:`,
    contributionLines,
  ].join('\n');
}

// --- Main debate runner ---

async function runDebate(config) {
  const {
    situacion = 'libre',
    tema,
    numAgents = 4,
    maxRounds = 10,
    model = 'gpt-4o-mini',
    onMessage = null,
    turnTimeout = 120000,
  } = config;

  if (!tema) {
    throw new Error('tema is required');
  }

  const startTime = Date.now();
  const log = (type, data) => {
    if (onMessage) {
      try {
        onMessage({ type, timestamp: Date.now(), ...data });
      } catch (e) {
        // Ignore callback errors
      }
    }
  };

  log('system', { message: `Starting debate: "${tema}" with ${numAgents} agents, situacion: ${situacion}, mode: coordinated` });

  // 0.9 Dedup: check for existing active debates with similar topic
  const allDebates = dm.listDebates ? dm.listDebates() : [];
  const activeDebates = allDebates.filter(d => d.status === 'active');
  
  // Clean stale debates (0 messages, older than 10 minutes)
  const now = Date.now();
  for (const d of activeDebates) {
    const msgCount = (d.messages || []).length;
    const age = d.createdAt ? now - new Date(d.createdAt).getTime() : 0;
    if (msgCount === 0 && age > 10 * 60 * 1000) {
      try {
        dm.finishDebate(d.id, 'Auto-closed: stale debate with 0 messages', true);
        log('system', { message: `[dedup] Auto-closed stale debate ${d.id} (0 msgs, ${Math.round(age/60000)}min old)` });
      } catch (e) { /* ignore */ }
    }
  }
  
  // Topic similarity check: find active debate with >50% keyword overlap
  function normalizeForDedup(topic) {
    return (topic || '').toLowerCase()
      .replace(/\[.*?\]/g, '') // Remove [🛠️ MEJORA DE CÓDIGO] etc
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !['para','como','este','todo','code','codigo','mejora','sprint','strategy','genome','debate','bugs','fixes'].includes(w));
  }
  
  const newTokens = new Set(normalizeForDedup(tema));
  let existingDebateId = null;
  
  if (newTokens.size > 0) {
    for (const d of activeDebates) {
      if (d.status !== 'active') continue;
      const existingTokens = new Set(normalizeForDedup(d.topic));
      if (existingTokens.size === 0) continue;
      const intersection = [...newTokens].filter(t => existingTokens.has(t));
      const union = new Set([...newTokens, ...existingTokens]);
      const similarity = intersection.length / union.size;
      if (similarity > 0.4) {
        existingDebateId = d.id;
        log('system', { message: `[dedup] Found similar active debate ${d.id} (${(similarity*100).toFixed(0)}% overlap). Reusing instead of creating duplicate.` });
        break;
      }
    }
  }
  
  // 1. Create debate via crearSituacion (or reuse existing)
  let creation;
  if (existingDebateId) {
    // Reuse existing debate
    const existingDebate = allDebates.find(d => d.id === existingDebateId);
    creation = { debate: existingDebate, agents: existingDebate.participants || [] };
    log('system', { message: `[dedup] Reusing debate ${existingDebateId} instead of creating new one` });
  } else {
    creation = dm.crearSituacion(situacion, tema, numAgents);
  }
  if (creation.error) {
    throw new Error(`Failed to create debate: ${creation.error}`);
  }

  const debate = creation.debate;
  const debateId = debate.id;
  const agents = creation.agents || [];

  if (agents.length === 0) {
    throw new Error('No agents were created for the debate');
  }

  log('debate_created', {
    debateId,
    topic: debate.topic,
    agents: agents.map(a => ({ name: a.name, role: a.role })),
    maxRounds: debate.maxRounds,
  });

  // 1.5 Load active principles from previous debates
  let activePrinciples = [];
  try {
    const principles = require('./principles.cjs');
    activePrinciples = principles.getActivePrinciples(10);
    if (activePrinciples.length > 0) {
      principles.markPrinciplesUsed(activePrinciples.map(p => p.id), debateId);
      log('system', { message: `[principles] Loaded ${activePrinciples.length} active principles` });
    }
  } catch (err) {
    log('error', { message: `[principles] Failed to load: ${err.message}` });
  }

  // 1.6 Load and freeze strategy genome (ADR-009 Capa 2)
  let frozenGenome = null;
  let genomePhenotype = '';
  if (loadGenome) {
    try {
      frozenGenome = loadGenome();
      if (frozenGenome) {
        genomePhenotype = expressGenome(frozenGenome);
        deepFreeze(frozenGenome);
        log('system', { message: `[genome] Loaded and frozen genome v${frozenGenome.version}. Phenotype: ${genomePhenotype ? 'active' : 'neutral'}` });
      }
    } catch (err) {
      log('error', { message: `[genome] Failed to load: ${err.message}` });
    }
  }

  // 1.7 Reset quality scores accumulator for this debate
  allDebateQualityScores = [];

  // 2. Run rounds
  const effectiveMaxRounds = maxRounds > 0 ? Math.min(maxRounds, SAFETY_CAP_ROUNDS) : SAFETY_CAP_ROUNDS;
  let roundCount = 0;

  try {
    while (roundCount < effectiveMaxRounds) {
      // Timeout check
      if (Date.now() - startTime > DEBATE_TIMEOUT_MS) {
        log('system', { message: 'Debate timeout reached (10 minutes). Finishing.' });
        break;
      }

      roundCount++;
      log('round_start', { round: roundCount, debateId });

      // Loop Coordinator: send constant signals to keep agents going
      let loopInstruction = null;
      if (roundCount >= 2 && roundCount % LOOP_COORDINATOR_INTERVAL === 0 && debate.messages.length > 0) {
        try {
          const recentMsgs = debate.messages.slice(-6);
          const coordPrompt = buildLoopCoordinatorPrompt(debate, recentMsgs, agents, roundCount, effectiveMaxRounds, lastRoundQualityScores);
          loopInstruction = await callLLM(coordPrompt, model);
          if (loopInstruction) {
            log('loop_coordinator', { round: roundCount, instruction: loopInstruction.trim() });
          }
        } catch (err) {
          log('error', { message: `[loop-coordinator] failed: ${err.message}` });
        }
      }

      // Get pending turns
      const pending = dm.getAllPendingTurns(debateId);

      if (pending.error) {
        log('error', { message: `getAllPendingTurns error: ${pending.error}` });
        break;
      }

      if (pending.finished) {
        log('system', { message: 'Debate was finished by the manager.' });
        break;
      }

      // If all spoke this round, advance to next round
      if (pending.allSpoke) {
        const advanceResult = dm.nextRound(debateId, true);
        if (advanceResult.error) {
          log('error', { message: `nextRound error: ${advanceResult.error}` });
          break;
        }
        if (advanceResult.status === 'finished') {
          log('system', { message: 'Debate reached maxRounds and finished.' });
          break;
        }

        // Re-fetch pending turns for the new round
        const newPending = dm.getAllPendingTurns(debateId);
        if (newPending.error || newPending.finished || newPending.allSpoke) {
          break;
        }

        // Process this new round's turns
        await processRoundTurns(newPending, debate, debateId, agents, log, startTime, turnTimeout);
      } else {
        // Process pending turns
        await processRoundTurns(pending, debate, debateId, agents, log, startTime, turnTimeout);
      }

      // Check repetitiveness in infinite mode
      if (maxRounds === 0 && debate.messages.length > 16) {
        if (areResponsesRepetitive(debate.messages)) {
          log('system', { message: 'Responses becoming repetitive. Ending debate.' });
          break;
        }
      }

      // Check for consensus close (agents voting to end the debate)
      if (debate.messages.length >= agents.length * 2) {
        if (detectConsensusClose(debate.messages, agents, agents.length * 2)) {
          log('system', { message: `Consensus close detected: ${agents.length}+ agents voted to end. Finishing debate.` });
          break;
        }
      }

      // Generate round synthesis (Principal Agent pattern from Claude Code)
      try {
        const roundMsgs = (debate.messages || []).filter(m => m.round === roundCount);
        if (roundMsgs.length >= 2) {
          const roundSynth = buildRoundSynthesis(roundMsgs, roundCount);
          if (roundSynth) {
            dm.addContext(debateId, `round-${roundCount}-synthesis`, roundSynth, 'round-synthesis');
            log('round_synthesis', { round: roundCount, agentCount: roundMsgs.length, preview: roundSynth.slice(0, 200) });
          }

          // ── CONTINUOUS LEARNING: Auto-calibrate agent competence per round ──
          try {
            const competences = loadCompetences();
            let updated = 0;
            for (const agent of agents) {
              const signals = extractPerformanceSignals(roundMsgs, agent.name);
              if (signals) {
                const result = autoUpdateCompetence(competences, agent.name, signals);
                if (result) updated++;
              }
            }
            if (updated > 0) {
              saveCompetences(competences);
              log('learning', {
                round: roundCount,
                message: `Auto-calibrated ${updated}/${agents.length} agent competences`,
                type: 'competence_update',
              });
            }
          } catch (learnErr) {
            log('error', { message: `[continuous-learning] competence update failed: ${learnErr.message}` });
          }

          // ── ADR-009 Capa 1: Score round messages for feedback loop ──
          try {
            const participantNames = agents.map(a => a.name);
            const { parseCheckpoint } = require('./prompt-builder.cjs');
            const scorePromises = roundMsgs.map((m, idx) => {
              const checkpoint = parseCheckpoint(m.text || '', m.participantName || 'unknown', roundCount);
              return scoreResponse(m.text || '', tema, m.participantName || 'unknown', roundCount, idx, participantNames, checkpoint)
                .catch(() => ({ agentName: m.participantName || 'unknown', composite: 0, relevance: 0, novelty: 0, concreteness: 0, argumentQuality: 0, structuredThought: 0 }))
            });
            lastRoundQualityScores = await Promise.all(scorePromises);
            allDebateQualityScores.push(...lastRoundQualityScores);
            log('learning', {
              round: roundCount,
              message: `Quality scored ${lastRoundQualityScores.length} messages (${allDebateQualityScores.length} total). Avg composite: ${(lastRoundQualityScores.reduce((s, q) => s + q.composite, 0) / lastRoundQualityScores.length).toFixed(3)}`,
              type: 'quality_feedback',
            });
          } catch (qErr) {
            log('error', { message: `[quality-feedback] scoring failed: ${qErr.message}` });
          }
        }
      } catch (err) {
        log('error', { message: `[round-synthesis] failed: ${err.message}` });
      }

      // After processing, check if we need to advance the round
      const postCheck = dm.getAllPendingTurns(debateId);
      if (postCheck.allSpoke) {
        const advResult = dm.nextRound(debateId, true);
        if (advResult.status === 'finished') {
          log('system', { message: 'Debate reached maxRounds and finished.' });
          break;
        }
      } else if (postCheck.finished) {
        break;
      }
    }
  } catch (err) {
    log('error', { message: `Debate loop error: ${err.message}` });
  }

  // 2.5 Warn if coordinated mode produced no messages (no agents connected?)
  if (!debate.messages || debate.messages.length === 0) {
    log('warning', {
      message: 'Coordinated debate finished with 0 messages. No Figma Make agents responded. Ensure agents are connected and calling onboarding() + decir().',
    });
  }

  // 3. Generate synthesis via OpenAI (end of debate only)
  log('system', { message: 'Generating synthesis...' });
  const synthesisData = getDebateData(debateId);
  let synthesis = '';
  try {
    let pastRetros = [];
    try {
      const outcomesModule = require('./debate-outcomes.cjs');
      pastRetros = outcomesModule.getRecentRetrospectives(3);
    } catch {}

    if (synthesisData && synthesisData.messages.length > 0) {
      synthesis = await callLLM(buildSynthesisPrompt(synthesisData, pastRetros), model);
      log('synthesis', { synthesis });
    } else {
      synthesis = 'No messages were generated during this debate.';
    }
  } catch (err) {
    log('error', { message: `Synthesis generation failed: ${err.message}` });
    synthesis = buildStructuralSummary(synthesisData); // fallback to structural
  }

  // 3.5 Extract principles from messages (best-effort without synthesis)
  let extractedPrinciples = [];
  try {
    const principles = require('./principles.cjs');
    const allText = (synthesisData ? synthesisData.messages : [])
      .map(m => m.text || '')
      .join('\n');
    const actionItemLines = allText.split('\n')
      .map(l => l.trim())
      .filter(l => /^(\d+[\.\)]\s|[-*]\s)/.test(l))
      .map(l => l.replace(/^(\d+[\.\)]\s|[-*]\s)/, '').trim())
      .filter(l => l.length > 10);
    extractedPrinciples = principles.extractPrinciples(allText, debateId, actionItemLines) || [];
  } catch (err) {
    log('error', { message: `[principles] extraction failed: ${err.message}` });
  }

  // 3.6 Run principles maintenance (correlate + retire bad)
  try {
    const principlesModule = require('./principles.cjs');
    const outcomesModule = require('./debate-outcomes.cjs');
    const correlationData = outcomesModule.getCorrelationData();
    if (correlationData.length >= 2) {
      const maintenance = principlesModule.runMaintenance(correlationData);
      if (maintenance.retired.length > 0) {
        log('system', { message: `[principles] Retired ${maintenance.retired.length} bad principles: ${maintenance.retired.join(', ')}` });
      }
      log('system', { message: `[principles] Maintenance: ${maintenance.correlated} correlated, ${maintenance.total} total` });
    }
  } catch (err) {
    log('error', { message: `[principles] maintenance failed: ${err.message}` });
  }

  // 3.65 Record outcome for self-improvement
  const allPrinciplesUsed = [...(activePrinciples ? activePrinciples.map(p => p.id) : []), ...(extractedPrinciples || []).map(p => p.id)];
  try {
    const outcomes = require('./debate-outcomes.cjs');
    outcomes.recordOutcome({
      debateId,
      topic: tema,
      messages: debate.messages || [],
      rounds: debate.currentRound || roundCount,
      maxRounds: effectiveMaxRounds,
      duration: Date.now() - startTime,
      agents,
      synthesis,
      principlesUsed: allPrinciplesUsed,
      qualityScores: [],
      repetitionDetected: maxRounds === 0 && debate.messages.length > 16 && areResponsesRepetitive(debate.messages),
    });
  } catch (err) {
    log('error', { message: `[outcomes] Failed to record: ${err.message}` });
  }

  // 3.67 Strategy Genome mutation (ADR-009 Capa 2: blended fitness evolutionary learning)
  try {
    const freshGenome = loadGenome(); // Load fresh (unfrozen) copy for mutation
    if (allDebateQualityScores.length > 0) {
      // Compute average quality scores across all rounds
      const avgSignals = { concreteness: 0, argumentQuality: 0, relevance: 0, novelty: 0, structuredThought: 0 };
      for (const s of allDebateQualityScores) {
        avgSignals.concreteness += (s.concreteness || 0);
        avgSignals.argumentQuality += (s.argumentQuality || 0);
        avgSignals.relevance += (s.relevance || 0);
        avgSignals.novelty += (s.novelty || 0);
        avgSignals.structuredThought += (s.structuredThought || 0);
      }
      const count = allDebateQualityScores.length;
      avgSignals.concreteness /= count;
      avgSignals.argumentQuality /= count;
      avgSignals.relevance /= count;
      avgSignals.novelty /= count;
      avgSignals.structuredThought /= count;

      // Blend with effective rating ONLY if human rating exists (70% quality-gate, 30% rating)
      const outcomesForGenome = require('./debate-outcomes.cjs');
      const outcomeForGenome = outcomesForGenome.getOutcome(debateId);
      // Only blend rating when there is an explicit human rating — avoids constant bias from neutral fallback
      const hasHumanRating = !!(outcomeForGenome && outcomeForGenome.rating);
      const blendedSignals = hasHumanRating
        ? (() => {
            const effectiveRating = outcomesForGenome.getEffectiveRating(outcomeForGenome) || 3;
            const ratingNorm = effectiveRating / 5;
            return {
              concreteness: avgSignals.concreteness * 0.7 + ratingNorm * 0.3,
              argumentQuality: avgSignals.argumentQuality * 0.7 + ratingNorm * 0.3,
              relevance: avgSignals.relevance * 0.7 + ratingNorm * 0.3,
              novelty: avgSignals.novelty * 0.7 + ratingNorm * 0.3,
              structuredThought: avgSignals.structuredThought * 0.7 + ratingNorm * 0.3,
            };
          })()
        : { ...avgSignals };

      let mutated = mutateGenome(freshGenome, blendedSignals);
      // Check for rollback: if 3 consecutive bad debates, reset genome to defaults
      const rolledBack = rollbackGenome(mutated);
      if (rolledBack) {
        mutated = rolledBack;
        log('warning', { message: `[genome] ROLLBACK triggered after ${ROLLBACK_WINDOW} consecutive bad debates. Reset to defaults.`, type: 'genome_rollback' });
      }
      saveGenome(mutated);
      appendHistory({
        generation: mutated.generation,
        genes: { ...mutated.genes },
        fitness: mutated.fitnessEMA ?? 0.5,
        signals: blendedSignals,
        debateId,
        rolledBack: !!rolledBack,
      });
      log('learning', {
        message: `[genome] Mutated with blended fitness (${count} scores). concreteness=${blendedSignals.concreteness.toFixed(3)}, argQuality=${blendedSignals.argumentQuality.toFixed(3)}, relevance=${blendedSignals.relevance.toFixed(3)}`,
        type: 'genome_mutation',
        genes: { ...mutated.genes },
      });
    }
  } catch (err) {
    // Fail silently if strategy-genome.cjs doesn't exist yet (backward compat)
    if (!err.message.includes('Cannot find module')) {
      log('error', { message: `[genome] Mutation failed: ${err.message}` });
    }
  }

  // 3.7 Agent retrospectives via OpenAI (end of debate — mejora continua)
  const retrospectives = [];
  try {
    const retroPromptBase = (agentName, agentRole, topic, synthesisText) =>
      `You are ${agentName} (${agentRole}). A debate just finished on: "${topic}".

Here is the synthesis:
${synthesisText.slice(0, 1500)}

In EXACTLY ONE SENTENCE (max 30 words), describe what you learned or what you would do differently next time. Be specific and self-critical. Start with "I learned..." or "Next time I would..."`;

    const retroPromises = agents.map(agent =>
      callLLM(retroPromptBase(agent.name, agent.role, tema, synthesis), model)
        .then(text => ({ agent: agent.name, role: agent.role, retro: text.trim().split('\n')[0].slice(0, 150) }))
        .catch(() => ({ agent: agent.name, role: agent.role, retro: null }))
    );
    const retroResults = await Promise.all(retroPromises);

    for (const r of retroResults) {
      if (r.retro) {
        retrospectives.push(r);
        log('retrospective', { agent: r.agent, retro: r.retro });
      }
    }
  } catch (err) {
    log('error', { message: `[retrospectives] failed: ${err.message}` });
  }

  // 4. Finish debate
  try {
    dm.finishDebate(debateId, synthesis, true); // _skipConsensus = true
  } catch (err) {
    log('error', { message: `finishDebate error: ${err.message}` });
  }

  const duration = Date.now() - startTime;
  const finalData = getDebateData(debateId);

  const result = {
    debateId,
    messages: finalData ? finalData.messages : [],
    rounds: finalData ? finalData.currentRound : roundCount,
    synthesis,
    retrospectives,
    duration,
  };

  log('debate_finished', {
    debateId,
    totalMessages: result.messages.length,
    totalRounds: result.rounds,
    duration,
  });

  return result;
}

// --- Process all pending turns for a round ---

async function processRoundTurns(pending, debate, debateId, agents, log, startTime, turnTimeout = 120000) {
  if (!pending.turns || pending.turns.length === 0) return;

  // Reorder turns by agent competence (most competent first)
  let orderedTurns = pending.turns;
  try {
    const sm2 = require('./sm2-lite.cjs');
    const competences = sm2.loadCompetences();
    orderedTurns = [...pending.turns].sort((a, b) => {
      const nameA = (a.agent && a.agent.name) || '';
      const nameB = (b.agent && b.agent.name) || '';
      const compA = sm2.getCompetenceForAgent(competences, nameA);
      const compB = sm2.getCompetenceForAgent(competences, nameB);
      if (!compA && !compB) return 0;
      if (!compA) return 1;
      if (!compB) return -1;
      const weightA = sm2.getAgentWeight(compA, debate.topic || '');
      const weightB = sm2.getAgentWeight(compB, debate.topic || '');
      return weightB - weightA; // Higher weight first
    });
  } catch (err) {
    // Fall back to default order if sm2-lite fails
  }

  // --- PARALLEL WAIT (ADR-007 Level 1) ---
  // Launch all agent waits simultaneously. Results processed in competence order.
  if (Date.now() - startTime > DEBATE_TIMEOUT_MS) {
    log('system', { message: 'Debate timeout before parallel batch.' });
    return;
  }

  const resolvedTurns = orderedTurns.map(turn => {
    const turnAgent = turn.agent || {};
    return {
      turn,
      agent: agents.find(a => a.name === turnAgent.name) || {
        name: turnAgent.name || 'unknown',
        role: turnAgent.role || 'participant',
        desc: turnAgent.roleDesc || turnAgent.role || 'participant',
      },
    };
  });

  // Log which agents are entering parallel wait (for dashboard status)
  const pendingNames = resolvedTurns.map(({ agent }) => agent.name);
  log('parallel_wait_start', {
    debateId,
    round: debate.currentRound,
    agents: pendingNames,
    message: `Waiting for ${pendingNames.length} agents in parallel: ${pendingNames.join(', ')}`,
  });

  const waitPromises = resolvedTurns.map(({ agent }) =>
    waitForExternalAgent(debateId, agent.name, log, turnTimeout)
      .then(msg => ({ agent, msg, responseTime: Date.now() }))
      .catch(() => ({ agent, msg: null, responseTime: Date.now() }))
  );

  const results = await Promise.allSettled(waitPromises);

  // Track response order and timing for analytics
  const responseStats = { responded: [], timedOut: [], totalMs: 0 };
  const batchStart = Date.now();

  for (const result of results) {
    const val = result.status === 'fulfilled' ? result.value : { agent: { name: 'unknown', role: 'unknown' }, msg: null };
    if (val.msg) {
      const respTime = val.responseTime ? val.responseTime - batchStart : 0;
      responseStats.responded.push({ name: val.agent.name, ms: respTime });
      log('agent_message', {
        agent: val.agent.name,
        role: val.agent.role,
        round: debate.currentRound,
        wordCount: (val.msg.text || '').trim().split(/\s+/).length,
        preview: (val.msg.text || '').slice(0, 200),
        status: 'responded',
      });
    } else {
      responseStats.timedOut.push(val.agent.name);
      log('turn_timeout', {
        debateId,
        agent: val.agent.name,
        message: `${val.agent.name} did not respond within ${Math.round(turnTimeout / 1000)}s — skipping turn`,
        status: 'timeout',
      });
    }
  }

  // Summary log for the round batch
  log('parallel_wait_end', {
    debateId,
    round: debate.currentRound,
    responded: responseStats.responded.length,
    timedOut: responseStats.timedOut.length,
    timedOutAgents: responseStats.timedOut,
    message: `Round batch complete: ${responseStats.responded.length} responded, ${responseStats.timedOut.length} timed out`,
  });
}

// --- Helper: get raw debate data from debate-manager ---

function getDebateData(debateId) {
  // read() returns { debate: { id, topic, status, currentRound, ... }, messages: [...], ... }
  const readResult = dm.read(debateId, 0, 0);
  if (readResult.error) return null;

  const debateInfo = readResult.debate || {};
  const messages = readResult.messages || [];

  // Reconstruct participants list from messages (read() doesn't expose full participant objects)
  const participantMap = new Map();
  for (const msg of messages) {
    if (msg.participantName && !participantMap.has(msg.participantName)) {
      participantMap.set(msg.participantName, {
        name: msg.participantName,
        role: msg.participantRole || 'participant',
      });
    }
  }

  return {
    id: debateId,
    topic: debateInfo.topic || '',
    messages,
    currentRound: debateInfo.currentRound || 0,
    participants: Array.from(participantMap.values()),
    status: debateInfo.status || 'unknown',
  };
}

module.exports = { runDebate, getAllHeartbeats, getHeartbeat, updateHeartbeat };
