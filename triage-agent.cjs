/**
 * Triage Agent — Evaluates task complexity and decides workflow
 *
 * Classifies tasks as simple/medium/complex and either handles them
 * directly or triggers a multi-agent debate via orchestrator-engine.
 *
 * Usage:
 *   const { evaluateTask, runTriagedTask } = require('./triage-agent.cjs');
 *   const decision = await evaluateTask('Change button color to teal');
 *   const result = await runTriagedTask('Refactor auth system', { onMessage: console.log });
 */

const fs = require('fs');
const path = require('path');
const orchestrator = require('./orchestrator-engine.cjs');

// --- Load API key from .env (same pattern as orchestrator-engine.cjs) ---
let OPENAI_API_KEY = '';
try {
  const envPath = path.join(__dirname, '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^OPENAI_API_KEY=(.+)$/m);
  if (match) {
    OPENAI_API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
  }
} catch (err) {
  console.error('[triage-agent] Failed to read .env file:', err.message);
}

// --- Team Agents ---

const TEAM_AGENTS = [
  { id: 'arquitecto', name: 'Arquitecto', specialty: 'Estructura, patterns, decisiones tecnicas, diseno de sistemas', triggers: ['arquitectura', 'refactor', 'diseno', 'sistema', 'scalab', 'patron', 'migration'] },
  { id: 'frontend', name: 'Frontend Dev', specialty: 'React, TypeScript, UI/UX, componentes, Tailwind, animaciones', triggers: ['componente', 'ui', 'ux', 'react', 'css', 'tailwind', 'dashboard', 'vista', 'layout', 'responsive'] },
  { id: 'backend', name: 'Backend Dev', specialty: 'Supabase, Edge Functions, API, base de datos, auth, server-side', triggers: ['api', 'database', 'supabase', 'endpoint', 'query', 'servidor', 'edge function', 'auth'] },
  { id: 'qa', name: 'QA Engineer', specialty: 'Tests, edge cases, validacion, cobertura, regression', triggers: ['test', 'bug', 'error', 'validacion', 'edge case', 'regression', 'coverage'] },
  { id: 'seguridad', name: 'Security Analyst', specialty: 'Auth, XSS, injection, OWASP, permisos, tokens, rate limiting', triggers: ['seguridad', 'security', 'auth', 'token', 'xss', 'injection', 'permiso', 'vulnerab'] },
  { id: 'triage', name: 'Triage Coordinator', specialty: 'Evalua complejidad, decide flujo, coordina equipo, optimiza recursos', triggers: [] },
];

// --- OpenAI API call (same pattern as orchestrator-engine.cjs) ---

async function callLLM(prompt, model = 'gpt-4o-mini') {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not found in .env file');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.3,
    }),
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

// --- Keyword-based pre-check ---

function keywordPreCheck(description) {
  const lower = description.toLowerCase();
  const matched = [];

  for (const agent of TEAM_AGENTS) {
    if (agent.triggers.length === 0) continue;
    for (const trigger of agent.triggers) {
      if (lower.includes(trigger)) {
        matched.push(agent.id);
        break;
      }
    }
  }

  return [...new Set(matched)];
}

// --- Keyword-based fallback classification ---

function fallbackClassification(description) {
  const matchedAgents = keywordPreCheck(description);
  const count = matchedAgents.length;

  if (count <= 1) {
    const agent = matchedAgents[0] || 'frontend';
    return {
      complexity: 'simple',
      reason: 'Keyword-based fallback: single agent match',
      relevant_agents: [agent],
      suggested_situacion: null,
      direct_action: description,
      debate_tema: null,
    };
  }

  if (count <= 3) {
    return {
      complexity: 'medium',
      reason: 'Keyword-based fallback: 2-3 agent matches',
      relevant_agents: matchedAgents,
      suggested_situacion: 'mejora_codigo',
      direct_action: null,
      debate_tema: description,
    };
  }

  return {
    complexity: 'complex',
    reason: 'Keyword-based fallback: 4+ agent matches',
    relevant_agents: matchedAgents,
    suggested_situacion: 'arquitectura',
    direct_action: null,
    debate_tema: description,
  };
}

// --- Build classification prompt ---

function buildClassificationPrompt(description) {
  return `You are a task triage coordinator for a software development team.
Evaluate the following task and classify its complexity.

TASK: "${description}"

TEAM MEMBERS:
- arquitecto: system design, patterns, technical decisions
- frontend: React, TypeScript, UI/UX, components, Tailwind
- backend: Supabase, Edge Functions, API, database, auth
- qa: tests, edge cases, validation, coverage
- seguridad: security, auth, XSS, injection, OWASP
- triage: coordination (you)

CLASSIFICATION RULES:
- SIMPLE: Single-file changes, cosmetic fixes, typos, simple feature additions, config changes. ONE agent can handle it.
- MEDIUM: Changes touching 2-3 files, need brief review from 2-3 agents. Examples: adding a new component with API call, updating auth flow.
- COMPLEX: Architectural decisions, new systems, security-sensitive changes, cross-cutting concerns, refactors affecting 4+ files. Needs FULL team debate.

Respond in EXACTLY this JSON format (no markdown, no explanation):
{"complexity":"simple|medium|complex","reason":"brief explanation","relevant_agents":["agent_ids"],"suggested_situacion":"arquitectura|mejora_codigo|identificar_problemas|ejecucion|libre|null","direct_action":"what to do if simple, null otherwise","debate_tema":"topic for debate if medium/complex, null otherwise"}`;
}

// --- Parse LLM JSON response safely ---

function parseLLMResponse(text) {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  const parsed = JSON.parse(cleaned);

  // Validate required fields
  const validComplexities = ['simple', 'medium', 'complex'];
  if (!validComplexities.includes(parsed.complexity)) {
    throw new Error(`Invalid complexity: ${parsed.complexity}`);
  }

  if (!Array.isArray(parsed.relevant_agents) || parsed.relevant_agents.length === 0) {
    throw new Error('relevant_agents must be a non-empty array');
  }

  // Validate agent ids
  const validIds = TEAM_AGENTS.map(a => a.id);
  parsed.relevant_agents = parsed.relevant_agents.filter(id => validIds.includes(id));
  if (parsed.relevant_agents.length === 0) {
    parsed.relevant_agents = ['frontend'];
  }

  return parsed;
}

// --- Core: evaluateTask ---

async function evaluateTask(description) {
  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('Task description is required');
  }

  const preCheck = keywordPreCheck(description);
  let classification;

  try {
    const prompt = buildClassificationPrompt(description);
    const raw = await callLLM(prompt);
    classification = parseLLMResponse(raw);
  } catch (err) {
    console.warn('[triage-agent] LLM classification failed, using keyword fallback:', err.message);
    classification = fallbackClassification(description);
  }

  // Build decision based on complexity
  if (classification.complexity === 'simple') {
    return {
      action: 'direct',
      agent: classification.relevant_agents[0],
      task: description,
      instructions: classification.direct_action || description,
      complexity: 'simple',
      reason: classification.reason,
      preCheckAgents: preCheck,
    };
  }

  if (classification.complexity === 'medium') {
    const agents = classification.relevant_agents.slice(0, 3);
    return {
      action: 'consult',
      agents,
      task: description,
      instructions: classification.debate_tema || description,
      situacion: classification.suggested_situacion || 'mejora_codigo',
      complexity: 'medium',
      reason: classification.reason,
      preCheckAgents: preCheck,
    };
  }

  // complex
  const agents = classification.relevant_agents.length >= 4
    ? classification.relevant_agents
    : [...new Set([...classification.relevant_agents, ...preCheck])].slice(0, 6);

  // Ensure at least 4 agents for complex tasks
  if (agents.length < 4) {
    const allIds = TEAM_AGENTS.map(a => a.id).filter(id => !agents.includes(id));
    while (agents.length < 4 && allIds.length > 0) {
      agents.push(allIds.shift());
    }
  }

  return {
    action: 'debate',
    situacion: classification.suggested_situacion || 'arquitectura',
    tema: classification.debate_tema || description,
    num_agents: agents.length,
    agents,
    complexity: 'complex',
    reason: classification.reason,
    preCheckAgents: preCheck,
  };
}

// --- Core: runTriagedTask ---

async function runTriagedTask(description, options = {}) {
  const { onMessage = null, model = 'gpt-4o-mini' } = options;

  const decision = await evaluateTask(description);

  if (onMessage) {
    onMessage({ type: 'triage_decision', decision });
  }

  // Simple: return instructions directly
  if (decision.action === 'direct') {
    const result = {
      type: 'direct',
      agent: decision.agent,
      instructions: decision.instructions,
    };
    return { decision, result };
  }

  // Medium: brief debate with 2-3 agents, max 3 rounds
  if (decision.action === 'consult') {
    const debateResult = await orchestrator.runDebate({
      situacion: decision.situacion,
      tema: decision.instructions,
      numAgents: decision.agents.length,
      maxRounds: 3,
      model,
      onMessage,
    });
    return { decision, result: debateResult };
  }

  // Complex: full debate with 4-6 agents, 10 rounds
  const debateResult = await orchestrator.runDebate({
    situacion: decision.situacion,
    tema: decision.tema,
    numAgents: decision.num_agents,
    maxRounds: 10,
    model,
    onMessage,
  });
  return { decision, result: debateResult };
}

// --- getTeamStatus ---

function getTeamStatus() {
  return TEAM_AGENTS.map(agent => ({
    id: agent.id,
    name: agent.name,
    specialty: agent.specialty,
    triggerCount: agent.triggers.length,
    triggers: agent.triggers,
  }));
}

// --- Exports ---

module.exports = { evaluateTask, runTriagedTask, TEAM_AGENTS, getTeamStatus };
