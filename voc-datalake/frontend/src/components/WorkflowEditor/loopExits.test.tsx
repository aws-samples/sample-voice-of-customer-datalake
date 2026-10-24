/**
 * @fileoverview Loop exits: the loop's review (its gate) leaves the loop on its
 * passing verdict and goes round on its failing one, no other member leaves the
 * loop — the local mirror of the server's messages — and a new arrow out of a
 * gate is labelled by its direction (canvas drag and "Add arrow").
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import builtinJson from '@test/builtinWorkflow.json'
import { at } from '@test/defined'
import { validateLocally } from './graphRules'
import { connect } from './model'
import { StepArrows } from './ArrowSettings'
import { normalizeDefinition, WORKFLOW_SCHEMA } from '../../api/workflowsApi'
import type { WorkflowDefinition, WorkflowEdge, WorkflowLoop, WorkflowNode, WorkflowNodeType } from '../../api/workflowsApi'

const node = (id: string, type: WorkflowNodeType, params?: Record<string, unknown>): WorkflowNode => ({
  id, type, position: { x: 0, y: 0 }, data: { title: id, ...(params === undefined ? {} : { params }) },
})
const edge = (source: string, target: string, label?: WorkflowEdge['label']): WorkflowEdge => ({
  id: `e_${source}__${target}`, source, target, ...(label === undefined ? {} : { label }),
})

/** start → write → review ⇄ revise → end; the review gates a persona-agreement loop. */
function personaLoop(edges?: WorkflowEdge[], loop?: Partial<WorkflowLoop>): WorkflowDefinition {
  return {
    schema: WORKFLOW_SCHEMA,
    name: 'Loop',
    nodes: [
      node('start', 'start'), node('write', 'write_prfaq'), node('review', 'persona_review', { target: 'prfaq' }),
      node('revise', 'revise_document', { target: 'prfaq' }), node('end', 'end', { status: 'completed' }),
    ],
    edges: edges ?? [
      edge('start', 'write'), edge('write', 'review'), edge('review', 'end', 'agreed'),
      edge('review', 'revise', 'not_agreed'), edge('revise', 'review'),
    ],
    loops: [{ node_ids: ['review', 'revise'], until: 'persona_agreement', max_rounds: 3, ...loop }],
  }
}

/** The same shape gated by a final review in a review-pass loop. */
function reviewLoop(edges: WorkflowEdge[]): WorkflowDefinition {
  const base = personaLoop(edges, { until: 'review_pass' })
  return { ...base, nodes: base.nodes.map((n) => (n.id === 'review' ? node('review', 'final_review') : n)) }
}

const HEAD = [edge('start', 'write'), edge('write', 'review'), edge('revise', 'review')]
const issuesOf = (d: WorkflowDefinition) => validateLocally(d)

describe('loop exits — valid workflows', () => {
  it('accepts the gated persona loop', () => {
    expect(issuesOf(personaLoop())).toStrictEqual([])
  })

  it('keeps the built-in template valid', () => {
    const builtin = normalizeDefinition(builtinJson)
    expect(builtin).not.toBeNull()
    expect(builtin === null ? ['unreadable'] : issuesOf(builtin)).toStrictEqual([])
  })

  it('accepts a review-pass loop gated by a final review', () => {
    expect(issuesOf(reviewLoop([...HEAD, edge('review', 'end', 'pass'), edge('review', 'revise', 'fail')]))).toStrictEqual([])
  })
})

describe('loop exits — the gate', () => {
  it("needs an 'agreed' arrow that leaves the loop", () => {
    const d = personaLoop([...HEAD, edge('review', 'revise', 'not_agreed'), edge('revise', 'end')])
    expect(issuesOf(d)).toContainEqual({ message: "this review needs an 'agreed' arrow that leaves the loop", node_id: 'review' })
  })

  it("needs a 'not_agreed' arrow that stays inside the loop", () => {
    const d = personaLoop([...HEAD.slice(0, 2), edge('review', 'end', 'agreed'), edge('review', 'revise', 'agreed'), edge('revise', 'review')])
    expect(issuesOf(d)).toStrictEqual([
      { message: "this review needs a 'not_agreed' arrow that stays inside the loop", node_id: 'review' },
      { message: "an 'agreed' arrow must leave the loop", node_id: 'review' },
    ])
  })

  it("refuses a 'fail' arrow that leaves the loop, in the server's order", () => {
    const d = reviewLoop([...HEAD, edge('review', 'end', 'fail'), edge('review', 'revise', 'pass')])
    expect(issuesOf(d).map((i) => i.message)).toStrictEqual([
      "this review needs a 'pass' arrow that leaves the loop",
      "this review needs a 'fail' arrow that stays inside the loop",
      "a 'pass' arrow must leave the loop",
      "a 'fail' arrow must stay inside the loop",
    ])
  })

  it('asks for every arrow of the review to be labelled', () => {
    const d = reviewLoop([...HEAD, edge('review', 'end', 'pass'), edge('review', 'revise')])
    expect(issuesOf(d)).toStrictEqual([
      { message: "this review needs a 'fail' arrow that stays inside the loop", node_id: 'review' },
      { message: "label each arrow of this review 'pass' or 'fail'", node_id: 'review' },
    ])
  })

  it("lets only the loop's review leave the loop", () => {
    const d = personaLoop([...HEAD, edge('review', 'end', 'agreed'), edge('review', 'revise', 'not_agreed'), edge('revise', 'end')])
    expect(issuesOf(d)).toStrictEqual([{ message: "only the loop's review can leave the loop", node_id: 'revise' }])
  })
})

describe("loop exits — the server's order and scope", () => {
  const messages = (d: WorkflowDefinition) => issuesOf(d).map((i) => [i.message, i.node_id])

  it('walks members in node_ids order, each gate checked where it sits', () => {
    const d = personaLoop([...HEAD, edge('review', 'revise', 'not_agreed'), edge('revise', 'end')], { node_ids: ['revise', 'review'] })
    expect(messages(d)).toStrictEqual([
      ["only the loop's review can leave the loop", 'revise'],
      ["this review needs an 'agreed' arrow that leaves the loop", 'review'],
    ])
  })

  it('reports only the missing review for a loop without one, not every way out', () => {
    const d = personaLoop([...HEAD, edge('review', 'end', 'agreed'), edge('review', 'revise', 'not_agreed'), edge('revise', 'end')], { until: 'review_pass' })
    expect(messages(d)).toStrictEqual([['loop 1 repeats until a review passes but contains no final review', undefined]])
  })

  it('does not count an end step listed in the loop as inside it', () => {
    const d = personaLoop(undefined, { node_ids: ['review', 'revise', 'end'] })
    expect(messages(d)).toStrictEqual([['start and end steps cannot be inside a loop', 'end']])
  })
})

describe('loop exits — arrows out of a gate are labelled by direction', () => {
  const open = () => personaLoop([edge('start', 'write'), edge('write', 'review'), edge('revise', 'review')])

  it('labels a drag into the loop with the failing verdict', () => {
    expect(connect(open(), 'review', 'revise').edges.at(-1)?.label).toBe('not_agreed')
  })

  it('labels a drag out of the loop with the passing verdict, even when it is not the first free label', () => {
    const d = connect(connect(open(), 'review', 'revise'), 'review', 'end')
    expect(d.edges.at(-1)?.label).toBe('agreed')
  })

  it('keeps an explicit condition and the first-free label outside a loop', () => {
    expect(connect(open(), 'review', 'revise', 'agreed').edges.at(-1)?.label).toBe('agreed')
    expect(connect({ ...open(), loops: [] }, 'review', 'revise').edges.at(-1)?.label).toBe('agreed')
  })

  it('pre-labels "Add arrow" left on no condition, and the user can still pick one', async () => {
    const onChange = vi.fn<(d: WorkflowDefinition) => void>()
    const d = open()
    render(<StepArrows definition={d} node={at(d.nodes, 2)} readOnly={false} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText('To step'), 'end')
    await userEvent.click(screen.getByRole('button', { name: 'Add arrow' }))
    expect(onChange.mock.calls.at(-1)?.[0].edges.at(-1)).toMatchObject({ target: 'end', label: 'agreed' })
  })
})
