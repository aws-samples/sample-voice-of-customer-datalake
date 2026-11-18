/**
 * @fileoverview jsdom cannot lay out React Flow: a spec replaces `ReactFlow` with a probe that renders nothing and
 * records the props a canvas passes it, so the spec can read them and call the handlers as React Flow would.
 *
 *   vi.mock('@xyflow/react', async (importOriginal) => (await import('@test/reactFlowProbe')).reactFlowProbeModule(importOriginal))
 *   import { probedFlowProps } from '@test/reactFlowProbe'
 *
 * @module test/reactFlowProbe
 */
import type { Connection, Edge, EdgeChange, Node, NodeChange, OnSelectionChangeParams } from '@xyflow/react'

/** What the specs read of the props a canvas passes React Flow (FlowCanvas, WorkflowCanvas, RunCanvas). */
export interface ProbedFlowProps {
  nodes: Node[]
  edges: Edge[]
  nodesDraggable: boolean
  nodesConnectable: boolean
  deleteKeyCode: unknown
  onConnect: (connection: Connection) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  /** (7.54.00) What React Flow reports of its nodes: a measure (`dimensions`), a move, a selection. */
  onNodesChange: (changes: NodeChange[]) => void
  /** (React Flow passes its mouse event first; the canvas reads only the node) */
  onNodeClick: (event: unknown, node: Node) => void
  onSelectionChange: (params: OnSelectionChangeParams) => void
}

const probe: { last: ProbedFlowProps | null } = { last: null }

function ReactFlowProbe(props: ProbedFlowProps) {
  probe.last = props
  return null
}

/** The `@xyflow/react` module with `ReactFlow` replaced by the probe (a `vi.mock` factory). */
export async function reactFlowProbeModule(importOriginal: <T>() => Promise<T>) {
  return { ...(await importOriginal<typeof import('@xyflow/react')>()), ReactFlow: ReactFlowProbe }
}

/** The props the probe was last rendered with. */
export function probedFlowProps(): ProbedFlowProps {
  if (probe.last === null) throw new Error('ReactFlow was not rendered')
  return probe.last
}
