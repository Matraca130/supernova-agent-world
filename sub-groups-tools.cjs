/**
 * Sub-Groups and Pipeline Tools for MCP
 *
 * Registers MCP tools for orchestrating sub-groups (mesas) and sequential room pipelines.
 * These tools extend the debate system to support:
 * - Splitting large debates into parallel sub-groups
 * - Synthesizing findings across sub-groups
 * - Creating sequential room pipelines with output flowing to next room
 */

const sg = require('./sub-groups.cjs');
const dm = require('./debate-manager.cjs');
const mt = require('./micro-topics.cjs');

/**
 * Register all sub-group and pipeline tools with the MCP server
 *
 * @param {McpServer} server - The MCP server instance
 * @param {z} z - Zod schema validation
 */
function registerSubGroupTools(server, z) {
  // ── CREAR SUB-GRUPOS (Split large debate into parallel mesas) ──────────

  server.tool(
    'crear_sub_grupos',
    `Divide un debate en sub-grupos (mesas) que debaten en paralelo sobre el mismo tema desde perspectivas diferentes.

CUÁNDO USAR:
- Cuando hay 6+ participantes en el debate
- Quieres que debatan en grupos pequeños (3-5 agentes) para profundizar
- Después puedes sintetizar los hallazgos

EJEMPLO:
- 12 participantes + tamaño de grupo 4 = 3 mesas debatiendo en paralelo
- Cada mesa hace su propio debate completo
- Al final sintetizas hallazgos comunes y discrepancias`,
    {
      debate_id: z.string().describe('ID del debate principal con 6+ participantes'),
      tamaño_grupo: z.number().optional().default(4).describe('Tamaño de cada mesa (3-5 típicamente)'),
    },
    async ({ debate_id, tamaño_grupo }) => {
      const result = sg.createSubGroups(debate_id, tamaño_grupo);

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `✅ Sub-grupos creados para debate "${debate_id}"\n\n`;
      text += `📊 ESTADÍSTICAS:\n`;
      text += `  ${result.groupCount} mesas creadas\n`;
      text += `  ${result.groupSize} agentes por mesa\n\n`;

      text += `🎯 MESAS:\n`;
      for (const group of result.groups) {
        text += `\n  MESA ${group.groupNumber}/${group.totalGroups}:\n`;
        text += `    ID: ${group.subDebateId}\n`;
        text += `    Tema: ${group.topic.substring(0, 80)}...\n`;
        text += `    Integrantes (${group.memberCount}):\n`;
        for (const member of group.members) {
          text += `      • ${member.name} (${member.role})\n`;
        }
      }

      text += `\n💡 PRÓXIMOS PASOS:\n`;
      text += `  1. Usa "estado_sub_grupos" para monitorear el progreso\n`;
      text += `  2. Usa "leer" en cada subDebateId para ver las discusiones\n`;
      text += `  3. Cuando todas las mesas terminen, usa "sintetizar_grupos"\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── ESTADO SUB-GRUPOS (Monitor status of all groups) ─────────────────

  server.tool(
    'estado_sub_grupos',
    `Monitorea el estado actual de TODOS los sub-grupos de un debate principal.

Muestra:
- Número de ronda actual en cada mesa
- Quién ya habló y quién está esperando
- Mensajes acumulados por mesa
- Progreso general del grupo`,
    {
      debate_id: z.string().describe('ID del debate principal'),
    },
    async ({ debate_id }) => {
      const result = sg.getSubGroupStatus(debate_id);

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `📊 ESTADO DE SUB-GRUPOS — Debate "${debate_id}"\n\n`;
      text += `🏆 RESUMEN:\n`;
      text += `  Total de mesas: ${result.groupCount}\n`;
      text += `  Estado general: ${result.overallStatus.toUpperCase()}\n`;
      text += `  Ronda promedio: ${result.averageRound}\n`;
      text += `  Sintetizado: ${result.synthesized ? 'SÍ ✓' : 'NO (aún)'}\n\n`;

      text += `🎯 DETALLE POR MESA:\n`;
      for (const group of result.groups) {
        text += `\n  MESA ${group.groupNumber}/${result.groupCount}: ${group.status.toUpperCase()}\n`;
        text += `    Ronda: ${group.currentRound}/${group.maxRounds}\n`;
        text += `    Mensajes: ${group.messageCount}\n`;
        text += `    Hablaron: ${group.spokenThisRound}/${group.memberCount}\n`;

        if (group.pendingParticipants.length > 0) {
          text += `    ⏳ Esperando: ${group.pendingParticipants.join(', ')}\n`;
        } else {
          text += `    ✓ Todos hablaron esta ronda\n`;
        }

        if (group.lastMessage) {
          text += `    Último: ${group.lastMessage.participantName}: "${group.lastMessage.text}"\n`;
        }
      }

      text += `\n💡 ACCIONES:\n`;
      if (result.overallStatus !== 'completed') {
        text += `  • Continúa monitoreando con "estado_sub_grupos"\n`;
      }
      if (result.synthesized) {
        text += `  • Las mesas ya fueron sintetizadas\n`;
      } else if (result.overallStatus === 'completed') {
        text += `  • Todas las mesas completaron → Usa "sintetizar_grupos"\n`;
      }

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── SINTETIZAR GRUPOS (Synthesize all group outputs) ────────────────

  server.tool(
    'sintetizar_grupos',
    `Sintetiza los hallazgos y consensos de todas las mesas después de que completen su debate.

CÓMO FUNCIONA:
1. Recopila los últimos mensajes de cada mesa
2. Identifica puntos de consenso y divergencias
3. Genera un prompt para que un coordinador integre los hallazgos
4. Opcionalmente, añade la síntesis como contexto al debate principal

REQUIERE: Todas las mesas deben estar FINALIZADAS`,
    {
      debate_id: z.string().describe('ID del debate principal (que tiene sub-grupos)'),
    },
    async ({ debate_id }) => {
      const result = sg.synthesizeGroups(debate_id);

      if (result.error) {
        let text = `❌ No se puede sintetizar aún: ${result.error}\n\n`;
        if (result.pendingGroups) {
          text += `⏳ Grupos aún activos:\n`;
          for (const groupId of result.pendingGroups) {
            text += `  • ${groupId}\n`;
          }
        }
        return { content: [{ type: 'text', text }] };
      }

      let text = `✅ SÍNTESIS GENERADA\n\n`;
      text += `📊 ESTADÍSTICAS:\n`;
      text += `  Mesas síntesizadas: ${result.totalGroups}\n`;
      text += `  Mensajes totales: ${result.totalMessages}\n\n`;

      text += `🎯 HALLAZGOS POR MESA:\n`;
      for (const finding of result.findings) {
        text += `\n  MESA ${finding.groupNumber}:\n`;
        text += `    Tema: ${finding.topic.substring(0, 80)}...\n`;
        text += `    Mensajes: ${finding.messageCount}\n`;
        text += `    Últimos puntos:\n`;
        for (const msg of finding.lastMessages) {
          text += `      • [${msg.participantName}|${msg.participantRole}]: ${msg.text.substring(0, 80)}...\n`;
        }
      }

      text += `\n📝 PROMPT DE SÍNTESIS:\n`;
      text += '```\n' + result.synthesisPrompt.substring(0, 500) + '...\n```\n';

      text += `\n💡 PRÓXIMOS PASOS:\n`;
      text += `  1. Copia el PROMPT DE SÍNTESIS anterior\n`;
      text += `  2. Usa "unirse" para que un coordinador se una al debate principal\n`;
      text += `  3. Que el coordinador use "decir" con el prompt de síntesis\n`;
      text += `  4. Luego usa "fusionar_grupos" para integrar aprendizajes al debate principal\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── CREAR PIPELINE (Create sequential room pipeline) ──────────────────

  server.tool(
    'crear_pipeline',
    `Crea un "Pipeline de Salas" — un debate secuencial donde:
1. SALA 1 debate el tema y genera hallazgos
2. SALA 2 recibe los hallazgos de Sala 1 como entrada y profundiza
3. SALA 3 recibe input de Sala 2 y propone soluciones
... y así sucesivamente

EJEMPLO TÍPICO:
Tema: "Mejora de educación técnica"
- Sala 1 (Detección): Identifica problemas en educación técnica actual
- Sala 2 (Análisis): Analiza causas raíz de los problemas encontrados
- Sala 3 (Soluciones): Propone alternativas basadas en hallazgos previos

VENTAJA: Cada sala está "informada" por la anterior, creando un flujo lógico`,
    {
      tema: z.string().describe('Tema principal del pipeline'),
      salas: z.array(
        z.object({
          nombre: z.string().describe('Nombre de la sala (ej: "Detección", "Análisis", "Soluciones")'),
          cantidad_agentes: z.number().describe('Número de agentes en esta sala (típicamente 3-5)'),
          instruccion: z.string().optional().describe('Instrucción específica para esta sala'),
        })
      ).describe('Array de definiciones de salas. MÍNIMO 2 salas.'),
    },
    async ({ tema, salas }) => {
      // Transform input to match function signature
      const roomsFormatted = salas.map(s => ({
        name: s.nombre,
        agentCount: s.cantidad_agentes,
        instruction: s.instruccion,
      }));

      const result = sg.createPipeline(tema, roomsFormatted);

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `✅ PIPELINE CREADO: "${tema}"\n\n`;
      text += `📊 CONFIGURACIÓN:\n`;
      text += `  ID: ${result.pipelineId}\n`;
      text += `  Total de salas: ${result.roomCount}\n`;
      text += `  Sala activa: ${result.currentRoom + 1}\n\n`;

      text += `🚀 SALAS:\n`;
      for (const room of result.rooms) {
        text += `\n  SALA ${room.roomNumber}/${room.totalRooms}: ${room.name}\n`;
        text += `    Debate ID: ${room.debateId}\n`;
        text += `    Agentes: ${room.agentCount}\n`;
        text += `    Estado: ${room.status}\n`;
        text += `    Tema: ${room.topic.substring(0, 70)}...\n`;
      }

      text += `\n💡 PRÓXIMOS PASOS:\n`;
      text += `  1. Usa "leer" con el debateId de Sala 1 para ver discusiones\n`;
      text += `  2. Cuando Sala 1 termine, usa "avanzar_pipeline" para pasar a Sala 2\n`;
      text += `  3. El output de Sala 1 se pasa automáticamente como contexto a Sala 2\n`;
      text += `  4. Repite para cada sala hasta completar el pipeline\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── ESTADO PIPELINE (Monitor pipeline status) ──────────────────────

  server.tool(
    'estado_pipeline',
    `Monitorea el estado actual de un pipeline de salas.

Muestra:
- Cuál es la sala activa
- Progreso en cada sala (ronda, mensajes, participantes)
- Salas completadas vs. pendientes
- Tiempo para avanzar a la siguiente sala`,
    {
      pipeline_id: z.string().describe('ID del pipeline'),
    },
    async ({ pipeline_id }) => {
      const result = sg.getPipelineStatus(pipeline_id);

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `📊 ESTADO DEL PIPELINE\n`;
      text += `Tema: "${result.topic}"\n`;
      text += `Estado general: ${result.overallStatus.toUpperCase()}\n\n`;

      text += `🚀 SALAS (${result.completedRooms}/${result.roomCount} completadas):\n`;
      for (const room of result.rooms) {
        const icon = room.status === 'completed' ? '✅' : (room.status === 'active' ? '🔥' : '⏳');
        text += `\n  ${icon} SALA ${room.roomNumber}/${result.roomCount}: ${room.name}\n`;
        text += `    Estado: ${room.status.toUpperCase()}\n`;
        text += `    Ronda: ${room.currentRound}/${room.maxRounds}\n`;
        text += `    Mensajes: ${room.messageCount}\n`;
        text += `    Agentes: ${room.spokenThisRound}/${room.agentCount} hablaron\n`;

        if (room.pendingParticipants.length > 0) {
          text += `    ⏳ Esperando: ${room.pendingParticipants.join(', ')}\n`;
        }
      }

      text += `\n💡 ACCIONES:\n`;
      const activeRoom = result.rooms.find(r => r.status === 'active');
      if (activeRoom) {
        if (activeRoom.spokenThisRound < activeRoom.agentCount) {
          text += `  • La Sala ${activeRoom.roomNumber} aún está en progreso\n`;
          text += `  • Faltan: ${activeRoom.pendingParticipants.join(', ')}\n`;
        } else {
          text += `  • Sala ${activeRoom.roomNumber} lista para avanzar\n`;
          text += `  • Usa "avanzar_pipeline" para pasar a Sala ${activeRoom.roomNumber + 1}\n`;
        }
      }

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── AVANZAR PIPELINE (Advance to next room) ──────────────────────────

  server.tool(
    'avanzar_pipeline',
    `Avanza el pipeline a la siguiente sala, pasando el output de la sala actual como contexto/conocimiento a la siguiente.

REQUISITO: La sala actual DEBE estar completada (todos hablaron)

QUÉ SUCEDE:
1. Extrae los últimos hallazgos de la sala actual
2. Los añade como "CONOCIMIENTO PREVIO" a la siguiente sala
3. Activa la siguiente sala para que debata
4. Si no hay más salas, marca el pipeline como COMPLETADO`,
    {
      pipeline_id: z.string().describe('ID del pipeline'),
    },
    async ({ pipeline_id }) => {
      const result = sg.advancePipeline(pipeline_id);

      if (result.error) {
        let text = `❌ Error: ${result.error}\n`;
        if (result.message) {
          text += `\n${result.message}\n`;
        }
        return { content: [{ type: 'text', text }] };
      }

      let text = `✅ PIPELINE AVANZADO\n\n`;
      text += `📍 TRANSICIÓN:\n`;
      text += `  De: Sala ${result.previousRoomNumber} — ${result.previousRoomName}\n`;
      text += `  A:  Sala ${result.currentRoomNumber} — ${result.currentRoomName}\n`;
      text += `  Progreso: ${result.currentRoomNumber}/${result.totalRooms}\n\n`;

      text += `✓ Output de Sala ${result.previousRoomNumber} agregado como contexto\n\n`;

      if (result.nextTurn) {
        text += `🎯 PRÓXIMO TURNO:\n`;
        text += `  Agente: ${result.nextTurn.agent.name}\n`;
        text += `  Rol: ${result.nextTurn.agent.role}\n`;
        text += `  Fase: ${result.nextTurn.phase ? result.nextTurn.phase : 'N/A'}\n`;
      }

      text += `\n💡 PRÓXIMOS PASOS:\n`;
      text += `  • Usa "leer" para ver el contexto de Sala ${result.currentRoomNumber}\n`;
      text += `  • Coordina con los agentes de Sala ${result.currentRoomNumber} para que comiencen\n`;
      text += `  • Cuando terminen, usa "avanzar_pipeline" de nuevo (o "estado_pipeline" para monitorear)\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── GET PIPELINE ROOM (Detailed room info) ────────────────────────────

  server.tool(
    'sala_pipeline',
    `Obtén información detallada de una sala específica dentro de un pipeline.

Muestra:
- Todos los agentes y sus roles
- Historial reciente (últimos mensajes)
- Próximo turno
- Estado actual`,
    {
      pipeline_id: z.string().describe('ID del pipeline'),
      numero_sala: z.number().describe('Número de sala (1, 2, 3, ...)'),
    },
    async ({ pipeline_id, numero_sala }) => {
      const roomIndex = numero_sala - 1;
      const result = sg.getPipelineRoom(pipeline_id, roomIndex);

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `🚀 SALA ${result.roomNumber} — ${result.roomName}\n`;
      text += `Pipeline: ${result.pipelineId}\n`;
      text += `Estado: ${result.status.toUpperCase()}\n\n`;

      text += `📊 ESTADÍSTICAS:\n`;
      text += `  Debate ID: ${result.debateId}\n`;
      text += `  Agentes: ${result.agentCount}\n`;
      text += `  Ronda actual: ${result.currentRound}\n`;
      text += `  Mensajes acumulados: ${result.messageCount}\n\n`;

      text += `📝 ÚLTIMOS MENSAJES:\n`;
      if (result.recentMessages.length > 0) {
        for (const msg of result.recentMessages) {
          text += `  [${msg.participantName}|${msg.participantRole}]:\n`;
          text += `    "${msg.text}"\n\n`;
        }
      } else {
        text += `  (Sin mensajes aún)\n`;
      }

      if (result.nextTurn) {
        text += `🎯 PRÓXIMO TURNO:\n`;
        text += `  Agente: ${result.nextTurn.agent.name}\n`;
        text += `  Rol: ${result.nextTurn.agent.role}\n`;
      }

      return { content: [{ type: 'text', text }] };
    }
  );
  // ════════════════════════════════════════════════════════════════════════
  // MICRO-TOPICS: Divide & Conquer for 10-Agent Debates
  // ════════════════════════════════════════════════════════════════════════

  // ── CREATE TOPIC TREE ────────────────────────────────────────────────────

  server.tool(
    'crear_arbol_temas',
    `Crea un ÁRBOL DE TEMAS para divide & conquer.

PARA QUÉ: Cuando tienes un tema grande y 6-10+ agentes, dividirlo en subtemas
que se debaten en MICRO-DEBATES paralelos (rápidos, 2-3 rondas, 2-4 agentes cada uno).

FLUJO:
1. crear_arbol_temas → Crea el árbol
2. sugerir_descomposicion → Sugiere cómo dividir el tema
3. spawn_subtema → Crea micro-debates para cada subtema
4. Los agentes debaten cada subtema rápidamente
5. sintetizar_arbol → Fusiona todas las conclusiones

VENTAJA: 10 agentes trabajan en paralelo en subtemas focalizados en vez de
hablar todos del mismo tema grande.`,
    {
      debate_id: z.string().describe('ID del debate principal'),
    },
    async ({ debate_id }) => {
      // Get debate info
      const debates = dm.listDebates ? dm.listDebates() : [];
      const debate = debates.find(d => d.id === debate_id);
      if (!debate) {
        return { content: [{ type: 'text', text: `❌ Debate ${debate_id} no encontrado` }] };
      }

      const result = mt.createTopicTree(
        debate_id,
        debate.topic,
        debate.participants || []
      );

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `✅ ÁRBOL DE TEMAS CREADO\n\n`;
      text += `🌳 Tree ID: ${result.treeId}\n`;
      text += `📋 Tema: ${result.mainTopic}\n`;
      text += `👥 Agentes: ${result.participantCount}\n\n`;
      text += `💡 PRÓXIMOS PASOS:\n`;
      text += `  1. Usa "sugerir_descomposicion" para obtener subtemas sugeridos\n`;
      text += `  2. O usa "spawn_subtema" directamente si ya sabes los subtemas\n`;
      text += `  3. Cuando todos terminen, usa "sintetizar_arbol" para fusionar conclusiones\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── SUGGEST DECOMPOSITION ────────────────────────────────────────────────

  server.tool(
    'sugerir_descomposicion',
    `Sugiere cómo descomponer un tema grande en subtemas micro.

Genera 3-5 subtemas focalizados con agentes asignados para cada uno.
Puedes usar las sugerencias directamente con "spawn_subtema" o modificarlas.`,
    {
      debate_id: z.string().describe('ID del debate principal'),
    },
    async ({ debate_id }) => {
      const debates = dm.listDebates ? dm.listDebates() : [];
      const debate = debates.find(d => d.id === debate_id);
      if (!debate) {
        return { content: [{ type: 'text', text: `❌ Debate ${debate_id} no encontrado` }] };
      }

      const result = mt.suggestDecomposition(
        debate.topic,
        debate.participants || []
      );

      let text = `🔬 DESCOMPOSICIÓN SUGERIDA\n\n`;
      text += `📋 Tema principal: ${result.mainTopic}\n`;
      text += `📊 ${result.subtopicCount} subtemas × ${result.agentsPerSubtopic} agentes/subtema\n\n`;

      for (const s of result.suggestions) {
        text += `\n  🎯 ${s.subtopic}\n`;
        text += `     ${s.description}\n`;
        text += `     👥 Agentes: ${s.suggestedAgents.join(', ')}\n`;
        text += `     ⏱️ Rondas: ${s.suggestedRounds}\n`;
      }

      text += `\n\n💡 Usa "spawn_subtema" con tree_id para crear cada micro-debate.\n`;
      text += `   Los agentes pueden debatir subtemas EN PARALELO.\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── SPAWN SUBTOPIC ───────────────────────────────────────────────────────

  server.tool(
    'spawn_subtema',
    `Crea un MICRO-DEBATE focalizado en un subtema específico.

CARACTERÍSTICAS:
- Rápido: 2-3 rondas (no 10)
- Focalizado: Solo el subtema, no el tema completo
- Pequeño: 2-4 agentes (no todos)
- Orientado a conclusiones: Cada mensaje debe llegar a una conclusión parcial

Puede crear subtemas ANIDADOS: un subtema puede generar sub-subtemas.`,
    {
      tree_id: z.string().describe('ID del árbol de temas (de crear_arbol_temas)'),
      subtema: z.string().describe('El subtema específico a debatir'),
      agentes: z.array(z.string()).describe('Nombres de los agentes que participarán (2-4)'),
      rondas: z.number().optional().default(3).describe('Máximo de rondas (default: 3)'),
      parent_subtema_id: z.string().optional().describe('ID del subtema padre (para anidamiento)'),
    },
    async ({ tree_id, subtema, agentes, rondas, parent_subtema_id }) => {
      const result = mt.spawnSubtopic(tree_id, subtema, agentes, {
        maxRounds: rondas,
        intensity: 'micro',
        parentSubtopicId: parent_subtema_id || null,
      });

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `✅ MICRO-DEBATE CREADO\n\n`;
      text += `🔬 Subtema: ${result.topic}\n`;
      text += `📋 Subtopic ID: ${result.subtopicId}\n`;
      text += `🎯 Debate ID: ${result.debateId}\n`;
      text += `👥 Agentes: ${result.agents.join(', ')}\n`;
      text += `⏱️ Rondas: ${result.maxRounds}\n`;
      if (result.parentSubtopicId) {
        text += `🔗 Derivado de: ${result.parentSubtopicId}\n`;
      }
      text += `\n💡 Los agentes deben hacer onboarding y debatir en el debate ${result.debateId}.\n`;
      text += `   Recuerda: es un MICRO-debate. Rápido, focalizado, con conclusiones.\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── TREE STATUS ──────────────────────────────────────────────────────────

  server.tool(
    'estado_arbol',
    `Muestra el estado completo del árbol de micro-debates.

Incluye:
- Vista en árbol visual
- Subtemas activos vs completados
- Conclusiones parciales
- Si está listo para síntesis final`,
    {
      tree_id: z.string().describe('ID del árbol de temas'),
    },
    async ({ tree_id }) => {
      const result = mt.getTreeStatus(tree_id);

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `🌳 ESTADO DEL ÁRBOL DE TEMAS\n\n`;
      text += `📋 Tema: ${result.mainTopic}\n`;
      text += `📊 Estado: ${result.status.toUpperCase()}\n`;
      text += `📈 Progreso: ${result.stats.completedSubtopics}/${result.stats.totalSubtopics} subtemas\n`;
      text += `💬 Mensajes totales: ${result.stats.totalMessages}\n`;
      text += `🎯 Listo para síntesis: ${result.readyForSynthesis ? 'SÍ ✓' : 'NO (subtemas activos)'}\n\n`;

      text += `🌿 VISTA EN ÁRBOL:\n`;
      text += result.treeView + '\n\n';

      if (result.readyForSynthesis) {
        text += `\n💡 ¡Todos los subtemas completados! Usa "sintetizar_arbol" para fusionar conclusiones.\n`;
      } else {
        const activeOnes = result.subtopics.filter(s => s.status === 'active');
        if (activeOnes.length > 0) {
          text += `\n⏳ SUBTEMAS ACTIVOS:\n`;
          for (const s of activeOnes) {
            text += `  🔄 ${s.topic} (debate: ${s.debateId}, agentes: ${s.agents.join(', ')})\n`;
          }
        }
      }

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── SYNTHESIZE TREE ──────────────────────────────────────────────────────

  server.tool(
    'sintetizar_arbol',
    `Fusiona TODAS las conclusiones de los micro-debates en una síntesis final.

REQUIERE: Todos los subtemas deben estar completados.

QUÉ HACE:
1. Auto-concluye cualquier micro-debate terminado
2. Recopila todas las conclusiones
3. Las ordena por confianza
4. Genera una síntesis integrada
5. La añade como contexto al debate principal`,
    {
      tree_id: z.string().describe('ID del árbol de temas'),
    },
    async ({ tree_id }) => {
      const result = mt.synthesizeTree(tree_id);

      if (result.error) {
        let text = `❌ ${result.error}\n`;
        if (result.activeSubtopics) {
          text += `\n⏳ Subtemas aún activos:\n`;
          for (const s of result.activeSubtopics) {
            text += `  • ${s.topic} (debate: ${s.debateId})\n`;
          }
        }
        return { content: [{ type: 'text', text }] };
      }

      let text = `✅ SÍNTESIS COMPLETA\n\n`;
      text += `📋 Tema: ${result.mainTopic}\n`;
      text += `📊 Subtemas analizados: ${result.subtopicsAnalyzed}\n`;
      text += `💬 Mensajes totales: ${result.totalMessages}\n`;
      text += `📌 Contexto añadido al debate: ${result.mainDebateId}\n\n`;

      text += `🏆 TOP CONCLUSIONES (por confianza):\n`;
      for (const c of result.topConclusions) {
        text += `  [${((c.confidence || 0) * 100).toFixed(0)}%] ${c.topic}\n`;
        text += `     → ${c.conclusion || '(implícita)'}\n\n`;
      }

      text += `\n📝 SÍNTESIS COMPLETA AÑADIDA AL DEBATE PRINCIPAL.\n`;
      text += `Los agentes ahora pueden ver las conclusiones integradas.\n`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── CONCLUDE SUBTOPIC ────────────────────────────────────────────────────

  server.tool(
    'concluir_subtema',
    `Concluye manualmente un micro-debate y extrae sus conclusiones.

Normalmente los micro-debates se auto-concluyen, pero puedes forzar
la conclusión si crees que ya se dijo lo necesario.`,
    {
      tree_id: z.string().describe('ID del árbol de temas'),
      subtema_id: z.string().describe('ID del subtema a concluir'),
    },
    async ({ tree_id, subtema_id }) => {
      const result = mt.concludeSubtopic(tree_id, subtema_id);

      if (result.error) {
        return { content: [{ type: 'text', text: `❌ Error: ${result.error}` }] };
      }

      let text = `✅ SUBTEMA CONCLUIDO\n\n`;
      text += `🔬 ${result.topic}\n`;
      text += `📊 Mensajes: ${result.messageCount}\n`;
      text += `🎯 Conclusiones: ${result.conclusionCount}\n`;
      text += `📈 Confianza: ${((result.confidence || 0) * 100).toFixed(0)}%\n`;
      text += `📋 Progreso: ${result.treeProgress}\n\n`;

      if (result.conclusions.length > 0) {
        text += `📌 CONCLUSIONES:\n`;
        for (const c of result.conclusions) {
          text += `  • [${c.author}] ${c.text}\n`;
        }
      }

      return { content: [{ type: 'text', text }] };
    }
  );
}

module.exports = { registerSubGroupTools };
