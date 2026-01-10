/**
 * @fileoverview Tests for S3Browser component
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import S3Browser from './S3Browser'

const mockData = {
  bucket: 'voc-raw-data',
  prefix: 'raw/',
  objects: [
    { key: 'twitter/', fullKey: 'raw/twitter/', size: 0, lastModified: '2025-01-01T00:00:00Z', isFolder: true },
    { key: 'trustpilot/', fullKey: 'raw/trustpilot/', size: 0, lastModified: '2025-01-01T00:00:00Z', isFolder: true },
    { key: 'feedback-001.json', fullKey: 'raw/feedback-001.json', size: 1024, lastModified: '2025-01-15T10:30:00Z', isFolder: false },
    { key: 'image.png', fullKey: 'raw/image.png', size: 2048, lastModified: '2025-01-15T11:00:00Z', isFolder: false },
  ],
}

describe('S3Browser', () => {
  const defaultProps = {
    path: [] as string[],
    data: mockData,
    loading: false,
    onNavigateToFolder: vi.fn(),
    onNavigateUp: vi.fn(),
    onNavigateToBreadcrumb: vi.fn(),
    onView: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onDownload: vi.fn(),
  }

  describe('rendering', () => {
    it('renders bucket name in breadcrumb', () => {
      render(<S3Browser {...defaultProps} />)

      expect(screen.getByText('voc-raw-data')).toBeInTheDocument()
    })

    it('renders folders', () => {
      render(<S3Browser {...defaultProps} />)

      expect(screen.getByText('twitter/')).toBeInTheDocument()
      expect(screen.getByText('trustpilot/')).toBeInTheDocument()
    })

    it('renders files with size', () => {
      render(<S3Browser {...defaultProps} />)

      expect(screen.getByText('feedback-001.json')).toBeInTheDocument()
      expect(screen.getByText(/1\.0 KB/)).toBeInTheDocument()
    })

    it('renders path breadcrumbs', () => {
      render(<S3Browser {...defaultProps} path={['raw', 'twitter']} />)

      expect(screen.getByText('raw')).toBeInTheDocument()
      expect(screen.getByText('twitter')).toBeInTheDocument()
    })

    it('shows back button when in subfolder', () => {
      render(<S3Browser {...defaultProps} path={['raw']} />)

      expect(screen.getByText('Back')).toBeInTheDocument()
    })

    it('hides back button at root', () => {
      render(<S3Browser {...defaultProps} path={[]} />)

      expect(screen.queryByText('Back')).not.toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('shows loading spinner when loading', () => {
      render(<S3Browser {...defaultProps} loading={true} />)

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('shows empty message when no objects', () => {
      render(<S3Browser {...defaultProps} data={{ ...mockData, objects: [] }} />)

      expect(screen.getByText('No files found')).toBeInTheDocument()
    })
  })

  describe('navigation', () => {
    it('calls onNavigateToFolder when folder clicked', async () => {
      const onNavigateToFolder = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} onNavigateToFolder={onNavigateToFolder} />)

      await user.click(screen.getByText('twitter/'))
      expect(onNavigateToFolder).toHaveBeenCalledWith('twitter/')
    })

    it('calls onNavigateUp when back button clicked', async () => {
      const onNavigateUp = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} path={['raw']} onNavigateUp={onNavigateUp} />)

      await user.click(screen.getByText('Back'))
      expect(onNavigateUp).toHaveBeenCalled()
    })

    it('calls onNavigateToBreadcrumb when breadcrumb clicked', async () => {
      const onNavigateToBreadcrumb = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} path={['raw', 'twitter']} onNavigateToBreadcrumb={onNavigateToBreadcrumb} />)

      await user.click(screen.getByText('raw'))
      expect(onNavigateToBreadcrumb).toHaveBeenCalledWith(0)
    })

    it('calls onNavigateToBreadcrumb with -1 when bucket clicked', async () => {
      const onNavigateToBreadcrumb = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} onNavigateToBreadcrumb={onNavigateToBreadcrumb} />)

      await user.click(screen.getByText('voc-raw-data'))
      expect(onNavigateToBreadcrumb).toHaveBeenCalledWith(-1)
    })
  })

  describe('file actions', () => {
    it('calls onView when file clicked', async () => {
      const onView = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} onView={onView} />)

      await user.click(screen.getByText('feedback-001.json'))
      expect(onView).toHaveBeenCalledWith('raw/feedback-001.json')
    })

    it('calls onView when view button clicked', async () => {
      const onView = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} onView={onView} />)

      const viewButtons = screen.getAllByTitle('View')
      await user.click(viewButtons[0])
      expect(onView).toHaveBeenCalled()
    })

    it('calls onEdit when edit button clicked', async () => {
      const onEdit = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} onEdit={onEdit} />)

      const editButtons = screen.getAllByTitle('Edit')
      await user.click(editButtons[0])
      expect(onEdit).toHaveBeenCalledWith('raw/feedback-001.json')
    })

    it('calls onDelete when delete button clicked', async () => {
      const onDelete = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} onDelete={onDelete} />)

      const deleteButtons = screen.getAllByTitle('Delete')
      await user.click(deleteButtons[0])
      expect(onDelete).toHaveBeenCalled()
    })

    it('calls onDownload when download button clicked', async () => {
      const onDownload = vi.fn()
      const user = userEvent.setup()

      render(<S3Browser {...defaultProps} onDownload={onDownload} />)

      const downloadButtons = screen.getAllByTitle('Download')
      await user.click(downloadButtons[0])
      expect(onDownload).toHaveBeenCalled()
    })

    it('does not show edit button for image files', () => {
      render(<S3Browser {...defaultProps} />)

      // There should be 1 edit button (for json file) not 2
      const editButtons = screen.getAllByTitle('Edit')
      expect(editButtons).toHaveLength(1)
    })
  })

  describe('file size formatting', () => {
    it('formats bytes correctly', () => {
      const smallFile = {
        ...mockData,
        objects: [{ key: 'small.json', fullKey: 'small.json', size: 500, lastModified: '2025-01-01', isFolder: false }],
      }

      render(<S3Browser {...defaultProps} data={smallFile} />)
      expect(screen.getByText(/500 B/)).toBeInTheDocument()
    })

    it('formats KB correctly', () => {
      render(<S3Browser {...defaultProps} />)
      expect(screen.getByText(/1\.0 KB/)).toBeInTheDocument()
    })

    it('formats MB correctly', () => {
      const largeFile = {
        ...mockData,
        objects: [{ key: 'large.json', fullKey: 'large.json', size: 2 * 1024 * 1024, lastModified: '2025-01-01', isFolder: false }],
      }

      render(<S3Browser {...defaultProps} data={largeFile} />)
      expect(screen.getByText(/2\.0 MB/)).toBeInTheDocument()
    })
  })
})
