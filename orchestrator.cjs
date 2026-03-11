#!/usr/bin/env node

/**
 * Multi-Agent Chat Orchestrator
 *
 * Hace que los agentes de Claude Code se comuniquen entre sí
 * usando un archivo compartido como "chat room".
 *
 * Uso:
 *   node orchestrator.cjs "¿Cómo mejoramos la arquitectura del quiz?"
 *   node orchestrator.cjs --agents "teach-leader,experto-quiz" "tema a discutir"
 *   node orchestrator.cjs --rounds 5 --quality high "tema"
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────
const CHAT_FILE = path.join(__dirname, 'chat-room.md');
const PROJECT_DIR = path.resolve(__dirname, '..');

const DEFAULT_AGENTS = ['arquitecto', 'teach-leader'];
const DEFAULT_ROUNDS = 3;
const DEFAULT_QUALITY = 'normal';

// ── Quality presets ─────────────────────────────────────────────────────
const QUALITY_PRESETS = {
  normal: {
    model: 'sonnet',
    maxWords: 200,
    effort: 'medium',
    timeout: 120_000,
  },
  high: {
    model: 'opus',
    maxWords: 500,
    effort: 'high',
    timeout: 300_000,
  },
  max: {
    model: 'opus',
    maxWords: 800,
    effort: 'max',
    timeout: 600_000,
  },
};

// ── Parse args ──────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let agents = DEFAULT_AGENTS;
  let rounds = DEFAULT_ROUNDS;
  let quality = DEFAULT_QUALITY;
  let topic = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agents' && args[i + 1]) {
      agents = args[++i].split(',').map(a => a.trim());
    } else if (args[i] === '--rounds' && args[i + 1]) {
      rounds = parseInt(args[++i], 10);
    } else if (args[i] === '--quality' && args[i + 1]) {
      quality = args[++i];
    } else {
      topic += (topic ? ' ' : '') + args[i];
    }
  }

  if (!topic) {
    console.error('\n  Uso: node orchestrator.cjs [opciones] "tema"\n');
    console.error('  Opciones:');
    console.error('    --agents "a,b,c"     Agentes participantes');
    console.error('    --rounds N           Rondas de conversacion (default: 3)');
    console.error('    --quality NIVEL      normal | high | max (default: normal)');
    console.error('\n  Ejemplos:');
    console.error('    node orchestrator.cjs --quality high "¿Cómo mejoramos el quiz?"');
    console.error('    node orchestrator.cjs --agents "teach-leader,arquitecto" --quality max --rounds 3 "integrar IA"');
    console.error('\n  Agentes disponibles:');

    const agentsDir = path.join(PROJECT_DIR, '.claude', 'agents');
    if (fs.existsSync(agentsDir)) {
      fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .forEach(f => console.error(`    - ${f.replace('.md', '')}`));
    }
    process.exit(1);
  }

  if (!QUALITY_PRESETS[quality]) {
    console.error(`  Error: quality debe ser: normal, high, o max`);
    process.exit(1);
  }

  return { agents, rounds, topic, quality };
}

// ── Colores para terminal ───────────────────────────────────────────────
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const AGENT_COLORS = [COLORS.cyan, COLORS.magenta, COLORS.yellow, COLORS.green, COLORS.blue, COLORS.red];

function colorFor(index) {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

// ── Chat room helpers ───────────────────────────────────────────────────
function initChatRoom(topic, agents, quality) {
  const preset = QUALITY_PRESETS[quality];
  const timestamp = new Date().toLocaleString();
  const content = `# Chat Room - Agentes Axon
> Sesion: ${timestamp}
> Tema: ${topic}
> Participantes: ${agents.join(', ')}
> Calidad: ${quality} (modelo: ${preset.model}, esfuerzo: ${preset.effort})

---

## Tema de discusion
${topic}

---

`;
  fs.writeFileSync(CHAT_FILE, content, 'utf-8');
}

function appendMessage(agent, message) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `### [${timestamp}] ${agent}:\n${message}\n\n---\n\n`;
  fs.appendFileSync(CHAT_FILE, entry, 'utf-8');
}

function getChatHistory() {
  return fs.readFileSync(CHAT_FILE, 'utf-8');
}

// ── Prompt templates ────────────────────────────────────────────────────
function buildPrompt(agentName, agents, topic, history, round, totalRounds, maxWords) {
  const otherAgents = agents.filter(a => a !== agentName).join(', ');

  if (round === 1 && !history.includes('###')) {
    // First message ever
    return `Eres ${agentName}, parte de un panel de expertos del proyecto Axon (plataforma educativa medica, React+TypeScript+Vite+Supabase).

CONTEXTO DE LA DISCUSION:
- Tema: "${topic}"
- Otros panelistas: ${otherAgents}
- Esta es la Ronda 1 de ${totalRounds}. Habra debate despues.

TU TAREA:
Presenta tu vision CREATIVA e INNOVADORA sobre el tema. No seas generico.
- Propone ideas CONCRETAS y ESPECIFICAS para Axon (menciona componentes, rutas, servicios reales del proyecto)
- Piensa en lo que NADIE ha propuesto antes
- Da ejemplos de UX/UI especificos
- Si propones IA, di EXACTAMENTE como se integraria (que modelo, que endpoint, que flujo)

Escribe maximo ${maxWords} palabras. Se directo, sin formalidades. Responde SOLO con texto.`;
  }

  // Subsequent messages
  return `Eres ${agentName}, parte de un panel de expertos del proyecto Axon.

HISTORIAL DE LA DISCUSION:
${history}

CONTEXTO:
- Ronda ${round} de ${totalRounds}
- Otros panelistas: ${otherAgents}

TU TAREA:
Lee lo que dijeron los demas y RESPONDE DIRECTAMENTE:
- Si estas de acuerdo con algo, AMPLIFICA la idea con detalles concretos de implementacion
- Si NO estas de acuerdo, di POR QUE y propone una alternativa mejor
- Conecta ideas de diferentes agentes que podrian funcionar juntas
- Propone algo NUEVO que nadie haya mencionado
- Se especifico: menciona archivos, componentes, hooks, servicios reales de Axon
- Desafia las ideas debiles con argumentos tecnicos

NO repitas lo que ya se dijo. NO seas diplomatico. Se honesto y creativo.
Maximo ${maxWords} palabras. Responde SOLO con texto.`;
}

function buildSummaryPrompt(history, topic) {
  return `Eres el facilitador de esta discusion entre agentes de Axon.

HISTORIAL COMPLETO:
${history}

Genera un RESUMEN EJECUTIVO de alta calidad:

## 1. IDEAS ESTRELLA (las 3 mejores propuestas con mayor impacto)
Para cada una: que es, quien la propuso, como implementarla, prioridad (P0/P1/P2)

## 2. PLAN DE ACCION INMEDIATO
Pasos concretos ordenados por prioridad, con agente responsable

## 3. ARQUITECTURA PROPUESTA
Como se conectan las ideas entre si, que servicios/componentes nuevos se necesitan

## 4. RIESGOS Y DESACUERDOS
Puntos donde los agentes no coincidieron, decisiones pendientes

## 5. QUICK WINS
Cosas que se pueden implementar HOY con minimo esfuerzo y maximo impacto

Se concreto y accionable. Responde SOLO con texto.`;
}

// ── Invoke agent via claude CLI ─────────────────────────────────────────
function askAgent(agentName, prompt, preset) {
  try {
    // Pass prompt via stdin — use shell:true so Windows finds claude.cmd
    const result = execSync(
      'claude -p --agent "' + agentName + '" --model ' + preset.model + ' --effort ' + preset.effort + ' --tools ""',
      {
        input: prompt,
        cwd: PROJECT_DIR,
        encoding: 'utf-8',
        timeout: preset.timeout,
        maxBuffer: 1024 * 1024 * 10,
        shell: true,
      }
    );

    return result.trim();
  } catch (err) {
    return `[Error: ${agentName} no respondio - ${err.message?.slice(0, 200)}]`;
  }
}

// ── Spinner animation ───────────────────────────────────────────────────
function elapsed(startTime) {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  return `${seconds}s`;
}

// ── Main loop ───────────────────────────────────────────────────────────
function main() {
  const { agents, rounds, topic, quality } = parseArgs();
  const preset = QUALITY_PRESETS[quality];

  console.log(`\n${COLORS.bold}${'═'.repeat(62)}${COLORS.reset}`);
  console.log(`${COLORS.bold}  MULTI-AGENT CHAT - Axon  ${COLORS.dim}[${quality.toUpperCase()} quality]${COLORS.reset}`);
  console.log(`${COLORS.bold}${'═'.repeat(62)}${COLORS.reset}`);
  console.log(`${COLORS.dim}  Tema:    ${topic}${COLORS.reset}`);
  console.log(`${COLORS.dim}  Agentes: ${agents.join(', ')}${COLORS.reset}`);
  console.log(`${COLORS.dim}  Rondas:  ${rounds}${COLORS.reset}`);
  console.log(`${COLORS.dim}  Modelo:  ${preset.model} | Esfuerzo: ${preset.effort} | Max: ${preset.maxWords} palabras${COLORS.reset}`);
  console.log(`${COLORS.dim}  Chat:    ${CHAT_FILE}${COLORS.reset}`);
  console.log(`${COLORS.bold}${'═'.repeat(62)}${COLORS.reset}\n`);

  // Init chat room
  initChatRoom(topic, agents, quality);

  const globalStart = Date.now();

  for (let round = 1; round <= rounds; round++) {
    console.log(`${COLORS.bold}── Ronda ${round}/${rounds} ${'─'.repeat(46)}${COLORS.reset}\n`);

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const color = colorFor(i);
      const turnStart = Date.now();

      console.log(`${color}${COLORS.bold}  [${agent}]${COLORS.reset} ${COLORS.dim}pensando...${COLORS.reset}`);

      const history = getChatHistory();
      const prompt = buildPrompt(agent, agents, topic, history, round, rounds, preset.maxWords);
      const response = askAgent(agent, prompt, preset);

      // Write to chat room
      appendMessage(agent, response);

      // Show in terminal
      console.log(`${color}${COLORS.bold}  [${agent}]${COLORS.reset} ${COLORS.dim}(${elapsed(turnStart)})${COLORS.reset}`);
      response.split('\n').forEach(line => {
        console.log(`${color}  │ ${COLORS.reset}${line}`);
      });
      console.log('');
    }
  }

  // Final summary
  console.log(`${COLORS.bold}── Generando resumen ejecutivo... ${'─'.repeat(30)}${COLORS.reset}\n`);

  const finalHistory = getChatHistory();
  const summaryPrompt = buildSummaryPrompt(finalHistory, topic);
  const summary = askAgent(agents[0], summaryPrompt, { ...preset, timeout: 600_000 });

  appendMessage('RESUMEN EJECUTIVO', summary);

  console.log(`${COLORS.green}${COLORS.bold}  RESUMEN EJECUTIVO:${COLORS.reset}`);
  summary.split('\n').forEach(line => {
    console.log(`${COLORS.green}  │ ${COLORS.reset}${line}`);
  });

  console.log(`\n${COLORS.bold}${'═'.repeat(62)}${COLORS.reset}`);
  console.log(`${COLORS.dim}  Tiempo total: ${elapsed(globalStart)}${COLORS.reset}`);
  console.log(`${COLORS.dim}  Chat guardado en: ${CHAT_FILE}${COLORS.reset}`);
  console.log(`${COLORS.bold}${'═'.repeat(62)}${COLORS.reset}\n`);
}

main();
