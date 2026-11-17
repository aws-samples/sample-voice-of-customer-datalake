/**
 * @fileoverview The canvas's React Flow node types by KIND (7.52.00 C2): each kind its renderer, plus the frames and
 * a run's lanes. A node's `type` is its kind (`nodeKinds.ts kindOf`), so a decision (an `end` that needs a person)
 * draws as a decision whatever its stored type.
 *
 * @module components/WorkflowEditor/nodes/nodeTypes
 */
import { AgentNode } from './AgentNode'
import { CallFlowNode } from './CallFlowNode'
import { DecisionNode } from './DecisionNode'
import { CallFrameNode, LaneNode, LoopFrameNode } from './FrameNodes'
import { GateNode } from './GateNode'
import { PlatformNode } from './PlatformNode'
import { TerminalNode } from './TerminalNode'
import type { ComponentType } from 'react'
import type { NodeProps, NodeTypes } from '@xyflow/react'
import type { StepFlowNode } from './nodeData'
import type { NodeKind } from './nodeKinds'

/** Each kind's renderer (the canvas and the drag preview draw a step through it). */
export const KIND_RENDERERS: Readonly<Record<NodeKind, ComponentType<NodeProps<StepFlowNode>>>> = {
  trigger: TerminalNode,
  agent: AgentNode,
  team: AgentNode,
  gate: GateNode,
  call: CallFlowNode,
  decision: DecisionNode,
  end: TerminalNode,
  platform: PlatformNode,
}

export const NODE_TYPES: NodeTypes = { ...KIND_RENDERERS, loopFrame: LoopFrameNode, callFrame: CallFrameNode, lane: LaneNode }
