/**
 * Plan progress in the bubble: the block appears under an approved
 * propose_plan, shows each step's status, polls while the plan runs and stops
 * once it ends, resolves a step that needs approval inline, and cancels.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const fetchApiDoubles = await vi.hoisted(async () => import('@test/fetchApiRoutes'))
vi.mock('../../api/client', fetchApiDoubles.clientWithMockedFetchApi)

import { render } from '@test/test-utils'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { createThreadState } from '../thread/reducer'
import MessageList from '../components/MessageList'
import PlanProgress from './PlanProgress'
import { PLAN_POLL_MS } from './usePlanProgress'
import type { Message } from '@ag-ui/core'

const ID = 'pl_a1b2c3d4e5f6'
const step = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `Step ${id}`, pack: 'project', kind: 'write', after: [], status, outputs: {}, ...extra })
const view = (status: string, steps: unknown[], extra: Record<string, unknown> = {}) =>
  ({ plan: { plan_id: ID, status, goal: 'Acme plan', created_at: '', updated_at: '', steps, ...extra } })

const SEEN = 'c'.repeat(64)
const PENDING = { tool: 'generate_personas', args: { project_id: 'proj_1', persona_count: 5 }, reason: 'The arguments differ from the approved plan.', fingerprint: SEEN }
const RUNNING = view('running', [step('s1', 'done', { outputs: { project_id: 'proj_1' } }), step('s2', 'needs_approval', { pending: PENDING })])
const gets = () => fetchApi.mock.calls.filter(([path, options]) => path === `/agents/plans/${ID}` && options?.method === undefined).length

beforeEach(() => {
  resetFetchApi()
  return stubElementScrollIntoView()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('PlanProgress', () => {
  it('lists the steps with their statuses', async () => {
    routeFetchApi({ [`GET /agents/plans/${ID}`]: () => RUNNING })
    render(<PlanProgress planId={ID} onOpen={() => {}} />)
    const first = await screen.findByTestId('plan-progress-step-s1')
    expect(within(first).getByText('Done')).toBeInTheDocument()
    expect(within(first).getByText('proj_1')).toBeInTheDocument()
    expect(within(screen.getByTestId('plan-progress-step-s2')).getByText('Needs approval')).toBeInTheDocument()
  })

  it('polls every 5 s while the plan runs and stops once it has ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const answers = [RUNNING, view('completed', [step('s1', 'done')], { summary: 'Every step finished.' })]
    routeFetchApi({ [`GET /agents/plans/${ID}`]: () => answers.shift() ?? answers.at(-1) ?? RUNNING })
    render(<PlanProgress planId={ID} onOpen={() => {}} />)
    await screen.findByText('Needs approval')
    await act(async () => { await vi.advanceTimersByTimeAsync(PLAN_POLL_MS) })
    await screen.findByText('Every step finished.')
    await act(async () => { await vi.advanceTimersByTimeAsync(PLAN_POLL_MS * 3) })
    expect(gets()).toBe(2)
  })

  it('shows what a step that needs approval would write and approves exactly that write', async () => {
    const approved = view('running', [step('s1', 'done'), step('s2', 'running')])
    const sent: unknown[] = []
    routeFetchApi({ [`GET /agents/plans/${ID}`]: () => RUNNING, [`POST /agents/plans/${ID}/steps/s2/approve`]: (body) => { sent.push(body); return approved } })
    render(<PlanProgress planId={ID} onOpen={() => {}} />)
    const approval = await screen.findByTestId('plan-step-approval')
    expect(within(approval).getByTestId('field-persona_count')).toHaveTextContent('5')
    await userEvent.click(within(approval).getByRole('button', { name: 'Approve step' }))
    await waitFor(() => expect(screen.getByTestId('plan-progress-step-s2')).toHaveAttribute('data-status', 'running'))
    expect(sent).toStrictEqual([{ fingerprint: SEEN }])
  })

  it('a stale card is refused and the plan reloads with the write that replaced it', async () => {
    const changed = { ...PENDING, args: { project_id: 'proj_1', persona_count: 9 }, fingerprint: 'd'.repeat(64) }
    const answers = [RUNNING, view('running', [step('s1', 'done'), step('s2', 'needs_approval', { pending: changed })])]
    routeFetchApi({
      [`GET /agents/plans/${ID}`]: () => answers.shift() ?? answers.at(-1) ?? RUNNING,
      [`POST /agents/plans/${ID}/steps/s2/approve`]: () => { throw new Error('API Error: 409') },
    })
    render(<PlanProgress planId={ID} onOpen={() => {}} />)
    await userEvent.click(within(await screen.findByTestId('plan-step-approval')).getByRole('button', { name: 'Approve step' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('field-persona_count')).toHaveTextContent('9'))
  })

  it('offers only Decline for a paused write without a fingerprint', async () => {
    const unsigned = view('running', [step('s2', 'needs_approval', { pending: { ...PENDING, fingerprint: undefined } })])
    routeFetchApi({ [`GET /agents/plans/${ID}`]: () => unsigned })
    render(<PlanProgress planId={ID} onOpen={() => {}} />)
    const approval = await screen.findByTestId('plan-step-approval')
    expect(within(approval).getByRole('button', { name: 'Approve step' })).toBeDisabled()
    expect(within(approval).getByRole('button', { name: 'Decline step' })).toBeEnabled()
  })

  it('declines a step that needs approval', async () => {
    const declined = view('completed_with_errors', [step('s1', 'done'), step('s2', 'failed', { error: 'Declined by the approver.' })])
    routeFetchApi({ [`GET /agents/plans/${ID}`]: () => RUNNING, [`POST /agents/plans/${ID}/steps/s2/decline`]: () => declined })
    render(<PlanProgress planId={ID} onOpen={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Decline step' }))
    expect(await screen.findByText('Declined by the approver.')).toBeInTheDocument()
  })

  it('Cancel stops the plan; an ended plan offers its project instead', async () => {
    const cancelled = view('cancelled', [step('s1', 'done', { outputs: { project_id: 'proj_1' } }), step('s2', 'cancelled')])
    routeFetchApi({ [`GET /agents/plans/${ID}`]: () => RUNNING, [`POST /agents/plans/${ID}/cancel`]: () => cancelled })
    render(<PlanProgress planId={ID} onOpen={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel plan' }))
    expect(await screen.findByRole('link', { name: 'Open the project' })).toHaveAttribute('href', '/projects/proj_1')
    expect(screen.queryByRole('button', { name: 'Cancel plan' })).not.toBeInTheDocument()
  })
})

describe('the bubble', () => {
  const outcome = (status: string) => JSON.stringify(status === 'executed'
    ? { status, summary: 'ok', data: { plan_id: ID } }
    : { status, reason: 'no' })
  const thread = (status: string) => {
    const messages: Message[] = [{ id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'propose_plan', arguments: '{}' } }] }]
    return { ...createThreadState('t1'), messages, toolResults: { c1: outcome(status) } }
  }

  it('shows the plan progress under an approved propose_plan', async () => {
    routeFetchApi({ [`GET /agents/plans/${ID}`]: () => RUNNING })
    render(<MessageList thread={thread('executed')} page={{ kind: 'home', path: '/' }} />)
    expect(await screen.findByTestId('plan-progress')).toHaveAttribute('data-plan-id', ID)
  })

  it('shows nothing for a declined proposal', () => {
    render(<MessageList thread={thread('declined')} page={{ kind: 'home', path: '/' }} />)
    expect(screen.queryByTestId('plan-progress')).not.toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })
})

describe('PlanProgress \u2014 analysis results', () => {
  const think = (outputs: Record<string, string>) => step('s1', 'done', { kind: 'think', pack: 'insights', outputs })
  const renderWith = async (outputs: Record<string, string>) => {
    routeFetchApi({ [`GET /agents/plans/${ID}`]: () => view('completed', [think(outputs)]) })
    render(<PlanProgress planId={ID} onOpen={() => {}} />)
    return within(await screen.findByTestId('plan-progress-step-s1'))
  }

  it('shows a done analysis step\u2019s result as markdown', async () => {
    const row = await renderWith({ summary: '## Top problems\n\n1. **Late refunds** (12 reviews)' })
    expect(row.getByRole('heading', { name: 'Top problems' })).toBeInTheDocument()
    expect(row.getByText('Late refunds').tagName).toBe('STRONG')
    expect(row.queryByText('summary')).not.toBeInTheDocument()
  })

  it('collapses a long result behind a toggle', async () => {
    const row = await renderWith({ summary: `Refunds are late. ${'More detail. '.repeat(60)}` })
    const toggle = row.getByRole('button', { name: 'Show the full result' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(row.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('says so when a done analysis step stored no result', async () => {
    const row = await renderWith({})
    expect(row.getByTestId('plan-step-no-result')).toHaveTextContent('This step finished without storing a result.')
  })
})
