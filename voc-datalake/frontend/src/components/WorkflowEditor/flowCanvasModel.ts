/**
 * @fileoverview What the flow canvas hands React Flow (7.52.00 C2), derived from a definition: its steps by KIND in
 * flow order (the keyboard's Tab follows the flow, N14), each drawn centred in its 220 px column with its accessible
 * name ("Gate: Quality gate, failed") and its description; the loop frames and a run's call frames behind them; a
 * run's lanes after them; its arrows, each from its verdict's handle, toned and lit; and the canvas's own aria words
 * (`ariaLabelConfig`, in the person's language). Pure given `t`, so the canvas only keeps React Flow's state.
 *
 * @module components/WorkflowEditor/flowCanvasModel
 */
import { MarkerType } from '@xyflow/react'
import { GROUP_PADDING, frameAround, loopBounds } from './model'
import { drawnPosition, flowOrder, kindOf, verdictHandles } from './nodes/nodeKinds'
import { nodeDescriptionId } from './nodes/nodeData'
import type { AriaLabelConfig, Edge } from '@xyflow/react'
import type { TFunction } from 'i18next'
import type { WorkflowDefinition, WorkflowEdge, WorkflowLoop, WorkflowNode } from '../../api/workflowsApi'
import type { CallFrameFlowNode, FlowMode, LaneFlowNode, LoopFrameFlowNode, StepFlowNode } from './nodes/nodeData'
import type { StepState } from './runState'
import type { CanvasSelection } from './selection'


export type FlowNode = StepFlowNode | LoopFrameFlowNode | CallFrameFlowNode | LaneFlowNode

/** (7.54.00) The steps' drawn sizes as React Flow measured them, by step id (a run's cards grow with their chips). */
export type MeasuredSizes = ReadonlyMap<string, { readonly width: number; readonly height: number }>

export const NO_SIZES: MeasuredSizes = new Map()

/** `before` with the `measured` sizes, or `before` itself when none changed by a pixel (no re-render, no re-layout). */
export function withMeasured(before: MeasuredSizes,
  measured: readonly (readonly [string, { readonly width: number; readonly height: number }])[]): MeasuredSizes {
  const changed = measured.filter(([id, size]) => {
    const known = before.get(id)
    return known === undefined || Math.abs(known.width - size.width) >= 1 || Math.abs(known.height - size.height) >= 1
  })
  if (changed.length === 0) return before
  const next = new Map(before)
  for (const [id, size] of changed) next.set(id, { width: Math.round(size.width), height: Math.round(size.height) })
  return next
}

/** A call of a run's flat copy: the call step, what its frame reads, and its `<call>.<child>` steps. */
export interface CallFrameSpec {
  readonly call: string
  readonly label: string
  readonly progress: string
  readonly nodeIds: readonly string[]
}

/** A frame's box. */
interface FrameBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * (7.54.00) A frame around some steps (`box`, `frameAround`'s) grown to hold their run lanes (beside the steps,
 * runLanes.ts) and their cards as tall as they were measured; with no lanes and no sizes (building, viewing), `box`.
 */
function holding(box: FrameBox, members: readonly WorkflowNode[], lanes: readonly LaneFlowNode[], sizes: MeasuredSizes): FrameBox {
  const ids = new Set(members.map((node) => node.id))
  const beside = lanes.filter((lane) => ids.has(lane.data.step))
  const right = Math.max(box.x + box.width, ...beside.map((lane) => lane.position.x + lane.data.width + GROUP_PADDING))
  const bottom = Math.max(box.y + box.height,
    ...members.map((node) => node.position.y + (sizes.get(node.id)?.height ?? 0) + GROUP_PADDING),
    ...beside.map((lane) => lane.position.y + lane.data.height + GROUP_PADDING))
  return { x: box.x, y: box.y, width: right - box.x, height: bottom - box.y }
}

const LOOP_PREFIX = 'loop:'
const CALL_PREFIX = 'call:'
const LANE_PREFIX = 'lane:'
const NO_ISSUES: readonly string[] = []

export const loopIndexOfFrame = (id: string): number | null => {
  if (!id.startsWith(LOOP_PREFIX)) return null
  const index = Number(id.slice(LOOP_PREFIX.length))
  return Number.isInteger(index) ? index : null
}

/** A step's id on the canvas, or null for a frame or a lane. */
export const isStepId = (id: string): boolean => !id.startsWith(LOOP_PREFIX) && !id.startsWith(CALL_PREFIX) && !id.startsWith(LANE_PREFIX)
export const isLaneId = (id: string): boolean => id.startsWith(LANE_PREFIX)

/** "<kind>: <title>, <state>" — the role, the chips and the reason are the node's description. */
function stepLabel(t: TFunction<'agents'>, step: WorkflowNode, run: StepState | undefined): string {
  const parts = [step.data.title]
  if (run !== undefined) parts.push(t(`run.stepStatus.${run.status}`).toLowerCase())
  if (run?.gate === 'pass') parts.push(t('canvas.gate.go'))
  if (run?.gate === 'fail') parts.push(t('canvas.gate.noGo'))
  return t('canvas.nodeName', { kind: t(`canvas.kinds.${kindOf(step)}`), rest: parts.join(', ') })
}

interface StepInputs {
  readonly definition: WorkflowDefinition
  readonly issuesByNode: ReadonlyMap<string, readonly string[]> | undefined
  readonly runStates: ReadonlyMap<string, StepState> | undefined
  readonly mode: FlowMode
  /** The canvas's id (the descriptions' prefix) and React Flow's own keyboard description. */
  readonly descPrefix: string
  readonly keyboardDescription: string
}

function stepNodes(t: TFunction<'agents'>, inputs: StepInputs): StepFlowNode[] {
  const building = inputs.mode === 'build'
  return flowOrder(inputs.definition).map((step) => {
    const kind = kindOf(step)
    const run = inputs.runStates?.get(step.id)
    return {
      id: step.id,
      type: kind,
      position: drawnPosition(step),
      className: `voc-kind-${kind}`,
      data: { step, kind, issues: inputs.issuesByNode?.get(step.id) ?? NO_ISSUES, run },
      ariaLabel: stepLabel(t, step, run),
      domAttributes: { 'aria-describedby': `${nodeDescriptionId(inputs.descPrefix, step.id)} ${inputs.keyboardDescription}` },
      draggable: building,
      connectable: building,
      deletable: building,
    }
  })
}

function loopFrames(t: TFunction<'agents'>, definition: WorkflowDefinition, lanes: readonly LaneFlowNode[],
  sizes: MeasuredSizes): LoopFrameFlowNode[] {
  const label = (loop: WorkflowLoop, index: number) => t('editor.loopFrameLabel', {
    n: index + 1, until: t(`loopUntil.${loop.until}`), rounds: loop.max_rounds,
  })
  return definition.loops.flatMap((loop, index) => {
    const bounds = loopBounds(definition, loop)
    if (bounds === null) return []
    const box = holding(bounds, definition.nodes.filter((node) => loop.node_ids.includes(node.id)), lanes, sizes)
    // Selectable and focusable: clicking a loop's frame (or Tab + Enter) opens its settings.
    return [{
      id: `${LOOP_PREFIX}${index}`, type: 'loopFrame', position: { x: box.x, y: box.y },
      data: { loop, index, width: box.width, height: box.height }, ariaLabel: label(loop, index),
      draggable: false, selectable: true, connectable: false, deletable: false, focusable: true, zIndex: -1,
    }]
  })
}

function callFrames(definition: WorkflowDefinition, calls: readonly CallFrameSpec[], lanes: readonly LaneFlowNode[],
  sizes: MeasuredSizes): CallFrameFlowNode[] {
  return calls.flatMap((call) => {
    const members = definition.nodes.filter((node) => call.nodeIds.includes(node.id))
    if (members.length === 0) return []
    const box = holding(frameAround(members), members, lanes, sizes)
    return [{
      id: `${CALL_PREFIX}${call.call}`, type: 'callFrame', position: { x: box.x, y: box.y },
      data: { call: call.call, label: call.label, progress: call.progress, width: box.width, height: box.height },
      ariaLabel: `${call.label}, ${call.progress}`,
      draggable: false, selectable: false, connectable: false, deletable: false, focusable: false, zIndex: -1,
    }]
  })
}

/** Every node the canvas draws: the frames behind (around their steps and, in a run, their lanes and their measured
 * cards), the steps in flow order, then a run's lanes. */
export function buildNodes(t: TFunction<'agents'>, inputs: StepInputs & {
  readonly calls: readonly CallFrameSpec[]; readonly lanes: readonly LaneFlowNode[]; readonly sizes?: MeasuredSizes
}): FlowNode[] {
  const { definition, lanes } = inputs
  const sizes = inputs.sizes ?? NO_SIZES
  return [...loopFrames(t, definition, lanes, sizes), ...callFrames(definition, inputs.calls, lanes, sizes), ...stepNodes(t, inputs), ...lanes]
}

/** Keep React Flow's measurements, selection and in-flight drag positions across re-derivations. */
export function carryOver(previous: readonly FlowNode[], next: FlowNode[]): FlowNode[] {
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
export function withSelectedNodes(nodes: FlowNode[], selection: CanvasSelection): FlowNode[] {
  const wanted = new Set([...selection.nodeIds, ...selection.loopIndexes.map((i) => `${LOOP_PREFIX}${i}`)])
  const next = nodes.map((node) => {
    const selected = wanted.has(node.id)
    return (node.selected === true) === selected ? node : { ...node, selected }
  })
  return next.every((node, i) => node === nodes[i]) ? nodes : next
}

/** "Arrow from <title> to <title>[, <condition>]" — React Flow's default names the raw ids. */
function arrowLabel(definition: WorkflowDefinition, edge: WorkflowEdge, t: TFunction<'agents'>): string {
  const title = (id: string) => definition.nodes.find((n) => n.id === id)?.data.title ?? id
  const condition = edge.label === undefined ? t('editor.fields.labelNone') : t(`edgeLabels.${edge.label}`)
  return t('editor.arrowLabel', { source: title(edge.source), target: title(edge.target), condition })
}

/** A verdict arrow's tone by meaning: agreed / pass ok, not agreed / fail warn. */
const VERDICT_TONES: Readonly<Partial<Record<string, string>>> = {
  agreed: 'voc-edge-ok', pass: 'voc-edge-ok', not_agreed: 'voc-edge-warn', fail: 'voc-edge-warn',
}

/** In a run: an arrow into a way not taken is dashed; one from a step done into a step reached is lit. */
function runEdgeClass(edge: WorkflowEdge, runStates: ReadonlyMap<string, StepState> | undefined): string | undefined {
  const target = runStates?.get(edge.target)
  if (target === undefined) return undefined
  if (target.status === 'skipped') return 'voc-edge-skipped'
  return runStates?.get(edge.source)?.status === 'done' && target.status !== 'idle' ? 'voc-edge-lit' : undefined
}

/** An arrow's classes: its verdict's tone, and its run's light. */
function edgeClass(edge: WorkflowEdge, runStates: ReadonlyMap<string, StepState> | undefined): string | undefined {
  const classes = [edge.label === undefined ? undefined : VERDICT_TONES[edge.label], runEdgeClass(edge, runStates)]
    .filter((each): each is string => each !== undefined)
  return classes.length === 0 ? undefined : classes.join(' ')
}

/** The handle an arrow leaves from: a verdict's own on a step that reports one (GO, NO-GO…), else the plain one. */
function sourceHandleOf(definition: WorkflowDefinition, edge: WorkflowEdge): string | undefined {
  const type = definition.nodes.find((node) => node.id === edge.source)?.type
  if (type === undefined || edge.label === undefined) return undefined
  return verdictHandles(type).some((handle) => handle.label === edge.label) ? edge.label : undefined
}

export function buildEdges(t: TFunction<'agents'>, inputs: {
  readonly definition: WorkflowDefinition; readonly runStates: ReadonlyMap<string, StepState> | undefined
  readonly building: boolean; readonly selected: ReadonlySet<string>
}): Edge[] {
  const { definition, runStates, building, selected } = inputs
  return definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: sourceHandleOf(definition, edge),
    label: edge.label === undefined ? undefined : t(`edgeLabels.${edge.label}`),
    ariaLabel: arrowLabel(definition, edge, t),
    className: edgeClass(edge, runStates),
    markerEnd: { type: MarkerType.ArrowClosed },
    deletable: building,
    focusable: building,
    selected: building && selected.has(edge.id),
  }))
}

/** React Flow's own words (its keyboard help, controls, minimap and handles), in the person's language. */
export function ariaWords(t: TFunction<'agents'>): Partial<AriaLabelConfig> {
  return {
    'node.a11yDescription.default': t('canvas.aria.node'),
    'node.a11yDescription.keyboardDisabled': t('canvas.aria.nodeKeyboard'),
    'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => t('canvas.aria.moved', { direction, x, y }),
    'edge.a11yDescription.default': t('canvas.aria.edge'),
    'controls.ariaLabel': t('canvas.aria.controls'),
    'controls.zoomIn.ariaLabel': t('canvas.aria.zoomIn'),
    'controls.zoomOut.ariaLabel': t('canvas.aria.zoomOut'),
    'controls.fitView.ariaLabel': t('canvas.aria.fitView'),
    'controls.interactive.ariaLabel': t('canvas.aria.interactive'),
    'minimap.ariaLabel': t('editor.minimap'),
    'handle.ariaLabel': t('canvas.aria.handle'),
  }
}
