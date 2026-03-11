#!/usr/bin/env node

/**
 * Multi-Agent Chat Orchestrator v2 — Parallel Edition
 *
 * Dos salas de chat simultaneas con cross-pollination entre rondas.
 * Los agentes se dividen en 2 grupos que debaten en paralelo,
 * y al final de cada ronda leen lo que dijo el otro grupo.
 *
 * Uso:
 *   node orchestrator-v2.cjs "tema"
 *   node orchestrator-v2.cjs --quality high --rounds 3 "tema"
 *   node orchestrator-v2.cjs --sala1 "arquitecto,teach-leader,experto-quiz" --sala2 "experto-resumen,experto-flashcards,experto-organizador" "tema"
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────
const CHAT_DIR = __dirname;
const CHAT_FILE_1 = path.join(CHAT_DIR, 'sala-estrategia.md');
const CHAT_FILE_2 = path.join(CHAT_DIR, 'sala-implementacion.md');
const CHAT_FINAL = path.join(CHAT_DIR, 'sintesis-final.md');
const MEMORY_DIR = path.join(CHAT_DIR, 'memoria');
const MEMORY_FILE = path.join(MEMORY_DIR, 'historial.json');
const MEMORY_SUMMARY = path.join(MEMORY_DIR, 'memoria-acumulada.md');
const PROJECT_DIR = path.resolve(__dirname, '..');

// Vector store for semantic memory
const vectorStore = require('./memoria/vector-store.cjs');

const DEFAULT_SALA1 = ['arquitecto', 'teach-leader', 'experto-quiz'];
const DEFAULT_SALA2 = ['experto-resumen', 'experto-flashcards', 'experto-organizador'];
const DEFAULT_ROUNDS = 3;
const DEFAULT_QUALITY = 'high';

// ── Quality presets ─────────────────────────────────────────────────────
const QUALITY_PRESETS = {
  normal: { model: 'sonnet', maxWords: 300, effort: 'medium', timeout: 120_000 },
  high:   { model: 'opus',   maxWords: 500, effort: 'high',   timeout: 300_000 },
  max:    { model: 'opus',   maxWords: 800, effort: 'max',    timeout: 600_000 },
};

// ── Parse args ──────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let sala1 = DEFAULT_SALA1;
  let sala2 = DEFAULT_SALA2;
  let rounds = DEFAULT_ROUNDS;
  let quality = DEFAULT_QUALITY;
  let contextFile = '';
  let topic = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sala1' && args[i + 1]) {
      sala1 = args[++i].split(',').map(a => a.trim());
    } else if (args[i] === '--sala2' && args[i + 1]) {
      sala2 = args[++i].split(',').map(a => a.trim());
    } else if (args[i] === '--rounds' && args[i + 1]) {
      rounds = parseInt(args[++i], 10);
    } else if (args[i] === '--quality' && args[i + 1]) {
      quality = args[++i];
    } else if (args[i] === '--context' && args[i + 1]) {
      contextFile = args[++i];
    } else {
      topic += (topic ? ' ' : '') + args[i];
    }
  }

  if (!topic) {
    console.error('\n  Uso: node orchestrator-v2.cjs [opciones] "tema"\n');
    console.error('  Opciones:');
    console.error('    --sala1 "a,b,c"      Agentes en Sala Estrategia');
    console.error('    --sala2 "d,e,f"      Agentes en Sala Implementacion');
    console.error('    --rounds N           Rondas (default: 3)');
    console.error('    --quality NIVEL      normal | high | max (default: high)');
    console.error('\n  Agentes disponibles:');
    const agentsDir = path.join(PROJECT_DIR, '.claude', 'agents');
    if (fs.existsSync(agentsDir)) {
      fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))
        .forEach(f => console.error(`    - ${f.replace('.md', '')}`));
    }
    process.exit(1);
  }

  // Load context file if provided
  let contextContent = '';
  if (contextFile) {
    const ctxPath = path.resolve(contextFile);
    if (fs.existsSync(ctxPath)) {
      contextContent = fs.readFileSync(ctxPath, 'utf-8');
    } else {
      console.error(`  Error: archivo de contexto no encontrado: ${ctxPath}`);
      process.exit(1);
    }
  }

  return { sala1, sala2, rounds, topic, quality, contextContent };
}

// ── Colors ──────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  white: '\x1b[37m', bgBlue: '\x1b[44m', bgMagenta: '\x1b[45m',
};

const SALA_COLORS = {
  1: { header: C.bgBlue + C.white, agent: [C.cyan, C.blue, C.green], border: C.blue },
  2: { header: C.bgMagenta + C.white, agent: [C.magenta, C.yellow, C.red], border: C.magenta },
};

function agentColor(salaNum, index) {
  const colors = SALA_COLORS[salaNum].agent;
  return colors[index % colors.length];
}

// ── Chat helpers ────────────────────────────────────────────────────────
function initChatFile(filePath, salaName, topic, agents, quality) {
  const preset = QUALITY_PRESETS[quality];
  const ts = new Date().toLocaleString();
  const content = `# ${salaName}
> Sesion: ${ts}
> Tema: ${topic}
> Participantes: ${agents.join(', ')}
> Calidad: ${quality} (${preset.model}, esfuerzo: ${preset.effort})

---

## Tema
${topic}

---

`;
  fs.writeFileSync(filePath, content, 'utf-8');
}

function appendMsg(filePath, agent, message) {
  const ts = new Date().toLocaleTimeString();
  fs.appendFileSync(filePath, `### [${ts}] ${agent}:\n${message}\n\n---\n\n`, 'utf-8');
}

function readChat(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

// ── Memory system ───────────────────────────────────────────────────────
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveSession(topic, ideas, decisions, date) {
  const sessions = loadMemory();
  sessions.push({
    id: sessions.length + 1,
    date,
    topic,
    ideas,
    decisions,
  });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
  rebuildMemorySummary(sessions);
}

function rebuildMemorySummary(sessions) {
  if (!sessions.length) return;

  let md = `# Memoria Acumulada — Multi-Agent Chat\n`;
  md += `> Total de sesiones: ${sessions.length}\n`;
  md += `> Ultima actualizacion: ${new Date().toLocaleString()}\n\n---\n\n`;

  // Solo las ultimas 10 sesiones para no sobrecargar el prompt
  const recent = sessions.slice(-10);

  for (const s of recent) {
    md += `## Sesion #${s.id} (${s.date})\n`;
    md += `**Tema:** ${s.topic}\n\n`;
    if (s.ideas && s.ideas.length) {
      md += `**Ideas clave:**\n`;
      s.ideas.forEach(idea => { md += `- ${idea}\n`; });
      md += '\n';
    }
    if (s.decisions && s.decisions.length) {
      md += `**Decisiones:**\n`;
      s.decisions.forEach(d => { md += `- ${d}\n`; });
      md += '\n';
    }
    md += `---\n\n`;
  }

  fs.writeFileSync(MEMORY_SUMMARY, md, 'utf-8');
}

function getMemoryContext() {
  if (fs.existsSync(MEMORY_SUMMARY)) {
    const content = fs.readFileSync(MEMORY_SUMMARY, 'utf-8');
    if (content.trim().length > 50) return content;
  }
  return '';
}

// Semantic memory search — returns only relevant memories for the topic
async function getSemanticMemory(query, topK = 5) {
  try {
    return await vectorStore.getRelevantContext(query, topK);
  } catch {
    // Fallback to text memory if Ollama is not running
    return getMemoryContext();
  }
}

// ── Invoke agent (async) ────────────────────────────────────────────────
function askAgentAsync(agentName, prompt, preset) {
  return new Promise((resolve) => {
    const child = exec(
      'claude -p --agent "' + agentName + '" --model ' + preset.model + ' --effort ' + preset.effort + ' --tools ""',
      {
        cwd: PROJECT_DIR,
        encoding: 'utf-8',
        timeout: preset.timeout,
        maxBuffer: 1024 * 1024 * 10,
        shell: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve(`[Error: ${agentName} - ${(err.message || '').slice(0, 150)}]`);
        } else {
          resolve(stdout.trim());
        }
      }
    );
    // Send prompt via stdin
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

// ── Prompt builders ─────────────────────────────────────────────────────
async function buildFirstPrompt(agent, agents, topic, salaName, otherSalaName, maxWords, contextContent) {
  const others = agents.filter(a => a !== agent).join(', ');
  const memory = await getSemanticMemory(topic);

  let prompt = `Eres ${agent} en la "${salaName}" del proyecto Axon (plataforma educativa medica, React+TypeScript+Vite+Supabase).

CONTEXTO:
- Tema: "${topic}"
- Tus companeros en esta sala: ${others}
- Hay otra sala ("${otherSalaName}") debatiendo el mismo tema en paralelo. Despues cruzaran ideas.
`;

  if (contextContent) {
    prompt += `
DOCUMENTACION DEL SISTEMA A DISCUTIR:
${contextContent}
`;
  }

  if (memory) {
    prompt += `
MEMORIA DE SESIONES ANTERIORES:
${memory}
IMPORTANTE: NO repitas ideas que ya se discutieron. Construye SOBRE ellas, profundiza, o propone alternativas nuevas. Si una idea anterior fue buena, llévala al siguiente nivel de detalle.
`;
  }

  prompt += `
TU TAREA:
Da tu perspectiva CREATIVA e INNOVADORA. Se especifico para Axon:
- Propone ideas CONCRETAS (menciona componentes, servicios, hooks reales del proyecto)
- Piensa en UX/UI especificos, flujos de usuario
- Si propones IA, detalla: que modelo, que endpoint, que datos de entrada/salida
- Se AUDAZ — propone cosas que nadie esperaria
${memory ? '- CONSTRUYE sobre las decisiones anteriores, no repitas\n' : ''}
Maximo ${maxWords} palabras. Responde SOLO con texto.`;

  return prompt;
}

async function buildDebatePrompt(agent, agents, topic, salaName, ownHistory, otherHistory, otherSalaName, round, totalRounds, maxWords, contextContent) {
  const others = agents.filter(a => a !== agent).join(', ');
  const memory = round === 2 ? await getSemanticMemory(topic) : '';

  let prompt = `Eres ${agent} en la "${salaName}" del proyecto Axon.
`;

  if (contextContent && round <= 2) {
    prompt += `
DOCUMENTACION DEL SISTEMA A DISCUTIR:
${contextContent}
`;
  }

  if (memory) {
    prompt += `
${memory}
IMPORTANTE: NO repitas ideas de sesiones anteriores. Construye SOBRE ellas.
`;
  }

  prompt += `
HISTORIAL DE TU SALA:
${ownHistory}
`;

  if (otherHistory) {
    prompt += `
HISTORIAL DE LA OTRA SALA ("${otherSalaName}"):
${otherHistory}

IMPORTANTE: Lee lo que dijo la otra sala. Conecta ideas entre ambas salas, desafia o amplifica sus propuestas.
`;
  }

  prompt += `
CONTEXTO: Ronda ${round}/${totalRounds}. Companeros: ${others}.

TU TAREA:
- RESPONDE a lo que dijeron — no repitas, AVANZA la discusion
- Si ves una idea brillante de la otra sala, adáptala y mejorala
- Si ves una idea debil, desafiala con argumentos tecnicos
- Propone CONEXIONES entre ideas de ambas salas
- Agrega algo NUEVO que nadie haya dicho
- Se especifico: archivos, componentes, hooks, servicios reales de Axon
${round === totalRounds ? '- ULTIMA RONDA: Cierra con tus TOP 3 propuestas priorizadas\n' : ''}
Maximo ${maxWords} palabras. Responde SOLO con texto.`;

  return prompt;
}

function buildSynthesisPrompt(history1, history2, topic) {
  return `Eres el facilitador que sintetiza dos discusiones paralelas sobre el proyecto Axon.

SALA ESTRATEGIA:
${history1}

SALA IMPLEMENTACION:
${history2}

TEMA: ${topic}

Genera una SINTESIS EJECUTIVA de alta calidad:

## 1. LAS 5 MEJORES IDEAS (combinando ambas salas)
Para cada una: idea, quien la propuso, impacto esperado, esfuerzo estimado (S/M/L), prioridad (P0/P1/P2)

## 2. CONEXIONES ENTRE SALAS
Ideas de una sala que complementan o potencian ideas de la otra

## 3. ROADMAP PROPUESTO
Fase 1 (Quick wins, 1-2 semanas), Fase 2 (Core features, 1 mes), Fase 3 (Avanzado, 2-3 meses)

## 4. ARQUITECTURA DE IA PROPUESTA
Diagrama textual de como se integran los servicios de IA en Axon

## 5. RIESGOS Y DECISIONES PENDIENTES
Puntos de desacuerdo, trade-offs, cosas que necesitan mas investigacion

## 6. SIGUIENTE PASO INMEDIATO
La UNICA cosa mas importante que hacer manana

Se concreto y accionable. Responde SOLO con texto.`;
}

// ── Run one sala (all agents in sequence for a round) ───────────────────
async function runSalaRound(salaNum, agents, topic, salaName, otherSalaName, chatFile, otherChatFile, round, totalRounds, preset, contextContent) {
  const results = [];

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const color = agentColor(salaNum, i);
    const border = SALA_COLORS[salaNum].border;
    const startTime = Date.now();

    process.stdout.write(`${border}  │ ${color}${C.bold}[${agent}]${C.reset} ${C.dim}pensando...${C.reset}`);

    const ownHistory = readChat(chatFile);
    const otherHistory = round > 1 ? readChat(otherChatFile) : '';

    let prompt;
    if (round === 1 && i === 0) {
      prompt = await buildFirstPrompt(agent, agents, topic, salaName, otherSalaName, preset.maxWords, contextContent);
    } else {
      prompt = await buildDebatePrompt(agent, agents, topic, salaName, ownHistory, otherHistory, otherSalaName, round, totalRounds, preset.maxWords, contextContent);
    }

    const response = await askAgentAsync(agent, prompt, preset);
    const secs = Math.floor((Date.now() - startTime) / 1000);

    appendMsg(chatFile, agent, response);

    // Clear "pensando..." and show response
    process.stdout.write(`\r${border}  │ ${color}${C.bold}[${agent}]${C.reset} ${C.dim}(${secs}s)${C.reset}\n`);
    response.split('\n').forEach(line => {
      console.log(`${border}  │ ${C.reset}  ${line}`);
    });
    console.log(`${border}  │${C.reset}`);

    results.push({ agent, response });
  }

  return results;
}

// ── Run two salas in parallel ───────────────────────────────────────────
async function runParallelRound(sala1Agents, sala2Agents, topic, round, totalRounds, preset, contextContent) {
  console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
  console.log(`${C.bold}  RONDA ${round}/${totalRounds}${round > 1 ? '  (con cross-pollination)' : ''}${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

  // Show both sala headers
  console.log(`${C.blue}${C.bold}  ┌─ SALA ESTRATEGIA ────────────┐${C.reset}   ${C.magenta}${C.bold}┌─ SALA IMPLEMENTACION ─────────┐${C.reset}`);
  console.log(`${C.blue}${C.bold}  │${C.reset} ${C.dim}${sala1Agents.join(', ')}${C.reset}   ${C.magenta}${C.bold}│${C.reset} ${C.dim}${sala2Agents.join(', ')}${C.reset}`);
  console.log('');

  // Run both salas in PARALLEL
  const [results1, results2] = await Promise.all([
    runSalaRound(1, sala1Agents, topic, 'Sala Estrategia', 'Sala Implementacion', CHAT_FILE_1, CHAT_FILE_2, round, totalRounds, preset, contextContent),
    runSalaRound(2, sala2Agents, topic, 'Sala Implementacion', 'Sala Estrategia', CHAT_FILE_2, CHAT_FILE_1, round, totalRounds, preset, contextContent),
  ]);

  return { results1, results2 };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const { sala1, sala2, rounds, topic, quality, contextContent } = parseArgs();
  const preset = QUALITY_PRESETS[quality];
  const allAgents = [...sala1, ...sala2];

  console.log(`\n${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.bold}  MULTI-AGENT CHAT v2 — PARALLEL EDITION${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.dim}  Tema:     ${topic}${C.reset}`);
  console.log(`${C.blue}${C.bold}  Sala 1:${C.reset}${C.dim}   ${sala1.join(', ')} (Estrategia)${C.reset}`);
  console.log(`${C.magenta}${C.bold}  Sala 2:${C.reset}${C.dim}   ${sala2.join(', ')} (Implementacion)${C.reset}`);
  console.log(`${C.dim}  Rondas:   ${rounds} | Modelo: ${preset.model} | Esfuerzo: ${preset.effort}${C.reset}`);
  console.log(`${C.dim}  Archivos: sala-estrategia.md + sala-implementacion.md${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}`);

  // Init chat files
  initChatFile(CHAT_FILE_1, 'Sala Estrategia', topic, sala1, quality);
  initChatFile(CHAT_FILE_2, 'Sala Implementacion', topic, sala2, quality);

  const globalStart = Date.now();

  // Run rounds
  for (let round = 1; round <= rounds; round++) {
    await runParallelRound(sala1, sala2, topic, round, rounds, preset, contextContent);
  }

  // Synthesis
  console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
  console.log(`${C.green}${C.bold}  GENERANDO SINTESIS FINAL (cruzando ambas salas)...${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

  const h1 = readChat(CHAT_FILE_1);
  const h2 = readChat(CHAT_FILE_2);
  const synthPrompt = buildSynthesisPrompt(h1, h2, topic);

  const synthesis = await askAgentAsync(sala1[0], synthPrompt, { ...preset, timeout: 600_000 });

  // Save synthesis
  const synthContent = `# Sintesis Final — Multi-Agent Chat v2
> Fecha: ${new Date().toLocaleString()}
> Tema: ${topic}
> Sala Estrategia: ${sala1.join(', ')}
> Sala Implementacion: ${sala2.join(', ')}
> Calidad: ${quality}

---

${synthesis}
`;
  fs.writeFileSync(CHAT_FINAL, synthContent, 'utf-8');

  // Display
  console.log(`${C.green}${C.bold}  SINTESIS FINAL:${C.reset}`);
  synthesis.split('\n').forEach(line => {
    console.log(`${C.green}  │ ${C.reset}${line}`);
  });

  // ── Extract ideas and save to memory ──────────────────────────────────
  console.log(`\n${C.yellow}${C.bold}  Guardando en memoria...${C.reset}`);

  const extractPrompt = `Del siguiente resumen de discusion, extrae EXACTAMENTE en este formato JSON (sin markdown, sin backticks, solo el JSON puro):
{"ideas":["idea 1","idea 2","idea 3","idea 4","idea 5"],"decisions":["decision 1","decision 2","decision 3"]}

Maximo 5 ideas clave y 3 decisiones tomadas. Cada una en una frase corta.

RESUMEN:
${synthesis}`;

  const extracted = await askAgentAsync(sala1[0], extractPrompt, { ...preset, timeout: 120_000 });

  let ideas = [];
  let decisions = [];
  try {
    const jsonMatch = extracted.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      ideas = parsed.ideas || [];
      decisions = parsed.decisions || [];
    }
  } catch {
    ideas = [synthesis.slice(0, 200) + '...'];
  }

  const sessionDate = new Date().toLocaleDateString();
  const sessionNum = loadMemory().length + 1;

  // Save to text memory (backup)
  saveSession(topic, ideas, decisions, sessionDate);

  // Save to vector store (semantic memory)
  console.log(`${C.yellow}  Guardando en vector store...${C.reset}`);
  const meta = { session: sessionNum, date: sessionDate, topic };
  let vectorCount = 0;

  for (const idea of ideas) {
    try {
      await vectorStore.addMemory(idea, 'ideas', meta);
      vectorCount++;
      process.stdout.write(`${C.yellow}    [idea ${vectorCount}] embedido${C.reset}\n`);
    } catch (e) {
      console.log(`${C.red}    [idea] error: ${e.message.slice(0, 80)}${C.reset}`);
    }
  }

  for (const dec of decisions) {
    try {
      await vectorStore.addMemory(dec, 'decisiones', meta);
      vectorCount++;
      process.stdout.write(`${C.yellow}    [decision ${vectorCount}] embedida${C.reset}\n`);
    } catch (e) {
      console.log(`${C.red}    [decision] error: ${e.message.slice(0, 80)}${C.reset}`);
    }
  }

  // Save synthesis as conclusion
  try {
    await vectorStore.addMemory(synthesis.slice(0, 1000), 'conclusiones', meta);
    vectorCount++;
    console.log(`${C.yellow}    [conclusion] embedida${C.reset}`);
  } catch {}

  const stats = vectorStore.getStats();
  const sessions = loadMemory();
  console.log(`${C.yellow}  Sesion #${sessions.length} guardada${C.reset}`);
  console.log(`${C.yellow}  Vector store: ${stats.total} memorias (${Object.entries(stats.categories).map(([k,v]) => `${k}:${v}`).join(', ')})${C.reset}`);

  // ── Generate action prompts per agent ──────────────────────────────────
  console.log(`\n${C.bold}${'─'.repeat(62)}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  GENERANDO PROMPTS DE ACCION POR AGENTE...${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(62)}${C.reset}\n`);

  const AGENT_PROMPTS_FILE = path.join(CHAT_DIR, 'prompts-de-accion.md');

  const agentPromptRequest = `Basandote en la sintesis final y todo el debate de ambas salas, genera un PROMPT COMPLETO Y DETALLADO para cada agente del proyecto Axon.

SINTESIS:
${synthesis}

HISTORIAL SALA ESTRATEGIA:
${h1.slice(0, 3000)}

HISTORIAL SALA IMPLEMENTACION:
${h2.slice(0, 3000)}

Genera un prompt para CADA UNO de estos agentes. Cada prompt debe ser autocontenido — el agente debe poder leerlo y saber EXACTAMENTE que hacer sin contexto adicional:

## ARQUITECTO
Prompt completo para el arquitecto: que archivos crear/modificar, que tipos definir, que invariantes respetar, orden de ejecucion.

## EXPERTO-QUIZ
Prompt completo para el experto en quiz: que componentes modificar, que endpoints conectar, que hooks crear, flujo exacto del quiz adaptativo.

## EXPERTO-FLASHCARDS
Prompt completo para el experto en flashcards: que tipos de tarjetas implementar, como integrar con BKT/FSRS, que endpoints usar.

## EXPERTO-RESUMEN
Prompt completo para el experto en resumenes: que generar, cuando mostrarlo, que datos de entrada/salida, componentes exactos.

## EXPERTO-ORGANIZADOR
Prompt completo para el experto en organizador/dashboard: que mostrar en el dashboard, como integrar las recomendaciones de IA, flujo del estudiante.

## TEACH-LEADER
Prompt completo para el teach-leader: que revisar, que validar, criterios de calidad, que tests proponer, que patrones de codigo seguir.

REGLAS PARA CADA PROMPT:
- Menciona archivos EXACTOS del proyecto (paths reales)
- Define tipos TypeScript si son necesarios
- Especifica endpoints con request/response
- Define el orden de implementacion (que va primero)
- Incluye criterios de "done" (como saber que esta terminado)
- Maximo 500 palabras por agente
- Cada prompt empieza con: "Tu tarea es..."

Responde SOLO con texto, en formato markdown.`;

  const agentPrompts = await askAgentAsync(sala1[0], agentPromptRequest, { ...preset, timeout: 600_000 });

  // Save to file
  const promptsContent = `# Prompts de Accion — Generados por Multi-Agent Chat v2
> Fecha: ${new Date().toLocaleString()}
> Tema: ${topic}
> Basado en: ${sessions.length} sesiones de debate

---

${agentPrompts}
`;
  fs.writeFileSync(AGENT_PROMPTS_FILE, promptsContent, 'utf-8');

  // Display
  console.log(`${C.cyan}${C.bold}  PROMPTS DE ACCION:${C.reset}`);
  agentPrompts.split('\n').forEach(line => {
    console.log(`${C.cyan}  │ ${C.reset}${line}`);
  });

  // Save prompts to vector store
  try {
    await vectorStore.addMemory(agentPrompts.slice(0, 2000), 'arquitectura', meta);
    console.log(`\n${C.yellow}  Prompts guardados en vector store${C.reset}`);
  } catch {}

  console.log(`${C.cyan}  Archivo: ${AGENT_PROMPTS_FILE}${C.reset}`);

  // ── Final stats ───────────────────────────────────────────────────────
  const totalSecs = Math.floor((Date.now() - globalStart) / 1000);
  const totalMins = Math.floor(totalSecs / 60);
  const remSecs = totalSecs % 60;

  console.log(`\n${C.bold}${'═'.repeat(62)}${C.reset}`);
  console.log(`${C.dim}  Tiempo total: ${totalMins}m ${remSecs}s${C.reset}`);
  console.log(`${C.dim}  Sesiones en memoria: ${sessions.length}${C.reset}`);
  console.log(`${C.dim}  Archivos:${C.reset}`);
  console.log(`${C.blue}    Sala Estrategia:    ${CHAT_FILE_1}${C.reset}`);
  console.log(`${C.magenta}    Sala Implementacion: ${CHAT_FILE_2}${C.reset}`);
  console.log(`${C.green}    Sintesis Final:     ${CHAT_FINAL}${C.reset}`);
  console.log(`${C.yellow}    Memoria:            ${MEMORY_SUMMARY}${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(62)}${C.reset}\n`);
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
