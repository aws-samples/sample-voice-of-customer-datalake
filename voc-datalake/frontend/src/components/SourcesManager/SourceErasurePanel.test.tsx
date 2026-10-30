/**
 * "Delete all data from a source": the picker lists what the server accepts,
 * Delete stays off until the source id is typed exactly, the typed text is sent
 * as `confirm`, and the started job's progress is shown from the polled list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { supportProfile } from '@test/dimensionFixtures'

// `api.getSourcesStatus` (the page-wide schedule read) goes through the same routed double.
vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => ({
  ...m.fetchApiClientModule(),
  api: { getSourcesStatus: () => m.fetchApi('/sources/status') },
})))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import SourceErasurePanel from './SourceErasurePanel'
import { normalizeSourceProfiles } from '../../api/sourceProfilesApi'

const SOURCE = 'web_trustpilot_example_air'
const PROFILES = normalizeSourceProfiles({ sources: [supportProfile] })
const running = {
  job_id: 'er_00000000abcd', status: 'running', field: 'source', source: SOURCE, value_hash: 'f'.repeat(64),
  deleted_items: 40, deleted_objects: 12, started_by: 'admin', created_at: '2026-01-01', phase: 'raw',
}

interface Routes { jobs?: unknown[]; sources?: string[]; post?: () => unknown; scheduled?: Record<string, boolean> }

function route({ jobs = [], sources = [SOURCE, 'support_tickets'], post = () => ({ job: running }), scheduled = {} }: Routes = {}) {
  const status = Object.fromEntries(Object.entries(scheduled).map(([id, enabled]) => [id, { enabled }]))
  routeFetchApi({
    'GET /settings/erasure': () => ({ jobs, sources }),
    'POST /settings/erasure': post,
    'GET /sources/status': () => ({ sources: status }),
  })
}

const panel = () => screen.findByRole('region', { name: 'Delete all data from a source' })

beforeEach(() => {
  resetFetchApi()
  route()
})

describe('SourceErasurePanel', () => {
  /** Pick SOURCE and open the dialog; returns the dialog's typed field and Delete button. */
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    const region = await panel()
    await user.selectOptions(await within(region).findByLabelText('Source'), SOURCE)
    await user.click(within(region).getByRole('button', { name: 'Delete all data from this source' }))
    const dialog = await screen.findByRole('dialog')
    return {
      region,
      typed: within(dialog).getByLabelText(`Type ${SOURCE} to confirm`),
      confirm: within(dialog).getByRole('button', { name: 'Delete all data' }),
    }
  }

  it('cannot open the dialog before a source is chosen', async () => {
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    const region = await panel()
    await within(region).findByLabelText('Source')
    expect(within(region).getByRole('button', { name: 'Delete all data from this source' })).toBeDisabled()
  })

  it('says the source keeps running and uploaded files are kept, without a warning when its schedule is off', async () => {
    route({ scheduled: { [SOURCE]: false, support_tickets: true } })
    const user = userEvent.setup()
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    await openDialog(user)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/The source keeps running after the deletion/)).toHaveTextContent(
      'Uploaded CSV and JSON files (raw/csv_upload, raw/json_upload) are kept.')
    expect(within(dialog).queryByText(/schedule of .* is on/)).not.toBeInTheDocument()
  })

  it('warns when the chosen source has its schedule on', async () => {
    route({ scheduled: { [SOURCE]: true } })
    const user = userEvent.setup()
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/sources/status'))
    await openDialog(user)
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
      `The schedule of ${SOURCE} is on. New reviews will arrive after the deletion unless you turn the source off first.`)
  })

  it('keeps Delete off until the source id is typed exactly', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    const { typed, confirm } = await openDialog(user)
    await user.type(typed, SOURCE.toUpperCase())
    expect(confirm).toBeDisabled()
    await user.clear(typed)
    await user.type(typed, SOURCE)
    expect(confirm).toBeEnabled()
  })

  it('sends what was typed as confirm and shows the job progress', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    const { region, typed, confirm } = await openDialog(user)
    await user.type(typed, SOURCE)
    route({ jobs: [running] })
    await user.click(confirm)
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/erasure', {
      method: 'POST', body: JSON.stringify({ field: 'source', value: SOURCE, confirm: SOURCE }),
    }))
    expect(await within(region).findByText('Deleting raw files. Reviews deleted: 40. Raw files deleted: 12.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows why the server refused, such as a deletion already running', async () => {
    const user = userEvent.setup()
    route({ post: () => { throw new Error('An erasure of this source is already running') } })
    renderWithQueryClient(<SourceErasurePanel profiles={[]} />)
    const { region, typed, confirm } = await openDialog(user)
    await user.type(typed, SOURCE)
    await user.click(confirm)
    expect(await within(region).findByRole('alert')).toHaveTextContent(
      'The deletion was not started: An erasure of this source is already running')
  })

  it('names configured sources by their label', async () => {
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    const select = await within(await panel()).findByLabelText('Source')
    expect(within(select).getByRole('option', { name: 'Support tickets' })).toHaveValue('support_tickets')
  })

  it('says so when no source has data', async () => {
    route({ sources: [] })
    renderWithQueryClient(<SourceErasurePanel profiles={[]} />)
    expect(await within(await panel()).findByText('No source has data yet.')).toBeInTheDocument()
  })
})
