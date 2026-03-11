/**
 * Git Tracker — Experto-Organizador
 *
 * Matchea commits de git con action items para cerrarlos automáticamente.
 * Busca tags [mac-XXX] en commit messages y también hace fuzzy matching
 * por similitud de texto.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ACTION_ITEMS_FILE = path.join(__dirname, 'sessions', 'action-items.json');

/**
 * Obtiene commits recientes desde una fecha
 * @param {string} since - ISO date (YYYY-MM-DD)
 * @param {string} [cwd] - working directory
 * @returns {Array<{hash: string, message: string, date: string}>}
 */
function getRecentCommits(since, cwd) {
  const repoDir = cwd || path.join(__dirname, '..');
  try {
    const raw = execSync(
      `git log --since="${since}" --pretty=format:"%H|||%s|||%ai" --no-merges`,
      { cwd: repoDir, encoding: 'utf-8', shell: true }
    );
    if (!raw.trim()) return [];
    return raw.trim().split('\n').map(line => {
      const [hash, message, date] = line.split('|||');
      return { hash: hash.trim(), message: message.trim(), date: date.trim() };
    });
  } catch {
    return [];
  }
}

/**
 * Extrae tags [mac-XXX] de un commit message
 * @param {string} message
 * @returns {string[]}
 */
function extractTags(message) {
  const matches = message.match(/\[mac-\d{3,}\]/gi);
  if (!matches) return [];
  return matches.map(m => m.replace(/[[\]]/g, '').toLowerCase());
}

/**
 * Similitud simple entre dos strings (Jaccard sobre palabras)
 * @param {string} a
 * @param {string} b
 * @returns {number} 0-1
 */
function textSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Intenta cerrar action items basado en commits recientes
 * @param {string} [since] - fecha desde (default: 7 días atrás)
 * @returns {{ closed: string[], matched: Array<{itemId: string, commit: string}> }}
 */
function matchCommitsToActions(since) {
  const sinceDate = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const commits = getRecentCommits(sinceDate);

  let items = [];
  try {
    if (fs.existsSync(ACTION_ITEMS_FILE)) {
      items = JSON.parse(fs.readFileSync(ACTION_ITEMS_FILE, 'utf-8'));
    }
  } catch {
    return { closed: [], matched: [] };
  }

  const closed = [];
  const matched = [];

  for (const commit of commits) {
    // 1. Exact tag match [mac-XXX]
    const tags = extractTags(commit.message);
    for (const tag of tags) {
      const item = items.find(i => i.id === tag && i.status !== 'done');
      if (item) {
        item.status = 'done';
        item.closedBy = commit.hash.slice(0, 7);
        closed.push(item.id);
        matched.push({ itemId: item.id, commit: commit.hash.slice(0, 7) });
      }
    }

    // 2. Fuzzy match for open items
    for (const item of items) {
      if (item.status === 'done') continue;
      if (closed.includes(item.id)) continue;

      const sim = textSimilarity(commit.message, item.description);
      if (sim >= 0.4) {
        item.status = 'done';
        item.closedBy = commit.hash.slice(0, 7);
        item.matchConfidence = parseFloat(sim.toFixed(3));
        closed.push(item.id);
        matched.push({ itemId: item.id, commit: commit.hash.slice(0, 7), similarity: sim });
      }
    }
  }

  if (closed.length > 0) {
    fs.writeFileSync(ACTION_ITEMS_FILE, JSON.stringify(items, null, 2), 'utf-8');
  }

  return { closed, matched };
}

module.exports = {
  getRecentCommits,
  extractTags,
  textSimilarity,
  matchCommitsToActions,
};
