/**
 * @fileoverview The inspector's tabs per kind and mode (7.52.00 C2; docs/ux part 5 §5.4): an agent's (a run's agents
 * first; its arrows only outside a run), a gate's (a run's checks and reviewers first), a call's.
 *
 * @module components/WorkflowEditor/inspector/inspectorTabs
 */
import type { FlowMode } from '../nodes/nodeData'

export type AgentTab = 'agents' | 'setup' | 'assertions' | 'arrows'
export type GateTab = 'checks' | 'reviewers' | 'setup' | 'packs' | 'assertions' | 'arrows'
export type CallTab = 'setup' | 'preview'

export const agentTabs = (mode: FlowMode): readonly AgentTab[] =>
  (mode === 'run' ? ['agents', 'setup', 'assertions'] : ['setup', 'assertions', 'arrows'])

export const gateTabs = (mode: FlowMode): readonly GateTab[] =>
  (mode === 'run' ? ['checks', 'reviewers', 'setup'] : ['setup', 'packs', 'assertions', 'arrows'])

export const CALL_TABS: readonly CallTab[] = ['setup', 'preview']
