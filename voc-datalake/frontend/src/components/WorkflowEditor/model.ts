/**
 * @fileoverview Pure editing operations on a workflow definition: the node
 * catalogue (palette groups, default role and params per type), id minting,
 * add / update / move / remove / connect, and loop groups (with their frame
 * geometry). No React, no React Flow types —
 * the canvas adapter maps to and from these, so every rule here is unit-testable.
 *
 * @module components/WorkflowEditor/model
 */
import type {
  WorkflowDefinition, WorkflowEdge, WorkflowEdgeLabel, WorkflowLoop, WorkflowNode, WorkflowNodeRole, WorkflowNodeType,
} from '../../api/workflowsApi'

export type PaletteGroup = 'flow' | 'research' | 'documents' | 'review' | 'prototype' | 'delivery'

interface NodeTypeSpec {
  group: PaletteGroup
  role?: WorkflowNodeRole
  params?: Record<string, unknown>
}

/** Every node type, in palette order. */
export const NODE_CATALOGUE: Readonly<Record<WorkflowNodeType, NodeTypeSpec>> = {
  start: { group: 'flow' },
  aggregate_reviews: { group: 'research', role: 'worker' },
  select_or_create_project: { group: 'research', role: 'orchestrator' },
  select_personas: { group: 'research', role: 'orchestrator' },
  generate_personas: { group: 'research', role: 'worker', params: { max_new: 3 } },
  deep_research: { group: 'research', role: 'worker', params: { use_web_search: true } },
  write_prfaq: { group: 'documents', role: 'worker' },
  write_prd: { group: 'documents', role: 'worker' },
  revise_document: { group: 'documents', role: 'worker', params: { target: 'prfaq' } },
  duplicate_document: { group: 'documents', role: 'orchestrator' },
  persona_review: { group: 'review', role: 'persona', params: { target: 'prfaq' } },
  final_review: { group: 'review', role: 'reviewer' },
  custom_llm: { group: 'review', role: 'worker' },
  build_prototype: { group: 'prototype', role: 'worker' },
  collect_prototype_feedback: { group: 'prototype', role: 'worker' },
  revise_prototype: { group: 'prototype', role: 'worker' },
  handoff: { group: 'delivery', role: 'orchestrator' },
  end: { group: 'flow', params: { status: 'completed' } },
}

/** dataTransfer type the palette writes and the canvas accepts. */
export const PALETTE_MIME = 'application/x-voc-workflow-node'

export const PALETTE_GROUPS: readonly PaletteGroup[] = ['flow', 'research', 'documents', 'review', 'prototype', 'delivery']

const isNodeType = (value: string): value is WorkflowNodeType => Object.hasOwn(NODE_CATALOGUE, value)

export function parseNodeType(value: string): WorkflowNodeType | null {
  return isNodeType(value) ? value : null
}

/**
 * Labels an arrow may carry when leaving a node of this type. A custom step
 * (`custom_llm`) reports no verdict, so — like every other non-review step — its
 * arrows carry none and always run (the server refuses pass/fail out of it).
 */
export function edgeLabelsFor(sourceType: WorkflowNodeType | undefined): readonly WorkflowEdgeLabel[] {
  if (sourceType === 'persona_review') return ['agreed', 'not_agreed']
  if (sourceType === 'final_review') return ['pass', 'fail']
  return []
}

/** A fresh id `<prefix>_<n>` not used by `taken` (ids match the server's `[A-Za-z0-9_-]{1,64}`). */
export function mintId(prefix: string, taken: ReadonlySet<string>): string {
  const base = prefix.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'n'
  // Among taken.size + 1 candidates at least one is free.
  const free = Array.from({ length: taken.size + 1 }, (_x, i) => `${base}_${i + 1}`).find((id) => !taken.has(id))
  return free ?? `${base}_${taken.size + 1}`
}

export function addNode(
  definition: WorkflowDefinition, type: WorkflowNodeType, position: { x: number; y: number }, title: string,
): { definition: WorkflowDefinition; nodeId: string } {
  const spec = NODE_CATALOGUE[type]
  const nodeId = mintId(type, new Set(definition.nodes.map((n) => n.id)))
  const node: WorkflowNode = {
    id: nodeId,
    type,
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    data: { title, ...(spec.role === undefined ? {} : { role: spec.role }), params: { ...spec.params } },
  }
  return { definition: { ...definition, nodes: [...definition.nodes, node] }, nodeId }
}

export function updateNode(
  definition: WorkflowDefinition, nodeId: string, patch: (node: WorkflowNode) => WorkflowNode,
): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.map((n) => (n.id === nodeId ? patch(n) : n)) }
}

export function moveNodes(definition: WorkflowDefinition, moves: ReadonlyMap<string, { x: number; y: number }>): WorkflowDefinition {
  if (moves.size === 0) return definition
  return {
    ...definition,
    nodes: definition.nodes.map((n) => {
      const to = moves.get(n.id)
      return to === undefined ? n : { ...n, position: { x: Math.round(to.x), y: Math.round(to.y) } }
    }),
  }
}

/** Remove nodes, their arrows, and their loop membership (a loop left empty goes too). */
export function removeNodes(definition: WorkflowDefinition, ids: ReadonlySet<string>): WorkflowDefinition {
  if (ids.size === 0) return definition
  return {
    ...definition,
    nodes: definition.nodes.filter((n) => !ids.has(n.id)),
    edges: definition.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
    loops: definition.loops
      .map((l) => ({ ...l, node_ids: l.node_ids.filter((id) => !ids.has(id)) }))
      .filter((l) => l.node_ids.length > 0),
  }
}

export function removeEdges(definition: WorkflowDefinition, ids: ReadonlySet<string>): WorkflowDefinition {
  if (ids.size === 0) return definition
  return { ...definition, edges: definition.edges.filter((e) => !ids.has(e.id)) }
}

/**
 * The condition a new arrow gets: `'auto'` pre-fills the first verdict label
 * not yet used by the source (a canvas drag), `null` is the default arrow (no
 * condition), a label is used as given (the side panel's "Add arrow").
 */
export type ArrowCondition = WorkflowEdgeLabel | null | 'auto'

/** May an arrow out of `sourceType` carry `condition`? (`'auto'` and none always may.) */
function conditionAllowed(condition: ArrowCondition, sourceType: WorkflowNodeType): boolean {
  return condition === null || condition === 'auto' || edgeLabelsFor(sourceType).includes(condition)
}

/** The label a new arrow gets for an allowed `condition` (undefined = the default arrow). */
function labelFor(condition: ArrowCondition, sourceType: WorkflowNodeType, existing: readonly WorkflowEdge[]): WorkflowEdgeLabel | undefined {
  if (condition === null) return undefined
  if (condition !== 'auto') return condition
  const used = new Set(existing.map((e) => e.label))
  return edgeLabelsFor(sourceType).find((l) => !used.has(l))
}

/**
 * Connect two steps. Refused (unchanged) for a self-arrow, a duplicate arrow,
 * an arrow out of an end or into the start, and a condition the source step
 * cannot report (see {@link edgeLabelsFor}).
 */
export function connect(
  definition: WorkflowDefinition, source: string, target: string, condition: ArrowCondition = 'auto',
): WorkflowDefinition {
  if (source === target) return definition
  const types = new Map(definition.nodes.map((n) => [n.id, n.type]))
  const sourceType = types.get(source)
  if (sourceType === undefined || !types.has(target) || sourceType === 'end' || types.get(target) === 'start') return definition
  const existing = definition.edges.filter((e) => e.source === source)
  if (existing.some((e) => e.target === target) || !conditionAllowed(condition, sourceType)) return definition
  const label = labelFor(condition, sourceType, existing)
  const id = mintId(`e_${source}__${target}`.slice(0, 40), new Set(definition.edges.map((e) => e.id)))
  const edge: WorkflowEdge = { id, source, target, ...(label === undefined ? {} : { label }) }
  return { ...definition, edges: [...definition.edges, edge] }
}

export function setEdgeLabel(definition: WorkflowDefinition, edgeId: string, label: WorkflowEdgeLabel | undefined): WorkflowDefinition {
  return {
    ...definition,
    edges: definition.edges.map((e) => {
      if (e.id !== edgeId) return e
      const plain: WorkflowEdge = { id: e.id, source: e.source, target: e.target }
      return label === undefined ? plain : { ...plain, label }
    }),
  }
}

/** Steps that may sit in a loop: any but start / end. */
const canLoop = (definition: WorkflowDefinition, nodeId: string): boolean =>
  definition.nodes.some((n) => n.id === nodeId && n.type !== 'start' && n.type !== 'end')

/** Default round budget of a new loop (the server allows 1–5). */
const DEFAULT_LOOP_ROUNDS = 3

/** Group steps into a new loop; steps already in another loop are moved out of it. */
export function createLoop(definition: WorkflowDefinition, nodeIds: readonly string[]): WorkflowDefinition {
  const ids = new Set(nodeIds.filter((id) => canLoop(definition, id)))
  if (ids.size === 0) return definition
  const hasReview = definition.nodes.some((n) => ids.has(n.id) && n.type === 'persona_review')
  const loop: WorkflowLoop = { node_ids: [...ids], until: hasReview ? 'persona_agreement' : 'review_pass', max_rounds: DEFAULT_LOOP_ROUNDS }
  const others = definition.loops
    .map((l) => ({ ...l, node_ids: l.node_ids.filter((id) => !ids.has(id)) }))
    .filter((l) => l.node_ids.length > 0)
  return { ...definition, loops: [...others, loop] }
}

/** Drop `nodeId` from every loop except `keep`; loops left empty go. */
function withoutMember(loops: readonly WorkflowLoop[], nodeId: string, keep: number): WorkflowLoop[] {
  return loops
    .map((l, i) => (i === keep ? l : { ...l, node_ids: l.node_ids.filter((id) => id !== nodeId) }))
    .filter((l) => l.node_ids.length > 0)
}

/**
 * Put one step into loop `index`, or into a new loop (`'new'`). A step belongs
 * to one loop at most, so it leaves its previous one (dropped when emptied).
 * Start / end steps and unknown ids are refused (unchanged).
 */
export function addToLoop(definition: WorkflowDefinition, nodeId: string, index: number | 'new'): WorkflowDefinition {
  if (!canLoop(definition, nodeId)) return definition
  if (index === 'new') return createLoop(definition, [nodeId])
  if (index < 0) return definition
  const loop = definition.loops.at(index)
  if (loop === undefined || loop.node_ids.includes(nodeId)) return definition
  const loops = definition.loops.map((l, i) => (i === index ? { ...l, node_ids: [...l.node_ids, nodeId] } : l))
  return { ...definition, loops: withoutMember(loops, nodeId, index) }
}

/** Take one step out of its loop (the loop goes when it is left empty). */
export function removeFromLoop(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  if (loopIndexOf(definition, nodeId) < 0) return definition
  return { ...definition, loops: withoutMember(definition.loops, nodeId, -1) }
}

/** An empty canvas (name and description kept): the start of a workflow built by hand. */
export function clearDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return { ...definition, nodes: [], edges: [], loops: [] }
}

export function updateLoop(definition: WorkflowDefinition, index: number, patch: Partial<WorkflowLoop>): WorkflowDefinition {
  return { ...definition, loops: definition.loops.map((l, i) => (i === index ? { ...l, ...patch } : l)) }
}

export function removeLoop(definition: WorkflowDefinition, index: number): WorkflowDefinition {
  return { ...definition, loops: definition.loops.filter((_l, i) => i !== index) }
}

export function loopIndexOf(definition: WorkflowDefinition, nodeId: string): number {
  return definition.loops.findIndex((l) => l.node_ids.includes(nodeId))
}

const GROUP_PADDING = 28
/** Approximate rendered step size, for loop frames (matches StepNode's fixed width). */
export const STEP_WIDTH = 220
export const STEP_HEIGHT = 72

/** The frame drawn behind a loop's steps. */
export function loopBounds(definition: WorkflowDefinition, loop: WorkflowLoop): { x: number; y: number; width: number; height: number } | null {
  const members = definition.nodes.filter((n) => loop.node_ids.includes(n.id))
  if (members.length === 0) return null
  const xs = members.map((n) => n.position.x)
  const ys = members.map((n) => n.position.y)
  const x = Math.min(...xs) - GROUP_PADDING
  const y = Math.min(...ys) - GROUP_PADDING - 16
  return {
    x, y,
    width: Math.max(...xs) + STEP_WIDTH + GROUP_PADDING - x,
    height: Math.max(...ys) + STEP_HEIGHT + GROUP_PADDING - y,
  }
}
