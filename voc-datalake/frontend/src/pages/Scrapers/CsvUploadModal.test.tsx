/**
 * @fileoverview Tests for CsvUploadModal component (prd-fix #7 / P9).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { renderWithQueryClient } from '@test/query-client'
import { dimensionsWire, sourcesWire } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import CsvUploadModal from './CsvUploadModal'

const render = (ui: ReactElement) => renderWithQueryClient(ui)

const mockUploadCsvFeedback = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: {
    uploadCsvFeedback: (...args: unknown[]) => mockUploadCsvFeedback(...args),
  },
}))

const CSV = 'id,text,rating\n1,"Great app",5\n2,"Login fails",1\n'

function makeCsvFile(content: string = CSV, name = 'feedback.csv'): File {
  const file = new File([content], name, { type: 'text/csv' })
  // jsdom's File lacks .text(); the modal reads the file with it.
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
  return file
}

function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  return input
}

/** Render the open modal with `uploadCsvFeedback` resolving to `result`; returns a user. */
function renderOpenWithUploadResult(result: Record<string, unknown>, onClose: () => void = () => {}) {
  mockUploadCsvFeedback.mockResolvedValue(result)
  render(<CsvUploadModal isOpen onClose={onClose} />)
  return userEvent.setup()
}

/** Pick the default CSV fixture and press Upload. */
async function uploadDefaultCsv(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(getFileInput(), makeCsvFile())
  await user.click(screen.getByRole('button', { name: /upload/i }))
}

const DEFAULT_MAP = { id: 'id', text: 'text', rating: 'rating' }

describe('CsvUploadModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFetchApi()
    routeFetchApi({ 'GET /settings/dimensions': () => dimensionsWire, 'GET /settings/sources': () => sourcesWire })
  })

  it('renders nothing when closed', () => {
    render(<CsvUploadModal isOpen={false} onClose={() => {}} />)
    expect(screen.queryByText(/CSV upload/i)).not.toBeInTheDocument()
  })

  it('renders title, format guide, and disabled upload button when open', () => {
    render(<CsvUploadModal isOpen onClose={() => {}} />)
    expect(screen.getByText('CSV upload')).toBeInTheDocument()
    expect(screen.getByText('CSV format')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upload/i })).toBeDisabled()
  })

  it('shows an error and keeps upload disabled for a non-csv file', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<CsvUploadModal isOpen onClose={() => {}} />)

    await user.upload(getFileInput(), new File(['x'], 'notes.txt', { type: 'text/plain' }))

    expect(await screen.findByText(/select a .csv file/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /upload/i })).toBeDisabled()
  })

  it('shows an error for a file over 10 MB', async () => {
    const user = userEvent.setup()
    render(<CsvUploadModal isOpen onClose={() => {}} />)

    const big = makeCsvFile()
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 })
    await user.upload(getFileInput(), big)

    expect(await screen.findByText(/exceeds 10 MB/i)).toBeInTheDocument()
  })

  it('uploads the file text and shows the queued-count success view', async () => {
    const user = renderOpenWithUploadResult({
      success: true, imported_count: 2, total_rows: 2,
    })

    await user.upload(getFileInput(), makeCsvFile())
    expect(screen.getByText('feedback.csv')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /upload/i }))

    await waitFor(() => {
      expect(mockUploadCsvFeedback).toHaveBeenCalledWith({
        csv_text: CSV,
        default_source: 'csv_upload',
        source_id: 'manual_import',
        column_map: DEFAULT_MAP,
      })
    })
    expect(await screen.findByText(/2 rows queued for processing/i)).toBeInTheDocument()
  })

  it('passes a custom default source label', async () => {
    const user = renderOpenWithUploadResult({
      success: true, imported_count: 1, total_rows: 1,
    })

    const sourceInput = screen.getByPlaceholderText('csv_upload')

    await user.clear(sourceInput)
    await user.type(sourceInput, 'store_reviews')
    await uploadDefaultCsv(user)

    await waitFor(() => {
      expect(mockUploadCsvFeedback).toHaveBeenCalledWith({
        csv_text: CSV,
        default_source: 'store_reviews',
        source_id: 'manual_import',
        column_map: DEFAULT_MAP,
      })
    })
  })

  it('surfaces server warnings in the success view', async () => {
    const user = renderOpenWithUploadResult({
      success: true, imported_count: 1, total_rows: 2,
      warnings: ['row 2: empty text — skipped'],
    })

    await uploadDefaultCsv(user)

    expect(await screen.findByText(/row 2: empty text/i)).toBeInTheDocument()
  })

  it('shows the API error and stays on the form when the upload fails', async () => {
    const user = userEvent.setup()
    mockUploadCsvFeedback.mockRejectedValue(new Error('API Error: 400'))
    render(<CsvUploadModal isOpen onClose={() => {}} />)

    await uploadDefaultCsv(user)

    expect(await screen.findByText(/API Error: 400/i)).toBeInTheDocument()
    // still on the form (no success view)
    expect(screen.queryByText(/queued for processing/i)).not.toBeInTheDocument()
  })

  it('calls onClose from the Cancel button and resets state', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<CsvUploadModal isOpen onClose={onClose} />)

    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from the Done button after a successful upload', async () => {
    const onClose = vi.fn()
    const user = renderOpenWithUploadResult({
      success: true, imported_count: 2, total_rows: 2,
    }, onClose)

    await uploadDefaultCsv(user)
    await user.click(await screen.findByRole('button', { name: /done/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers a template download', () => {
    render(<CsvUploadModal isOpen onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /download template/i })).toBeInTheDocument()
  })

  it('suggests a mapping from the header: fields, dimension columns, and metadata for the rest', async () => {
    const user = renderOpenWithUploadResult({ success: true, imported_count: 1, total_rows: 1 })
    await user.upload(getFileInput(), makeCsvFile('Comment,Product,Region,Labels\n"Login fails",mobile_app,EU,vip\n'))
    const mapping = await screen.findByRole('group', { name: 'Column mapping' })
    expect(within(mapping).getByLabelText('Where Comment goes')).toHaveValue('text')
    expect(within(mapping).getByLabelText('Where Product goes')).toHaveValue('dimension:product')
    expect(within(mapping).getByLabelText('Where Region goes')).toHaveValue('metadata')
    expect(within(mapping).getByLabelText('Where Labels goes')).toHaveValue('tags')
  })

  it('sends the chosen source profile and an edited mapping', async () => {
    const user = renderOpenWithUploadResult({ success: true, imported_count: 1, total_rows: 1 })
    await screen.findByRole('option', { name: 'Sales CSV' })
    await user.selectOptions(screen.getByLabelText('Source'), 'sales_csv')
    const csv = 'Comment,Segment,Internal\n"Great",partner,x\n'
    await user.upload(getFileInput(), makeCsvFile(csv))
    await user.selectOptions(await screen.findByLabelText('Where Segment goes'), 'dimension:user_type')
    await user.selectOptions(screen.getByLabelText('Where Internal goes'), 'ignore')
    await user.click(screen.getByRole('button', { name: /upload/i }))
    await waitFor(() => expect(mockUploadCsvFeedback).toHaveBeenCalledWith({
      csv_text: csv, default_source: 'csv_upload', source_id: 'sales_csv',
      column_map: { Comment: 'text', Segment: 'dimension:user_type', Internal: 'ignore' },
    }))
  })

  it('marks a restricted source and blocks an upload without a text column', async () => {
    const user = renderOpenWithUploadResult({ success: true, imported_count: 1, total_rows: 1 })
    expect(await screen.findByRole('option', { name: 'Support tickets (restricted)' })).toBeInTheDocument()
    await user.upload(getFileInput(), makeCsvFile('Note,When\nhello,2026-01-01\n'))
    expect(await screen.findByRole('status')).toHaveTextContent('Map one column to Feedback text')
    expect(screen.getByRole('button', { name: /upload/i })).toBeDisabled()
  })
})
