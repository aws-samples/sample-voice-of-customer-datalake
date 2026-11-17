/**
 * @fileoverview What every canvas node is handed (7.52.00 C2): its step, kind, inline issues and run state as node
 * data, and through {@link FlowLookupsContext} what the canvas knows beside the definition: the Registry's cards (an
 * agent's chips: model, version), the library's flows (a call's child name), the mode (build, view or run) and the
 * id the canvas's descriptions are keyed by. A node rendered outside a canvas (the palette's drag preview, a spec)
 * reads the empty lookups.
 *
 * @module components/WorkflowEditor/nodes/nodeData
 */
import { createContext, useContext } from 'react'
import type { Node } from '@xyflow/react'
import type { RegistryCard } from '../../../api/flowSetupApi'
import type { WorkflowLoop, WorkflowNode } from '../../../api/workflowsApi'
import type { LaneState, StepState } from '../runState'
import type { NodeKind } from './nodeKinds'

/** Build (an administrator edits), view (read only: a viewer, an agent's Flow tab, a template preview) or run. */
export type FlowMode = 'build' | 'view' | 'run'

export type StepNodeData = {
  step: WorkflowNode
  kind: NodeKind
  /** Inline validation messages (build). */
  issues: readonly string[]
  run?: StepState
}
export type StepFlowNode = Node<StepNodeData, NodeKind>

export type LoopFrameData = {
  loop: WorkflowLoop
  index: number
  width: number
  height: number
}
export type LoopFrameFlowNode = Node<LoopFrameData, 'loopFrame'>

/** (7.52.00, run) A call's steps grouped under it: `<call>.<child>` steps of the run's flat copy. */
export type CallFrameData = {
  /** The call step's id (the prefix of its children's). */
  call: string
  /** What the frame's label reads ("Issue triage · r2"). */
  label: string
  /** "3 of 6 steps done". */
  progress: string
  width: number
  height: number
}
export type CallFrameFlowNode = Node<CallFrameData, 'callFrame'>

export type LaneData = {
  /** The agent on the task, else its role. */
  label: string
  role: string
  state: LaneState
  attempt: number
  /** The agent the workspace has open. */
  open: boolean
  width: number
  height: number
}
export type LaneFlowNode = Node<LaneData, 'lane'>

/** A flow the library holds, as a call node names it. */
export interface FlowName { readonly name: string; readonly revision: number }

export interface FlowLookups {
  readonly mode: FlowMode
  /** The Registry's cards by id (empty when not read: a viewer, the module off). */
  readonly cards: ReadonlyMap<string, RegistryCard>
  /** The library's flows by id. */
  readonly flows: ReadonlyMap<string, FlowName>
  /** The canvas's own id: a node's description is `<descPrefix>-desc-<node id>`. */
  readonly descPrefix: string
  /** An engineering flow's pull-request state (Start's `pr`: `ready` or `draft`); null for an agents workflow. */
  readonly prState: string | null
  /** Whether the nodes draw their handles: on a canvas (React Flow's store), never in a drag preview. */
  readonly handles: boolean
}

const NO_CARDS: ReadonlyMap<string, RegistryCard> = new Map()
const NO_FLOWS: ReadonlyMap<string, FlowName> = new Map()

export const EMPTY_LOOKUPS: FlowLookups = {
  mode: 'view', cards: NO_CARDS, flows: NO_FLOWS, descPrefix: 'flow', prState: null, handles: false,
}

export const FlowLookupsContext = createContext<FlowLookups>(EMPTY_LOOKUPS)

export const useFlowLookups = (): FlowLookups => useContext(FlowLookupsContext)

/** The id of a node's description (the role, the chips, a failure's reason), named by its `aria-describedby`. */
export const nodeDescriptionId = (prefix: string, nodeId: string): string => `${prefix}-desc-${nodeId}`
