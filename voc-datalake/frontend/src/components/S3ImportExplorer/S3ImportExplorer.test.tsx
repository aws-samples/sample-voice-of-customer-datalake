/**
 * @fileoverview Tests for S3ImportExplorer component.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { useLocale } from '../../test/i18n-locale'
import deComponents from '../../../public/locales/de/components.json'
import type { S3ImportFile } from '../../api/types'

vi.mock('../../api/client', () => ({
  api: {
    getS3ImportSources: vi.fn(),
    getS3ImportFiles: vi.fn(),
    createS3ImportSource: vi.fn(),
    deleteS3ImportFile: vi.fn(),
    getS3UploadUrl: vi.fn(),
  },
}))

import { api } from '../../api/client'
import S3ImportExplorer from './S3ImportExplorer'

const mockGetS3ImportSources = vi.mocked(api.getS3ImportSources)
const mockGetS3ImportFiles = vi.mocked(api.getS3ImportFiles)
const mockCreateS3ImportSource = vi.mocked(api.createS3ImportSource)
const mockDeleteS3ImportFile = vi.mocked(api.deleteS3ImportFile)
const mockGetS3UploadUrl = vi.mocked(api.getS3UploadUrl)

const renderExplorer = () => renderWithQueryClient(<S3ImportExplorer />)

/** A listed file with `overrides` applied to the one-file default. */
function importFile(overrides: Partial<S3ImportFile> = {}): S3ImportFile {
  return {
    key: 'default/file1.json',
    filename: 'file1.json',
    source: 'default',
    size: 1024,
    last_modified: '2025-01-15T10:30:00Z',
    status: 'pending',
    ...overrides,
  }
}

/** Mount with `files` listed. */
function renderWithFiles(files: S3ImportFile[]) {
  mockGetS3ImportFiles.mockResolvedValue({ files, bucket: 'test-bucket' })
  return renderExplorer()
}

/** Mount, wait for the "New source" button, and press it. */
async function openNewSourceForm(): Promise<UserEvent> {
  const user = userEvent.setup()
  renderExplorer()
  const button = await screen.findByRole('button', { name: /new source/i })
  await user.click(button)
  return user
}

/** Mount and drop `file` on the upload input (the `accept` filter is off so unsupported types reach the component). */
async function uploadFile(file: File) {
  const user = userEvent.setup({ applyAccept: false })
  renderExplorer()
  await user.upload(await screen.findByLabelText('Drop files here or click to upload'), file)
}

function resetApiMocks() {
  vi.clearAllMocks()
  mockGetS3ImportSources.mockResolvedValue({ bucket: 'test-bucket', sources: [] })
  mockGetS3ImportFiles.mockResolvedValue({ files: [], bucket: 'test-bucket' })
  mockCreateS3ImportSource.mockResolvedValue({ success: true })
  mockDeleteS3ImportFile.mockResolvedValue({ success: true })
}

describe('S3ImportExplorer', () => {
  beforeEach(resetApiMocks)

  describe('bucket not configured', () => {
    it('shows error when bucket is not configured', async () => {
      mockGetS3ImportSources.mockResolvedValue({ bucket: null, sources: [] })

      renderExplorer()

      expect(await screen.findByText('S3 Import bucket not configured')).toBeInTheDocument()
    })
  })

  describe('bucket info', () => {
    it('displays bucket name', async () => {
      mockGetS3ImportSources.mockResolvedValue({ bucket: 'my-import-bucket', sources: [] })

      renderExplorer()

      expect(await screen.findByText('my-import-bucket')).toBeInTheDocument()
      expect(screen.getByText('Bucket:')).toBeInTheDocument()
    })

    it('displays refresh button', async () => {
      renderExplorer()

      expect(await screen.findByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
  })

  describe('source selector', () => {
    it('displays source dropdown with All Sources option', async () => {
      renderExplorer()

      expect(await screen.findByRole('combobox', { name: 'All Sources' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: 'All Sources' })).toBeInTheDocument()
    })

    it('displays available sources in dropdown', async () => {
      mockGetS3ImportSources.mockResolvedValue({
        bucket: 'test-bucket',
        sources: [
          { name: 'webscraper', display_name: 'Web Scraper' },
          { name: 'reviews', display_name: 'Reviews' },
        ],
      })

      renderExplorer()
      await screen.findByRole('option', { name: 'Reviews' })

      expect(screen.getAllByRole('option').map((o) => o.textContent)).toStrictEqual(['All Sources', 'Web Scraper', 'Reviews'])
    })
  })

  describe('create source', () => {
    it('shows new source input when button is clicked', async () => {
      await openNewSourceForm()

      expect(await screen.findByPlaceholderText('Source name...')).toBeInTheDocument()
    })

    it('creates source when form is submitted', async () => {
      const user = await openNewSourceForm()

      await user.type(screen.getByPlaceholderText('Source name...'), 'new-source')
      await user.click(screen.getByRole('button', { name: /create/i }))

      await waitFor(() => {
        expect(mockCreateS3ImportSource).toHaveBeenCalledWith('new-source')
      })
    })

    it('hides input when cancel is clicked', async () => {
      const user = await openNewSourceForm()

      await user.click(screen.getByRole('button', { name: /cancel/i }))

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Source name...')).not.toBeInTheDocument()
      })
    })
  })

  describe('upload area', () => {
    it('displays upload instructions', async () => {
      renderExplorer()

      expect(await screen.findByText('Drop files here or click to upload')).toBeInTheDocument()
      expect(screen.getByText('Supports CSV, JSON, JSONL')).toBeInTheDocument()
    })
  })

  describe('uploading', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))))
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('rejects an unsupported file type without asking for an upload URL', async () => {
      await uploadFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))

      expect(await screen.findByText('Unsupported file type: notes.txt. Only CSV, JSON, and JSONL files are supported.')).toBeInTheDocument()
      expect(mockGetS3UploadUrl).not.toHaveBeenCalled()
    })

    it('PUTs the file to the presigned URL into the default source and reports success', async () => {
      mockGetS3UploadUrl.mockResolvedValue({ success: true, upload_url: 'https://s3.example/put' })

      await uploadFile(new File(['a,b'], 'reviews.csv', { type: 'text/csv' }))

      expect(await screen.findByText('Uploaded reviews.csv')).toBeInTheDocument()
      expect(mockGetS3UploadUrl).toHaveBeenCalledWith('reviews.csv', 'default', 'text/csv')
      expect(fetch).toHaveBeenCalledWith('https://s3.example/put', expect.objectContaining({ method: 'PUT', headers: { 'Content-Type': 'text/csv' } }))
    })

    it('reports a missing upload URL with the translated fallback reason', async () => {
      mockGetS3UploadUrl.mockResolvedValue({ success: false })

      await uploadFile(new File(['{}'], 'data.json', { type: 'application/json' }))

      expect(await screen.findByText('Failed to upload data.json: Failed to get upload URL')).toBeInTheDocument()
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('file list', () => {
    it('shows empty state when no files exist', async () => {
      renderWithFiles([])

      expect(await screen.findByText('No files found')).toBeInTheDocument()
    })

    it('displays file count in header', async () => {
      renderWithFiles([
        importFile({ key: 'file1.json' }),
        importFile({ key: 'file2.csv', filename: 'file2.csv', size: 2048, last_modified: '2025-01-02', status: 'processed' }),
      ])

      expect(await screen.findByText('Files (2)')).toBeInTheDocument()
    })

    it('displays file information', async () => {
      renderWithFiles([importFile()])

      expect(await screen.findByText('file1.json')).toBeInTheDocument()
      expect(screen.getByText('Pending')).toBeInTheDocument()
    })

    it('shows processed status badge for processed files', async () => {
      renderWithFiles([importFile({ status: 'processed' })])

      expect(await screen.findByText('Processed')).toBeInTheDocument()
    })
  })

  describe('delete file', () => {
    it('calls delete API when delete button is clicked', async () => {
      const user = userEvent.setup()
      renderWithFiles([importFile()])

      await user.click(await screen.findByRole('button', { name: 'Delete file' }))

      await waitFor(() => {
        expect(mockDeleteS3ImportFile).toHaveBeenCalledWith('default/file1.json')
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching files', async () => {
      mockGetS3ImportFiles.mockReturnValue(new Promise(() => {}))

      renderExplorer()

      await waitFor(() => {
        expect(document.querySelector('.animate-spin')).toBeInTheDocument()
      })
    })
  })

  describe('file size formatting', () => {
    it.each([
      ['bytes', 500, /500 B/],
      ['kilobytes', 2048, /2\.0 KB/],
      ['megabytes', 1048576, /1\.0 MB/],
    ])('formats %s correctly', async (_unit, size, rendered) => {
      renderWithFiles([importFile({ key: 'file1.json', size })])

      expect(await screen.findByText(rendered)).toBeInTheDocument()
    })
  })
})

// Every suite above runs under `en`, where a literal and its translation are the
// same string; this one renders under `de`, so it fails if a literal comes back.
// Expected strings are read from the shipped catalogue, not restated.
describe('S3ImportExplorer under German', () => {
  const de = deComponents.s3Import

  useLocale('de', { components: deComponents })

  beforeEach(resetApiMocks)

  it('translates the toolbar, selector and upload area', async () => {
    renderExplorer()

    expect(await screen.findByRole('button', { name: de.refresh })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: de.allSources })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: de.newSource })).toBeInTheDocument()
    expect(screen.getByText(de.dropFiles)).toBeInTheDocument()
  })

  it('translates the file list and formats the date in the UI language', async () => {
    const file = importFile()
    renderWithFiles([file])

    expect(await screen.findByText(de.pending)).toBeInTheDocument()
    expect(screen.getByText(de.filesCount_other.replace('{{count}}', '1'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: de.deleteFile })).toBeInTheDocument()
    expect(screen.getByText(new Date(file.last_modified).toLocaleString('de', { dateStyle: 'medium', timeStyle: 'short' }), { exact: false })).toBeInTheDocument()
  })

  it('translates the not-configured state', async () => {
    mockGetS3ImportSources.mockResolvedValue({ bucket: null, sources: [] })

    renderExplorer()

    expect(await screen.findByText(de.notConfigured)).toBeInTheDocument()
  })
})
