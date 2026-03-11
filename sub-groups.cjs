/**
 * Sub-Groups (Mesas) and Pipeline de Salas Orchestration
 *
 * FEATURE 1: Sub-Groups (Mesas)
 * When there are 6+ agents, split them into smaller "mesas" (tables) that debate in parallel,
 * then a coordinator synthesizes the outputs.
 *
 * FEATURE 2: Pipeline de Salas (Room Pipeline)
 * Sequential rooms where output of one becomes input of the next.
 */

const fs = require('fs');
const path = require('path');
const dm = require('./debate-manager.cjs');

const PIPELINES_FILE = path.join(__dirname, 'pipelines.json');

let pipelineState = {
  pipelines: {},
  nextId: 1,
};

// ── Persistencia ──────────────────────────────────────────────────────────

function loadPipelineState() {
  try {
    if (fs.existsSync(PIPELINES_FILE)) {
      pipelineState = JSON.parse(fs.readFileSync(PIPELINES_FILE, 'utf-8'));
    }
  } catch {
    // Default state if corrupted
  }
}

let _saveTimer = null;
let _savePending = false;

function savePipelineStateNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _savePending = false;
  fs.writeFileSync(PIPELINES_FILE, JSON.stringify(pipelineState, null, 2), 'utf-8');
}

function savePipelineState() {
  _savePending = true;
  if (!_saveTimer) {
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      if (_savePending) {
        _savePending = false;
        fs.writeFileSync(PIPELINES_FILE, JSON.stringify(pipelineState, null, 2), 'utf-8');
      }
    }, 3000);
  }
}

process.on('exit', () => { if (_savePending) savePipelineStateNow(); });
process.on('SIGINT', () => { if (_savePending) savePipelineStateNow(); process.exit(); });
process.on('SIGTERM', () => { if (_savePending) savePipelineStateNow(); process.exit(); });

loadPipelineState();

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1: SUB-GROUPS (MESAS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a debate into sub-groups (mesas) for parallel debate
 *
 * @param {string} debateId - Main debate ID
 * @param {number} groupSize - Size of each group (default 3-5)
 * @returns {object} Groups with members, topics, and sub-debate IDs
 */
function createSubGroups(debateId, groupSize = 4) {
  const mainDebate = dm.listDebates().find(d => d.id === debateId);
  if (!mainDebate) {
    return { error: `Debate ${debateId} no existe` };
  }

  const participants = mainDebate.participants || [];
  if (participants.length < 6) {
    return {
      error: `Se necesitan mínimo 6 participantes para crear sub-grupos. Tienes ${participants.length}.`,
    };
  }

  // Shuffle participants to randomize group assignments
  const shuffled = [...participants].sort(() => Math.random() - 0.5);

  const groups = [];
  const groupCount = Math.ceil(shuffled.length / groupSize);

  for (let i = 0; i < groupCount; i++) {
    const groupMembers = shuffled.slice(i * groupSize, (i + 1) * groupSize);

    // Create sub-topic from main topic
    const subtopic = `${mainDebate.topic} (Mesa ${i + 1}/${groupCount}: Perspectiva de ${groupMembers.map(p => p.name).join(', ')})`;

    // Create sub-debate with same configuration as main
    const subDebateResult = dm.createDebate(
      subtopic,
      mainDebate.maxRounds || 10,
      null,
      mainDebate.intensity || 'adversarial'
    );

    if (subDebateResult.error) {
      return { error: `Error creando sub-debate: ${subDebateResult.error}` };
    }

    // Join participants to sub-debate
    const members = [];
    for (const participant of groupMembers) {
      const joinResult = dm.joinDebate(subDebateResult.id, participant.name, participant.role);
      if (!joinResult.error) {
        members.push({
          name: participant.name,
          role: participant.role,
          status: 'pending',
        });
      }
    }

    groups.push({
      groupId: `group-${debateId}-${i + 1}`,
      mainDebateId: debateId,
      subDebateId: subDebateResult.id,
      groupNumber: i + 1,
      totalGroups: groupCount,
      topic: subtopic,
      members,
      status: 'active',
      createdAt: new Date().toISOString(),
      currentRound: 0,
      maxRounds: mainDebate.maxRounds || 10,
    });
  }

  // Store group configuration in state
  pipelineState.pipelines[`subgroups-${debateId}`] = {
    type: 'subgroups',
    mainDebateId: debateId,
    groups,
    status: 'active',
    createdAt: new Date().toISOString(),
    synthesized: false,
  };

  savePipelineState();

  return {
    mainDebateId: debateId,
    groupCount,
    groupSize,
    groups: groups.map(g => ({
      groupId: g.groupId,
      subDebateId: g.subDebateId,
      groupNumber: g.groupNumber,
      totalGroups: g.totalGroups,
      topic: g.topic,
      memberCount: g.members.length,
      members: g.members.map(m => ({ name: m.name, role: m.role })),
      status: g.status,
    })),
  };
}

/**
 * Get status of all sub-groups for a main debate
 *
 * @param {string} debateId - Main debate ID
 * @returns {object} Status of all groups, current round, and next steps
 */
function getSubGroupStatus(debateId) {
  const subgroupKey = `subgroups-${debateId}`;
  const config = pipelineState.pipelines[subgroupKey];

  if (!config || config.type !== 'subgroups') {
    return { error: `No hay sub-grupos para el debate ${debateId}` };
  }

  const groups = config.groups.map(group => {
    const subDebate = dm.listDebates().find(d => d.id === group.subDebateId);
    if (!subDebate) {
      return {
        ...group,
        status: 'error',
        message: 'Sub-debate no encontrado',
      };
    }

    const spokenSet = new Set(subDebate.spokenThisRound || []);
    const pending = group.members.filter(m => !spokenSet.has(m.name));

    return {
      groupId: group.groupId,
      groupNumber: group.groupNumber,
      totalGroups: group.totalGroups,
      topic: group.topic,
      status: subDebate.status,
      currentRound: subDebate.currentRound,
      maxRounds: subDebate.maxRounds,
      messageCount: (subDebate.messages || []).length,
      memberCount: group.members.length,
      spokenThisRound: subDebate.participants.length - pending.length,
      pendingParticipants: pending.map(p => p.name),
      lastMessage: subDebate.messages && subDebate.messages.length > 0
        ? {
            participantName: subDebate.messages[subDebate.messages.length - 1].participantName,
            text: subDebate.messages[subDebate.messages.length - 1].text.substring(0, 100) + '...',
          }
        : null,
    };
  });

  // Calculate overall progress
  const allCompleted = groups.every(g => g.status === 'finished');
  const avgRound = groups.reduce((sum, g) => sum + g.currentRound, 0) / groups.length;

  return {
    mainDebateId: debateId,
    groupCount: config.groups.length,
    groups,
    overallStatus: allCompleted ? 'completed' : 'active',
    averageRound: Math.round(avgRound * 10) / 10,
    synthesized: config.synthesized,
    createdAt: config.createdAt,
  };
}

/**
 * Get pending turns for a specific sub-group
 *
 * @param {string} debateId - Main debate ID
 * @param {string} groupId - Group ID
 * @returns {object} Pending turns and next speaker
 */
function getSubGroupTurns(debateId, groupId) {
  const subgroupKey = `subgroups-${debateId}`;
  const config = pipelineState.pipelines[subgroupKey];

  if (!config || config.type !== 'subgroups') {
    return { error: `No hay sub-grupos para el debate ${debateId}` };
  }

  const group = config.groups.find(g => g.groupId === groupId);
  if (!group) {
    return { error: `Grupo ${groupId} no encontrado` };
  }

  const subDebate = dm.listDebates().find(d => d.id === group.subDebateId);
  if (!subDebate) {
    return { error: `Sub-debate del grupo no encontrado` };
  }

  // Get next turn from debate-manager
  const nextTurn = dm.getNextTurn(group.subDebateId);

  if (nextTurn.error) {
    return { error: nextTurn.error };
  }

  return {
    groupId,
    groupNumber: group.groupNumber,
    topic: group.topic,
    subDebateId: group.subDebateId,
    nextTurn,
  };
}

/**
 * Synthesize outputs from all sub-groups into a main summary
 *
 * @param {string} debateId - Main debate ID
 * @returns {object} Synthesis with key findings and consensus points
 */
function synthesizeGroups(debateId) {
  const subgroupKey = `subgroups-${debateId}`;
  const config = pipelineState.pipelines[subgroupKey];

  if (!config || config.type !== 'subgroups') {
    return { error: `No hay sub-grupos para el debate ${debateId}` };
  }

  const groups = config.groups;

  // Check if all groups are finished
  const allFinished = groups.every(g => {
    const subDebate = dm.listDebates().find(d => d.id === g.subDebateId);
    return subDebate && subDebate.status === 'finished';
  });

  if (!allFinished) {
    const stillActive = groups
      .filter(g => {
        const subDebate = dm.listDebates().find(d => d.id === g.subDebateId);
        return subDebate && subDebate.status !== 'finished';
      })
      .map(g => g.groupId);

    return {
      error: `No se puede sintetizar: ${stillActive.length} grupo(s) aún activo(s)`,
      pendingGroups: stillActive,
    };
  }

  // Collect findings from each group
  const findings = groups.map(group => {
    const subDebate = dm.listDebates().find(d => d.id === group.subDebateId);
    if (!subDebate || !subDebate.messages) return null;

    const lastMessages = subDebate.messages.slice(-5);
    const summary = `MESA ${group.groupNumber}: ${lastMessages
      .map(m => `${m.participantName}: ${m.text.substring(0, 80)}...`)
      .join('\n')}`;

    return {
      groupId: group.groupId,
      groupNumber: group.groupNumber,
      topic: group.topic,
      messageCount: subDebate.messages.length,
      lastMessages: lastMessages.map(m => ({
        participantName: m.participantName,
        participantRole: m.participantRole,
        text: m.text.substring(0, 150),
      })),
    };
  }).filter(Boolean);

  // Build synthesis
  const synthesis = {
    mainDebateId: debateId,
    totalGroups: groups.length,
    totalMessages: groups.reduce((sum, g) => {
      const subDebate = dm.listDebates().find(d => d.id === g.subDebateId);
      return sum + (subDebate && subDebate.messages ? subDebate.messages.length : 0);
    }, 0),
    findings,
    synthesisPrompt: `
SÍNTESIS DE SUB-GRUPOS
=====================
${findings.map(f => `
MESA ${f.groupNumber}:
Tema: ${f.topic}
Mensajes: ${f.messageCount}

Puntos clave:
${f.lastMessages.map(m => `- ${m.participantName} (${m.participantRole}): ${m.text.substring(0, 120)}...`).join('\n')}
`).join('\n')}

TAREA DEL COORDINADOR:
1. Identifica los puntos de consenso entre mesas
2. Enumera los temas disputados
3. Extrae las mejores ideas de cada mesa
4. Propón una síntesis final que intégre los hallazgos de todas las mesas
    `,
    createdAt: new Date().toISOString(),
  };

  // Mark as synthesized
  config.synthesized = true;
  savePipelineState();

  return synthesis;
}

/**
 * Merge sub-groups back into main debate context
 *
 * @param {string} debateId - Main debate ID
 * @returns {object} Merged context with all group insights
 */
function mergeGroupsBack(debateId) {
  const mainDebate = dm.listDebates().find(d => d.id === debateId);
  if (!mainDebate) {
    return { error: `Debate principal ${debateId} no existe` };
  }

  const subgroupKey = `subgroups-${debateId}`;
  const config = pipelineState.pipelines[subgroupKey];

  if (!config || config.type !== 'subgroups') {
    return { error: `No hay sub-grupos para el debate ${debateId}` };
  }

  const groups = config.groups;

  // Collect all unique insights from sub-groups
  const allInsights = [];
  const allMessages = [];

  for (const group of groups) {
    const subDebate = dm.listDebates().find(d => d.id === group.subDebateId);
    if (subDebate && subDebate.messages) {
      // Take last few high-value messages from each group
      const recentMessages = subDebate.messages.slice(-10);
      for (const msg of recentMessages) {
        allMessages.push({
          groupNumber: group.groupNumber,
          participantName: msg.participantName,
          participantRole: msg.participantRole,
          text: msg.text,
        });

        // Extract key insights (first 200 chars)
        allInsights.push({
          groupNumber: group.groupNumber,
          from: msg.participantName,
          role: msg.participantRole,
          insight: msg.text.substring(0, 200),
        });
      }
    }
  }

  // Add merged context to main debate
  const contextContent = `
SÍNTESIS INTEGRADA DE MESAS (${groups.length} grupos)
====================================================

${allInsights.map(i => `[MESA ${i.groupNumber}] ${i.from} (${i.role}): ${i.insight}`).join('\n\n')}

TAREA: Usar estos insights para enriquecer el debate principal.
  `.trim();

  dm.addContext(debateId, 'synthesized-subgroups', contextContent, 'synthesis');

  return {
    mainDebateId: debateId,
    groupCount: groups.length,
    totalInsights: allInsights.length,
    totalMessages: allMessages.length,
    contextAdded: true,
    message: `Se integraron ${allInsights.length} insights de ${groups.length} mesas al debate principal`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 2: PIPELINE DE SALAS (ROOM PIPELINE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a pipeline with sequential rooms where output of one becomes input of next
 *
 * @param {string} topic - Main topic for the pipeline
 * @param {array} rooms - Array of room definitions: {name, agentCount, instruction}
 * @returns {object} Pipeline with room IDs and configuration
 */
function createPipeline(topic, rooms = []) {
  if (!topic || topic.trim() === '') {
    return { error: 'El topic no puede estar vacío' };
  }

  if (!Array.isArray(rooms) || rooms.length === 0) {
    return { error: 'Debes proporcionar al menos 1 sala' };
  }

  const pipelineId = `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const pipelineRooms = rooms.map((roomDef, index) => {
    // Validate room definition
    if (!roomDef.name || !roomDef.agentCount) {
      return {
        error: `Sala ${index + 1} incompleta: necesita name y agentCount`,
      };
    }

    // Create room topic: derive from main topic + stage context
    const roomTopic = `${topic} (Sala ${index + 1}/${rooms.length}: ${roomDef.name})`;

    // Create debate for this room
    const debateResult = dm.createDebate(
      roomTopic,
      5, // Default maxRounds for pipeline rooms
      null,
      'adversarial'
    );

    if (debateResult.error) {
      return { error: `Error creando debate para sala: ${debateResult.error}` };
    }

    // Register agents for this room
    const agents = [];
    const agentCount = Math.min(roomDef.agentCount, 10); // Cap at 10 agents

    for (let i = 0; i < agentCount; i++) {
      const agentName = `agente-sala${index + 1}-${i + 1}`;
      const result = dm.joinDebate(debateResult.id, agentName, `experto-${roomDef.name}-${i + 1}`);

      if (!result.error) {
        agents.push({
          name: agentName,
          role: `experto-${roomDef.name}-${i + 1}`,
        });
      }
    }

    return {
      roomId: `room-${pipelineId}-${index + 1}`,
      pipelineId,
      roomNumber: index + 1,
      totalRooms: rooms.length,
      name: roomDef.name,
      debateId: debateResult.id,
      agentCount: agents.length,
      instruction: roomDef.instruction || `Tu rol es ${roomDef.name}. Expresa tu perspectiva detalladamente.`,
      topic: roomTopic,
      agents,
      status: index === 0 ? 'active' : 'waiting', // Only first room is active initially
      round: 0,
      createdAt: new Date().toISOString(),
    };
  });

  // Check for errors in room creation
  const errors = pipelineRooms.filter(r => r.error);
  if (errors.length > 0) {
    return { error: `Error en configuración de salas: ${errors[0].error}` };
  }

  // Store pipeline configuration
  pipelineState.pipelines[pipelineId] = {
    type: 'pipeline',
    pipelineId,
    topic,
    rooms: pipelineRooms,
    status: 'active',
    currentRoomIndex: 0,
    createdAt: new Date().toISOString(),
    outputs: {}, // Will store outputs from each room
  };

  savePipelineState();

  return {
    pipelineId,
    topic,
    roomCount: pipelineRooms.length,
    currentRoom: 0,
    rooms: pipelineRooms.map(r => ({
      roomId: r.roomId,
      roomNumber: r.roomNumber,
      totalRooms: r.totalRooms,
      name: r.name,
      debateId: r.debateId,
      agentCount: r.agentCount,
      status: r.status,
      topic: r.topic,
    })),
    message: `Pipeline "${topic}" creado con ${pipelineRooms.length} sala(s)`,
  };
}

/**
 * Get overall status of a pipeline
 *
 * @param {string} pipelineId - Pipeline ID
 * @returns {object} Status of all rooms and overall progress
 */
function getPipelineStatus(pipelineId) {
  const config = pipelineState.pipelines[pipelineId];

  if (!config || config.type !== 'pipeline') {
    return { error: `Pipeline ${pipelineId} no encontrado` };
  }

  const rooms = config.rooms.map((room, index) => {
    const debate = dm.listDebates().find(d => d.id === room.debateId);

    if (!debate) {
      return {
        ...room,
        status: 'error',
        message: 'Debate no encontrado',
      };
    }

    const spokenSet = new Set(debate.spokenThisRound || []);
    const pending = room.agents.filter(a => !spokenSet.has(a.name));

    return {
      roomId: room.roomId,
      roomNumber: room.roomNumber,
      name: room.name,
      debateId: room.debateId,
      status: debate.status === 'finished' ? 'completed' : (index === config.currentRoomIndex ? 'active' : 'waiting'),
      currentRound: debate.currentRound,
      maxRounds: debate.maxRounds,
      messageCount: (debate.messages || []).length,
      agentCount: room.agentCount,
      spokenThisRound: debate.participants.length - pending.length,
      pendingParticipants: pending.map(a => a.name),
      topic: room.topic,
    };
  });

  const completedRooms = rooms.filter(r => r.status === 'completed').length;

  return {
    pipelineId,
    topic: config.topic,
    roomCount: config.rooms.length,
    currentRoomIndex: config.currentRoomIndex,
    rooms,
    overallStatus: completedRooms === config.rooms.length ? 'completed' : 'active',
    completedRooms,
    createdAt: config.createdAt,
  };
}

/**
 * Get specific room debate from pipeline
 *
 * @param {string} pipelineId - Pipeline ID
 * @param {number} roomIndex - Room index (0-based)
 * @returns {object} Debate details and next turns
 */
function getPipelineRoom(pipelineId, roomIndex) {
  const config = pipelineState.pipelines[pipelineId];

  if (!config || config.type !== 'pipeline') {
    return { error: `Pipeline ${pipelineId} no encontrado` };
  }

  if (roomIndex < 0 || roomIndex >= config.rooms.length) {
    return { error: `Índice de sala inválido: ${roomIndex}. El pipeline tiene ${config.rooms.length} salas.` };
  }

  const room = config.rooms[roomIndex];
  const debate = dm.listDebates().find(d => d.id === room.debateId);

  if (!debate) {
    return { error: `Debate de la sala ${roomIndex + 1} no encontrado` };
  }

  // Get next turn
  const nextTurn = dm.getNextTurn(room.debateId);

  return {
    pipelineId,
    roomNumber: roomIndex + 1,
    roomName: room.name,
    debateId: room.debateId,
    topic: room.topic,
    agentCount: room.agentCount,
    currentRound: debate.currentRound,
    messageCount: (debate.messages || []).length,
    status: debate.status,
    nextTurn: nextTurn.error ? null : nextTurn,
    recentMessages: debate.messages && debate.messages.length > 0
      ? debate.messages.slice(-3).map(m => ({
          participantName: m.participantName,
          participantRole: m.participantRole,
          text: m.text.substring(0, 150),
        }))
      : [],
  };
}

/**
 * Advance pipeline to next room, passing output from current room as context to next
 *
 * @param {string} pipelineId - Pipeline ID
 * @returns {object} Status of newly activated room
 */
function advancePipeline(pipelineId) {
  const config = pipelineState.pipelines[pipelineId];

  if (!config || config.type !== 'pipeline') {
    return { error: `Pipeline ${pipelineId} no encontrado` };
  }

  const currentRoomIndex = config.currentRoomIndex;
  const currentRoom = config.rooms[currentRoomIndex];
  const currentDebate = dm.listDebates().find(d => d.id === currentRoom.debateId);

  if (!currentDebate) {
    return { error: `Debate actual no encontrado` };
  }

  // Check if current room is finished
  if (currentDebate.status !== 'finished') {
    return {
      error: `La sala ${currentRoomIndex + 1} no está completa`,
      message: `Completa la sala "${currentRoom.name}" antes de avanzar`,
      currentRoom: currentRoomIndex + 1,
      totalRooms: config.rooms.length,
    };
  }

  // Check if there's a next room
  if (currentRoomIndex >= config.rooms.length - 1) {
    return {
      error: 'El pipeline ya está completo',
      message: 'Todas las salas han sido completadas',
      totalRooms: config.rooms.length,
    };
  }

  // Extract output from current room
  const currentMessages = (currentDebate.messages || []).slice(-10);
  const output = `
SALA ${currentRoomIndex + 1} COMPLETADA: ${currentRoom.name}
${'='.repeat(50)}

Hallazgos principales:
${currentMessages.map(m => `- ${m.participantName}: ${m.text.substring(0, 100)}...`).join('\n')}

Esta información será el punto de partida para la siguiente sala.
  `.trim();

  // Store output
  config.outputs[currentRoomIndex] = {
    roomNumber: currentRoomIndex + 1,
    roomName: currentRoom.name,
    messageCount: currentMessages.length,
    output,
    completedAt: new Date().toISOString(),
  };

  // Move to next room
  const nextRoomIndex = currentRoomIndex + 1;
  const nextRoom = config.rooms[nextRoomIndex];

  // Add context from current room to next room
  dm.addContext(
    nextRoom.debateId,
    `input-from-sala-${currentRoomIndex + 1}`,
    output,
    'pipeline-input'
  );

  // Update pipeline state
  config.currentRoomIndex = nextRoomIndex;
  config.rooms[nextRoomIndex].status = 'active';
  config.rooms[currentRoomIndex].status = 'completed';

  savePipelineState();

  // Get first turn of new room
  const firstTurn = dm.getNextTurn(nextRoom.debateId);

  return {
    pipelineId,
    previousRoomNumber: currentRoomIndex + 1,
    previousRoomName: currentRoom.name,
    currentRoomNumber: nextRoomIndex + 1,
    currentRoomName: nextRoom.name,
    totalRooms: config.rooms.length,
    status: 'advanced',
    contextPassed: true,
    nextTurn: firstTurn.error ? null : firstTurn,
    message: `Pipeline avanzó: Sala ${currentRoomIndex + 1} (${currentRoom.name}) → Sala ${nextRoomIndex + 1} (${nextRoom.name})`,
  };
}

module.exports = {
  // Sub-Groups (Mesas)
  createSubGroups,
  getSubGroupStatus,
  getSubGroupTurns,
  synthesizeGroups,
  mergeGroupsBack,

  // Pipeline de Salas
  createPipeline,
  getPipelineStatus,
  getPipelineRoom,
  advancePipeline,

  // Persistence
  savePipelineStateNow,
};
