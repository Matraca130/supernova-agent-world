/**
 * Orchestrator Engine — Server-side autonomous debate runner
 *
 * Runs multi-agent debates WITHOUT depending on external AI clients.
 * The server itself calls OpenAI's API to generate agent responses.
 *
 * Usage:
 *   const { runDebate } = require('./orchestrator-engine.cjs');
 *   const result = await runDebate({
 *     situacion: 'mejora_codigo',
 *     tema: 'Refactorizar el sistema de autenticacion',
 *     numAgents: 4,
 *     maxRounds: 10,
 *     onMessage: (msg) => console.log(msg)
 *   });
 */

const fs = require('fs');
const path = require('path');
const dm = require('./debate-manager.cjs');

// --- Load API key from .env (same pattern as embeddings.cjs) ---
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
const SAFETY_CAP_ROUNDS = 20;
const DEBATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const AGENT_DELAY_MS = 200;
const MAX_RETRY_ATTEMPTS = 2;

// --- OpenAI API call via native fetch ---

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
      temperature: 0.9
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

// --- Prompt builder ---

function buildAgentPrompt(agent, debate, recentMessages, phase) {
  const phaseName = phase ? phase.name : 'DEBATE ABIERTO';
  const phaseInstruction = phase ? phase.instruction : 'Participa activamente en el debate. Defiende tu posicion con argumentos solidos.';

  return `You are ${agent.name}, role: ${agent.role}.

YOUR ROLE DESCRIPTION: ${agent.desc || agent.role}

DEBATE TOPIC: ${debate.topic}
CURRENT PHASE: ${phaseName}
PHASE INSTRUCTION: ${phaseInstruction}
ROUND: ${debate.currentRound}

RULES:
- You MUST argue from your role's perspective
- You MUST object to at least one other participant by NAME
- You MUST provide concrete evidence and reasoning
- Your response MUST be at least 150 words — be detailed and thorough
- NEVER agree easily — push back, question, challenge
- Use specific examples, data points, or scenarios to support your arguments
- Address at least one point made by another participant directly
- Propose at least one concrete action or recommendation

RECENT MESSAGES:
${recentMessages.length > 0 ? recentMessages.map(m => `[${m.from} (${m.role})]: ${m.text}`).join('\n\n') : '(No messages yet — you are opening the debate. State your position clearly and strongly.)'}

NOW RESPOND AS ${agent.name} (${agent.role}). Be specific, detailed, and confrontational. Remember: minimum 150 words, argue from YOUR unique perspective.`;
}

function buildRetryPrompt(agent, debate, recentMessages, phase, previousResponse, rejectReason) {
  const basePrompt = buildAgentPrompt(agent, debate, recentMessages, phase);
  return `${basePrompt}

IMPORTANT: Your previous response was REJECTED for the following reason:
"${rejectReason}"

Your previous response was:
"${previousResponse.slice(0, 300)}..."

You MUST write a LONGER and MORE DETAILED response this time. Expand your arguments, add more examples, reference other participants by name, and provide concrete evidence. AIM FOR AT LEAST 200 WORDS.`;
}

function buildSynthesisPrompt(debate) {
  const allMessages = debate.messages.map(m =>
    `[Round ${m.round}] ${m.participantName} (${m.participantRole}): ${m.text}`
  ).join('\n\n');

  return `You are a neutral debate moderator. Summarize the following debate comprehensively.

DEBATE TOPIC: ${debate.topic}
TOTAL ROUNDS: ${debate.currentRound}
PARTICIPANTS: ${debate.participants.map(p => `${p.name} (${p.role})`).join(', ')}

ALL MESSAGES:
${allMessages}

Provide a structured synthesis with:
1. KEY AGREEMENTS — Points where participants found common ground
2. KEY DISAGREEMENTS — Unresolved conflicts and opposing views
3. DECISIONS MADE — Any concrete conclusions or recommendations that emerged
4. OPEN QUESTIONS — Issues that remain unresolved and need further discussion
5. STRONGEST ARGUMENTS — The most compelling points made during the debate

Be concise but thorough. Write in the same language as the debate messages.`;
}

// --- Utility: sleep ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// --- Main debate runner ---

async function runDebate(config) {
  const {
    situacion = 'libre',
    tema,
    numAgents = 4,
    maxRounds = 10,
    model = 'gpt-4o-mini',
    onMessage = null,
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

  log('system', { message: `Starting debate: "${tema}" with ${numAgents} agents, situacion: ${situacion}` });

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
        await processRoundTurns(newPending, debate, debateId, agents, model, log, startTime);
      } else {
        // Process pending turns
        await processRoundTurns(pending, debate, debateId, agents, model, log, startTime);
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

  // 3. Generate synthesis
  log('system', { message: 'Generating synthesis...' });
  let synthesis = '';
  try {
    const synthesisData = getDebateData(debateId);

    if (synthesisData && synthesisData.messages.length > 0) {
      synthesis = await callLLM(buildSynthesisPrompt(synthesisData), model);
      log('synthesis', { synthesis });
    } else {
      synthesis = 'No messages were generated during this debate.';
    }
  } catch (err) {
    log('error', { message: `Synthesis generation failed: ${err.message}` });
    synthesis = 'Synthesis generation failed due to an API error.';
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

async function processRoundTurns(pending, debate, debateId, agents, model, log, startTime) {
  if (!pending.turns || pending.turns.length === 0) return;

  // Phase info is at the top level of the pending response
  const phase = pending.phase ? {
    name: pending.phase,
    instruction: pending.phaseInstruction || '',
  } : null;

  // Recent messages are shared at the top level
  const recentMessages = pending.recentMessages || [];

  for (const turn of pending.turns) {
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

    // Generate response via LLM
    let response = null;
    try {
      const prompt = buildAgentPrompt(agent, debate, recentMessages, phase);
      response = await callLLM(prompt, model);
    } catch (err) {
      log('error', { message: `LLM call failed for ${agent.name}: ${err.message}` });
      continue; // Skip this agent's turn
    }

    if (!response) continue;

    // Try to submit the response
    let sayResult = dm.say(debateId, agent.name, response);

    // Retry if rejected (word count too low)
    if (sayResult.rejected) {
      log('retry', { agent: agent.name, reason: sayResult.error });

      for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        try {
          const retryPrompt = buildRetryPrompt(
            agent, debate, recentMessages, phase,
            response, sayResult.error
          );
          response = await callLLM(retryPrompt, model);
          sayResult = dm.say(debateId, agent.name, response);

          if (!sayResult.rejected) break;
          log('retry', { agent: agent.name, attempt: attempt + 1, reason: sayResult.error });
        } catch (err) {
          log('error', { message: `Retry LLM call failed for ${agent.name}: ${err.message}` });
          break;
        }
      }
    }

    if (sayResult.error && !sayResult.rejected) {
      log('error', { message: `say() failed for ${agent.name}: ${sayResult.error}` });
    } else if (!sayResult.error) {
      log('agent_message', {
        agent: agent.name,
        role: agent.role,
        round: debate.currentRound,
        wordCount: response.trim().split(/\s+/).length,
        preview: response.slice(0, 200),
      });
    }

    // Small delay between agents to avoid rate limits
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
