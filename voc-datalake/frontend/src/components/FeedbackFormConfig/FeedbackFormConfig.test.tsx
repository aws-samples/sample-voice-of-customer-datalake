/**
 * @fileoverview Tests for FeedbackFormConfig component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock stores and API before importing component
const mockGetFeedbackFormConfig = vi.fn()
const mockSaveFeedbackFormConfig = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedbackFormConfig: () => mockGetFeedbackFormConfig(),
    saveFeedbackFormConfig: (config: unknown) => mockSaveFeedbackFormConfig(config),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: { apiEndpoint: 'https://api.example.com' },
  })),
}))

import FeedbackFormConfig from './FeedbackFormConfig'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('FeedbackFormConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetFeedbackFormConfig.mockResolvedValue({ config: null })
    mockSaveFeedbackFormConfig.mockResolvedValue({ success: true })
  })

  describe('loading state', () => {
    it('shows loading indicator while fetching config', () => {
      mockGetFeedbackFormConfig.mockReturnValue(new Promise(() => {}))
      
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })
  })

  describe('enable toggle', () => {
    it('displays enable checkbox', async () => {
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Enable Feedback Form')).toBeInTheDocument()
      })
    })

    it('shows Disabled status when form is disabled', async () => {
      mockGetFeedbackFormConfig.mockResolvedValue({ config: { enabled: false } })
      
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Disabled')).toBeInTheDocument()
      })
    })

    it('shows Active status when form is enabled', async () => {
      mockGetFeedbackFormConfig.mockResolvedValue({ config: { enabled: true } })
      
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Active')).toBeInTheDocument()
      })
    })
  })

  describe('tabs', () => {
    it('displays all three tabs', async () => {
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /embed/i })).toBeInTheDocument()
      })
    })

    it('shows settings tab content by default', async () => {
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Form Title')).toBeInTheDocument()
        expect(screen.getByText('Description')).toBeInTheDocument()
      })
    })

    it('switches to theme tab when clicked', async () => {
      const user = userEvent.setup()
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /theme/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Primary Color')).toBeInTheDocument()
        expect(screen.getByText('Background Color')).toBeInTheDocument()
      })
    })

    it('switches to embed tab when clicked', async () => {
      const user = userEvent.setup()
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /embed/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /embed/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Script Embed (Recommended)')).toBeInTheDocument()
        expect(screen.getByText('iFrame Embed (Alternative)')).toBeInTheDocument()
      })
    })
  })

  describe('settings tab', () => {
    it('displays form title input with default value', async () => {
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // Find the input by its value since label isn't properly associated
        const input = screen.getByDisplayValue('Share Your Feedback')
        expect(input).toBeInTheDocument()
      })
    })

    it('displays rating type selector', async () => {
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Enable Rating')).toBeInTheDocument()
      })
    })

    it('displays collect name and email checkboxes', async () => {
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Collect Name')).toBeInTheDocument()
        expect(screen.getByText('Collect Email')).toBeInTheDocument()
      })
    })
  })

  describe('theme tab', () => {
    it('displays color pickers', async () => {
      const user = userEvent.setup()
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /theme/i }))
      
      await waitFor(() => {
        // Labels exist but aren't associated with inputs via htmlFor
        expect(screen.getByText('Primary Color')).toBeInTheDocument()
        expect(screen.getByText('Text Color')).toBeInTheDocument()
        expect(screen.getByText('Border Radius')).toBeInTheDocument()
      })
    })

    it('displays preview section', async () => {
      const user = userEvent.setup()
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /theme/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Preview (Typeform-style)')).toBeInTheDocument()
      })
    })
  })

  describe('embed tab', () => {
    it('shows warning when form is disabled', async () => {
      const user = userEvent.setup()
      mockGetFeedbackFormConfig.mockResolvedValue({ config: { enabled: false } })
      
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /embed/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /embed/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/enable the feedback form above/i)).toBeInTheDocument()
      })
    })

    it('displays embed code snippets', async () => {
      const user = userEvent.setup()
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /embed/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /embed/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/VoC Feedback Form Widget/)).toBeInTheDocument()
      })
    })

    it('displays copy buttons for embed codes', async () => {
      const user = userEvent.setup()
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /embed/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /embed/i }))
      
      await waitFor(() => {
        const copyButtons = screen.getAllByRole('button', { name: /copy/i })
        expect(copyButtons.length).toBeGreaterThanOrEqual(2)
      })
    })
  })

  describe('save functionality', () => {
    it('calls save API when save button is clicked', async () => {
      const user = userEvent.setup()
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /save/i }))
      
      await waitFor(() => {
        expect(mockSaveFeedbackFormConfig).toHaveBeenCalled()
      })
    })

    it('shows Saved! text after successful save', async () => {
      const user = userEvent.setup()
      mockSaveFeedbackFormConfig.mockResolvedValue({ success: true })
      
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /save/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Saved!')).toBeInTheDocument()
      })
    })
  })

  describe('form field updates', () => {
    it('updates form title when input changes', async () => {
      const user = userEvent.setup()
      render(<FeedbackFormConfig />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByDisplayValue('Share Your Feedback')).toBeInTheDocument()
      })
      
      const input = screen.getByDisplayValue('Share Your Feedback')
      await user.clear(input)
      await user.type(input, 'Custom Title')
      
      expect(input).toHaveValue('Custom Title')
    })
  })
})
