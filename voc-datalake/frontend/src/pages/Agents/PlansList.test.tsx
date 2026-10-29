/**
 * The Plans list on the Agents page: the caller's plans with their status,
 * an empty state, and opening a plan shows its live progress.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { PlansList } = await import('./PlansList')

const ID = 'pl_a1b2c3d4e5f6'
const SUMMARY = { plan_id: ID, status: 'running', goal: 'Acme: personas and a PR/FAQ', created_at: '2026-10-14T10:00:00Z', updated_at: '' }
const VIEW = { plan: { ...SUMMARY, steps: [{ id: 's1', title: 'Create the project', pack: 'core', kind: 'write', status: 'running', outputs: {} }] } }

beforeEach(() => {
  resetFetchApi()
})

describe('PlansList', () => {
  it('lists the caller\u2019s plans with their status', async () => {
    routeFetchApi({ 'GET /agents/plans?limit=20': () => ({ plans: [SUMMARY] }) })
    render(<PlansList />)
    const row = await screen.findByTestId(`plan-row-${ID}`)
    expect(within(row).getByText('Acme: personas and a PR/FAQ')).toBeInTheDocument()
    expect(within(row).getByText('Running')).toBeInTheDocument()
  })

  it('says how to start one when there are none', async () => {
    routeFetchApi({ 'GET /agents/plans?limit=20': () => ({ plans: [] }) })
    render(<PlansList />)
    expect(await screen.findByText(/No plans yet/)).toBeInTheDocument()
  })

  it('opening a plan shows its steps', async () => {
    routeFetchApi({ 'GET /agents/plans?limit=20': () => ({ plans: [SUMMARY] }), [`GET /agents/plans/${ID}`]: () => VIEW })
    render(<PlansList />)
    const toggle = await screen.findByRole('button', { name: /Acme: personas/ })
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByTestId('plan-progress-step-s1')).toHaveTextContent('Create the project')
  })
})

describe('PlansList — results', () => {
  it('an opened plan shows each analysis step\u2019s result', async () => {
    const think = { id: 's1', title: 'Summarise complaints', pack: 'insights', kind: 'think', status: 'done', outputs: { summary: 'Refunds are **late**.' } }
    const done = { ...SUMMARY, status: 'completed' }
    routeFetchApi({ 'GET /agents/plans?limit=20': () => ({ plans: [done] }), [`GET /agents/plans/${ID}`]: () => ({ plan: { ...done, steps: [think] } }) })
    render(<PlansList />)
    await userEvent.click(await screen.findByRole('button', { name: /^Acme: personas/ }))
    expect(await screen.findByTestId('plan-step-result')).toHaveTextContent('Refunds are late.')
  })
})

describe('PlansList — Delete', () => {
  const DONE = { ...SUMMARY, plan_id: 'pl_f0e1d2c3b4a5', status: 'cancelled', goal: 'Acme: summarise complaints' }
  const DELETE_PATH = `DELETE /agents/plans/${DONE.plan_id}`
  const DELETE_BUTTON = { name: 'Delete the plan “Acme: summarise complaints”' }

  it('offers Delete only on a finished plan', async () => {
    routeFetchApi({ 'GET /agents/plans?limit=20': () => ({ plans: [SUMMARY, DONE] }) })
    render(<PlansList />)
    expect(await screen.findByRole('button', DELETE_BUTTON)).toBeEnabled()
    expect(screen.queryByRole('button', { name: /Delete the plan “Acme: personas/ })).not.toBeInTheDocument()
  })

  it('deletes after the confirmation and refreshes the list', async () => {
    const plans = { current: [SUMMARY, DONE] }
    const remove = vi.fn(() => {
      plans.current = [SUMMARY]
      return { plan: { ...DONE, steps: [] } }
    })
    routeFetchApi({ 'GET /agents/plans?limit=20': () => ({ plans: plans.current }), [DELETE_PATH]: remove })
    render(<PlansList />)
    await userEvent.click(await screen.findByRole('button', DELETE_BUTTON))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('“Acme: summarise complaints” will be removed from your plans.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId(`plan-row-${ID}`)).toBeInTheDocument()
    await vi.waitFor(() => expect(screen.queryByTestId(`plan-row-${DONE.plan_id}`)).not.toBeInTheDocument())
  })

  it('a finished plan\u2019s Delete button stays the same node while a running plan polls the list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      routeFetchApi({ 'GET /agents/plans?limit=20': () => ({ plans: [SUMMARY, DONE] }) })
      render(<PlansList />)
      const button = await screen.findByRole('button', DELETE_BUTTON)
      await act(() => vi.advanceTimersByTimeAsync(31_000))
      expect(button.isConnected).toBe(true)
      expect(screen.getByRole('button', DELETE_BUTTON)).toBe(button)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the plan when the confirmation is cancelled', async () => {
    const remove = vi.fn()
    routeFetchApi({ 'GET /agents/plans?limit=20': () => ({ plans: [DONE] }), [DELETE_PATH]: remove })
    render(<PlansList />)
    await userEvent.click(await screen.findByRole('button', DELETE_BUTTON))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByTestId(`plan-row-${DONE.plan_id}`)).toBeInTheDocument()
  })

  it('says so when the delete fails, and the plan stays', async () => {
    routeFetchApi({
      'GET /agents/plans?limit=20': () => ({ plans: [DONE] }),
      [DELETE_PATH]: () => { throw new Error('API Error: 409') },
    })
    render(<PlansList />)
    await userEvent.click(await screen.findByRole('button', DELETE_BUTTON))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The plan couldn’t be deleted.')
    expect(screen.getByTestId(`plan-row-${DONE.plan_id}`)).toBeInTheDocument()
  })
})
