/**
 * Strategy Genome v1 — Global evolutionary strategy for debate agents
 * ADR-010: Strategy Genome (ADR-009 Capa 2)
 *
 * 5 genes [0,1] with noisy gradient descent mutation (lr=0.05).
 * Global genome (shared by all agents) in v1. Per-agent in v2.
 *
 * Produced in debate-003 (consensus 6/6, quality 49/50).
 * Wired in orchestrator-engine.cjs (block 3.67) and prompt-builder.cjs (L278-286).
 */

const fs = require('fs');
const path = require('path');

// ── Constants ──────────────────────────────────────────────────────────
const GENOME_FILE = path.join(__dirname, 'strategy-genomes.json');
const HISTORY_FILE = path.join(__dirname, 'genome-history.json');
const GENOME_VERSION = 1;
const LEARNING_RATE = 0.05;
const NOISE_SCALE = 0.02;
const BOUNDS = { min: 0.05, max: 0.95 };
const BASELINE = 0.5;
const EMA_ALPHA = 0.3;
const MAX_HISTORY = 20;
const ROLLBACK_THRESHOLD = 0.25;
const ROLLBACK_WINDOW = 3;
const ENTROPY_FLOOR_VARIANCE = 0.05;
const LR_DECAY = 0.01; // Inverse decay rate: lr / (1 + LR_DECAY * generation)
const DRIFT_THRESHOLD = 0.15; // Max allowed deviation of gene mean from BASELINE

// ── Gene definitions ───────────────────────────────────────────────────
const GENE_DEFINITIONS = {
  argumentDepth: {
    description: 'Depth of reasoning chains',
    qualityDimensions: ['concreteness', 'structuredThought'],
    baseline: BASELINE,
  },
  adversarialIntensity: {
    description: 'Aggressiveness of counter-arguments',
    qualityDimensions: ['argumentQuality'],
    baseline: BASELINE,
  },
  concisenessPreference: {
    description: 'Preference for shorter, focused responses',
    qualityDimensions: ['relevance'],
    baseline: BASELINE,
  },
  explorationRate: {
    description: 'Tendency to introduce novel ideas',
    qualityDimensions: ['novelty'],
    baseline: BASELINE,
  },
  collaborationBias: {
    description: 'Tendency to build on others vs. challenge',
    qualityDimensions: ['argumentQuality'],
    baseline: BASELINE,
    invertGradient: true,
  },
  decompositionAffinity: {
    description: 'Preference for topic decomposition into micro-debates vs monolithic debate',
    qualityDimensions: ['decompositionQuality', 'relevance'],
    baseline: BASELINE,
  },
};

const GENE_NAMES = Object.keys(GENE_DEFINITIONS);

// ── Default genome factory ─────────────────────────────────────────────
function createDefaultGenome() {
  const genes = {};
  for (const name of GENE_NAMES) {
    genes[name] = GENE_DEFINITIONS[name].baseline;
  }
  return {
    version: GENOME_VERSION,
    genes,
    fitnessEMA: null,
    generation: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ── Validation ─────────────────────────────────────────────────────────
function validateGenome(genome) {
  if (!genome || typeof genome !== 'object') return false;
  if (genome.version !== GENOME_VERSION) return false;
  if (!genome.genes || typeof genome.genes !== 'object') return false;
  for (const name of GENE_NAMES) {
    const val = genome.genes[name];
    if (typeof val !== 'number' || val < 0 || val > 1 || isNaN(val)) return false;
  }
  return true;
}

// ── Load genome (with validation + fallback) ───────────────────────────
function loadGenome() {
  try {
    if (fs.existsSync(GENOME_FILE)) {
      const raw = fs.readFileSync(GENOME_FILE, 'utf8');
      const genome = JSON.parse(raw);
      if (validateGenome(genome)) {
        return genome;
      }
      console.warn('[strategy-genome] Invalid genome file, using defaults');
    }
  } catch (err) {
    console.warn(`[strategy-genome] Failed to load: ${err.message}`);
  }
  return createDefaultGenome();
}

// ── Save genome (atomic write: tmp + rename) ───────────────────────────
function saveGenome(genome) {
  if (!validateGenome(genome)) {
    throw new Error('[strategy-genome] Cannot save invalid genome');
  }
  // Deep copy to avoid mutating frozen/shared genome objects
  const toSave = JSON.parse(JSON.stringify(genome));
  toSave.updatedAt = new Date().toISOString();
  const tmpFile = GENOME_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(toSave, null, 2), 'utf8');
  fs.renameSync(tmpFile, GENOME_FILE);
}

// ── Deep freeze (prevents accidental mutation during debate) ───────────
function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object' && obj[key] !== null && !Object.isFrozen(obj[key])) {
        deepFreeze(obj[key]);
      }
    }
  }
  return obj;
}

// ── Clamp helper ───────────────────────────────────────────────────────
function clamp(val) {
  if (typeof val !== 'number' || isNaN(val)) {
    console.warn('[strategy-genome] NaN/invalid detected in clamp, using BASELINE');
    return BASELINE;
  }
  return Math.max(BOUNDS.min, Math.min(BOUNDS.max, val));
}

// ── Noisy gradient descent mutation ────────────────────────────────────
/**
 * Mutates a genome based on quality signals using noisy gradient descent.
 * Supports per-gene gradient via GENE_DEFINITIONS.qualityDimensions mapping.
 * Returns a NEW genome (deep copy). Original is NOT modified.
 *
 * @param {object} genome - Current genome
 * @param {object|number} qualitySignals - Object with quality dimensions {concreteness, argumentQuality, relevance, novelty, structuredThought} or scalar [0,1] for backward compat
 * @param {object} [options]
 * @param {number} [options.lr] - Learning rate override (default: 0.05)
 * @param {function} [options.noiseFn] - Noise function for testing
 * @param {boolean} [options.hasHumanRating] - Whether the fitness comes from human rating (1.5x lr boost)
 * @returns {object} New mutated genome
 */
function mutateGenome(genome, fitnessScore, options = {}) {
  const { lr = LEARNING_RATE, noiseFn = null, hasHumanRating = false } = options;

  // Deep copy
  const newGenome = JSON.parse(JSON.stringify(genome));

  // Handle fitnessScore as object vs scalar
  let overallFitness = 0.5;
  const isObject = typeof fitnessScore === 'object' && fitnessScore !== null;
  
  if (isObject) {
    const vals = Object.values(fitnessScore);
    overallFitness = vals.length > 0 ? vals.reduce((a,b)=>a+b, 0) / vals.length : 0.5;
  } else if (typeof fitnessScore === 'number') {
    overallFitness = fitnessScore;
  }

  // Update fitness EMA
  if (newGenome.fitnessEMA === null) {
    newGenome.fitnessEMA = overallFitness;
  } else {
    newGenome.fitnessEMA = EMA_ALPHA * overallFitness + (1 - EMA_ALPHA) * newGenome.fitnessEMA;
  }

  // Effective learning rate: higher for human ratings (more trusted signal)
  // Inverse decay: lr decreases as genome matures for convergence stability
  const baseLr = hasHumanRating ? lr * 1.5 : lr;
  const effectiveLr = baseLr / (1 + LR_DECAY * (genome.generation || 0));

  // Mutate each gene
  for (const name of GENE_NAMES) {
    let geneGradient = overallFitness - 0.5;
    
    // Per-gene gradient if we have specific signals mapping to its dimensions
    if (isObject && GENE_DEFINITIONS[name].qualityDimensions) {
      let sum = 0;
      let count = 0;
      for (const dim of GENE_DEFINITIONS[name].qualityDimensions) {
        if (fitnessScore[dim] !== undefined && !isNaN(fitnessScore[dim])) {
          sum += fitnessScore[dim];
          count++;
        }
      }
      if (count > 0) {
        geneGradient = (sum / count) - 0.5;
      }
    }

    // Invert gradient for genes marked with invertGradient (e.g. collaborationBias)
    if (GENE_DEFINITIONS[name].invertGradient) {
      geneGradient = -geneGradient;
    }

    const noise = noiseFn ? noiseFn() : (Math.random() - 0.5) * NOISE_SCALE * 2;
    const delta = geneGradient * effectiveLr + noise;
    newGenome.genes[name] = clamp(newGenome.genes[name] + delta);
  }

  // Entropy floor: if variance too low, inject diversity
  const values = GENE_NAMES.map(n => newGenome.genes[n]);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  if (variance < ENTROPY_FLOOR_VARIANCE) {
    // Push genes away from mean
    for (const name of GENE_NAMES) {
      const direction = newGenome.genes[name] >= mean ? 1 : -1;
      newGenome.genes[name] = clamp(newGenome.genes[name] + direction * 0.03);
    }
  }

  // Mean drift detector: if overall mean drifts too far from BASELINE, push back
  if (Math.abs(mean - BASELINE) > DRIFT_THRESHOLD) {
    for (const name of GENE_NAMES) {
      const driftCorrection = (BASELINE - newGenome.genes[name]) * 0.1;
      newGenome.genes[name] = clamp(newGenome.genes[name] + driftCorrection);
    }
  }

  newGenome.generation++;
  newGenome.updatedAt = new Date().toISOString();
  return newGenome;
}

// ── Rollback: reset if 3 consecutive bad debates ───────────────────────
/**
 * Checks if genome should be rolled back based on recent fitness history.
 * Returns a reset genome if rollback is needed, null otherwise.
 *
 * @param {object} genome - Current genome
 * @returns {object|null} Reset genome or null
 */
function rollbackGenome(genome) {
  try {
    const history = loadHistory();
    if (history.length < ROLLBACK_WINDOW) return null;

    const recent = history.slice(-ROLLBACK_WINDOW);
    const allBad = recent.every(h => h.fitness < ROLLBACK_THRESHOLD);

    if (allBad) {
      console.warn('[strategy-genome] ROLLBACK: 3 consecutive bad debates. Resetting to defaults.');
      const reset = createDefaultGenome();
      reset.generation = genome.generation + 1;
      return reset;
    }
  } catch (err) {
    console.warn(`[strategy-genome] Rollback check failed: ${err.message}`);
  }
  return null;
}

// ── Phenotype expression (genome → prompt instructions) ────────────────
/**
 * Converts genome genes into natural language instructions for the agent.
 * Uses 3-level mapping: conservative [0, 0.33], neutral [0.33, 0.66], aggressive [0.66, 1.0].
 *
 * @param {object} genome - Current genome
 * @param {string} [defaultInstructions] - DIALOGUE_FRAME for the role (used in neutral range)
 * @returns {string} Prompt section with phenotype instructions
 */
function expressGenome(genome, defaultInstructions) {
  if (!genome || !genome.genes) return '';

  const instructions = [];

  // argumentDepth
  const ad = genome.genes.argumentDepth;
  if (ad < 0.33) {
    instructions.push('Sé conciso en tu razonamiento. Máximo 2 pasos lógicos por argumento.');
  } else if (ad > 0.66) {
    instructions.push('Profundiza tu razonamiento. Usa cadenas de 4+ pasos lógicos con evidencia en cada paso.');
  }

  // adversarialIntensity
  const ai = genome.genes.adversarialIntensity;
  if (ai < 0.33) {
    instructions.push('Sé diplomático. Busca puntos de acuerdo antes de objetar.');
  } else if (ai > 0.66) {
    instructions.push('Sé AGRESIVAMENTE crítico. Cuestiona CADA premisa. No concedas sin evidencia fuerte.');
  }

  // concisenessPreference
  const cp = genome.genes.concisenessPreference;
  if (cp < 0.33) {
    instructions.push('Desarrolla tus ideas con detalle extenso y ejemplos múltiples.');
  } else if (cp > 0.66) {
    instructions.push('Sé EXTREMADAMENTE conciso. Cada oración debe aportar información nueva.');
  }

  // explorationRate
  const er = genome.genes.explorationRate;
  if (er < 0.33) {
    instructions.push('Enfócate en refinar ideas existentes. No introduzcas temas nuevos.');
  } else if (er > 0.66) {
    instructions.push('Introduce ideas NOVEDOSAS que nadie haya mencionado. Busca conexiones inesperadas.');
  }

  // collaborationBias
  const cb = genome.genes.collaborationBias;
  if (cb < 0.33) {
    instructions.push('Trabaja INDEPENDIENTEMENTE. Formula tu propia posición sin depender de otros.');
  } else if (cb > 0.66) {
    instructions.push('CONSTRUYE activamente sobre ideas de otros. Cita y extiende argumentos previos.');
  }

  // If all genes are neutral and we have default instructions, use those
  if (instructions.length === 0 && defaultInstructions) {
    return `\nESTRATEGIA DE DEBATE (genoma neutral, frame del rol):\n${defaultInstructions}\n`;
  }

  if (instructions.length === 0) return '';

  return `\nESTRATEGIA DE DEBATE (genoma gen-${genome.generation || 0}):\n${instructions.join('\n')}\n`;
}

// ── History management ─────────────────────────────────────────────────
function appendHistory(entry) {
  try {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
    history.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    // Keep only last MAX_HISTORY entries
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }
    const tmpFile = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(tmpFile, HISTORY_FILE);
  } catch (err) {
    console.warn(`[strategy-genome] Failed to append history: ${err.message}`);
  }
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (!Array.isArray(raw)) return [];
      // Filter out entries with invalid/missing fitness (stale format protection)
      return raw.filter(h => typeof h.fitness === 'number' && !isNaN(h.fitness));
    }
  } catch (err) {
    console.warn(`[strategy-genome] Failed to load history: ${err.message}`);
  }
  return [];
}

// ── Stats ──────────────────────────────────────────────────────────────
function getGenomeStats() {
  const genome = loadGenome();
  const history = loadHistory();
  const values = GENE_NAMES.map(n => genome.genes[n]);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;

  return {
    version: genome.version,
    generation: genome.generation,
    genes: { ...genome.genes },
    fitnessEMA: genome.fitnessEMA,
    mean: parseFloat(mean.toFixed(4)),
    variance: parseFloat(variance.toFixed(4)),
    historyLength: history.length,
    lastUpdate: genome.updatedAt,
    phenotypePreview: expressGenome(genome).slice(0, 200),
  };
}

// ── Exports ────────────────────────────────────────────────────────────
module.exports = {
  loadGenome,
  saveGenome,
  validateGenome,
  mutateGenome,
  expressGenome,
  getGenomeStats,
  rollbackGenome,
  appendHistory,
  loadHistory,
  deepFreeze,
  createDefaultGenome,
  // Expose constants for testing
  GENE_NAMES,
  GENE_DEFINITIONS,
  LEARNING_RATE,
  BOUNDS,
};
