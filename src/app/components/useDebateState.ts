/**
 * useDebateState — Central state management for the debate UI.
 * Provides reducer + context for all components. Single provider, single hook.
 * Includes deriveConsensusFromMessages() — uses regex to auto-detect sentiment
 * from message content. Matches ACEPTO/OBJECIÓN/etc at message level against
 * mentioned agents. Future: sentence-level parsing + confirm chips (v1.1).
 */

import { useReducer, createContext, useContext, useMemo } from 'react';
import type { DebateState, DebateAction, ConsensusMap, Message, Agent, Sentiment } from './types';

function deriveConsensusFromMessages(
  messages: Message[],
  agents: Agent[]
): ConsensusMap {
  const map: ConsensusMap = {};
  
  for (const agent of agents) {
    map[agent.id] = {};
    for (const otherAgent of agents) {
      if (agent.id !== otherAgent.id) {
        map[agent.id][otherAgent.id] = 'neutral';
      }
    }
  }

  for (const msg of messages) {
    const fromAgent = msg.agentId;
    
    for (const mentionedId of msg.mentionedAgents) {
      if (mentionedId === fromAgent) continue;
      
      let sentiment: Sentiment = 'neutral';
      
      if (/APROBADO|ACEPTO|DE ACUERDO|VOTO A FAVOR|APOYO|CORRECTO|TIENE RAZÓN/i.test(msg.content)) {
        sentiment = 'agree';
      }
      if (/OBJECIÓN|RECHAZO|VETO|INCORRECTO|INACEPTABLE|NO ESTOY DE ACUERDO/i.test(msg.content)) {
        sentiment = 'object';
      }
      
      if (map[fromAgent]) {
        map[fromAgent][mentionedId] = sentiment;
      }
    }
  }

  return map;
}

function debateReducer(state: DebateState, action: DebateAction): DebateState {
  switch (action.type) {
    case 'SET_FILTER_AGENT':
      return { ...state, filters: { ...state.filters, agentId: action.agentId } };
    case 'SET_FILTER_PHASE':
      return { ...state, filters: { ...state.filters, phase: action.phase } };
    case 'SET_VIEW':
      return { ...state, activeView: action.view };
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case 'TOGGLE_CONTEXT_DRAWER':
      return { ...state, contextDrawerOpen: !state.contextDrawerOpen };
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message] };
    case 'SET_AGENT_STATUS':
      return {
        ...state,
        agents: state.agents.map(a =>
          a.id === action.agentId ? { ...a, status: action.status } : a
        ),
      };
    default:
      return state;
  }
}

interface DebateContextType {
  state: DebateState;
  dispatch: React.Dispatch<DebateAction>;
  consensus: ConsensusMap;
  filteredMessages: Message[];
}

const DebateContext = createContext<DebateContextType | null>(null);

export function useDebateContext() {
  const ctx = useContext(DebateContext);
  if (!ctx) throw new Error('useDebateContext must be used within DebateProvider');
  return ctx;
}

export { DebateContext, debateReducer, deriveConsensusFromMessages };

export function useDebateReducer(initialState: DebateState) {
  const [state, dispatch] = useReducer(debateReducer, initialState);

  const consensus = useMemo(
    () => deriveConsensusFromMessages(state.messages, state.agents),
    [state.messages, state.agents]
  );

  const filteredMessages = useMemo(() => {
    let msgs = state.messages;
    if (state.filters.agentId) {
      msgs = msgs.filter(m => m.agentId === state.filters.agentId);
    }
    if (state.filters.phase) {
      msgs = msgs.filter(m => m.phase === state.filters.phase);
    }
    return msgs;
  }, [state.messages, state.filters]);

  return { state, dispatch, consensus, filteredMessages };
}
