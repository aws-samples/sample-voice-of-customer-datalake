/**
 * A trial's row in the platform console (7.71.00): its state as a badge, Extend by 14, 30 or 60 days, and Convert after
 * a confirmation (which says a paused trial's plugins and forms come back); a refusal said in words; nothing for a
 * converted trial or a workspace that is no trial.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../../test/query-client'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import type { PlatformWorkspace } from '../../../api/platformWorkspacesApi'
import { PLATFORM_ACME } from '../../../test/workspaceFixtures'
import TrialActions, { TrialBadge } from './TrialActions'

const TRIAL = { days: 30, expires_at: '2026-12-21T09:00:00+00:00', paused_at: null, converted_at: null, paused: null }
const ROW: PlatformWorkspace = { ...PLATFORM_ACME, trial: TRIAL }
const EXTEND = `/platform/workspaces/${ROW.id}/trial/extend`
const CONVERT = `/platform/workspaces/${ROW.id}/trial/convert`
const ANSWER = { trial: { ...TRIAL, extended: [] } }

function renderRow(row: PlatformWorkspace = ROW) {
  return render(<QueryClientProvider client={createTestQueryClient()}><TrialBadge trial={row.trial ?? TRIAL} /><TrialActions workspace={row} /></QueryClientProvider>)
}

beforeEach(() => { resetFetchApi() })

describe('TrialActions', () => {
  it('extends by the days chosen', async () => {
    routeFetchApi({ [`POST ${EXTEND}`]: () => ANSWER })
    renderRow()
    expect(screen.getByText(/Trial · ends/)).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Extend Acme Outfitters by'), '60')
    await userEvent.click(screen.getByRole('button', { name: 'Extend' }))
    await vi.waitFor(() => { expect(sentFetchApiBody(EXTEND, 'POST')).toStrictEqual({ days: 60 }) })
  })

  it('converts only once confirmed, and says what a paused trial gets back', async () => {
    routeFetchApi({ [`POST ${CONVERT}`]: () => ANSWER })
    renderRow({ ...ROW, trial: { ...TRIAL, paused_at: '2026-12-21T09:00:05+00:00', paused: { plugins: 1, forms: 0 } } })
    expect(screen.getByText(/Trial paused since/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Convert Acme Outfitters into a regular workspace' }))
    expect(screen.getByText(/plugins and forms its pause turned off are turned back on/)).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Convert' }).at(-1) ?? document.body)
    await vi.waitFor(() => { expect(sentFetchApiBody(CONVERT, 'POST')).toStrictEqual({}) })
  })

  it('says a refusal in words', async () => {
    routeFetchApi({ [`POST ${EXTEND}`]: () => { throw new ApiError(409, 'This trial was converted: it is a regular workspace now, with no end') } })
    renderRow()
    await userEvent.click(screen.getByRole('button', { name: 'Extend' }))
    expect(await screen.findByText('This trial was converted: it is a regular workspace now.')).toBeInTheDocument()
  })

  it('offers nothing for a converted trial, and says it was one', () => {
    renderRow({ ...ROW, trial: { ...TRIAL, converted_at: '2026-12-22T09:00:00+00:00' } })
    expect(screen.getByText('Converted from a trial')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
