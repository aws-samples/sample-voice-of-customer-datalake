/**
 * Dimensions editor: renders the stored config, edits stay a draft until Save,
 * a broken draft cannot be saved, and a refused save shows the server's reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { dimensionsWire } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import DimensionsManager from './DimensionsManager'

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({
    'GET /settings/dimensions': () => dimensionsWire,
    'PUT /settings/dimensions': (body) => ({ success: true, ...(typeof body === 'object' ? body : {}), updated_at: '2026-02-02' }),
  })
})

describe('DimensionsManager', () => {
  it('shows each stored dimension with its values and parent', async () => {
    renderWithQueryClient(<DimensionsManager />)
    const module = await screen.findByRole('region', { name: 'Module' })
    expect(within(module).getByLabelText('Parent dimension')).toHaveValue('product')
    expect(within(module).getByLabelText('Stored name of login')).toHaveValue('login')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('saves an added value with the whole list', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<DimensionsManager />)
    const userType = await screen.findByRole('region', { name: 'User type' })
    await user.type(within(userType).getByLabelText('New value for User type'), 'reseller{Enter}')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/dimensions', expect.objectContaining({ method: 'PUT' })))
    const body: unknown = JSON.parse(String(fetchApi.mock.calls.at(-1)?.[1]?.body))
    expect(body).toMatchObject({ dimensions: [{ key: 'product' }, { key: 'module', parent: 'product' }, { key: 'user_type', values: [{}, {}, { name: 'reseller' }] }] })
  })

  it('blocks a save while the draft is invalid and says why', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<DimensionsManager />)
    await user.click(await screen.findByRole('button', { name: /Add dimension/ }))
    await user.type(within(screen.getByRole('region', { name: 'New dimension' })).getByLabelText('Key (stored on reviews)'), 'source')
    expect(screen.getByRole('status')).toHaveTextContent('"source" is reserved')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it("shows the server's reason when the save is refused", async () => {
    routeFetchApi({
      'GET /settings/dimensions': () => dimensionsWire,
      'PUT /settings/dimensions': () => { throw new ApiError(400, 'At most 200 values per dimension') },
    })
    const user = userEvent.setup()
    renderWithQueryClient(<DimensionsManager />)
    await user.click(within(await screen.findByRole('region', { name: 'Product' })).getByRole('button', { name: 'Remove value web_shop' }))
    await user.click(within(screen.getByRole('region', { name: 'Module' })).getByRole('button', { name: 'Remove value checkout' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved: At most 200 values per dimension')
  })

  it('discards the draft back to what is stored', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<DimensionsManager />)
    await user.click(within(await screen.findByRole('region', { name: 'User type' })).getByRole('button', { name: /Remove dimension/ }))
    expect(screen.queryByRole('region', { name: 'User type' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByRole('region', { name: 'User type' })).toBeInTheDocument()
  })
})
