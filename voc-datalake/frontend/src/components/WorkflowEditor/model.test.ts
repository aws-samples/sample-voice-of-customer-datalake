/**
 * @fileoverview Pure editing operations on a workflow definition: id minting,
 * add / update / move / remove / connect, edge labels, loop groups and frames.
 */
import { describe, it, expect } from 'vitest'
import {
  NODE_CATALOGUE, addNode, addToLoop, clearDefinition, connect, createLoop, edgeLabelsFor, loopBounds, loopIndexOf, mintId,
  moveNodes, parseNodeType, removeEdges, removeFromLoop, removeLoop, removeNodes, setEdgeLabel, updateLoop, updateNode,
  STEP_HEIGHT, STEP_WIDTH,
} from './model'
import { clampRounds, loopIssues } from './loopFields'
import { emptyDefinition } from './model-fixtures'
import { validateLocally } from './graphRules'
import { WORKFLOW_NODE_TYPES } from '../../api/workflowsApi'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import { at } from '@test/defined'

/** start → review → end, plus a revise step (not yet wired). */
function withReview(): WorkflowDefinition {
  const base = emptyDefinition('Flow')
  const review = addNode(base, 'persona_review', { x: 10.4, y: 140.6 }, 'Review')
  const revise = addNode(review.definition, 'revise_document', { x: 300, y: 140 }, 'Revise')
  return revise.definition
}

describe('catalogue helpers', () => {
  it('covers every node type', () => {
    const byText = (a: string, b: string) => a.localeCompare(b)
    expect(Object.keys(NODE_CATALOGUE).sort(byText)).toStrictEqual([...WORKFLOW_NODE_TYPES].sort(byText))
  })

  it('parses only known node types', () => {
    expect(parseNodeType('write_prd')).toBe('write_prd')
    expect(parseNodeType('toString')).toBeNull()
  })

  it('offers verdict labels per source type', () => {
    expect(edgeLabelsFor('persona_review')).toStrictEqual(['agreed', 'not_agreed'])
    expect(edgeLabelsFor('final_review')).toStrictEqual(['pass', 'fail'])
    // A custom step reports no verdict (3.00.00): no pass / fail out of it.
    expect(edgeLabelsFor('custom_llm')).toStrictEqual([])
    expect(edgeLabelsFor('write_prd')).toStrictEqual([])
  })
})

describe('mintId', () => {
  it('mints the first free suffix', () => {
    expect(mintId('write_prd', new Set(['write_prd_1', 'write_prd_3']))).toBe('write_prd_2')
  })

  it('sanitises the prefix to the server id charset', () => {
    expect(mintId('a b/c', new Set())).toBe('a_b_c_1')
    expect(mintId('', new Set())).toBe('n_1')
  })

  it('keeps ids within 64 characters', () => {
    expect(mintId('x'.repeat(100), new Set()).length).toBeLessThanOrEqual(64)
  })
})

describe('emptyDefinition / addNode', () => {
  it('starts as a valid start → end workflow', () => {
    expect(validateLocally(emptyDefinition('New'))).toStrictEqual([])
  })

  it('adds a node with catalogue defaults and a rounded position', () => {
    const { definition, nodeId } = addNode(emptyDefinition('F'), 'persona_review', { x: 10.4, y: 140.6 }, 'Review')
    expect(nodeId).toBe('persona_review_1')
    expect(definition.nodes.at(-1)).toStrictEqual({
      id: 'persona_review_1', type: 'persona_review', position: { x: 10, y: 141 },
      data: { title: 'Review', role: 'persona', params: { target: 'prfaq' } },
    })
  })

  it('does not share default params between nodes', () => {
    const first = addNode(emptyDefinition('F'), 'generate_personas', { x: 0, y: 0 }, 'G')
    const second = addNode(first.definition, 'generate_personas', { x: 0, y: 0 }, 'G')
    expect(second.nodeId).toBe('generate_personas_2')
    expect(at(second.definition.nodes, 2).data.params).not.toBe(NODE_CATALOGUE.generate_personas.params)
  })

  it('omits the role for flow steps', () => {
    const { definition } = addNode(emptyDefinition('F'), 'end', { x: 0, y: 0 }, 'End 2')
    expect(definition.nodes.at(-1)?.data).toStrictEqual({ title: 'End 2', params: { status: 'completed' } })
  })
})

describe('updateNode / moveNodes', () => {
  it('patches only the targeted node', () => {
    const d = withReview()
    const next = updateNode(d, 'persona_review_1', (n) => ({ ...n, data: { ...n.data, title: 'Panel' } }))
    expect(next.nodes.map((n) => n.data.title)).toStrictEqual(['Start', 'Done', 'Panel', 'Revise'])
  })

  it('moves nodes with rounding and keeps the same object when nothing moves', () => {
    const d = withReview()
    const moved = moveNodes(d, new Map([['start', { x: 5.6, y: -3.2 }]]))
    expect(at(moved.nodes, 0).position).toStrictEqual({ x: 6, y: -3 })
    expect(moveNodes(d, new Map())).toBe(d)
  })
})

describe('connect', () => {
  it('pre-fills the first free verdict label when leaving a reviewing step', () => {
    const d = connect(connect(withReview(), 'persona_review_1', 'end'), 'persona_review_1', 'revise_document_1')
    expect(d.edges.slice(1)).toStrictEqual([
      { id: 'e_persona_review_1__end_1', source: 'persona_review_1', target: 'end', label: 'agreed' },
      { id: 'e_persona_review_1__revise_document_1_1', source: 'persona_review_1', target: 'revise_document_1', label: 'not_agreed' },
    ])
  })

  it('adds a plain arrow between ordinary steps', () => {
    const d = connect(withReview(), 'revise_document_1', 'persona_review_1')
    expect(d.edges.at(-1)).toStrictEqual({ id: 'e_revise_document_1__persona_review_1_1', source: 'revise_document_1', target: 'persona_review_1' })
  })

  it.each([
    ['a self-arrow', 'persona_review_1', 'persona_review_1'],
    ['a duplicate arrow', 'start', 'end'],
    ['an arrow out of an end', 'end', 'persona_review_1'],
    ['an arrow into the start', 'persona_review_1', 'start'],
    ['an unknown step', 'ghost', 'end'],
  ])('refuses %s', (_label, source, target) => {
    const d = withReview()
    expect(connect(d, source, target)).toBe(d)
  })
})

describe('setEdgeLabel / removeEdges / removeNodes', () => {
  it('sets and clears an arrow label', () => {
    const d = connect(withReview(), 'persona_review_1', 'end')
    const id = at(d.edges, 1).id
    expect(at(setEdgeLabel(d, id, 'not_agreed').edges, 1).label).toBe('not_agreed')
    expect(setEdgeLabel(d, id, undefined).edges[1]).toStrictEqual({ id, source: 'persona_review_1', target: 'end' })
  })

  it('removes arrows by id', () => {
    const d = withReview()
    expect(removeEdges(d, new Set(['e_start__end'])).edges).toStrictEqual([])
    expect(removeEdges(d, new Set())).toBe(d)
  })

  it('removes nodes with their arrows and loop membership, dropping an emptied loop', () => {
    const wired = connect(connect(withReview(), 'persona_review_1', 'revise_document_1'), 'revise_document_1', 'persona_review_1')
    const looped = createLoop(wired, ['persona_review_1', 'revise_document_1'])
    const once = removeNodes(looped, new Set(['revise_document_1']))
    expect(once.edges.map((e) => e.id)).toStrictEqual(['e_start__end'])
    expect(once.loops).toStrictEqual([{ node_ids: ['persona_review_1'], until: 'persona_agreement', max_rounds: 3 }])
    expect(removeNodes(once, new Set(['persona_review_1'])).loops).toStrictEqual([])
  })
})

describe('loops', () => {
  it('groups steps (never start/end) and picks the until rule from the members', () => {
    const d = createLoop(withReview(), ['start', 'persona_review_1', 'revise_document_1', 'end'])
    expect(d.loops).toStrictEqual([{ node_ids: ['persona_review_1', 'revise_document_1'], until: 'persona_agreement', max_rounds: 3 }])
    expect(at(createLoop(withReview(), ['revise_document_1']).loops, 0).until).toBe('review_pass')
  })

  it('ignores a group with no eligible steps', () => {
    const d = withReview()
    expect(createLoop(d, ['start', 'end', 'ghost'])).toBe(d)
  })

  it('moves steps out of their previous loop', () => {
    const first = createLoop(withReview(), ['persona_review_1', 'revise_document_1'])
    const second = createLoop(first, ['revise_document_1'])
    expect(second.loops.map((l) => l.node_ids)).toStrictEqual([['persona_review_1'], ['revise_document_1']])
    expect(loopIndexOf(second, 'revise_document_1')).toBe(1)
    expect(loopIndexOf(second, 'start')).toBe(-1)
  })

  it('updates and removes a loop by index', () => {
    const d = createLoop(withReview(), ['persona_review_1'])
    expect(at(updateLoop(d, 0, { max_rounds: 5 }).loops, 0).max_rounds).toBe(5)
    expect(removeLoop(d, 0).loops).toStrictEqual([])
  })

  it('frames the loop members with padding', () => {
    const pad = 28 // GROUP_PADDING in model.ts (+16 above for the frame label)
    const d = createLoop(withReview(), ['persona_review_1', 'revise_document_1'])
    const x = 10 - pad
    const y = 140 - pad - 16 // the revise step sits at y=140, the review at 141
    expect(loopBounds(d, at(d.loops, 0))).toStrictEqual({
      x, y, width: 300 + STEP_WIDTH + pad - x, height: 141 + STEP_HEIGHT + pad - y,
    })
    expect(loopBounds(d, { node_ids: ['ghost'], until: 'review_pass', max_rounds: 1 })).toBeNull()
  })
})

describe('connect with an explicit condition ("Add arrow")', () => {
  it('uses the chosen condition instead of the first free one', () => {
    const d = connect(withReview(), 'persona_review_1', 'revise_document_1', 'not_agreed')
    expect(d.edges.at(-1)?.label).toBe('not_agreed')
  })

  it('adds a default arrow out of a reviewing step for `null`', () => {
    const d = connect(withReview(), 'persona_review_1', 'end', null)
    expect(d.edges.at(-1)).toStrictEqual({ id: 'e_persona_review_1__end_1', source: 'persona_review_1', target: 'end' })
  })

  it.each([
    ['pass out of a persona review', 'persona_review_1', 'end', 'pass'],
    ['agreed out of a step without a verdict', 'revise_document_1', 'end', 'agreed'],
  ] as const)('refuses %s', (_label, source, target, condition) => {
    const d = withReview()
    expect(connect(d, source, target, condition)).toBe(d)
  })
})

describe('addToLoop / removeFromLoop / clearDefinition', () => {
  const looped = () => createLoop(withReview(), ['persona_review_1'])

  it('opens a new loop for one step and joins an existing one', () => {
    const opened = addToLoop(withReview(), 'persona_review_1', 'new')
    expect(opened.loops).toStrictEqual([{ node_ids: ['persona_review_1'], until: 'persona_agreement', max_rounds: 3 }])
    expect(at(addToLoop(opened, 'revise_document_1', 0).loops, 0).node_ids).toStrictEqual(['persona_review_1', 'revise_document_1'])
  })

  it('moves a step out of its previous loop, dropping that loop when it empties', () => {
    const two = createLoop(looped(), ['revise_document_1'])
    const moved = addToLoop(two, 'persona_review_1', 1)
    // Loop 0 emptied and went, so the joined loop is now the first.
    expect(moved.loops).toStrictEqual([{ node_ids: ['revise_document_1', 'persona_review_1'], until: 'review_pass', max_rounds: 3 }])
  })

  it.each([
    ['a start step', 'start', 0],
    ['an unknown step', 'ghost', 0],
    ['a missing loop', 'revise_document_1', 3],
    ['a negative index', 'revise_document_1', -1],
    ['a step already in that loop', 'persona_review_1', 0],
  ] as const)('refuses %s', (_label, nodeId, index) => {
    const d = looped()
    expect(addToLoop(d, nodeId, index)).toBe(d)
  })

  it('takes a step out of its loop, and the loop goes with its last member', () => {
    const d = addToLoop(looped(), 'revise_document_1', 0)
    expect(at(removeFromLoop(d, 'revise_document_1').loops, 0).node_ids).toStrictEqual(['persona_review_1'])
    expect(removeFromLoop(looped(), 'persona_review_1').loops).toStrictEqual([])
    expect(removeFromLoop(d, 'start')).toBe(d)
  })

  it('clears every step, arrow and loop but keeps the name and description', () => {
    const d = { ...looped(), description: 'kept' }
    expect(clearDefinition(d)).toStrictEqual({ ...d, nodes: [], edges: [], loops: [] })
  })
})

describe('loopFields', () => {
  it.each([['3', 3], ['9', 5], ['0', 1], ['', 1], ['2.7', 2], ['abc', 1]])('clamps %j rounds to %i', (raw, rounds) => {
    expect(clampRounds(raw)).toBe(rounds)
  })

  it('keeps only the messages about the given loop', () => {
    const messages = ['loop 1 is malformed', 'loop 10 is malformed', 'loop 2 has no arrow back', 'a workflow needs an end']
    expect(loopIssues(messages, 0)).toStrictEqual(['loop 1 is malformed'])
    expect(loopIssues(messages, 1)).toStrictEqual(['loop 2 has no arrow back'])
  })
})
