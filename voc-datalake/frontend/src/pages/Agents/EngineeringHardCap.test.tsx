/**
 * @fileoverview Agents → Spend's hard cap: its state as saved, an administrator's change (PUT, then shown as saved,
 * the switch keeping its focus meanwhile), a failed save, a failed load and its retry, an unreadable answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { parseSettings } from '../../api/engineeringSpendApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringHardCap } = await import('./EngineeringHardCap')

const LABEL = /Hard cap at each workflow’s monthly budget/
const settings = (hardCap: boolean) => ({ hard_cap: hardCap, updated_at: null, updated_by: null })

beforeEach(() => { resetFetchApi() })

describe('the hard cap', () => {
  it('shows its state and saves an administrator\'s change, keeping the switch\'s focus', async () => {
    const user = userEvent.setup()
    routeFetchApi({
      'GET /agents/engineering/settings': () => settings(false),
      'PUT /agents/engineering/settings': () => settings(true),
    }, { missStatus: 500 })
    renderWithQueryClient(<EngineeringHardCap />)
    const toggle = await screen.findByRole('switch', { name: LABEL })
    expect(toggle).not.toBeChecked()
    toggle.focus()
    await user.keyboard(' ')
    await waitFor(() => expect(toggle).toBeChecked())
    expect(toggle).toHaveFocus()
    expect(fetchApi.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ hard_cap: true }) })
  })

  it('says a failed save, and keeps the state as saved', async () => {
    const user = userEvent.setup()
    routeFetchApi({
      'GET /agents/engineering/settings': () => settings(false),
      'PUT /agents/engineering/settings': () => { throw new ApiError(503, 'unavailable') },
    }, { missStatus: 500 })
    renderWithQueryClient(<EngineeringHardCap />)
    await user.click(await screen.findByRole('switch', { name: LABEL }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(screen.getByRole('switch', { name: LABEL })).not.toBeChecked()
  })

  it('says a failed load, and loads again on Retry', async () => {
    const user = userEvent.setup()
    routeFetchApi({ 'GET /agents/engineering/settings': () => { throw new ApiError(503, 'unavailable') } }, { missStatus: 500 })
    renderWithQueryClient(<EngineeringHardCap />)
    expect(await screen.findByText('The hard cap’s setting could not be loaded.', {}, { timeout: 5000 })).toBeInTheDocument()
    routeFetchApi({ 'GET /agents/engineering/settings': () => settings(true) }, { missStatus: 500 })
    await user.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('switch', { name: LABEL })).toBeChecked()
  })

  it('reads an answer without a hard_cap as an error, never as "off"', () => {
    expect(() => parseSettings({ updated_by: 'x' })).toThrow('unreadable')
    expect(parseSettings({ hard_cap: true })).toStrictEqual({ hard_cap: true, updated_at: null, updated_by: null })
  })
})
