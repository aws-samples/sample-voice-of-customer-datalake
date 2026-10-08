/**
 * @fileoverview The side panel's arrow and loop settings (owner: "I don't have
 * the option to build a fail or pass, the loop if I click on it is not
 * configurable"):
 * - an arrow's condition is offered per source step (pass / fail from a final
 *   review, agreed / not agreed from a persona review, none elsewhere, with a
 *   hint saying why), and editable both on the arrow and from its source step;
 * - "Add arrow" wires a branch with a chosen condition, keyboard only;
 * - a selected loop opens its settings (exit condition, max rounds clamped to
 *   the server's 1–5, members, its validation messages);
 * - a step joins / leaves a loop from its own settings;
 * - read-only callers see every setting disabled.
 *
 * The panel runs in a stateful harness so a sequence of edits composes like in
 * the editor; `onDefinition` records every definition it emits.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NodeConfigPanel } from './NodeConfigPanel'
import { selectLoop, selectStep, viewOf } from './selection'
import { WORKFLOW_SCHEMA } from '../../api/workflowsApi'
import type { CanvasSelection } from './selection'
import type { WorkflowDefinition } from '../../api/workflowsApi'

const node = (id: string, type: WorkflowDefinition['nodes'][number]['type'], title: string, params: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data: { title, params } })

/** start → write → review ⇄ revise (loop) → final → done | human. */
const DEFINITION: WorkflowDefinition = {
  schema: WORKFLOW_SCHEMA,
  name: 'Branching',
  nodes: [
    node('start', 'start', 'Start'),
    node('write', 'write_prfaq', 'Write'),
    node('review', 'persona_review', 'Review', { target: 'prfaq' }),
    node('revise', 'revise_document', 'Revise', { target: 'prfaq' }),
    node('final', 'final_review', 'Final'),
    node('done', 'end', 'Done', { status: 'completed' }),
    node('human', 'end', 'Human', { status: 'needs_human' }),
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'write' },
    { id: 'e2', source: 'write', target: 'review' },
    { id: 'e3', source: 'review', target: 'revise', label: 'not_agreed' },
    { id: 'e4', source: 'revise', target: 'review' },
    { id: 'e5', source: 'review', target: 'final', label: 'agreed' },
    { id: 'e6', source: 'final', target: 'done', label: 'pass' },
  ],
  loops: [{ node_ids: ['review', 'revise'], until: 'persona_agreement', max_rounds: 3 }],
}

function Harness({ initial, selection, readOnly, issues, onDefinition }: Readonly<{
  initial: WorkflowDefinition; selection: CanvasSelection; readOnly: boolean; issues: readonly string[]
  onDefinition: (definition: WorkflowDefinition) => void
}>) {
  const [definition, setDefinition] = useState(initial)
  const [current, setCurrent] = useState(selection)
  return (
    <NodeConfigPanel definition={definition} selection={current} issuesByNode={new Map()} generalIssues={issues}
      readOnly={readOnly} onSelect={setCurrent}
      onChange={(next) => { setDefinition(next); onDefinition(next) }} />
  )
}

interface RenderOptions {
  readOnly?: boolean
  issues?: readonly string[]
  initial?: WorkflowDefinition
}

const NO_ISSUES: readonly string[] = []

function renderPanel(selection: CanvasSelection, { readOnly = false, issues = NO_ISSUES, initial = DEFINITION }: RenderOptions = {}) {
  const onDefinition = vi.fn<(definition: WorkflowDefinition) => void>()
  render(<Harness initial={initial} selection={selection} readOnly={readOnly} issues={issues} onDefinition={onDefinition} />)
  const last = (): WorkflowDefinition => {
    const call = onDefinition.mock.calls.at(-1)
    if (call === undefined) throw new Error('the panel emitted no change')
    return call[0]
  }
  return { onDefinition, last }
}

const arrowSelection = (id: string): CanvasSelection => ({ nodeIds: [], edgeIds: [id], loopIndexes: [] })
const optionTexts = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent)
const edgeOf = (definition: WorkflowDefinition, id: string) => definition.edges.find((e) => e.id === id)

describe('viewOf', () => {
  it('ranks several steps, one step, one arrow, one loop, then the workflow', () => {
    const kinds = [
      { nodeIds: ['write', 'final'], edgeIds: ['e1'], loopIndexes: [0] },
      { nodeIds: ['write'], edgeIds: ['e1'], loopIndexes: [0] },
      arrowSelection('e1'),
      selectLoop(0),
      { nodeIds: [], edgeIds: [], loopIndexes: [] },
    ].map((selection) => viewOf(DEFINITION, selection).kind)
    expect(kinds).toStrictEqual(['steps', 'step', 'arrow', 'loop', 'workflow'])
    expect(viewOf(DEFINITION, selectLoop(0))).toStrictEqual({ kind: 'loop', index: 0 })
  })

  it('falls back to the workflow for ids that no longer exist', () => {
    expect(viewOf(DEFINITION, selectStep('gone')).kind).toBe('workflow')
    expect(viewOf(DEFINITION, arrowSelection('gone')).kind).toBe('workflow')
    expect(viewOf(DEFINITION, selectLoop(4)).kind).toBe('workflow')
  })
})

describe('arrow conditions', () => {
  it('offers pass / fail on an arrow out of a final review and edits it', async () => {
    const { last } = renderPanel(arrowSelection('e6'))
    const select = screen.getByLabelText('Condition')
    expect(optionTexts(select)).toStrictEqual(['Always', 'Pass', 'Fail'])
    expect(select).toHaveValue('pass')
    await userEvent.selectOptions(select, 'Fail')
    expect(edgeOf(last(), 'e6')?.label).toBe('fail')
    await userEvent.selectOptions(select, 'Always')
    expect(edgeOf(last(), 'e6')).toStrictEqual({ id: 'e6', source: 'final', target: 'done' })
  })

  it('offers agreed / not agreed out of a persona review', () => {
    renderPanel(arrowSelection('e5'))
    expect(optionTexts(screen.getByLabelText('Condition'))).toStrictEqual(['Always', 'Agreed', 'Not agreed'])
  })

  it('explains why an arrow out of a step without a verdict has no condition', () => {
    renderPanel(arrowSelection('e2'))
    expect(screen.queryByLabelText('Condition')).not.toBeInTheDocument()
    expect(screen.getByText('This step reports no verdict, so its arrows always run.')).toBeInTheDocument()
  })

  it('offers no pass / fail out of a custom step: its arrows always run', () => {
    const initial: WorkflowDefinition = {
      ...DEFINITION,
      nodes: [...DEFINITION.nodes, { ...node('custom', 'custom_llm', 'Think'), data: { title: 'Think', instructions: 'Summarise.', params: {} } }],
      edges: [...DEFINITION.edges, { id: 'e7', source: 'write', target: 'custom' }, { id: 'e8', source: 'custom', target: 'human' }],
    }
    renderPanel(selectStep('custom'), { initial })
    const add = screen.getByRole('group', { name: 'Add an arrow' })
    expect(within(add).queryByLabelText('Condition')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Condition to Human')).not.toBeInTheDocument()
  })

  it('offers only real targets for a new arrow', () => {
    renderPanel(selectStep('final'))
    const add = screen.getByRole('group', { name: 'Add an arrow' })
    // Not itself, not the start, not a step it already points at.
    expect(optionTexts(within(add).getByLabelText('To step'))).toStrictEqual(['Choose a step…', 'Write', 'Review', 'Revise', 'Human'])
    expect(within(add).getByRole('button', { name: 'Add arrow' })).toBeDisabled()
  })

  it('builds the fail branch from the source step, keyboard only', async () => {
    const { last } = renderPanel(selectStep('final'))
    const add = screen.getByRole('group', { name: 'Add an arrow' })
    await userEvent.selectOptions(within(add).getByLabelText('To step'), 'Human')
    await userEvent.selectOptions(within(add).getByLabelText('Condition'), 'Fail')
    await userEvent.click(within(add).getByRole('button', { name: 'Add arrow' }))
    expect(last().edges.at(-1)).toMatchObject({ source: 'final', target: 'human', label: 'fail' })
    // The new arrow is listed with its own condition picker.
    expect(screen.getByLabelText('Condition to Human')).toHaveValue('fail')
  })

  it("edits and deletes an arrow from its source step's list", async () => {
    const { last } = renderPanel(selectStep('final'))
    await userEvent.selectOptions(screen.getByLabelText('Condition to Done'), 'Fail')
    expect(edgeOf(last(), 'e6')?.label).toBe('fail')
    await userEvent.click(screen.getByRole('button', { name: 'Delete the arrow to Done' }))
    expect(edgeOf(last(), 'e6')).toBeUndefined()
  })

  it('adds a default arrow when no condition is chosen', async () => {
    const { last } = renderPanel(selectStep('write'))
    const add = screen.getByRole('group', { name: 'Add an arrow' })
    expect(within(add).queryByLabelText('Condition')).not.toBeInTheDocument()
    await userEvent.selectOptions(within(add).getByLabelText('To step'), 'Final')
    await userEvent.click(within(add).getByRole('button', { name: 'Add arrow' }))
    const added = last().edges.at(-1)
    expect(added).toMatchObject({ source: 'write', target: 'final' })
    expect(added !== undefined && 'label' in added).toBe(false)
  })

  it('offers no outgoing arrows on an end step', () => {
    renderPanel(selectStep('done'))
    expect(screen.queryByRole('region', { name: 'Arrows out' })).not.toBeInTheDocument()
  })
})

describe('loop settings', () => {
  it('opens a selected loop and edits its exit condition', async () => {
    const { last } = renderPanel(selectLoop(0))
    const loop = screen.getByRole('region', { name: 'Loop 1' })
    const until = within(loop).getByLabelText('Until')
    expect(until).toHaveValue('persona_agreement')
    await userEvent.selectOptions(until, 'the review passes')
    expect(last().loops[0]?.until).toBe('review_pass')
    expect(within(loop).getByText('Repeats while a review step in the loop answers "Fail".')).toBeInTheDocument()
  })

  it('clamps max rounds to the server range 1–5', async () => {
    const { last } = renderPanel(selectLoop(0))
    const rounds = within(screen.getByRole('region', { name: 'Loop 1' })).getByLabelText('Maximum rounds')
    await userEvent.clear(rounds)
    await userEvent.type(rounds, '9')
    expect(last().loops[0]?.max_rounds).toBe(5)
    expect(rounds).toHaveValue(5)
  })

  it('adds and removes member steps (never start or end)', async () => {
    const { last } = renderPanel(selectLoop(0))
    const members = screen.getByRole('group', { name: 'Steps in this loop' })
    expect(within(members).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent))
      .toStrictEqual(['Write', 'Review', 'Revise', 'Final'])
    await userEvent.click(within(members).getByLabelText('Final'))
    expect(last().loops[0]?.node_ids).toStrictEqual(['review', 'revise', 'final'])
    await userEvent.click(within(members).getByLabelText('Revise'))
    expect(last().loops[0]?.node_ids).toStrictEqual(['review', 'final'])
  })

  it('never empties a loop through its member list', () => {
    const single: WorkflowDefinition = { ...DEFINITION, loops: [{ node_ids: ['review'], until: 'persona_agreement', max_rounds: 2 }] }
    renderPanel(selectLoop(0), { initial: single })
    expect(screen.getByLabelText('Review')).toBeDisabled()
  })

  it("lists the loop's own validation messages", () => {
    renderPanel(selectLoop(0), { issues: ['loop 1 has no arrow back to an earlier step in the loop', 'loop 2 is malformed', 'a workflow needs at least one end step'] })
    const loop = screen.getByRole('region', { name: 'Loop 1' })
    expect(within(loop).getByText('loop 1 has no arrow back to an earlier step in the loop')).toBeInTheDocument()
    expect(within(loop).queryByText('loop 2 is malformed')).not.toBeInTheDocument()
  })

  it('removes the loop', async () => {
    const { last } = renderPanel(selectLoop(0))
    await userEvent.click(screen.getByRole('button', { name: 'Remove the loop' }))
    expect(last().loops).toStrictEqual([])
  })

  it('puts a step into a new loop and takes it out again', async () => {
    const { last } = renderPanel(selectStep('final'))
    expect(screen.getByLabelText('Loop')).toHaveValue('new')
    await userEvent.click(screen.getByRole('button', { name: 'Add to loop' }))
    expect(last().loops.at(-1)).toStrictEqual({ node_ids: ['final'], until: 'review_pass', max_rounds: 3 })
    // Now a member: its loop's settings show under the step.
    expect(screen.getByRole('region', { name: 'Loop 2' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Take this step out of the loop' }))
    expect(last().loops).toHaveLength(1)
  })

  it('puts a step into an existing loop', async () => {
    const { last } = renderPanel(selectStep('write'))
    await userEvent.selectOptions(screen.getByLabelText('Loop'), 'Loop 1 (2 steps)')
    await userEvent.click(screen.getByRole('button', { name: 'Add to loop' }))
    expect(last().loops[0]?.node_ids).toStrictEqual(['review', 'revise', 'write'])
  })
})

describe('read-only', () => {
  it('disables every arrow and loop setting', () => {
    renderPanel(selectLoop(0), { readOnly: true })
    const loop = screen.getByRole('region', { name: 'Loop 1' })
    expect(within(loop).getByLabelText('Until')).toBeDisabled()
    expect(within(loop).getByLabelText('Maximum rounds')).toBeDisabled()
    for (const box of within(loop).getAllByRole('checkbox')) expect(box).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Remove the loop' })).not.toBeInTheDocument()
  })

  it('shows a step\'s arrows without "Add arrow" or loop joining', () => {
    renderPanel(selectStep('final'), { readOnly: true })
    expect(screen.getByLabelText('Condition to Done')).toBeDisabled()
    expect(screen.queryByRole('group', { name: 'Add an arrow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add to loop' })).not.toBeInTheDocument()
  })
})

describe('workflow settings (nothing selected)', () => {
  it('edits the description and selects steps and loops from the outline', async () => {
    const { last } = renderPanel({ nodeIds: [], edgeIds: [], loopIndexes: [] })
    await userEvent.type(screen.getByLabelText('Description'), 'Hand-built')
    expect(last().description).toBe('Hand-built')
    await userEvent.clear(screen.getByLabelText('Description'))
    expect('description' in last()).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Loop 1: until personas agree, at most 3 rounds' }))
    expect(screen.getByRole('region', { name: 'Loop 1' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Workflow settings' }))
    await userEvent.click(screen.getByRole('button', { name: 'Configure step Final' }))
    expect(screen.getByLabelText('Title')).toHaveValue('Final')
  })
})
