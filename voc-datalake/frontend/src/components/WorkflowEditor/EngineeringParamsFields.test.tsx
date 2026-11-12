/**
 * @fileoverview An engineering flow's step settings (each writes the params the server's rules accept) and the
 * palette of each kind of workflow.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { settingsStep as step } from '@test/workflowFixtures'
import { ParamsFields } from './ParamsFields'
import { NodePalette } from './NodePalette'
import type { WorkflowNode } from '../../api/workflowsApi'

const renderStep = (type: WorkflowNode['type'], params: Record<string, unknown>) => {
  const onParams = vi.fn()
  render(<ParamsFields node={step(type, params)} readOnly={false} onParams={onParams} />)
  return onParams
}

describe('an agent step', () => {
  it('sets its role, its skill version and its share of the budget', async () => {
    const onParams = renderStep('agent', { role: 'fixer', skill_version: 'latest' })
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'committer')
    expect(onParams).toHaveBeenLastCalledWith({ role: 'committer', skill_version: 'latest' })
    fireEvent.change(screen.getByLabelText('Share of the run budget'), { target: { value: '0.4' } })
    expect(onParams).toHaveBeenLastCalledWith({ role: 'fixer', skill_version: 'latest', budget_share: 0.4 })
    fireEvent.change(screen.getByLabelText('Skill version'), { target: { value: 'v3' } })
    expect(onParams).toHaveBeenLastCalledWith({ role: 'fixer', skill_version: 'v3' })
  })

  it('a share typed key by key keeps what is typed (0, 0., 0.4) and stores 0.4', async () => {
    const onParams = renderStep('agent', { role: 'fixer' })
    const field = screen.getByLabelText('Share of the run budget')
    await userEvent.type(field, '0.4')
    expect(field).toHaveValue(0.4)
    expect(onParams).toHaveBeenLastCalledWith({ role: 'fixer', budget_share: 0.4 })
  })

  it('an agent with no role shows none chosen, not the first role', () => {
    renderStep('agent', {})
    expect(screen.getByLabelText('Role')).toHaveValue('')
    expect(screen.getByRole('option', { name: '—' })).toBeInTheDocument()
  })

  it('leaves out a setting cleared (the default applies)', () => {
    const onParams = renderStep('agent', { role: 'fixer', model: 'model-a', budget_share: 0.5 })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } })
    expect(onParams).toHaveBeenLastCalledWith({ role: 'fixer', budget_share: 0.5 })
    fireEvent.change(screen.getByLabelText('Share of the run budget'), { target: { value: '' } })
    expect(onParams).toHaveBeenLastCalledWith({ role: 'fixer', model: 'model-a' })
  })
})

describe('a map, a board and a memory step', () => {
  it('a map sets how it shards and its cap, within bounds', async () => {
    const onParams = renderStep('map', { shard_by: 'packages', shard_cap: 50 })
    await userEvent.selectOptions(screen.getByLabelText('Shard by'), 'history')
    expect(onParams).toHaveBeenLastCalledWith({ shard_by: 'history', shard_cap: 50 })
    fireEvent.change(screen.getByLabelText('Most shards'), { target: { value: '900' } })
    expect(onParams).toHaveBeenLastCalledWith({ shard_by: 'packages', shard_cap: 200 })
  })

  it('a board offers only the roles that post and the roles that claim', async () => {
    const onParams = renderStep('board', { posters: ['coordinator'], claimers: ['fixer'] })
    const posters = within(screen.getByRole('group', { name: 'Who posts tasks' }))
    expect(posters.getAllByRole('checkbox').map((box) => box.parentElement?.textContent)).toStrictEqual(['builder', 'coordinator', 'hunter'])
    await userEvent.click(posters.getByLabelText('hunter'))
    expect(onParams).toHaveBeenLastCalledWith({ posters: ['coordinator', 'hunter'], claimers: ['fixer'] })
    const claimers = within(screen.getByRole('group', { name: 'Who claims tasks' }))
    expect(claimers.queryByLabelText('coach')).toBeNull()
    await userEvent.click(claimers.getByLabelText('fixer'))
    expect(onParams).toHaveBeenLastCalledWith({ posters: ['coordinator'], claimers: [] })
  })

  it('a memory read sets its limit; a write has none', async () => {
    const onParams = renderStep('memory', { mode: 'read', scope: 'repo', limit: 10 })
    fireEvent.change(screen.getByLabelText('Most memories read'), { target: { value: '25' } })
    expect(onParams).toHaveBeenLastCalledWith({ mode: 'read', scope: 'repo', limit: 25 })
    await userEvent.selectOptions(screen.getByLabelText('Whose memory'), 'person')
    expect(onParams).toHaveBeenLastCalledWith({ mode: 'read', scope: 'person', limit: 10 })
  })

  it('a memory write shows no limit', () => {
    renderStep('memory', { mode: 'write', scope: 'repo' })
    expect(screen.queryByLabelText('Most memories read')).toBeNull()
  })
})

describe('a quality gate step', () => {
  it('detects its packs by default, or pins them', async () => {
    const onParams = renderStep('quality_gate', { max_rounds: 3, packs: 'auto' })
    expect(screen.queryByRole('group', { name: 'Gate packs' })).toBeNull()
    await userEvent.click(screen.getByLabelText('Detect the gate packs in the repository'))
    expect(onParams).toHaveBeenLastCalledWith({ max_rounds: 3, packs: ['java'] })
    fireEvent.change(screen.getByLabelText('Review rounds (most)'), { target: { value: '9' } })
    expect(onParams).toHaveBeenLastCalledWith({ max_rounds: 5, packs: 'auto' })
    fireEvent.change(screen.getByLabelText('Review rounds (most)'), { target: { value: '' } })
    expect(onParams).toHaveBeenLastCalledWith({ packs: 'auto' })
  })

  it('a pinned gate lists the packs to choose', async () => {
    const onParams = renderStep('quality_gate', { packs: ['java'] })
    await userEvent.click(within(screen.getByRole('group', { name: 'Gate packs' })).getByLabelText('rust-ts'))
    expect(onParams).toHaveBeenLastCalledWith({ packs: ['java', 'rust-ts'] })
  })

  it.each(['reduce', 'learning_loop', 'self_improvement', 'stop_at_pr'] as const)('%s has no settings', (type) => {
    const { container } = render(<ParamsFields node={step(type, {})} readOnly={false} onParams={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the palette of each kind', () => {
  it('an engineering flow offers Start, End and the engineering steps only', () => {
    render(<NodePalette onAdd={vi.fn()} schema="voc-workflow/2" />)
    expect(screen.getByText('Engineering')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop at PR' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /PRD/ })).toBeNull()
  })

  it('an agents workflow offers no engineering step', () => {
    render(<NodePalette onAdd={vi.fn()} schema="voc-workflow/1" />)
    expect(screen.queryByText('Engineering')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop at PR' })).toBeNull()
  })
})
