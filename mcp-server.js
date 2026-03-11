#!/usr/bin/env node

/**
 * MCP Server v3 — Multi-Agent Debate con Fases, Intensidad, Roles Antagonistas
 *
 * Expone el sistema de debates como un MCP server.
 * Cualquier IA compatible con MCP puede conectarse y participar.
 *
 * DOS MODOS:
 *   node mcp-server.js                → stdio (para Claude Desktop config)
 *   node mcp-server.js --http 3000    → HTTP/SSE en http://localhost:3000
 *
 * Tools: iniciar_debate, unirse, decir, leer, avanzar_ronda, finalizar, debates, estado, roles
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createRequire } from 'module';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Bridge ESM → CJS
const require = createRequire(import.meta.url);
const dm = require('./debate-manager.cjs');
const validators = require('./validators.cjs');
const sgTools = require('./sub-groups-tools.cjs');
const orchestrator = require('./orchestrator-engine.cjs');

// ── Parse args ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = 'stdio';
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--http' || args[i] === '--sse') {
      mode = 'http';
      if (args[i + 1] && !isNaN(args[i + 1])) {
        port = parseInt(args[++i], 10);
      }
    }
  }
  return { mode, port };
}

// Active orchestrations for SSE streaming
const activeOrchestrations = new Map();
const orchClients = new Set();

function broadcastOrchEvent(event) {
  const data = JSON.stringify(event);
  for (const client of orchClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// ── Registrar tools en un McpServer ──────────────────────────────────────

function registerTools(server) {

  // ── ONBOARDING ──────────────────────────────────────────────────────
  server.tool(
    'onboarding',
    `🚀 LLAMA ESTO PRIMERO. Te asigna un rol automáticamente en el debate activo.
Recibirás: tu rol, qué hacer, qué tools usar, estado actual del debate.
Solo necesitas dar tu nombre — el sistema hace el resto.
Si no hay debate activo, te dice cómo crear uno.`,
    {
      agent_name: z.string().describe('Tu nombre único (ej: "claude-opus-1", "gemini-pro", "gpt4-review")'),
    },
    async ({ agent_name }) => {
      const result = dm.onboarding(agent_name);
      if (result.error) {
        return { content: [{ type: 'text', text: `❌ ${result.error}\n${result.suggestion || ''}` }] };
      }
      const lines = [
        `🚀 ONBOARDING COMPLETO`,
        `═══════════════════════════════════════`,
        `Nombre: ${result.agent_name}`,
        `Rol: ${result.role}`,
        `Descripción: ${result.role_description}`,
        ``,
        `📋 Debate: ${result.debate_id}`,
        `Tema: ${result.topic}`,
        `Fase: ${result.phase}`,
        `Ronda: ${result.round}`,
        `Intensidad: ${result.intensity}`,
        ``,
        `🛠️ Tus herramientas: ${result.tools_to_use.join(', ')}`,
        ``,
        `⚡ ACCIÓN INMEDIATA:`,
        result.immediate_action,
        ``,
        `👥 Otros participantes: ${result.other_participants.length ? result.other_participants.join(', ') : 'ninguno aún'}`,
        `🪑 Roles disponibles: ${result.available_roles_remaining.length ? result.available_roles_remaining.join(', ') : 'todos asignados'}`,
        ``,
        `🏛️ Gobernanza:`,
        `  Aprobaciones necesarias: ${result.governance.min_approvals}`,
        `  Roles obligatorios: ${result.governance.mandatory_roles.join(', ')}`,
        `  Roles con veto: ${result.governance.veto_roles.join(', ')}`,
        ``,
        `📊 Propuestas: ${result.pending_proposals} pendientes, ${result.approved_proposals} aprobadas`,
      ];
      if (result.phase_instruction) {
        lines.push(``, `📌 Instrucción de fase: ${result.phase_instruction}`);
      }
      lines.push(``, `🔄 IMPORTANTE: Usa "run_debate" para lanzar un debate autónomo completo en el servidor, o usa "decir" para participar manualmente en el debate.`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ── RUN_DEBATE (orquestación autónoma) ─────────────────────────────
  server.tool(
    'run_debate',
    `🚀 EJECUTA UN DEBATE AUTÓNOMO COMPLETO en el servidor.
Una sola llamada ejecuta TODO el debate: crea agentes, genera mensajes via OpenAI API, avanza rondas, y genera síntesis.
NO requiere que los agentes llamen tools repetidamente — el servidor hace todo.

Ideal para: debates largos, análisis profundos, mejora de código.
El debate corre en background y puedes ver el progreso en /dashboard-v2 o /api/orchestrator/events.`,
    {
      situacion: z.enum(['libre', 'identificar_problemas', 'arquitectura', 'ejecucion', 'mejora_codigo']).default('libre').describe('Tipo de situación/workflow'),
      tema: z.string().describe('El tema a debatir'),
      num_agents: z.number().optional().default(4).describe('Número de agentes (2-15)'),
      max_rounds: z.number().optional().default(10).describe('Máximo de rondas (0=auto-detect by repetition)'),
      model: z.string().optional().default('gpt-4o-mini').describe('Modelo OpenAI a usar'),
    },
    async ({ situacion, tema, num_agents, max_rounds, model }) => {
      const debateId = `orch-${Date.now()}`;
      const startTime = Date.now();

      activeOrchestrations.set(debateId, {
        id: debateId,
        status: 'running',
        tema,
        situacion,
        startTime,
        messages: [],
      });

      broadcastOrchEvent({
        type: 'debate_started',
        timestamp: new Date().toISOString(),
        data: { debateId, tema, situacion, num_agents, max_rounds, model },
      });

      try {
        const config = {
          debateId,
          situacion,
          tema,
          numAgents: num_agents,
          maxRounds: max_rounds,
          model,
          onMessage: (msg) => {
            const orch = activeOrchestrations.get(debateId);
            if (orch) orch.messages.push(msg);
            broadcastOrchEvent({
              type: 'message',
              timestamp: new Date().toISOString(),
              data: { debateId, ...msg },
            });
          },
        };

        const result = await orchestrator.runDebate(config);

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const orch = activeOrchestrations.get(debateId);
        if (orch) orch.status = 'completed';

        broadcastOrchEvent({
          type: 'debate_completed',
          timestamp: new Date().toISOString(),
          data: { debateId, duration, totalMessages: result.totalMessages, rounds: result.rounds },
        });

        const synthesisPreview = result.synthesis
          ? result.synthesis.substring(0, 300) + (result.synthesis.length > 300 ? '...' : '')
          : '(sin síntesis)';

        return {
          content: [{
            type: 'text',
            text: `🏁 DEBATE AUTÓNOMO COMPLETADO

Debate ID: ${debateId}
Tema: "${tema}"
Situación: ${situacion}
Modelo: ${model}
Agentes: ${num_agents}
Rondas completadas: ${result.rounds || 'N/A'}
Total mensajes: ${result.totalMessages || 0}
Duración: ${duration}s

📝 SÍNTESIS:
${synthesisPreview}

Ver detalles completos en /dashboard-v2 o /api/orchestrator/events`,
          }],
        };
      } catch (err) {
        const orch = activeOrchestrations.get(debateId);
        if (orch) orch.status = 'error';

        broadcastOrchEvent({
          type: 'debate_error',
          timestamp: new Date().toISOString(),
          data: { debateId, error: err.message },
        });

        return {
          content: [{
            type: 'text',
            text: `❌ Error en debate autónomo: ${err.message}\nDebate ID: ${debateId}`,
          }],
        };
      }
    }
  );

  // ── INICIAR DEBATE ─────────────────────────────────────────────────
  server.tool(
    'iniciar_debate',
    `Crea un debate con FASES estructuradas, roles antagonistas e intensidad configurable.

FASES (auto-calculadas según rondas):
- POSICIONES INICIALES: cada uno presenta su tesis
- CROSS-EXAMINATION: preguntas directas entre participantes
- REBUTTALS: responder objeciones
- VEREDICTO: voto final

INTENSIDAD:
- "casual": conversación libre
- "moderado": requiere al menos 1 desacuerdo por mensaje
- "adversarial" (DEFAULT): prohibido estar de acuerdo, objeciones obligatorias

CONSEJO: Para debates intensos, incluye REGLAS en el tema:
"DEBATE: ¿X es un anti-pattern? REGLAS: Prohibido decir 'de acuerdo' sin contraargumento..."`,
    {
      tema: z.string().describe('El tema a debatir. Puedes incluir REGLAS y CONTEXTO en el texto.'),
      rondas: z.number().optional().default(10).describe('Rondas (8+ activa fases completas). Usa 0 para modo continuo sin límite.'),
      intensidad: z.enum(['casual', 'moderado', 'adversarial']).optional().default('adversarial').describe('Nivel de intensidad del debate. Default: adversarial.'),
    },
    async ({ tema, rondas, intensidad }) => {
      const debate = dm.createDebate(tema, rondas, null, intensidad);
      const rolesText = debate.suggestedRoles
        .map((r, i) => `  ${i + 1}. ${r.role} — ${r.desc}`)
        .join('\n');

      const phasesText = (debate.phases || [])
        .map(p => `  Rondas ${p.rounds[0]}-${p.rounds[1]}: ${p.name}`)
        .join('\n');

      const rulesText = (debate.rules || [])
        .map((r, i) => `  ${i + 1}. ${r}`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `🔥 Debate creado: ${debate.id}
Tema: "${tema}"
Categoría: ${debate.category} | Intensidad: ${debate.intensity}
Rondas: ${rondas || '∞ (continuo)'}
Auto-avance: ON

FASES DEL DEBATE:
${phasesText || '  (sin fases — debate libre)'}

REGLAS DE ENGAGEMENT:
${rulesText}

ROLES DISPONIBLES (antagonistas por diseño — DEBEN chocar):
${rolesText}

INSTRUCCIONES PARA PARTICIPANTES:
1. Usa "unirse" con debate_id="${debate.id}" y elige un rol
2. Usa "decir" para contribuir — el sistema te indicará la FASE actual y qué se espera
3. TODOS deben hablar antes de que la ronda avance
4. Respeta tu ROL — argumenta desde esa perspectiva SIN CONCEDER al oponente fácilmente
5. Mínimo ${debate.minWords || 100} palabras por mensaje`,
        }],
      };
    }
  );

  // ── UNIRSE ─────────────────────────────────────────────────────────
  server.tool(
    'unirse',
    'Únete a un debate eligiendo un rol ANTAGONISTA. Tu rol define tu perspectiva — DEBES argumentar desde ese punto de vista sin ceder fácilmente.',
    {
      debate_id: z.string().describe('ID del debate'),
      nombre: z.string().describe('Tu nombre (ej: "claude-opus", "gpt4", "gemini")'),
      rol: z.string().optional().describe('Rol a tomar. Elige uno que CHOQUE con los roles ya tomados. Si no eliges, se asigna uno.'),
    },
    async ({ debate_id, nombre, rol }) => {
      const result = dm.joinDebate(debate_id, nombre, rol);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }
      const d = result.debate;
      const takenRoles = d.participants.map(p => `${p.name} → ${p.role}`).join('\n  ');
      const availableRoles = (d.suggestedRoles || [])
        .filter(r => !d.participants.find(p => p.role === r.role))
        .map(r => `${r.role} — ${r.desc}`)
        .join('\n  ');

      const phase = dm.getCurrentPhase(d.currentRound, d.phases);
      const rulesText = (d.rules || []).map((r, i) => `  ${i + 1}. ${r}`).join('\n');

      // Info de redistribución si ocurrió
      let redistText = '';
      if (result.replacedAgent) {
        redistText = `\n\n🔄 REDISTRIBUCIÓN: El agente virtual "${result.replacedAgent.name}" te cedió su rol "${result.replacedAgent.role}" y fue removido del debate.`;
      }

      return {
        content: [{
          type: 'text',
          text: result.alreadyJoined
            ? `Ya estás en "${d.topic}" como ${result.participant.role}.`
            : `🎭 Te uniste a "${d.topic}" como "${nombre}"${redistText}
ROL: ${result.participant.role}
Tu perspectiva es ÚNICA — defiéndela con convicción.

Participantes actuales:
  ${takenRoles}

Roles aún disponibles:
  ${availableRoles || 'ninguno — todos tomados'}

Ronda: ${d.currentRound}/${d.maxRounds || '∞'}${phase ? `\nFASE ACTUAL: ${phase.name}\n📌 ${phase.instruction}` : ''}

REGLAS DE ENGAGEMENT:
${rulesText}

⚡ IMPORTANTE: Usa "decir" para contribuir. NO seas tibio. Tu rol EXIGE que defiendas tu posición.`,
        }],
      };
    }
  );

  // ── DECIR (con enforcement de profundidad) ─────────────────────────
  server.tool(
    'decir',
    `Di algo en el debate. REGLAS ESTRICTAS:

1. MÍNIMO 150 PALABRAS o el mensaje es RECHAZADO automáticamente por el servidor
2. En modo ADVERSARIAL cada agente debe hablar 2 VECES por ronda (posición + réplica) antes de avanzar
3. DEBE incluir al menos 1 objeción directa a otro participante POR NOMBRE
4. DEBE argumentar desde tu ROL — no seas neutral
5. Si te mencionaron, DEBES responder a la objeción

Si tu mensaje es rechazado por ser muy corto, reescríbelo con más detalle y evidencia.`,
    {
      debate_id: z.string().describe('ID del debate'),
      nombre: z.string().describe('Tu nombre de participante'),
      mensaje: z.string().describe('Tu contribución DETALLADA. Mínimo 150 palabras. Incluye argumentos concretos, evidencia, y objeciones directas.'),
    },
    async ({ debate_id, nombre, mensaje }) => {
      const result = dm.say(debate_id, nombre, mensaje);
      if (result.error) {
        // Si fue rechazado por minWords, dar instrucciones claras
        if (result.rejected) {
          return {
            content: [{
              type: 'text',
              text: `🚫 MENSAJE RECHAZADO — DEMASIADO CORTO\n\nTu mensaje tiene ${result.wordCount} palabras. Mínimo requerido: ${result.minWords}.\n\nPara que sea aceptado DEBES:\n- Expandir tus argumentos con evidencia concreta\n- Incluir al menos 1 objeción DIRECTA a otro participante por nombre\n- Explicar el razonamiento, no solo la conclusión\n- Mínimo ${result.minWords} palabras\n\nReescribe tu mensaje y llama "decir" de nuevo.`,
            }],
          };
        }
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }

      let statusText = `✓ Mensaje #${result.totalMessages} registrado (${result.wordCount} palabras) — Ronda ${result.round}`;
      statusText += `\nExchanges esta ronda: ${result.exchangesThisRound}/${result.minExchanges}`;

      if (result.exchangesThisRound < result.minExchanges) {
        statusText += `\n\n⚠️ DEBES HABLAR ${result.minExchanges - result.exchangesThisRound} VEZ/VECES MÁS esta ronda.`;
        statusText += `\nLee las respuestas de los demás con "leer" y luego responde con "decir" de nuevo.`;
        statusText += `\nLa ronda NO avanza hasta que todos completen ${result.minExchanges} exchanges.`;
      }

      if (result.autoAdvanced) {
        if (result.status === 'finished') {
          statusText += `\n\n🏁 DEBATE TERMINADO. Usa "finalizar" para síntesis.`;
        } else {
          statusText += `\n\n✅ TODOS completaron ${result.minExchanges} exchanges → Ronda avanzada a ${result.round}.`;
        }
      } else if (result.pendingParticipants.length > 0) {
        statusText += `\n\n⏳ Faltan por completar exchanges: ${result.pendingParticipants.join(', ')}`;
      }

      if (result.currentPhase) {
        statusText += `\n\n📌 FASE: ${result.currentPhase}`;
        statusText += `\n${result.phaseInstruction}`;
      }

      if (result.rules && result.rules.length > 0 && result.intensity === 'ADVERSARIAL') {
        statusText += `\n\n⚡ REGLAS:`;
        result.rules.forEach((r, i) => { statusText += `\n  ${i + 1}. ${r}`; });
      }

      if (result.status === 'active') {
        statusText += `\n\n👉 SIGUIENTE: Usa "leer" para ver respuestas, luego "decir" para responder. ATACA argumentos débiles. NO concedas sin pelear.`;
      }

      return { content: [{ type: 'text', text: statusText }] };
    }
  );

  // ── LEER ──────────────────────────────────────────────────────────
  server.tool(
    'leer',
    'Lee el historial del debate con roles, fases, reglas y estado de turnos. Usa esto para ver qué dijeron los demás antes de responder. Soporta paginación para debates largos.',
    {
      debate_id: z.string().describe('ID del debate'),
      desde_mensaje: z.number().optional().default(0).describe('Índice desde el cual leer (0 = todo)'),
      limite: z.number().optional().default(0).describe('Máximo de mensajes a retornar (0 = todos). Retorna los últimos N mensajes.'),
    },
    async ({ debate_id, desde_mensaje, limite }) => {
      const result = dm.read(debate_id, desde_mensaje, limite);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }

      let extra = `\n[${result.newMessages} mensajes, ${result.totalMessages} total]`;
      if (result.pendingParticipants && result.pendingParticipants.length > 0) {
        extra += `\n⏳ Esperando: ${result.pendingParticipants.join(', ')}`;
      }
      if (result.phaseInstruction) {
        extra += `\n\n📌 INSTRUCCIÓN DE FASE: ${result.phaseInstruction}`;
      }

      return { content: [{ type: 'text', text: result.formatted + extra }] };
    }
  );

  // ── AVANZAR RONDA ─────────────────────────────────────────────────
  server.tool(
    'avanzar_ronda',
    'Avanza a la siguiente ronda/fase. SOLO funciona si todos hablaron. Usa forzar=true para saltarse la verificación.',
    {
      debate_id: z.string().describe('ID del debate'),
      forzar: z.boolean().optional().default(false).describe('Forzar avance aunque no todos hayan hablado'),
    },
    async ({ debate_id, forzar }) => {
      const result = dm.nextRound(debate_id, forzar);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }
      if (result.finished) {
        return {
          content: [{
            type: 'text',
            text: `🏁 Debate terminado en ronda ${result.round}. Usa "finalizar" para guardar síntesis.`,
          }],
        };
      }
      let text = `Ronda avanzada a ${result.round}. Todos deben hablar de nuevo.`;
      if (result.phase) {
        text += `\n\n📌 NUEVA FASE: ${result.phase}\n${result.phaseInstruction}`;
      }
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── VOTAR FINALIZAR ──────────────────────────────────────────────
  server.tool(
    'votar_finalizar',
    `🗳️ Vota para finalizar el debate. Se necesita CONSENSO de 2/3 de los participantes.
Cuando estés satisfecho con los cambios realizados, vota para terminar.
Cuando se alcance el consenso, el coordinador-merge puede llamar "finalizar".`,
    {
      debate_id: z.string().describe('ID del debate'),
      nombre: z.string().describe('Tu nombre de agente'),
      razon: z.string().optional().describe('Por qué consideras que se puede finalizar'),
    },
    async ({ debate_id, nombre, razon }) => {
      const result = dm.voteFinish(debate_id, nombre, razon || '');
      if (result.error) return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
      return { content: [{ type: 'text', text: `🗳️ ${result.message}\n\nVotos: ${result.voters.join(', ')}` }] };
    }
  );

  // ── FINALIZAR ─────────────────────────────────────────────────────
  server.tool(
    'finalizar',
    `🏁 Cierra el debate con síntesis. REQUIERE consenso previo: 2/3 de los agentes deben haber votado con "votar_finalizar".
Si no hay consenso suficiente, será rechazado.`,
    {
      debate_id: z.string().describe('ID del debate'),
      sintesis: z.string().optional().describe('Síntesis final del debate'),
    },
    async ({ debate_id, sintesis }) => {
      const result = dm.finishDebate(debate_id, sintesis);
      if (result.error) {
        const extra = result.voters ? `\nVotos actuales: ${result.voters.join(', ')}` : '';
        return { content: [{ type: 'text', text: `❌ ${result.error}${extra}` }] };
      }
      const parts = result.debate.participants.map(p => `${p.name} (${p.role})`).join(', ');
      return {
        content: [{
          type: 'text',
          text: `🏁 Debate "${result.debate.topic}" finalizado por CONSENSO.\nMensajes: ${result.debate.messages.length}\nRondas: ${result.debate.currentRound}\nParticipantes: ${parts}\nGuardado en: ${result.savedTo}`,
        }],
      };
    }
  );

  // ── DEBATES ───────────────────────────────────────────────────────
  server.tool(
    'debates',
    'Lista todos los debates con estado, categoría, intensidad y fases.',
    {},
    async () => {
      const list = dm.listDebates();
      if (list.length === 0) {
        return { content: [{ type: 'text', text: 'No hay debates. Usa "iniciar_debate" para crear uno.' }] };
      }
      let text = 'Debates:\n\n';
      for (const d of list) {
        const icon = d.status === 'active' ? '🔥' : '🏁';
        text += `${icon} ${d.id}: "${d.topic}" (${d.category})\n`;
        text += `   Intensidad: ${d.intensity || 'moderado'} | Ronda: ${d.currentRound}/${d.maxRounds || '∞'}`;
        if (d.currentPhase) text += ` | Fase: ${d.currentPhase}`;
        text += `\n   Mensajes: ${d.messageCount} | Participantes: ${d.participants.join(', ') || 'ninguno'}\n\n`;
      }
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── ESTADO ────────────────────────────────────────────────────────
  server.tool(
    'estado',
    'Estado detallado: participantes, roles, turnos, fase actual, reglas de engagement.',
    {},
    async () => {
      const debate = dm.getActiveDebate();
      if (!debate) {
        return { content: [{ type: 'text', text: 'No hay debate activo.' }] };
      }

      const spokenSet = new Set(debate.spokenThisRound || []);
      const participantsList = debate.participants
        .map(p => {
          const spoke = spokenSet.has(p.name) ? '✓' : '⏳';
          return `  ${spoke} ${p.name} — ${p.role}`;
        })
        .join('\n');

      const pending = debate.participants
        .filter(p => !spokenSet.has(p.name))
        .map(p => p.name);

      const phase = dm.getCurrentPhase(debate.currentRound, debate.phases);
      const rulesText = (debate.rules || []).map((r, i) => `  ${i + 1}. ${r}`).join('\n');

      const lastMsgs = debate.messages.slice(-3)
        .map(m => `  [${m.participantName}|${m.participantRole || '?'}]: ${m.text.slice(0, 150)}...`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: `🔥 ${debate.id} (${debate.category}) | Intensidad: ${debate.intensity || 'moderado'}
Tema: "${debate.topic}"
Ronda: ${debate.currentRound}/${debate.maxRounds || '∞'}${phase ? `\nFASE: ${phase.name}\n📌 ${phase.instruction}` : ''}

Participantes (✓=habló ⏳=falta):
${participantsList}

${pending.length > 0 ? `⏳ Esperando: ${pending.join(', ')}` : '✅ Todos hablaron esta ronda.'}

REGLAS:
${rulesText || '  (sin reglas especiales)'}

Últimos mensajes:
${lastMsgs || '  (sin mensajes)'}`,
        }],
      };
    }
  );

  // ── ROLES ─────────────────────────────────────────────────────────
  server.tool(
    'roles',
    'Muestra roles antagonistas para un tema, o los roles del debate activo.',
    {
      tema: z.string().optional().describe('Tema para sugerir roles. Si vacío, muestra roles del debate activo.'),
    },
    async ({ tema }) => {
      if (tema) {
        const suggested = dm.suggestRoles(tema);
        const rolesText = suggested.roles
          .map(r => `  - ${r.role}: ${r.desc}`)
          .join('\n');
        return {
          content: [{
            type: 'text',
            text: `Categoría: ${suggested.category}\n\nRoles antagonistas para "${tema}":\n${rolesText}\n\nEstos roles están diseñados para CHOCAR entre sí y generar debate intenso.`,
          }],
        };
      }

      const debate = dm.getActiveDebate();
      if (!debate) {
        return { content: [{ type: 'text', text: 'No hay debate activo.' }] };
      }

      const taken = debate.participants.map(p => `  ✓ ${p.role} → ${p.name}`);
      const available = (debate.suggestedRoles || [])
        .filter(r => !debate.participants.find(p => p.role === r.role))
        .map(r => `  ○ ${r.role} — ${r.desc}`);

      return {
        content: [{
          type: 'text',
          text: `Debate: "${debate.topic}" (${debate.category})\n\nRoles tomados:\n${taken.join('\n') || '  ninguno'}\n\nRoles disponibles:\n${available.join('\n') || '  ninguno'}`,
        }],
      };
    }
  );

  // ── AGREGAR CONTEXTO (Knowledge Base) ──────────────────────────
  server.tool(
    'agregar_contexto',
    `📚 Inyecta FUENTES DE EVIDENCIA al debate: código, SQL, docs, datos, configs.

Los agentes DEBEN usar estas fuentes para argumentar — no pueden inventar datos.
Usa esto para que el debate sea TÉCNICAMENTE RIGUROSO basado en evidencia real.

Categorías: "codigo", "sql", "doc", "datos", "config", "api", "log"

Ejemplo: agregar_contexto(debate_id, fuente: "auth.ts", contenido: "export function authenticate()...", categoria: "codigo")`,
    {
      debate_id: z.string().describe('ID del debate'),
      fuente: z.string().describe('Nombre de la fuente (ej: "auth.ts", "tabla:users", "doc:arquitectura")'),
      contenido: z.string().describe('El contenido real: código fuente, SQL, documentación, datos, etc.'),
      categoria: z.enum(['codigo', 'sql', 'doc', 'datos', 'config', 'api', 'log', 'general']).optional().default('general').describe('Tipo de fuente'),
    },
    async ({ debate_id, fuente, contenido, categoria }) => {
      const result = dm.addContext(debate_id, fuente, contenido, categoria);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }

      return {
        content: [{
          type: 'text',
          text: `📚 Fuente agregada al banco de conocimiento:
  ID: ${result.entry.id}
  Fuente: ${fuente} [${categoria}]
  Palabras: ${result.entry.wordCount}

Total fuentes: ${result.totalSources} (${result.totalWords} palabras)

Los agentes ahora DEBEN citar esta fuente en sus argumentos.
Usa "agregar_contexto" de nuevo para más fuentes.`,
        }],
      };
    }
  );

  // ── CONSULTAR FUENTE (leer KB completo) ───────────────────────────
  server.tool(
    'consultar_fuente',
    `Lee una fuente específica del banco de conocimiento del debate.
Usa esto para obtener el contenido completo de una fuente antes de argumentar.`,
    {
      debate_id: z.string().describe('ID del debate'),
      fuente_id: z.string().describe('ID de la fuente o nombre (ej: "kb-xxx" o "auth.ts")'),
    },
    async ({ debate_id, fuente_id }) => {
      const result = dm.getKnowledgeSource(debate_id, fuente_id);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }

      return {
        content: [{
          type: 'text',
          text: `📖 FUENTE: ${result.source} [${result.category}]\n${'─'.repeat(50)}\n${result.content}\n${'─'.repeat(50)}\n(${result.wordCount} palabras)`,
        }],
      };
    }
  );

  // ── BANCO (listar fuentes del KB) ─────────────────────────────────
  server.tool(
    'banco',
    'Lista todas las fuentes del banco de conocimiento del debate activo.',
    {
      debate_id: z.string().optional().describe('ID del debate. Si vacío, usa el debate activo.'),
    },
    async ({ debate_id }) => {
      const id = debate_id || dm.getActiveDebate()?.id;
      if (!id) {
        return { content: [{ type: 'text', text: 'No hay debate activo.' }] };
      }
      const result = dm.getKnowledgeBase(id);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }

      if (result.sources.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `📚 Banco de conocimiento vacío para ${id}.\n\nUsa "agregar_contexto" para inyectar código, SQL, docs, etc.\nLos agentes usarán estas fuentes como evidencia.`,
          }],
        };
      }

      let text = `📚 BANCO DE CONOCIMIENTO: ${result.totalSources} fuentes (${result.totalWords} palabras)\n\n`;
      result.sources.forEach((s, i) => {
        text += `  ${i + 1}. [${s.category}] ${s.source} (${s.wordCount} palabras)\n`;
        text += `     ID: ${s.id}\n`;
        text += `     Preview: ${s.preview.slice(0, 100)}...\n\n`;
      });

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── NOTA: orquestar_debate fue FUSIONADO en "situacion" con tipo "libre" (audit fix)
  // Usa: situacion(tipo: "libre", tema: "...", num_agentes: 3)

  // ── TURNO (siguiente sub-agente) ──────────────────────────────────
  server.tool(
    'turno',
    `Obtiene el PRÓXIMO TURNO del debate orquestado.
Te dice QUIÉN debe hablar, su ROL, el CONTEXTO, y un PROMPT completo para hacer role-play.

Después de recibir el turno:
1. Lee el rolePlayPrompt
2. Genera tu mensaje EN PERSONAJE como ese agente
3. Usa "decir" con el nombre del agente
4. Llama "turno" otra vez para el siguiente

Si el debate terminó, recibirás finished=true.`,
    {
      debate_id: z.string().describe('ID del debate'),
    },
    async ({ debate_id }) => {
      const turn = dm.getNextTurn(debate_id);

      if (turn.error) {
        return { content: [{ type: 'text', text: `Error: ${turn.error}` }] };
      }

      if (turn.finished) {
        return {
          content: [{
            type: 'text',
            text: `🏁 DEBATE TERMINADO: ${debate_id}
${turn.totalMessages} mensajes en ${turn.totalRounds} rondas.

Usa "finalizar(debate_id: "${debate_id}", sintesis: "...")" para cerrar con una síntesis.`,
          }],
        };
      }

      if (turn.allSpoke) {
        return {
          content: [{
            type: 'text',
            text: `✅ Todos hablaron en ronda ${turn.round}. La ronda debería auto-avanzar. Llama "turno" de nuevo.`,
          }],
        };
      }

      // Formatear mensajes recientes como contexto
      let contextText = '';
      if (turn.recentMessages && turn.recentMessages.length > 0) {
        contextText = '\n\nÚLTIMOS MENSAJES (contexto):\n';
        turn.recentMessages.forEach(m => {
          contextText += `  [${m.from} | ${m.role}] (R${m.round}): ${m.text}\n`;
        });
      }

      return {
        content: [{
          type: 'text',
          text: `${'='.repeat(60)}
🎭 TURNO #${turn.spokenThisRound + 1}/${turn.totalParticipants} — Ronda ${turn.round}/${turn.maxRounds || '∞'}
${'='.repeat(60)}

AGENTE: ${turn.agent.name}
ROL: ${turn.agent.role}
PERSPECTIVA: ${turn.agent.roleDesc}
${turn.phase ? `\nFASE: ${turn.phase}` : ''}
Otros participantes: ${turn.otherParticipants.join(', ')}
${contextText}
${'─'.repeat(60)}
${turn.rolePlayPrompt}
${'─'.repeat(60)}

👉 ACCIÓN: Genera tu mensaje como "${turn.agent.name}" y usa:
   decir(debate_id: "${turn.debateId}", nombre: "${turn.agent.name}", mensaje: "tu-mensaje")
   Luego llama "turno" otra vez.`,
        }],
      };
    }
  );

  // ── RONDA COMPLETA (todos los turnos en paralelo) ──────────────
  server.tool(
    'ronda_completa',
    `⚡ MODO PARALELO: Obtiene los prompts de TODOS los agentes pendientes.

FLUJO COMPLETO POR RONDA (en modo ADVERSARIAL cada agente habla 2 VECES por ronda):

1. "ronda_completa" → prompts de N agentes
2. Genera N respuestas LARGAS (mínimo 150 palabras CADA UNA o serán rechazadas)
3. "decir_lote" con las N respuestas
4. "ronda_completa" de nuevo → ahora pide las RÉPLICAS (2do exchange)
5. Genera N réplicas donde CADA agente responde a lo que dijeron los demás
6. "decir_lote" con las N réplicas
7. Ronda avanza automáticamente
8. "ronda_completa" para la siguiente ronda

IMPORTANTE: En ADVERSARIAL, la ronda NO avanza después del primer "decir_lote".
Cada agente necesita 2 exchanges (posición + réplica). Llama "ronda_completa" de nuevo para ver qué falta.`,
    {
      debate_id: z.string().describe('ID del debate'),
    },
    async ({ debate_id }) => {
      const result = dm.getAllPendingTurns(debate_id);

      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }

      if (result.finished) {
        return {
          content: [{
            type: 'text',
            text: `🏁 DEBATE TERMINADO: ${debate_id}\n${result.totalMessages} mensajes en ${result.totalRounds} rondas.\n\nUsa "finalizar" para cerrar con síntesis.`,
          }],
        };
      }

      if (result.allSpoke) {
        return {
          content: [{
            type: 'text',
            text: `✅ Todos hablaron en ronda ${result.round}. Auto-avance debería activarse. Llama "ronda_completa" de nuevo.`,
          }],
        };
      }

      // Formatear contexto compartido
      let contextText = '';
      if (result.recentMessages && result.recentMessages.length > 0) {
        contextText = '\nCONTEXTO (últimos mensajes):\n';
        result.recentMessages.forEach(m => {
          contextText += `  [${m.from} | ${m.role}] (R${m.round}): ${m.text.slice(0, 200)}${m.text.length > 200 ? '...' : ''}\n`;
        });
      }

      // Formatear cada turno
      const turnsText = result.turns.map((turn, i) => {
        let t = `\n${'═'.repeat(60)}\n`;
        t += `🎭 AGENTE ${i + 1}/${result.pendingCount}: ${turn.agent.name}\n`;
        t += `ROL: ${turn.agent.role} — ${turn.agent.roleDesc}\n`;
        t += `${'─'.repeat(60)}\n`;
        t += turn.rolePlayPrompt;
        t += `\n${'═'.repeat(60)}`;
        return t;
      }).join('\n');

      const rulesText = (result.rules || []).map((r, i) => `  ${i + 1}. ${r}`).join('\n');

      return {
        content: [{
          type: 'text',
          text: `⚡ RONDA ${result.round}/${result.maxRounds || '∞'} — ${result.pendingCount} AGENTES PENDIENTES — ${result.exchangeRound || 'POSICIÓN'}
Debate: ${result.debateId} | Intensidad: ${result.intensity} | Exchanges por ronda: ${result.minExchanges}
${result.phase ? `FASE: ${result.phase}\n📌 ${result.phaseInstruction}` : ''}

REGLAS:
${rulesText || '  (sin reglas)'}
${contextText}
${'▓'.repeat(60)}
  GENERA ${result.pendingCount} RESPUESTAS EN PARALELO
  Cada una DESDE la perspectiva ÚNICA del agente
${'▓'.repeat(60)}
${turnsText}

👉 ACCIÓN: Genera las ${result.pendingCount} respuestas y usa:
   decir_lote(debate_id: "${result.debateId}", mensajes: [
     { nombre: "${result.turns[0]?.agent.name}", mensaje: "..." },
${result.turns.slice(1).map(t => `     { nombre: "${t.agent.name}", mensaje: "..." }`).join(',\n')}
   ])
   Luego llama "ronda_completa" para la siguiente ronda.`,
        }],
      };
    }
  );

  // ── DECIR LOTE (múltiples mensajes de un golpe) ──────────────────
  server.tool(
    'decir_lote',
    `Envía MÚLTIPLES mensajes de agentes de un solo golpe.
Ideal después de "ronda_completa" — envía todas las respuestas generadas en paralelo.

Cada mensaje debe tener: nombre (del agente) y mensaje (su contribución).
La ronda avanza automáticamente cuando todos los agentes de la ronda han hablado.`,
    {
      debate_id: z.string().describe('ID del debate'),
      mensajes: z.array(z.object({
        nombre: z.string().describe('Nombre del agente'),
        mensaje: z.string().describe('El mensaje de ese agente'),
      })).describe('Array de mensajes, uno por agente'),
    },
    async ({ debate_id, mensajes }) => {
      const batch = mensajes.map(m => ({ name: m.nombre, text: m.mensaje }));
      const result = dm.sayBatch(debate_id, batch);

      let statusText = `📨 ${result.processed} mensajes registrados en debate ${result.debateId}\n`;
      statusText += `Ronda actual: ${result.currentRound} | Estado: ${result.status}\n`;

      if (result.currentPhase) {
        statusText += `Fase: ${result.currentPhase}\n`;
      }

      statusText += `\nDetalle:\n`;
      result.results.forEach(r => {
        const icon = r.success ? '✓' : '✗';
        statusText += `  ${icon} ${r.agent}${r.autoAdvanced ? ' (ronda avanzó)' : ''}${r.error ? ` — Error: ${r.error}` : ''}\n`;
      });

      if (result.status === 'finished') {
        statusText += `\n🏁 DEBATE TERMINADO. Usa "finalizar" para cerrar con síntesis.`;
      } else if (result.status === 'active') {
        statusText += `\n👉 Llama "ronda_completa" para la siguiente ronda.`;
      }

      return { content: [{ type: 'text', text: statusText }] };
    }
  );

  // ── SITUACIONES PADRONIZADAS ─────────────────────────────────────

  // ── LISTAR SITUACIONES ──────────────────────────────────────────
  server.tool(
    'situaciones',
    `📋 Lista las SITUACIONES PADRONIZADAS disponibles.

Una SITUACIÓN es un workflow pre-configurado con roles, fases, reglas y coordinación específicos.
Cada situación viene con agentes especializados que saben exactamente qué hacer.

Situaciones disponibles:
- "libre": Debate abierto sin template — roles auto-detectados según tema (reemplaza orquestar_debate)
- "identificar_problemas": Detectar, analizar, priorizar y proponer fixes para errores
- "arquitectura": Diseñar solución técnica con debate entre pragmatismo vs perfección
- "ejecucion": Implementación coordinada — uno codea, otro revisa, otro coordina, otro arquitecta

Usa "situacion" para iniciar una de estas situaciones.`,
    {},
    async () => {
      const list = dm.listSituaciones();
      let text = '📋 SITUACIONES PADRONIZADAS DISPONIBLES\n\n';
      text += 'Cada situación es un workflow completo con roles, fases, y coordinación pre-configurados.\n\n';

      list.forEach((sit, i) => {
        text += `${sit.icon} ${i + 1}. "${sit.id}" — ${sit.name}\n`;
        text += `   ${sit.desc}\n`;
        text += `   Intensidad: ${sit.intensity} | Rondas: ${sit.maxRounds}\n`;
        text += `   Roles: ${sit.roles.length}\n`;
        sit.roles.forEach(r => { text += `     • ${r}\n`; });
        text += `   Fases: ${sit.phases.join(' → ')}\n`;
        text += `   Coordinación: ${sit.coordination}\n\n`;
      });

      text += `\n👉 Usa "situacion" para iniciar. Ejemplo:\n`;
      text += `   situacion(tipo: "ejecucion", tema: "Implementar sistema de auth JWT")\n`;
      text += `   situacion(tipo: "identificar_problemas", tema: "Bugs en el módulo de pagos", num_agentes: 5)`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── CREAR SITUACIÓN ─────────────────────────────────────────────
  server.tool(
    'situacion',
    `🎯 INICIA UNA SITUACIÓN PADRONIZADA — workflow completo pre-configurado.

TIPOS DISPONIBLES:
🔥 "libre" — Debate abierto sin template (roles auto-detectados según tema)
📍 "identificar_problemas" — Análisis exhaustivo de errores/bugs
   Flujo: Detector → Analista → Priorizador → Fix → Abogado del Diablo

🏗️ "arquitectura" — Diseño técnico de solución
   Flujo: Propuestas → Cross-exam → Refinamiento → Decisión final

⚡ "ejecucion" — Implementación coordinada en tiempo real
   Flujo: Coordinador asigna → Implementador codea → Revisor+QA+Arquitecto revisan → Merge

OPCIÓN SUB-AGENTES: Si usas num_agentes > 0, se crean agentes virtuales automáticos.
Si num_agentes = 0, los participantes se unen manualmente (ideal para equipos reales).

DESPUÉS DE CREAR:
1. Inyecta contexto con "agregar_contexto" (código, logs, docs)
2. Usa "turno" o "ronda_completa" si hay sub-agentes
3. Usa "workflow_status" para ver el estado de coordinación`,
    {
      tipo: z.enum(['libre', 'identificar_problemas', 'arquitectura', 'ejecucion']).describe('Tipo de situación. "libre" = debate abierto con roles auto-detectados.'),
      tema: z.string().describe('El tema/contexto específico (ej: "Bugs en módulo de pagos", "Arquitectura para sistema de notificaciones")'),
      num_agentes: z.number().optional().default(0).describe('Número de sub-agentes virtuales (0 = manual, participantes se unen con "unirse"). Máximo: 15.'),
    },
    async ({ tipo, tema, num_agentes }) => {
      const result = dm.crearSituacion(tipo, tema, num_agentes || 0);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }

      const d = result.debate;
      const t = result.template;

      // Roles disponibles
      const rolesText = d.suggestedRoles
        .map((r, i) => `  ${i + 1}. ${r.role} (orden: ${r.order}) — ${r.desc}`)
        .join('\n');

      // Fases
      const phasesText = t.phases
        .map(p => `  R${p.rounds[0]}-${p.rounds[1]}: ${p.name}`)
        .join('\n');

      // Reglas
      const rulesText = (d.rules || [])
        .map((r, i) => `  ${i + 1}. ${r}`)
        .join('\n');

      // Agentes virtuales (si se crearon)
      let agentsText = '';
      if (result.agents.length > 0) {
        agentsText = `\n\n🤖 ${result.agents.length} SUB-AGENTES CREADOS:\n`;
        result.agents.forEach((a, i) => {
          agentsText += `  ${i + 1}. ${a.name} → ${a.role} (orden: ${a.order})\n`;
        });
      }

      // Coordinación
      const coordText = `\n📊 COORDINACIÓN: ${t.coordination.type}\n` +
        `   Flujo: ${t.coordination.flowDescription}\n` +
        `   Dependencias:\n` +
        Object.entries(t.coordination.dependencies || {})
          .map(([role, deps]) => `     ${role} ← espera a: ${deps.length > 0 ? deps.join(', ') : '(sin dependencias)'}`)
          .join('\n');

      // Primer turno si hay agentes
      let turnText = '';
      if (result.firstTurn && !result.firstTurn.error && !result.firstTurn.finished) {
        turnText = `\n\n${'='.repeat(60)}\n🎬 PRIMER TURNO:\n${'='.repeat(60)}\n\n${result.firstTurn.rolePlayPrompt}`;
      }

      return {
        content: [{
          type: 'text',
          text: `${t.icon} SITUACIÓN INICIADA: ${t.name}
ID: ${d.id}
Tema: "${tema}"
Intensidad: ${d.intensity} | Rondas: ${d.maxRounds} | Min palabras: ${d.minWords}

ROLES (en orden de coordinación):
${rolesText}

FASES DEL WORKFLOW:
${phasesText}

REGLAS:
${rulesText}
${coordText}
${agentsText}

PRÓXIMOS PASOS:
${result.agents.length > 0
  ? `1. Inyecta contexto: agregar_contexto(debate_id: "${d.id}", fuente: "...", contenido: "...", categoria: "codigo")
2. Genera respuesta del primer agente según el turno abajo
3. Usa "decir" con el nombre del agente
4. Usa "turno" o "ronda_completa" para continuar
5. Usa "workflow_status" para ver el estado de coordinación`
  : `1. Los participantes se unen con: unirse(debate_id: "${d.id}", nombre: "...", rol: "...")
2. Inyecta contexto con: agregar_contexto(debate_id: "${d.id}", ...)
3. Participan con "decir"
4. Usa "workflow_status" para ver coordinación`}
${turnText}`,
        }],
      };
    }
  );

  // ── WORKFLOW STATUS ──────────────────────────────────────────────
  server.tool(
    'workflow_status',
    `📊 Estado de COORDINACIÓN del workflow de una situación.

Muestra:
- Quién puede hablar y quién está esperando dependencias
- El flujo de coordinación y en qué punto estamos
- La fase actual y qué se espera
- Agentes bloqueados y por qué

Usa esto para saber QUÉ hacer a continuación en una situación padronizada.`,
    {
      debate_id: z.string().describe('ID del debate/situación'),
    },
    async ({ debate_id }) => {
      const result = dm.getWorkflowStatus(debate_id);
      if (result.error) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }

      let text = `📊 WORKFLOW STATUS: ${result.situacion}\n`;
      text += `Coordinación: ${result.coordinationType} | Ronda: ${result.currentRound}/${result.maxRounds}\n`;
      text += `Flujo: ${result.flowDescription}\n`;

      if (result.currentPhase) {
        text += `\n📌 FASE: ${result.currentPhase}\n   ${result.phaseInstruction}\n`;
      }

      text += `\n${'─'.repeat(50)}\n`;
      text += `ESTADO DE AGENTES:\n`;

      result.participants.forEach(p => {
        let icon;
        if (p.status === 'completado') icon = '✅';
        else if (p.status === 'listo_para_hablar') icon = '🟢';
        else icon = '🔴';

        text += `  ${icon} ${p.name} (${p.role})`;
        text += ` [exchanges: ${p.exchanges}]`;
        if (p.dependsOn.length > 0) {
          text += ` ← depende de: ${p.dependsOn.join(', ')}`;
        }
        text += `\n`;
      });

      if (result.nextToAct) {
        text += `\n${'─'.repeat(50)}\n`;
        text += `🎯 PRÓXIMO EN ACTUAR: ${result.nextToAct.name} (${result.nextToAct.role})\n`;
        text += `   ${result.nextToAct.desc}\n`;
      }

      if (result.blockedAgents.length > 0) {
        text += `\n⏳ BLOQUEADOS:\n`;
        result.blockedAgents.forEach(b => {
          text += `  🔴 ${b.name} (${b.role}) — esperando: ${b.waitingFor.join(', ')}\n`;
        });
      }

      if (result.allCompleted) {
        text += `\n✅ TODOS COMPLETARON esta ronda. La ronda debería auto-avanzar.\n`;
      }

      text += `\nLeyenda: ✅=completado 🟢=listo 🔴=esperando`;

      return { content: [{ type: 'text', text }] };
    }
  );

  // ── Resource ──────────────────────────────────────────────────────
  server.resource(
    'debate-activo',
    'debate://activo',
    async (uri) => {
      const debate = dm.getActiveDebate();
      if (!debate) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'No hay debate activo.' }] };
      }
      const result = dm.read(debate.id);
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: result.formatted }],
      };
    }
  );

  // ── SUB-GROUPS & PIPELINE TOOLS (módulo externo) ──
  sgTools.registerSubGroupTools(server, z);

  // ── CODE PROPOSAL TOOLS ─────────────────────────────────────────────

  server.tool(
    'read_project_file',
    `📄 Lee un archivo del proyecto para analizar su código.
Retorna el contenido con números de línea. Solo puede leer archivos dentro del directorio del proyecto.
Úsalo ANTES de proponer cambios — necesitas ver el código actual.`,
    {
      path: z.string().describe('Ruta relativa al archivo (ej: "debate-manager.cjs", "mcp-server.js")'),
    },
    async ({ path: filePath }) => {
      const result = dm.readProjectFile(filePath);
      if (result.error) return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
      return { content: [{ type: 'text', text: `📄 ${result.path} (${result.lines} lines)\n\n${result.content}` }] };
    }
  );

  server.tool(
    'list_project_files',
    `📁 Lista archivos del proyecto. Puede filtrar por patrón (ej: ".cjs", ".js", "test").
Excluye node_modules, .git, y directorios de sesiones.`,
    {
      pattern: z.string().optional().default('').describe('Filtro opcional: extensión o nombre parcial (ej: ".cjs", "server", "test")'),
    },
    async ({ pattern }) => {
      const files = dm.listProjectFiles(pattern || '');
      const text = files.length === 0
        ? 'No files found matching pattern.'
        : files.map(f => `  ${f.path} (${(f.size/1024).toFixed(1)}KB, ${f.modified.split('T')[0]})`).join('\n');
      return { content: [{ type: 'text', text: `📁 ${files.length} files found:\n${text}` }] };
    }
  );

  server.tool(
    'propose_edit',
    `✏️ Propone un cambio de código. NO lo aplica — crea una propuesta pendiente que debe ser revisada.
Requiere: debate activo, archivo leído previamente, old_string exacto del archivo, new_string con el cambio.
La propuesta debe ser MÍNIMA — un cambio enfocado por propuesta.`,
    {
      debate_id: z.string().describe('ID del debate de mejora de código'),
      agent_name: z.string().describe('Nombre del agente que propone'),
      file_path: z.string().describe('Ruta relativa al archivo a modificar'),
      old_string: z.string().describe('Texto EXACTO actual en el archivo que se quiere reemplazar'),
      new_string: z.string().describe('Texto nuevo que reemplazará al old_string'),
      reason: z.string().describe('Razón técnica del cambio — por qué mejora el código'),
    },
    async ({ debate_id, agent_name, file_path, old_string, new_string, reason }) => {
      const result = dm.proposeEdit(debate_id, agent_name, file_path, old_string, new_string, reason);
      if (result.error) return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
      return { content: [{ type: 'text', text: `✏️ Propuesta ${result.id} creada.\nArchivo: ${file_path}\nEstado: ${result.status}\nRazón: ${reason}\n\nAhora necesita revisión de al menos 2 agentes.` }] };
    }
  );

  server.tool(
    'review_proposal',
    `🔍 Revisa una propuesta de cambio de código. Aprueba o rechaza con justificación técnica.
- 2 aprobaciones → propuesta aprobada automáticamente
- 1 rechazo → propuesta rechazada
- No puedes revisar tu propia propuesta`,
    {
      proposal_id: z.string().describe('ID de la propuesta (ej: "prop-1")'),
      reviewer_name: z.string().describe('Nombre del agente revisor'),
      approve: z.boolean().describe('true para aprobar, false para rechazar'),
      comment: z.string().describe('Comentario técnico justificando la decisión'),
    },
    async ({ proposal_id, reviewer_name, approve, comment }) => {
      const result = dm.reviewProposal(proposal_id, reviewer_name, approve, comment);
      if (result.error) return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
      const emoji = approve ? '✅' : '❌';
      return { content: [{ type: 'text', text: `${emoji} Review de ${reviewer_name} para ${proposal_id}: ${approve ? 'APROBADA' : 'RECHAZADA'}\nComentario: ${comment}\n\nEstado: ${result.status} (${result.approvals} aprobaciones, ${result.rejections} rechazos)` }] };
    }
  );

  server.tool(
    'apply_proposal',
    `🚀 Aplica una propuesta APROBADA al archivo en un GIT BRANCH separado.
GOVERNANCE: Solo el coordinador-merge puede ejecutar esto.
Requiere: status "approved", aprobacion del arquitecto-guardian Y revisor-seguridad.
Si falla, la propuesta se marca como rechazada.`,
    {
      proposal_id: z.string().describe('ID de la propuesta aprobada a aplicar'),
      agent_name: z.string().describe('Nombre del agente que ejecuta la aplicacion (debe ser coordinador-merge)'),
    },
    async ({ proposal_id, agent_name }) => {
      const result = dm.applyProposal(proposal_id, agent_name);
      if (result.error) return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
      const branchInfo = result.branch ? `\nBranch: ${result.branch}` : '\n(Sin git branch — aplicado directamente)';
      return { content: [{ type: 'text', text: `🚀 Propuesta ${result.id} APLICADA\nArchivo: ${result.file}${branchInfo}\nAplicado por: ${result.appliedBy}\n\n⚠️ Ejecuta run_tests para verificar que nada se rompió.` }] };
    }
  );

  server.tool(
    'revert_proposal',
    `⏪ Revierte una propuesta previamente aplicada. Deshace el cambio en el archivo.
Solo funciona si la propuesta tiene status "applied".`,
    {
      proposal_id: z.string().describe('ID de la propuesta a revertir'),
    },
    async ({ proposal_id }) => {
      const result = dm.revertProposal(proposal_id);
      if (result.error) return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
      return { content: [{ type: 'text', text: `⏪ Propuesta ${result.id} REVERTIDA\nArchivo: ${result.file}\nEl archivo volvió a su estado anterior.` }] };
    }
  );

  server.tool(
    'list_proposals',
    `📋 Lista todas las propuestas de cambio de código, opcionalmente filtradas por debate.
Muestra: id, archivo, estado, razón, cantidad de reviews.`,
    {
      debate_id: z.string().optional().describe('Filtrar por debate ID (opcional — sin filtro muestra todas)'),
    },
    async ({ debate_id }) => {
      const props = dm.listProposals(debate_id);
      if (props.length === 0) return { content: [{ type: 'text', text: '📋 No hay propuestas.' }] };
      const text = props.map(p =>
        `${p.status === 'approved' ? '✅' : p.status === 'rejected' ? '❌' : p.status === 'applied' ? '🚀' : '⏳'} ${p.id} | ${p.filePath} | ${p.status} | ${p.approvals}👍 ${p.rejections}👎 | ${p.reason.substring(0, 60)}`
      ).join('\n');
      return { content: [{ type: 'text', text: `📋 ${props.length} propuesta(s):\n${text}` }] };
    }
  );

  server.tool(
    'run_tests',
    `🧪 Ejecuta el test suite completo del proyecto (test-suite.cjs).
Retorna: tests pasados, fallados, y output resumido.
IMPORTANTE: Úsalo después de aplicar propuestas para verificar que nada se rompió.`,
    {},
    async () => {
      const result = dm.runProjectTests();
      const emoji = result.allPassed ? '✅' : '❌';
      const text = result.error
        ? `❌ Error ejecutando tests:\n${result.error}\n\n${result.output || ''}`
        : `${emoji} Tests: ${result.passed} passed, ${result.failed} failed\n${result.allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}\n\n${result.output}`;
      return { content: [{ type: 'text', text }] };
    }
  );

  // ── GOVERNANCE ──
  server.tool(
    'governance_status',
    `🏛️ Muestra el estado de gobernanza de una propuesta o la configuración general.
Sin parámetros: retorna la configuración de gobernanza (roles, aprobaciones requeridas, archivos protegidos).
Con proposal_id: retorna el estado detallado de qué falta para aprobar esa propuesta.`,
    { proposal_id: z.string().optional().describe('ID de la propuesta (opcional — sin él retorna config general)') },
    async ({ proposal_id }) => {
      if (proposal_id) {
        const status = dm.getGovernanceStatus(proposal_id);
        if (status.error) return { content: [{ type: 'text', text: `❌ ${status.error}` }] };
        const lines = [
          `🏛️ Governance Status — Propuesta ${proposal_id}`,
          `Estado: ${status.status}`,
          `Aprobaciones: ${status.approvals}/${status.minApprovalsNeeded}`,
          `Roles mandatorios faltantes: ${status.mandatoryRolesNeeded.length ? status.mandatoryRolesNeeded.join(', ') : 'ninguno'}`,
          `Vetada: ${status.hasVeto ? 'SÍ' : 'no'}`,
          `Lista para aplicar: ${status.canBeApproved ? 'SÍ ✅' : 'NO ❌'}`,
        ];
        if (status.reviews && status.reviews.length) {
          lines.push(`\nReviews:`);
          status.reviews.forEach(r => lines.push(`  - ${r.reviewer} (${r.role}): ${r.vote}${r.comment ? ' — ' + r.comment : ''}`));
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } else {
        const config = dm.getGovernanceConfig();
        const lines = [
          '🏛️ Configuración de Gobernanza',
          `Aprobaciones mínimas: ${config.minApprovals}`,
          `Roles con aprobación mandatoria: ${config.mandatoryApprovalRoles.join(', ')}`,
          `Roles con veto: ${config.vetoRoles.join(', ')}`,
          `Roles que pueden proponer: ${config.proposeAllowedRoles.join(', ')}`,
          `Roles que pueden aplicar: ${config.applyAllowedRoles.join(', ')}`,
          `Archivos protegidos: ${config.protectedFiles.join(', ')}`,
          `Archivos prohibidos: ${config.forbiddenFiles.join(', ')}`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
    }
  );

  // ── EMBEDDINGS / SEMANTIC SEARCH ──
  server.tool(
    'buscar_similar',
    `🔍 Búsqueda semántica en el historial de debates usando embeddings de OpenAI.
Encuentra mensajes, contextos y síntesis similares a tu consulta.
Útil para: "¿ya debatimos algo parecido?", encontrar decisiones previas, detectar contradicciones.
Soporta filtros por debate, tipo de contenido, y agente.`,
    {
      query: z.string().describe('Texto de búsqueda semántica (ej: "microservicios vs monolito", "problema de autenticación")'),
      top_k: z.number().optional().describe('Cantidad de resultados (default: 5)'),
      debate_id: z.string().optional().describe('Filtrar por debate específico'),
      type: z.string().optional().describe('Filtrar por tipo: "message", "synthesis", "context", "proposal"'),
      agent_name: z.string().optional().describe('Filtrar por agente específico'),
    },
    async ({ query, top_k, debate_id, type, agent_name }) => {
      const filters = {};
      if (debate_id) filters.debateId = debate_id;
      if (type) filters.type = type;
      if (agent_name) filters.agentName = agent_name;
      const results = await dm.searchEmbeddings(query, top_k || 5, filters);
      if (results.length === 0) {
        return { content: [{ type: 'text', text: '🔍 No se encontraron resultados similares.' }] };
      }
      const lines = [`🔍 ${results.length} resultado(s) encontrados:\n`];
      results.forEach((r, i) => {
        lines.push(`${i + 1}. [${(r.similarity * 100).toFixed(1)}% similar] ${r.metadata.type} — ${r.metadata.agentName || 'unknown'}`);
        lines.push(`   Debate: ${r.metadata.debateId || 'N/A'} | Ronda: ${r.metadata.round || 'N/A'} | Fase: ${r.metadata.phase || 'N/A'}`);
        lines.push(`   "${r.text.slice(0, 200)}${r.text.length > 200 ? '...' : ''}"`);
        lines.push('');
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'embedding_stats',
    `📊 Estadísticas del sistema de embeddings.
Muestra: total de embeddings, desglose por tipo y debate, última fecha de embedding.`,
    {},
    async () => {
      const stats = dm.getEmbeddingStats();
      const lines = [
        '📊 Embedding Stats',
        `Total embeddings: ${stats.total}`,
        `Último embedding: ${stats.lastEmbeddedAt || 'nunca'}`,
        '',
        'Por tipo:',
        ...Object.entries(stats.byType).map(([k, v]) => `  ${k}: ${v}`),
        '',
        'Por debate:',
        ...Object.entries(stats.byDebate).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (stats.total === 0) {
        lines.push('\nAún no hay embeddings. Se generan automáticamente al enviar mensajes, agregar contexto, o finalizar debates.');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // ── HEALTH CHECK con validators ──
  server.tool(
    'health_check',
    `🏥 Verifica la salud del estado del sistema.
Revisa: integridad de debates.json, campos requeridos, datos corruptos.
Retorna lista de problemas encontrados o estado saludable.`,
    {},
    async () => {
      const health = validators.healthCheck();
      let text = health.healthy
        ? '✅ Sistema saludable — sin problemas detectados'
        : `⚠️ ${health.issues.length} problema(s) encontrado(s):\n` +
          health.issues.map((iss, i) => `  ${i+1}. ${iss}`).join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );
}

// ── Mode: STDIO ──────────────────────────────────────────────────────────

async function startStdio() {
  const server = new McpServer({ name: 'multi-agent-debate', version: '3.0.0' });
  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[multi-agent-debate] MCP server started on stdio');
}

// ── Mode: HTTP/SSE ───────────────────────────────────────────────────────

async function startHttp(port) {
  const app = express();
  app.use(express.json());

  const connections = new Map();

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // SSE endpoint
  app.get('/sse', (req, res) => {
    const server = new McpServer({ name: 'multi-agent-debate', version: '3.0.0' });
    registerTools(server);
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    connections.set(sessionId, { server, transport });
    console.error(`[mcp] SSE client connected: ${sessionId}`);
    server.connect(transport).catch(err => console.error(`[mcp] SSE error:`, err));
    res.on('close', () => {
      connections.delete(sessionId);
      console.error(`[mcp] SSE client disconnected: ${sessionId}`);
    });
  });

  app.post('/messages', (req, res) => {
    const sessionId = req.query.sessionId;
    const conn = connections.get(sessionId);
    if (!conn) return res.status(400).json({ error: 'Unknown session' });
    conn.transport.handlePostMessage(req, res);
  });

  // ── Streamable HTTP (Figma Make, etc.) ──────────────────────────────
  const streamableSessions = new Map();

  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [sid, { createdAt }] of streamableSessions) {
      if (createdAt < cutoff) {
        streamableSessions.delete(sid);
        console.error(`[mcp] Sesión expirada: ${sid}`);
      }
    }
  }, 10 * 60 * 1000);

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      console.error(`[mcp] POST /mcp | session: ${sessionId || 'nueva'} | body: ${JSON.stringify(req.body).slice(0, 150)}`);

      let transport;
      if (sessionId && streamableSessions.has(sessionId)) {
        transport = streamableSessions.get(sessionId).transport;
      } else {
        const server = new McpServer({ name: 'multi-agent-debate', version: '3.0.0' });
        registerTools(server);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          onsessioninitialized: (sid) => {
            console.error(`[mcp] Sesión inicializada: ${sid}`);
            streamableSessions.set(sid, { transport, createdAt: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            streamableSessions.delete(transport.sessionId);
          }
        };
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId && !streamableSessions.has(transport.sessionId)) {
        streamableSessions.set(transport.sessionId, { transport, createdAt: Date.now() });
      }
    } catch (err) {
      console.error(`[mcp] ERROR: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32600, message: err.message }, id: null });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId || !streamableSessions.has(sessionId)) {
        return res.status(400).json({ error: 'Session ID inválido' });
      }
      const { transport } = streamableSessions.get(sessionId);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && streamableSessions.has(sessionId)) {
      streamableSessions.delete(sessionId);
    }
    res.status(200).end();
  });

  // ── API: debate en vivo ───────────────────────────────────────────
  app.get('/api/debate/live', (req, res) => {
    const debate = dm.getActiveDebate();
    if (!debate) {
      const all = dm.listDebates();
      const latest = all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      if (latest) {
        const full = dm.read(latest.id);
        // Re-read full debate data from state
        return res.json({ debate: {
          ...full.debate,
          messages: full.messages,
          participants: [],
          synthesis: null,
          phases: [],
          rules: full.rules || [],
          intensity: full.debate.intensity || 'moderado',
        }});
      }
      return res.json({ debate: null });
    }
    const phase = dm.getCurrentPhase(debate.currentRound, debate.phases);
    res.json({
      debate: {
        id: debate.id,
        topic: debate.topic,
        status: debate.status,
        category: debate.category,
        intensity: debate.intensity || 'adversarial',
        currentRound: debate.currentRound,
        maxRounds: debate.maxRounds,
        participants: debate.participants,
        messages: debate.messages,
        synthesis: debate.synthesis,
        spokenThisRound: debate.spokenThisRound || [],
        exchangeCount: debate.exchangeCount || {},
        minExchangesPerRound: debate.minExchangesPerRound || 1,
        rules: debate.rules || [],
        currentPhase: phase ? phase.name : null,
        phaseInstruction: phase ? phase.instruction : null,
        phases: (debate.phases || []).map(p => ({ name: p.name, rounds: p.rounds })),
        knowledgeBaseCount: (debate.knowledgeBase || []).length,
        situacion: debate.situacion || null,
        situacionName: debate.situacionName || null,
        coordination: debate.coordination || null,
      },
    });
  });

  // ── Session Management API ─────────────────────────────────────────

  app.get('/api/sessions', (req, res) => {
    const debates = dm.listDebates();
    const result = debates
      .map(d => {
        const full = dm.read(d.id);
        const msgs = full.messages || [];
        const lastTs = msgs.length ? new Date(msgs[msgs.length - 1].timestamp || d.createdAt) : new Date(d.createdAt);
        const endTs = d.status === 'active' ? new Date() : lastTs;
        const duration = Math.round((endTs - new Date(d.createdAt)) / 1000);
        return { id: d.id, topic: d.topic, status: d.status, category: d.category, intensity: d.intensity, participants: d.participants, messageCount: d.messageCount, currentRound: d.currentRound, maxRounds: d.maxRounds, currentPhase: d.currentPhase, createdAt: d.createdAt, duration };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ sessions: result });
  });

  app.get('/api/sessions/stats', (req, res) => {
    const debates = dm.listDebates();
    const totalDebates = debates.length;
    let totalMessages = 0;
    const categoryCounts = {};
    const intensityCounts = {};
    for (const d of debates) {
      totalMessages += d.messageCount || 0;
      if (d.category) categoryCounts[d.category] = (categoryCounts[d.category] || 0) + 1;
      if (d.intensity) intensityCounts[d.intensity] = (intensityCounts[d.intensity] || 0) + 1;
    }
    const avgMessagesPerDebate = totalDebates ? +(totalMessages / totalDebates).toFixed(2) : 0;
    const mostUsedCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    res.json({ totalDebates, totalMessages, avgMessagesPerDebate, mostUsedCategory, intensityDistribution: intensityCounts });
  });

  app.get('/api/sessions/:id', (req, res) => {
    const full = dm.read(req.params.id);
    if (!full || !full.debate) return res.status(404).json({ error: 'Session not found' });
    const msgs = full.messages || [];
    const agentCounts = {};
    let totalWords = 0;
    for (const m of msgs) {
      if (m.role) agentCounts[m.role] = (agentCounts[m.role] || 0) + 1;
      if (m.content) totalWords += m.content.split(/\s+/).filter(Boolean).length;
    }
    const lastTs = msgs.length ? new Date(msgs[msgs.length - 1].timestamp || full.debate.createdAt) : new Date(full.debate.createdAt);
    const endTs = full.debate.status === 'active' ? new Date() : lastTs;
    const duration = Math.round((endTs - new Date(full.debate.createdAt)) / 1000);
    const stats = { totalMessages: msgs.length, messagesPerAgent: agentCounts, avgWordsPerMessage: msgs.length ? +(totalWords / msgs.length).toFixed(2) : 0, duration };
    res.json({ debate: full.debate, messages: msgs, participants: full.debate.participants || [], phases: full.debate.phases || [], knowledgeBase: full.knowledgeBase || [], synthesis: full.debate.synthesis || null, stats });
  });

  // ── Proposals API ────────────────────────────────────────────────
  app.get('/api/proposals', (req, res) => {
    const debateId = req.query.debate_id;
    const props = dm.listProposals(debateId);
    res.json({ proposals: props });
  });

  app.get('/api/proposals/:id', (req, res) => {
    const prop = dm.getProposal(req.params.id);
    if (prop.error) return res.status(404).json(prop);
    res.json({ proposal: prop });
  });

  // ── Orchestrator SSE events ──────────────────────────────────────
  app.get('/api/orchestrator/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    orchClients.add(res);
    req.on('close', () => orchClients.delete(res));
  });

  app.get('/api/orchestrator/status', (req, res) => {
    const orchestrations = [];
    for (const [id, orch] of activeOrchestrations) {
      orchestrations.push({
        id: orch.id,
        status: orch.status,
        tema: orch.tema,
        situacion: orch.situacion,
        messageCount: orch.messages.length,
        duration: ((Date.now() - orch.startTime) / 1000).toFixed(1) + 's',
      });
    }
    res.json({ orchestrations });
  });

  // ── Dashboard ─────────────────────────────────────────────────────
  app.get('/dashboard', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(getDashboardHtml());
  });

  // Dashboard v2 — Enhanced version
  app.get('/dashboard-v2', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const dashV2Path = path.join(__dirname, 'dashboard-v2.html');
    if (fs.existsSync(dashV2Path)) {
      res.send(fs.readFileSync(dashV2Path, 'utf-8'));
    } else {
      res.send(getDashboardHtml()); // fallback to v1
    }
  });

  // Agent World — Isometric visualization
  app.get('/world', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const worldPath = path.join(__dirname, 'dashboard-world.html');
    if (fs.existsSync(worldPath)) {
      res.send(fs.readFileSync(worldPath, 'utf-8'));
    } else {
      res.status(404).send('World view not found');
    }
  });

  function getDashboardHtml() {
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Multi-Agent Debate v3 — Live Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#e0e0e0;height:100vh;display:flex;flex-direction:column}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:14px 24px;border-bottom:1px solid #2a2a4a;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:18px;color:#7c83ff;font-weight:600}
.status{display:flex;align-items:center;gap:8px;font-size:13px;color:#888}
.dot{width:8px;height:8px;border-radius:50%;background:#444;transition:background .3s}
.dot.live{background:#4ade80;animation:pulse 2s infinite}
.dot.ended{background:#f87171}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.topic-bar{background:#111122;padding:10px 24px;border-bottom:1px solid #222244;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.topic{font-size:15px;color:#c8c8ff;font-weight:500;flex:1;min-width:200px}
.meta{font-size:12px;color:#666;display:flex;gap:12px;flex-wrap:wrap}
.meta-item{background:#1a1a33;padding:2px 8px;border-radius:4px}
.intensity-badge{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px}
.intensity-adversarial{background:#4a1a1a;color:#ff6b6b;border:1px solid #ff6b6b40}
.intensity-moderado{background:#3a3a1a;color:#fdcb6e;border:1px solid #fdcb6e40}
.intensity-casual{background:#1a3a2a;color:#55efc4;border:1px solid #55efc440}
.phase-bar{background:#0d0d1a;padding:8px 24px;border-bottom:1px solid #1a1a33;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.phase-pill{padding:4px 12px;border-radius:16px;font-size:11px;font-weight:500;background:#1a1a33;color:#555;border:1px solid #222244;transition:all .3s}
.phase-pill.active{background:#2a1a4a;color:#a29bfe;border-color:#6c5ce7}
.phase-pill.done{background:#1a2a1a;color:#55efc4;border-color:#00b89440}
.rules-bar{background:#1a0a0a;padding:8px 24px;border-bottom:1px solid #2a1a1a;font-size:11px;color:#ff6b6b88;max-height:60px;overflow-y:auto;display:none}
.rules-bar.show{display:block}
.rules-bar span{color:#ff6b6b;font-weight:600}
.coord-bar{background:#0a1a2a;padding:8px 24px;border-bottom:1px solid #1a2a44;font-size:11px;color:#74b9ff;display:none}
.coord-bar.show{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.coord-bar .sit-badge{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;background:#1a2a4a;color:#74b9ff;border:1px solid #0984e340}
.coord-bar .flow{color:#55efc4;font-size:11px}
.coord-bar .dep{color:#fdcb6e;font-size:10px;background:#2a2a1a;padding:2px 6px;border-radius:4px}
.pbar{background:#0d0d1a;padding:6px 24px;border-bottom:1px solid #1a1a33;display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-height:32px}
.chip{padding:3px 10px;border-radius:16px;font-size:11px;font-weight:500;border:1px solid;display:flex;align-items:center;gap:4px}
.chip .spoke{font-size:9px}
.chat{flex:1;overflow-y:auto;padding:12px 24px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
.chat::-webkit-scrollbar{width:6px}
.chat::-webkit-scrollbar-thumb{background:#333;border-radius:3px}
.msg{display:flex;gap:10px;animation:fadeIn .4s ease-out;max-width:90%}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.avatar{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:bold;flex-shrink:0;color:#fff}
.bubble{background:#14142a;border:1px solid #222244;border-radius:12px;padding:10px 14px;min-width:200px;max-width:100%}
.mh{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:8px}
.mname{font-size:12px;font-weight:600}
.mtime{font-size:10px;color:#555}
.mrole{font-size:10px;background:#1a1a33;padding:2px 6px;border-radius:4px;color:#666}
.mround{font-size:10px;color:#555;background:#1a1a33;padding:2px 6px;border-radius:4px}
.mphase{font-size:9px;color:#6c5ce7;background:#1a1a2e;padding:2px 6px;border-radius:4px}
.mtext{font-size:13px;line-height:1.5;color:#ccc;white-space:pre-wrap;word-break:break-word}
.rdiv{display:flex;align-items:center;gap:12px;padding:6px 0;color:#555;font-size:11px;text-transform:uppercase;letter-spacing:1px}
.rdiv::before,.rdiv::after{content:'';flex:1;height:1px;background:linear-gradient(to right,transparent,#333,transparent)}
.rdiv .phase-tag{color:#6c5ce7;font-weight:600;font-size:10px}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#444}
.empty .icon{font-size:48px}
.footer{background:#111122;padding:8px 24px;border-top:1px solid #222244;display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#555}
</style>
</head>
<body>
<div class="header">
  <h1>&#9889; Multi-Agent Debate v3</h1>
  <div class="status"><div class="dot" id="dot"></div><span id="stxt">Conectando...</span></div>
</div>
<div id="tbar" class="topic-bar" style="display:none">
  <span class="topic" id="ttxt"></span>
  <div class="meta">
    <span class="intensity-badge" id="ibadge"></span>
    <span class="meta-item" id="rinfo"></span>
    <span class="meta-item" id="mcount"></span>
  </div>
</div>
<div id="phbar" class="phase-bar" style="display:none"></div>
<div id="rbar" class="rules-bar"></div>
<div id="cbar" class="coord-bar"></div>
<div id="pbar" class="pbar"></div>
<div class="chat" id="chat">
  <div class="empty" id="empty">
    <div class="icon">&#9889;</div>
    <p>No hay debate activo</p>
    <code style="background:#1a1a2e;padding:8px 16px;border-radius:8px;color:#7c83ff">Usa "iniciar_debate" desde cualquier IA conectada</code>
  </div>
</div>
<div class="footer">
  <div style="display:flex;align-items:center;gap:6px"><div class="dot" id="fdot"></div><span id="ftxt">Dashboard en tiempo real</span></div>
  <span id="lupd"></span>
</div>
<script>
const COLORS=[{bg:'#2a1a4a',b:'#6c5ce7',t:'#a29bfe',a:'#6c5ce7'},{bg:'#1a2a4a',b:'#0984e3',t:'#74b9ff',a:'#0984e3'},{bg:'#1a4a2a',b:'#00b894',t:'#55efc4',a:'#00b894'},{bg:'#4a2a1a',b:'#e17055',t:'#fab1a0',a:'#e17055'},{bg:'#4a1a3a',b:'#e84393',t:'#fd79a8',a:'#e84393'},{bg:'#3a3a1a',b:'#fdcb6e',t:'#ffeaa7',a:'#d4a017'}];
const cmap={};let ci=0,last=0,lastR=0,curId=null;
function gc(n){if(!cmap[n]){cmap[n]=COLORS[ci%COLORS.length];ci++}return cmap[n]}
function ini(n){return n.split('-').map(w=>w[0]).join('').toUpperCase().slice(0,2)}
function fmt(ts){return new Date(ts).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function setS(s){
  const d=document.getElementById('dot'),f=document.getElementById('fdot'),t=document.getElementById('stxt');
  if(s==='live'){d.className='dot live';f.className='dot live';t.textContent='EN VIVO';t.style.color='#4ade80'}
  else if(s==='ended'){d.className='dot ended';f.className='dot ended';t.textContent='Finalizado';t.style.color='#f87171'}
  else{d.className='dot';f.className='dot';t.textContent='Sin debate';t.style.color='#888'}
}
function renderPhases(phases, currentRound) {
  const bar = document.getElementById('phbar');
  if (!phases || phases.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '<span style="font-size:11px;color:#555;margin-right:6px">Fases:</span>';
  phases.forEach(p => {
    const pill = document.createElement('span');
    pill.className = 'phase-pill';
    if (currentRound >= p.rounds[0] && currentRound <= p.rounds[1]) pill.className += ' active';
    else if (currentRound > p.rounds[1]) pill.className += ' done';
    pill.textContent = p.name + ' (R' + p.rounds[0] + '-' + p.rounds[1] + ')';
    bar.appendChild(pill);
  });
}
function renderRules(rules) {
  const bar = document.getElementById('rbar');
  if (!rules || rules.length === 0) { bar.className = 'rules-bar'; return; }
  bar.className = 'rules-bar show';
  bar.innerHTML = '<span>REGLAS:</span> ' + rules.map((r,i) => (i+1)+'. '+esc(r)).join(' | ');
}
function renderCoord(d) {
  const bar = document.getElementById('cbar');
  if (!d.situacionName || !d.coordination) { bar.className = 'coord-bar'; return; }
  bar.className = 'coord-bar show';
  let html = '<span class="sit-badge">' + esc(d.situacionName) + '</span>';
  html += '<span class="flow">' + esc(d.coordination.flowDescription) + '</span>';
  bar.innerHTML = html;
}
function renderP(ps, spoken) {
  const b=document.getElementById('pbar');
  const spokenSet = new Set(spoken || []);
  b.innerHTML='<span style="font-size:11px;color:#555;margin-right:4px">Agentes:</span>';
  ps.forEach(p=>{
    const col=gc(p.name||p),n=p.name||p;
    const chip=document.createElement('span');
    chip.className='chip';chip.style.background=col.bg;chip.style.borderColor=col.b;chip.style.color=col.t;
    const hasSp = spokenSet.has(n);
    chip.innerHTML=(hasSp?'<span class="spoke" style="color:#4ade80">&#10003;</span>':'<span class="spoke" style="color:#f87171">&#9711;</span>')+' '+esc(n)+(p.role&&p.role!=='participante'?' <span style="opacity:0.6">('+esc(p.role)+')</span>':'');
    b.appendChild(chip);
  });
}
function addMsg(m){
  const c=document.getElementById('chat'),col=gc(m.participantName),e=document.createElement('div');
  e.className='msg';
  const phaseTag = m.phase ? '<span class="mphase">'+esc(m.phase)+'</span>' : '';
  e.innerHTML='<div class="avatar" style="background:'+col.a+'">'+ini(m.participantName)+'</div><div class="bubble" style="border-color:'+col.b+'40"><div class="mh"><span class="mname" style="color:'+col.t+'">'+esc(m.participantName)+'</span><span>'+'<span class="mtime">'+fmt(m.timestamp)+'</span>'+(m.participantRole?'<span class="mrole">'+esc(m.participantRole)+'</span>':'')+'<span class="mround">R'+m.round+'</span>'+phaseTag+'</span></div><div class="mtext">'+esc(m.text)+'</div></div>';
  c.appendChild(e);
}
function addRound(r, phase){
  const c=document.getElementById('chat'),d=document.createElement('div');
  d.className='rdiv';
  d.innerHTML='Ronda '+r+(phase?' <span class="phase-tag">'+esc(phase)+'</span>':'');
  c.appendChild(d);
}
async function poll(){try{
  const r=await fetch('/api/debate/live');if(!r.ok)throw new Error();
  const data=await r.json();
  if(!data.debate){setS('idle');document.getElementById('tbar').style.display='none';document.getElementById('phbar').style.display='none';document.getElementById('rbar').className='rules-bar';document.getElementById('empty').style.display='flex';document.getElementById('lupd').textContent='Actualizado: '+new Date().toLocaleTimeString();return}
  const d=data.debate;
  document.getElementById('empty').style.display='none';
  document.getElementById('tbar').style.display='flex';
  document.getElementById('ttxt').textContent=d.topic;
  document.getElementById('rinfo').textContent='Ronda '+d.currentRound+'/'+(d.maxRounds||'inf');
  document.getElementById('mcount').textContent=d.messages.length+' msgs';
  const ib=document.getElementById('ibadge');
  ib.textContent=d.intensity||'moderado';
  ib.className='intensity-badge intensity-'+(d.intensity||'moderado').toLowerCase();
  setS(d.status==='active'?'live':'ended');
  if(d.phases)renderPhases(d.phases,d.currentRound);
  if(d.rules)renderRules(d.rules);
  renderCoord(d);
  if(d.participants&&d.participants.length>0)renderP(d.participants,d.spokenThisRound);
  if(d.id!==curId){curId=d.id;last=0;lastR=0;document.getElementById('chat').innerHTML=''}
  if(d.messages.length>last){
    const nm=d.messages.slice(last);
    for(const m of nm){
      if(m.round>lastR){
        const ph=d.phases?d.phases.find(p=>m.round>=p.rounds[0]&&m.round<=p.rounds[1]):null;
        addRound(m.round,ph?ph.name:d.currentPhase);
        lastR=m.round;
      }
      addMsg(m);
    }
    last=d.messages.length;
    const c=document.getElementById('chat');c.scrollTop=c.scrollHeight;
  }
  document.getElementById('lupd').textContent='Actualizado: '+new Date().toLocaleTimeString();
}catch(e){document.getElementById('ftxt').textContent='Error - reintentando...'}}
poll();setInterval(poll,1500);
</script>
</body>
</html>`;
  }

  // Health check
  app.get('/', (req, res) => {
    const activeDebate = dm.getActiveDebate();
    res.json({
      name: 'multi-agent-debate',
      version: '3.0.0',
      status: 'running',
      connections: connections.size,
      streamableSessions: streamableSessions.size,
      endpoints: {
        dashboard: `http://localhost:${port}/dashboard`,
        dashboardV2: `http://localhost:${port}/dashboard-v2`,
        agentWorld: `http://localhost:${port}/world`,
        streamableHttp: `http://localhost:${port}/mcp`,
        sse: `http://localhost:${port}/sse`,
        liveApi: `http://localhost:${port}/api/debate/live`,
        sessionsApi: `http://localhost:${port}/api/sessions`,
        proposalsApi: `http://localhost:${port}/api/proposals`,
      },
      activeDebate: activeDebate ? {
        id: activeDebate.id,
        topic: activeDebate.topic,
        intensity: activeDebate.intensity,
        participants: activeDebate.participants.map(p => `${p.name} (${p.role})`),
        messages: activeDebate.messages.length,
        round: `${activeDebate.currentRound}/${activeDebate.maxRounds || 'inf'}`,
      } : null,
      tools: ['onboarding','run_debate','iniciar_debate','unirse','decir','leer','avanzar_ronda','votar_finalizar','finalizar','debates','estado','roles','agregar_contexto','consultar_fuente','banco','turno','ronda_completa','decir_lote','situaciones','situacion','workflow_status','read_project_file','list_project_files','propose_edit','review_proposal','apply_proposal','revert_proposal','list_proposals','run_tests','governance_status','buscar_similar','embedding_stats','health_check'],
    });
  });

  app.listen(port, () => {
    console.error(`
\x1b[1;35m╔═══════════════════════════════════════════════════════════╗
║  ⚡ Multi-Agent Debate v3 — MCP Server                    ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  Dashboard:  http://localhost:${port}/dashboard               ║
║  Server:     http://localhost:${port}                         ║
║  MCP:        http://localhost:${port}/mcp (Figma/Streamable)  ║
║  SSE:        http://localhost:${port}/sse (Claude Desktop)    ║
║                                                           ║
║  Features: Fases, Roles Antagonistas, Intensidad          ║
║  Esperando conexiones de IAs...                           ║
╚═══════════════════════════════════════════════════════════╝\x1b[0m
`);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

const { mode, port } = parseArgs();

if (mode === 'http') {
  startHttp(port);
} else {
  startStdio().catch(err => {
    console.error('[multi-agent-debate] Fatal error:', err);
    process.exit(1);
  });
}
