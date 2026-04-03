/**
 * @fileoverview Tests for S3ImportExplorer component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock API before importing component
const mockGetS3ImportSources = vi.fn()
const mockGetS3ImportFiles = vi.fn()
const mockCreateS3ImportSource = vi.fn()
const mockDeleteS3ImportFile = vi.fn()
const mockGetS3UploadUrl = vi.fn()

vi.mock('../../api/dataExplorerApi', () => ({
  dataExplorerApi: {
    getS3ImportSources: () => mockGetS3ImportSources(),
    getS3ImportFiles: (params: unknown) => mockGetS3ImportFiles(params),
    createS3ImportSource: (name: string) => mockCreateS3ImportSource(name),
    deleteS3ImportFile: (key: string) => mockDeleteS3ImportFile(key),
    getS3UploadUrl: (filename: string, source: string, contentType: string) =>
      mockGetS3UploadUrl(filename, source, contentType),
  },
}))

import S3ImportExplorer from './S3ImportExplorer'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('S3ImportExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetS3ImportSources.mockResolvedValue({
      bucket: 'test-bucket',
      sources: [],
    })
    mockGetS3ImportFiles.mockResolvedValue({ files: [] })
    mockCreateS3ImportSource.mockResolvedValue({ success: true })
    mockDeleteS3ImportFile.mockResolvedValue({ success: true })
  })

  describe('bucket not configured', () => {
    it('shows error when bucket is not configured', async () => {
      mockGetS3ImportSources.mockResolvedValue({ bucket: null, sources: [] })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('S3 Import bucket not configured')).toBeInTheDocument()
      })
    })
  })

  describe('bucket info', () => {
    it('displays bucket name', async () => {
      mockGetS3ImportSources.mockResolvedValue({
        bucket: 'my-import-bucket',
        sources: [],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('my-import-bucket')).toBeInTheDocument()
      })
    })

    it('displays refresh button', async () => {
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
      })
    })
  })

  describe('source selector', () => {
    it('displays source dropdown with All Sources option', async () => {
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument()
        expect(screen.getByText('All Sources')).toBeInTheDocument()
      })
    })

    it('displays available sources in dropdown', async () => {
      mockGetS3ImportSources.mockResolvedValue({
        bucket: 'test-bucket',
        sources: [
          { name: 'webscraper', display_name: 'Web Scraper' },
          { name: 'reviews', display_name: 'Reviews' },
        ],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        const select = screen.getByRole('combobox')
        expect(select).toBeInTheDocument()
      })
      
      const options = screen.getAllByRole('option')
      expect(options.map(o => o.textContent)).toContain('Web Scraper')
      expect(options.map(o => o.textContent)).toContain('Reviews')
    })
  })

  describe('create source', () => {
    it('shows new source input when button is clicked', async () => {
      const user = userEvent.setup()
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /new source/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /new source/i }))
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Source name...')).toBeInTheDocument()
      })
    })

    it('creates source when form is submitted', async () => {
      const user = userEvent.setup()
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /new source/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /new source/i }))
      
      const input = screen.getByPlaceholderText('Source name...')
      await user.type(input, 'new-source')
      await user.click(screen.getByRole('button', { name: /create/i }))
      
      await waitFor(() => {
        expect(mockCreateS3ImportSource).toHaveBeenCalledWith('new-source')
      })
    })

    it('hides input when cancel is clicked', async () => {
      const user = userEvent.setup()
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /new source/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /new source/i }))
      await user.click(screen.getByRole('button', { name: /cancel/i }))
      
      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Source name...')).not.toBeInTheDocument()
      })
    })
  })

  describe('upload area', () => {
    it('displays upload instructions', async () => {
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Drop files here or click to upload')).toBeInTheDocument()
        expect(screen.getByText('Supports CSV, JSON, JSONL')).toBeInTheDocument()
      })
    })
  })

  describe('file list', () => {
    it('shows empty state when no files exist', async () => {
      mockGetS3ImportFiles.mockResolvedValue({ files: [] })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('No files found')).toBeInTheDocument()
      })
    })

    it('displays file count in header', async () => {
      mockGetS3ImportFiles.mockResolvedValue({
        files: [
          { key: 'file1.json', filename: 'file1.json', source: 'default', size: 1024, last_modified: '2025-01-01', status: 'pending' },
          { key: 'file2.csv', filename: 'file2.csv', source: 'default', size: 2048, last_modified: '2025-01-02', status: 'processed' },
        ],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Files (2)')).toBeInTheDocument()
      })
    })

    it('displays file information', async () => {
      mockGetS3ImportFiles.mockResolvedValue({
        files: [
          {
            key: 'default/file1.json',
            filename: 'file1.json',
            source: 'default',
            size: 1024,
            last_modified: '2025-01-15T10:30:00Z',
            status: 'pending',
          },
        ],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('file1.json')).toBeInTheDocument()
        expect(screen.getByText('Pending')).toBeInTheDocument()
      })
    })

    it('shows processed status badge for processed files', async () => {
      mockGetS3ImportFiles.mockResolvedValue({
        files: [
          {
            key: 'default/file1.json',
            filename: 'file1.json',
            source: 'default',
            size: 1024,
            last_modified: '2025-01-15T10:30:00Z',
            status: 'processed',
          },
        ],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Processed')).toBeInTheDocument()
      })
    })
  })

  describe('delete file', () => {
    it('calls delete API when delete button is clicked', async () => {
      const user = userEvent.setup()
      mockGetS3ImportFiles.mockResolvedValue({
        files: [
          {
            key: 'default/file1.json',
            filename: 'file1.json',
            source: 'default',
            size: 1024,
            last_modified: '2025-01-15T10:30:00Z',
            status: 'pending',
          },
        ],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('file1.json')).toBeInTheDocument()
      })
      
      const deleteButton = screen.getByTitle('Delete file')
      await user.click(deleteButton)
      
      await waitFor(() => {
        expect(mockDeleteS3ImportFile).toHaveBeenCalledWith('default/file1.json')
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching files', async () => {
      mockGetS3ImportFiles.mockReturnValue(new Promise(() => {}))
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // eslint-disable-next-line testing-library/no-node-access
        expect(document.querySelector('.animate-spin')).toBeInTheDocument()
      })
    })
  })

  describe('file size formatting', () => {
    it('formats bytes correctly', async () => {
      mockGetS3ImportFiles.mockResolvedValue({
        files: [
          {
            key: 'file1.json',
            filename: 'file1.json',
            source: 'default',
            size: 500,
            last_modified: '2025-01-15T10:30:00Z',
            status: 'pending',
          },
        ],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText(/500 B/)).toBeInTheDocument()
      })
    })

    it('formats kilobytes correctly', async () => {
      mockGetS3ImportFiles.mockResolvedValue({
        files: [
          {
            key: 'file1.json',
            filename: 'file1.json',
            source: 'default',
            size: 2048,
            last_modified: '2025-01-15T10:30:00Z',
            status: 'pending',
          },
        ],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument()
      })
    })

    it('formats megabytes correctly', async () => {
      mockGetS3ImportFiles.mockResolvedValue({
        files: [
          {
            key: 'file1.json',
            filename: 'file1.json',
            source: 'default',
            size: 1048576,
            last_modified: '2025-01-15T10:30:00Z',
            status: 'pending',
          },
        ],
      })
      
      render(<S3ImportExplorer />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText(/1\.0 MB/)).toBeInTheDocument()
      })
    })
  })
})
