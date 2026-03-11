const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Load API key from .env ---
let OPENAI_API_KEY = '';
try {
  const envPath = path.join(__dirname, '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^OPENAI_API_KEY=(.+)$/m);
  if (match) {
    OPENAI_API_KEY = match[1].trim().replace(/^["']|["']$/g, '');
  }
} catch (err) {
  console.error('[embeddings] Failed to read .env file:', err.message);
}

// --- Storage paths ---
const STORAGE_PATH = path.join(__dirname, 'embeddings.json');
const STORAGE_TMP_PATH = STORAGE_PATH + '.tmp';

// --- In-memory state ---
let store = {
  embeddings: [],
  stats: { total: 0, byType: {}, byDebate: {}, lastEmbeddedAt: null }
};

// Load existing embeddings.json on startup
try {
  if (fs.existsSync(STORAGE_PATH)) {
    const raw = fs.readFileSync(STORAGE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.embeddings)) {
      store = parsed;
    }
  }
} catch (err) {
  console.error('[embeddings] Failed to load embeddings.json:', err.message);
}

// --- Debounced save ---
let saveTimer = null;
let saveInProgress = false;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (saveInProgress) {
      scheduleSave();
      return;
    }
    saveInProgress = true;
    try {
      const data = JSON.stringify(store, null, 2);
      fs.writeFileSync(STORAGE_TMP_PATH, data, 'utf8');
      fs.renameSync(STORAGE_TMP_PATH, STORAGE_PATH);
    } catch (err) {
      console.error('[embeddings] Failed to save embeddings.json:', err.message);
    } finally {
      saveInProgress = false;
    }
  }, 2000);
}

// --- OpenAI embeddings API call ---
async function callEmbeddingAPI(text) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not found in .env');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// --- Cosine similarity ---
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

// --- Update stats ---
function updateStats(metadata) {
  store.stats.total = store.embeddings.length;
  store.stats.lastEmbeddedAt = new Date().toISOString();

  if (metadata.type) {
    store.stats.byType[metadata.type] = (store.stats.byType[metadata.type] || 0) + 1;
  }
  if (metadata.debateId) {
    store.stats.byDebate[metadata.debateId] = (store.stats.byDebate[metadata.debateId] || 0) + 1;
  }
}

// --- embed(text, metadata) ---
async function embed(text, metadata = {}) {
  const entry = {
    id: crypto.randomUUID(),
    text: String(text).slice(0, 500),
    vector: null,
    metadata: {
      debateId: metadata.debateId || null,
      type: metadata.type || 'message',
      agentName: metadata.agentName || null,
      role: metadata.role || null,
      round: metadata.round != null ? metadata.round : null,
      phase: metadata.phase || null
    },
    createdAt: new Date().toISOString()
  };

  // Fire and forget: launch the API call but don't block the caller
  const promise = (async () => {
    try {
      entry.vector = await callEmbeddingAPI(text);
      store.embeddings.push(entry);
      updateStats(entry.metadata);
      scheduleSave();
    } catch (err) {
      console.error('[embeddings] embed() failed:', err.message);
    }
  })();

  // We intentionally do NOT await `promise` — fire and forget.
  // But we still return the entry reference so the caller has the id.
  // Attach the promise so callers can optionally await it.
  entry._promise = promise;

  return entry;
}

// --- search(query, topK, filters) ---
async function search(query, topK = 5, filters = {}) {
  try {
    const queryVector = await callEmbeddingAPI(query);

    let candidates = store.embeddings.filter(e => e.vector !== null);

    // Apply filters
    if (filters.debateId) {
      candidates = candidates.filter(e => e.metadata.debateId === filters.debateId);
    }
    if (filters.type) {
      candidates = candidates.filter(e => e.metadata.type === filters.type);
    }
    if (filters.agentName) {
      candidates = candidates.filter(e => e.metadata.agentName === filters.agentName);
    }

    // Compute similarity and sort
    const scored = candidates.map(e => ({
      id: e.id,
      text: e.text,
      similarity: cosineSimilarity(queryVector, e.vector),
      metadata: e.metadata
    }));

    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, topK);
  } catch (err) {
    console.error('[embeddings] search() failed:', err.message);
    return [];
  }
}

// --- getStats() ---
function getStats() {
  return {
    total: store.embeddings.length,
    byType: { ...store.stats.byType },
    byDebate: { ...store.stats.byDebate },
    lastEmbeddedAt: store.stats.lastEmbeddedAt
  };
}

// --- Exports ---
module.exports = {
  embed,
  search,
  getStats,
  cosineSimilarity
};
