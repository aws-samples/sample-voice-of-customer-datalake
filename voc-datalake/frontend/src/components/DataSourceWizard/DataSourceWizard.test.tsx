/**
 * @fileoverview Tests for DataSourceWizard component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import DataSourceWizard, { defaultContextConfig, type ContextConfig } from './DataSourceWizard'
import { Sparkles } from 'lucide-react'

// Mock API before importing component
const mockGetSources = vi.fn()
const mockGetCategoriesConfig = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getSources: (days: number) => mockGetSources(days),
    getCategoriesConfig: () => mockGetCategoriesConfig(),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: { apiEndpoint: 'https://api.example.com' },
  })),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const mockPersonas = [
  { persona_id: 'p1', name: 'Power User', tagline: 'Uses all features', description: '', pain_points: [], goals: [], behaviors: [], demographics: {} },
  { persona_id: 'p2', name: 'Casual User', tagline: 'Basic usage', description: '', pain_points: [], goals: [], behaviors: [], demographics: {} },
]

const mockDocuments = [
  { document_id: 'd1', title: 'Product PRD', document_type: 'prd', content: '', created_at: '', updated_at: '' },
  { document_id: 'd2', title: 'Research Report', document_type: 'research', content: '', created_at: '', updated_at: '' },
]

const defaultProps = {
  title: 'Test Wizard',
  accentColor: 'purple' as const,
  icon: <Sparkles data-testid="wizard-icon" />,
  personas: mockPersonas,
  documents: mockDocuments,
  contextConfig: defaultContextConfig,
  onContextChange: vi.fn(),
  renderFinalStep: () => <div data-testid="final-step">Final Step Content</div>,
  finalStepValid: true,
  onClose: vi.fn(),
  onSubmit: vi.fn(),
  isSubmitting: false,
  submitLabel: 'Generate',
}

describe('DataSourceWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSources.mockResolvedValue({ sources: { twitter: 100, instagram: 50 } })
    mockGetCategoriesConfig.mockResolvedValue({
      categories: [
        { id: 'delivery', name: 'delivery', description: 'Delivery Issues' },
        { id: 'quality', name: 'quality', description: 'Product Quality' },
      ],
    })
  })

  describe('header', () => {
    it('displays wizard title', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Test Wizard')).toBeInTheDocument()
    })

    it('displays step indicator', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/step 1 of/i)).toBeInTheDocument()
    })

    it('displays wizard icon', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      expect(screen.getByTestId('wizard-icon')).toBeInTheDocument()
    })

    it('displays close button', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      expect(screen.getByLabelText('Close wizard')).toBeInTheDocument()
    })
  })

  describe('close functionality', () => {
    it('calls onClose when close button is clicked', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      
      render(<DataSourceWizard {...defaultProps} onClose={onClose} />, { wrapper: createWrapper() })
      
      await user.click(screen.getByLabelText('Close wizard'))
      
      expect(onClose).toHaveBeenCalled()
    })
  })

  describe('data sources step', () => {
    it('displays Customer Feedback option', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Customer Feedback')).toBeInTheDocument()
    })

    it('displays Personas option when personas exist', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      // The component shows "Personas (2)" format
      expect(screen.getByText(/Personas/)).toBeInTheDocument()
    })

    it('displays persona count', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/\(2\)/)).toBeInTheDocument()
    })

    it('calls onContextChange when feedback checkbox is toggled', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          onContextChange={onContextChange}
          contextConfig={{ ...defaultContextConfig, useFeedback: true }}
        />, 
        { wrapper: createWrapper() }
      )
      
      const checkbox = screen.getByRole('checkbox', { name: /customer feedback/i })
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ useFeedback: false })
      )
    })

    it('calls onContextChange when personas checkbox is toggled', async () => {
      const user = userEvent.setup()
      const onContextChange = vi.fn()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          onContextChange={onContextChange}
        />, 
        { wrapper: createWrapper() }
      )
      
      const checkbox = screen.getByRole('checkbox', { name: /personas/i })
      await user.click(checkbox)
      
      expect(onContextChange).toHaveBeenCalledWith(
        expect.objectContaining({ usePersonas: true })
      )
    })
  })

  describe('navigation', () => {
    it('displays Back button disabled on first step', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      const backButton = screen.getByRole('button', { name: /back/i })
      expect(backButton).toBeDisabled()
    })

    it('displays Next button on non-final steps', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument()
    })

    it('advances to next step when Next is clicked', async () => {
      const user = userEvent.setup()
      
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/step 2 of/i)).toBeInTheDocument()
      })
    })

    it('goes back when Back is clicked', async () => {
      const user = userEvent.setup()
      
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      // Go to step 2
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/step 2 of/i)).toBeInTheDocument()
      })
      
      // Go back to step 1
      await user.click(screen.getByRole('button', { name: /back/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/step 1 of/i)).toBeInTheDocument()
      })
    })
  })

  describe('feedback filters step', () => {
    it('displays sources section when feedback is enabled', async () => {
      const user = userEvent.setup()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          contextConfig={{ ...defaultContextConfig, useFeedback: true }}
        />, 
        { wrapper: createWrapper() }
      )
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Sources')).toBeInTheDocument()
      })
    })

    it('displays categories section', async () => {
      const user = userEvent.setup()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          contextConfig={{ ...defaultContextConfig, useFeedback: true }}
        />, 
        { wrapper: createWrapper() }
      )
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Categories')).toBeInTheDocument()
      })
    })

    it('displays sentiments section', async () => {
      const user = userEvent.setup()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          contextConfig={{ ...defaultContextConfig, useFeedback: true }}
        />, 
        { wrapper: createWrapper() }
      )
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Sentiments')).toBeInTheDocument()
      })
    })

    it('displays time range selector', async () => {
      const user = userEvent.setup()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          contextConfig={{ ...defaultContextConfig, useFeedback: true }}
        />, 
        { wrapper: createWrapper() }
      )
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Time Range')).toBeInTheDocument()
      })
    })
  })

  describe('final step', () => {
    it('renders custom final step content', async () => {
      const user = userEvent.setup()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          contextConfig={{ ...defaultContextConfig, useFeedback: false }}
        />, 
        { wrapper: createWrapper() }
      )
      
      // Navigate to final step (only 2 steps when feedback is disabled)
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByTestId('final-step')).toBeInTheDocument()
      })
    })

    it('displays submit button on final step', async () => {
      const user = userEvent.setup()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          contextConfig={{ ...defaultContextConfig, useFeedback: false }}
        />, 
        { wrapper: createWrapper() }
      )
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument()
      })
    })

    it('calls onSubmit when submit button is clicked', async () => {
      const user = userEvent.setup()
      const onSubmit = vi.fn()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          onSubmit={onSubmit}
          contextConfig={{ ...defaultContextConfig, useFeedback: false }}
        />, 
        { wrapper: createWrapper() }
      )
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument()
      })
      
      await user.click(screen.getByRole('button', { name: /generate/i }))
      
      expect(onSubmit).toHaveBeenCalled()
    })

    it('disables submit button when finalStepValid is false', async () => {
      const user = userEvent.setup()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          finalStepValid={false}
          contextConfig={{ ...defaultContextConfig, useFeedback: false }}
        />, 
        { wrapper: createWrapper() }
      )
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        const submitButton = screen.getByRole('button', { name: /generate/i })
        expect(submitButton).toBeDisabled()
      })
    })

    it('shows loading state when isSubmitting is true', async () => {
      const user = userEvent.setup()
      
      render(
        <DataSourceWizard 
          {...defaultProps} 
          isSubmitting={true}
          contextConfig={{ ...defaultContextConfig, useFeedback: false }}
        />, 
        { wrapper: createWrapper() }
      )
      
      await user.click(screen.getByRole('button', { name: /next/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Processing...')).toBeInTheDocument()
      })
    })
  })

  describe('progress bar', () => {
    it('displays progress bar', () => {
      render(<DataSourceWizard {...defaultProps} />, { wrapper: createWrapper() })
      
      const progressBar = document.querySelector('.h-1.bg-gray-100')
      expect(progressBar).toBeInTheDocument()
    })
  })

  describe('accent colors', () => {
    it('applies purple accent color', () => {
      render(
        <DataSourceWizard {...defaultProps} accentColor="purple" />, 
        { wrapper: createWrapper() }
      )
      
      const nextButton = screen.getByRole('button', { name: /next/i })
      expect(nextButton).toHaveClass('bg-purple-600')
    })

    it('applies blue accent color', () => {
      render(
        <DataSourceWizard {...defaultProps} accentColor="blue" />, 
        { wrapper: createWrapper() }
      )
      
      const nextButton = screen.getByRole('button', { name: /next/i })
      expect(nextButton).toHaveClass('bg-blue-600')
    })

    it('applies amber accent color', () => {
      render(
        <DataSourceWizard {...defaultProps} accentColor="amber" />, 
        { wrapper: createWrapper() }
      )
      
      const nextButton = screen.getByRole('button', { name: /next/i })
      expect(nextButton).toHaveClass('bg-amber-600')
    })

    it('applies green accent color', () => {
      render(
        <DataSourceWizard {...defaultProps} accentColor="green" />, 
        { wrapper: createWrapper() }
      )
      
      const nextButton = screen.getByRole('button', { name: /next/i })
      expect(nextButton).toHaveClass('bg-green-600')
    })
  })

  describe('hideDataSources', () => {
    it('hides feedback option when specified', () => {
      render(
        <DataSourceWizard {...defaultProps} hideDataSources={['feedback']} />, 
        { wrapper: createWrapper() }
      )
      
      expect(screen.queryByText('Customer Feedback')).not.toBeInTheDocument()
    })

    it('hides personas option when specified', () => {
      render(
        <DataSourceWizard {...defaultProps} hideDataSources={['personas']} />, 
        { wrapper: createWrapper() }
      )
      
      expect(screen.queryByText(/personas \(/i)).not.toBeInTheDocument()
    })
  })

  describe('empty states', () => {
    it('does not show personas option when no personas exist', () => {
      render(
        <DataSourceWizard {...defaultProps} personas={[]} />, 
        { wrapper: createWrapper() }
      )
      
      expect(screen.queryByText(/personas \(/i)).not.toBeInTheDocument()
    })

    it('does not show documents option when no documents exist', () => {
      render(
        <DataSourceWizard {...defaultProps} documents={[]} />, 
        { wrapper: createWrapper() }
      )
      
      expect(screen.queryByText(/existing documents/i)).not.toBeInTheDocument()
    })
  })
})
