/**
 * @fileoverview Tests for CsvUploadModal component (prd-fix #7 / P9).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CsvUploadModal from './CsvUploadModal'

const mockUploadCsvFeedback = vi.fn()

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

describe('CsvUploadModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    const user = userEvent.setup()
    mockUploadCsvFeedback.mockResolvedValue({
      success: true, imported_count: 2, total_rows: 2,
    })
    render(<CsvUploadModal isOpen onClose={() => {}} />)

    await user.upload(getFileInput(), makeCsvFile())
    expect(screen.getByText('feedback.csv')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /upload/i }))

    await waitFor(() => {
      expect(mockUploadCsvFeedback).toHaveBeenCalledWith({
        csv_text: CSV,
        default_source: 'csv_upload',
      })
    })
    expect(await screen.findByText(/2 rows queued for processing/i)).toBeInTheDocument()
  })

  it('passes a custom default source label', async () => {
    const user = userEvent.setup()
    mockUploadCsvFeedback.mockResolvedValue({
      success: true, imported_count: 1, total_rows: 1,
    })
    render(<CsvUploadModal isOpen onClose={() => {}} />)

    const sourceInput = screen.getByPlaceholderText('csv_upload')
    await user.clear(sourceInput)
    await user.type(sourceInput, 'store_reviews')
    await user.upload(getFileInput(), makeCsvFile())
    await user.click(screen.getByRole('button', { name: /upload/i }))

    await waitFor(() => {
      expect(mockUploadCsvFeedback).toHaveBeenCalledWith({
        csv_text: CSV,
        default_source: 'store_reviews',
      })
    })
  })

  it('surfaces server warnings in the success view', async () => {
    const user = userEvent.setup()
    mockUploadCsvFeedback.mockResolvedValue({
      success: true, imported_count: 1, total_rows: 2,
      warnings: ['row 2: empty text — skipped'],
    })
    render(<CsvUploadModal isOpen onClose={() => {}} />)

    await user.upload(getFileInput(), makeCsvFile())
    await user.click(screen.getByRole('button', { name: /upload/i }))

    expect(await screen.findByText(/row 2: empty text/i)).toBeInTheDocument()
  })

  it('shows the API error and stays on the form when the upload fails', async () => {
    const user = userEvent.setup()
    mockUploadCsvFeedback.mockRejectedValue(new Error('API Error: 400'))
    render(<CsvUploadModal isOpen onClose={() => {}} />)

    await user.upload(getFileInput(), makeCsvFile())
    await user.click(screen.getByRole('button', { name: /upload/i }))

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
    const user = userEvent.setup()
    const onClose = vi.fn()
    mockUploadCsvFeedback.mockResolvedValue({
      success: true, imported_count: 2, total_rows: 2,
    })
    render(<CsvUploadModal isOpen onClose={onClose} />)

    await user.upload(getFileInput(), makeCsvFile())
    await user.click(screen.getByRole('button', { name: /upload/i }))
    await user.click(await screen.findByRole('button', { name: /done/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers a template download', () => {
    render(<CsvUploadModal isOpen onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /download template/i })).toBeInTheDocument()
  })
})
