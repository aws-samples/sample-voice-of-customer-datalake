/**
 * @fileoverview Client-side port of an engineering flow's rules (`voc-workflow/2`,
 * `lambda/shared/workflow_engineering.py`): each step's settings and the graph rules, with the server's
 * messages, so the editor pins them to steps as the user edits. The shared fixture
 * `src/test/engineeringFlows.json` holds the two to the same answers (a Python test and a vitest read it).
 *
 * @module components/WorkflowEditor/engineeringRules
 */
import { isRecord } from '../../lib/typeGuards'
import type { WorkflowDefinition, WorkflowEdge, WorkflowIssue, WorkflowNode } from '../../api/workflowsApi'

export const ENGINEERING_ROLES = [
  'mapper', 'understander', 'hunter', 'fixer', 'builder', 'committer', 'commit-reviewer', 'gate-runner',
  'pr-author', 'pr-reviewer', 'final-go', 'coordinator', 'coach',
] as const
export const BOARD_POSTERS = ['builder', 'coordinator', 'hunter'] as const
export const BOARD_CLAIMERS = [
  'builder', 'commit-reviewer', 'committer', 'final-go', 'fixer', 'hunter', 'mapper', 'pr-author', 'pr-reviewer',
  'understander',
] as const
export const GATE_PACKS = ['java', 'python-ts', 'rust-ts'] as const
export const SHARD_BY = ['packages', 'history', 'pr_pages'] as const
export const BOARD_UNTIL = ['drained', 'caps'] as const
export const MEMORY_MODES = ['read', 'write'] as const
export const MEMORY_SCOPES = ['repo', 'role', 'person'] as const
export const MAX_SHARD_CAP = 200
export const MAX_GATE_ROUNDS = 5
export const MAX_MEMORY_LIMIT = 50
const MAX_MODEL_CHARS = 128
const GATE_SETTINGS = new Set(['max_rounds', 'reviewers', 'packs', 'final_go_model'])
const REVIEWER_SETTINGS = new Set(['name', 'focus', 'model_id', 'advisory'])
/** The default reviewers, each with whether it is advisory. */
const DEFAULT_REVIEWERS: Readonly<Record<string, boolean>> = { security: false, quality: false, 'first-principles': true }
const PUSHING_ROLES = new Set(['committer', 'pr-author'])
const GATE_LABELS = ['pass', 'fail']
const WORK = new Set(['agent', 'map', 'board', 'quality_gate', 'learning_loop'])
const TERMINAL = new Set(['end', 'stop_at_pr'])
const SKILL_VERSION = /^(?:latest|v[1-9]\d{0,4})$/
const REVIEWER_NAME = /^[a-z][a-z0-9-]{0,39}$/

const GATE_NEEDS_BOTH_ARROWS = "a quality gate needs a 'pass' arrow (GO) and a 'fail' arrow (NO-GO), every arrow labelled"
const GATE_FAIL_TO_A_PERSON = "a quality gate's 'fail' arrow goes to a human decision point (an end step that needs a human)"
const ENDS_AT_A_STOP_AT_PR = 'a committer or PR author ends the flow at a stop at PR: every way its work can end is a '
  + 'stop at PR or a human decision point, and at least one is a stop at PR'

type Params = Readonly<Record<string, unknown>>

const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value)
/** A setting, or its default when left out (a null is given, as the server reads it: refused, never the default). */
const setting = (params: Params, key: string, fallback: unknown): unknown => (key in params ? params[key] : fallback)
const whole = (params: Params, key: string, low: number, high: number, fallback: number): boolean => {
  const value = setting(params, key, fallback)
  return isWhole(value) && value >= low && value <= high
}
const oneOf = (values: readonly string[], value: unknown): boolean => typeof value === 'string' && values.includes(value)
const roles = (value: unknown, allowed: readonly string[]): boolean =>
  Array.isArray(value) && value.length > 0 && value.every((role) => oneOf(allowed, role)) && new Set(value).size === value.length
/** Left out, or a model id (a key set to null is not left out). */
const model = (params: Params, key: string): boolean => {
  if (!(key in params)) return true
  const value = params[key]
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_MODEL_CHARS
}

function agentIssues(params: Params): string[] {
  const issues: string[] = []
  if (!oneOf(ENGINEERING_ROLES, params.role)) issues.push(`an agent needs params.role: one of ${ENGINEERING_ROLES.join(', ')}`)
  const version = setting(params, 'skill_version', 'latest')
  if (typeof version !== 'string' || !SKILL_VERSION.test(version)) {
    issues.push("an agent's params.skill_version is 'latest' or a version like 'v3'")
  }
  if (!model(params, 'model')) issues.push(`an agent's params.model is a model id of at most ${MAX_MODEL_CHARS} characters`)
  const share = params.budget_share
  // The server reads a null share as none set (its `share is not None`), unlike its other settings.
  if (share !== undefined && share !== null && (typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > 1)) {
    issues.push("an agent's params.budget_share is a fraction of the run's budget, above 0 and at most 1")
  }
  return issues
}

function reviewerOk(item: unknown): item is Record<string, unknown> & { name: string } {
  if (!isRecord(item) || typeof item.name !== 'string' || Object.keys(item).some((key) => !REVIEWER_SETTINGS.has(key))) return false
  const texts = ['focus', 'model_id'].filter((key) => key in item).map((key) => item[key])
  return REVIEWER_NAME.test(item.name) && texts.every((text) => typeof text === 'string' && text.trim() !== '')
    && typeof setting(item, 'advisory', false) === 'boolean' && (item.name in DEFAULT_REVIEWERS || 'focus' in item)
}

function reviewersIssue(reviewers: unknown): string | undefined {
  if (reviewers === undefined) return undefined
  if (!(Array.isArray(reviewers) && reviewers.length > 0 && reviewers.every(reviewerOk))) {
    return "a quality gate's params.reviewers is a list of reviewers: each a name (lowercase letters, digits "
      + `and dashes; ${Object.keys(DEFAULT_REVIEWERS).join(', ')} or a new one with a focus), and optionally a `
      + 'focus, a model_id and advisory (true or false)'
  }
  const names = reviewers.map((reviewer) => reviewer.name)
  const advisory = reviewers.map((reviewer) => reviewer.advisory ?? DEFAULT_REVIEWERS[reviewer.name] ?? false)
  return new Set(names).size !== names.length || advisory.every(Boolean)
    ? "a quality gate's reviewers have different names, and at least one can block (not advisory)"
    : undefined
}

function packsOk(params: Params): boolean {
  const packs = 'packs' in params ? params.packs : 'auto'
  return packs === 'auto' || (Array.isArray(packs) && packs.length > 0 && packs.every((p) => oneOf(GATE_PACKS, p))
    && new Set(packs).size === packs.length)
}

function gateIssues(params: Params): string[] {
  const settings = [...GATE_SETTINGS].sort((a, b) => a.localeCompare(b)).join(', ')
  return [
    Object.keys(params).some((key) => !GATE_SETTINGS.has(key)) ? `a quality gate's settings are ${settings}` : undefined,
    reviewersIssue(params.reviewers),
    whole(params, 'max_rounds', 1, MAX_GATE_ROUNDS, 3)
      ? undefined : `a quality gate's params.max_rounds is a whole number from 1 to ${MAX_GATE_ROUNDS}`,
    packsOk(params) ? undefined : `a quality gate's params.packs is 'auto' or a list of gate packs: ${GATE_PACKS.join(', ')}`,
    model(params, 'final_go_model')
      ? undefined : `a quality gate's params.final_go_model is a model id of at most ${MAX_MODEL_CHARS} characters`,
  ].filter((message): message is string => message !== undefined)
}

function boardIssues(params: Params): string[] {
  const issues = ([['posters', BOARD_POSTERS], ['claimers', BOARD_CLAIMERS]] as const)
    .filter(([key, allowed]) => !roles(params[key], allowed))
    .map(([key, allowed]) => `a board needs params.${key}: a list of roles, each once (${allowed.join(', ')})`)
  if (!oneOf(BOARD_UNTIL, setting(params, 'until', 'drained'))) issues.push(`a board's params.until is one of ${BOARD_UNTIL.join(', ')}`)
  return issues
}

function mapIssues(params: Params): string[] {
  const issues: string[] = []
  if (!oneOf(SHARD_BY, params.shard_by)) issues.push(`a map needs params.shard_by: one of ${SHARD_BY.join(', ')}`)
  if (!whole(params, 'shard_cap', 1, MAX_SHARD_CAP, MAX_SHARD_CAP)) {
    issues.push(`a map's params.shard_cap is a whole number from 1 to ${MAX_SHARD_CAP}`)
  }
  return issues
}

function memoryIssues(params: Params): string[] {
  const issues: string[] = []
  if (!oneOf(MEMORY_MODES, params.mode)) issues.push(`a memory step needs params.mode: one of ${MEMORY_MODES.join(', ')}`)
  if (!oneOf(MEMORY_SCOPES, params.scope)) issues.push(`a memory step needs params.scope: one of ${MEMORY_SCOPES.join(', ')}`)
  if (params.mode === 'read' && !whole(params, 'limit', 1, MAX_MEMORY_LIMIT, 10)) {
    issues.push(`a memory read's params.limit is a whole number from 1 to ${MAX_MEMORY_LIMIT}`)
  }
  return issues
}

const PARAMS: Readonly<Record<string, (params: Params) => string[]>> = {
  agent: agentIssues, quality_gate: gateIssues, board: boardIssues, map: mapIssues, memory: memoryIssues,
}

/** What is wrong with an engineering step's settings (empty when nothing is). */
export function engineeringParamsIssues(nodeType: string, params: Params): string[] {
  return PARAMS[nodeType]?.(params) ?? []
}

type Adjacency = ReadonlyMap<string, readonly string[]>
type Reach = (id: string) => ReadonlySet<string>

/** The reduces a map's shards meet first, and whether some way out reaches an end without one. */
function firstReduces(start: string, types: ReadonlyMap<string, string>, forward: Adjacency): [Set<string>, boolean] {
  const found = new Set<string>()
  const ends = new Set<string>()
  const seen = new Set<string>()
  const queue = [...(forward.get(start) ?? [])]
  // A for…of over the queue also visits what is pushed onto it while walking.
  for (const node of queue) {
    if (seen.has(node)) continue
    seen.add(node)
    const type = types.get(node) ?? ''
    if (type === 'reduce') found.add(node)
    else if (TERMINAL.has(type)) ends.add(node)
    else queue.push(...(forward.get(node) ?? []))
  }
  return [found, ends.size > 0]
}

function mapReduceIssues(types: ReadonlyMap<string, string>, forward: Adjacency): WorkflowIssue[] {
  const out: WorkflowIssue[] = []
  const met = new Set<string>()
  for (const [id, type] of types) {
    if (type !== 'map') continue
    const [reduces, escapes] = firstReduces(id, types, forward)
    for (const reduce of reduces) met.add(reduce)
    if (reduces.size !== 1 || escapes) {
      out.push({ message: 'a map needs exactly one reduce after it, on every way out, where its shards meet', node_id: id })
    }
  }
  for (const [id, type] of types) {
    if (type === 'reduce' && !met.has(id)) out.push({ message: 'a reduce needs a map before it', node_id: id })
  }
  return out
}

const needsHuman = (node: WorkflowNode | undefined): boolean =>
  node?.type === 'end' && node.data.params?.status === 'needs_human'

function gateArrowIssues(nodes: ReadonlyMap<string, WorkflowNode>, edges: readonly WorkflowEdge[]): WorkflowIssue[] {
  const out: WorkflowIssue[] = []
  for (const edge of edges) {
    if (edge.label !== undefined && nodes.get(edge.source)?.type !== 'quality_gate') {
      out.push({ message: "only a quality gate's arrows carry a label (pass or fail)", node_id: edge.source })
    }
  }
  for (const [id, node] of nodes) {
    if (node.type !== 'quality_gate') continue
    const outgoing = edges.filter((edge) => edge.source === id)
    const labels = new Set<string | undefined>(outgoing.map((edge) => edge.label))
    if (outgoing.length === 0 || [...labels].some((l) => !GATE_LABELS.includes(l ?? '')) || !GATE_LABELS.every((l) => labels.has(l))) {
      out.push({ message: GATE_NEEDS_BOTH_ARROWS, node_id: id })
    }
    if (outgoing.some((edge) => edge.label === 'fail' && !needsHuman(nodes.get(edge.target)))) {
      out.push({ message: GATE_FAIL_TO_A_PERSON, node_id: id })
    }
  }
  return out
}

function placementIssues(types: ReadonlyMap<string, string>, forward: Adjacency, backward: Adjacency): WorkflowIssue[] {
  const out: WorkflowIssue[] = []
  const terminal = (id: string) => {
    const after = forward.get(id) ?? []
    return after.length > 0 && after.every((next) => TERMINAL.has(types.get(next) ?? ''))
  }
  for (const [id, type] of types) {
    const before = backward.get(id) ?? []
    const afterBoard = before.length > 0 && before.every((previous) => types.get(previous) === 'board')
    if (type === 'learning_loop' && !(terminal(id) || afterBoard)) {
      out.push({ message: 'a learning loop is the last step before an end, or comes right after a board', node_id: id })
    }
    const alone = ![...types].some(([other, kind]) => other !== id && WORK.has(kind))
    if (type === 'self_improvement' && !(alone || terminal(id))) {
      out.push({ message: 'self-improvement runs in its own flow, or as the last step before an end', node_id: id })
    }
  }
  return out
}

const pushes = (node: WorkflowNode): boolean => {
  const params = node.data.params ?? {}
  if (node.type === 'agent') return PUSHING_ROLES.has(String(params.role))
  const claimers = Array.isArray(params.claimers) ? params.claimers : []
  return node.type === 'board' && claimers.some((role) => PUSHING_ROLES.has(String(role)))
}

function stopAtPrIssues(nodes: ReadonlyMap<string, WorkflowNode>, reach: Reach): WorkflowIssue[] {
  const out: WorkflowIssue[] = []
  for (const [id, node] of nodes) {
    if (!pushes(node)) continue
    const ends = [...reach(id)].filter((other) => TERMINAL.has(nodes.get(other)?.type ?? ''))
    const stops = ends.filter((other) => nodes.get(other)?.type === 'stop_at_pr')
    if (ends.some((other) => !needsHuman(nodes.get(other)) && nodes.get(other)?.type !== 'stop_at_pr') || stops.length === 0) {
      out.push({ message: ENDS_AT_A_STOP_AT_PR, node_id: id })
    }
  }
  return out
}

/** Neumaier's compensated sum: 0.1 + 0.2 + 0.7 is the whole budget, as with the server's `math.fsum`. */
function compensatedSum(values: readonly number[]): number {
  const [sum, compensation] = values.reduce<readonly [number, number]>(([running, lost], value) => {
    const total = running + value
    const error = Math.abs(running) >= Math.abs(value) ? (running - total) + value : (value - total) + running
    return [total, lost + error]
  }, [0, 0])
  return sum + compensation
}

/** The engineering rules over a flow whose shape and arrows are sound (the server's `graph_issues`). */
export function engineeringGraphIssues(
  definition: WorkflowDefinition, forward: Adjacency, backward: Adjacency, reach: Reach,
): WorkflowIssue[] {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const types = new Map<string, string>(definition.nodes.map((node) => [node.id, node.type]))
  const shares = definition.nodes.filter((node) => node.type === 'agent').map((node) => node.data.params?.budget_share)
  const out: WorkflowIssue[] = []
  if (compensatedSum(shares.filter((share): share is number => typeof share === 'number')) > 1) {
    out.push({ message: "the agents' budget shares add up to more than the run's budget (at most 1 in all)" })
  }
  return [...out, ...mapReduceIssues(types, forward), ...gateArrowIssues(nodes, definition.edges),
    ...placementIssues(types, forward, backward), ...stopAtPrIssues(nodes, reach)]
}
