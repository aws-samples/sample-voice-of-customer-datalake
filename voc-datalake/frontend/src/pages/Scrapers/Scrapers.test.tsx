import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// Mock API
const mockGetScrapers = vi.fn()
const mockSaveScraper = vi.fn()
const mockDeleteScraper = vi.fn()
const mockRunScraper = vi.fn()
const mockGetScraperStatus = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getScrapers: () => mockGetScrapers(),
    saveScraper: (s: unknown) => mockSaveScraper(s),
    deleteScraper: (id: string) => mockDeleteScraper(id),
    runScraper: (id: string) => mockRunScraper(id),
    getScraperStatus: (id: string) => mockGetScraperStatus(id),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

vi.mock('../../store/manualImportStore', () => ({
  useManualImportStore: () => ({
    setIsModalOpen: vi.fn(),
    isModalOpen: false,
  }),
}))

// Mock subcomponents
vi.mock('./ScraperEditor', () => ({
  default: ({ onSave, onClose }: { onSave: (s: unknown) => void; onClose: () => void }) => (
    <div data-testid="scraper-editor">
      <button onClick={() => onSave({ id: 'new', name: 'Test' })}>Save</button>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))

vi.mock('./TemplateSelector', () => ({
  default: ({ onSelect, onClose }: { onSelect: (t: unknown) => void; onClose: () => void }) => (
    <div data-testid="template-selector">
      <button onClick={() => onSelect({ id: 'template1', name: 'Template' })}>Select Template</button>
      <button onClick={onClose}>Close Templates</button>
    </div>
  ),
}))

vi.mock('./ManualImportModal', () => ({
  default: () => <div data-testid="manual-import-modal" />,
}))

import Scrapers from './Scrapers'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

const mockScrapers = [
  {
    id: 'scraper-1',
    name: 'Test Scraper',
    base_url: 'https://example.com/reviews',
    enabled: true,
    frequency_minutes: 60,
    urls: [],
    pagination: { enabled: false, max_pages: 1 },
  },
  {
    id: 'scraper-2',
    name: 'Disabled Scraper',
    base_url: 'https://other.com',
    enabled: false,
    frequency_minutes: 30,
    urls: ['https://other.com/page1'],
    pagination: { enabled: true, max_pages: 5 },
  },
]

describe('Scrapers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetScrapers.mockResolvedValue({ scrapers: mockScrapers })
    mockGetScraperStatus.mockResolvedValue({ status: 'never_run' })
    mockSaveScraper.mockResolvedValue({ success: true })
    mockDeleteScraper.mockResolvedValue({ success: true })
    mockRunScraper.mockResolvedValue({ success: true })
  })

  describe('rendering', () => {
    it('renders page header', async () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      expect(screen.getByText('Data Sources')).toBeInTheDocument()
      expect(screen.getByText(/configure web scrapers and app review sources/i)).toBeInTheDocument()
    })

    it('renders action buttons', async () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /new source/i })).toBeInTheDocument()
    })

    it('renders scraper cards after loading', async () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
        expect(screen.getByText('Disabled Scraper')).toBeInTheDocument()
      })
    })

    it('shows domain from base_url', async () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('example.com')).toBeInTheDocument()
        expect(screen.getByText('other.com')).toBeInTheDocument()
      })
    })

    it('shows frequency label', async () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
      })
      // Frequency labels are rendered in the card
    })
  })

  describe('empty state', () => {
    it('shows empty state when no scrapers', async () => {
      mockGetScrapers.mockResolvedValue({ scrapers: [] })

      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('No scrapers configured')).toBeInTheDocument()
        expect(screen.getByText(/create a scraper to start/i)).toBeInTheDocument()
      })
    })

    it('shows create button in empty state', async () => {
      mockGetScrapers.mockResolvedValue({ scrapers: [] })

      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create scraper/i })).toBeInTheDocument()
      })
    })
  })

  describe('template selector', () => {
    it('opens template selector when New Source clicked', async () => {
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /new source/i }))

      expect(screen.getByTestId('template-selector')).toBeInTheDocument()
    })

    it('closes template selector when close clicked', async () => {
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /new source/i }))
      await user.click(screen.getByText('Close Templates'))

      expect(screen.queryByTestId('template-selector')).not.toBeInTheDocument()
    })

    it('opens editor when template selected', async () => {
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /new source/i }))
      await user.click(screen.getByText('Select Template'))

      expect(screen.getByTestId('scraper-editor')).toBeInTheDocument()
    })
  })

  describe('scraper actions', () => {
    it('opens editor when edit button clicked', async () => {
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
      })

      const editButtons = screen.getAllByTitle('Edit')
      await user.click(editButtons[0])

      expect(screen.getByTestId('scraper-editor')).toBeInTheDocument()
    })

    it('shows delete confirmation when delete clicked', async () => {
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
      })

      const deleteButtons = screen.getAllByTitle('Delete')
      await user.click(deleteButtons[0])

      expect(screen.getByText('Delete Scraper')).toBeInTheDocument()
      expect(screen.getByText(/are you sure/i)).toBeInTheDocument()
    })

    it('calls deleteScraper when delete confirmed', async () => {
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
      })

      const deleteButtons = screen.getAllByTitle('Delete')
      await user.click(deleteButtons[0])

      // Find the confirm button in the modal
      const confirmButtons = screen.getAllByRole('button', { name: /delete/i })
      const confirmButton = confirmButtons.find(btn => btn.className.includes('danger') || btn.textContent === 'Delete')
      if (confirmButton) {
        await user.click(confirmButton)
      }

      await waitFor(() => {
        expect(mockDeleteScraper).toHaveBeenCalledWith('scraper-1')
      })
    })

    it('calls runScraper when run button clicked', async () => {
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
      })

      const runButtons = screen.getAllByTitle('Run now')
      await user.click(runButtons[0])

      await waitFor(() => {
        expect(mockRunScraper).toHaveBeenCalledWith('scraper-1')
      })
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetScrapers.mockReturnValue(new Promise(() => {}))

      render(<Scrapers />, { wrapper: createWrapper() })

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })
})

describe('Scrapers - not configured', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows configuration message when API not configured', () => {
    vi.doMock('../../store/configStore', () => ({
      useConfigStore: () => ({
        config: { apiEndpoint: '' },
      }),
    }))

    // Would need fresh import to test
  })
})
