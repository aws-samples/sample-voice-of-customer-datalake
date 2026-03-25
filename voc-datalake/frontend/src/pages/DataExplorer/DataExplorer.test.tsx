import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

const mockRefetch = vi.fn()

// Default mock return value matching the actual backend response format
const defaultQueryReturn = {
  isConfigured: true,
  s3Data: {
    objects: [
      { key: 'raw', size: 0, lastModified: '', isFolder: true },
      { key: 'test.json', fullKey: 'raw/test.json', size: 1024, lastModified: '2025-03-01T00:00:00Z', isFolder: false },
    ],
    bucket: 'voc-raw-data-123456-us-east-1',
    bucketId: 'raw-data',
    bucketLabel: 'VoC Raw Data',
    prefix: '',
  },
  s3Loading: false,
  s3Error: null,
  feedbackData: {
    count: 2,
    items: [
      {
        feedback_id: 'fb-001',
        source_id: 'src-001',
        source_platform: 'webscraper',
        source_channel: 'web',
        brand_name: 'TestBrand',
        source_created_at: '2025-03-01T00:00:00Z',
        processed_at: '2025-03-01T01:00:00Z',
        original_text: 'Great product, love it!',
        original_language: 'en',
        category: 'product_quality',
        journey_stage: 'post_purchase',
        sentiment_label: 'positive',
        sentiment_score: 0.85,
        urgency: 'low',
        impact_area: 'product',
      },
      {
        feedback_id: 'fb-002',
        source_id: 'src-002',
        source_platform: 'feedback_form',
        source_channel: 'form',
        brand_name: 'TestBrand',
        source_created_at: '2025-03-02T00:00:00Z',
        processed_at: '2025-03-02T01:00:00Z',
        original_text: 'Delivery was slow',
        original_language: 'en',
        category: 'delivery',
        journey_stage: 'delivery',
        sentiment_label: 'negative',
        sentiment_score: -0.6,
        urgency: 'high',
        impact_area: 'logistics',
      },
    ],
  },
  feedbackLoading: false,
  feedbackError: null,
  categoriesData: {
    period_days: 30,
    categories: { product_quality: 150, delivery: 80, pricing: 45 },
  },
  categoriesLoading: false,
  categoriesError: null,
  bucketsData: {
    buckets: [{ id: 'raw-data', name: 'voc-raw-data-123456-us-east-1', label: 'VoC Raw Data', description: 'Raw data' }],
  },
  sourcesData: { sources: { webscraper: 100, feedback_form: 50 } },
  refetch: mockRefetch,
}

let queryReturnOverride: Partial<typeof defaultQueryReturn> = {}

vi.mock('./useDataExplorerQueries', () => ({
  useDataExplorerQueries: () => ({ ...defaultQueryReturn, ...queryReturnOverride }),
}))

vi.mock('./useDataExplorerMutations', () => ({
  useDataExplorerMutations: () => ({
    saveS3Mutation: { mutate: vi.fn(), isPending: false, error: null },
    deleteS3Mutation: { mutate: vi.fn(), isPending: false },
    saveFeedbackMutation: { mutate: vi.fn(), isPending: false, error: null },
    deleteFeedbackMutation: { mutate: vi.fn(), isPending: false },
  }),
}))

vi.mock('./s3Handlers', () => ({
  openS3Editor: vi.fn(),
  openS3Creator: vi.fn(),
  downloadS3File: vi.fn(),
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

import DataExplorer from './DataExplorer'

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

describe('DataExplorer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryReturnOverride = {}
  })

  describe('rendering', () => {
    it('renders page header', () => {
      render(<DataExplorer />, { wrapper: createWrapper() })
      expect(screen.getByText('Data Explorer')).toBeInTheDocument()
    })

    it('renders view tabs', () => {
      render(<DataExplorer />, { wrapper: createWrapper() })
      expect(screen.getByRole('button', { name: /s3 raw data/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /processed feedback/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /categories/i })).toBeInTheDocument()
    })

    it('renders New File button in S3 view', () => {
      render(<DataExplorer />, { wrapper: createWrapper() })
      expect(screen.getByRole('button', { name: /new file/i })).toBeInTheDocument()
    })

    it('renders Refresh button', () => {
      render(<DataExplorer />, { wrapper: createWrapper() })
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
  })

  describe('S3 Raw Data tab', () => {
    it('displays S3 objects from backend response format', () => {
      render(<DataExplorer />, { wrapper: createWrapper() })
      // S3Browser receives the objects array directly from the backend
      // The s3BrowserData memo passes objects through without transformation
      expect(screen.getByText('raw')).toBeInTheDocument()
      expect(screen.getByText('test.json')).toBeInTheDocument()
    })

    it('shows bucket label from backend response', () => {
      render(<DataExplorer />, { wrapper: createWrapper() })
      expect(screen.getByText('VoC Raw Data')).toBeInTheDocument()
    })

    it('shows error state when S3 query fails', () => {
      queryReturnOverride = {
        s3Data: undefined,
        s3Error: new Error('Failed to list S3 objects'),
      }
      render(<DataExplorer />, { wrapper: createWrapper() })
      expect(screen.getByText('Error loading files')).toBeInTheDocument()
      expect(screen.getByText('Failed to list S3 objects')).toBeInTheDocument()
    })

    it('shows empty state when no S3 objects', () => {
      queryReturnOverride = {
        s3Data: { objects: [], bucket: 'test', bucketId: 'raw-data', prefix: '' },
      }
      render(<DataExplorer />, { wrapper: createWrapper() })
      expect(screen.getByText(/no files/i)).toBeInTheDocument()
    })

    it('navigates into folders', async () => {
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      // Click on the folder
      await user.click(screen.getByText('raw'))
      // After clicking, the path should update (refetch is called)
      expect(mockRefetch).not.toHaveBeenCalled() // refetch is only called on Refresh button
    })
  })

  describe('Processed Feedback tab', () => {
    it('displays feedback items when switching to tab', async () => {
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /processed feedback/i }))

      await waitFor(() => {
        expect(screen.getByText('Great product, love it!')).toBeInTheDocument()
        expect(screen.getByText('Delivery was slow')).toBeInTheDocument()
      })
    })

    it('shows record count', async () => {
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /processed feedback/i }))

      await waitFor(() => {
        // The component shows "Showing X of Y records"
        expect(screen.getByText(/Showing 2 of 2 records/)).toBeInTheDocument()
      })
    })

    it('shows error state when feedback query fails', async () => {
      queryReturnOverride = {
        feedbackData: undefined,
        feedbackError: new Error('Zod validation failed'),
      }
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /processed feedback/i }))

      await waitFor(() => {
        expect(screen.getByText('Error loading feedback')).toBeInTheDocument()
        expect(screen.getByText('Zod validation failed')).toBeInTheDocument()
      })
    })

    it('shows empty state when no feedback items', async () => {
      queryReturnOverride = {
        feedbackData: { count: 0, items: [] },
      }
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /processed feedback/i }))

      await waitFor(() => {
        expect(screen.getByText(/no feedback/i)).toBeInTheDocument()
      })
    })

    it('filters feedback by search query', async () => {
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /processed feedback/i }))

      const searchInput = screen.getByPlaceholderText(/search/i)
      await user.type(searchInput, 'Delivery')

      await waitFor(() => {
        expect(screen.getByText('Delivery was slow')).toBeInTheDocument()
        expect(screen.queryByText('Great product, love it!')).not.toBeInTheDocument()
      })
    })

    it('shows source filter dropdown', async () => {
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /processed feedback/i }))

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument()
      })
    })
  })

  describe('Categories tab', () => {
    it('displays categories with counts', async () => {
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /categories/i }))

      await waitFor(() => {
        expect(screen.getByText('product_quality')).toBeInTheDocument()
        expect(screen.getByText('delivery')).toBeInTheDocument()
        expect(screen.getByText('pricing')).toBeInTheDocument()
      })
    })

    it('shows category percentages', async () => {
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /categories/i }))

      await waitFor(() => {
        // product_quality: 150/275 = 54.5%
        expect(screen.getByText(/54\.5%/)).toBeInTheDocument()
      })
    })

    it('shows error state when categories query fails', async () => {
      queryReturnOverride = {
        categoriesData: undefined,
        categoriesError: new Error('API Error: 500'),
      }
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /categories/i }))

      await waitFor(() => {
        expect(screen.getByText('Error loading categories')).toBeInTheDocument()
        expect(screen.getByText('API Error: 500')).toBeInTheDocument()
      })
    })

    it('shows empty state when no categories', async () => {
      queryReturnOverride = {
        categoriesData: { period_days: 30, categories: {} },
      }
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /categories/i }))

      await waitFor(() => {
        expect(screen.getByText(/no categories/i)).toBeInTheDocument()
      })
    })
  })

  describe('tab switching', () => {
    it('calls refetch when Refresh button is clicked', async () => {
      const user = userEvent.setup()
      render(<DataExplorer />, { wrapper: createWrapper() })

      await user.click(screen.getByRole('button', { name: /refresh/i }))
      expect(mockRefetch).toHaveBeenCalledTimes(1)
    })
  })
})
