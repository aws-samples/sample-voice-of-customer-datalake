/**
 * @fileoverview The ONE flow canvas (7.52.00 C2; docs/ux part 5 §5.6): a flow drawn in its node language (each kind
 * its shape, nodes/), in one of three modes, beside its inspector (FlowInspector.tsx):
 * - `build` — an administrator edits: drag, connect (a gate's GO and NO-GO from their own handles), delete, drop a
 *   palette item (a block: a Registry card, a gate pack, a flow to call), multi-select;
 * - `view` — read only (a viewer, an agent's Flow tab, a template preview): nothing moves or connects;
 * - `run` — a run's flow lit by its state (the outline and the corner badge), a run's lanes beside its steps (placed
 *   by the host, by the steps' measured sizes: `onMeasured`) and a call's `<call>.<child>` steps framed under it, the
 *   frames holding their lanes; a small minimap, by state, lanes too; inert: a click selects, never acts.
 *
 * Opening follows the SELECTION, not a click, so the keyboard reaches it (N14): Tab moves through the steps in flow
 * order, Enter or Space selects one (`onSelect`), Escape clears it. React Flow keeps its own measured nodes, so the
 * canvas holds them and re-derives them from the definition whenever it changes, keeping measurements and selection;
 * positions reach the definition on a drag's END only (one edit per move).
 *
 * @module components/WorkflowEditor/FlowCanvas
 */
import '@xyflow/react/dist/style.css'
import './workflowCanvas.css'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { isEngineeringFlow } from '../../api/workflowsApi'
import { FIT_VIEW_OPTIONS, focusStepId, startStepId, useFocusStep } from './canvasFocus'
import { NO_EDGES, applyEdgeSelection } from './edgeSelection'
import { BLOCK_MIME, PALETTE_MIME, addBlock, connect, moveNodes, parseBlock, parseNodeType, removeEdges, removeNodes } from './model'
import {
  NO_SIZES, ariaWords, buildEdges, buildNodes, carryOver, isLaneId, isStepId, loopIndexOfFrame, withMeasured, withSelectedNodes,
} from './flowCanvasModel'
import { FlowLookupsContext } from './nodes/nodeData'
import { NODE_TYPES } from './nodes/nodeTypes'
import { kindOf, labelOfHandle, laneMinimapClass, minimapClass, storedPosition } from './nodes/nodeKinds'
import { flowPrState } from './nodes/nodeText'
import { cardsById, useFlowLibrary, useRegistryCards } from './inspector/useFlowSetup'
import { dragTitle } from './paletteItems'
import type { DragEvent, KeyboardEvent } from 'react'
import type { TFunction } from 'i18next'
import type { Connection, EdgeChange, Node, NodeChange, OnSelectionChangeParams } from '@xyflow/react'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { CallFrameSpec, FlowNode, MeasuredSizes } from './flowCanvasModel'
import type { FlowLookups, FlowMode, FlowName, LaneFlowNode } from './nodes/nodeData'
import type { CanvasSelection } from './selection'
import type { StepState } from './runState'
import type { PaletteBlock } from './model'

/** A run's state on the canvas: each step's, its lanes (placed by the caller) and its calls' frames. */
export interface FlowRunState {
  readonly steps: ReadonlyMap<string, StepState>
  readonly lanes?: readonly LaneFlowNode[]
  readonly calls?: readonly CallFrameSpec[]
}

/** What one selection opens: a step, an arrow, a run's lane, a loop; null: nothing (the inspector closes). */
export type FlowSelection =
  | { readonly kind: 'step'; readonly id: string }
  | { readonly kind: 'edge'; readonly id: string }
  | { readonly kind: 'lane'; readonly id: string }
  | { readonly kind: 'loop'; readonly index: number }
  | null

/** How a selection was made: from the keyboard (Enter or Space on a node), so the host moves focus to its inspector. */
export interface SelectHow { readonly keyboard: boolean }

export interface FlowCanvasProps {
  readonly definition: WorkflowDefinition
  readonly mode: FlowMode
  readonly runState?: FlowRunState
  /** One step, arrow, lane or loop selected (a click, Enter), or nothing (Escape, the pane). */
  readonly onSelect?: (selection: FlowSelection, how?: SelectHow) => void
  /** A selection made outside the canvas (the inspector's close, the outline): applied whenever this object changes. */
  readonly selection?: CanvasSelection
  /** Build: every selection change (several steps at once included). */
  readonly onSelectionChange?: (selection: CanvasSelection) => void
  /** Build: the edited definition. */
  readonly onChange?: (definition: WorkflowDefinition) => void
  /** Build: inline validation messages per step id. */
  readonly issuesByNode?: ReadonlyMap<string, readonly string[]>
  /** The canvas's name for assistive tech (default: the editor's, or the run graph's). */
  readonly label?: string
  /** (7.54.00, run) The steps' sizes once React Flow measured them (a run's cards grow with their chips), so the host
   * lays its lanes and rows out by what is drawn. */
  readonly onMeasured?: (sizes: MeasuredSizes) => void
}

const NO_LANES: readonly LaneFlowNode[] = []
const NO_CALLS: readonly CallFrameSpec[] = []
const NO_FLOW_NAMES: ReadonlyMap<string, FlowName> = new Map()

/** The one selection a change makes: a single step, arrow, lane or loop; none for several or nothing. */
function singleOf(nodes: readonly Node[], edges: readonly { id: string }[]): FlowSelection {
  const [node] = nodes
  if (nodes.length === 1 && edges.length === 0 && node !== undefined) {
    const index = loopIndexOfFrame(node.id)
    if (index !== null) return { kind: 'loop', index }
    return isLaneId(node.id) ? { kind: 'lane', id: node.id } : { kind: 'step', id: node.id }
  }
  const [edge] = edges
  return nodes.length === 0 && edges.length === 1 && edge !== undefined ? { kind: 'edge', id: edge.id } : null
}

/** What the nodes read beside their data: the Registry's cards and the library's flows, where they are read. */
function useLookups(definition: WorkflowDefinition, mode: FlowMode, descPrefix: string): FlowLookups {
  const engineering = isEngineeringFlow(definition)
  const registry = useRegistryCards(null, engineering && mode !== 'run')
  const calls = definition.nodes.some((node) => node.type === 'call_flow')
  const library = useFlowLibrary(engineering && calls)
  const prState = engineering ? flowPrState(definition.nodes) : null
  return useMemo(() => ({
    mode, descPrefix, prState, handles: true,
    cards: cardsById(registry.data),
    flows: library.data === undefined ? NO_FLOW_NAMES
      : new Map(library.data.map((flow) => [flow.workflow_id, { name: flow.name, revision: flow.revision }])),
  }), [mode, descPrefix, prState, registry.data, library.data])
}

/** The dropped block: a palette item's (`BLOCK_MIME`), or a bare node type (`PALETTE_MIME`, before 7.52.00). */
function droppedBlock(event: DragEvent, title: (type: string) => string): PaletteBlock | null {
  const block = parseBlock(event.dataTransfer.getData(BLOCK_MIME))
  if (block !== null) return block
  const type = parseNodeType(event.dataTransfer.getData(PALETTE_MIME))
  return type === null ? null : { type, title: title(type) }
}

const carriesBlock = (event: DragEvent): boolean =>
  event.dataTransfer.types.includes(BLOCK_MIME) || event.dataTransfer.types.includes(PALETTE_MIME)

/** The step a canvas centres on: a run's active one, else the start. */
function focusOf(runStates: ReadonlyMap<string, StepState> | undefined, startId: string | undefined): string | undefined {
  return runStates === undefined ? startId : focusStepId(runStates) ?? startId
}

/** What may be done on the canvas: everything while building, nothing that moves, connects or deletes otherwise. */
function interactionOf(building: boolean) {
  return {
    nodesDraggable: building,
    nodesConnectable: building,
    edgesFocusable: building,
    deleteKeyCode: building ? ['Backspace', 'Delete'] : null,
    multiSelectionKeyCode: building ? ['Shift', 'Meta', 'Control'] : null,
  }
}

/** The canvas's name for assistive tech: the host's, else the editor's or the run graph's. */
function canvasName(t: TFunction<'agents'>, mode: FlowMode, label: string | undefined): string {
  if (label !== undefined) return label
  return mode === 'build' ? t('editor.canvasLabel') : t('run.graphLabel')
}

/** "Drop to add Fixer": what a palette item over the canvas will add. */
function DropStatus() {
  const { t } = useTranslation('agents')
  const name = dragTitle()
  return (
    <p role="status" className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-bg-elevated px-2 py-1 text-[12px] text-text shadow-sm">
      {name === '' ? t('canvas.dropAny') : t('canvas.drop', { name })}
    </p>
  )
}

/**
 * React Flow's nodes, re-derived from the definition whenever it changes (measurements and selection kept), with a
 * selection made outside the canvas applied, and the arrows' selection (they are derived, so it is held here).
 */
function useCanvasNodes(t: TFunction<'agents'>, inputs: Parameters<typeof buildNodes>[1], selection: CanvasSelection | undefined) {
  const building = inputs.mode === 'build'
  const { definition, issuesByNode, runStates, mode, descPrefix, keyboardDescription, calls, lanes, sizes } = inputs
  const derived = useMemo(() => buildNodes(t, { definition, issuesByNode, runStates, mode, descPrefix, keyboardDescription, calls, lanes, sizes }),
    [t, definition, issuesByNode, runStates, mode, descPrefix, keyboardDescription, calls, lanes, sizes])
  const [nodes, setNodes] = useState<FlowNode[]>(derived)
  const [synced, setSynced] = useState(derived)
  if (synced !== derived) {
    // Re-derive during render (not in an effect) so a definition change paints once.
    setSynced(derived)
    setNodes((previous) => carryOver(previous, derived))
  }
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(NO_EDGES)
  const [appliedSelection, setAppliedSelection] = useState(selection)
  if (selection !== appliedSelection) {
    // After the re-derivation above, so a step added and selected in one edit ends up selected.
    setAppliedSelection(selection)
    if (selection !== undefined) {
      setNodes((current) => withSelectedNodes(current, selection))
      setSelectedEdges((current) => (building ? new Set(selection.edgeIds) : current))
    }
  }
  return { nodes, setNodes, selectedEdges, setSelectedEdges }
}

/** The minimap's fill of a node: a step by its kind (build, view) or state (run), a run's lane by its state. */
function useMinimapClass(definition: WorkflowDefinition, runStates: ReadonlyMap<string, StepState> | undefined) {
  return useCallback((node: FlowNode) => {
    if (node.type === 'lane') return laneMinimapClass(node.data.state, node.data.open)
    if (!isStepId(node.id)) return ''
    const step = definition.nodes.find((each) => each.id === node.id)
    return step === undefined ? '' : minimapClass(kindOf(step), runStates?.get(step.id), node.selected === true)
  }, [definition.nodes, runStates])
}

/** (7.54.00, run) A run's minimap is small, so it never covers the steps of a pane; a narrow canvas hides it (CSS). */
const RUN_MINIMAP_STYLE = { width: 132, height: 88 } as const

function CanvasInner({
  definition, mode, runState, onSelect, selection, onSelectionChange, onChange, issuesByNode, label, onMeasured,
}: Readonly<FlowCanvasProps>) {
  const { t } = useTranslation('agents')
  const { screenToFlowPosition } = useReactFlow()
  const building = mode === 'build'
  const runStates = runState?.steps
  const rfId = `flow${useId().replace(/[^A-Za-z0-9]/g, '')}`
  const lookups = useLookups(definition, mode, rfId)
  // The run graph follows the active step; the editor opens on its start (floored fit, canvasFocus.ts).
  const [startId] = useState(() => startStepId(definition))
  useFocusStep(definition, focusOf(runStates, startId))
  // (7.54.00) A run's steps as React Flow measured them: its frames hold the cards as drawn, and the host lays out by them.
  const [sizes, setSizes] = useState<MeasuredSizes>(NO_SIZES)
  const { nodes, setNodes, selectedEdges, setSelectedEdges } = useCanvasNodes(t, {
    definition, issuesByNode, runStates, mode, descPrefix: rfId, keyboardDescription: `react-flow__node-desc-${rfId}`,
    calls: runState?.calls ?? NO_CALLS, lanes: runState?.lanes ?? NO_LANES, sizes,
  }, selection)
  const edges = useMemo(() => buildEdges(t, { definition, runStates, building, selected: selectedEdges }),
    [t, definition, runStates, building, selectedEdges])
  const [dropping, setDropping] = useState(false)
  const aria = useMemo(() => ariaWords(t), [t])
  // Whether the selection under way comes from the keyboard (Enter or Space on a node) or a pointer.
  const keyboard = useRef(false)

  const emit = useCallback((next: WorkflowDefinition) => {
    if (building && onChange !== undefined && next !== definition) onChange(next)
  }, [building, definition, onChange])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
    if (mode === 'run') {
      const measured = changes.flatMap((change) => (change.type === 'dimensions' && change.dimensions !== undefined && isStepId(change.id)
        ? [[change.id, change.dimensions] as const] : []))
      if (measured.length > 0) setSizes((before) => withMeasured(before, measured))
    }
    if (!building) return
    const steps = new Map(definition.nodes.map((node) => [node.id, node]))
    const moves = new Map<string, { x: number; y: number }>()
    const removed = new Set<string>()
    for (const change of changes) {
      const step = 'id' in change ? steps.get(change.id) : undefined
      if (step === undefined) continue
      if (change.type === 'position' && change.dragging === false && change.position !== undefined) {
        moves.set(step.id, storedPosition(step, change.position))
      }
      if (change.type === 'remove') removed.add(step.id)
    }
    emit(removeNodes(moveNodes(definition, moves), removed))
  }, [building, definition, emit, mode, setNodes])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!building) return
    setSelectedEdges((previous) => applyEdgeSelection(previous, changes))
    emit(removeEdges(definition, new Set(changes.flatMap((c) => (c.type === 'remove' ? [c.id] : [])))))
  }, [building, definition, emit, setSelectedEdges])

  const onConnect = useCallback((connection: Connection) => {
    const source = definition.nodes.find((node) => node.id === connection.source)
    const verdict = source === undefined ? undefined : labelOfHandle(source.type, connection.sourceHandle)
    emit(connect(definition, connection.source, connection.target, verdict ?? 'auto'))
  }, [definition, emit])

  // React Flow sends the selection again whenever its onSelectionChange changes (its SelectionListener's effect). A
  // host's handlers made anew each render (a run's lane opens its session) would then re-apply the same selection on
  // every render, forever: React Flow is handed one stable handler that calls the host's latest ones.
  const handlers = useRef({ onSelect, onSelectionChange, onMeasured })
  useLayoutEffect(() => {
    handlers.current = { onSelect, onSelectionChange, onMeasured }
  })
  // (the host hears of a new measure once, after the render that took it)
  useEffect(() => {
    if (sizes !== NO_SIZES) handlers.current.onMeasured?.(sizes)
  }, [sizes])
  const handleSelection = useCallback(({ nodes: picked, edges: pickedEdges }: OnSelectionChangeParams) => {
    const ids = picked.map((n) => n.id)
    handlers.current.onSelectionChange?.({
      nodeIds: ids.filter(isStepId),
      edgeIds: pickedEdges.map((e) => e.id),
      loopIndexes: ids.flatMap((id) => {
        const index = loopIndexOfFrame(id)
        return index === null ? [] : [index]
      }),
    })
    handlers.current.onSelect?.(singleOf(picked, pickedEdges), { keyboard: keyboard.current })
    keyboard.current = false
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    setNodes((current) => current.map((node) => (node.selected === true ? { ...node, selected: false } : node)))
    setSelectedEdges(NO_EDGES)
    onSelect?.(null)
  }, [onSelect, setNodes, setSelectedEdges])

  const onDragOver = useCallback((event: DragEvent) => {
    if (!building || !carriesBlock(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropping(true)
  }, [building])

  const onDrop = useCallback((event: DragEvent) => {
    setDropping(false)
    if (!building) return
    const block = droppedBlock(event, (type) => t(`nodeTypes.${type}.label`))
    if (block === null) return
    event.preventDefault()
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    emit(addBlock(definition, block, storedPosition({ type: block.type, data: { title: block.title, params: { ...block.params } } }, at)).definition)
  }, [building, definition, emit, screenToFlowPosition, t])

  const minimapNode = useMinimapClass(definition, runStates)

  return (
    <FlowLookupsContext.Provider value={lookups}>
      <div className="voc-workflow relative h-full w-full" data-mode={mode} data-dropping={dropping}
        onDragOver={onDragOver} onDragLeave={() => setDropping(false)} onDrop={onDrop} onKeyDown={onKeyDown}
        onKeyDownCapture={(event) => { keyboard.current = event.key === 'Enter' || event.key === ' ' }}
        onPointerDownCapture={() => { keyboard.current = false }}>
        <ReactFlow<FlowNode>
          id={rfId}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={handleSelection}
          onNodeClick={(_event, node) => { if (!building) onSelect?.(singleOf([node], []), { keyboard: false }) }}
          {...interactionOf(building)}
          // A selected frame must stay BEHIND its steps (elevation would cover them).
          elevateNodesOnSelect={false}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={aria}
          aria-label={canvasName(t, mode, label)}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable ariaLabel={t('editor.minimap')} nodeClassName={minimapNode}
            style={mode === 'run' ? RUN_MINIMAP_STYLE : undefined} />
        </ReactFlow>
        {dropping && <DropStatus />}
      </div>
    </FlowLookupsContext.Provider>
  )
}

/** Self-contained: each canvas owns its React Flow store. */
export function FlowCanvas(props: Readonly<FlowCanvasProps>) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
