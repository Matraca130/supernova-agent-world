#!/usr/bin/env node
/**
 * Analyze Bias — Experto-Quiz
 *
 * Analiza métricas de sesiones para detectar sesgos:
 * - Speaking order bias: ¿agentes que hablan primero reciben más atención?
 * - Dominance bias: ¿algún agente monopoliza las ideas?
 * - Novelty decay: ¿la novedad cae con las rondas?
 *
 * Uso: node analyze-bias.cjs [metrics.jsonl]
 */

const fs = require('fs');
const path = require('path');

const METRICS_FILE = process.argv[2] || path.join(__dirname, 'sessions', 'metrics.jsonl');

function loadMetrics() {
  try {
    if (!fs.existsSync(METRICS_FILE)) return [];
    return fs.readFileSync(METRICS_FILE, 'utf-8')
      .trim().split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Correlación de Pearson entre dos arrays
 */
function pearsonCorrelation(x, y) {
  const n = x.length;
  if (n < 3) return { r: 0, significant: false };

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (den === 0) return { r: 0, significant: false };

  const r = num / den;
  // Simple significance: |r| > 0.5 with n >= 5
  return { r: parseFloat(r.toFixed(3)), significant: Math.abs(r) > 0.5 && n >= 5 };
}

function analyzeSpeakingOrderBias(turns) {
  if (turns.length < 5) return null;

  const orders = turns.map(t => t.speakingOrder || 0);
  const composites = turns.map(t => t.qualityScore?.composite || t.composite || 0.5);

  const corr = pearsonCorrelation(orders, composites);

  return {
    name: 'Speaking Order Bias',
    correlation: corr.r,
    significant: corr.significant,
    interpretation: corr.significant
      ? (corr.r > 0 ? '⚠ Agentes que hablan después tienden a recibir scores más altos' : '⚠ Agentes que hablan primero reciben scores más altos')
      : '✓ No se detecta sesgo significativo por orden de habla',
    samples: turns.length,
  };
}

function analyzeDominanceBias(turns) {
  const agentActions = {};
  for (const t of turns) {
    const agent = t.agent || t.agentName;
    if (!agent) continue;
    if (!agentActions[agent]) agentActions[agent] = { totalActions: 0, turns: 0 };
    agentActions[agent].turns++;
    agentActions[agent].totalActions += (t.actionItems || 0);
  }

  const entries = Object.entries(agentActions);
  if (entries.length < 2) return null;

  const avgActions = entries.map(([, d]) => d.totalActions / d.turns);
  const maxRatio = Math.max(...avgActions) / (Math.min(...avgActions) || 0.1);

  const dominant = entries.sort((a, b) => (b[1].totalActions / b[1].turns) - (a[1].totalActions / a[1].turns))[0];

  return {
    name: 'Dominance Bias',
    maxRatio: parseFloat(maxRatio.toFixed(2)),
    significant: maxRatio > 3,
    dominantAgent: dominant[0],
    interpretation: maxRatio > 3
      ? `⚠ ${dominant[0]} produce ${maxRatio.toFixed(1)}x más action items que el promedio`
      : '✓ Distribución de contribuciones relativamente equilibrada',
    agents: Object.fromEntries(entries.map(([name, d]) => [name, parseFloat((d.totalActions / d.turns).toFixed(2))])),
  };
}

function analyzeNoveltyDecay(turns) {
  const byRound = {};
  for (const t of turns) {
    const round = t.round || 0;
    if (!byRound[round]) byRound[round] = [];
    const novelty = t.qualityScore?.novelty || t.novelty;
    if (novelty !== undefined) byRound[round].push(novelty);
  }

  const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);
  if (rounds.length < 2) return null;

  const avgByRound = rounds.map(r => ({
    round: r,
    avgNovelty: parseFloat((byRound[r].reduce((a, b) => a + b, 0) / byRound[r].length).toFixed(3)),
    samples: byRound[r].length,
  }));

  const roundNums = avgByRound.map(r => r.round);
  const novelties = avgByRound.map(r => r.avgNovelty);
  const corr = pearsonCorrelation(roundNums, novelties);

  return {
    name: 'Novelty Decay',
    correlation: corr.r,
    significant: corr.significant,
    byRound: avgByRound,
    interpretation: corr.significant && corr.r < -0.3
      ? '⚠ La novedad decrece significativamente en rondas posteriores — considerar inyectar estímulos'
      : '✓ La novedad se mantiene estable a través de las rondas',
  };
}

// Main
const metrics = loadMetrics();
const turns = metrics.filter(m => m.type === 'turn');

console.log('\n' + '╔' + '═'.repeat(58) + '╗');
console.log('║' + '  Multi-Agent Chat — Análisis de Sesgos'.padEnd(58) + '║');
console.log('╚' + '═'.repeat(58) + '╝');

if (turns.length < 3) {
  console.log('\n⚠ Datos insuficientes. Se necesitan al menos 3 turnos registrados.');
  console.log(`  Encontrados: ${turns.length} turnos en ${METRICS_FILE}`);
  console.log('  Ejecute más sesiones y vuelva a intentar.\n');
  process.exit(0);
}

const analyses = [
  analyzeSpeakingOrderBias(turns),
  analyzeDominanceBias(turns),
  analyzeNoveltyDecay(turns),
].filter(Boolean);

for (const analysis of analyses) {
  console.log(`\n📊 ${analysis.name}`);
  console.log('─'.repeat(50));
  console.log(`  ${analysis.interpretation}`);
  if (analysis.correlation !== undefined) console.log(`  Correlación: ${analysis.correlation}`);
  if (analysis.samples) console.log(`  Muestras: ${analysis.samples}`);
  if (analysis.agents) {
    console.log('  Acción/turno por agente:');
    for (const [name, val] of Object.entries(analysis.agents)) {
      console.log(`    ${name.padEnd(22)} ${val}`);
    }
  }
  if (analysis.byRound) {
    console.log('  Novedad por ronda:');
    for (const r of analysis.byRound) {
      const bar = '█'.repeat(Math.round(r.avgNovelty * 20));
      console.log(`    R${r.round}: ${r.avgNovelty.toFixed(3)} [${bar}] (n=${r.samples})`);
    }
  }
}

console.log('\n' + '─'.repeat(60) + '\n');
