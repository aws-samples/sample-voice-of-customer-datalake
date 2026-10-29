/**
 * @fileoverview CsvUploadModal with a dataset name (issue #411): preview first, then a confirmed upload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { dimensionsWire, sourcesWire } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import CsvUploadModal from './CsvUploadModal'
import { parseCsvDatasetPreview } from '../../api/csvDatasetSchema'

const mockUpload = vi.fn<(...args: unknown[]) => unknown>()
const mockPreview = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: {
    uploadCsvFeedback: (...args: unknown[]) => mockUpload(...args),
    previewCsvUpload: (...args: unknown[]) => mockPreview(...args),
  },
}))
vi.mock('../../api/invalidateFeedbackData', () => ({ useInvalidateFeedbackData: () => vi.fn() }))

const CSV = 'id,text\n1,"Great app"\n2,"Login fails"\n'
const MAPPING = { id: 'id', text: 'text' }

function csvFile(content: string = CSV): File {
  const file = new File([content], 'feedback.csv', { type: 'text/csv' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
  return file
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  return input
}

const PREVIEW = parseCsvDatasetPreview({
  total_rows: 3,
  counts: { new: 1, changed: 1, unchanged: 0, v1_rows: 1 },
  changed_rows: [{ row: 2, csv_row_id: '2', before: 'Login fials', after: 'Login fails' }],
  changed_rows_truncated: false,
})

async function openWithDataset(name = '  Example Air Q3 ') {
  const user = userEvent.setup()
  renderWithQueryClient(<CsvUploadModal isOpen onClose={() => {}} />)
  await user.type(screen.getByLabelText('Dataset name (optional)'), name)
  await user.upload(fileInput(), csvFile())
  return user
}

describe('CsvUploadModal with a dataset name', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFetchApi()
    routeFetchApi({ 'GET /settings/dimensions': () => dimensionsWire, 'GET /settings/sources': () => sourcesWire })
    mockPreview.mockResolvedValue(PREVIEW)
    mockUpload.mockResolvedValue({ imported_count: 2, total_rows: 3, counts: { new: 1, changed: 1, unchanged: 1, v1_rows: 1 } })
  })

  it('previews first and stores nothing until the person confirms', async () => {
    const user = await openWithDataset()
    await user.click(screen.getByRole('button', { name: 'Preview changes' }))

    expect(mockPreview).toHaveBeenCalledWith({
      csv_text: CSV, default_source: undefined, source_id: 'manual_import', column_map: MAPPING, dataset_name: 'Example Air Q3',
    })
    expect(mockUpload).not.toHaveBeenCalled()
    expect(await screen.findByText('1 stored row will be updated')).toBeInTheDocument()
    expect(screen.getByText('1 new row will be added')).toBeInTheDocument()
    expect(screen.getByText('1 row cannot be updated later (no id)')).toBeInTheDocument()
    expect(screen.getByText('Row 2 (id 2)')).toBeInTheDocument()
    expect(screen.getByText('Login fials')).toBeInTheDocument()
  })

  it('confirms the updates the preview listed with apply_updates', async () => {
    const user = await openWithDataset()
    await user.click(screen.getByRole('button', { name: 'Preview changes' }))
    await user.click(await screen.findByRole('button', { name: 'Import and update' }))

    await waitFor(() => expect(mockUpload).toHaveBeenCalledWith(expect.objectContaining({
      dataset_name: 'Example Air Q3', apply_updates: true,
    })))
    expect(await screen.findByText(/1 stored row updated\./)).toBeInTheDocument()
    expect(screen.getByText(/1 unchanged row skipped\./)).toBeInTheDocument()
  })

  it('goes back to the form from the preview without uploading', async () => {
    const user = await openWithDataset()
    await user.click(screen.getByRole('button', { name: 'Preview changes' }))
    await user.click(await screen.findByRole('button', { name: 'Back' }))

    expect(screen.getByLabelText('Dataset name (optional)')).toHaveValue('  Example Air Q3 ')
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('offers a plain Import when nothing stored changes', async () => {
    mockPreview.mockResolvedValue(parseCsvDatasetPreview({ total_rows: 2, counts: { new: 2 } }))
    const user = await openWithDataset()
    await user.click(screen.getByRole('button', { name: 'Preview changes' }))
    expect(await screen.findByRole('button', { name: 'Import' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Import and update' })).not.toBeInTheDocument()
  })

  it('blocks an invalid dataset name and says why', async () => {
    await openWithDataset('reviews/q3')
    expect(screen.getByRole('alert')).toHaveTextContent('Use only letters, digits, spaces')
    expect(screen.getByRole('button', { name: 'Preview changes' })).toBeDisabled()
  })

  it('uploads in one step without a dataset name, as before', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<CsvUploadModal isOpen onClose={() => {}} />)
    await user.upload(fileInput(), csvFile())
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1))
    expect(mockPreview).not.toHaveBeenCalled()
    expect(mockUpload.mock.calls[0]?.[0]).not.toHaveProperty('dataset_name')
  })
})

describe('parseCsvDatasetPreview', () => {
  it('reads missing counts as zero and drops a malformed changed row', () => {
    const preview = parseCsvDatasetPreview({ counts: { changed: 2 }, changed_rows: [{ row: 'x', before: 1 }, 'junk'] })
    expect(preview.counts).toEqual({ new: 0, changed: 2, unchanged: 0, v1_rows: 0 })
    expect(preview.changed_rows).toEqual([{ row: null, csv_row_id: null, before: '', after: '' }])
  })

  it('never throws on a non-object', () => {
    expect(parseCsvDatasetPreview(null).counts.new).toBe(0)
  })
})
