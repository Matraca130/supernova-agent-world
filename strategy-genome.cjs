/**
 * Strategy Genome — ADR-009 Capa 2
 *
 * Evolutionary strategy parameters for debate agents.
 * Global genome (v1) with 5 genes mapped to quality-gate dimensions.
 * Mutates post-debate via noisy gradient descent with EMA baseline.
 *
 * Security invariants:
 *   - Object.freeze (deep) during debate
 *   - Gene bounds [0, 1] enforced on every mutation
 *   - Atomic write (tmp + rename) for persistence
 *   - Schema validation on load (NaN, missing genes, out-of-bounds)
 */

const fs = require('fs');
const path = require('path');

// --- Paths ---
const GENOME_PATH = path.join(__dirname, 'strategy-genome.json');
const GENOME_TMP = GENOME_PATH + '.tmp';
const HISTORY_PATH = path.join(__dirname, 'genome-history.json');
const HISTORY_TMP = HISTORY_PATH + '.tmp';

// --- Constants ---
const MAX_HISTORY = 20;
const ENTROPY_FLOOR = 0.05;
const MEAN_DRIFT_THRESHOLD = 0.25;
const EMA_ALPHA = 0.3;

const REQUIRED_GENES = [
  'argumentDepth',
  'adversarialIntensity',
  'concisenessPreference',
  'evidenceWeight',
  'crossReferenceFrequency',
];

const GENE_DIMENSION_MAP = {
  argumentDepth: 'concreteness',
  adversarialIntensity: 'argumentQuality',
  concisenessPreference: 'relevance',
  evidenceWeight: 'concreteness',
  crossReferenceFrequency: 'argumentQuality',
};

const DEFAULT_EMA = { concreteness: 0.5, argumentQuality: 0.5, relevance: 0.5 };

const DEFAULT_GENOME = {
  version: 1,
  genes: {
    argumentDepth: 0.5,
    adversarialIntensity: 0.5,
    concisenessPreference: 0.5,
    evidenceWeight: 0.5,
    crossReferenceFrequency: 0.5,
  },
  _ema: { ...DEFAULT_EMA },
};

// --- Deep Freeze ---
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

// --- Schema Validation ---
function validateGenome(genome) {
  if (!genome || typeof genome !== 'object') return false;
  if (!genome.genes || typeof genome.genes !== 'object') return false;
  for (const gene of REQUIRED_GENES) {
    const val = genome.genes[gene];
    if (typeof val !== 'number' || isNaN(val) || val < 0 || val > 1) return false;
  }
  return true;
}

// --- Load / Save ---
function loadGenome() {
  try {
    if (fs.existsSync(GENOME_PATH)) {
      const raw = fs.readFileSync(GENOME_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Version migration: v1 without _ema
      if (parsed.version < 2 && !parsed._ema) {
        parsed._ema = { ...DEFAULT_EMA };
      }
      if (validateGenome(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('[strategy-genome] loadGenome failed:', err.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_GENOME));
}

function saveGenome(genome) {
  const data = JSON.stringify(genome, null, 2);
  fs.writeFileSync(GENOME_TMP, data, 'utf8');
  fs.renameSync(GENOME_TMP, GENOME_PATH);
}

// --- EMA Update ---
function updateEMA(ema, fitnessSignals) {
  const newEMA = { ...ema };
  for (const dim of Object.keys(DEFAULT_EMA)) {
    if (typeof fitnessSignals[dim] === 'number') {
      newEMA[dim] = EMA_ALPHA * fitnessSignals[dim] + (1 - EMA_ALPHA) * (ema[dim] || 0.5);
    }
  }
  return newEMA;
}

// --- Mutation ---
function mutateGenome(genome, fitnessSignals, options = {}) {
  const { lr = 0.05, noiseFn = Math.random } = options;
  const ema = genome._ema || DEFAULT_EMA;
  const newGenes = { ...genome.genes };

  for (const [gene, dimension] of Object.entries(GENE_DIMENSION_MAP)) {
    const signal = fitnessSignals[dimension];
    if (typeof signal !== 'number') continue;
    const baseline = ema[dimension] || 0.5;
    const gradient = signal - baseline;
    const noise = (noiseFn() - 0.5) * lr;
    newGenes[gene] = Math.max(0, Math.min(1, newGenes[gene] + gradient * lr + noise));
  }

  // Entropy floor: if variance too low, inject extra noise
  const values = Object.values(newGenes);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  if (variance < ENTROPY_FLOOR) {
    for (const gene of Object.keys(newGenes)) {
      newGenes[gene] = Math.max(0, Math.min(1, newGenes[gene] + (noiseFn() - 0.5) * lr * 2));
    }
  }

  // Mean drift detector: pull toward center if drifting
  const postMean = Object.values(newGenes).reduce((a, b) => a + b, 0) / values.length;
  const drift = Math.abs(postMean - 0.5);
  if (drift > MEAN_DRIFT_THRESHOLD) {
    const correction = (0.5 - postMean) * 0.1;
    for (const gene of Object.keys(newGenes)) {
      newGenes[gene] = Math.max(0, Math.min(1, newGenes[gene] + correction));
    }
  }

  const newEMA = updateEMA(ema, fitnessSignals);

  return {
    version: genome.version,
    genes: newGenes,
    _ema: newEMA,
  };
}

// --- Phenotype Expression ---
function expressGenome(genome) {
  if (!genome || !genome.genes) return '';
  const g = genome.genes;
  const lines = [];
  if (g.argumentDepth > 0.6) lines.push('Profundiza tus argumentos con cadenas de razonamiento de 3+ pasos.');
  if (g.argumentDepth < 0.4) lines.push('Se directo y conciso en tus argumentos.');
  if (g.adversarialIntensity > 0.6) lines.push('Desafia activamente las posiciones de otros agentes. Busca debilidades.');
  if (g.adversarialIntensity < 0.4) lines.push('Busca consenso y construye sobre ideas ajenas.');
  if (g.concisenessPreference > 0.6) lines.push('Se conciso. Elimina redundancias. Cada oracion debe aportar valor nuevo.');
  if (g.concisenessPreference < 0.4) lines.push('Desarrolla tus ideas con detalle y ejemplos extensos.');
  if (g.evidenceWeight > 0.6) lines.push('Incluye evidencia concreta: numeros, archivos, lineas de codigo.');
  if (g.crossReferenceFrequency > 0.6) lines.push('Referencia explicitamente a otros agentes por nombre. Responde a sus puntos.');
  return lines.length > 0 ? '\nESTRATEGIA GENETICA:\n' + lines.join('\n') + '\n' : '';
}

// --- History ---
function appendHistory(genome, fitnessSignals) {
  let history = [];
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      if (!Array.isArray(history)) history = [];
    }
  } catch { history = []; }

  history.push({
    timestamp: new Date().toISOString(),
    genes: { ...genome.genes },
    fitness: fitnessSignals,
    _ema: genome._ema ? { ...genome._ema } : null,
  });

  // Rotate: keep last MAX_HISTORY entries
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }

  const data = JSON.stringify(history, null, 2);
  fs.writeFileSync(HISTORY_TMP, data, 'utf8');
  fs.renameSync(HISTORY_TMP, HISTORY_PATH);
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch {}
  return [];
}

module.exports = {
  DEFAULT_GENOME,
  GENE_DIMENSION_MAP,
  REQUIRED_GENES,
  ENTROPY_FLOOR,
  MEAN_DRIFT_THRESHOLD,
  EMA_ALPHA,
  deepFreeze,
  validateGenome,
  loadGenome,
  saveGenome,
  updateEMA,
  mutateGenome,
  expressGenome,
  appendHistory,
  loadHistory,
};
