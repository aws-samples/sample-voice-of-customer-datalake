/**
 * @fileoverview A step's view in the run workspace's inspector (7.52.00 C2, owner decision N-D3), against the shared
 * fixture: a step clicked on the run's canvas opens it in place of the agent's tabs. A team's step lists its agents
 * (each lane's state, what it cost and what ran, Open its session, which goes back to the agent's tabs); a gate's
 * step its gate runner's gate (the round, why it stopped, the final go, the tools recorded, then its checks), and its
 * reviewers; a step no agent has run says so; Close inspector goes back too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { adminFlag, resetFetchApi, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { AGENT, RUN_PATH, endpointOf, renderWorkspace, workspaceRoutes } from '@test/runWorkspaceHarness'
import fixture from '@test/engineeringRunWorkspace.json'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.authStoreWithOriginal(importOriginal)))

stubResizeObserverForSuite()

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  workspaceRoutes()
})

afterEach(() => { window.sessionStorage.clear() })

const inspector = async () => within(await screen.findByRole('region', { name: 'Inspector' }))

/** The workspace at the run, the step `id` clicked on its canvas (a click: d3-zoom's mousedown needs a real window). */
async function openStep(id: string, path = RUN_PATH) {
  const router = renderWorkspace(path)
  fireEvent.click(await screen.findByTestId(`step-${id}`))
  return { router, view: await inspector() }
}

describe('a team\'s step', () => {
  it('lists its agents: each lane\'s state, what it cost and what ran, and opens a session from it', async () => {
    const { router, view } = await openStep('board')
    const row = within(await view.findByRole('list', { name: 'The step\'s agents' })).getByText(AGENT).closest('li')
    expect(row).toHaveTextContent(/^fixer-3At work\$0\.94Ran fixer@v3 · model-medium/)
    await userEvent.click(within(row ?? document.body).getByRole('button', { name: 'Open its session' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe(`${RUN_PATH}/a/${AGENT}`) })
    expect(await view.findByRole('heading', { name: `Inspector: ${AGENT}` })).toBeInTheDocument()
  })

  it('goes back to the agent\'s tabs on Close inspector', async () => {
    const { view } = await openStep('board')
    await userEvent.click(view.getByRole('button', { name: 'Close inspector' }))
    expect(await view.findByRole('tablist', { name: 'What to inspect' })).toBeInTheDocument()
  })
})

describe('a gate\'s step', () => {
  it('shows its gate runner\'s gate: the round, why it stopped, the final go and the tools recorded, then its checks', async () => {
    workspaceRoutes({
      [`GET ${endpointOf(fixture.gate)}`]: () => ({
        ...fixture.gate.answer, stop: { code: 'review_blocked', text_key: null, recorded: 'blocked by review' },
        final_go: { verdict: 'NO-GO', agent: 'final-go-5', model_id: null, reasons: ['a finding left open'] },
      }),
    })
    const { view } = await openStep('gate')
    expect(await view.findByText('Round 1')).toBeInTheDocument()
    expect(view.getByText('A review blocked it: the final go said NO-GO.')).toBeInTheDocument()
    expect(view.getByText('Final go: NO-GO a finding left open')).toHaveClass('text-danger')
    expect(view.getByText('The repository\'s own pins. Last recorded: python Python 3.14.0')).toBeInTheDocument()
  })

  it('lists its reviewers, each blocking or advisory', async () => {
    const { view } = await openStep('gate')
    await userEvent.click(view.getByRole('tab', { name: 'Reviewers' }))
    expect(view.getByText('security').nextElementSibling).toHaveTextContent('blocks')
  })
})

describe('a step no agent has run', () => {
  const NO_LANES = { ...fixture.overview.answer, lanes: {} }

  it('says a team\'s step has not run, nor a gate\'s', async () => {
    workspaceRoutes({ [`GET ${RUN_PATH}`]: () => NO_LANES })
    const { view } = await openStep('board')
    expect(view.getByText('Not run yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('step-gate'))
    expect(await view.findByText('The gate hasn\'t run yet.')).toBeInTheDocument()
  })
})
