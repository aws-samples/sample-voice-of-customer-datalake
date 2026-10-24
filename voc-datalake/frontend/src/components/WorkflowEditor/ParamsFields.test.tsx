/**
 * @fileoverview The per-step web-search switch: research and custom steps search
 * the public web unless switched off (absent = on, as the runtime reads it), and
 * the hint names the per-run cap.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
