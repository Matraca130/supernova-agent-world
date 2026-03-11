#!/usr/bin/env node

/**
 * Multi-Agent Chat Orchestrator v4 — Parallel + Teach-Leader Curator
 *
 * Arquitectura:
 *   RONDA N:  5 agentes en paralelo (todos piensan al mismo tiempo)
 *   CURACIÓN: teach-leader lee todo, filtra, prioriza, genera brief
 *   (se repite N rondas)
 *   SÍNTESIS: teach-leader genera síntesis final + action items
 *
 * 3x más rápido que v3: elimina esperas secuenciales dentro de salas.
 *
 * Uso:
 *   node orchestrator-v4.cjs "tema"
 *   node orchestrator-v4.cjs --quality high --rounds 3 "tema"
 *   node orchestrator-v4.cjs --context "archivo.md" --quality experimental "tema"
 */

const fs = require('fs');
const path = require('path');

// ── Modules ─────────────────────────────────────────────────────────────
const { invokeAgent, invokeParallel } = require('./agent-invoker.cjs');
const { parseCheckpoint, CHECKPOINT_INSTRUCTIONS } = require('./prompt-builder.cjs');
const vectorStore = require('./memoria/vector-store.cjs');
const { formatActionItems, formatReport, archiveSession } = require('./output-formatter.cjs');
const { scoreResponse } = require('./quality-gate.cjs');
const { updateCompetence, loadCompetences, saveCompetences, rankAgents } = require('./sm2-lite.cjs');
const { matchCommitsToActions } = require('./git-tracker.cjs');
const PRESETS_DATA = require('./presets.json');

// ── Config ──────────────────────────────────────────────────────────────
const CHAT_DIR = __dirname;
const SESSIONS_DIR = path.join(CHAT_DIR, 'sessions');
const DEBATE_LOG = path.join(CHAT_DIR, 'debate-paralelo.md');
const CHAT_FINAL = path.join(CHAT_DIR, 'sintesis-final.md');
const AGENT_PROMPTS_FILE = path.join(CHAT_DIR, 'prompts-de-accion.md');
const METRICS_FILE = path.join(CHAT_DIR, 'metrics.jsonl');
const MEMORY_DIR = path.join(CHAT_DIR, 'memoria');
const MEMORY_FILE = path.join(MEMORY_DIR, 'historial.json');

const CURATOR = 'teach-leader';
const THINKERS = ['arquitecto', 'experto-quiz', 'experto-flashcards', 'experto-resumen', 'experto-organizador'];
const DEFAULT_ROUNDS = 3;
const DEFAULT_QUALITY = 'high';

const QUALITY_PRESETS = {
  normal: { model: 'sonnet', maxWords: 300, effort: 'medium', timeout: 120_000 },
  high:   { model: 'opus',   maxWords: 500, effort: 'high',   timeout: 300_000 },
  max:    { model: 'opus',   maxWords: 800, effort: 'max',    timeout: 600_000 },
  stable:       { model: PRESETS_DATA.stable?.model || 'sonnet', maxWords: 300, effort: PRESETS_DATA.stable?.effort || 'high', timeout: PRESETS_DATA.stable?.timeout || 120_000 },
  experimental: { model: PRESETS_DATA.experimental?.model || 'opus', maxWords: 800, effort: PRESETS_DATA.experimental?.effort || 'high', timeout: PRESETS_DATA.experimental?.timeout || 300_000 },
  quick:        { model: PRESETS_DATA.quick?.model || 'sonnet', maxWords: 200, effort: PRESETS_DATA.quick?.effort || 'medium', timeout: PRESETS_DATA.quick?.timeout || 90_000 },
};

// ── Colors ──────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const AGENT_COLORS = {
  'arquitecto': C.cyan,
  'experto-quiz': C.blue,
  'experto-flashcards': C.green,
  'experto-resumen': C.magenta,
  'experto-organizador': C.yellow,
  'teach-leader': C.red,
};

// ── Parse args ──────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let rounds = DEFAULT_ROUNDS, quality = DEFAULT_QUALITY;
  let contextFile = '', topic = '';
  let agents = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agents' && args[i + 1]) agents = args[++i].split(',').map(a => a.trim());
    else if (args[i] === '--rounds' && args[i + 1]) rounds = parseInt(args[++i], 10);
    else if (args[i] === '--quality' && args[i + 1]) quality = args[++i];
    else if (args[i] === '--context' && args[i + 1]) contextFile = args[++i];
    else topic += (topic ? ' ' : '') + args[i];
  }

  if (!topic) {
    console.error('\n  Uso: node orchestrator-v4.cjs [opciones] "tema"\n');
    console.error('  Opciones:');
    console.error('    --agents "a,b,c,d,e"  Agentes pensadores (default: los 5)');
    console.error('    --rounds N            Rondas (default: 3)');
    console.error('    --quality NIVEL       quick|stable|normal|high|experimental|max');
    console.error('    --context "file.md"   Archivo de contexto');
    process.exit(1);
  }

  let contextContent = '';
  if (contextFile) {
    const ctxPath = path.resolve(contextFile);
    if (fs.existsSync(ctxPath)) contextContent = fs.readFileSync(ctxPath, 'utf-8');
    else { console.error(`  Error: contexto no encontrado: ${ctxPath}`); process.exit(1); }
  }

  return { agents: agents || THINKERS, rounds, topic, quality, contextContent };
}

// ── Helpers ─────────────────────────────────────────────────────────────
function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`;
}

function appendMetric(data) {
  fs.appendFileSync(METRICS_FILE, JSON.stringify(data) + '\n', 'utf-8');
}

async function getSemanticMemory(query, topK = 5) {
  try { return await vectorStore.getRelevantContext(query, topK); }
  catch { return ''; }
}

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
  } catch {}
  return [];
}

function saveSession(topic, ideas, decisions, date) {
  const sessions = loadMemory();
  sessions.push({ id: sessions.length + 1, date, topic, ideas, decisions });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
}

function appendToLog(text) {
  fs.appendFileSync(DEBATE_LOG, text + '\n', 'utf-8');
}

// ── Prompt builders (v4 specific) ───────────────────────────────────────

function buildThinkPrompt({ agent, topic, round, maxWords, contextContent, memory, curatorBrief }) {
  let prompt = `Eres ${agent} en una discusion paralela sobre el proyecto Axon (plataforma educativa medica, React+TypeScript+Vite+Supabase).

TEMA: "${topic}"
RONDA: ${round}
`;

  if (contextContent && round <= 2) {
    prompt += `\nDOCUMENTACION DEL SISTEMA:\n${contextContent}\n`;
  }

  if (memory && round <= 2) {
    prompt += `\nMEMORIA DE SESIONES ANTERIORES:\n${memory}\nNO repitas ideas anteriores. Construye SOBRE ellas.\n`;
  }

  if (curatorBrief) {
    prompt += `\n═══ BRIEF DEL TEACH-LEADER (resumen de la ronda anterior) ═══
${curatorBrief}
═══ FIN DEL BRIEF ═══

IMPORTANTE: Lee el brief con atencion. El teach-leader ya filtro y priorizo.
- Amplifica las ideas marcadas como prioritarias
- Resuelve las preguntas abiertas si puedes
- NO repitas lo que ya se dijo — AVANZA
- Si no estas de acuerdo con algo, argumenta POR QUE
`;
  } else {
    prompt += `\nEsta es la primera ronda. Otros 4 agentes estan pensando EN PARALELO sobre el mismo tema.

TU TAREA:
- Da tu perspectiva UNICA basada en tu expertise
- Se CONCRETO: menciona archivos, componentes, hooks, servicios reales de Axon
- Propone ideas AUDACES que nadie esperaria
- Si propones IA: que modelo, que endpoint, que datos
- Piensa en UX/UI especificos, flujos de usuario
`;
  }

  prompt += `\nMaximo ${maxWords} palabras.${CHECKPOINT_INSTRUCTIONS}`;
  return prompt;
}

function buildCurationPrompt({ topic, round, totalRounds, responses, prevBrief }) {
  let prompt = `Eres el TEACH-LEADER del proyecto Axon. Tu rol es CURAR y ARBITRAR, no debatir.

TEMA: "${topic}"
RONDA: ${round}/${totalRounds}

5 agentes acaban de pensar EN PARALELO. Aqui estan sus respuestas:

`;

  for (const r of responses) {
    prompt += `═══ ${r.agent.toUpperCase()} ═══\n${r.response}\n\n`;
  }

  if (prevBrief) {
    prompt += `\nTU BRIEF ANTERIOR:\n${prevBrief}\n`;
  }

  prompt += `
TU TAREA como curador:

1. **ELIMINA DUPLICADOS**: Si 3 agentes dijeron lo mismo, resume en 1 linea
2. **MARCA CONTRADICCIONES**: Si 2 agentes se contradicen, nombra a ambos y la contradiccion
3. **PRIORIZA**: Ordena las ideas por impacto/viabilidad (P0, P1, P2)
4. **PREGUNTAS ABIERTAS**: Lista preguntas que los agentes deben resolver en la siguiente ronda
5. **BRIEF COMPACTO**: Genera un resumen de MAX 400 palabras que los agentes recibiran

FORMATO DE SALIDA:

## IDEAS PRIORITARIAS
- [P0] idea (propuesta por: agente)
- [P1] idea (propuesta por: agente)
...

## CONTRADICCIONES
- agente-X dice A, agente-Y dice B → resolver

## PREGUNTAS PARA LA SIGUIENTE RONDA
- pregunta concreta 1
- pregunta concreta 2

## BRIEF PARA AGENTES
(Max 400 palabras, lo que los agentes recibiran como contexto)

${round === totalRounds ? '## VEREDICTO FINAL\nEsta es la ULTIMA ronda. Da tu veredicto: las TOP 5 ideas finales, ordenadas.\n' : ''}
${CHECKPOINT_INSTRUCTIONS}`;

  return prompt;
}

function buildFinalSynthesisPrompt({ topic, allBriefs, allResponses, checkpoints }) {
  let checkpointSummary = '';
  const structured = checkpoints.filter(c => c.structured);
  if (structured.length > 0) {
    checkpointSummary = '\nCHECKPOINTS ESTRUCTURADOS:\n';
    for (const cp of structured) {
      checkpointSummary += `[${cp.agentName} R${cp.round}]`;
      if (cp.consenso.length) checkpointSummary += ` Consenso: ${cp.consenso.join('; ')}`;
      if (cp.accionable.length) checkpointSummary += ` Accionable: ${cp.accionable.join('; ')}`;
      checkpointSummary += '\n';
    }
  }

  return `Eres el TEACH-LEADER generando la SINTESIS FINAL del debate paralelo sobre Axon.

TEMA: "${topic}"

BRIEFS DE CADA RONDA:
${allBriefs.map((b, i) => `\n── RONDA ${i + 1} ──\n${b}`).join('\n')}
${checkpointSummary}

Genera una SINTESIS EJECUTIVA:

## 1. LAS 5 MEJORES IDEAS (priorizadas)
Para cada una: idea, quien la propuso, impacto, esfuerzo (S/M/L), prioridad (P0/P1/P2)

## 2. CONEXIONES ENTRE AGENTES
Ideas que se complementan o potencian entre distintos agentes

## 3. ROADMAP
Fase 1 (1-2 semanas), Fase 2 (1 mes), Fase 3 (2-3 meses)

## 4. ARQUITECTURA PROPUESTA
Diagrama textual de como se integran los cambios

## 5. RIESGOS Y DECISIONES PENDIENTES

## 6. SIGUIENTE PASO INMEDIATO

Se concreto y accionable.`;
}

function buildActionPromptsPrompt(synthesis) {
  return `Basandote en la sintesis final, genera un PROMPT COMPLETO para cada agente.

SINTESIS:
${synthesis}

Genera un prompt para CADA agente. Cada prompt debe ser autocontenido:

## ARQUITECTO
## EXPERTO-QUIZ
## EXPERTO-FLASHCARDS
## EXPERTO-RESUMEN
## EXPERTO-ORGANIZADOR
## TEACH-LEADER

REGLAS:
- Archivos EXACTOS del proyecto (paths reales)
- Tipos TypeScript si necesarios
- Endpoints con request/response
- Orden de implementacion
- Criterios de "done"
- Max 500 palabras por agente
- Empieza con: "Tu tarea es..."

Responde SOLO con texto markdown.`;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const { agents: thinkers, rounds, topic, quality, contextContent } = parseArgs();
  const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
  const presetConfig = PRESETS_DATA[quality] || {};

  global.__sessionId = `v4-${Date.now()}`;
  const allCheckpoints = [];
  const allBriefs = [];
  const allResponses = [];

  // Load competences
  const competences = loadCompetences();
  const useCompetenceTracking = presetConfig.competenceTracking !== false;

  if (useCompetenceTracking) {
    const ranked = rankAgents(competences, topic);
    thinkers.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
  }

  // Ensure dirs
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  // Header
  console.log(`\n${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.bold}  MULTI-AGENT CHAT v4 — PARALLEL + CURATOR${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.dim}  Tema:      ${topic}${C.reset}`);
  console.log(`${C.dim}  Pensadores: ${thinkers.join(', ')}${C.reset}`);
  console.log(`${C.red}${C.bold}  Curador:    ${CURATOR}${C.reset}`);
  console.log(`${C.dim}  Rondas:     ${rounds} | Modelo: ${preset.model} | Esfuerzo: ${preset.effort}${C.reset}`);
  console.log(`${C.dim}  Modo:       ALL PARALLEL (5 agentes simultáneos por ronda)${C.reset}`);
  if (contextContent) console.log(`${C.dim}  Contexto:   inyectado${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}`);

  // Init debate log
  fs.writeFileSync(DEBATE_LOG, `# Debate Paralelo v4\n> ${new Date().toLocaleString()}\n> Tema: ${topic}\n> Agentes: ${thinkers.join(', ')}\n> Curador: ${CURATOR}\n\n---\n\n`, 'utf-8');

  const globalStart = Date.now();
  const roundTimes = [];
  let curatorBrief = '';
  const memory = await getSemanticMemory(topic);

  // ── ROUNDS ──────────────────────────────────────────────────────────
  for (let round = 1; round <= rounds; round++) {
    const roundStart = Date.now();

    console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
    console.log(`${C.bold}  RONDA ${round}/${rounds}  ⚡ 5 agentes en paralelo${C.reset}`);
    console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

    appendToLog(`## Ronda ${round}\n`);

    // ── PHASE A: All thinkers in parallel ─────────────────────────────
    const tasks = thinkers.map(agent => ({
      agent,
      prompt: buildThinkPrompt({
        agent,
        topic,
        round,
        maxWords: preset.maxWords,
        contextContent,
        memory: round <= 2 ? memory : '',
        curatorBrief: round > 1 ? curatorBrief : '',
      }),
    }));

    // Show "thinking" status
    for (const agent of thinkers) {
      const color = AGENT_COLORS[agent] || C.white;
      console.log(`${color}  ⚡ [${agent}]${C.reset} ${C.dim}pensando...${C.reset}`);
    }
    console.log('');

    const parallelStart = Date.now();
    const results = await invokeParallel(tasks, {
      model: preset.model,
      effort: preset.effort,
      timeout: preset.timeout,
    });
    const parallelTime = Date.now() - parallelStart;

    console.log(`${C.dim}  ── 5 respuestas en ${elapsed(parallelTime)} (paralelo) ──${C.reset}\n`);

    // Process results
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const color = AGENT_COLORS[r.agent] || C.white;
      const cp = parseCheckpoint(r.response, r.agent, round);
      allCheckpoints.push(cp);
      allResponses.push(r);

      // Log to file
      const ts = new Date().toLocaleTimeString();
      appendToLog(`### [${ts}] ${r.agent} (${elapsed(r.elapsed)}):\n${r.response}\n\n---\n\n`);

      // Quality gate (observational)
      let qualityScore = null;
      try { qualityScore = await scoreResponse(r.response, topic, r.agent, round, i); } catch {}

      // Metric
      appendMetric({
        type: 'turn', sessionId: global.__sessionId,
        agent: r.agent, round, speakingOrder: i,
        elapsed: r.elapsed, attempts: r.attempts,
        structured: cp.structured,
        consensoCount: cp.consenso.length,
        accionableCount: cp.accionable.length,
        qualityScore,
        parallel: true,
      });

      // Display
      console.log(`${color}${C.bold}  [${r.agent}]${C.reset} ${C.dim}(${elapsed(r.elapsed)})${cp.structured ? ` ${C.green}✓cp${C.reset}` : ''}${C.reset}`);
      const lines = r.response.split('\n');
      const preview = lines.slice(0, 6);
      preview.forEach(l => console.log(`${color}  │${C.reset} ${l}`));
      if (lines.length > 6) console.log(`${color}  │${C.reset} ${C.dim}... (${lines.length - 6} lineas más)${C.reset}`);
      console.log('');
    }

    // ── PHASE B: Teach-leader curates ─────────────────────────────────
    console.log(`${C.red}${C.bold}  ┌─ CURACIÓN: teach-leader ─────────────────────┐${C.reset}`);
    console.log(`${C.red}  │${C.reset} ${C.dim}Leyendo 5 respuestas, filtrando, priorizando...${C.reset}`);

    const curationStart = Date.now();
    const curationPrompt = buildCurationPrompt({
      topic,
      round,
      totalRounds: rounds,
      responses: results,
      prevBrief: curatorBrief || '',
    });

    const curationResult = await invokeAgent(CURATOR, curationPrompt, {
      model: preset.model,
      effort: preset.effort,
      timeout: preset.timeout,
    });

    const curationTime = Date.now() - curationStart;
    curatorBrief = curationResult.response;
    allBriefs.push(curatorBrief);

    const curatorCp = parseCheckpoint(curationResult.response, CURATOR, round);
    allCheckpoints.push(curatorCp);

    appendToLog(`### [CURACIÓN] teach-leader (${elapsed(curationTime)}):\n${curatorBrief}\n\n---\n\n`);

    appendMetric({
      type: 'curation', sessionId: global.__sessionId,
      agent: CURATOR, round, elapsed: curationTime,
      structured: curatorCp.structured,
    });

    // Display brief
    console.log(`${C.red}  │${C.reset} ${C.dim}(${elapsed(curationTime)})${curatorCp.structured ? ` ${C.green}✓cp${C.reset}` : ''}${C.reset}`);
    curatorBrief.split('\n').slice(0, 15).forEach(l => {
      console.log(`${C.red}  │${C.reset} ${l}`);
    });
    console.log(`${C.red}  └────────────────────────────────────────────────┘${C.reset}`);

    roundTimes.push(Date.now() - roundStart);
  }

  // ── SYNTHESIS ─────────────────────────────────────────────────────────
  console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
  console.log(`${C.green}${C.bold}  TEACH-LEADER: GENERANDO SÍNTESIS FINAL...${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

  const synthPrompt = buildFinalSynthesisPrompt({ topic, allBriefs, allResponses, checkpoints: allCheckpoints });
  const synthResult = await invokeAgent(CURATOR, synthPrompt, { ...preset, timeout: 600_000 });
  const synthesis = synthResult.response;

  fs.writeFileSync(CHAT_FINAL, `# Sintesis Final — v4\n> ${new Date().toLocaleString()}\n> Tema: ${topic}\n\n---\n\n${synthesis}\n`, 'utf-8');

  console.log(`${C.green}${C.bold}  SÍNTESIS:${C.reset}`);
  synthesis.split('\n').forEach(l => console.log(`${C.green}  │ ${C.reset}${l}`));

  // ── Checkpoints summary ─────────────────────────────────────────────
  const structured = allCheckpoints.filter(c => c.structured);
  console.log(`\n${C.cyan}  Checkpoints: ${structured.length}/${allCheckpoints.length} estructurados${C.reset}`);

  if (structured.length > 0) {
    const allAccionable = structured.flatMap(c => c.accionable);
    if (allAccionable.length > 0) {
      console.log(`${C.cyan}  Acciones propuestas (${allAccionable.length}):${C.reset}`);
      allAccionable.slice(0, 10).forEach((a, i) => {
        console.log(`${C.cyan}    ${i+1}. ${C.reset}${a}`);
      });
    }
  }

  // ── Save to memory ──────────────────────────────────────────────────
  console.log(`\n${C.yellow}${C.bold}  Guardando en memoria...${C.reset}`);

  const extractPrompt = `Extrae EXACTAMENTE en formato JSON (sin markdown, sin backticks):\n{"ideas":["idea 1","idea 2","idea 3","idea 4","idea 5"],"decisions":["decision 1","decision 2","decision 3"]}\n\nMaximo 5 ideas y 3 decisiones en frases cortas.\n\n${synthesis}`;
  const extractResult = await invokeAgent(CURATOR, extractPrompt, { ...preset, timeout: 120_000 });

  let ideas = [], decisions = [];
  try {
    const m = extractResult.response.match(/\{[\s\S]*\}/);
    if (m) { const p = JSON.parse(m[0]); ideas = p.ideas || []; decisions = p.decisions || []; }
  } catch { ideas = [synthesis.slice(0, 200)]; }

  const sessionDate = new Date().toLocaleDateString();
  const sessionNum = loadMemory().length + 1;
  saveSession(topic, ideas, decisions, sessionDate);

  const meta = { session: sessionNum, date: sessionDate, topic };
  let vecCount = 0;
  for (const idea of ideas) {
    try { await vectorStore.addMemory(idea, 'ideas', meta); vecCount++; } catch {}
  }
  for (const dec of decisions) {
    try { await vectorStore.addMemory(dec, 'decisiones', meta); vecCount++; } catch {}
  }
  try { await vectorStore.addMemory(synthesis.slice(0, 1000), 'conclusiones', meta); vecCount++; } catch {}

  console.log(`${C.yellow}  Sesion #${sessionNum}: ${vecCount} memorias embedidas${C.reset}`);

  // ── Action prompts ──────────────────────────────────────────────────
  console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  GENERANDO PROMPTS DE ACCIÓN...${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

  const apPrompt = buildActionPromptsPrompt(synthesis);
  const apResult = await invokeAgent(CURATOR, apPrompt, { ...preset, timeout: 600_000 });

  fs.writeFileSync(AGENT_PROMPTS_FILE, `# Prompts de Accion — v4\n> ${new Date().toLocaleString()}\n> Tema: ${topic}\n\n---\n\n${apResult.response}\n`, 'utf-8');

  console.log(`${C.cyan}${C.bold}  PROMPTS DE ACCIÓN:${C.reset}`);
  apResult.response.split('\n').forEach(l => console.log(`${C.cyan}  │ ${C.reset}${l}`));

  // ── Git tracking ──────────────────────────────────────────────────
  console.log(`\n${C.dim}  Verificando commits para cerrar action items...${C.reset}`);
  try {
    const gitResult = matchCommitsToActions();
    if (gitResult.closed.length > 0) {
      console.log(`${C.green}  ✓ Cerrados por commits: ${gitResult.closed.join(', ')}${C.reset}`);
    }
  } catch {}

  // ── Action items ──────────────────────────────────────────────────
  console.log(`\n${C.yellow}${C.bold}  Procesando action items...${C.reset}`);
  const actionItems = formatActionItems(allCheckpoints, global.__sessionId);
  const newItems = actionItems.filter(i => i.createdSession === global.__sessionId);
  console.log(`${C.yellow}  ${newItems.length} nuevos, ${actionItems.length} total${C.reset}`);

  // ── Competences ───────────────────────────────────────────────────
  if (useCompetenceTracking) {
    for (const cp of allCheckpoints) {
      if (competences[cp.agentName]) {
        let q = 1;
        if (cp.structured && cp.accionable.length > 0) q = 5;
        else if (cp.structured) q = 3;
        competences[cp.agentName] = updateCompetence(competences[cp.agentName], q);
      }
    }
    saveCompetences(competences);
  }

  // ── Report & archive ──────────────────────────────────────────────
  const totalMs = Date.now() - globalStart;
  formatReport({
    actionItems, checkpoints: allCheckpoints, metrics: null,
    competences: useCompetenceTracking ? competences : null,
    sessionId: global.__sessionId, topic, duration: totalMs,
  });
  archiveSession(global.__sessionId);

  // ── Session metric ────────────────────────────────────────────────
  appendMetric({
    type: 'session', sessionId: global.__sessionId,
    version: 'v4', date: sessionDate, topic, quality, rounds,
    agents: [...thinkers, CURATOR],
    duration: totalMs, roundTimes,
    totalCheckpoints: allCheckpoints.length,
    structuredCheckpoints: structured.length,
    ideasSaved: ideas.length, decisionsSaved: decisions.length,
    actionItemsNew: newItems.length, actionItemsTotal: actionItems.length,
  });

  // ── Final ─────────────────────────────────────────────────────────
  const totalMins = Math.floor(totalMs / 60000);
  const remSecs = Math.floor((totalMs % 60000) / 1000);

  console.log(`\n${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.bold}  RESUMEN v4${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.dim}  Tiempo total: ${totalMins}m ${remSecs}s${C.reset}`);
  console.log(`${C.dim}  Checkpoints: ${structured.length}/${allCheckpoints.length} estructurados${C.reset}`);
  console.log(`${C.dim}  Memoria: sesion #${sessionNum} (${vecCount} vectores)${C.reset}`);
  console.log(`${C.dim}  Action items: ${newItems.length} nuevos, ${actionItems.length} total${C.reset}`);
  console.log(`${C.dim}  Archivos:${C.reset}`);
  console.log(`${C.blue}    ${DEBATE_LOG}${C.reset}`);
  console.log(`${C.green}    ${CHAT_FINAL}${C.reset}`);
  console.log(`${C.cyan}    ${AGENT_PROMPTS_FILE}${C.reset}`);
  console.log(`${C.yellow}    ${METRICS_FILE}${C.reset}`);
  console.log(`${C.dim}    sessions/session-report.md${C.reset}`);
  console.log(`${C.dim}    sessions/action-items.json${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}\n`);
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });
