/**
 * @fileoverview The glyph on each node's tile (7.52.00 C2; docs/ux part 5 §5.3), by NAME: an engineering agent's ROLE
 * glyph (the fixer's wrench, the hunter's crosshair…), a gate's shield (and its verdict's in a run), a call's
 * workflow, a decision's hand, the trigger's play, an end's flag; an agents workflow's steps keep their type's icon
 * (inside the same `aim` tile). The palette, the canvas, the drag preview, a lane and the inspector's header all
 * draw it through `GlyphIcon` (a name looked up in one static table, so no component is made while rendering).
 *
 * @module components/WorkflowEditor/nodes/nodeGlyphs
 */
import {
  BookOpen, Brain, CirclePlay, Combine, Crosshair, Database, Flag, Gavel, GitCommitHorizontal, GitPullRequest,
  GitPullRequestCreate, GraduationCap, Hammer, Hand, KanbanSquare, ListChecks, Map as MapGlyph, MessageSquareCode,
  MessagesSquare, Network, ScanEye, ShieldCheck, ShieldX, Split, Workflow, Wrench,
} from 'lucide-react'
import { TYPE_ICONS } from '../nodeTypeIcons'
import { kindOf } from './nodeKinds'
import type { LucideIcon } from 'lucide-react'
import type { WorkflowNode, WorkflowNodeType } from '../../../api/workflowsApi'

/** An engineering role's glyph (the agent card's avatar, its palette row, its lane's avatar). */
const ROLE_GLYPHS: Readonly<Record<string, LucideIcon>> = {
  mapper: MapGlyph,
  understander: BookOpen,
  hunter: Crosshair,
  fixer: Wrench,
  builder: Hammer,
  committer: GitCommitHorizontal,
  'commit-reviewer': ScanEye,
  'gate-runner': ListChecks,
  'pr-author': GitPullRequestCreate,
  'pr-reviewer': MessageSquareCode,
  'final-go': Gavel,
  coordinator: Network,
  coach: GraduationCap,
}

/** The engineering steps whose glyph is not their type's icon. */
const STEP_GLYPHS: Readonly<Partial<Record<WorkflowNodeType, LucideIcon>>> = {
  start: CirclePlay,
  quality_gate: ShieldCheck,
  persona_review: MessagesSquare,
  call_flow: Workflow,
  board: KanbanSquare,
  learning_loop: GraduationCap,
  self_improvement: Brain,
  map: Split,
  reduce: Combine,
  memory: Database,
  stop_at_pr: GitPullRequest,
  end: Flag,
}

/** Every glyph by name: `role:<role>`, `type:<type>`, `decision`, `verdict:pass`, `verdict:fail`. */
export const GLYPHS: Readonly<Record<string, LucideIcon>> = {
  ...Object.fromEntries(Object.entries(ROLE_GLYPHS).map(([role, icon]) => [`role:${role}`, icon])),
  ...Object.fromEntries(Object.entries(TYPE_ICONS).map(([type, icon]) => [`type:${type}`, STEP_GLYPHS[parseType(type)] ?? icon])),
  decision: Hand,
  'verdict:pass': ShieldCheck,
  'verdict:fail': ShieldX,
}

function parseType(type: string): WorkflowNodeType {
  return Object.keys(TYPE_ICONS).find((each): each is WorkflowNodeType => each === type) ?? 'agent'
}

/** The glyph a role's avatar shows (a card made from a skill is its base role's); the agent's for any other. */
export const roleGlyphName = (role: unknown): string =>
  (typeof role === 'string' && `role:${role}` in GLYPHS ? `role:${role}` : 'type:agent')

/** A node's tile glyph: a decision's hand, an agent's role, else its type's. */
export function glyphNameOf(node: Pick<WorkflowNode, 'type' | 'data'>): string {
  if (kindOf(node) === 'decision') return 'decision'
  return node.type === 'agent' ? roleGlyphName(node.data.params?.role) : `type:${node.type}`
}
