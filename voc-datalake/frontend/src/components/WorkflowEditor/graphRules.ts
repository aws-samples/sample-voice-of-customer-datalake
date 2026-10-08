/**
 * @fileoverview Client-side port of the graph rules in
 * `lambda/shared/workflow_schema.py` (`_check_graph`), so the editor can pin
 * errors to steps as the user edits. Same messages, same order of checks.
 *
 * The server's `POST /workflows/validate` stays the judge (it also runs
 * these); this module only gives instant, inline feedback.
 *
 * @module components/WorkflowEditor/graphRules
 */
import { REVIEW_TARGETS, END_STATUSES, isObject, workflowDefinitionSchema } from '../../api/workflowsApi'
import type { WorkflowDefinition, WorkflowIssue } from '../../api/workflowsApi'

const PERSONA_LABELS = new Set(['agreed', 'not_agreed'])
// Not `custom_llm`: a custom step reports no verdict, so it can neither gate a
// `review_pass` loop nor carry pass/fail arrows.
const VERDICT_NODES = new Set(['persona_review', 'final_review'])
const CUSTOM_STEP_VERDICT_LABELS = new Set(['pass', 'fail'])

type Adjacency = Map<string, string[]>

/** Nodes reachable from `start` by one or more edges. */
function reach(start: string, adjacency: Adjacency): Set<string> {
  const seen = new Set<string>()
  const queue = [...(adjacency.get(start) ?? [])]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === undefined || seen.has(node)) continue
    seen.add(node)
    queue.push(...(adjacency.get(node) ?? []))
  }
  return seen
}

function issue(message: string, nodeId?: string): WorkflowIssue {
  return { message, node_id: nodeId }
}

function checkParams(definition: WorkflowDefinition, out: WorkflowIssue[]): void {
  for (const node of definition.nodes) {
    const params = node.data.params ?? {}
    if (node.type === 'persona_review' && !REVIEW_TARGETS.some((t) => t === params.target)) {
      out.push(issue(`persona_review needs params.target: one of ${REVIEW_TARGETS.join(', ')}`, node.id))
    }
    const status = params.status ?? 'completed'
    if (node.type === 'end' && !END_STATUSES.some((s) => s === status)) {
      out.push(issue(`end params.status must be one of ${END_STATUSES.join(', ')}`, node.id))
    }
    if (node.type === 'custom_llm' && (node.data.instructions ?? '').trim() === '') {
      out.push(issue('instructions is required', node.id))
    }
  }
}

function checkUnique(definition: WorkflowDefinition, out: WorkflowIssue[]): void {
  const nodes = new Set<string>()
  for (const node of definition.nodes) {
    if (nodes.has(node.id)) out.push(issue('node id is used more than once', node.id))
    nodes.add(node.id)
  }
  const edges = new Set<string>()
  for (const edge of definition.edges) {
    if (edges.has(edge.id)) out.push(issue('edge id is used more than once'))
    edges.add(edge.id)
  }
}

/** The label rules: which verdicts may leave which step. */
function checkEdgeLabel(label: string, source: string, sourceType: string | undefined, out: WorkflowIssue[]): void {
  if (PERSONA_LABELS.has(label) && sourceType !== 'persona_review') {
    out.push(issue(`'${label}' arrows can only leave a persona review`, source))
  }
  if (CUSTOM_STEP_VERDICT_LABELS.has(label) && sourceType === 'custom_llm') {
    out.push(issue(`a custom step reports no pass/fail verdict, so its arrows cannot be '${label}' — use a plain arrow`, source))
  }
}

function checkEdges(definition: WorkflowDefinition, types: Map<string, string>, out: WorkflowIssue[]): void {
  const seen = new Set<string>()
  for (const edge of definition.edges) {
    const { source, target } = edge
    const label = edge.label ?? ''
    if (!types.has(source) || !types.has(target)) {
      out.push(issue('edge connects a node that does not exist', types.has(source) ? source : undefined))
      continue
    }
    if (types.get(source) === 'end') out.push(issue('an end step cannot have outgoing arrows', source))
    if (types.get(target) === 'start') out.push(issue('the start step cannot have incoming arrows', target))
    checkEdgeLabel(label, source, types.get(source), out)
    const key = `${source}\u0000${target}\u0000${label}`
    if (seen.has(key)) out.push(issue('two arrows connect the same steps with the same label', source))
    seen.add(key)
  }
}

function checkReachability(
  definition: WorkflowDefinition, types: Map<string, string>, forward: Adjacency, backward: Adjacency, out: WorkflowIssue[],
): void {
  const starts = [...types].filter(([, t]) => t === 'start').map(([id]) => id)
  const ends = [...types].filter(([, t]) => t === 'end').map(([id]) => id)
  if (starts.length !== 1) out.push(issue('a workflow needs exactly one start step'))
  if (ends.length === 0) out.push(issue('a workflow needs at least one end step'))
  const start = starts.at(0)
  if (start === undefined || starts.length !== 1 || ends.length === 0) return
  const reachable = new Set([start, ...reach(start, forward)])
  const reachesEnd = new Set(ends)
  for (const end of ends) for (const id of reach(end, backward)) reachesEnd.add(id)
  for (const node of definition.nodes) {
    if (!reachable.has(node.id)) out.push(issue('this step is not connected to the start', node.id))
    else if (!reachesEnd.has(node.id)) out.push(issue('this step has no path to an end step', node.id))
  }
}

function loopOwners(definition: WorkflowDefinition, types: Map<string, string>, out: WorkflowIssue[]): Map<string, number> {
  const owner = new Map<string, number>()
  definition.loops.forEach((loop, index) => {
    for (const id of loop.node_ids) {
      const type = types.get(id)
      if (type === undefined) {
        out.push(issue(`loop ${index + 1} lists a step that does not exist`))
        continue
      }
      if (type === 'start' || type === 'end') out.push(issue('start and end steps cannot be inside a loop', id))
      const current = owner.get(id)
      if (current !== undefined && current !== index) out.push(issue('a step can belong to only one loop', id))
      if (current === undefined) owner.set(id, index)
    }
    const memberTypes = new Set(loop.node_ids.map((id) => types.get(id)))
    if (loop.until === 'persona_agreement' && !memberTypes.has('persona_review')) {
      out.push(issue(`loop ${index + 1} repeats until persona agreement but contains no persona review`))
    }
    if (loop.until === 'review_pass' && ![...memberTypes].some((t) => t !== undefined && VERDICT_NODES.has(t))) {
      out.push(issue(`loop ${index + 1} repeats until a review passes but contains no reviewing step`))
    }
  })
  return owner
}

function checkLoops(definition: WorkflowDefinition, types: Map<string, string>, forward: Adjacency, out: WorkflowIssue[]): void {
  const owner = loopOwners(definition, types, out)
  const reachOf = new Map([...types.keys()].map((id) => [id, reach(id, forward)]))
  const cyclicLoops = new Set<number>()
  for (const id of types.keys()) {
    const mine = reachOf.get(id) ?? new Set<string>()
    if (!mine.has(id)) continue
    const component = [...mine].filter((other) => reachOf.get(other)?.has(id) === true)
    const loopIndex = owner.get(id)
    if (loopIndex === undefined || component.some((other) => owner.get(other) !== loopIndex)) {
      out.push(issue('this step is in a cycle that is not inside one declared loop', id))
    } else {
      cyclicLoops.add(loopIndex)
    }
  }
  definition.loops.forEach((_loop, index) => {
    if (!cyclicLoops.has(index)) out.push(issue(`loop ${index + 1} has no arrow back to an earlier step in the loop`))
  })
}

/** The graph rules only (assumes a sound shape). */
export function checkGraph(definition: WorkflowDefinition): WorkflowIssue[] {
  const out: WorkflowIssue[] = []
  const types = new Map(definition.nodes.map((n) => [n.id, n.type]))
  const forward: Adjacency = new Map([...types.keys()].map((id) => [id, []]))
  const backward: Adjacency = new Map([...types.keys()].map((id) => [id, []]))
  for (const edge of definition.edges) {
    if (types.has(edge.source) && types.has(edge.target)) {
      forward.get(edge.source)?.push(edge.target)
      backward.get(edge.target)?.push(edge.source)
    }
  }
  checkEdges(definition, types, out)
  checkReachability(definition, types, forward, backward, out)
  checkLoops(definition, types, forward, out)
  return out
}

/** The step a Zod issue path points into (`nodes.<i>.…`), if any. */
function nodeAt(definition: unknown, path: readonly PropertyKey[]): Record<string, unknown> | undefined {
  const [head, index] = path
  if (head !== 'nodes' || typeof index !== 'number' || !isObject(definition) || !Array.isArray(definition.nodes)) return undefined
  const node: unknown = definition.nodes[index]
  return isObject(node) && typeof node.id === 'string' ? node : undefined
}

const blankTitle = (node: Record<string, unknown>): boolean =>
  isObject(node.data) && typeof node.data.title === 'string' && node.data.title.trim() === ''

/** A Zod issue as the server would word it, pinned to its step when it is about one. */
function shapeIssue(definition: unknown, path: readonly PropertyKey[], message: string): WorkflowIssue {
  const node = nodeAt(definition, path)
  if (node === undefined || typeof node.id !== 'string') return issue(`${path.map(String).join('.') || 'definition'}: ${message}`)
  const field = path.slice(2).map(String).join('.')
  // A blank `data.title` is the server's "title is required".
  if (field === 'data.title' && blankTitle(node)) return issue('title is required', node.id)
  return issue(`${field || 'step'}: ${message}`, node.id)
}

/** Zod shape, then (only when the shape is sound) params and graph rules — like the server. */
export function validateLocally(definition: unknown): WorkflowIssue[] {
  const shape = workflowDefinitionSchema.safeParse(definition)
  if (!shape.success) {
    return shape.error.issues.map((i) => shapeIssue(definition, i.path, i.message))
  }
  const out: WorkflowIssue[] = []
  checkParams(shape.data, out)
  checkUnique(shape.data, out)
  if (out.length > 0) return out
  return checkGraph(shape.data)
}
