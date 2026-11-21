/**
 * Insights → Leadership (7.70.00): the scope's admins read the view (counts, the estimate labelled with its
 * assumptions beside it), everyone else is told it is for administrators; an admin sets the baselines in the
 * assumptions drawer; a platform admin outside a workspace is pointed to the platform's cost estimate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', async (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.clientWithMockedFetchApi(importOriginal)))
const groups = vi.hoisted(() => ({ admin: true, platform: false }))
vi.mock('../../store/authStore', () => ({ useIsAdmin: () => groups.admin, useIsPlatformAdmin: () => groups.platform }))

import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { ACME, JUNIPER } from '@test/workspaceFixtures'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import Leadership from './Leadership'
import { leadershipView } from './leadership-fixtures'

const SETTINGS = { baselines: leadershipView().time_saved.baselines, defaults: {}, note: null, updated_at: null,
  max_hours: 200, max_note_chars: 500 }

function serve() {
  routeFetchApi({
    'GET /metrics/adoption': () => leadershipView(),
    'PUT /settings/adoption': () => SETTINGS,
  }, { ignoreQuery: true })
}

const render = () => renderWithQueryClient(<TestRouter><Leadership /></TestRouter>)

beforeEach(() => {
  resetFetchApi()
  setCurrentWorkspace(null)
  Object.assign(groups, { admin: true, platform: false })
  serve()
})

describe('Leadership', () => {
  it('shows the headline figures, the time saved labelled as an estimate with a way to its assumptions', async () => {
    render()
    expect(await screen.findByText('Time saved (estimate)')).toBeInTheDocument()
    expect(screen.getByText('166.0 h')).toBeInTheDocument()
    expect(screen.getByText('Estimate, not a measurement')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'See its assumptions' })).toBeInTheDocument()
  })

  it('reads the range it shows, by month by default', async () => {
    render()
    await screen.findByText('Projects started', { selector: 'p' })
    const [endpoint] = fetchApi.mock.calls[0] ?? []
    expect(endpoint).toMatch(/^\/metrics\/adoption\?from=\d{4}-\d{2}&to=\d{4}-\d{2}&grain=month$/)
  })

  it('opens the assumptions with each baseline, its count and the hours, and saves an admin\'s baselines', async () => {
    const user = userEvent.setup()
    render()
    await user.click(await screen.findByRole('button', { name: 'See its assumptions' }))
    const sheet = await screen.findByRole('dialog', { name: 'How time saved is estimated' })
    expect(within(sheet).getByText('Set by an admin')).toBeInTheDocument()
    const prd = within(sheet).getByLabelText('PRDs: hours by hand')
    await user.clear(prd)
    await user.type(prd, '12')
    await user.click(within(sheet).getByRole('button', { name: 'Save baselines' }))
    await waitFor(() => expect(sentFetchApiBody('/settings/adoption', 'PUT')).toStrictEqual({
      baselines: { personas: 1.5, research: 6, prfaq: 4, prd: 12, prototype: 16 }, note: '=From our survey' }))
  })

  it('refuses a baseline out of range before it is sent', async () => {
    const user = userEvent.setup()
    render()
    await user.click(await screen.findByRole('button', { name: 'Assumptions' }))
    const sheet = await screen.findByRole('dialog', { name: 'How time saved is estimated' })
    await user.clear(within(sheet).getByLabelText('PRDs: hours by hand'))
    expect(within(sheet).getByRole('alert')).toHaveTextContent('from 0 to 200')
    expect(within(sheet).getByRole('button', { name: 'Save baselines' })).toBeDisabled()
  })

  it('tells anyone but an admin of the scope that the view is for administrators, and reads nothing', () => {
    groups.admin = false
    render()
    expect(screen.getByRole('note')).toHaveTextContent('for administrators')
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('in a workspace, follows the workspace role, never the deployment group', async () => {
    setCurrentWorkspace(JUNIPER)
    const { unmount } = render()
    expect(screen.getByRole('note')).toHaveTextContent('for administrators')
    unmount()
    groups.admin = false
    setCurrentWorkspace(ACME)
    render()
    expect(await screen.findByText('Time saved (estimate)')).toBeInTheDocument()
  })

  it('points a platform admin to the platform\'s cost estimate', async () => {
    groups.platform = true
    render()
    expect(await screen.findByText(/GET \/platform\/costs/)).toBeInTheDocument()
  })
})
