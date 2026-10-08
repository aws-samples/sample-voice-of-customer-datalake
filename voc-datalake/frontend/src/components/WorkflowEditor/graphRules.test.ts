/**
 * @fileoverview The client-side graph rules: one start, a reachable end, no
 * orphan steps, cycles only inside declared loops, max_rounds 1–5, the node
 * limit, per-type params — and a valid default-like workflow passes.
 */
import { describe, it, expect } from 'vitest'
import { checkGraph, validateLocally } from './graphRules'
import { API_WORKFLOW_LIMITS, WORKFLOW_SCHEMA } from '../../api/workflowsApi'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeType } from '../../api/workflowsApi'
import { at } from '@test/defined'

const node = (id: string, type: WorkflowNodeType, params?: Record<string, unknown>, instructions?: string): WorkflowNode => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { title: id, ...(params === undefined ? {} : { params }), ...(instructions === undefined ? {} : { instructions }) },
})

const edge = (source: string, target: string, label?: WorkflowEdge['label']): WorkflowEdge => ({
  id: ['e', `${source}__${target}`, ...(label === undefined ? [] : [label])].join('_'),
  source,
  target,
  ...(label === undefined ? {} : { label }),
})

/** Reviews → Prototype, with the persona review / revise loop. */
function defaultLike(): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    name: 'Reviews → Prototype',
    nodes: [
      node('start', 'start'),
      node('aggregate', 'aggregate_reviews'),
      node('project', 'select_or_create_project'),
      node('prfaq', 'write_prfaq'),
      node('review', 'persona_review', { target: 'prfaq' }),
      node('revise', 'revise_document', { target: 'prfaq' }),
      node('proto', 'build_prototype'),
      node('end', 'end', { status: 'completed' }),
    ],
    edges: [
      edge('start', 'aggregate'),
      edge('aggregate', 'project'),
      edge('project', 'prfaq'),
      edge('prfaq', 'review'),
      edge('review', 'proto', 'agreed'),
      edge('review', 'revise', 'not_agreed'),
      edge('revise', 'review'),
      edge('proto', 'end'),
    ],
    loops: [{ node_ids: ['review', 'revise'], until: 'persona_agreement', max_rounds: 3 }],
  }
}

/** start → end with steps in between, as a straight chain. */
function chain(stepCount: number): WorkflowDefinition {
  const steps = Array.from({ length: stepCount }, (_x, i) => node(`s${i}`, 'aggregate_reviews'))
  const ids = ['start', ...steps.map((s) => s.id), 'end']
  return {
    schema: WORKFLOW_SCHEMA,
    name: 'Chain',
    nodes: [node('start', 'start'), ...steps, node('end', 'end')],
    edges: ids.slice(1).map((id, i) => edge(at(ids, i), id)),
    loops: [],
  }
}

const messages = (definition: unknown) => validateLocally(definition).map((i) => i.message)
const withNodes = (d: WorkflowDefinition, nodes: WorkflowNode[]): WorkflowDefinition => ({ ...d, nodes })

describe('validateLocally — a sound workflow', () => {
  it('accepts the default-like workflow', () => {
    expect(validateLocally(defaultLike())).toStrictEqual([])
  })

  it('accepts a minimal start → end workflow', () => {
    expect(validateLocally(chain(0))).toStrictEqual([])
  })
})

describe('validateLocally — start and end', () => {
  it('needs exactly one start (none)', () => {
    const d = defaultLike()
    const noStart = { ...withNodes(d, d.nodes.filter((n) => n.id !== 'start')), edges: d.edges.filter((e) => e.source !== 'start') }
    expect(messages(noStart)).toContain('a workflow needs exactly one start step')
  })

  it('needs exactly one start (two)', () => {
    const d = defaultLike()
    const twoStarts = { ...withNodes(d, [...d.nodes, node('start2', 'start')]), edges: [...d.edges, edge('start2', 'aggregate')] }
    expect(messages(twoStarts)).toStrictEqual(['a workflow needs exactly one start step'])
  })

  it('needs at least one end', () => {
    const d = chain(1)
    const noEnd = { ...withNodes(d, d.nodes.filter((n) => n.type !== 'end')), edges: [edge('start', 's0')] }
    expect(messages(noEnd)).toStrictEqual(['a workflow needs at least one end step'])
  })

  it('pins a step that cannot reach an end', () => {
    const d = chain(0)
    const deadEnd = { ...withNodes(d, [...d.nodes, node('dead', 'write_prd')]), edges: [...d.edges, edge('start', 'dead')] }
    expect(validateLocally(deadEnd)).toStrictEqual([{ message: 'this step has no path to an end step', node_id: 'dead' }])
  })

  it('refuses arrows out of an end and into the start', () => {
    const d = chain(1)
    const result = messages({ ...d, edges: [...d.edges, edge('end', 's0'), edge('s0', 'start')] })
    expect(result).toContain('an end step cannot have outgoing arrows')
    expect(result).toContain('the start step cannot have incoming arrows')
  })
})

describe('validateLocally — orphans and arrows', () => {
  it('pins an orphan step', () => {
    const d = chain(1)
    const orphan = withNodes(d, [...d.nodes, node('lonely', 'write_prd')])
    expect(validateLocally(orphan)).toStrictEqual([{ message: 'this step is not connected to the start', node_id: 'lonely' }])
  })

  it('refuses an arrow to a step that does not exist', () => {
    const d = chain(0)
    expect(messages({ ...d, edges: [...d.edges, edge('start', 'ghost')] })).toContain('edge connects a node that does not exist')
  })

  it("refuses 'agreed' arrows that do not leave a persona review", () => {
    const d = chain(1)
    const labelled = { ...d, edges: [edge('start', 's0'), { ...edge('s0', 'end'), label: 'agreed' as const }] }
    expect(validateLocally(labelled)).toStrictEqual([{ message: "'agreed' arrows can only leave a persona review", node_id: 's0' }])
  })

  it('refuses two arrows between the same steps with the same label', () => {
    const d = chain(0)
    const twice = { ...d, edges: [...d.edges, { ...edge('start', 'end'), id: 'e_dup' }] }
    expect(messages(twice)).toStrictEqual(['two arrows connect the same steps with the same label'])
  })

  it('reports a reused node id before any graph rule', () => {
    const d = chain(1)
    expect(messages(withNodes(d, [...d.nodes, node('s0', 'write_prd')]))).toStrictEqual(['node id is used more than once'])
  })

  it('reports a reused edge id', () => {
    const d = chain(1)
    expect(messages({ ...d, edges: d.edges.map((e) => ({ ...e, id: 'same' })) })).toStrictEqual(['edge id is used more than once'])
  })
})

describe('validateLocally — loops', () => {
  it('refuses a cycle that is not inside a declared loop', () => {
    const result = validateLocally({ ...defaultLike(), loops: [] })
    expect(result).toStrictEqual([
      { message: 'this step is in a cycle that is not inside one declared loop', node_id: 'review' },
      { message: 'this step is in a cycle that is not inside one declared loop', node_id: 'revise' },
    ])
  })

  it('refuses a cycle that only half belongs to a loop', () => {
    const half = { ...defaultLike(), loops: [{ node_ids: ['review'], until: 'persona_agreement' as const, max_rounds: 3 }] }
    expect(messages(half)).toContain('this step is in a cycle that is not inside one declared loop')
  })

  it('refuses a loop with no arrow back', () => {
    const d = chain(1)
    const loose = { ...d, loops: [{ node_ids: ['s0'], until: 'review_pass' as const, max_rounds: 2 }] }
    expect(messages(loose)).toContain('loop 1 has no arrow back to an earlier step in the loop')
  })

  it('refuses start / end steps inside a loop', () => {
    const d = defaultLike()
    const result = messages({ ...d, loops: [{ ...d.loops[0], node_ids: ['review', 'revise', 'end'] }] })
    expect(result).toContain('start and end steps cannot be inside a loop')
  })

  it('refuses a step in two loops and a loop naming a missing step', () => {
    const d = defaultLike()
    const result = messages({ ...d, loops: [...d.loops, { node_ids: ['revise', 'ghost'], until: 'persona_agreement' as const, max_rounds: 2 }] })
    expect(result).toContain('a step can belong to only one loop')
    expect(result).toContain('loop 2 lists a step that does not exist')
  })

  it('needs a persona review in a persona-agreement loop', () => {
    const d = chain(1)
    const result = messages({ ...d, loops: [{ node_ids: ['s0'], until: 'persona_agreement' as const, max_rounds: 2 }] })
    expect(result).toContain('loop 1 repeats until persona agreement but contains no persona review')
  })

  it.each(['pass', 'fail'] as const)("refuses a '%s' arrow out of a custom step (it reports no verdict)", (label) => {
    const d = chain(1)
    const custom = withNodes(d, d.nodes.map((n) => (n.id === 's0' ? node('s0', 'custom_llm', undefined, 'Summarise.') : n)))
    const labelled = { ...custom, edges: custom.edges.map((e) => (e.source === 's0' ? { ...e, label } : e)) }
    expect(validateLocally(labelled)).toContainEqual({
      message: `a custom step reports no pass/fail verdict, so its arrows cannot be '${label}' — use a plain arrow`,
      node_id: 's0',
    })
    expect(validateLocally(custom)).toStrictEqual([])
  })

  it('does not count a custom step as the reviewer of a review-pass loop', () => {
    const d = chain(1)
    const custom = withNodes(d, d.nodes.map((n) => (n.id === 's0' ? node('s0', 'custom_llm', undefined, 'Summarise.') : n)))
    const result = messages({ ...custom, loops: [{ node_ids: ['s0'], until: 'review_pass' as const, max_rounds: 2 }] })
    expect(result).toContain('loop 1 repeats until a review passes but contains no reviewing step')
  })

  it('needs a reviewing step in a review-pass loop', () => {
    const d = chain(1)
    const result = messages({ ...d, loops: [{ node_ids: ['s0'], until: 'review_pass' as const, max_rounds: 2 }] })
    expect(result).toContain('loop 1 repeats until a review passes but contains no reviewing step')
  })

  it.each([1, API_WORKFLOW_LIMITS.maxRounds])('accepts max_rounds %i', (rounds) => {
    const d = defaultLike()
    expect(validateLocally({ ...d, loops: [{ ...d.loops[0], max_rounds: rounds }] })).toStrictEqual([])
  })

  it.each([0, API_WORKFLOW_LIMITS.maxRounds + 1, 2.5])('refuses max_rounds %s', (rounds) => {
    const d = defaultLike()
    const result = messages({ ...d, loops: [{ ...d.loops[0], max_rounds: rounds }] })
    expect(result).toStrictEqual([expect.stringMatching(/^loops\.0\.max_rounds: /)])
  })
})

describe('validateLocally — limits and params', () => {
  it('accepts the node limit', () => {
    expect(validateLocally(chain(API_WORKFLOW_LIMITS.maxNodes - 2))).toStrictEqual([])
  })

  it('refuses one node over the limit', () => {
    expect(messages(chain(API_WORKFLOW_LIMITS.maxNodes - 1))).toContainEqual(expect.stringMatching(/^nodes: /))
  })

  it('refuses a definition that is not a workflow', () => {
    expect(messages({ nodes: 'nope' }).length).toBeGreaterThan(0)
  })

  it('needs a persona review target, a known end status and custom-step instructions', () => {
    const d = chain(0)
    const bad = withNodes(d, [
      node('start', 'start'), node('end', 'end', { status: 'archived' }),
      node('review', 'persona_review'), node('custom', 'custom_llm', undefined, '   '),
    ])
    expect(validateLocally(bad)).toStrictEqual([
      { message: 'end params.status must be one of completed, needs_human', node_id: 'end' },
      { message: 'persona_review needs params.target: one of prfaq, prd, prototype', node_id: 'review' },
      { message: 'instructions is required', node_id: 'custom' },
    ])
  })
})

describe('checkGraph', () => {
  it('runs the graph rules alone (params are not judged)', () => {
    const d = chain(0)
    expect(checkGraph(withNodes(d, [node('start', 'start'), node('end', 'end', { status: 'bogus' })]))).toStrictEqual([])
  })
})

describe('validateLocally — shape errors pinned to their step', () => {
  it("words a blank title as the server's 'title is required', on that step", () => {
    const definition = defaultLike()
    const blank = { ...definition, nodes: definition.nodes.map((n, i) => (i === 1 ? { ...n, data: { ...n.data, title: '  ' } } : n)) }
    expect(validateLocally(blank)).toStrictEqual([{ message: 'title is required', node_id: at(definition.nodes, 1).id }])
  })

  it('keeps an unpinned message for a shape error outside the steps', () => {
    const [only] = validateLocally({ ...defaultLike(), nodes: [] })
    expect(only?.node_id).toBeUndefined()
    expect(only?.message).toMatch(/^nodes: /)
  })
})
