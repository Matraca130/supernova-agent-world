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
const LOOP_COORDINATOR_INTERVAL = 2; // Run loop coordinator every N rounds

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

function buildLoopCoordinatorPrompt(debate, recentMessages, agents, round, maxRounds) {
  const agentList = agents.map(a => `${a.name} (${a.role})`).join(', ');
  const msgBlock = recentMessages.length > 0
    ? recentMessages.map(m => `[${m.participantName} (${m.participantRole})]: ${(m.text || '').slice(0, 200)}`).join('\n')
    : '(No messages yet)';

  return `You are a LOOP COORDINATOR for a multi-agent debate with Claude Opus 4.6 agents. Your job is to generate a STRUCTURED coordination signal with 3 components. You do NOT participate in the debate.

TOPIC: ${debate.topic}
ROUND: ${round}/${maxRounds}
AGENTS: ${agentList}

RECENT MESSAGES:
${msgBlock}

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

async function waitForExternalAgent(debateId, agentName, log, timeoutMs = 120000) {
  const startWait = Date.now();
  const initialMsgCount = (dm.read(debateId, 0, 0).messages || []).length;

  log('turn_request', {
    debateId,
    agent: agentName,
    message: `Waiting for ${agentName} to respond via decir()`,
    timeout_seconds: Math.round(timeoutMs / 1000),
  });

  const agentNameLower = agentName.toLowerCase();

  while (Date.now() - startWait < timeoutMs) {
    const current = dm.read(debateId, 0, 0);

    // Check if debate was finalized externally
    if (current.debate && (current.debate.status === 'finished' || current.debate.status === 'cancelled')) {
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
        return agentMsg;
      }
    }

    await sleep(2000); // Poll every 2s
  }

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

  // 1. Create debate via crearSituacion
  const creation = dm.crearSituacion(situacion, tema, numAgents);
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
          const coordPrompt = buildLoopCoordinatorPrompt(debate, recentMsgs, agents, roundCount, effectiveMaxRounds);
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

  for (const turn of orderedTurns) {
    // Timeout check
    if (Date.now() - startTime > DEBATE_TIMEOUT_MS) {
      break;
    }

    // Each turn has an .agent object with { name, role, roleDesc }
    const turnAgent = turn.agent || {};
    const agent = agents.find(a => a.name === turnAgent.name) || {
      name: turnAgent.name || 'unknown',
      role: turnAgent.role || 'participant',
      desc: turnAgent.roleDesc || turnAgent.role || 'participant',
    };

    // Wait for external agent to call decir()
    const agentMsg = await waitForExternalAgent(debateId, agent.name, log, turnTimeout);

    if (agentMsg) {
      log('agent_message', {
        agent: agent.name,
        role: agent.role,
        round: debate.currentRound,
        wordCount: (agentMsg.text || '').trim().split(/\s+/).length,
        preview: (agentMsg.text || '').slice(0, 200),
      });
    } else {
      log('turn_timeout', {
        debateId,
        agent: agent.name,
        message: `${agent.name} did not respond within ${Math.round(turnTimeout / 1000)}s — skipping turn`,
      });
    }

    // Small delay between agents
    await sleep(AGENT_DELAY_MS);
  }
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

module.exports = { runDebate };
