#!/usr/bin/env node
/**
 * Report — Experto-Organizador
 *
 * Script standalone: `node report.cjs`
 * Genera un reporte rápido del estado actual del sistema multi-agent.
 */

const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const ACTION_ITEMS_FILE = path.join(SESSIONS_DIR, 'action-items.json');
const METRICS_FILE = path.join(SESSIONS_DIR, 'metrics.jsonl');
const COMPETENCE_FILE = path.join(__dirname, 'agent-competence.json');

function loadJSON(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return null;
}

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

function printActionItems() {
  const items = loadJSON(ACTION_ITEMS_FILE);
  if (!items || items.length === 0) {
    console.log('\n📋 Action Items: ninguno\n');
    return;
  }

  const newItems = items.filter(i => i.status === 'new');
  const pending = items.filter(i => i.status === 'pending');
  const done = items.filter(i => i.status === 'done');
  const escalated = items.filter(i => i.escalated);

  console.log('\n📋 Action Items');
  console.log('═'.repeat(60));
  console.log(`  Total: ${items.length} | Nuevos: ${newItems.length} | Pendientes: ${pending.length} | Cerrados: ${done.length}`);
  if (escalated.length) console.log(`  ⚠ Escalados a P0: ${escalated.length}`);

  console.log('\n  Abiertos:');
  for (const item of [...newItems, ...pending]) {
    const icon = item.escalated ? '⚠' : item.status === 'new' ? '★' : '○';
    console.log(`    ${icon} [${item.priority}] ${item.id}: ${item.description.slice(0, 70)}`);
    console.log(`      → Agente: ${item.assignedAgent} | Sesiones: ${item.sessionsPending || 0}`);
  }

  if (done.length > 0) {
    console.log(`\n  Cerrados (últimos 5):`);
    for (const item of done.slice(-5)) {
      console.log(`    ✓ ${item.id}: ${item.description.slice(0, 70)} [${item.closedBy || '?'}]`);
    }
  }
}

function printCompetences() {
  const comp = loadJSON(COMPETENCE_FILE);
  if (!comp) {
    console.log('\n🧠 Competencias: sin datos\n');
    return;
  }

  console.log('\n🧠 Competencias de Agentes');
  console.log('═'.repeat(60));
  const sorted = Object.entries(comp).sort((a, b) => b[1].easeFactor - a[1].easeFactor);
  for (const [name, c] of sorted) {
    const bar = '█'.repeat(Math.round((c.easeFactor - 1.3) / 2.7 * 20));
    const empty = '░'.repeat(20 - bar.length);
    console.log(`  ${name.padEnd(22)} EF:${c.easeFactor.toFixed(2)} [${bar}${empty}] rep:${c.repetitions} int:${c.interval}d`);
    console.log(`${''.padEnd(24)} dominios: ${c.domains.join(', ')}`);
  }
}

function printMetricsSummary() {
  const metrics = loadMetrics();
  if (metrics.length === 0) {
    console.log('\n📊 Métricas: sin datos\n');
    return;
  }

  const sessions = metrics.filter(m => m.type === 'session');
  const turns = metrics.filter(m => m.type === 'turn');

  console.log('\n📊 Métricas');
  console.log('═'.repeat(60));
  console.log(`  Sesiones registradas: ${sessions.length}`);
  console.log(`  Turnos registrados: ${turns.length}`);

  if (sessions.length > 0) {
    const last = sessions[sessions.length - 1];
    console.log(`\n  Última sesión:`);
    console.log(`    ID: ${last.sessionId}`);
    console.log(`    Tema: ${last.topic || '?'}`);
    console.log(`    Duración: ${last.durationMs ? Math.round(last.durationMs / 60000) + 'm' : '?'}`);
  }

  if (turns.length > 0) {
    const agents = {};
    for (const t of turns) {
      if (!agents[t.agent]) agents[t.agent] = { count: 0, totalTime: 0 };
      agents[t.agent].count++;
      agents[t.agent].totalTime += t.durationMs || 0;
    }
    console.log('\n  Participación por agente:');
    for (const [name, data] of Object.entries(agents)) {
      const avgTime = data.totalTime > 0 ? Math.round(data.totalTime / data.count / 1000) + 's' : '?';
      console.log(`    ${name.padEnd(22)} turnos: ${data.count}  avg: ${avgTime}`);
    }
  }
}

function printMemoryStats() {
  const memFile = path.join(__dirname, 'memoria', 'memories.json');
  const data = loadJSON(memFile);
  if (!data || !data.memories) {
    console.log('\n💾 Memoria semántica: sin datos\n');
    return;
  }

  const cats = {};
  for (const m of data.memories) {
    cats[m.category] = (cats[m.category] || 0) + 1;
  }

  console.log('\n💾 Memoria Semántica');
  console.log('═'.repeat(60));
  console.log(`  Total memorias: ${data.memories.length}`);
  for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat}: ${count}`);
  }
}

// Main
console.log('\n' + '╔' + '═'.repeat(58) + '╗');
console.log('║' + '  Multi-Agent Chat — Status Report'.padEnd(58) + '║');
console.log('║' + `  ${new Date().toLocaleString()}`.padEnd(58) + '║');
console.log('╚' + '═'.repeat(58) + '╝');

printActionItems();
printCompetences();
printMetricsSummary();
printMemoryStats();

console.log('\n' + '─'.repeat(60));
console.log('Ejecutar: node multi-agent-chat/report.cjs');
console.log('');
