/**
 * Import history on the Data sources page (#237, docs/import-history.md): the table of
 * runs, paging, and a row's detail with the warnings its import returned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { at } from '@test/defined'

const list = vi.fn<(cursor?: string) => unknown>()
const get = vi.fn<(runId: string) => unknown>()

vi.mock('../../api/importHistoryApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/importHistoryApi')>()
  return { ...actual, importHistoryApi: { list: (cursor?: string) => list(cursor), get: (runId: string) => get(runId) } }
})

const { default: ImportHistory } = await import('./ImportHistory')
const { normalizeImportHistoryPage, normalizeImportRunDetail } = await import('../../api/importHistoryApi')

const CSV_RUN = {
  run_id: 'run-csv', method: 'csv', source: 'Example Air survey', actor: 'sub-1', actor_email: 'admin@example.com',
  started_at: '2026-10-01T10:00:00+00:00', finished_at: '2026-10-01T10:00:04+00:00',
  counts: { received: 412, imported: 398, skipped: 9, duplicate: 5, failed: 0 },
  status: 'completed', warning_count: 2, error_count: 0, truncated: false, raw_s3_key: 's3://raw/raw/csv_upload/x.csv',
}
const S3_RUN = {
  ...CSV_RUN, run_id: 'run-s3', method: 's3', source: 'S3 - reviews_export', actor: 's3-upload', actor_email: '',
  counts: { received: 250, imported: 200, skipped: 0, duplicate: 0, failed: 50 }, status: 'partial',
}

function page(runs: unknown[], nextCursor?: string) {
  return normalizeImportHistoryPage({ runs, next_cursor: nextCursor })
}

/** The text of each cell of the table's row `index` (0 is the header row). */
async function rowTexts(index: number): Promise<string[]> {
  const table = await screen.findByRole('table', { name: 'Import history' })
  return within(at(within(table).getAllByRole('row'), index)).getAllByRole('cell').map((cell) => cell.textContent)
}

const DETAILED_RUN = normalizeImportRunDetail({ run: {
  ...CSV_RUN, warnings: ['row 4: empty text — skipped', 'row 12: duplicate row — skipped'], errors: [],
  warning_count: 250, truncated: true,
} })

/** Render the history, open the CSV run and return its detail region. */
async function openCsvRun() {
  const user = userEvent.setup()
  renderWithQueryClient(<ImportHistory />)
  await user.click(await screen.findByRole('button', { name: 'Open the CSV file import from Example Air survey' }))
  return { user, detail: await screen.findByRole('region', { name: 'Import details' }) }
}

beforeEach(() => {
  list.mockReset()
  get.mockReset()
  list.mockResolvedValue(page([CSV_RUN, S3_RUN]))
  get.mockResolvedValue(DETAILED_RUN)
})

describe('ImportHistory', () => {
  it('lists a console import with its method, source, actor, counts and status', async () => {
    renderWithQueryClient(<ImportHistory />)
    const cells = await rowTexts(1)
    expect(cells.slice(0, 3)).toStrictEqual(['CSV file', 'Example Air survey', 'admin@example.com'])
    expect(cells[4]).toBe('398 of 412 imported9 skipped, 5 duplicates')
    expect(cells[5]).toBe('Completed')
  })

  it('names the bucket trigger as the actor of an S3 import and shows its failed rows', async () => {
    renderWithQueryClient(<ImportHistory />)
    const cells = await rowTexts(2)
    expect(cells[2]).toBe('S3 upload (uploader unknown)')
    expect(cells[4]).toBe('200 of 250 imported50 failed')
    expect(screen.getByText('Partial')).toHaveClass('badge-warn')
  })

  it('says so when there is no import yet', async () => {
    list.mockResolvedValue(page([]))
    renderWithQueryClient(<ImportHistory />)
    expect(await screen.findByText('No imports in the last 90 days.')).toBeInTheDocument()
  })

  it('loads the next page with the cursor the first page returned', async () => {
    list.mockResolvedValueOnce(page([CSV_RUN], 'cursor-2')).mockResolvedValueOnce(page([S3_RUN]))
    const user = userEvent.setup()
    renderWithQueryClient(<ImportHistory />)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByText('S3 - reviews_export')).toBeInTheDocument()
    expect(list).toHaveBeenLastCalledWith('cursor-2')
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('opens a run with the warnings its import returned and how many are not shown', async () => {
    const { detail } = await openCsvRun()
    expect(get).toHaveBeenCalledWith('run-csv')
    const warnings = await within(detail).findByRole('region', { name: 'Warnings' })
    expect(within(warnings).getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual([
      'row 4: empty text — skipped', 'row 12: duplicate row — skipped'])
    expect(within(warnings).getByText('248 more not shown')).toBeInTheDocument()
  })

  it('points a truncated run at its raw file, and closes', async () => {
    const { user, detail } = await openCsvRun()
    expect(await within(detail).findByText('s3://raw/raw/csv_upload/x.csv')).toBeInTheDocument()
    expect(within(detail).getByText('Some messages were shortened or left out. The raw file has the full input.')).toBeInTheDocument()
    await user.click(within(detail).getByRole('button', { name: 'Close import details' }))
    expect(screen.queryByRole('region', { name: 'Import details' })).not.toBeInTheDocument()
  })

  it('reports a run that cannot be read instead of showing an empty detail', async () => {
    get.mockResolvedValue(null)
    const { detail } = await openCsvRun()
    expect(await within(detail).findByRole('alert')).toHaveTextContent('Could not load this import.')
  })
})

describe('the import history wire boundary', () => {
  it('drops a row without a run id and reads a drifted row with defaults', () => {
    const parsed = normalizeImportHistoryPage({ runs: [{ method: 'csv' }, { run_id: 'r', method: 'email', counts: 'x', status: 7 }] })
    expect(parsed.runs).toHaveLength(1)
    expect(parsed.runs[0]).toMatchObject({ run_id: 'r', method: 'unknown', status: 'unknown', counts: { received: 0, imported: 0 } })
    expect(parsed.next_cursor).toBeUndefined()
  })

  it('reads a non-object answer as an empty page and a detail without a run as null', () => {
    expect(normalizeImportHistoryPage('oops')).toStrictEqual({ runs: [], next_cursor: undefined })
    expect(normalizeImportRunDetail({})).toBeNull()
  })
})
