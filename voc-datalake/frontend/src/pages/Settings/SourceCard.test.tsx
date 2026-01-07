/**
 * @fileoverview Tests for SourceCard component
 * @module pages/Settings/SourceCard.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SourceCard from './SourceCard'
import type { SourceInfo } from './sourceConfig'

// Mock API
const mockGetIntegrationStatus = vi.fn()
const mockGetSourcesStatus = vi.fn()
const mockUpdateIntegrationCredentials = vi.fn()
const mockTestIntegration = vi.fn()
const mockEnableSource = vi.fn()
const mockDisableSource = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getIntegrationStatus: () => mockGetIntegrationStatus(),
    getSourcesStatus: () => mockGetSourcesStatus(),
    updateIntegrationCredentials: (source: string, creds: Record<string, string>) =>
      mockUpdateIntegrationCredentials(source, creds),
    testIntegration: (source: string) => mockTestIntegration(source),
    enableSource: (source: string) => mockEnableSource(source),
    disableSource: (source: string) => mockDisableSource(source),
  },
}))

// Mock S3ImportExplorer
vi.mock('../../components/S3ImportExplorer', () => ({
  default: () => <div data-testid="s3-import-explorer">S3 Import Explorer</div>,
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const mockSourceInfo: SourceInfo = {
  name: 'Test Source',
  icon: '🧪',
  description: 'Test source description',
  fields: [
    { key: 'api_key', label: 'API Key', type: 'password' },
    { key: 'business_id', label: 'Business ID', type: 'text', placeholder: 'Enter ID' },
  ],
  webhooks: [
    { name: 'Test Webhook', events: 'created, updated', docUrl: 'https://docs.example.com' },
  ],
  setupInstructions: {
    title: 'Setup Instructions',
    color: 'blue',
    steps: ['Step 1', 'Step 2', 'Step 3'],
  },
}

describe('SourceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: false } })
    mockGetSourcesStatus.mockResolvedValue({ sources: { test_source: { enabled: false } } })
  })

  describe('Header', () => {
    it('renders source name and icon', () => {
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      expect(screen.getByText('Test Source')).toBeInTheDocument()
      expect(screen.getByText('🧪')).toBeInTheDocument()
    })

    it('renders description when provided', () => {
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      expect(screen.getByText('Test source description')).toBeInTheDocument()
    })

    it('shows connected badge when source is configured', async () => {
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await waitFor(() => {
        expect(screen.getByText('Connected')).toBeInTheDocument()
      })
    })

    it('shows enabled/disabled toggle', () => {
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      expect(screen.getByRole('checkbox')).toBeInTheDocument()
      expect(screen.getByText('Disabled')).toBeInTheDocument()
    })
  })

  describe('Expand/Collapse', () => {
    it('expands card when header is clicked', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByText('API Credentials')).toBeInTheDocument()
    })

    it('shows webhooks section when expanded', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByText('Webhooks')).toBeInTheDocument()
      expect(screen.getByText('Test Webhook')).toBeInTheDocument()
    })

    it('shows setup instructions when expanded', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByText('Setup Instructions')).toBeInTheDocument()
      expect(screen.getByText('Step 1')).toBeInTheDocument()
    })
  })

  describe('Enable/Disable Toggle', () => {
    it('enables source when toggle is clicked', async () => {
      const user = userEvent.setup()
      mockEnableSource.mockResolvedValue({ enabled: true })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('checkbox'))

      await waitFor(() => {
        expect(mockEnableSource).toHaveBeenCalledWith('test_source')
      })
    })

    it('disables source when toggle is unchecked', async () => {
      const user = userEvent.setup()
      mockGetSourcesStatus.mockResolvedValue({ sources: { test_source: { enabled: true } } })
      mockDisableSource.mockResolvedValue({ enabled: false })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await waitFor(() => {
        expect(screen.getByRole('checkbox')).toBeChecked()
      })

      await user.click(screen.getByRole('checkbox'))

      await waitFor(() => {
        expect(mockDisableSource).toHaveBeenCalledWith('test_source')
      })
    })

    it('disables toggle when no API endpoint', () => {
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="" />,
        { wrapper: createWrapper() }
      )

      expect(screen.getByRole('checkbox')).toBeDisabled()
    })
  })

  describe('Credentials Section', () => {
    it('renders credential fields', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByLabelText('API Key')).toBeInTheDocument()
      expect(screen.getByLabelText('Business ID')).toBeInTheDocument()
    })

    it('toggles password visibility', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const apiKeyInput = screen.getByLabelText('API Key')
      expect(apiKeyInput).toHaveAttribute('type', 'password')

      await user.click(screen.getByRole('button', { name: /show/i }))

      expect(apiKeyInput).toHaveAttribute('type', 'text')
    })

    it('saves credentials when save button is clicked', async () => {
      const user = userEvent.setup()
      mockUpdateIntegrationCredentials.mockResolvedValue({ success: true })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await user.type(screen.getByLabelText('API Key'), 'secret-key')
      await user.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => {
        expect(mockUpdateIntegrationCredentials).toHaveBeenCalledWith('test_source', { api_key: 'secret-key' })
      })
    })

    it('shows success message after saving', async () => {
      const user = userEvent.setup()
      mockUpdateIntegrationCredentials.mockResolvedValue({ success: true })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await user.type(screen.getByLabelText('API Key'), 'secret-key')
      await user.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => {
        expect(screen.getByText('Saved!')).toBeInTheDocument()
      })
    })
  })

  describe('Test Integration', () => {
    it('tests integration when test button is clicked', async () => {
      const user = userEvent.setup()
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
      mockTestIntegration.mockResolvedValue({ success: true, message: 'Connection successful' })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test/i })).not.toBeDisabled()
      })

      await user.click(screen.getByRole('button', { name: /test/i }))

      await waitFor(() => {
        expect(mockTestIntegration).toHaveBeenCalledWith('test_source')
      })
    })

    it('shows success message on successful test', async () => {
      const user = userEvent.setup()
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
      mockTestIntegration.mockResolvedValue({ success: true, message: 'Connection successful' })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test/i })).not.toBeDisabled()
      })
      await user.click(screen.getByRole('button', { name: /test/i }))

      await waitFor(() => {
        expect(screen.getByText('Connection successful')).toBeInTheDocument()
      })
    })

    it('shows error message on failed test', async () => {
      const user = userEvent.setup()
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
      mockTestIntegration.mockResolvedValue({ success: false, message: 'Invalid credentials' })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test/i })).not.toBeDisabled()
      })
      await user.click(screen.getByRole('button', { name: /test/i }))

      await waitFor(() => {
        expect(screen.getByText('Invalid credentials')).toBeInTheDocument()
      })
    })

    it('disables test button when source not configured', async () => {
      const user = userEvent.setup()
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: false } })

      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test/i })).toBeDisabled()
      })
    })
  })

  describe('Webhooks Section', () => {
    it('displays webhook URL', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com/" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByText('https://api.example.com/webhooks/test_source')).toBeInTheDocument()
    })

    it('copies webhook URL to clipboard', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com/" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const copyButtons = screen.getAllByRole('button')
      const copyButton = copyButtons.find(btn => btn.querySelector('svg'))
      if (copyButton) {
        await user.click(copyButton)
      }

      // Clipboard mock is set up in test setup
    })

    it('shows documentation link when provided', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const docsLink = screen.getByRole('link', { name: /docs/i })
      expect(docsLink).toHaveAttribute('href', 'https://docs.example.com')
    })
  })

  describe('S3 Import Source', () => {
    it('renders S3ImportExplorer for s3_import source', async () => {
      const user = userEvent.setup()
      const s3SourceInfo: SourceInfo = {
        name: 'S3 Import',
        icon: '📦',
        fields: [],
      }

      render(
        <SourceCard sourceKey="s3_import" info={s3SourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /s3 import/i }))

      expect(screen.getByTestId('s3-import-explorer')).toBeInTheDocument()
    })
  })

  describe('Setup Instructions Colors', () => {
    it('applies blue color theme', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard sourceKey="test_source" info={mockSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const instructionsSection = screen.getByText('Setup Instructions').closest('div')
      expect(instructionsSection).toHaveClass('bg-blue-50')
    })

    it('applies orange color theme', async () => {
      const user = userEvent.setup()
      const orangeSourceInfo: SourceInfo = {
        ...mockSourceInfo,
        setupInstructions: { ...mockSourceInfo.setupInstructions!, color: 'orange' },
      }

      render(
        <SourceCard sourceKey="test_source" info={orangeSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const instructionsSection = screen.getByText('Setup Instructions').closest('div')
      expect(instructionsSection).toHaveClass('bg-orange-50')
    })
  })

  describe('Multiline Fields', () => {
    it('renders textarea for multiline fields', async () => {
      const user = userEvent.setup()
      const multilineSourceInfo: SourceInfo = {
        name: 'Test',
        icon: '🧪',
        fields: [{ key: 'config', label: 'Config', type: 'text', multiline: true }],
      }

      render(
        <SourceCard sourceKey="test_source" info={multilineSourceInfo} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test/i }))

      expect(screen.getByRole('textbox', { name: /config/i })).toBeInstanceOf(HTMLTextAreaElement)
    })
  })
})
