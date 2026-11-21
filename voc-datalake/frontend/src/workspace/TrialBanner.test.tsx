/**
 * The trial banner (7.71.00): a running trial says when it ends and that it then only pauses; a paused one says since
 * when, what the pause turned off and that nothing was deleted; a converted trial, a workspace that is no trial and no
 * workspace show nothing. The banner keeps the trial store in step, which the paused controls read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../test/query-client'

vi.mock('../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ACME } from '../test/workspaceFixtures'
import type { TrialSummary } from '../api/workspacesApi'
import { setCurrentWorkspace } from './currentWorkspace'
import { isTrialPaused, setCurrentTrial, useSuggestedPlaybook, useTrialPaused } from './currentTrial'
import TrialBanner from './TrialBanner'

const RUNNING: TrialSummary = { days: 30, expires_at: '2026-12-21T09:00:00+00:00', paused_at: null, converted_at: null, paused: null }
const PAUSED: TrialSummary = { ...RUNNING, paused_at: '2026-12-21T09:00:05+00:00', paused: { plugins: 2, forms: 3 } }

function Probe() {
  return <span data-testid="probe">{`${String(useTrialPaused())} ${useSuggestedPlaybook() ?? 'none'}`}</span>
}

function renderBanner(trial: TrialSummary | null, playbook: string | null = null) {
  routeFetchApi({ 'GET /me/workspaces/current': () => ({ workspace: { ...ACME, platform_admin: false, trial, playbook } }) })
  render(<QueryClientProvider client={createTestQueryClient()}><TrialBanner /><Probe /></QueryClientProvider>)
}

beforeEach(() => { resetFetchApi(); setCurrentWorkspace(ACME) })
afterEach(() => { setCurrentWorkspace(null); setCurrentTrial({ trial: null, playbook: null }) })

describe('TrialBanner', () => {
  it('says when a running trial ends and that it then pauses, deleting nothing', async () => {
    renderBanner(RUNNING, 'qa')
    expect(await screen.findByText(/This is a trial workspace until .*2026.*nothing is deleted/)).toBeInTheDocument()
    expect(screen.getByTestId('probe')).toHaveTextContent('false qa')
  })

  it('says since when a paused trial is paused, what it turned off, and that reads and the export still work', async () => {
    renderBanner(PAUSED)
    expect(await screen.findByText(/2 plugins and 3 live forms were turned off\. Nothing was deleted/)).toBeInTheDocument()
    expect(screen.getByTestId('probe')).toHaveTextContent('true none')
  })

  it.each([
    ['a converted trial', { ...PAUSED, converted_at: '2026-12-22T09:00:00+00:00' }],
    ['a workspace that is no trial', null],
  ])('shows nothing for %s', async (_case, trial) => {
    renderBanner(trial)
    await screen.findByTestId('probe')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it('shows nothing outside a workspace and asks nothing', () => {
    setCurrentWorkspace(null)
    renderBanner(RUNNING)
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
})

describe('isTrialPaused', () => {
  it('is true for a paused trial only', () => {
    expect([isTrialPaused(null), isTrialPaused(RUNNING), isTrialPaused(PAUSED),
      isTrialPaused({ ...PAUSED, converted_at: 'x' })]).toStrictEqual([false, false, true, false])
  })
})
