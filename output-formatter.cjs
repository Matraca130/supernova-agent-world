/**
 * Output Formatter — Experto-Resumen
 *
 * Centraliza TODA la escritura de archivos de output.
 * Genera action-items.json, session-report.md, y archiva sesiones.
 */

const fs = require('fs');
const path = require('path');

const CHAT_DIR = __dirname;
const SESSIONS_DIR = path.join(CHAT_DIR, 'sessions');
const ACTION_ITEMS_FILE = path.join(SESSIONS_DIR, 'action-items.json');
const SESSION_REPORT_FILE = path.join(SESSIONS_DIR, 'session-report.md');

// Ensure sessions dir exists
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/**
 * Extrae action items de checkpoints y mergea con existentes
 * @param {import('./SessionTypes.cjs').Checkpoint[]} checkpoints
 * @param {string} sessionId
 * @returns {import('./SessionTypes.cjs').ActionItem[]}
 */
function formatActionItems(checkpoints, sessionId) {
  // Load existing items
  let existing = [];
  try {
    if (fs.existsSync(ACTION_ITEMS_FILE)) {
      existing = JSON.parse(fs.readFileSync(ACTION_ITEMS_FILE, 'utf-8'));
    }
  } catch {}

  // Mark old 'new' items as 'pending'
  for (const item of existing) {
    if (item.status === 'new') item.status = 'pending';
  }

  // Escalate items pending 3+ sessions
  for (const item of existing) {
    if (item.status === 'pending' && item.sessionsPending >= 3 && item.priority !== 'P0') {
      item.priority = 'P0';
      item.escalated = true;
    }
    if (item.status === 'pending') {
      item.sessionsPending = (item.sessionsPending || 1) + 1;
    }
  }

  // Extract new accionables from checkpoints
  const newActions = [];
  const actionCounts = {};

  for (const cp of checkpoints) {
    if (!cp.accionable) continue;
    for (const action of cp.accionable) {
      const key = action.toLowerCase().trim();
      actionCounts[key] = (actionCounts[key] || { text: action, agents: [], count: 0 });
      actionCounts[key].count++;
      if (!actionCounts[key].agents.includes(cp.agentName)) {
        actionCounts[key].agents.push(cp.agentName);
      }
    }
  }

  // Deduplicate against existing
  const existingTexts = existing.map(e => e.description.toLowerCase().trim());
  let nextId = existing.length + 1;

  for (const [key, data] of Object.entries(actionCounts)) {
    // Skip if already exists (simple substring match)
    const isDuplicate = existingTexts.some(et => et.includes(key.slice(0, 30)) || key.includes(et.slice(0, 30)));
    if (isDuplicate) continue;

    // Priority by mention count
    let priority = 'P2';
    if (data.count >= 3) priority = 'P0';
    else if (data.count >= 2) priority = 'P1';

    newActions.push({
      id: `mac-${String(nextId++).padStart(3, '0')}`,
      description: data.text,
      status: 'new',
      createdSession: sessionId,
      closedBy: null,
      priority,
      assignedAgent: data.agents[0] || 'arquitecto',
      mentionedBy: data.agents,
      sessionsPending: 0,
    });
  }

  const allItems = [...existing, ...newActions];
  fs.writeFileSync(ACTION_ITEMS_FILE, JSON.stringify(allItems, null, 2), 'utf-8');

  return allItems;
}

/**
 * Genera el reporte de sesión en markdown
 * @param {Object} params
 */
function formatReport({ actionItems, checkpoints, metrics, competences, sessionId, topic, duration }) {
  const newItems = actionItems.filter(i => i.createdSession === sessionId);
  const pendingItems = actionItems.filter(i => i.status === 'pending');
  const doneItems = actionItems.filter(i => i.status === 'done');
  const escalated = actionItems.filter(i => i.escalated);

  const structured = checkpoints.filter(c => c.structured);

  let report = `# Session Report — ${sessionId}
> Fecha: ${new Date().toLocaleString()}
> Tema: ${topic}
> Duracion: ${Math.floor(duration / 60000)}m ${Math.floor((duration % 60000) / 1000)}s

---

## Action Items

| ID | Descripcion | Status | Prioridad | Agente | Sesiones |
|----|-------------|--------|-----------|--------|----------|
`;

  for (const item of actionItems) {
    const statusIcon = item.status === 'done' ? '✓' : item.status === 'new' ? '★' : item.escalated ? '⚠' : '○';
    report += `| ${item.id} | ${item.description.slice(0, 60)} | ${statusIcon} ${item.status} | ${item.priority} | ${item.assignedAgent} | ${item.sessionsPending || 0} |\n`;
  }

  report += `\n**Resumen:** ${newItems.length} nuevos, ${pendingItems.length} pendientes, ${doneItems.length} cerrados`;
  if (escalated.length) report += `, ${escalated.length} escalados a P0`;

  report += `\n\n## Checkpoints\n\n`;
  report += `- Estructurados: ${structured.length}/${checkpoints.length}\n`;

  if (structured.length > 0) {
    report += `\n### Consenso global\n`;
    const allConsenso = structured.flatMap(c => c.consenso);
    const unique = [...new Set(allConsenso)];
    unique.slice(0, 10).forEach(c => { report += `- ${c}\n`; });

    report += `\n### Divergencias\n`;
    const allDiv = structured.flatMap(c => c.divergencias);
    [...new Set(allDiv)].slice(0, 10).forEach(d => { report += `- ${d}\n`; });

    report += `\n### Preguntas abiertas\n`;
    const allQ = structured.flatMap(c => c.preguntas);
    [...new Set(allQ)].slice(0, 10).forEach(q => { report += `- ${q}\n`; });
  }

  if (competences) {
    report += `\n## Competencias de Agentes\n\n`;
    report += `| Agente | EaseFactor | Dominios |\n|--------|------------|----------|\n`;
    for (const [name, comp] of Object.entries(competences)) {
      report += `| ${name} | ${comp.easeFactor.toFixed(2)} | ${comp.domains.join(', ')} |\n`;
    }
  }

  report += `\n---\n*Generado automaticamente por Multi-Agent Chat v3*\n`;

  fs.writeFileSync(SESSION_REPORT_FILE, report, 'utf-8');
  return report;
}

/**
 * Archiva los archivos de sala de la sesión actual
 */
function archiveSession(sessionId) {
  const archiveDir = path.join(SESSIONS_DIR, sessionId);
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  const filesToArchive = ['sala-estrategia.md', 'sala-implementacion.md', 'sintesis-final.md', 'prompts-de-accion.md'];
  for (const f of filesToArchive) {
    const src = path.join(CHAT_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(archiveDir, f));
    }
  }
}

module.exports = {
  formatActionItems,
  formatReport,
  archiveSession,
  ACTION_ITEMS_FILE,
  SESSION_REPORT_FILE,
};
