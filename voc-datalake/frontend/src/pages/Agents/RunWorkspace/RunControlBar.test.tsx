/**
 * @fileoverview The run's control bar against the shared fixture (7.51.00, the UX audit's S8/S9): Stop sends the
 * shutdown (a checkpoint, then the end) and reads Stopping… with Stop inert and what each agent did; "Stop now,
 * without saving" is in Stop's menu and asked first; Pause and Resume are one toggle by the agents' state; the
 * run's status chip is toned; an agent and the run say Stop alike.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { adminFlag, resetFetchApi, sentFetchApiBody, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { RUN_PATH, renderWorkspace, workspaceRoutes } from '@test/runWorkspaceHarness'
import fixture from '@test/engineeringRunWorkspace.json'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

stubResizeObserverForSuite()

const SIGNALS = `${RUN_PATH}/signals`
const stopped = { signal: { event_id: 'e', signal: 'shutdown', agents: { 'fixer-3': 'stopped' }, applied: { 'fixer-3': true } } }

function withSignals(answer: RouteHandler = () => stopped, overview: unknown = fixture.overview.answer) {
  workspaceRoutes({ [`GET ${RUN_PATH}`]: () => overview, [`POST ${SIGNALS}`]: answer })
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('the run control bar', () => {
  it('shows the run\'s status in its tone, and Stop, Pause and More actions', async () => {
    withSignals()
    renderWorkspace(RUN_PATH)
    expect(await screen.findByText('Active')).toHaveClass('badge-accent')
    expect([screen.getByRole('button', { name: 'Pause' }), screen.getByRole('button', { name: 'More ways to stop' }),
      screen.getByRole('button', { name: 'More actions' })]).toHaveLength(3)
  })

  it('stops the run with a checkpoint first, then reads Stopping… with Stop inert and what each agent did', async () => {
    withSignals()
    renderWorkspace(RUN_PATH)
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(sentFetchApiBody(SIGNALS, 'POST')).toStrictEqual({ signal: 'shutdown' }))
    expect(await screen.findByText('Stopping…')).toHaveClass('badge-warn')
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Stop sent · fixer-3: Stopped')).toHaveAttribute('role', 'status')
  })

  it('keeps "Stop now, without saving" in Stop\'s menu, and asks before it', async () => {
    const signal = vi.fn((_body: unknown) => stopped)
    withSignals(signal)
    renderWorkspace(RUN_PATH)
    await userEvent.click(await screen.findByRole('button', { name: 'More ways to stop' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Stop now, without saving…' }))
    expect(signal).not.toHaveBeenCalled()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop now, without saving' }))
    await waitFor(() => expect(signal).toHaveBeenCalledWith({ signal: 'stop_now', confirm: true }))
  })

  it('offers Resume, not Pause, once every agent at work is paused', async () => {
    const paused = { ...fixture.overview.answer, agents: fixture.overview.answer.agents.map((agent) => ({ ...agent, status: agent.status === 'done' ? 'done' : 'paused' })) }
    withSignals(() => stopped, paused)
    renderWorkspace(RUN_PATH)
    await userEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(sentFetchApiBody(SIGNALS, 'POST')).toStrictEqual({ signal: 'resume' }))
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  })

  it('uses the run\'s word for an agent\'s Stop, its other moves under ⋯', async () => {
    withSignals()
    renderWorkspace(`${RUN_PATH}/a/${fixture.agent}`)
    const agent = within(await screen.findByRole('group', { name: `Agent ${fixture.agent}` }))
    await userEvent.click(agent.getByRole('button', { name: `More for ${fixture.agent}` }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual(['Save a checkpoint', 'Stop now, without saving…', 'Restart…'])
    expect(agent.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })
})
