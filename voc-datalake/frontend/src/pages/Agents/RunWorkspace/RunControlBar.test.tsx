/**
 * @fileoverview The run's control bar against the shared fixture (7.51.00, the UX audit's S8/S9): Stop is the run's
 * Stop (7.50.03, `POST …/stop`, never a signal: a checkpoint, then the end) and reads Stopping… with Stop inert and
 * what each agent did; "Stop now, without saving" is in Stop's menu, asked first, and sent confirmed; Pause and Resume
 * are one toggle by the agents' state; the run's status chip is toned; an agent and the run say Stop alike.
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
const STOP = `${RUN_PATH}/stop`
const stopped = { signal: { event_id: 'e', signal: 'resume', agents: { 'fixer-3': 'working' }, applied: { 'fixer-3': true } } }
const saving = { stop: { status: 'stopping', mode: 'stop', tasks_closed: [], saving: ['fixer-3'] } }

function withSignals(answer: RouteHandler = () => stopped, overview: unknown = fixture.overview.answer, stop: RouteHandler = () => saving) {
  workspaceRoutes({ [`GET ${RUN_PATH}`]: () => overview, [`POST ${SIGNALS}`]: answer, [`POST ${STOP}`]: stop })
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('the run control bar', () => {
  it('shows the run\'s status in its tone, and Stop, Pause and More run controls', async () => {
    withSignals()
    renderWorkspace(RUN_PATH)
    expect(await screen.findByText('Active')).toHaveClass('badge-accent')
    expect([screen.getByRole('button', { name: 'Pause' }), screen.getByRole('button', { name: 'More ways to stop' }),
      screen.getByRole('button', { name: 'More run controls' })]).toHaveLength(3)
  })

  it('stops the run through its Stop (a checkpoint first), then reads Stopping… with Stop inert and what each agent did', async () => {
    const run = { stopping: false }
    const overview = fixture.overview.answer
    workspaceRoutes({
      [`GET ${RUN_PATH}`]: () => (run.stopping ? { ...overview, run: { ...overview.run, stop: { mode: 'stop', requested_at: '2026-11-17T09:30:00Z' } },
        agents: overview.agents.map((agent) => (agent.agent === 'fixer-3' ? { ...agent, status: 'pause_requested' } : agent)) } : overview),
      [`POST ${STOP}`]: () => {
        run.stopping = true
        return saving
      },
    })
    renderWorkspace(RUN_PATH)
    const bar = within(await screen.findByRole('region', { name: 'Run controls' }))
    await userEvent.click(bar.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(sentFetchApiBody(STOP, 'POST')).toStrictEqual({}))
    expect(await bar.findByText('Stopping…')).toHaveClass('badge-warn')
    expect(bar.getByRole('button', { name: 'Stop' })).toHaveAttribute('aria-disabled', 'true')
    // What the Stop said, and each agent's part of it, both announced; Pause is gone while it stops.
    expect([bar.getByText('Stop sent: fixer-3 saving a checkpoint, then the run stops.').getAttribute('role'),
      bar.getByText(/^Stop sent · .*fixer-3 saving a checkpoint…/).getAttribute('role'),
      bar.queryByRole('button', { name: 'Pause' })]).toStrictEqual(['status', 'status', null])
  })

  it('keeps "Stop now, without saving" in Stop\'s menu, asks before it, and sends it confirmed as the run\'s Stop', async () => {
    const signal = vi.fn((_body: unknown) => stopped)
    const stop = vi.fn((_body: unknown) => ({ stop: { status: 'stopped', mode: 'stop_now', tasks_closed: ['task-fix'] } }))
    withSignals(signal, undefined, stop)
    renderWorkspace(RUN_PATH)
    await userEvent.click(await screen.findByRole('button', { name: 'More ways to stop' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Stop now, without saving…' }))
    expect(stop).not.toHaveBeenCalled()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop now, without saving' }))
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ now: true, confirm: true }))
    expect([await screen.findByText('Stopped. 1 open task was closed.'), signal.mock.calls]).toStrictEqual([expect.anything(), []])
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
