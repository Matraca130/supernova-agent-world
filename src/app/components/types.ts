/**
 * types.ts — All shared TypeScript interfaces for Agent World UI.
 * Single source of truth for the data model.
 * Import from here in every component that needs typing.
 */

export type Phase = 'PROPUESTAS' | 'CROSS_EXAMINATION' | 'REFINAMIENTO' | 'DECISIÓN';

export type AgentStatus = 'speaking' | 'waiting' | 'blocked' | 'done';

export type Sentiment = 'agree' | 'object' | 'neutral';

export interface Agent {
  id: string;
  name: string;
  shortName: string;
  role: string;
  emoji: string;
  color: string;
  bgColor: string;
  borderColor: string;
  /** Hex color for SVG GraphView nodes — decoupled from Tailwind classes */
  graphColor: string;
  status: AgentStatus;
  messageCount: number;
}

export interface Message {
  id: string;
  agentId: string;
  content: string;
  timestamp: Date;
  round: number;
  phase: Phase;
  isObjection: boolean;
  mentionedAgents: string[];
  hasCode: boolean;
}

export interface EvidenceSource {
  id: string;
  name: string;
  category: 'codigo' | 'sql' | 'doc' | 'config';
  content: string;
  language?: string;
}

export interface DeployStep {
  id: string;
  name: string;
  description: string;
  status: 'done' | 'in_progress' | 'pending';
  issueNumber?: number;
}

export type ConsensusMap = Record<string, Record<string, Sentiment>>;

export interface DebateState {
  id: string;
  title: string;
  messages: Message[];
  agents: Agent[];
  currentRound: number;
  totalRounds: number;
  currentPhase: Phase;
  consensus: ConsensusMap;
  evidence: EvidenceSource[];
  deploys: DeployStep[];
  filters: {
    agentId?: string;
    phase?: Phase;
  };
  activeView: 'thread' | 'graph' | 'matrix';
  sidebarOpen: boolean;
  contextDrawerOpen: boolean;
}

export type DebateAction =
  | { type: 'SET_FILTER_AGENT'; agentId: string | undefined }
  | { type: 'SET_FILTER_PHASE'; phase: Phase | undefined }
  | { type: 'SET_VIEW'; view: 'thread' | 'graph' | 'matrix' }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_CONTEXT_DRAWER' }
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'SET_AGENT_STATUS'; agentId: string; status: AgentStatus };
