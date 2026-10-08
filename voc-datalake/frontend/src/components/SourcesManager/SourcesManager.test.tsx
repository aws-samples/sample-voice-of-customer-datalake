/**
 * Sources editor and erasure: profiles render with their policy, edits save as
 * one list, a bad retention blocks the save, and an erasure asks first, sends
 * the value once, clears it, and lists the job by its hash.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { dimensionsWire, sourcesWire, supportProfile } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import SourcesManager from './SourcesManager'

const job = { job_id: 'er_0123456789ab', status: 'completed', field: 'email', value_hash: 'a1b2c3d4e5f6a7b8', deleted_items: 3, deleted_objects: 3, started_by: 'admin', created_at: '2026-01-01' }

/** The body of the last `PUT /settings/sources`. */
function savedBody(): unknown {
  const call = fetchApi.mock.calls.filter(([endpoint, options]) => endpoint === '/settings/sources' && options?.method === 'PUT').at(-1)
  return JSON.parse(String(call?.[1]?.body))
}

/** The settings routes, with `jobs` as the stored erasure jobs. */
function routeSettings(jobs: unknown[] = []): void {
  routeFetchApi({
    'GET /settings/sources': () => sourcesWire,
    'PUT /settings/sources': (body) => body,
    'GET /settings/dimensions': () => dimensionsWire,
    'GET /settings/erasure': () => ({ jobs }),
    'POST /settings/erasure': () => ({ job }),
    'GET /scrapers': () => ({ scrapers: [{ id: 's1', name: 'trustpilot_reviews' }, { id: 's2', name: 'Shop Reviews' }] }),
  })
}

beforeEach(() => {
  resetFetchApi()
  routeSettings()
})

describe('SourcesManager', () => {
  it('shows the stored policy of each profile', async () => {
    renderWithQueryClient(<SourcesManager />)
    const support = await screen.findByRole('region', { name: 'Support tickets' })
    expect(within(support).getByLabelText('Personal data')).toHaveValue('redact')
    expect(within(support).getByLabelText('Delete reviews older than (days)')).toHaveValue(365)
    expect(within(support).getByRole('switch', { name: /Restricted/ })).toBeChecked()
  })

  it('saves a new profile with the contract defaults, and an edited one as changed', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<SourcesManager />)
    await user.type(await screen.findByLabelText('Add a source profile'), 'webscraper{Enter}')
    const support = screen.getByRole('region', { name: 'Support tickets' })
    await user.click(within(support).getByRole('checkbox', { name: 'Keep reviews forever' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/sources', expect.objectContaining({ method: 'PUT' })))
    expect(savedBody()).toStrictEqual({ sources: [
      { id: 'sales_csv', label: 'Sales CSV', pii: 'allow', retention_days: null, restricted: false, dimension_defaults: { user_type: 'partner' }, tags: ['sales'] },
      { ...supportProfile, retention_days: null },
      { id: 'webscraper', label: 'webscraper', pii: 'allow', retention_days: null, restricted: false, dimension_defaults: {}, tags: [] },
    ] })
  })

  it('blocks a save while a retention is out of range', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<SourcesManager />)
    const days = within(await screen.findByRole('region', { name: 'Support tickets' })).getByLabelText('Delete reviews older than (days)')
    await user.clear(days)
    await user.type(days, '7')
    expect(screen.getByRole('status')).toHaveTextContent('Support tickets: retention must be 30-3650 days')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('suggests a scraper whose name is a valid source id, never the webscraper plugin id', async () => {
    const { container } = renderWithQueryClient(<SourcesManager />)
    await waitFor(() => expect(container.querySelector('datalist option[value="trustpilot_reviews"]')).not.toBeNull())
    expect(container.querySelector('datalist option[value="webscraper"]')).toBeNull()
    expect(container.querySelector('datalist option[value="Shop Reviews"]')).toBeNull()
  })

    it('refuses an id that already has a profile', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<SourcesManager />)
    await user.type(await screen.findByLabelText('Add a source profile'), 'sales_csv')
    expect(screen.getByText('That source already has a profile.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })
})

describe('ErasurePanel', () => {
  it('asks first, sends the value once, clears it and lists the job by hash', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<SourcesManager />)
    const panel = await screen.findByRole('region', { name: "Erase one person's feedback" })
    await user.selectOptions(within(panel).getByLabelText('Match on'), 'email')
    await user.type(within(panel).getByLabelText('Value'), 'ana@example.com')
    await user.selectOptions(within(panel).getByLabelText('Within source'), 'support_tickets')
    routeSettings([job])
    await user.click(within(panel).getByRole('button', { name: 'Erase' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Erase' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/erasure', { method: 'POST', body: JSON.stringify({ field: 'email', value: 'ana@example.com', source: 'support_tickets' }) }))
    expect(within(panel).getByLabelText('Value')).toHaveValue('')
    expect(await within(panel).findByText('a1b2c3d4e5f6')).toBeInTheDocument()
  })

  it.each(['source_id', 'csv_row_id'])('needs a source before a %s erasure can start', async (field) => {
    const user = userEvent.setup()
    renderWithQueryClient(<SourcesManager />)
    const panel = await screen.findByRole('region', { name: "Erase one person's feedback" })
    await user.selectOptions(within(panel).getByLabelText('Match on'), field)
    await user.type(within(panel).getByLabelText('Value'), 'row-7')
    expect(within(panel).getByRole('button', { name: 'Erase' })).toBeDisabled()
    expect(within(panel).getByLabelText('Within source')).toHaveAccessibleDescription('An id is unique only within its source: choose the source.')
    await user.selectOptions(within(panel).getByLabelText('Within source'), 'support_tickets')
    expect(within(panel).getByRole('button', { name: 'Erase' })).toBeEnabled()
  })
})
