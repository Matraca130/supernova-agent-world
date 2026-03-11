/**
 * Vector Store local usando Ollama + mxbai-embed-large
 *
 * Almacena memorias como embeddings agrupados por categoria:
 * - ideas, decisiones, conclusiones, pendientes, arquitectura
 *
 * Busca por similitud semantica — solo devuelve lo relevante.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const STORE_FILE = path.join(__dirname, 'vectors.json');
const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'mxbai-embed-large';

// ── Ollama API ──────────────────────────────────────────────────────────
function getEmbedding(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: MODEL, input: text });

    const req = http.request(
      `${OLLAMA_URL}/api/embed`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.embeddings && parsed.embeddings[0]) {
              resolve(parsed.embeddings[0]);
            } else {
              reject(new Error('No embedding in response: ' + body.slice(0, 200)));
            }
          } catch (e) {
            reject(new Error('Parse error: ' + e.message));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Vector math ─────────────────────────────────────────────────────────
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── Store operations ────────────────────────────────────────────────────
function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    }
  } catch {}
  return { entries: [] };
}

function saveStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store), 'utf-8');
}

/**
 * Agrega una memoria al store
 * @param {string} text - El texto de la memoria
 * @param {string} category - ideas | decisiones | conclusiones | pendientes | arquitectura
 * @param {object} metadata - { session, date, topic, agent }
 */
async function addMemory(text, category, metadata = {}) {
  const store = loadStore();
  const embedding = await getEmbedding(text);

  store.entries.push({
    id: store.entries.length + 1,
    text,
    category,
    metadata: { ...metadata, timestamp: new Date().toISOString() },
    embedding,
  });

  saveStore(store);
  return store.entries.length;
}

/**
 * Busca memorias relevantes por similitud semantica
 * @param {string} query - La pregunta o tema a buscar
 * @param {number} topK - Cuantos resultados devolver (default: 5)
 * @param {string} category - Filtrar por categoria (opcional)
 * @returns {Array<{text, category, metadata, score}>}
 */
async function searchMemories(query, topK = 5, category = null) {
  const store = loadStore();
  if (!store.entries.length) return [];

  const queryEmbedding = await getEmbedding(query);

  let entries = store.entries;
  if (category) {
    entries = entries.filter(e => e.category === category);
  }

  const scored = entries.map(entry => ({
    text: entry.text,
    category: entry.category,
    metadata: entry.metadata,
    score: cosineSimilarity(queryEmbedding, entry.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Devuelve un resumen formateado de memorias relevantes para inyectar en un prompt
 */
async function getRelevantContext(query, topK = 5) {
  const results = await searchMemories(query, topK);
  if (!results.length) return '';

  let context = '## Memorias relevantes de sesiones anteriores:\n\n';
  for (const r of results) {
    const score = (r.score * 100).toFixed(0);
    const cat = r.category.toUpperCase();
    const date = r.metadata.date || '';
    context += `**[${cat}]** (${date}, relevancia: ${score}%)\n${r.text}\n\n`;
  }
  return context;
}

/**
 * Stats del store
 */
function getStats() {
  const store = loadStore();
  const cats = {};
  for (const e of store.entries) {
    cats[e.category] = (cats[e.category] || 0) + 1;
  }
  return { total: store.entries.length, categories: cats };
}

// ── CLI mode ────────────────────────────────────────────────────────────
async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'add') {
    const text = args[1];
    const category = args[2] || 'ideas';
    const meta = { session: 'manual', date: new Date().toLocaleDateString() };
    const id = await addMemory(text, category, meta);
    console.log(`Memoria #${id} guardada en [${category}]`);
  } else if (cmd === 'search') {
    const query = args[1];
    const topK = parseInt(args[2]) || 5;
    const results = await searchMemories(query, topK);
    console.log(`\nResultados para: "${query}"\n`);
    for (const r of results) {
      console.log(`  [${r.category}] (${(r.score * 100).toFixed(1)}%) ${r.text.slice(0, 100)}...`);
    }
  } else if (cmd === 'stats') {
    const stats = getStats();
    console.log(`Total memorias: ${stats.total}`);
    console.log('Por categoria:', stats.categories);
  } else if (cmd === 'context') {
    const query = args[1];
    const ctx = await getRelevantContext(query);
    console.log(ctx || 'Sin memorias relevantes.');
  } else {
    console.log('Uso:');
    console.log('  node vector-store.cjs add "texto" [categoria]');
    console.log('  node vector-store.cjs search "query" [topK]');
    console.log('  node vector-store.cjs context "query"');
    console.log('  node vector-store.cjs stats');
    console.log('\nCategorias: ideas, decisiones, conclusiones, pendientes, arquitectura');
  }
}

if (require.main === module) {
  cli().catch(err => { console.error('Error:', err.message); process.exit(1); });
}

module.exports = { addMemory, searchMemories, getRelevantContext, getStats };
