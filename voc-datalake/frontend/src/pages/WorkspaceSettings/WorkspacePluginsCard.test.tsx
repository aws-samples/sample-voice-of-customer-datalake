/**
 * The workspace's plugins in a paused trial (7.71.00): Enable is held back with the reason (only a platform admin's
 * extension or conversion turns plugins back on), Disable still works, and a server refusal of an enable is said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { ACME } from '../../test/workspaceFixtures'
import { setCurrentTrial } from '../../workspace/currentTrial'
import { TRIAL_PAUSED } from '../../workspace/workspaceRefusals'
import WorkspacePluginsCard from './WorkspacePluginsCard'

const PAUSED = { days: 30, expires_at: null, paused_at: '2026-12-21T09:00:05+00:00', converted_at: null, paused: { plugins: 1, forms: 0 } }

function renderCard() {
  render(<QueryClientProvider client={createTestQueryClient()}><WorkspacePluginsCard workspaceId={ACME.id} isAdmin /></QueryClientProvider>)
}

const LIST = { 'GET /me/workspaces/current/plugins': () => ({ plugins: [{ id: 'webscraper', enabled: false },
  { id: 'app_reviews_ios', enabled: true }] }) }

beforeEach(() => {
  resetFetchApi()
  routeFetchApi(LIST)
})
afterEach(() => setCurrentTrial({ trial: null, playbook: null }))

describe('WorkspacePluginsCard in a paused trial', () => {
  it('holds Enable back with the reason, and keeps Disable', async () => {
    setCurrentTrial({ trial: PAUSED, playbook: null })
    renderCard()
    expect(await screen.findAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText(/plugins stay off until a platform admin extends or converts it/)).toBeInTheDocument()
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => [button.textContent, button.hasAttribute('disabled')])).toStrictEqual([['Enable', true], ['Disable', false]])
  })

  it('says the server\'s refusal of an enable in a paused trial', async () => {
    routeFetchApi({ ...LIST, 'PUT /me/workspaces/current/plugins/webscraper': () => { throw new ApiError(409, TRIAL_PAUSED) } })
    renderCard()
    await userEvent.click((await screen.findAllByRole('button', { name: /^Enable/ }))[0] ?? document.body)
    expect(await screen.findByRole('alert')).toHaveTextContent('plugins stay off until a platform admin extends or converts it')
  })
})
