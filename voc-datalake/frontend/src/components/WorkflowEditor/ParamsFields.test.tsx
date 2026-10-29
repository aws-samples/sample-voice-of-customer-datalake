/**
 * @fileoverview The per-step settings: the web-search switch (research and custom steps
 * search the public web unless switched off, and the hint names the per-run cap), the
 * persona portraits switch (on unless off, as the product generates them), and a writing
 * step's word budget.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ParamsFields } from './ParamsFields'
import type { WorkflowNode } from '../../api/workflowsApi'

const step = (type: WorkflowNode['type'], params: Record<string, unknown>): WorkflowNode =>
  ({ id: 's1', type, position: { x: 0, y: 0 }, data: { title: 'Step', params } })

describe('ParamsFields web search', () => {
  it.each(['deep_research', 'custom_llm'] as const)('%s searches the web when the param is absent', (type) => {
    render(<ParamsFields node={step(type, {})} readOnly={false} onParams={vi.fn()} />)
    expect(screen.getByRole('checkbox')).toBeChecked()
  })

  it('an explicit false shows the switch off', () => {
    render(<ParamsFields node={step('custom_llm', { use_web_search: false })} readOnly={false} onParams={vi.fn()} />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('switching off stores false and keeps the other params', async () => {
    const onParams = vi.fn()
    render(<ParamsFields node={step('custom_llm', { other: 1 })} readOnly={false} onParams={onParams} />)
    await userEvent.click(screen.getByRole('checkbox'))
    expect(onParams).toHaveBeenCalledWith({ other: 1, use_web_search: false })
  })

  it('the hint names the run cap', () => {
    render(<ParamsFields node={step('deep_research', {})} readOnly={false} onParams={vi.fn()} />)
    expect(screen.getByText(/10/)).toBeInTheDocument()
  })
})

describe('ParamsFields persona portraits', () => {
  it('a generate step makes portraits when the param is absent (the product default)', () => {
    render(<ParamsFields node={step('generate_personas', {})} readOnly={false} onParams={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'Create a portrait for each persona' })).toBeChecked()
  })

  it('switching portraits off stores false and keeps the count', async () => {
    const onParams = vi.fn()
    render(<ParamsFields node={step('generate_personas', { max_new: 2 })} readOnly={false} onParams={onParams} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Create a portrait for each persona' }))
    expect(onParams).toHaveBeenCalledWith({ max_new: 2, generate_avatars: false })
  })
})

describe('ParamsFields word budget', () => {
  it.each(['write_prfaq', 'write_prd', 'revise_document'] as const)('%s offers a word budget, empty by default', (type) => {
    render(<ParamsFields node={step(type, {})} readOnly={false} onParams={vi.fn()} />)
    expect(screen.getByRole('spinbutton', { name: 'Length budget (words)' })).toHaveValue(null)
  })

  it.each([['1200', 1200], ['99999', 8000], ['-5', undefined]])('typing %s stores %s', (typed, stored) => {
    const onParams = vi.fn()
    render(<ParamsFields node={step('write_prfaq', {})} readOnly={false} onParams={onParams} />)
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Length budget (words)' }), { target: { value: typed } })
    expect(onParams).toHaveBeenLastCalledWith(stored === undefined ? {} : { max_words: stored })
  })

  it('clearing the budget removes the param', async () => {
    const onParams = vi.fn()
    render(<ParamsFields node={step('write_prd', { max_words: 900 })} readOnly={false} onParams={onParams} />)
    await userEvent.clear(screen.getByRole('spinbutton', { name: 'Length budget (words)' }))
    expect(onParams).toHaveBeenLastCalledWith({})
  })

  it('a review step has no word budget', () => {
    render(<ParamsFields node={step('persona_review', { target: 'prfaq' })} readOnly={false} onParams={vi.fn()} />)
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  })
})
