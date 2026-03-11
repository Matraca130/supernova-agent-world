/**
 * Debate Manager v3 — Fases + Roles Antagonistas + Reglas de Engagement
 *
 * Mejoras sobre v2:
 * - FASES: posiciones → cross-examination → rebuttals → veredicto
 * - Roles antagonistas que naturalmente chocan
 * - Reglas de engagement embebidas en cada debate
 * - Contexto de fase en cada respuesta del tool "decir"
 * - minWordsPerMessage: fuerza respuestas largas y detalladas
 * - Intensidad configurable: casual, moderado, adversarial
 */

const fs = require('fs');
const path = require('path');
const embeddings = require('./embeddings.cjs');

const STATE_FILE = path.join(__dirname, 'debates.json');

let state = {
  debates: {},
  nextId: 1,
};

// ── Persistencia ─────────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // Estado por defecto si corrupto
  }
}

// saveState con debounce: guarda máximo cada 3 segundos para evitar
// escrituras excesivas (audit: 320+ saves por debate)
let _saveTimer = null;
let _savePending = false;

function saveStateNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _savePending = false;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function saveState() {
  _savePending = true;
  if (!_saveTimer) {
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      if (_savePending) {
        _savePending = false;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
      }
    }, 3000);
  }
}

// Flush pendiente al cerrar proceso
process.on('exit', () => { if (_savePending) saveStateNow(); });
process.on('SIGINT', () => { if (_savePending) saveStateNow(); process.exit(); });
process.on('SIGTERM', () => { if (_savePending) saveStateNow(); process.exit(); });

loadState();

// ── Fases de debate ─────────────────────────────────────────────────────

const DEBATE_PHASES = {
  posiciones: {
    name: 'POSICIONES INICIALES',
    desc: 'Cada participante presenta su tesis y posición sobre el tema.',
    instruction: 'Presenta tu posición CLARA y FUERTE. No intentes ser neutral. Toma partido.',
    rounds: [1, 3],  // rondas 1-3
  },
  crossExamination: {
    name: 'CROSS-EXAMINATION',
    desc: 'Haz preguntas directas a otros participantes. Ellos DEBEN responder.',
    instruction: 'Haz 2 PREGUNTAS DIRECTAS a otro participante por nombre. Ataca los puntos débiles de sus argumentos. Exige respuestas concretas, no evasivas.',
    rounds: [4, 6],  // rondas 4-6
  },
  rebuttals: {
    name: 'REBUTTALS',
    desc: 'Responde a las objeciones y defiende tu posición.',
    instruction: 'Responde a CADA objeción que te hicieron. No ignores ninguna. Si no puedes refutar algo, admítelo pero explica por qué tu posición general sigue siendo mejor.',
    rounds: [7, 8],  // rondas 7-8
  },
  veredicto: {
    name: 'VEREDICTO FINAL',
    desc: 'Voto final. Elige la PEOR idea del debate y explica por qué.',
    instruction: 'VOTO FINAL: 1) Nombra la PEOR idea/argumento del debate y por qué. 2) Nombra la MEJOR idea que NO es la tuya. 3) Tu conclusión final en 3 oraciones.',
    rounds: [9, 10], // rondas 9-10
  },
};

/**
 * Calcula la fase actual dado el número de ronda y las fases configuradas
 */
function getCurrentPhase(round, phases) {
  if (!phases || phases.length === 0) return null;
  for (const phase of phases) {
    if (round >= phase.rounds[0] && round <= phase.rounds[1]) {
      return phase;
    }
  }
  // Si pasó de todas las fases, repetir la última
  return phases[phases.length - 1];
}

// ── Roles por categoría (v3 — más antagonistas) ─────────────────────────

const ROLE_TEMPLATES = {
  tecnologia: [
    { role: 'arquitecto-software', desc: 'Diseña la solución técnica ideal sin importar el costo' },
    { role: 'critico-tecnico', desc: 'Encuentra TODOS los fallos y puntos de fallo. DEBE objetar.' },
    { role: 'ship-fast-founder', desc: 'Quiere lanzar MAÑANA. Cada abstracción innecesaria es un enemigo.' },
    { role: 'security-hardliner', desc: 'Nada pasa sin auditoría, encryption, y validación triple.' },
    { role: 'junior-dev-mantenedor', desc: 'Va a mantener esto 2 años. Si no lo entiende, es mala decisión.' },
  ],
  medicina: [
    { role: 'medico-clinico', desc: 'Solo acepta tratamientos con evidencia nivel A.' },
    { role: 'investigador-radical', desc: 'Los tratamientos actuales son insuficientes, propone alternativas.' },
    { role: 'paciente-advocate', desc: 'Si el paciente sufre o no entiende, la solución es MALA.' },
    { role: 'eticista', desc: 'Los límites éticos NO son negociables.' },
    { role: 'cost-optimizer', desc: 'El sistema de salud tiene recursos finitos. Cada dólar cuenta.' },
  ],
  educacion: [
    { role: 'pedagogo-tradicional', desc: 'Los métodos probados funcionan. La innovación sin evidencia es ruido.' },
    { role: 'disruptor-edtech', desc: 'La educación tradicional está rota. Solo la tecnología la salva.' },
    { role: 'estudiante-frustrado', desc: 'Si el estudiante no aprende, el sistema falló. Punto.' },
    { role: 'evaluador-de-datos', desc: 'Solo importan los datos y métricas. Las opiniones no cuentan.' },
    { role: 'inclusivo-radical', desc: 'Si excluye a alguien, no importa qué tan bueno sea: se descarta.' },
  ],
  negocios: [
    { role: 'ceo-agresivo', desc: 'Market share primero. La rentabilidad viene después.' },
    { role: 'cfo-conservador', desc: 'Si no hay ROI claro en 6 meses, NO se hace.' },
    { role: 'head-of-product', desc: 'El usuario es todo. Métricas de satisfacción > métricas financieras.' },
    { role: 'devils-advocate', desc: 'DEBE encontrar fallos en CADA argumento. No puede estar de acuerdo.' },
    { role: 'operaciones', desc: 'Si no se puede ejecutar con el equipo actual en 3 meses, es fantasía.' },
  ],
  diseno: [
    { role: 'ux-purist', desc: 'Si no pasó user testing con 5+ usuarios, no se implementa.' },
    { role: 'visual-maximalist', desc: 'La estética y la emoción venden. Los datos son fríos.' },
    { role: 'developer-realista', desc: 'Si tarda más de 2 sprints en implementar, se simplifica.' },
    { role: 'accesibilidad-radical', desc: 'WCAG AAA o se rechaza. Sin excepciones.' },
    { role: 'product-growth', desc: 'Solo importa conversión y retención. Bonito pero inútil = basura.' },
  ],
  general: [
    { role: 'defensor', desc: 'Argumenta A MUERTE a favor. No concede NADA al oponente.' },
    { role: 'devils-advocate', desc: 'DEBE encontrar fallos en TODO. Prohibido estar de acuerdo.' },
    { role: 'mediador-provocador', desc: 'Busca consenso pero haciendo preguntas INCÓMODAS a todos.' },
    { role: 'visionario-extremo', desc: 'Las soluciones conservadoras son el problema. Solo vale lo radical.' },
    { role: 'realista-implacable', desc: 'Si no existe HOY y no funciona HOY, es ciencia ficción.' },
  ],
};

// ── Reglas de engagement por intensidad ──────────────────────────────────

const INTENSITY_RULES = {
  casual: {
    name: 'Casual',
    rules: [
      'Comparte tu perspectiva de forma natural.',
      'Puedes estar de acuerdo o en desacuerdo libremente.',
    ],
    minWords: 50,
  },
  moderado: {
    name: 'Moderado',
    rules: [
      'Cada mensaje debe incluir al menos 1 punto de desacuerdo con otro participante.',
      'No uses "estoy de acuerdo" sin un "pero..." significativo.',
      'Respuestas mínimo 100 palabras con argumentos concretos.',
    ],
    minWords: 100,
  },
  adversarial: {
    name: 'ADVERSARIAL',
    rules: [
      'PROHIBIDO estar de acuerdo sin contraargumento primero.',
      'Cada mensaje DEBE incluir mínimo 1 OBJECIÓN DIRECTA a otro participante (por nombre).',
      'Si 2 participantes coinciden, el tercero DEBE argumentar en contra.',
      'No uses "coincido", "de acuerdo", o "buen punto" sin un "PERO..." sustancial.',
      'Ataca IDEAS, no personas. Pero ataca SIN PIEDAD.',
      'Si no encuentras un fallo en el argumento del otro, explica por qué tu alternativa es SUPERIOR.',
      'Respuestas mínimo 150 palabras con evidencia o razonamiento concreto.',
    ],
    minWords: 150,
  },
};

/**
 * Detecta la categoría del tema y sugiere roles
 */
function suggestRoles(topic) {
  const t = topic.toLowerCase();

  if (/\b(código|software|programar|api|ia|inteligencia artificial|tech|app|web|database|cloud|devops|machine learning|ai|backend|frontend|deploy|server|docker|redis|supabase)\b/.test(t)) {
    return { category: 'tecnologia', roles: ROLE_TEMPLATES.tecnologia };
  }
  if (/\b(médic|salud|hospital|paciente|tratamiento|diagnóstico|farmac|enfermedad|clínic|anatomía|cirugía)\b/.test(t)) {
    return { category: 'medicina', roles: ROLE_TEMPLATES.medicina };
  }
  if (/\b(educa|enseñ|apren|escuela|universidad|curso|estudi|pedagog|formación|capacitación)\b/.test(t)) {
    return { category: 'educacion', roles: ROLE_TEMPLATES.educacion };
  }
  if (/\b(negocio|empresa|startup|mercado|venta|cliente|roi|revenue|profit|inversión|strategy)\b/.test(t)) {
    return { category: 'negocios', roles: ROLE_TEMPLATES.negocios };
  }
  if (/\b(diseñ|ux|ui|interfaz|prototip|figma|layout|visual|branding|wireframe)\b/.test(t)) {
    return { category: 'diseno', roles: ROLE_TEMPLATES.diseno };
  }

  return { category: 'general', roles: ROLE_TEMPLATES.general };
}

// ── Operaciones ──────────────────────────────────────────────────────────

/**
 * Crea un debate con fases, roles antagonistas, e intensidad configurable
 */
function createDebate(topic, maxRounds = 10, customRoles = null, intensity = 'adversarial', customRules = null) {
  const id = `debate-${String(state.nextId++).padStart(3, '0')}`;
  const suggested = suggestRoles(topic);
  const intensityConfig = INTENSITY_RULES[intensity] || INTENSITY_RULES.adversarial;

  // Calcular fases basadas en maxRounds
  let phases = [];
  if (maxRounds >= 8) {
    // Debate largo: fases completas
    const quarter = Math.floor(maxRounds / 4);
    phases = [
      { ...DEBATE_PHASES.posiciones, rounds: [1, quarter] },
      { ...DEBATE_PHASES.crossExamination, rounds: [quarter + 1, quarter * 2] },
      { ...DEBATE_PHASES.rebuttals, rounds: [quarter * 2 + 1, quarter * 3] },
      { ...DEBATE_PHASES.veredicto, rounds: [quarter * 3 + 1, maxRounds] },
    ];
  } else if (maxRounds >= 4) {
    // Debate medio: 3 fases
    const third = Math.floor(maxRounds / 3);
    phases = [
      { ...DEBATE_PHASES.posiciones, rounds: [1, third] },
      { ...DEBATE_PHASES.crossExamination, rounds: [third + 1, third * 2] },
      { ...DEBATE_PHASES.veredicto, rounds: [third * 2 + 1, maxRounds] },
    ];
  } else if (maxRounds > 0) {
    // Debate corto: sin fases
    phases = [
      { ...DEBATE_PHASES.posiciones, rounds: [1, maxRounds] },
    ];
  }
  // maxRounds === 0 (continuo): fases por default de DEBATE_PHASES

  // minExchanges: cuántas veces debe hablar cada agente por ronda antes de avanzar
  // adversarial = 2 (posición + réplica), moderado = 1, casual = 1
  const minExchangesMap = { ADVERSARIAL: 2, Moderado: 1, Casual: 1 };

  const debate = {
    id,
    topic,
    status: 'active',
    category: suggested.category,
    suggestedRoles: customRoles || suggested.roles,
    participants: [],
    messages: [],
    currentRound: 1,
    maxRounds,         // 0 = modo continuo
    autoAdvance: true,
    spokenThisRound: [],
    exchangeCount: {},  // { participantName: numExchanges }
    minExchangesPerRound: minExchangesMap[intensityConfig.name] || 1,
    intensity: intensityConfig.name,
    rules: customRules || intensityConfig.rules,
    minWords: intensityConfig.minWords,
    phases: maxRounds === 0 ? Object.values(DEBATE_PHASES) : phases,
    createdAt: new Date().toISOString(),
    synthesis: null,
  };

  state.debates[id] = debate;
  saveStateNow(); // Crítico: nuevo debate debe persistir inmediatamente
  return debate;
}

/**
 * Un participante se une al debate con un rol.
 * AUTO-REDISTRIBUCIÓN: Si hay agentes virtuales (agente-*) con roles,
 * y un participante REAL llega, un agente virtual le cede su rol y se va.
 */
function joinDebate(debateId, name, role = null) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };
  if (debate.status === 'finished') return { error: 'Debate ya terminó' };

  // Evitar duplicados
  const existing = debate.participants.find(p => p.name === name);
  if (existing) return { participant: existing, debate, alreadyJoined: true };

  // ── AUTO-REDISTRIBUCIÓN ──────────────────────────────────────────
  // Si el que llega NO es un agente virtual, y hay agentes virtuales,
  // transferir un rol de un agente virtual al nuevo participante.
  const isVirtual = name.startsWith('agente-');
  let replacedAgent = null;

  if (!isVirtual) {
    // Buscar agentes virtuales que puedan ceder su rol
    const virtualAgents = debate.participants.filter(p => p.name.startsWith('agente-'));

    if (virtualAgents.length > 0) {
      // Si el nuevo quiere un rol específico, buscar el virtual que lo tiene
      let donor = null;
      if (role) {
        donor = virtualAgents.find(p => p.role === role);
      }
      // Si no pidió rol específico, o no hay virtual con ese rol, tomar cualquier virtual
      if (!donor) {
        // Preferir virtuales que no hayan hablado mucho
        donor = virtualAgents.sort((a, b) => {
          const aMsgs = debate.messages.filter(m => m.participantName === a.name).length;
          const bMsgs = debate.messages.filter(m => m.participantName === b.name).length;
          return aMsgs - bMsgs;
        })[0];
      }

      if (donor) {
        const transferredRole = donor.role;
        replacedAgent = { name: donor.name, role: donor.role };

        // Eliminar al agente virtual
        debate.participants = debate.participants.filter(p => p.name !== donor.name);

        // Limpiar del tracking de rondas
        debate.spokenThisRound = (debate.spokenThisRound || []).filter(n => n !== donor.name);
        if (debate.exchangeCount) delete debate.exchangeCount[donor.name];

        // Asignar el rol transferido
        role = role || transferredRole;
      }
    }
  }

  // Si no eligió rol (y no hubo transferencia), asignar uno disponible
  let assignedRole = role;
  if (!assignedRole && debate.suggestedRoles) {
    const takenRoles = debate.participants.map(p => p.role);
    const available = debate.suggestedRoles.find(r => !takenRoles.includes(r.role));
    assignedRole = available ? available.role : 'participante';
  }
  if (!assignedRole) assignedRole = 'participante';

  // Verificar si el rol ya está tomado (post-redistribución)
  const roleTaken = debate.participants.find(p => p.role === assignedRole);
  if (roleTaken && assignedRole !== 'participante') {
    const takenRoles = debate.participants.map(p => p.role);
    const available = (debate.suggestedRoles || [])
      .filter(r => !takenRoles.includes(r.role))
      .map(r => r.role);
    return {
      error: `El rol "${assignedRole}" ya está tomado por ${roleTaken.name}. Roles disponibles: ${available.join(', ') || 'participante'}`,
    };
  }

  const participant = {
    id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    role: assignedRole,
    isVirtual,
    joinedAt: new Date().toISOString(),
  };
  debate.participants.push(participant);
  saveState();

  return {
    participant,
    debate,
    alreadyJoined: false,
    replacedAgent, // null si no hubo redistribución
  };
}

// ── Knowledge Base (Banco de Conocimiento) ──────────────────────────────
// Permite inyectar FUENTES (código, docs, datos, SQL, etc.) al debate.
// Los agentes usan estas fuentes como evidencia — no inventan.

/**
 * Agrega contexto/fuente al banco de conocimiento del debate.
 * Puede ser código, SQL, documentación, datos, etc.
 */
function addContext(debateId, source, content, category = 'general') {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };

  if (!debate.knowledgeBase) debate.knowledgeBase = [];

  const entry = {
    id: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source,       // "backend/auth.ts", "tabla: users", "doc: arquitectura", etc.
    content,      // El contenido real
    category,     // "codigo", "sql", "doc", "datos", "config"
    addedAt: new Date().toISOString(),
    wordCount: content.trim().split(/\s+/).length,
  };

  debate.knowledgeBase.push(entry);
  saveState();

  return {
    entry,
    totalSources: debate.knowledgeBase.length,
    totalWords: debate.knowledgeBase.reduce((acc, e) => acc + e.wordCount, 0),
  };
}

/**
 * Lee el banco de conocimiento del debate
 */
function getKnowledgeBase(debateId) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };

  const kb = debate.knowledgeBase || [];
  return {
    debateId,
    sources: kb.map(e => ({
      id: e.id,
      source: e.source,
      category: e.category,
      wordCount: e.wordCount,
      preview: e.content.slice(0, 200) + (e.content.length > 200 ? '...' : ''),
    })),
    totalSources: kb.length,
    totalWords: kb.reduce((acc, e) => acc + e.wordCount, 0),
  };
}

/**
 * Obtiene el contenido completo de una fuente del KB
 */
function getKnowledgeSource(debateId, sourceId) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };

  const kb = debate.knowledgeBase || [];
  const entry = kb.find(e => e.id === sourceId || e.source === sourceId);
  if (!entry) return { error: `Fuente "${sourceId}" no encontrada` };

  return entry;
}

/**
 * Un participante dice algo en el debate
 * ENFORCE: minWords, minExchanges por ronda
 */
function say(debateId, participantName, text, _skipSave = false) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };
  if (debate.status === 'finished') return { error: 'Debate ya terminó' };

  // ── ENFORCE: Mínimo de palabras ──────────────────────────────────
  const wordCount = text.trim().split(/\s+/).length;
  const minWords = debate.minWords || 100;
  if (wordCount < minWords) {
    return {
      error: `MENSAJE RECHAZADO: ${wordCount} palabras. Mínimo requerido: ${minWords}. Tu mensaje debe ser más detallado, incluir argumentos concretos, y objeciones directas a otros participantes. NO seas superficial.`,
      wordCount,
      minWords,
      rejected: true,
    };
  }

  // Auto-join si no está registrado
  let participant = debate.participants.find(p => p.name === participantName);
  if (!participant) {
    const joinResult = joinDebate(debateId, participantName);
    if (joinResult.error) return joinResult;
    participant = joinResult.participant;
  }

  // Verificar exchanges esta ronda
  if (!debate.spokenThisRound) debate.spokenThisRound = [];
  if (!debate.exchangeCount) debate.exchangeCount = {};

  const myExchanges = debate.exchangeCount[participantName] || 0;
  const minExchanges = debate.minExchangesPerRound || 1;
  const alreadySpoke = debate.spokenThisRound.includes(participantName);

  const message = {
    participantId: participant.id,
    participantName,
    participantRole: participant.role,
    text,
    wordCount,
    timestamp: new Date().toISOString(),
    round: debate.currentRound,
    phase: getCurrentPhase(debate.currentRound, debate.phases)?.name || null,
  };
  debate.messages.push(message);

  // Incrementar exchange count
  debate.exchangeCount[participantName] = myExchanges + 1;

  // Marcar como "habló" solo si cumple minExchanges
  if (!alreadySpoke && (myExchanges + 1) >= minExchanges) {
    debate.spokenThisRound.push(participantName);
  }

  // Calcular quién falta
  const pending = debate.participants
    .filter(p => !debate.spokenThisRound.includes(p.name))
    .map(p => {
      const exch = debate.exchangeCount[p.name] || 0;
      return `${p.name} (${p.role}) [${exch}/${minExchanges} exchanges]`;
    });

  // Auto-avance: solo cuando TODOS cumplieron minExchanges
  let autoAdvanced = false;
  if (debate.autoAdvance && debate.participants.length > 1 && pending.length === 0) {
    if (debate.maxRounds > 0 && debate.currentRound >= debate.maxRounds) {
      debate.status = 'finished';
      autoAdvanced = true;
    } else {
      debate.currentRound++;
      debate.spokenThisRound = [];
      debate.exchangeCount = {}; // Reset exchanges para nueva ronda
      autoAdvanced = true;
    }
  }

  const currentPhase = getCurrentPhase(debate.currentRound, debate.phases);

  if (!_skipSave) saveState();

  return {
    message,
    totalMessages: debate.messages.length,
    round: debate.currentRound,
    wordCount,
    alreadySpoke,
    exchangesThisRound: (debate.exchangeCount[participantName] || 0),
    minExchanges,
    pendingParticipants: pending,
    allSpoke: pending.length === 0,
    autoAdvanced,
    status: debate.status,
    currentPhase: currentPhase ? currentPhase.name : null,
    phaseInstruction: currentPhase ? currentPhase.instruction : null,
    rules: debate.rules || [],
    intensity: debate.intensity || 'moderado',
  };
}

/**
 * Lee el historial del debate con roles, turnos y fases
 */
function read(debateId, sinceIndex = 0, limit = 0) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };

  // Audit fix: paginación para debates largos
  let messages = debate.messages.slice(sinceIndex);
  const totalAvailable = messages.length;
  if (limit > 0) {
    messages = messages.slice(-limit); // Últimos N mensajes
  }
  const currentPhase = getCurrentPhase(debate.currentRound, debate.phases);

  let formatted = `# ${debate.topic}\n`;
  formatted += `Categoría: ${debate.category || 'general'} | Intensidad: ${debate.intensity || 'moderado'} | Estado: ${debate.status}\n`;
  formatted += `Ronda: ${debate.currentRound}/${debate.maxRounds || '∞'}`;
  if (currentPhase) {
    formatted += ` | FASE: ${currentPhase.name}`;
  }
  formatted += '\n';

  if (debate.rules && debate.rules.length > 0) {
    formatted += `\nREGLAS DE ENGAGEMENT:\n`;
    debate.rules.forEach((r, i) => { formatted += `  ${i + 1}. ${r}\n`; });
  }

  formatted += `\nParticipantes:\n`;
  for (const p of debate.participants) {
    const spoke = (debate.spokenThisRound || []).includes(p.name) ? '✓' : '⏳';
    formatted += `  ${spoke} ${p.name} — ${p.role}\n`;
  }
  formatted += '\n';

  let currentRound = 0;
  for (const msg of messages) {
    if (msg.round > currentRound) {
      const phase = getCurrentPhase(msg.round, debate.phases);
      const phaseTag = phase ? ` [${phase.name}]` : '';
      formatted += `\n═══ RONDA ${msg.round}${phaseTag} ═══\n\n`;
      currentRound = msg.round;
    }
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const roleTag = msg.participantRole ? ` [${msg.participantRole}]` : '';
    formatted += `[${time}] **${msg.participantName}**${roleTag}:\n${msg.text}\n\n---\n\n`;
  }

  const pending = debate.participants
    .filter(p => !(debate.spokenThisRound || []).includes(p.name))
    .map(p => `${p.name} (${p.role})`);

  if (debate.status === 'active' && pending.length > 0) {
    formatted += `\n⏳ Esperando: ${pending.join(', ')}\n`;
  }

  if (currentPhase && debate.status === 'active') {
    formatted += `\n📌 FASE ACTUAL: ${currentPhase.name}\n`;
    formatted += `   Instrucción: ${currentPhase.instruction}\n`;
  }

  return {
    debate: {
      id: debate.id,
      topic: debate.topic,
      status: debate.status,
      category: debate.category,
      intensity: debate.intensity,
      currentRound: debate.currentRound,
      maxRounds: debate.maxRounds,
      participantCount: debate.participants.length,
      messageCount: debate.messages.length,
      currentPhase: currentPhase ? currentPhase.name : null,
    },
    messages,
    formatted,
    newMessages: messages.length,
    totalMessages: debate.messages.length,
    totalAvailable,
    truncated: limit > 0 && totalAvailable > limit,
    pendingParticipants: pending,
    rules: debate.rules || [],
    phaseInstruction: currentPhase ? currentPhase.instruction : null,
  };
}

/**
 * Avanza ronda con verificación
 */
function nextRound(debateId, force = false) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };

  if (!force && debate.participants.length > 0) {
    const pending = debate.participants
      .filter(p => !(debate.spokenThisRound || []).includes(p.name))
      .map(p => `${p.name} (${p.role})`);

    if (pending.length > 0) {
      return {
        error: `No todos han hablado esta ronda. Faltan: ${pending.join(', ')}. Usa force=true para forzar el avance.`,
        pending,
      };
    }
  }

  if (debate.maxRounds > 0 && debate.currentRound >= debate.maxRounds) {
    debate.status = 'finished';
    debate.spokenThisRound = [];
    debate.exchangeCount = {};
    saveState();
    return { finished: true, round: debate.currentRound };
  }

  debate.currentRound++;
  debate.spokenThisRound = [];
  debate.exchangeCount = {};
  const newPhase = getCurrentPhase(debate.currentRound, debate.phases);
  saveState();
  return {
    finished: false,
    round: debate.currentRound,
    phase: newPhase ? newPhase.name : null,
    phaseInstruction: newPhase ? newPhase.instruction : null,
  };
}

/**
 * Finaliza un debate con síntesis
 */
function finishDebate(debateId, synthesis = null) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };

  debate.status = 'finished';
  if (synthesis) debate.synthesis = synthesis;
  saveStateNow(); // Crítico: cierre de debate debe persistir inmediatamente

  // Auto-embed toda la sesión al finalizar (fire & forget)
  (async () => {
    try {
      // Embed cada mensaje
      for (const msg of debate.messages) {
        await embeddings.embed(msg.text, {
          debateId,
          type: 'message',
          agentName: msg.participantName,
          role: msg.participantRole,
          round: msg.round,
          phase: msg.phase,
        });
      }
      // Embed knowledge base entries
      if (debate.knowledgeBase) {
        for (const kb of debate.knowledgeBase) {
          await embeddings.embed(kb.content, {
            debateId,
            type: 'context',
            agentName: kb.source,
            role: kb.category,
          });
        }
      }
      // Embed synthesis
      if (synthesis) {
        await embeddings.embed(synthesis, {
          debateId,
          type: 'synthesis',
          agentName: 'system',
          role: 'synthesis',
        });
      }
      console.error(`[embeddings] Sesión ${debateId} embeddeada: ${debate.messages.length} msgs + ${(debate.knowledgeBase || []).length} KB + ${synthesis ? 1 : 0} synthesis`);
    } catch (err) {
      console.error(`[embeddings] Error embeddeando sesión ${debateId}:`, err.message);
    }
  })();

  const mdPath = path.join(__dirname, `debate-mcp-${debateId}.md`);
  const result = read(debateId);
  let md = result.formatted;
  if (synthesis) md += `\n\n## Síntesis\n\n${synthesis}\n`;
  fs.writeFileSync(mdPath, md, 'utf-8');

  return { debate, savedTo: mdPath };
}

/**
 * Lista todos los debates
 */
function listDebates() {
  return Object.values(state.debates).map(d => ({
    id: d.id,
    topic: d.topic,
    status: d.status,
    category: d.category || 'general',
    intensity: d.intensity || 'moderado',
    participants: d.participants.map(p => `${p.name} (${p.role})`),
    messageCount: d.messages.length,
    currentRound: d.currentRound,
    maxRounds: d.maxRounds,
    currentPhase: getCurrentPhase(d.currentRound, d.phases)?.name || null,
    createdAt: d.createdAt,
  }));
}

/**
 * Obtiene el debate activo más reciente
 */
function getActiveDebate() {
  const active = Object.values(state.debates)
    .filter(d => d.status === 'active')
    .sort((a, b) => {
      const diff = new Date(b.createdAt) - new Date(a.createdAt);
      if (diff !== 0) return diff;
      // Tiebreaker: higher numeric ID = more recent
      const aNum = parseInt(a.id.replace(/\D/g, ''), 10) || 0;
      const bNum = parseInt(b.id.replace(/\D/g, ''), 10) || 0;
      return bNum - aNum;
    });
  return active[0] || null;
}

// ── Sub-Agent Orchestration ──────────────────────────────────────────────
// Permite que UNA sola IA (ej: Figma Make) controle múltiples "sub-agentes"
// El servidor le dice "ahora eres X, habla como X" en cada turno.

/**
 * Crea un debate auto-orquestado con N sub-agentes virtuales
 * La IA que llama este tool debe role-play como cada agente en secuencia.
 */
// ── Roles genéricos expandibles para debates con 6+ agentes ──────────
const GENERIC_EXTRA_ROLES = [
  { role: 'analista-datos', desc: 'Solo confía en datos medibles. Las opiniones sin datos son ruido.' },
  { role: 'estratega-largo-plazo', desc: 'Piensa en 3-5 años. Las soluciones cortoplacistas son trampas.' },
  { role: 'abogado-usuario-final', desc: 'Si el usuario final sufre o no entiende, toda la solución es MALA.' },
  { role: 'optimizador-costos', desc: 'Cada recurso tiene un costo. Si no es cost-effective, se rechaza.' },
  { role: 'innovador-disruptivo', desc: 'Las soluciones conservadoras perpetúan problemas. Solo vale lo radical.' },
  { role: 'integrador-sistemas', desc: 'Todo debe funcionar JUNTO. Si rompe otra cosa, no es solución.' },
  { role: 'historiador-lecciones', desc: 'Busca precedentes. Si ya se intentó y falló, exige explicar qué cambió.' },
  { role: 'simplificador', desc: 'Si no se puede explicar en 2 minutos, es demasiado complejo. Simplifica.' },
  { role: 'escéptico-metódico', desc: 'NADA se acepta sin evidencia. Cada afirmación requiere prueba.' },
  { role: 'visionario-futuro', desc: 'La tecnología cambia rápido. ¿Esto seguirá siendo relevante en 3 años?' },
];

function autoDebate(topic, numAgents = 3, maxRounds = 10, intensity = 'adversarial') {
  // Audit fix: cap subido de 5 a 15
  numAgents = Math.max(2, Math.min(15, numAgents));
  const debate = createDebate(topic, maxRounds, null, intensity);

  // Auto-registrar N agentes con roles del template
  const roles = debate.suggestedRoles || [];
  const baseRoleCount = roles.length; // Capturar ANTES de push extras
  const agents = [];
  for (let i = 0; i < Math.min(numAgents, baseRoleCount); i++) {
    const agentName = `agente-${roles[i].role}`;
    const result = joinDebate(debate.id, agentName, roles[i].role);
    if (!result.error) {
      agents.push({
        name: agentName,
        role: roles[i].role,
        desc: roles[i].desc,
      });
    }
  }

  // Audit fix: si hay más agentes que roles, usar roles genéricos expandibles
  // Cada uno tiene sufijo numérico único para evitar conflictos
  for (let i = baseRoleCount; i < numAgents; i++) {
    const extraIdx = i - baseRoleCount;
    const extraRole = GENERIC_EXTRA_ROLES[extraIdx % GENERIC_EXTRA_ROLES.length];
    const roleName = `${extraRole.role}-${extraIdx + 1}`;
    const agentName = `agente-${roleName}`;
    debate.suggestedRoles.push({ role: roleName, desc: extraRole.desc });
    const result = joinDebate(debate.id, agentName, roleName);
    if (!result.error) {
      agents.push({
        name: agentName,
        role: roleName,
        desc: extraRole.desc,
      });
    }
  }

  return {
    debate,
    agents,
    firstTurn: getNextTurn(debate.id),
  };
}

/**
 * Devuelve el próximo turno: quién debe hablar, su rol, contexto y fase.
 * Audit fix: ahora es wrapper de getAllPendingTurns() para eliminar duplicación.
 */
function getNextTurn(debateId) {
  const allPending = getAllPendingTurns(debateId);

  // Propagar errores, finished, allSpoke directamente
  if (allPending.error || allPending.finished || allPending.allSpoke) {
    return allPending;
  }

  // Tomar solo el primer turno pendiente
  const firstTurn = allPending.turns[0];
  const debate = state.debates[debateId];

  return {
    finished: false,
    debateId,
    round: allPending.round,
    maxRounds: allPending.maxRounds,
    totalParticipants: allPending.totalParticipants,
    spokenThisRound: allPending.totalParticipants - allPending.pendingCount,
    remainingThisRound: allPending.pendingCount,

    // Quién debe hablar ahora
    agent: firstTurn.agent,

    // Fase y reglas
    phase: allPending.phase,
    phaseInstruction: allPending.phaseInstruction,
    rules: allPending.rules,
    intensity: allPending.intensity,

    // Contexto
    recentMessages: allPending.recentMessages,
    mentionsMe: firstTurn.mentionsMe,
    otherParticipants: firstTurn.otherParticipants,
    topic: allPending.topic,

    // Instrucción de role-play
    rolePlayPrompt: firstTurn.rolePlayPrompt,
  };
}

/**
 * Construye un prompt detallado para que la IA haga role-play
 */
/**
 * Construye el string de KB compartido (para evitar duplicarlo N veces en paralelo)
 */
function buildSharedKBString(debate) {
  const kb = debate.knowledgeBase || [];
  if (kb.length === 0) return '';
  let kbStr = `\n📚 BANCO DE CONOCIMIENTO (${kb.length} fuentes disponibles):\n`;
  kbStr += `DEBES basar tus argumentos en estas fuentes. NO inventes datos.\n\n`;
  kb.forEach((entry, i) => {
    kbStr += `── FUENTE ${i + 1}: ${entry.source} [${entry.category}] ──\n`;
    kbStr += entry.content.slice(0, 500) + (entry.content.length > 500 ? '\n[...truncado, usa "consultar_fuente" para ver completo]' : '');
    kbStr += '\n\n';
  });
  kbStr += `REGLA: Cita fuentes específicas cuando argumentes. Ej: "Según FUENTE 2 (auth.ts), la línea X muestra que..."\n`;
  return kbStr;
}

function buildRolePlayPrompt(participant, phase, debate, mentionsMe, sharedKBString) {
  let prompt = `AHORA ERES: "${participant.name}" con rol "${participant.role}".\n`;
  prompt += `Tu perspectiva: ${(debate.suggestedRoles || []).find(r => r.role === participant.role)?.desc || participant.role}\n\n`;

  prompt += `TEMA: ${debate.topic}\n`;
  prompt += `RONDA: ${debate.currentRound}/${debate.maxRounds || '∞'}\n`;

  if (phase) {
    prompt += `\nFASE: ${phase.name}\nINSTRUCCIÓN DE FASE: ${phase.instruction}\n`;
  }

  if (debate.rules && debate.rules.length > 0) {
    prompt += `\nREGLAS QUE DEBES SEGUIR:\n`;
    debate.rules.forEach((r, i) => { prompt += `${i + 1}. ${r}\n`; });
  }

  if (mentionsMe && mentionsMe.length > 0) {
    prompt += `\n⚠️ TE MENCIONARON DIRECTAMENTE — DEBES RESPONDER:\n`;
    mentionsMe.forEach(m => {
      prompt += `  ${m.from}: "${m.text.slice(0, 150)}..."\n`;
    });
  }

  // ── Knowledge Base: inyectar fuentes como evidencia ──────────
  // Si se pasa sharedKBString (modo paralelo), lo usa en vez de reconstruirlo
  const kb = debate.knowledgeBase || [];
  if (kb.length > 0) {
    if (sharedKBString) {
      prompt += sharedKBString;
    } else {
      prompt += buildSharedKBString(debate);
    }
  }

  prompt += `\nINSTRUCCIONES CRÍTICAS (VIOLAR = MENSAJE RECHAZADO):\n`;
  prompt += `- MÍNIMO ${debate.minWords || 150} PALABRAS o el servidor RECHAZA tu mensaje automáticamente\n`;
  prompt += `- Habla SOLO desde la perspectiva de "${participant.role}"\n`;
  prompt += `- NO seas neutral. DEFIENDE tu posición con convicción\n`;
  prompt += `- Si alguien te contradijo, RESPONDE directamente con contraargumentos\n`;
  prompt += `- Incluye al menos 1 OBJECIÓN DIRECTA a otro participante (por nombre)\n`;
  if (kb.length > 0) {
    prompt += `- CITA FUENTES del banco de conocimiento — NO inventes datos\n`;
  } else {
    prompt += `- Incluye EVIDENCIA: código, SQL, datos, o razonamiento técnico concreto\n`;
  }
  prompt += `- NUNCA rompas el personaje\n`;
  prompt += `- Tu respuesta debe ser SUSTANCIAL — un párrafo no es suficiente\n`;

  prompt += `\nDespués de generar tu respuesta, usa "decir" con nombre="${participant.name}" y tu mensaje.`;
  prompt += `\nLuego llama "turno" para saber quién habla después.`;

  return prompt;
}

/**
 * Devuelve TODOS los turnos pendientes de la ronda actual, en paralelo.
 * Cada turno incluye un rolePlayPrompt completo para que la IA genere
 * todas las respuestas simultáneamente.
 */
function getAllPendingTurns(debateId) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };
  if (debate.status === 'finished') {
    return {
      finished: true,
      debateId,
      totalMessages: debate.messages.length,
      totalRounds: debate.currentRound,
    };
  }

  if (!debate.spokenThisRound) debate.spokenThisRound = [];
  if (!debate.exchangeCount) debate.exchangeCount = {};

  const minExchanges = debate.minExchangesPerRound || 1;

  // Pendientes: agentes que NO han completado minExchanges
  const pendingParticipants = debate.participants
    .filter(p => !debate.spokenThisRound.includes(p.name));

  if (pendingParticipants.length === 0) {
    return {
      allSpoke: true,
      round: debate.currentRound,
      debateId,
      minExchanges,
    };
  }

  const phase = getCurrentPhase(debate.currentRound, debate.phases);

  // Contexto compartido: últimos mensajes
  const recentMessages = debate.messages.slice(-8).map(m => ({
    from: m.participantName,
    role: m.participantRole,
    text: m.text.slice(0, 400) + (m.text.length > 400 ? '...' : ''),
    round: m.round,
  }));

  // Construir KB una sola vez para compartir entre todos los agentes (audit fix)
  const sharedKB = buildSharedKBString(debate);

  // Generar un turno para CADA agente pendiente
  const turns = pendingParticipants.map(participant => {
    const mentionsMe = debate.messages.filter(m =>
      m.participantName !== participant.name &&
      (m.text.toLowerCase().includes(participant.name.toLowerCase()) ||
       m.text.toLowerCase().includes(participant.role.toLowerCase()))
    ).slice(-3).map(m => ({
      from: m.participantName,
      text: m.text.slice(0, 200),
    }));

    const otherParticipants = debate.participants
      .filter(p => p.name !== participant.name)
      .map(p => `${p.name} (${p.role})`);

    const myExchanges = debate.exchangeCount[participant.name] || 0;
    return {
      agent: {
        name: participant.name,
        role: participant.role,
        roleDesc: (debate.suggestedRoles || []).find(r => r.role === participant.role)?.desc || '',
      },
      exchangesDone: myExchanges,
      exchangesNeeded: minExchanges,
      isReply: myExchanges > 0, // true = this is a REPLY to others, not first position
      mentionsMe,
      otherParticipants,
      rolePlayPrompt: buildRolePlayPrompt(participant, phase, debate, mentionsMe, sharedKB),
    };
  });

  return {
    finished: false,
    debateId,
    round: debate.currentRound,
    maxRounds: debate.maxRounds,
    totalParticipants: debate.participants.length,
    pendingCount: turns.length,
    minExchanges,
    exchangeRound: turns[0]?.exchangesDone > 0 ? 'RÉPLICA' : 'POSICIÓN',
    phase: phase ? phase.name : null,
    phaseInstruction: phase ? phase.instruction : null,
    rules: debate.rules || [],
    intensity: debate.intensity || 'adversarial',
    topic: debate.topic,
    recentMessages,
    turns,
  };
}

/**
 * Registra múltiples mensajes de agentes de un solo golpe (batch).
 * Cada entry: { name, text }
 */
function sayBatch(debateId, messages) {
  const results = [];
  for (const msg of messages) {
    const result = say(debateId, msg.name, msg.text, true); // _skipSave=true
    results.push({
      agent: msg.name,
      success: !result.error,
      error: result.error || null,
      round: result.round,
      autoAdvanced: result.autoAdvanced || false,
      status: result.status,
    });
    // Si el debate terminó, no seguir
    if (result.status === 'finished') break;
  }

  // Un solo save para todo el batch (audit fix: antes eran N saves)
  saveStateNow();

  const debate = state.debates[debateId];
  const phase = debate ? getCurrentPhase(debate.currentRound, debate.phases) : null;

  return {
    debateId,
    processed: results.length,
    results,
    currentRound: debate ? debate.currentRound : null,
    status: debate ? debate.status : 'unknown',
    currentPhase: phase ? phase.name : null,
  };
}

// ── SITUACIONES PADRONIZADAS (Workflow Templates) ─────────────────────
// Templates pre-configurados para escenarios comunes de coordinación multi-agente.
// Cada situación define: roles fijos, fases específicas, reglas de coordinación,
// dependencias entre agentes (quién espera a quién), y patrón de flujo.

const SITUACIONES = {
  libre: {
    name: 'DEBATE LIBRE',
    desc: 'Debate abierto sin template — los roles se auto-detectan según el tema. Equivalente al antiguo orquestar_debate.',
    icon: '🔥',
    intensity: 'adversarial',
    maxRounds: 10,
    minWords: 150,
    roles: null, // null = auto-detectar con suggestRoles()
    phases: null, // null = usar fases por defecto según maxRounds
    rules: null,  // null = usar reglas por defecto según intensidad
    coordination: {
      type: 'debate_libre',
      dependencies: {},
      flowDescription: 'Debate libre — todos los agentes participan sin orden fijo.',
    },
  },

  identificar_problemas: {
    name: 'IDENTIFICAR PROBLEMAS',
    desc: 'Análisis exhaustivo de errores, bugs, y problemas en código/sistema. Los agentes trabajan en secuencia: detectar → analizar → priorizar → proponer fix.',
    icon: '🔍',
    intensity: 'adversarial',
    maxRounds: 12,
    minWords: 150,
    roles: [
      { role: 'detector-errores', desc: 'Escanea el código/sistema y LISTA cada error, bug, warning, code smell que encuentre. Nada se le escapa.', order: 1 },
      { role: 'analista-raiz', desc: 'Para CADA error detectado, investiga la CAUSA RAÍZ. No acepta explicaciones superficiales. Siempre pregunta "¿pero por qué?"', order: 2 },
      { role: 'priorizador-impacto', desc: 'Clasifica errores por SEVERIDAD e IMPACTO al usuario. Si no hay datos de impacto, los exige.', order: 3 },
      { role: 'proponedor-fix', desc: 'Propone la solución MÍNIMA VIABLE para cada error. Si la solución es compleja, la divide en pasos. Siempre estima esfuerzo.', order: 4 },
      { role: 'abogado-del-diablo', desc: 'CUESTIONA cada diagnóstico y cada fix propuesto. "¿Estás seguro que esa es la causa?" "¿Y si el fix rompe algo más?"', order: 5 },
    ],
    phases: [
      { name: 'DETECCIÓN', desc: 'El detector lista todos los problemas encontrados.', instruction: 'LISTA todos los errores/problemas que encuentres. Sé exhaustivo. Incluye: descripción del error, dónde ocurre, frecuencia estimada, y cualquier stack trace o evidencia.', rounds: [1, 3] },
      { name: 'ANÁLISIS DE CAUSA RAÍZ', desc: 'Cada problema se analiza en profundidad.', instruction: 'Para CADA problema listado, investiga la causa raíz. No te conformes con la primera explicación. Usa las fuentes del banco de conocimiento. Pregunta "¿por qué?" al menos 3 veces.', rounds: [4, 6] },
      { name: 'PRIORIZACIÓN', desc: 'Los problemas se clasifican por impacto y urgencia.', instruction: 'Clasifica TODOS los problemas en: CRÍTICO (P0), ALTO (P1), MEDIO (P2), BAJO (P3). Para cada uno, explica el impacto al usuario y al sistema. Si no estás de acuerdo con la clasificación de otro, argumenta.', rounds: [7, 9] },
      { name: 'PLAN DE FIXES', desc: 'Se proponen soluciones concretas.', instruction: 'Propone un fix CONCRETO para cada problema P0 y P1. Incluye: archivos a modificar, cambios específicos, estimación de esfuerzo, y riesgos del fix. El abogado del diablo DEBE cuestionar cada propuesta.', rounds: [10, 12] },
    ],
    rules: [
      'PROHIBIDO ignorar un error reportado — todos deben ser analizados.',
      'CADA fix propuesto debe incluir: archivos, cambios, esfuerzo estimado.',
      'El abogado del diablo DEBE cuestionar al menos 2 diagnósticos por ronda.',
      'Usar datos del banco de conocimiento — NO inventar errores.',
      'Prioridad: P0 (sistema caído) > P1 (funcionalidad rota) > P2 (degradación) > P3 (cosmético).',
      'Si un error no tiene causa raíz clara, MARCARLO como "requiere investigación" con pasos a seguir.',
    ],
    coordination: {
      type: 'secuencial', // El orden importa: detector → analista → priorizador → fix
      dependencies: {
        'analista-raiz': ['detector-errores'],     // Analista espera que detector hable
        'priorizador-impacto': ['analista-raiz'],  // Priorizador espera análisis
        'proponedor-fix': ['priorizador-impacto'], // Fix espera priorización
        'abogado-del-diablo': [],                  // Puede hablar en cualquier momento
      },
      flowDescription: 'Detector → Analista → Priorizador → Fix, con el Abogado cuestionando en cada etapa.',
    },
  },

  arquitectura: {
    name: 'ARQUITECTURA DE SOLUCIÓN',
    desc: 'Diseño técnico de una solución. Los agentes debaten la mejor arquitectura considerando: escalabilidad, mantenimiento, costo, y velocidad de entrega.',
    icon: '🏗️',
    intensity: 'adversarial',
    maxRounds: 12,
    minWords: 150,
    roles: [
      { role: 'arquitecto-sistema', desc: 'Diseña la arquitectura ideal: componentes, interfaces, flujos de datos. Piensa en 5 años. No le importa si es complejo.', order: 1 },
      { role: 'pragmatico-delivery', desc: 'SOLO acepta lo que se puede entregar en 2 sprints. Cada abstracción extra es un enemigo. "Ship it."', order: 2 },
      { role: 'guardian-escalabilidad', desc: 'Si no escala a 10x el tráfico actual, se rechaza. Performance es todo. Cada query importa.', order: 3 },
      { role: 'defensor-mantenimiento', desc: 'Si un junior no lo entiende en 30 min, es mala arquitectura. Simplicidad y documentación ante todo.', order: 4 },
      { role: 'evaluador-tradeoffs', desc: 'NO toma partido. Evalúa CADA propuesta con pros/contras objetivos. Exige datos, no opiniones. Resume tradeoffs para decisión final.', order: 5 },
    ],
    phases: [
      { name: 'PROPUESTAS', desc: 'Cada agente propone su enfoque arquitectónico.', instruction: 'Presenta tu PROPUESTA de arquitectura. Incluye: componentes principales, tecnologías sugeridas, diagrama conceptual (en texto), y justificación desde tu perspectiva.', rounds: [1, 3] },
      { name: 'CROSS-EXAMINATION', desc: 'Los agentes cuestionan las propuestas de otros.', instruction: 'Haz preguntas DIRECTAS a las propuestas de otros. Ataca los puntos débiles. Exige datos de soporte. Si no pueden justificar una decisión técnica, señálalo.', rounds: [4, 6] },
      { name: 'REFINAMIENTO', desc: 'Las propuestas se refinan basándose en las objeciones.', instruction: 'REFINA tu propuesta incorporando las objeciones válidas. Explica QUÉ cambió y POR QUÉ. Si no aceptas una objeción, argumenta por qué tu diseño original es mejor.', rounds: [7, 9] },
      { name: 'DECISIÓN', desc: 'Evaluación final y recomendación.', instruction: 'VOTO FINAL: 1) ¿Cuál propuesta es MEJOR y por qué? 2) ¿Qué riesgos quedan sin resolver? 3) Plan de implementación en 3 fases. El evaluador de tradeoffs debe dar el resumen final.', rounds: [10, 12] },
    ],
    rules: [
      'Toda propuesta debe incluir: diagrama de componentes (texto), tecnologías, y justificación.',
      'PROHIBIDO proponer tecnología sin explicar por qué es mejor que las alternativas.',
      'Cada objeción debe incluir una alternativa — no solo "eso no sirve".',
      'El evaluador de tradeoffs DEBE resumir pros/contras de cada propuesta al final de cada ronda.',
      'Si hay empate, la arquitectura más SIMPLE gana.',
      'Decisiones de tecnología deben considerar: equipo actual, curva de aprendizaje, madurez del ecosistema.',
    ],
    coordination: {
      type: 'debate_libre', // Todos hablan, pero el evaluador resume
      dependencies: {
        'evaluador-tradeoffs': ['arquitecto-sistema', 'pragmatico-delivery'], // Resume después de que propongan
      },
      flowDescription: 'Todos proponen → Cross-exam → Refinamiento → El Evaluador da la recomendación final.',
    },
  },

  ejecucion: {
    name: 'EJECUCIÓN COORDINADA',
    desc: 'Implementación real con coordinación en tiempo real. Un agente implementa, otro revisa, otro coordina, otro arquitecta. Flujo tipo pull-request con revisión continua.',
    icon: '⚡',
    intensity: 'adversarial',
    maxRounds: 16,
    minWords: 120,
    roles: [
      { role: 'implementador', desc: 'ESCRIBE el código. Crea la rama, hace los cambios, reporta progreso. Su trabajo es ENTREGAR código que funcione.', order: 1 },
      { role: 'revisor-codigo', desc: 'REVISA cada cambio del implementador. Busca bugs, code smells, violaciones de estándares. NO aprueba sin al menos 1 observación.', order: 2 },
      { role: 'coordinador', desc: 'Organiza el flujo de trabajo. Define qué se hace primero, gestiona dependencias, resuelve conflictos. Mantiene a todos enfocados.', order: 3 },
      { role: 'arquitecto-guardian', desc: 'Verifica que la implementación siga la arquitectura definida. Si hay desviaciones, las señala INMEDIATAMENTE.', order: 4 },
      { role: 'qa-tester', desc: 'Define y ejecuta casos de prueba. Si algo no se puede probar, es un problema. Exige tests para cada cambio.', order: 5 },
    ],
    phases: [
      { name: 'PLANIFICACIÓN', desc: 'El coordinador define tareas y asignaciones.', instruction: 'COORDINADOR define las tareas. ARQUITECTO valida el approach. IMPLEMENTADOR confirma factibilidad. Resultado: lista de tareas con orden y dependencias claras.', rounds: [1, 3] },
      { name: 'IMPLEMENTACIÓN R1', desc: 'Primera ronda de implementación y revisión.', instruction: 'IMPLEMENTADOR: describe los cambios que hiciste (archivos, funciones, lógica). REVISOR: revisa y da feedback. COORDINADOR: verifica que sigue el plan. QA: prepara tests.', rounds: [4, 7] },
      { name: 'REVISIÓN Y AJUSTES', desc: 'Code review, fixes, y re-check.', instruction: 'IMPLEMENTADOR: aplica los fixes del review. REVISOR: re-revisa y aprueba/rechaza. ARQUITECTO: verifica alineación. QA: ejecuta tests y reporta resultados.', rounds: [8, 11] },
      { name: 'INTEGRACIÓN', desc: 'Merge, deploy, validación final.', instruction: 'COORDINADOR: da el OK final para merge. QA: confirma que todos los tests pasan. REVISOR: aprobación final. IMPLEMENTADOR: ejecuta merge. ARQUITECTO: valida que no hay deuda técnica nueva.', rounds: [12, 16] },
    ],
    rules: [
      'El IMPLEMENTADOR debe describir EXACTAMENTE qué cambió: archivo, línea, función.',
      'El REVISOR NO puede aprobar sin al menos 1 observación o pregunta.',
      'El COORDINADOR define el ORDER — los demás lo respetan.',
      'NINGÚN cambio pasa a merge sin aprobación del REVISOR + QA.',
      'El ARQUITECTO tiene poder de VETO si la implementación viola la arquitectura.',
      'CADA ronda debe terminar con un STATUS: "bloqueado", "en progreso", "listo para review", "aprobado".',
      'Si hay conflicto entre revisor e implementador, el coordinador decide.',
    ],
    coordination: {
      type: 'pipeline', // Flujo estricto: implementar → revisar → ajustar → aprobar
      dependencies: {
        'implementador': ['coordinador'],           // Implementador espera asignación del coordinador
        'revisor-codigo': ['implementador'],         // Revisor espera código del implementador
        'qa-tester': ['implementador'],              // QA espera implementación
        'arquitecto-guardian': ['implementador'],    // Arquitecto revisa implementación
        'coordinador': [],                           // Coordinador puede hablar siempre
      },
      flowDescription: 'Coordinador asigna → Implementador codea → Revisor + QA + Arquitecto revisan → Coordinador aprueba merge.',
    },
  },

  mejora_codigo: {
    name: 'MEJORA DE CÓDIGO',
    desc: 'Los agentes analizan código del proyecto, proponen mejoras, las debaten, y si hay consenso se aplican en un branch. Flujo: analizar → proponer → debatir → aplicar.',
    icon: '🛠️',
    intensity: 'adversarial',
    maxRounds: 12,
    minWords: 100,
    roles: [
      { role: 'analista-codigo', desc: 'Lee y analiza archivos del proyecto. Detecta problemas de performance, bugs, code smells, y oportunidades de mejora. Usa read_project_file para leer código.', order: 1 },
      { role: 'proponedor-mejora', desc: 'Propone cambios concretos con old_string/new_string. Cada propuesta debe tener razón clara y ser mínima. Usa propose_edit para crear propuestas.', order: 2 },
      { role: 'revisor-seguridad', desc: 'Revisa cada propuesta buscando: vulnerabilidades, breaking changes, edge cases no contemplados. RECHAZA propuestas inseguras con review_proposal.', order: 3 },
      { role: 'revisor-calidad', desc: 'Evalúa: legibilidad, mantenibilidad, consistencia con el estilo existente. Aprueba o rechaza con justificación técnica.', order: 4 },
      { role: 'coordinador-merge', desc: 'Decide cuándo aplicar propuestas aprobadas. Ejecuta tests. Si fallan, revierte. Reporta el resultado final.', order: 5 },
    ],
    phases: [
      { name: 'ANÁLISIS', desc: 'Los analistas leen el código y detectan issues.', instruction: 'Usa read_project_file para leer archivos. Lista TODOS los problemas encontrados con archivo, línea, y descripción. Sé exhaustivo.', rounds: [1, 3] },
      { name: 'PROPUESTAS', desc: 'Se crean propuestas concretas de cambio.', instruction: 'Usa propose_edit para proponer cambios. Cada propuesta: archivo, old_string, new_string, razón. Las propuestas deben ser MÍNIMAS y enfocadas.', rounds: [4, 7] },
      { name: 'REVISIÓN', desc: 'Los revisores evalúan cada propuesta.', instruction: 'Usa review_proposal para aprobar o rechazar. CADA revisión debe tener justificación técnica. Busca: bugs, seguridad, breaking changes, estilo.', rounds: [8, 10] },
      { name: 'APLICACIÓN', desc: 'Se aplican las propuestas aprobadas y se corren tests.', instruction: 'El coordinador usa apply_proposal para aplicar propuestas aprobadas. Luego run_tests. Si fallan, revert_proposal. Reporta estado final.', rounds: [11, 12] },
    ],
    rules: [
      'SOLO proponer cambios en archivos que hayas LEÍDO con read_project_file.',
      'Cada propuesta debe ser MÍNIMA — un cambio por propuesta, no refactors masivos.',
      'PROHIBIDO aprobar sin revisar — cada propuesta necesita al menos 1 aprobación y 0 rechazos activos.',
      'Si un test falla después de aplicar, se REVIERTE inmediatamente.',
      'El coordinador tiene la última palabra sobre qué se aplica.',
      'No modificar archivos de test para que pasen — arreglar el código, no los tests.',
    ],
    coordination: {
      type: 'pipeline',
      dependencies: {
        'proponedor-mejora': ['analista-codigo'],
        'revisor-seguridad': ['proponedor-mejora'],
        'revisor-calidad': ['proponedor-mejora'],
        'coordinador-merge': ['revisor-seguridad', 'revisor-calidad'],
        'analista-codigo': [],
      },
      flowDescription: 'Analista lee código → Proponedor crea propuestas → Revisores evalúan → Coordinador aplica y corre tests.',
    },
  },
};

/**
 * Lista las situaciones disponibles
 */
function listSituaciones() {
  return Object.entries(SITUACIONES).map(([key, sit]) => ({
    id: key,
    name: sit.name,
    icon: sit.icon,
    desc: sit.desc,
    roles: sit.roles
      ? sit.roles.map(r => `${r.role} (${r.desc.slice(0, 60)}...)`)
      : ['(auto-detectados según tema)'],
    phases: sit.phases
      ? sit.phases.map(p => p.name)
      : ['(auto-calculadas según rondas)'],
    coordination: sit.coordination.flowDescription,
    intensity: sit.intensity,
    maxRounds: sit.maxRounds,
  }));
}

/**
 * Crea un debate a partir de una situación padronizada.
 * Opcionalmente crea sub-agentes virtuales si numAgents > 0.
 */
function crearSituacion(situacionId, tema, numAgents = 0) {
  const template = SITUACIONES[situacionId];
  if (!template) {
    return { error: `Situación "${situacionId}" no existe. Disponibles: ${Object.keys(SITUACIONES).join(', ')}` };
  }

  // Audit fix: usar createDebate() internamente en vez de duplicar la lógica
  const isLibre = situacionId === 'libre';
  const fullTopic = (template.icon && !isLibre) ? `[${template.icon} ${template.name}] ${tema}` : tema;

  // Para "libre": roles y fases se auto-detectan, null = usar defaults de createDebate
  const debate = createDebate(
    fullTopic,
    template.maxRounds,
    template.roles,  // null para libre → auto-detecta
    template.intensity,
    template.rules   // null para libre → usa defaults
  );

  // Extender con campos específicos de situación
  debate.category = isLibre ? debate.category : 'situacion';
  debate.situacion = situacionId;
  debate.situacionName = template.name;
  debate.minWords = template.minWords || debate.minWords;
  debate.coordination = template.coordination;
  // Sobrescribir fases con las del template si tiene (libre usa las auto-calculadas)
  if (template.phases) {
    debate.phases = template.phases.map(p => ({
      name: p.name,
      desc: p.desc,
      instruction: p.instruction,
      rounds: p.rounds,
    }));
  }
  if (!debate.knowledgeBase) debate.knowledgeBase = [];
  saveState();

  // Si se pidieron sub-agentes, registrarlos automáticamente
  const agents = [];
  // Audit fix: cap subido a 15
  const effectiveAgents = Math.max(0, Math.min(15, numAgents));
  if (effectiveAgents > 0) {
    // Para "libre", usar autoDebate internamente (ya maneja roles genéricos)
    if (isLibre) {
      const autoResult = autoDebate(tema, effectiveAgents, template.maxRounds, template.intensity);
      // Copiar agentes del autoDebate al debate de situación
      // Reemplazar el debate creado por autoDebate con el nuestro
      // En realidad, para "libre" delegamos completamente a autoDebate
      return {
        debate: autoResult.debate,
        template: {
          name: template.name,
          icon: template.icon,
          coordination: template.coordination,
          phases: (autoResult.debate.phases || []).map(p => ({ name: p.name, rounds: p.rounds })),
        },
        agents: autoResult.agents,
        firstTurn: autoResult.firstTurn,
      };
    }

    const roles = debate.suggestedRoles || [];
    const rolesToAssign = roles.slice(0, Math.min(effectiveAgents, roles.length));
    for (const roleDef of rolesToAssign) {
      const agentName = `agente-${roleDef.role}`;
      const result = joinDebate(debate.id, agentName, roleDef.role);
      if (!result.error) {
        agents.push({
          name: agentName,
          role: roleDef.role,
          desc: roleDef.desc,
          order: roleDef.order,
        });
      }
    }
    // Si se pidieron más agentes que roles del template, agregar genéricos
    for (let i = roles.length; i < effectiveAgents; i++) {
      const extraIdx = i - roles.length;
      const extraRole = GENERIC_EXTRA_ROLES[extraIdx % GENERIC_EXTRA_ROLES.length];
      const roleName = `${extraRole.role}-${extraIdx + 1}`;
      const agentName = `agente-${roleName}`;
      debate.suggestedRoles.push({ role: roleName, desc: extraRole.desc, order: i + 1 });
      const result = joinDebate(debate.id, agentName, roleName);
      if (!result.error) {
        agents.push({ name: agentName, role: roleName, desc: extraRole.desc, order: i + 1 });
      }
    }
  }

  saveState();

  return {
    debate,
    template: {
      name: template.name,
      icon: template.icon,
      coordination: template.coordination,
      phases: template.phases.map(p => ({ name: p.name, rounds: p.rounds })),
    },
    agents,
    firstTurn: agents.length > 0 ? getNextTurn(debate.id) : null,
  };
}

/**
 * Obtiene el estado del workflow de coordinación de una situación.
 * Muestra quién debe esperar a quién, qué fase estamos, y el flujo.
 */
function getWorkflowStatus(debateId) {
  const debate = state.debates[debateId];
  if (!debate) return { error: `Debate ${debateId} no existe` };
  if (!debate.coordination) return { error: `Debate ${debateId} no es una situación con coordinación.` };

  const phase = getCurrentPhase(debate.currentRound, debate.phases);
  const coord = debate.coordination;

  // Calcular quién puede hablar basado en dependencias
  const spokenSet = new Set(debate.spokenThisRound || []);
  const participantStatus = debate.participants.map(p => {
    const deps = coord.dependencies[p.role] || [];
    const depsResolved = deps.every(depRole => {
      const depParticipant = debate.participants.find(pp => pp.role === depRole);
      return depParticipant && spokenSet.has(depParticipant.name);
    });
    const hasSpoken = spokenSet.has(p.name);
    const exchanges = (debate.exchangeCount || {})[p.name] || 0;

    let status;
    if (hasSpoken) {
      status = 'completado';
    } else if (depsResolved) {
      status = 'listo_para_hablar';
    } else {
      status = 'esperando_dependencias';
    }

    return {
      name: p.name,
      role: p.role,
      order: (debate.suggestedRoles || []).find(r => r.role === p.role)?.order || 99,
      status,
      exchanges,
      dependsOn: deps,
      dependenciesResolved: depsResolved,
      hasSpoken,
    };
  }).sort((a, b) => a.order - b.order);

  // Determinar próximo agente según coordinación
  const nextToAct = participantStatus.find(p => p.status === 'listo_para_hablar');

  return {
    debateId,
    situacion: debate.situacionName || 'N/A',
    coordinationType: coord.type,
    flowDescription: coord.flowDescription,
    currentRound: debate.currentRound,
    maxRounds: debate.maxRounds,
    currentPhase: phase ? phase.name : null,
    phaseInstruction: phase ? phase.instruction : null,
    participants: participantStatus,
    nextToAct: nextToAct ? {
      name: nextToAct.name,
      role: nextToAct.role,
      desc: (debate.suggestedRoles || []).find(r => r.role === nextToAct.role)?.desc || '',
    } : null,
    allCompleted: participantStatus.every(p => p.status === 'completado'),
    blockedAgents: participantStatus.filter(p => p.status === 'esperando_dependencias').map(p => ({
      name: p.name,
      role: p.role,
      waitingFor: p.dependsOn.filter(dep => {
        const depP = debate.participants.find(pp => pp.role === dep);
        return depP && !spokenSet.has(depP.name);
      }),
    })),
  };
}

// ── CODE PROPOSALS with GOVERNANCE ───────────────────────────────────
let proposals = [];
let proposalNextId = 1;

// ── Governance Rules ─────────────────────────────────────────────────
// These rules ensure NO agent can act alone. Changes require consensus.
const GOVERNANCE = {
  // Minimum approvals needed to approve a proposal
  minApprovals: 2,
  // Roles that MUST approve — proposal cannot be approved without them
  mandatoryApprovalRoles: ['arquitecto-guardian', 'revisor-seguridad'],
  // Roles with veto power — a single rejection from these roles blocks the proposal
  vetoRoles: ['arquitecto-guardian', 'revisor-seguridad', 'revisor-calidad'],
  // Only these roles can execute apply_proposal
  applyAllowedRoles: ['coordinador-merge'],
  // Only these roles can propose edits (analysts cannot propose, only read)
  proposeAllowedRoles: ['proponedor-mejora', 'coordinador-merge'],
  // Protected files that require ALL mandatory roles to approve
  protectedFiles: ['debate-manager.cjs', 'mcp-server.js', 'validators.cjs'],
  // Files that can NEVER be modified by agents
  forbiddenFiles: ['test-suite.cjs', '.env', 'package-lock.json'],
};

function getGovernanceConfig() {
  return { ...GOVERNANCE };
}

// Resolve agent role from the debate participants
function _getAgentRole(debateId, agentName) {
  const debate = state.debates[debateId];
  if (!debate) return null;
  const participant = debate.participants.find(p => p.name === agentName);
  return participant ? participant.role : null;
}

// Check governance status for a proposal
function getGovernanceStatus(proposalId) {
  const prop = proposals.find(p => p.id === proposalId);
  if (!prop) return { error: 'Proposal not found' };

  const approvals = prop.reviews.filter(r => r.approved);
  const rejections = prop.reviews.filter(r => !r.approved);
  const approverRoles = approvals.map(r => r.reviewerRole).filter(Boolean);
  const rejectorRoles = rejections.map(r => r.reviewerRole).filter(Boolean);

  const isProtected = GOVERNANCE.protectedFiles.some(f => prop.filePath.includes(f));
  const mandatoryNeeded = GOVERNANCE.mandatoryApprovalRoles.filter(role => !approverRoles.includes(role));
  const hasVeto = rejections.some(r => GOVERNANCE.vetoRoles.includes(r.reviewerRole));
  const hasEnoughApprovals = approvals.length >= GOVERNANCE.minApprovals;
  const allMandatoryApproved = mandatoryNeeded.length === 0;

  const canBeApproved = !hasVeto && hasEnoughApprovals && allMandatoryApproved;
  const isBlocked = hasVeto;

  return {
    proposalId: prop.id,
    status: prop.status,
    filePath: prop.filePath,
    isProtectedFile: isProtected,
    approvals: approvals.length,
    rejections: rejections.length,
    minApprovalsNeeded: GOVERNANCE.minApprovals,
    mandatoryRolesNeeded: mandatoryNeeded,
    hasVeto: isBlocked,
    vetoBy: isBlocked ? rejections.filter(r => GOVERNANCE.vetoRoles.includes(r.reviewerRole)).map(r => `${r.reviewer} (${r.reviewerRole})`) : [],
    canBeApproved,
    missingFor: canBeApproved ? [] : [
      ...(hasVeto ? ['BLOCKED by veto — must be resolved first'] : []),
      ...(!hasEnoughApprovals ? [`Need ${GOVERNANCE.minApprovals - approvals.length} more approval(s)`] : []),
      ...mandatoryNeeded.map(role => `Missing mandatory approval from: ${role}`),
    ],
  };
}

// ── Code Proposal Functions (with Governance) ───────────────────────

function readProjectFile(filePath) {
  const resolved = path.resolve(__dirname, filePath);
  if (!resolved.startsWith(__dirname)) {
    return { error: 'Access denied: can only read files within the project directory.' };
  }
  try {
    if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };
    const content = fs.readFileSync(resolved, 'utf-8');
    const lines = content.split('\n');
    return {
      path: filePath,
      lines: lines.length,
      content: lines.map((l, i) => `${i + 1}: ${l}`).join('\n'),
    };
  } catch (e) {
    return { error: `Failed to read file: ${e.message}` };
  }
}

function listProjectFiles(pattern) {
  const base = __dirname;
  const ignore = ['node_modules', '.git', 'sesiones-guardadas', 'sessions', 'memoria'];
  const results = [];
  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        if (!pattern || relPath.includes(pattern) || entry.name.endsWith(pattern)) {
          const stat = fs.statSync(fullPath);
          results.push({ path: relPath, size: stat.size, modified: stat.mtime.toISOString() });
        }
      }
    }
  }
  walk(base, '');
  return results;
}

function proposeEdit(debateId, agentName, filePath, oldString, newString, reason) {
  if (!state.debates[debateId]) return { error: 'Debate not found' };

  // Governance: check if agent has permission to propose
  const agentRole = _getAgentRole(debateId, agentName);
  if (agentRole && GOVERNANCE.proposeAllowedRoles.length > 0 && !GOVERNANCE.proposeAllowedRoles.includes(agentRole)) {
    return { error: `GOVERNANCE: Role "${agentRole}" cannot propose edits. Allowed roles: ${GOVERNANCE.proposeAllowedRoles.join(', ')}` };
  }

  // Governance: check forbidden files
  if (GOVERNANCE.forbiddenFiles.some(f => filePath.includes(f))) {
    return { error: `GOVERNANCE: File "${filePath}" is protected and cannot be modified by agents.` };
  }

  const resolved = path.resolve(__dirname, filePath);
  if (!resolved.startsWith(__dirname)) return { error: 'Access denied' };
  if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };
  const content = fs.readFileSync(resolved, 'utf-8');
  if (!content.includes(oldString)) return { error: 'old_string not found in file. Read the file first and use exact text.' };
  if (oldString === newString) return { error: 'old_string and new_string are identical' };

  const isProtected = GOVERNANCE.protectedFiles.some(f => filePath.includes(f));

  const id = `prop-${proposalNextId++}`;
  const proposal = {
    id,
    debateId,
    proposedBy: agentName,
    proposedByRole: agentRole,
    filePath,
    oldString,
    newString,
    reason,
    status: 'pending', // pending | approved | rejected | applied | reverted
    isProtectedFile: isProtected,
    reviews: [],
    governanceLog: [{ action: 'created', by: agentName, role: agentRole, at: new Date().toISOString() }],
    createdAt: new Date().toISOString(),
    appliedAt: null,
    appliedBy: null,
    branch: null,
  };
  proposals.push(proposal);

  const warnings = [];
  if (isProtected) warnings.push('This is a PROTECTED file — requires ALL mandatory role approvals.');

  return {
    id: proposal.id,
    status: 'pending',
    isProtectedFile: isProtected,
    governance: {
      minApprovals: GOVERNANCE.minApprovals,
      mandatoryApprovalRoles: GOVERNANCE.mandatoryApprovalRoles,
      vetoRoles: GOVERNANCE.vetoRoles,
    },
    warnings,
    message: `Proposal ${id} created. Requires: ${GOVERNANCE.minApprovals} approvals including ${GOVERNANCE.mandatoryApprovalRoles.join(' + ')}.`,
  };
}

function reviewProposal(proposalId, reviewerName, approve, comment) {
  const prop = proposals.find(p => p.id === proposalId);
  if (!prop) return { error: 'Proposal not found' };
  if (prop.status !== 'pending') return { error: `Proposal is already ${prop.status}` };
  if (prop.proposedBy === reviewerName) return { error: 'Cannot review your own proposal' };

  // Check if this reviewer already reviewed
  const existing = prop.reviews.find(r => r.reviewer === reviewerName);
  if (existing) return { error: `${reviewerName} already reviewed this proposal. Use a different reviewer.` };

  // Get reviewer role
  const reviewerRole = _getAgentRole(prop.debateId, reviewerName);

  prop.reviews.push({
    reviewer: reviewerName,
    reviewerRole: reviewerRole,
    approved: approve,
    comment: comment || '',
    at: new Date().toISOString(),
  });

  prop.governanceLog.push({
    action: approve ? 'approved' : 'rejected',
    by: reviewerName,
    role: reviewerRole,
    comment: comment || '',
    at: new Date().toISOString(),
  });

  // Governance-aware status update
  const approvals = prop.reviews.filter(r => r.approved);
  const rejections = prop.reviews.filter(r => !r.approved);
  const approverRoles = approvals.map(r => r.reviewerRole).filter(Boolean);

  // Veto check: any veto-role rejection blocks immediately
  const hasVeto = rejections.some(r => GOVERNANCE.vetoRoles.includes(r.reviewerRole));
  if (hasVeto) {
    prop.status = 'rejected';
    const vetoer = rejections.find(r => GOVERNANCE.vetoRoles.includes(r.reviewerRole));
    return {
      id: prop.id,
      status: 'rejected',
      reason: `VETOED by ${vetoer.reviewer} (${vetoer.reviewerRole}). Proposal blocked.`,
      reviews: prop.reviews.length,
      approvals: approvals.length,
      rejections: rejections.length,
    };
  }

  // Check if all mandatory roles approved AND minimum approvals met
  const mandatoryMet = GOVERNANCE.mandatoryApprovalRoles.every(role => approverRoles.includes(role));
  const enoughApprovals = approvals.length >= GOVERNANCE.minApprovals;

  if (mandatoryMet && enoughApprovals) {
    prop.status = 'approved';
  }

  const govStatus = getGovernanceStatus(proposalId);

  return {
    id: prop.id,
    status: prop.status,
    reviews: prop.reviews.length,
    approvals: approvals.length,
    rejections: rejections.length,
    governance: {
      canBeApproved: govStatus.canBeApproved,
      missing: govStatus.missingFor,
    },
  };
}

function applyProposal(proposalId, applierName) {
  const prop = proposals.find(p => p.id === proposalId);
  if (!prop) return { error: 'Proposal not found' };
  if (prop.status !== 'approved') return { error: `Proposal must be approved first (current: ${prop.status})` };

  // Governance: only allowed roles can apply
  if (applierName) {
    const applierRole = _getAgentRole(prop.debateId, applierName);
    if (applierRole && GOVERNANCE.applyAllowedRoles.length > 0 && !GOVERNANCE.applyAllowedRoles.includes(applierRole)) {
      return { error: `GOVERNANCE: Role "${applierRole}" cannot apply proposals. Only ${GOVERNANCE.applyAllowedRoles.join(', ')} can apply.` };
    }
  }

  // Double-check governance before applying
  const govStatus = getGovernanceStatus(proposalId);
  if (!govStatus.canBeApproved) {
    return { error: `GOVERNANCE: Proposal cannot be applied. Missing: ${govStatus.missingFor.join('; ')}` };
  }

  const resolved = path.resolve(__dirname, prop.filePath);

  // Create git branch for the change
  let branch = null;
  try {
    const { execSync } = require('child_process');
    branch = `proposal/${prop.id}`;
    execSync(`git checkout -b ${branch}`, { cwd: __dirname, encoding: 'utf-8', stdio: 'pipe' });
    prop.branch = branch;
  } catch (e) {
    // Git not available or not a repo — apply directly but log warning
    prop.branch = null;
  }

  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    if (!content.includes(prop.oldString)) {
      prop.status = 'rejected';
      // Return to previous branch if we created one
      if (branch) {
        try {
          const { execSync } = require('child_process');
          execSync('git checkout -', { cwd: __dirname, stdio: 'pipe' });
          execSync(`git branch -D ${branch}`, { cwd: __dirname, stdio: 'pipe' });
        } catch (_) {}
      }
      return { error: 'old_string no longer found in file — file may have changed. Proposal rejected.' };
    }
    const newContent = content.replace(prop.oldString, prop.newString);
    fs.writeFileSync(resolved, newContent, 'utf-8');
    prop.status = 'applied';
    prop.appliedAt = new Date().toISOString();
    prop.appliedBy = applierName || 'unknown';

    prop.governanceLog.push({
      action: 'applied',
      by: applierName || 'unknown',
      role: applierName ? _getAgentRole(prop.debateId, applierName) : null,
      branch: branch,
      at: new Date().toISOString(),
    });

    // Commit on branch if git available
    if (branch) {
      try {
        const { execSync } = require('child_process');
        execSync(`git add "${prop.filePath}"`, { cwd: __dirname, stdio: 'pipe' });
        execSync(`git commit -m "proposal(${prop.id}): ${prop.reason.substring(0, 60)}"`, { cwd: __dirname, stdio: 'pipe' });
      } catch (_) {}
    }

    return {
      id: prop.id,
      status: 'applied',
      file: prop.filePath,
      branch: branch,
      appliedBy: applierName,
      message: branch
        ? `Change applied on branch "${branch}". Run tests before merging.`
        : 'Change applied directly (git not available). Run tests to verify.',
    };
  } catch (e) {
    return { error: `Failed to apply: ${e.message}` };
  }
}

function revertProposal(proposalId) {
  const prop = proposals.find(p => p.id === proposalId);
  if (!prop) return { error: 'Proposal not found' };
  if (prop.status !== 'applied') return { error: `Can only revert applied proposals (current: ${prop.status})` };

  const resolved = path.resolve(__dirname, prop.filePath);
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    if (!content.includes(prop.newString)) {
      return { error: 'new_string not found — file may have been modified after apply.' };
    }
    const reverted = content.replace(prop.newString, prop.oldString);
    fs.writeFileSync(resolved, reverted, 'utf-8');
    prop.status = 'reverted';

    prop.governanceLog.push({
      action: 'reverted',
      at: new Date().toISOString(),
    });

    // If on a branch, go back to previous branch
    if (prop.branch) {
      try {
        const { execSync } = require('child_process');
        execSync('git checkout -', { cwd: __dirname, stdio: 'pipe' });
        execSync(`git branch -D ${prop.branch}`, { cwd: __dirname, stdio: 'pipe' });
      } catch (_) {}
      prop.branch = null;
    }

    return { id: prop.id, status: 'reverted', file: prop.filePath, message: 'Change reverted.' };
  } catch (e) {
    return { error: `Failed to revert: ${e.message}` };
  }
}

function listProposals(debateId) {
  const filtered = debateId ? proposals.filter(p => p.debateId === debateId) : proposals;
  return filtered.map(p => ({
    id: p.id,
    debateId: p.debateId,
    proposedBy: p.proposedBy,
    proposedByRole: p.proposedByRole,
    filePath: p.filePath,
    reason: p.reason,
    status: p.status,
    isProtectedFile: p.isProtectedFile,
    branch: p.branch,
    reviewCount: p.reviews.length,
    approvals: p.reviews.filter(r => r.approved).length,
    rejections: p.reviews.filter(r => !r.approved).length,
    createdAt: p.createdAt,
  }));
}

function getProposal(proposalId) {
  const prop = proposals.find(p => p.id === proposalId);
  if (!prop) return { error: 'Proposal not found' };
  return { ...prop };
}

function runProjectTests() {
  const { execSync } = require('child_process');
  try {
    fs.writeFileSync(path.join(__dirname, 'debates.json'), '{"debates":{},"nextId":1}', 'utf-8');
    const output = execSync('node test-suite.cjs', { cwd: __dirname, timeout: 60000, encoding: 'utf-8' });
    const passed = (output.match(/Passed: (\d+)/)||[])[1] || '?';
    const failed = (output.match(/Failed: (\d+)/)||[])[1] || '?';
    const allPassed = output.includes('ALL TESTS PASSED');
    return { allPassed, passed: parseInt(passed), failed: parseInt(failed), output: output.slice(-500) };
  } catch (e) {
    return { allPassed: false, error: e.message, output: (e.stdout || '').slice(-500) };
  }
}

module.exports = {
  createDebate,
  joinDebate,
  say,
  read,
  nextRound,
  finishDebate,
  listDebates,
  getActiveDebate,
  suggestRoles,
  getCurrentPhase,
  // Sub-agent orchestration
  autoDebate,
  getNextTurn,
  getAllPendingTurns,
  sayBatch,
  // Knowledge base
  addContext,
  getKnowledgeBase,
  getKnowledgeSource,
  // Situaciones padronizadas
  listSituaciones,
  crearSituacion,
  getWorkflowStatus,
  // Flush state (para uso externo si necesario)
  saveStateNow,
  // Code proposals + governance
  readProjectFile,
  listProjectFiles,
  proposeEdit,
  reviewProposal,
  applyProposal,
  revertProposal,
  listProposals,
  getProposal,
  runProjectTests,
  getGovernanceConfig,
  getGovernanceStatus,
  // Embeddings
  searchEmbeddings: embeddings.search,
  getEmbeddingStats: embeddings.getStats,
};
