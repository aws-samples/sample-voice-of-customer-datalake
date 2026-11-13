/**
 * @fileoverview The editor's panel with nothing selected: an engineering flow's monthly budget (set, changed,
 * cleared to none, the description kept), and none on an agents workflow.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { engineeringFlowView } from '@test/engineeringRunFixtures'
import { WorkflowDetails } from './WorkflowDetails'
import { emptyDefinition } from './model-fixtures'
import { workflowDefinitionSchema } from '../../api/workflowsApi'
import type { WorkflowDefinition } from '../../api/workflowsApi'

const flow: WorkflowDefinition = workflowDefinitionSchema.parse({ ...engineeringFlowView().workflow.definition, description: 'Fixes bugs' })

/** The panel over a definition it edits in place; `seen` gets every change. */
function Panel({ start, seen }: Readonly<{ start: WorkflowDefinition; seen: (definition: WorkflowDefinition) => void }>) {
  const [definition, setDefinition] = useState(start)
  return (
    <WorkflowDetails definition={definition} readOnly={false} onSelect={vi.fn()}
      onChange={(next) => { seen(next); setDefinition(next) }} />
  )
}

describe('WorkflowDetails — an engineering flow\'s monthly budget', () => {
  it('sets the budget typed, keeping the description', async () => {
    const user = userEvent.setup()
    const seen = vi.fn()
    render(<Panel start={flow} seen={seen} />)
    await user.type(screen.getByLabelText('Monthly budget (US dollars)'), '80')
    expect(seen).toHaveBeenLastCalledWith({ ...flow, budget: { monthly_usd: 80 } })
  })

  it('a field cleared saves the flow with no budget', async () => {
    const user = userEvent.setup()
    const seen = vi.fn()
    render(<Panel start={{ ...flow, budget: { monthly_usd: 50 } }} seen={seen} />)
    const field = screen.getByLabelText('Monthly budget (US dollars)')
    expect(field).toHaveValue(50)
    await user.clear(field)
    expect(seen).toHaveBeenLastCalledWith(flow)
  })

  it('a blank description keeps the budget', async () => {
    const user = userEvent.setup()
    const seen = vi.fn()
    render(<Panel start={{ ...flow, budget: { monthly_usd: 50 } }} seen={seen} />)
    await user.clear(screen.getByLabelText('Description'))
    const { schema, name, nodes, edges, loops } = flow
    expect(seen).toHaveBeenLastCalledWith({ schema, name, nodes, edges, loops, budget: { monthly_usd: 50 } })
  })

  it('an amount off the rule is marked at the field, which says the range', async () => {
    const user = userEvent.setup()
    render(<Panel start={flow} seen={vi.fn()} />)
    const field = screen.getByLabelText('Monthly budget (US dollars)')
    await user.type(field, '0')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter an amount in dollars and cents from $0.01 to $100,000, or leave it empty for none.')).toBeInTheDocument()
    await user.type(field, '.5')
    expect(field).not.toHaveAttribute('aria-invalid')
  })

  it('text that is no number keeps the field marked, never dropping the budget without a word', () => {
    const seen = vi.fn()
    render(<Panel start={{ ...flow, budget: { monthly_usd: 50 } }} seen={seen} />)
    const field = screen.getByLabelText('Monthly budget (US dollars)')
    // (a browser reports '' for "$80" in a number field, with validity.badInput set)
    Object.defineProperty(field, 'validity', { value: { badInput: true } })
    fireEvent.change(field, { target: { value: '' } })
    expect(seen).toHaveBeenLastCalledWith({ ...flow, budget: { monthly_usd: Number.NaN } })
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Enter an amount in dollars and cents from $0.01 to $100,000, or leave it empty for none.')
  })

  it('an agents workflow has no budget field', () => {
    render(<Panel start={emptyDefinition('Flow')} seen={vi.fn()} />)
    expect(screen.queryByLabelText('Monthly budget (US dollars)')).not.toBeInTheDocument()
  })
})
