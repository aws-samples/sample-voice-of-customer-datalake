/**
 * @fileoverview The Run now confirmation names the workflow by its name: a
 * placeholder while the workflow loads, the id only when it cannot be read;
 * and (7.58.00) an engineering agent's run takes one model for every role, or
 * each role's own, with "Other model…" typed and checked before it starts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { normalizeAgent } from '../../api/agentsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { RunNowConfirm } = await import('./RunNowConfirm')

/** Through the real boundary normaliser: every omitted field takes its lenient default. */
const AGENT = normalizeAgent({ agent_id: 'ag_1', name: 'Scout', workflow_id: 'wf_1' })

const FLOW = workflowView(1, { schema: 'voc-workflow/1', name: 'Flow', nodes: [], edges: [], loops: [] })

function renderConfirm(): void {
  if (AGENT === null) throw new Error('fixture agent did not normalise')
  renderWithQueryClient(<RunNowConfirm agent={AGENT} starting={false} onConfirm={vi.fn()} onCancel={vi.fn()} />)
}

describe('RunNowConfirm', () => {
  beforeEach(() => { resetFetchApi() })

  it('names the workflow once it loads, never its id', async () => {
    routeFetchApi({ 'GET /workflows/wf_1': () => FLOW })
    renderConfirm()
    expect(screen.getByText('…')).toBeInTheDocument()
    expect(await screen.findByText('Flow')).toBeInTheDocument()
    expect(screen.queryByText('wf_1')).not.toBeInTheDocument()
  })

  it('falls back to the id when the workflow cannot be read', async () => {
    routeFetchApi({}, { missStatus: 500 })
    renderConfirm()
    expect(await screen.findByText('wf_1')).toBeInTheDocument()
  })
})

describe('RunNowConfirm: the model for this run (7.58.00)', () => {
  const ENGINEERING = normalizeAgent({ agent_id: 'ag_2', name: 'Bug fixer', workflow_id: 'wf_1',
    engineering: { connection: 'storefront', language: 'python', feedback_type: 'bug' } })

  function renderEngineering(onConfirm = vi.fn()) {
    if (ENGINEERING === null) throw new Error('fixture agent did not normalise')
    renderWithQueryClient(<RunNowConfirm agent={ENGINEERING} starting={false} onConfirm={onConfirm} onCancel={vi.fn()} />)
    return onConfirm
  }

  beforeEach(() => {
    resetFetchApi()
    routeFetchApi({ 'GET /workflows/wf_1': () => FLOW })
  })

  it('offers each role\'s own model first, then Auto (Kiro only), the three 5.5 models and Other model…', () => {
    renderEngineering()
    const select = screen.getByLabelText('Model for this run')
    expect(select).toHaveValue('')
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toStrictEqual([
      "Each role's own model", 'Auto (Kiro only)', 'Opus 5.5 (Kiro and native)', 'Sonnet 5.5 (Kiro and native)',
      'Haiku 5.5 (Kiro and native)', 'Other model…'])
    expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument()
  })

  it('sends nothing of the model for each role\'s own, and the named model chosen', async () => {
    const user = userEvent.setup()
    const onConfirm = renderEngineering()
    await user.click(screen.getByRole('button', { name: 'Start run' }))
    expect(onConfirm).toHaveBeenLastCalledWith(undefined)
    await user.selectOptions(screen.getByLabelText('Model for this run'), 'opus')
    expect(screen.getByText(/claude-opus-5\.5 on Kiro, global\.anthropic\.claude-opus-5-5 on the native harness/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start run' }))
    expect(onConfirm).toHaveBeenLastCalledWith({ model: 'opus' })
  })

  it('sends Auto with the issue, saying Kiro chooses per task', async () => {
    const user = userEvent.setup()
    const onConfirm = renderEngineering()
    await user.type(screen.getByLabelText('Issue number (optional)'), '7')
    await user.selectOptions(screen.getByLabelText('Model for this run'), 'auto')
    expect(screen.getByText(/Kiro chooses the model per task/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start run' }))
    expect(onConfirm).toHaveBeenLastCalledWith({ issue: 7, model: 'auto' })
  })

  it('holds the start while Other model… has no id, or one off its shape', async () => {
    const user = userEvent.setup()
    renderEngineering()
    await user.selectOptions(screen.getByLabelText('Model for this run'), 'other')
    expect(screen.getByText('Type a model ID.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled()
    await user.type(screen.getByLabelText('Model ID'), 'https://example.com/model')
    expect(screen.getByLabelText('Model ID')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled()
  })

  it('sends a typed id trimmed, and hides the field once another model is picked', async () => {
    const user = userEvent.setup()
    const onConfirm = renderEngineering()
    await user.selectOptions(screen.getByLabelText('Model for this run'), 'other')
    await user.type(screen.getByLabelText('Model ID'), ' claude-sonnet-5.5 ')
    expect(screen.getByText(/for roles on Kiro, a Kiro model ID/i)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start run' }))
    expect(onConfirm).toHaveBeenLastCalledWith({ model: 'claude-sonnet-5.5' })
    await user.selectOptions(screen.getByLabelText('Model for this run'), '')
    expect(screen.queryByLabelText('Model ID')).not.toBeInTheDocument()
  })

  it('asks no model of an agent that is not an engineering one', () => {
    renderConfirm()
    expect(screen.queryByLabelText('Model for this run')).not.toBeInTheDocument()
  })
})
