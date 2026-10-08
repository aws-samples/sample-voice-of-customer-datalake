/**
 * @fileoverview The React Flow adapter: renders a workflow definition (steps,
 * arrows, loop frames) and turns canvas gestures into definition edits through
 * the pure operations in `model.ts`. Two modes:
 * - editable — drag, connect, delete, drop from the palette, multi-select;
 * - read-only (run graph) — nothing can be moved, connected or deleted; steps
 *   are lit by the run's event journal. A misclick there must not spend tokens.
 *
 * React Flow keeps its own measured node state, so the canvas holds the flow
 * nodes locally and re-derives them from the definition whenever it changes,
 * carrying over measurements and selection. Positions reach the definition on
 * drag END only (one edit per move, not one per frame).
 *
 * @module components/WorkflowEditor/WorkflowCanvas
 */
import '@xyflow/react/dist/style.css'
import './workflowCanvas.css'
import { useCallback, useMemo, useState } from 'react'
import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { LoopFrameNode, StepNode } from './CanvasNodes'
import { NO_EDGES, applyEdgeSelection } from './edgeSelection'
import { PALETTE_MIME, addNode, connect, loopBounds, moveNodes, parseNodeType, removeEdges, removeNodes } from './model'
import type { DragEvent } from 'react'
import type { TFunction } from 'i18next'
import type { Connection, Edge, EdgeChange, NodeChange, NodeTypes, OnSelectionChangeParams } from '@xyflow/react'
import type { WorkflowDefinition, WorkflowEdge, WorkflowLoop } from '../../api/workflowsApi'
import type { LoopFrameFlowNode, StepFlowNode } from './CanvasNodes'
import type { CanvasSelection } from './selection'
import type { StepState } from './runState'

type FlowNode = StepFlowNode | LoopFrameFlowNode

const NODE_TYPES: NodeTypes = { step: StepNode, loopFrame: LoopFrameNode }

interface WorkflowCanvasProps {
  definition: WorkflowDefinition
  readOnly?: boolean
  /** Inline validation messages per step id. */
  issuesByNode?: ReadonlyMap<string, readonly string[]>
  /** Run-graph state per step id (read-only mode). */
  runStates?: ReadonlyMap<string, StepState>
  /**
   * A selection made outside the canvas (side panel, palette): applied to the
   * canvas whenever this object changes, so both always show the same thing.
   */
  selection?: CanvasSelection
  onChange?: (definition: WorkflowDefinition) => void
  onSelectionChange?: (selection: CanvasSelection) => void
  /** Selecting a step in read-only mode (event-log filter). */
  onStepClick?: (nodeId: string) => void
}

const LOOP_PREFIX = 'loop:'
const NO_ISSUES: readonly string[] = []

const loopIndexOfFrame = (id: string): number | null => {
  if (!id.startsWith(LOOP_PREFIX)) return null
  const index = Number(id.slice(LOOP_PREFIX.length))
  return Number.isInteger(index) ? index : null
}

function buildNodes(
  definition: WorkflowDefinition,
  issuesByNode: ReadonlyMap<string, readonly string[]> | undefined,
  runStates: ReadonlyMap<string, StepState> | undefined,
  frameLabel: (loop: WorkflowLoop, index: number) => string,
): FlowNode[] {
  const frames: LoopFrameFlowNode[] = definition.loops.flatMap((loop, index) => {
    const box = loopBounds(definition, loop)
    if (box === null) return []
    // Selectable and focusable: clicking a loop's frame (or Tab + Enter) opens its settings.
    return [{
      id: `${LOOP_PREFIX}${index}`,
      type: 'loopFrame',
      position: { x: box.x, y: box.y },
      data: { loop, index, width: box.width, height: box.height },
      ariaLabel: frameLabel(loop, index),
      draggable: false,
      selectable: true,
      connectable: false,
      deletable: false,
      focusable: true,
      zIndex: -1,
    }]
  })
  const steps: StepFlowNode[] = definition.nodes.map((step) => ({
    id: step.id,
    type: 'step',
    position: step.position,
    data: { step, issues: issuesByNode?.get(step.id) ?? NO_ISSUES, run: runStates?.get(step.id) },
  }))
  return [...frames, ...steps]
}

/** Keep React Flow's measurements, selection and in-flight drag positions across re-derivations. */
function carryOver(previous: readonly FlowNode[], next: FlowNode[]): FlowNode[] {
  const byId = new Map(previous.map((n) => [n.id, n]))
  return next.map((node) => {
    const prev = byId.get(node.id)
    if (prev === undefined) return node
    return {
      ...node,
      ...(prev.measured === undefined ? {} : { measured: prev.measured }),
      ...(prev.selected === undefined ? {} : { selected: prev.selected }),
      ...(prev.dragging === true ? { position: prev.position, dragging: true } : {}),
    }
  })
}

/** Flow nodes with exactly `selection`'s steps and loop frames selected (unchanged objects kept). */
function withSelectedNodes(nodes: FlowNode[], selection: CanvasSelection): FlowNode[] {
  const wanted = new Set([...selection.nodeIds, ...selection.loopIndexes.map((i) => `${LOOP_PREFIX}${i}`)])
  const next = nodes.map((node) => {
    const selected = wanted.has(node.id)
    return (node.selected === true) === selected ? node : { ...node, selected }
  })
  return next.every((node, i) => node === nodes[i]) ? nodes : next
}

function withSelectedEdges(current: ReadonlySet<string>, selection: CanvasSelection): ReadonlySet<string> {
  const same = current.size === selection.edgeIds.length && selection.edgeIds.every((id) => current.has(id))
  return same ? current : new Set(selection.edgeIds)
}

/** "Arrow from <title> to <title>[, <condition>]" — React Flow's default names the raw ids. */
function arrowLabel(definition: WorkflowDefinition, edge: WorkflowEdge, t: TFunction<'agents'>): string {
  const title = (id: string) => definition.nodes.find((n) => n.id === id)?.data.title ?? id
  const condition = edge.label === undefined ? t('editor.fields.labelNone') : t(`edgeLabels.${edge.label}`)
  return t('editor.arrowLabel', { source: title(edge.source), target: title(edge.target), condition })
}

function edgeClass(edge: WorkflowEdge, runStates: ReadonlyMap<string, StepState> | undefined): string | undefined {
  const classes: string[] = []
  if (edge.label === 'agreed' || edge.label === 'pass') classes.push('voc-edge-ok')
  if (edge.label === 'not_agreed' || edge.label === 'fail') classes.push('voc-edge-warn')
  const source = runStates?.get(edge.source)
  const target = runStates?.get(edge.target)
  if (source?.status === 'done' && target !== undefined && target.status !== 'idle') classes.push('voc-edge-lit')
  return classes.length === 0 ? undefined : classes.join(' ')
}

function CanvasInner({
  definition, readOnly = false, issuesByNode, runStates, selection, onChange, onSelectionChange, onStepClick,
}: Readonly<WorkflowCanvasProps>) {
  const { t } = useTranslation('agents')
  const { screenToFlowPosition } = useReactFlow()
  const frameLabel = useCallback((loop: WorkflowLoop, index: number) => t('editor.loopFrameLabel', {
    n: index + 1, until: t(`loopUntil.${loop.until}`), rounds: loop.max_rounds,
  }), [t])
  const derived = useMemo(
    () => buildNodes(definition, issuesByNode, runStates, frameLabel),
    [definition, issuesByNode, runStates, frameLabel],
  )
  const [nodes, setNodes] = useState<FlowNode[]>(derived)
  const [synced, setSynced] = useState(derived)
  if (synced !== derived) {
    // Re-derive during render (not in an effect) so a definition change paints once.
    setSynced(derived)
    setNodes((previous) => carryOver(previous, derived))
  }
  // Edges are derived from the definition (controlled), so their selection is held here.
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(NO_EDGES)
  const [appliedSelection, setAppliedSelection] = useState(selection)
  if (selection !== appliedSelection) {
    // After the re-derivation above, so a step added and selected in one edit ends up selected.
    setAppliedSelection(selection)
    if (selection !== undefined) {
      setNodes((current) => withSelectedNodes(current, selection))
      setSelectedEdges((current) => withSelectedEdges(current, selection))
    }
  }

  const edges: Edge[] = useMemo(() => definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label === undefined ? undefined : t(`edgeLabels.${edge.label}`),
    ariaLabel: arrowLabel(definition, edge, t),
    className: edgeClass(edge, runStates),
    markerEnd: { type: MarkerType.ArrowClosed },
    deletable: !readOnly,
    selected: !readOnly && selectedEdges.has(edge.id),
  })), [definition, runStates, readOnly, selectedEdges, t])

  const emit = useCallback((next: WorkflowDefinition) => {
    if (!readOnly && onChange !== undefined && next !== definition) onChange(next)
  }, [definition, onChange, readOnly])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
    if (readOnly) return
    const moves = new Map<string, { x: number; y: number }>()
    const removed = new Set<string>()
    for (const change of changes) {
      if (change.type === 'position' && change.dragging === false && change.position !== undefined && !change.id.startsWith(LOOP_PREFIX)) {
        moves.set(change.id, change.position)
      }
      if (change.type === 'remove' && !change.id.startsWith(LOOP_PREFIX)) removed.add(change.id)
    }
    emit(removeNodes(moveNodes(definition, moves), removed))
  }, [definition, emit, readOnly])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (readOnly) return
    setSelectedEdges((previous) => applyEdgeSelection(previous, changes))
    const removed = new Set(changes.flatMap((c) => (c.type === 'remove' ? [c.id] : [])))
    emit(removeEdges(definition, removed))
  }, [definition, emit, readOnly])

  const onConnect = useCallback((connection: Connection) => {
    emit(connect(definition, connection.source, connection.target))
  }, [definition, emit])

  const handleSelection = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
    const ids = selectedNodes.map((n) => n.id)
    onSelectionChange?.({
      nodeIds: ids.filter((id) => !id.startsWith(LOOP_PREFIX)),
      edgeIds: selectedEdges.map((e) => e.id),
      loopIndexes: ids.flatMap((id) => {
        const index = loopIndexOfFrame(id)
        return index === null ? [] : [index]
      }),
    })
  }, [onSelectionChange])

  const onDragOver = useCallback((event: DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(PALETTE_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [readOnly])

  const onDrop = useCallback((event: DragEvent) => {
    if (readOnly) return
    const type = parseNodeType(event.dataTransfer.getData(PALETTE_MIME))
    if (type === null) return
    event.preventDefault()
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    emit(addNode(definition, type, position, t(`nodeTypes.${type}.label`)).definition)
  }, [definition, emit, readOnly, screenToFlowPosition, t])

  return (
    <div className="voc-workflow h-full w-full" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow<FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onSelectionChange={handleSelection}
        onNodeClick={(_event, node) => {
          if (!node.id.startsWith(LOOP_PREFIX)) onStepClick?.(node.id)
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesFocusable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        // A selected loop frame must stay BEHIND its steps (elevation would cover them).
        elevateNodesOnSelect={false}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        aria-label={readOnly ? t('run.graphLabel') : t('editor.canvasLabel')}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable ariaLabel={t('editor.minimap')} />
      </ReactFlow>
    </div>
  )
}

/** Self-contained: each canvas owns its React Flow store. */
export function WorkflowCanvas(props: Readonly<WorkflowCanvasProps>) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
