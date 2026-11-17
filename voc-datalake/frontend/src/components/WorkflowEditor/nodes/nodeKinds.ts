/**
 * @fileoverview The flow canvas's node language (7.52.00 C2; docs/ux part 5 §5.3), pure: every node type's KIND (its
 * shape), its size inside the 220 px column, who acts on it (the tile's tone), its verdict handles, the minimap's fill
 * and the flow order the keyboard follows. No React, no React Flow: the renderers (`nodes/*Node.tsx`), the canvas
 * (`FlowCanvas.tsx`), the palette and the inspector all read it, so a kind looks and behaves the same everywhere.
 *
 * - **Kind is shape plus icon**, never colour alone: trigger, end and decision are pills (a decision with a diamond),
 *   an agent and a team a rounded card, a gate an elongated hexagon, a call a stacked card, a platform step a
 *   square-cornered card.
 * - **Tone says who acts**, on the icon tile only: `aim` where a model does the step, `warn` where a person must,
 *   neutral where the platform does (a gate's tile is the strong neutral). It never changes with a run's state.
 *
 * @module components/WorkflowEditor/nodes/nodeKinds
 */
import type { WorkflowDefinition, WorkflowEdgeLabel, WorkflowNode, WorkflowNodeType } from '../../../api/workflowsApi'
import type { StepState } from '../runState'

export type NodeKind = 'trigger' | 'agent' | 'team' | 'gate' | 'call' | 'decision' | 'end' | 'platform'

/** Every kind, in the order the palette and the docs list them. */
export const NODE_KINDS: readonly NodeKind[] = ['trigger', 'agent', 'team', 'gate', 'call', 'decision', 'end', 'platform']

/** Each node type's kind (a decision is an `end` that needs a person: {@link kindOf}). */
export const KIND_OF_TYPE: Readonly<Record<WorkflowNodeType, NodeKind>> = {
  start: 'trigger',
  aggregate_reviews: 'agent',
  select_or_create_project: 'agent',
  select_personas: 'agent',
  generate_personas: 'agent',
  deep_research: 'agent',
  write_prfaq: 'agent',
  write_prd: 'agent',
  revise_document: 'agent',
  duplicate_document: 'agent',
  build_prototype: 'agent',
  collect_prototype_feedback: 'agent',
  revise_prototype: 'agent',
  handoff: 'agent',
  custom_llm: 'agent',
  // (a node whose arrows carry a verdict is a gate)
  persona_review: 'gate',
  final_review: 'gate',
  quality_gate: 'gate',
  agent: 'agent',
  // (Learn and the coach: a model runs them)
  learning_loop: 'agent',
  self_improvement: 'agent',
  board: 'team',
  call_flow: 'call',
  map: 'platform',
  reduce: 'platform',
  memory: 'platform',
  stop_at_pr: 'end',
  end: 'end',
}

/** `end` with `status: needs_human`: a person decides (where every NO-GO goes). */
export const isDecision = (node: Pick<WorkflowNode, 'type' | 'data'>): boolean =>
  node.type === 'end' && node.data.params?.status === 'needs_human'

export function kindOf(node: Pick<WorkflowNode, 'type' | 'data'>): NodeKind {
  return isDecision(node) ? 'decision' : KIND_OF_TYPE[node.type]
}

/** Every node keeps a 220 px column, so stored positions and arrows never move; a narrower shape is centred in it. */
export const NODE_COLUMN = 220

export interface NodeSize { readonly width: number; readonly height: number }

const SIZES: Readonly<Record<NodeKind, NodeSize>> = {
  trigger: { width: 180, height: 44 },
  agent: { width: 220, height: 88 },
  team: { width: 220, height: 88 },
  gate: { width: 220, height: 76 },
  call: { width: 220, height: 88 },
  decision: { width: 200, height: 52 },
  end: { width: 180, height: 44 },
  platform: { width: 200, height: 56 },
}

/** A kind's drawn size (its least height: a step with an issue line grows). */
export const kindSize = (kind: NodeKind): NodeSize => SIZES[kind]

/** A node's drawn size. */
export const nodeSize = (node: Pick<WorkflowNode, 'type' | 'data'>): NodeSize => SIZES[kindOf(node)]

/** How far a kind's shape sits from its column's left edge (centred in it). */
export const columnOffset = (kind: NodeKind): number => (NODE_COLUMN - SIZES[kind].width) / 2

/** Where a step's shape is drawn: its stored position (the column's corner) moved to centre the shape. */
export function drawnPosition(node: Pick<WorkflowNode, 'type' | 'data' | 'position'>): { x: number; y: number } {
  return { x: node.position.x + columnOffset(kindOf(node)), y: node.position.y }
}

/** The stored position of a shape drawn at `drawn` (the inverse of {@link drawnPosition}, for a drag's end). */
export function storedPosition(node: Pick<WorkflowNode, 'type' | 'data'>, drawn: { x: number; y: number }): { x: number; y: number } {
  return { x: drawn.x - columnOffset(kindOf(node)), y: drawn.y }
}

/** Who acts on a step, which tones its tile: a model (`aim`), a person (`warn`), the platform (neutral; a gate strong). */
export type TileTone = 'aim' | 'warn' | 'strong' | 'neutral'

const TILE_TONES: Readonly<Record<NodeKind, TileTone>> = {
  trigger: 'neutral', agent: 'aim', team: 'aim', gate: 'strong', call: 'neutral', decision: 'warn', end: 'neutral',
  platform: 'neutral',
}

export const tileTone = (kind: NodeKind): TileTone => TILE_TONES[kind]

/** Each tone's tile classes (semantic tokens only). */
export const TILE_CLASS: Readonly<Record<TileTone, string>> = {
  aim: 'bg-aim-subtle text-aim',
  warn: 'bg-warn-subtle text-warn',
  strong: 'bg-bg-hover text-text-strong',
  neutral: 'bg-bg-hover text-muted',
}

/** A verdict handle of a gate: its edge label and the text under it (`canvas.handles.<word>`). */
export interface VerdictHandle {
  readonly label: WorkflowEdgeLabel
  readonly word: 'go' | 'noGo' | 'agreed' | 'notAgreed'
  readonly side: 'left' | 'right'
}

const GATE_HANDLES: readonly VerdictHandle[] = [
  { label: 'pass', word: 'go', side: 'left' }, { label: 'fail', word: 'noGo', side: 'right' },
]
const PERSONA_HANDLES: readonly VerdictHandle[] = [
  { label: 'agreed', word: 'agreed', side: 'left' }, { label: 'not_agreed', word: 'notAgreed', side: 'right' },
]

/**
 * The source handles of a step that reports a verdict (owner decision N-D4): GO and NO-GO (pass and fail) on a gate,
 * Agreed and Not agreed on a persona review; none for any other step (one plain source handle). Dragging from one
 * makes that arrow, so the verdict is set by where you drag; the server's shape is the edge's `label`, unchanged.
 */
export function verdictHandles(type: WorkflowNodeType): readonly VerdictHandle[] {
  if (type === 'persona_review') return PERSONA_HANDLES
  return type === 'quality_gate' || type === 'final_review' ? GATE_HANDLES : []
}

/** The edge label a connection from `handle` (a source handle's id) carries; undefined for the plain handle. */
export function labelOfHandle(type: WorkflowNodeType, handle: string | null | undefined): WorkflowEdgeLabel | undefined {
  return verdictHandles(type).find((each) => each.label === handle)?.label
}

/** The run states whose outline is the state's (so a selected node shows its selection by the fill alone). */
export const HELD_STATES: ReadonlySet<StepState['status']> = new Set(['running', 'waiting', 'paused', 'failed'])

/** A step with an inward arrow (not a trigger) and an outward one (not an end or a decision). */
export const hasTarget = (kind: NodeKind): boolean => kind !== 'trigger'
export const hasSource = (kind: NodeKind): boolean => kind !== 'end' && kind !== 'decision'

/** What the minimap reads of a run step (its state), for the run's fills. */
type MinimapState = 'running' | 'done' | 'failed' | 'waiting' | 'quiet'

const MINIMAP_STATE: Readonly<Record<StepState['status'], MinimapState>> = {
  running: 'running', done: 'done', failed: 'failed', waiting: 'waiting', paused: 'waiting',
  idle: 'quiet', skipped: 'quiet', stopped: 'quiet',
}

/**
 * The minimap's class of a node (`workflowCanvas.css` `.voc-mini-*`): by kind while building or viewing (agents and
 * teams in `aim`, gates strong, decisions `warn`, the rest muted), by state in a run; a selected node adds its
 * stroke. The minimap tells nothing the canvas does not, so its colour is never the only cue.
 */
export function minimapClass(kind: NodeKind, run: StepState | undefined, selected: boolean): string {
  const fill = run === undefined ? `voc-mini-${kind}` : `voc-mini-${MINIMAP_STATE[run.status]}`
  return selected ? `${fill} voc-mini-selected` : fill
}

/**
 * The steps in flow order (owner N14: Tab follows the flow, not creation): by their distance from the start along the
 * arrows (breadth first), then by their place on the canvas (top, then left); a step the start never reaches comes
 * after the rest.
 */
export function flowOrder(definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>): WorkflowNode[] {
  const start = definition.nodes.find((node) => node.type === 'start') ?? definition.nodes[0]
  const levels = new Map<string, number>(start === undefined ? [] : [[start.id, 0]])
  const queue = start === undefined ? [] : [start.id]
  for (const id of queue) {
    for (const edge of definition.edges) {
      if (edge.source !== id || levels.has(edge.target)) continue
      levels.set(edge.target, (levels.get(id) ?? 0) + 1)
      queue.push(edge.target)
    }
  }
  const past = definition.nodes.length + 1
  const level = (node: WorkflowNode) => levels.get(node.id) ?? past
  return [...definition.nodes].sort((a, b) => level(a) - level(b) || a.position.y - b.position.y || a.position.x - b.position.x)
}
