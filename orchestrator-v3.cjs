#!/usr/bin/env node

/**
 * Multi-Agent Chat Orchestrator v3 — Modular Edition
 *
 * Usa módulos separados: SessionTypes, agent-invoker, prompt-builder.
 * Dos salas paralelas con cross-pollination, checkpoints estructurados,
 * memoria semántica, y generación de prompts de acción.
 *
 * Uso:
 *   node orchestrator-v3.cjs "tema"
 *   node orchestrator-v3.cjs --quality high --rounds 3 "tema"
 *   node orchestrator-v3.cjs --context "archivo.md" --quality max "tema"
 */

const fs = require('fs');
const path = require('path');

// ── Modules ─────────────────────────────────────────────────────────────
const { invokeAgent, invokeSequential } = require('./agent-invoker.cjs');
const { parseCheckpoint, buildFirstPrompt, buildDebatePrompt, buildSynthesisPrompt, buildActionPromptsPrompt } = require('./prompt-builder.cjs');
const vectorStore = require('./memoria/vector-store.cjs');
const { formatActionItems, formatReport, archiveSession } = require('./output-formatter.cjs');
const { scoreResponse } = require('./quality-gate.cjs');
const { updateCompetence, loadCompetences, saveCompetences, rankAgents } = require('./sm2-lite.cjs');
const { matchCommitsToActions } = require('./git-tracker.cjs');
const PRESETS_DATA = require('./presets.json');

// ── Config ──────────────────────────────────────────────────────────────
const CHAT_DIR = __dirname;
const CHAT_FILE_1 = path.join(CHAT_DIR, 'sala-estrategia.md');
const CHAT_FILE_2 = path.join(CHAT_DIR, 'sala-implementacion.md');
const CHAT_FINAL = path.join(CHAT_DIR, 'sintesis-final.md');
const MEMORY_DIR = path.join(CHAT_DIR, 'memoria');
const MEMORY_FILE = path.join(MEMORY_DIR, 'historial.json');
const MEMORY_SUMMARY = path.join(MEMORY_DIR, 'memoria-acumulada.md');
const AGENT_PROMPTS_FILE = path.join(CHAT_DIR, 'prompts-de-accion.md');
const METRICS_FILE = path.join(CHAT_DIR, 'metrics.jsonl');

const DEFAULT_SALA1 = ['arquitecto', 'teach-leader', 'experto-quiz'];
const DEFAULT_SALA2 = ['experto-resumen', 'experto-flashcards', 'experto-organizador'];
const DEFAULT_ROUNDS = 3;
const DEFAULT_QUALITY = 'high';

const QUALITY_PRESETS = {
  normal: { model: 'sonnet', maxWords: 300, effort: 'medium', timeout: 120_000 },
  high:   { model: 'opus',   maxWords: 500, effort: 'high',   timeout: 300_000 },
  max:    { model: 'opus',   maxWords: 800, effort: 'max',    timeout: 600_000 },
  // Map presets.json entries into runtime presets
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

const SALA_COLORS = {
  1: [C.cyan, C.blue, C.green],
  2: [C.magenta, C.yellow, C.red],
};
const SALA_BORDER = { 1: C.blue, 2: C.magenta };

// ── Parse args ──────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let sala1 = DEFAULT_SALA1, sala2 = DEFAULT_SALA2;
  let rounds = DEFAULT_ROUNDS, quality = DEFAULT_QUALITY;
  let contextFile = '', topic = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sala1' && args[i + 1]) sala1 = args[++i].split(',').map(a => a.trim());
    else if (args[i] === '--sala2' && args[i + 1]) sala2 = args[++i].split(',').map(a => a.trim());
    else if (args[i] === '--rounds' && args[i + 1]) rounds = parseInt(args[++i], 10);
    else if (args[i] === '--quality' && args[i + 1]) quality = args[++i];
    else if (args[i] === '--context' && args[i + 1]) contextFile = args[++i];
    else topic += (topic ? ' ' : '') + args[i];
  }

  if (!topic) {
    console.error('\n  Uso: node orchestrator-v3.cjs [opciones] "tema"\n');
    console.error('  Opciones:');
    console.error('    --sala1 "a,b,c"      Agentes Sala Estrategia');
    console.error('    --sala2 "d,e,f"      Agentes Sala Implementacion');
    console.error('    --rounds N           Rondas (default: 3)');
    console.error('    --quality NIVEL      normal | high | max (default: high)');
    console.error('    --context "file.md"  Archivo de contexto para inyectar');
    process.exit(1);
  }

  let contextContent = '';
  if (contextFile) {
    const ctxPath = path.resolve(contextFile);
    if (fs.existsSync(ctxPath)) contextContent = fs.readFileSync(ctxPath, 'utf-8');
    else { console.error(`  Error: contexto no encontrado: ${ctxPath}`); process.exit(1); }
  }

  return { sala1, sala2, rounds, topic, quality, contextContent };
}

// ── Chat helpers ────────────────────────────────────────────────────────
function initChat(filePath, salaName, topic, agents, quality) {
  const preset = QUALITY_PRESETS[quality];
  const ts = new Date().toLocaleString();
  fs.writeFileSync(filePath, `# ${salaName}\n> Sesion: ${ts}\n> Tema: ${topic}\n> Participantes: ${agents.join(', ')}\n> Calidad: ${quality} (${preset.model}, ${preset.effort})\n\n---\n\n## Tema\n${topic}\n\n---\n\n`, 'utf-8');
}

function appendMsg(filePath, agent, message) {
  const ts = new Date().toLocaleTimeString();
  fs.appendFileSync(filePath, `### [${ts}] ${agent}:\n${message}\n\n---\n\n`, 'utf-8');
}

function readChat(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

// ── Memory ──────────────────────────────────────────────────────────────
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

// ── Metrics ─────────────────────────────────────────────────────────────
function appendMetric(data) {
  fs.appendFileSync(METRICS_FILE, JSON.stringify(data) + '\n', 'utf-8');
}

// ── Display helpers ─────────────────────────────────────────────────────
function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`;
}

// ── Run a sala round ────────────────────────────────────────────────────
async function runSalaRound(salaNum, agents, topic, salaName, otherSalaName, chatFile, otherChatFile, round, totalRounds, preset, contextContent, allCheckpoints) {
  const colors = SALA_COLORS[salaNum];
  const border = SALA_BORDER[salaNum];
  const roundCheckpoints = [];

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const color = colors[i % colors.length];
    const startTime = Date.now();

    process.stdout.write(`${border}  │ ${color}${C.bold}[${agent}]${C.reset} ${C.dim}pensando...${C.reset}`);

    const ownHistory = readChat(chatFile);
    const otherHistory = round > 1 ? readChat(otherChatFile) : '';
    const memory = (round <= 2) ? await getSemanticMemory(topic) : '';

    let prompt;
    if (round === 1 && i === 0) {
      prompt = buildFirstPrompt({ agent, agents, topic, salaName, otherSalaName, maxWords: preset.maxWords, contextContent, memory });
    } else {
      prompt = buildDebatePrompt({ agent, agents, topic, salaName, ownHistory, otherHistory, otherSalaName, round, totalRounds, maxWords: preset.maxWords, contextContent: round <= 2 ? contextContent : '', memory });
    }

    const result = await invokeAgent(agent, prompt, {
      model: preset.model,
      effort: preset.effort,
      timeout: preset.timeout,
    });

    const cp = parseCheckpoint(result.response, agent, round);
    roundCheckpoints.push(cp);
    allCheckpoints.push(cp);

    appendMsg(chatFile, agent, result.response);

    // Quality gate (observational — never blocks)
    let qualityScore = null;
    try {
      qualityScore = await scoreResponse(result.response, topic, agent, round, i);
    } catch {}

    // Metrics
    appendMetric({
      type: 'turn',
      sessionId: global.__sessionId,
      agent,
      round,
      sala: salaNum,
      speakingOrder: i,
      elapsed: result.elapsed,
      attempts: result.attempts,
      structured: cp.structured,
      consensoCount: cp.consenso.length,
      accionableCount: cp.accionable.length,
      qualityScore,
    });

    // Display
    process.stdout.write(`\r${border}  │ ${color}${C.bold}[${agent}]${C.reset} ${C.dim}(${elapsed(result.elapsed)})${cp.structured ? ` ${C.green}✓checkpoint${C.reset}` : ''}${C.reset}\n`);
    result.response.split('\n').forEach(line => {
      console.log(`${border}  │ ${C.reset}  ${line}`);
    });
    console.log(`${border}  │${C.reset}`);
  }

  return roundCheckpoints;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const { sala1, sala2, rounds, topic, quality, contextContent } = parseArgs();
  const preset = QUALITY_PRESETS[quality];

  global.__sessionId = `mac-${Date.now()}`;
  const allCheckpoints = [];

  // Load competences and reorder agents by topic competence
  const competences = loadCompetences();
  const presetConfig = PRESETS_DATA[quality] || {};
  const useCompetenceTracking = presetConfig.competenceTracking !== false;

  if (useCompetenceTracking) {
    const ranked = rankAgents(competences, topic);
    // Reorder sala agents: put most competent first within each sala
    sala1.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
    sala2.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
  }

  // Header
  console.log(`\n${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.bold}  MULTI-AGENT CHAT v3 — MODULAR EDITION${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.dim}  Tema:     ${topic}${C.reset}`);
  console.log(`${C.blue}${C.bold}  Sala 1:${C.reset}${C.dim}   ${sala1.join(', ')} (Estrategia)${C.reset}`);
  console.log(`${C.magenta}${C.bold}  Sala 2:${C.reset}${C.dim}   ${sala2.join(', ')} (Implementacion)${C.reset}`);
  console.log(`${C.dim}  Rondas:   ${rounds} | Modelo: ${preset.model} | Esfuerzo: ${preset.effort}${C.reset}`);
  if (contextContent) console.log(`${C.dim}  Contexto: inyectado${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}`);

  // Init
  initChat(CHAT_FILE_1, 'Sala Estrategia', topic, sala1, quality);
  initChat(CHAT_FILE_2, 'Sala Implementacion', topic, sala2, quality);

  const globalStart = Date.now();
  const roundTimes = [];

  // Rounds
  for (let round = 1; round <= rounds; round++) {
    const roundStart = Date.now();

    console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
    console.log(`${C.bold}  RONDA ${round}/${rounds}${round > 1 ? '  (cross-pollination)' : ''}${C.reset}`);
    console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

    console.log(`${C.blue}${C.bold}  ┌─ SALA ESTRATEGIA ────────────┐${C.reset}   ${C.magenta}${C.bold}┌─ SALA IMPLEMENTACION ─────────┐${C.reset}`);
    console.log(`${C.blue}  │${C.reset} ${C.dim}${sala1.join(', ')}${C.reset}   ${C.magenta}  │${C.reset} ${C.dim}${sala2.join(', ')}${C.reset}\n`);

    // Run both salas in parallel
    await Promise.all([
      runSalaRound(1, sala1, topic, 'Sala Estrategia', 'Sala Implementacion', CHAT_FILE_1, CHAT_FILE_2, round, rounds, preset, contextContent, allCheckpoints),
      runSalaRound(2, sala2, topic, 'Sala Implementacion', 'Sala Estrategia', CHAT_FILE_2, CHAT_FILE_1, round, rounds, preset, contextContent, allCheckpoints),
    ]);

    roundTimes.push(Date.now() - roundStart);
  }

  // ── Synthesis ─────────────────────────────────────────────────────────
  console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
  console.log(`${C.green}${C.bold}  GENERANDO SINTESIS FINAL...${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

  const h1 = readChat(CHAT_FILE_1);
  const h2 = readChat(CHAT_FILE_2);
  const synthPrompt = buildSynthesisPrompt(h1, h2, topic, allCheckpoints);

  const synthResult = await invokeAgent(sala1[0], synthPrompt, { ...preset, timeout: 600_000 });
  const synthesis = synthResult.response;

  fs.writeFileSync(CHAT_FINAL, `# Sintesis Final — v3\n> ${new Date().toLocaleString()}\n> Tema: ${topic}\n\n---\n\n${synthesis}\n`, 'utf-8');

  console.log(`${C.green}${C.bold}  SINTESIS:${C.reset}`);
  synthesis.split('\n').forEach(l => console.log(`${C.green}  │ ${C.reset}${l}`));

  // ── Checkpoints summary ───────────────────────────────────────────────
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

  // ── Save to memory ────────────────────────────────────────────────────
  console.log(`\n${C.yellow}${C.bold}  Guardando en memoria...${C.reset}`);

  const extractPrompt = `Extrae EXACTAMENTE en formato JSON (sin markdown, sin backticks):\n{"ideas":["idea 1","idea 2","idea 3","idea 4","idea 5"],"decisions":["decision 1","decision 2","decision 3"]}\n\nMaximo 5 ideas y 3 decisiones en frases cortas.\n\n${synthesis}`;
  const extractResult = await invokeAgent(sala1[0], extractPrompt, { ...preset, timeout: 120_000 });

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

  // ── Action prompts ────────────────────────────────────────────────────
  console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  GENERANDO PROMPTS DE ACCION...${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

  const apPrompt = buildActionPromptsPrompt(synthesis, h1, h2);
  const apResult = await invokeAgent(sala1[0], apPrompt, { ...preset, timeout: 600_000 });

  fs.writeFileSync(AGENT_PROMPTS_FILE, `# Prompts de Accion — v3\n> ${new Date().toLocaleString()}\n> Tema: ${topic}\n\n---\n\n${apResult.response}\n`, 'utf-8');

  console.log(`${C.cyan}${C.bold}  PROMPTS DE ACCION:${C.reset}`);
  apResult.response.split('\n').forEach(l => console.log(`${C.cyan}  │ ${C.reset}${l}`));

  // ── Git tracking: close action items matched by commits ──────────────
  console.log(`\n${C.dim}  Verificando commits para cerrar action items...${C.reset}`);
  try {
    const gitResult = matchCommitsToActions();
    if (gitResult.closed.length > 0) {
      console.log(`${C.green}  ✓ Cerrados por commits: ${gitResult.closed.join(', ')}${C.reset}`);
    } else {
      console.log(`${C.dim}  Sin action items cerrados por commits recientes${C.reset}`);
    }
  } catch {}

  // ── Action items from checkpoints ───────────────────────────────────
  console.log(`\n${C.yellow}${C.bold}  Procesando action items...${C.reset}`);
  const actionItems = formatActionItems(allCheckpoints, global.__sessionId);
  const newItems = actionItems.filter(i => i.createdSession === global.__sessionId);
  console.log(`${C.yellow}  ${newItems.length} nuevos action items, ${actionItems.length} total${C.reset}`);

  // ── Update agent competences ────────────────────────────────────────
  if (useCompetenceTracking) {
    console.log(`${C.dim}  Actualizando competencias de agentes...${C.reset}`);
    for (const cp of allCheckpoints) {
      if (competences[cp.agentName]) {
        // quality 5 if structured + has accionables, 3 if structured, 1 if not
        let q = 1;
        if (cp.structured && cp.accionable.length > 0) q = 5;
        else if (cp.structured) q = 3;
        competences[cp.agentName] = updateCompetence(competences[cp.agentName], q);
      }
    }
    saveCompetences(competences);
  }

  // ── Generate session report ─────────────────────────────────────────
  const totalMs = Date.now() - globalStart;
  console.log(`\n${C.dim}  Generando reporte de sesión...${C.reset}`);
  formatReport({
    actionItems,
    checkpoints: allCheckpoints,
    metrics: null,
    competences: useCompetenceTracking ? competences : null,
    sessionId: global.__sessionId,
    topic,
    duration: totalMs,
  });

  // ── Archive session files ───────────────────────────────────────────
  archiveSession(global.__sessionId);
  console.log(`${C.dim}  Sesión archivada en sessions/${global.__sessionId}/${C.reset}`);

  // ── Session metrics ───────────────────────────────────────────────────
  appendMetric({
    type: 'session',
    sessionId: global.__sessionId,
    date: sessionDate,
    topic,
    quality,
    rounds,
    agents: [...sala1, ...sala2],
    duration: totalMs,
    roundTimes,
    totalCheckpoints: allCheckpoints.length,
    structuredCheckpoints: structured.length,
    ideasSaved: ideas.length,
    decisionsSaved: decisions.length,
    actionItemsNew: newItems.length,
    actionItemsTotal: actionItems.length,
  });

  // ── Final ─────────────────────────────────────────────────────────────
  const totalMins = Math.floor(totalMs / 60000);
  const remSecs = Math.floor((totalMs % 60000) / 1000);

  console.log(`\n${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.dim}  Tiempo total: ${totalMins}m ${remSecs}s${C.reset}`);
  console.log(`${C.dim}  Checkpoints: ${structured.length}/${allCheckpoints.length} estructurados${C.reset}`);
  console.log(`${C.dim}  Memoria: sesion #${sessionNum} (${vecCount} vectores)${C.reset}`);
  console.log(`${C.dim}  Action items: ${newItems.length} nuevos, ${actionItems.length} total${C.reset}`);
  console.log(`${C.dim}  Archivos:${C.reset}`);
  console.log(`${C.blue}    ${CHAT_FILE_1}${C.reset}`);
  console.log(`${C.magenta}    ${CHAT_FILE_2}${C.reset}`);
  console.log(`${C.green}    ${CHAT_FINAL}${C.reset}`);
  console.log(`${C.cyan}    ${AGENT_PROMPTS_FILE}${C.reset}`);
  console.log(`${C.yellow}    ${METRICS_FILE}${C.reset}`);
  console.log(`${C.dim}    sessions/session-report.md${C.reset}`);
  console.log(`${C.dim}    sessions/action-items.json${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}\n`);
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });
