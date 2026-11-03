/**
 * "Delete all data from a source": the picker lists what the server accepts,
 * Delete stays off until the source id is typed exactly and a legal basis is
 * given, both are sent (`confirm`, `legal_basis`), and the started job's
 * progress and details are shown from the polled list.
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
const mockInvalidateFeedbackData = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../../api/invalidateFeedbackData', () => ({ invalidateFeedbackData: mockInvalidateFeedbackData }))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import SourceErasurePanel from './SourceErasurePanel'
import { normalizeSourceProfiles } from '../../api/sourceProfilesApi'

const SOURCE = 'web_trustpilot_example_air'
const BASIS = 'Contract with the review site ended'
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
  mockInvalidateFeedbackData.mockClear()
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
      basis: within(dialog).getByLabelText('Legal basis'),
      confirm: within(dialog).getByRole('button', { name: 'Delete all data' }),
    }
  }

  it('cannot open the dialog before a source is chosen', async () => {
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    const region = await panel()
    await within(region).findByLabelText('Source')
    expect(within(region).getByRole('button', { name: 'Delete all data from this source' })).toBeDisabled()
  })

  it('says the source keeps running, without a warning when its schedule is off', async () => {
    route({ scheduled: { [SOURCE]: false, support_tickets: true } })
    const user = userEvent.setup()
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    await openDialog(user)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/The source keeps running after the deletion/)).toHaveTextContent(
      'Turn the source off first if you want it to stay empty.')
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

  it('keeps Delete off until the source id is typed exactly and a legal basis is given', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    const { typed, basis, confirm } = await openDialog(user)
    await user.type(typed, SOURCE.toUpperCase())
    await user.type(basis, BASIS)
    expect(confirm).toBeDisabled()
    await user.clear(typed)
    await user.type(typed, SOURCE)
    expect(confirm).toBeEnabled()
    await user.clear(basis)
    await user.type(basis, '   ')
    expect(confirm).toBeDisabled()
  })

  /** Open the dialog, fill it with SOURCE and `basis`, serve `jobs` from then on and confirm; returns the panel. */
  async function startDeletion(basisText: string, jobs: unknown[]) {
    const user = userEvent.setup()
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    const { region, typed, basis, confirm } = await openDialog(user)
    await user.type(typed, SOURCE)
    await user.type(basis, basisText)
    route({ jobs })
    await user.click(confirm)
    return region
  }

  it('sends what was typed as confirm with the legal basis, and shows the job progress', async () => {
    const region = await startDeletion(` ${BASIS} `, [running])
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/erasure', {
      method: 'POST', body: JSON.stringify({ field: 'source', value: SOURCE, confirm: SOURCE, legal_basis: BASIS }),
    }))
    expect(await within(region).findByText('Deleting raw files. Reviews deleted: 40. Raw files deleted: 12.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the job\'s legal basis, the Radar reviews and marked artifacts, and the last phase', async () => {
    const region = await startDeletion(BASIS, [
      { ...running, phase: 'lineage', legal_basis: BASIS, deleted_radar_items: 2, artifacts_marked: 3 }])
    expect(await within(region).findByText(/^Marking personas and documents/)).toBeInTheDocument()
    expect(within(region).getByText(`Legal basis: ${BASIS}`)).toBeInTheDocument()
    expect(within(region).getByText('2 Radar reviews deleted, 3 personas or documents marked')).toBeInTheDocument()
  })

  it('shows why the server refused, such as a deletion already running', async () => {
    const user = userEvent.setup()
    route({ post: () => { throw new Error('An erasure of this source is already running') } })
    renderWithQueryClient(<SourceErasurePanel profiles={[]} />)
    const { region, typed, basis, confirm } = await openDialog(user)
    await user.type(typed, SOURCE)
    await user.type(basis, BASIS)
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

  it('reads the jobs and the source list with one request', async () => {
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    await within(await panel()).findByLabelText('Source')
    const reads = fetchApi.mock.calls.filter((call) => call[0] === '/settings/erasure' && call[1] === undefined)
    expect(reads).toHaveLength(1)
  })

  it('refreshes the feedback views once a job it saw running has ended, not before', async () => {
    route({ jobs: [running] })
    renderWithQueryClient(<SourceErasurePanel profiles={PROFILES} />)
    await within(await panel()).findByLabelText('Source')
    expect(mockInvalidateFeedbackData).not.toHaveBeenCalled()
    route({ jobs: [{ ...running, status: 'completed' }] })
    await waitFor(() => expect(mockInvalidateFeedbackData).toHaveBeenCalledTimes(1), { timeout: 5_000 })
  })
})
