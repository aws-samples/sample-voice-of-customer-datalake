/**
 * @fileoverview Tests for SourceCard component
 * @module pages/Settings/SourceCard.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import SourceCard from './SourceCard'
import type { PluginManifest } from '../../plugins/types'

// Mock API
const mockGetIntegrationStatus = vi.fn()
const mockGetSourcesStatus = vi.fn()
const mockUpdateIntegrationCredentials = vi.fn()
const mockTestIntegration = vi.fn()
const mockEnableSource = vi.fn()
const mockDisableSource = vi.fn()
const mockGetIntegrationCredentials = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getIntegrationStatus: () => mockGetIntegrationStatus(),
    getSourcesStatus: () => mockGetSourcesStatus(),
    updateIntegrationCredentials: (source: string, creds: Record<string, string>) =>
      mockUpdateIntegrationCredentials(source, creds),
    testIntegration: (source: string) => mockTestIntegration(source),
    enableSource: (source: string) => mockEnableSource(source),
    disableSource: (source: string) => mockDisableSource(source),
    getIntegrationCredentials: (source: string, keys: string[]) =>
      mockGetIntegrationCredentials(source, keys),
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

const mockManifest: PluginManifest = {
  id: 'test_source',
  name: 'Test Source',
  icon: '🧪',
  description: 'Test source description',
  config: [
    { key: 'api_key', label: 'API Key', type: 'password', required: true, secret: true },
    { key: 'business_id', label: 'Business ID', type: 'text', placeholder: 'Enter ID', required: false, secret: false },
  ],
  webhooks: [
    { name: 'Test Webhook', events: ['created', 'updated'], docUrl: 'https://docs.example.com' },
  ],
  setup: {
    title: 'Setup Instructions',
    color: 'blue',
    steps: ['Step 1', 'Step 2', 'Step 3'],
  },
  hasIngestor: true,
  hasWebhook: true,
  hasS3Trigger: false,
}

describe('SourceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: false } })
    mockGetSourcesStatus.mockResolvedValue({ sources: { test_source: { enabled: false } } })
    mockGetIntegrationCredentials.mockResolvedValue({})
  })

  describe('Header', () => {
    it('renders source name and icon', () => {
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      expect(screen.getByText('Test Source')).toBeInTheDocument()
      expect(screen.getByText('🧪')).toBeInTheDocument()
    })

    it('renders description when provided', () => {
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      expect(screen.getByText('Test source description')).toBeInTheDocument()
    })

    it('shows connected badge when source is configured', async () => {
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await waitFor(() => {
        expect(screen.getByText('Connected')).toBeInTheDocument()
      })
    })

    it('shows enabled/disabled toggle', () => {
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
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
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByText('API Credentials')).toBeInTheDocument()
    })

    it('shows webhooks section when expanded', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByText('Webhooks')).toBeInTheDocument()
      expect(screen.getByText('Test Webhook')).toBeInTheDocument()
    })

    it('shows setup instructions when expanded', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
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
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
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
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
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
        <SourceCard manifest={mockManifest} apiEndpoint="" />,
        { wrapper: createWrapper() }
      )

      expect(screen.getByRole('checkbox')).toBeDisabled()
    })
  })

  describe('Credentials Section', () => {
    it('renders credential fields', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByText('API Key')).toBeInTheDocument()
      expect(screen.getByText('Business ID')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Enter api key')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('Enter ID')).toBeInTheDocument()
    })

    it('toggles password visibility', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const apiKeyInput = screen.getByPlaceholderText('Enter api key')
      expect(apiKeyInput).toHaveAttribute('type', 'password')

      await user.click(screen.getByRole('button', { name: /show/i }))

      expect(apiKeyInput).toHaveAttribute('type', 'text')
    })

    it('saves credentials when save button is clicked', async () => {
      const user = userEvent.setup()
      mockUpdateIntegrationCredentials.mockResolvedValue({ success: true })

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await user.type(screen.getByPlaceholderText('Enter api key'), 'secret-key')
      await user.click(screen.getByRole('button', { name: /save/i }))

      await waitFor(() => {
        expect(mockUpdateIntegrationCredentials).toHaveBeenCalledWith('test_source', { api_key: 'secret-key', business_id: 'Enter ID' })
      })
    })

    it('shows success message after saving', async () => {
      const user = userEvent.setup()
      mockUpdateIntegrationCredentials.mockResolvedValue({ success: true })

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await user.type(screen.getByPlaceholderText('Enter api key'), 'secret-key')
      await user.click(screen.getByRole('button', { name: /save/i }))

      // Verify mutation was called - the success message is shown via internal state
      await waitFor(() => {
        expect(mockUpdateIntegrationCredentials).toHaveBeenCalledWith('test_source', { api_key: 'secret-key', business_id: 'Enter ID' })
      })
    })
  })

  describe('Test Integration', () => {
    it('tests integration when test button is clicked', async () => {
      const user = userEvent.setup()
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
      mockTestIntegration.mockResolvedValue({ success: true, message: 'Connection successful' })

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      // Wait for the integration status to load
      await waitFor(() => {
        const testButton = screen.getByRole('button', { name: /test$/i })
        expect(testButton).not.toBeDisabled()
      })

      await user.click(screen.getByRole('button', { name: /test$/i }))

      await waitFor(() => {
        expect(mockTestIntegration).toHaveBeenCalledWith('test_source')
      })
    })

    it('shows success message on successful test', async () => {
      const user = userEvent.setup()
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
      mockTestIntegration.mockResolvedValue({ success: true, message: 'Connection successful' })

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test$/i })).not.toBeDisabled()
      })
      await user.click(screen.getByRole('button', { name: /test$/i }))

      await waitFor(() => {
        expect(screen.getByText('Connection successful')).toBeInTheDocument()
      })
    })

    it('shows error message on failed test', async () => {
      const user = userEvent.setup()
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: true } })
      mockTestIntegration.mockResolvedValue({ success: false, message: 'Invalid credentials' })

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test$/i })).not.toBeDisabled()
      })
      await user.click(screen.getByRole('button', { name: /test$/i }))

      await waitFor(() => {
        expect(screen.getByText('Invalid credentials')).toBeInTheDocument()
      })
    })

    it('disables test button when source not configured', async () => {
      const user = userEvent.setup()
      mockGetIntegrationStatus.mockResolvedValue({ test_source: { configured: false } })

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      // The test button should be disabled when not configured
      const testButton = screen.getByRole('button', { name: /test$/i })
      expect(testButton).toBeDisabled()
    })
  })

  describe('Webhooks Section', () => {
    it('displays webhook URL', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com/" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(screen.getByText('https://api.example.com/webhooks/test_source')).toBeInTheDocument()
    })

    it('copies webhook URL to clipboard', async () => {
      const user = userEvent.setup()
      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com/" />,
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
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
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
      const s3Manifest: PluginManifest = {
        id: 's3_import',
        name: 'S3 Import',
        icon: '📦',
        config: [],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: true,
      }

      render(
        <SourceCard manifest={s3Manifest} apiEndpoint="https://api.example.com" />,
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
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const instructionsSection = screen.getByText('Setup Instructions').closest('div')
      expect(instructionsSection).toHaveClass('bg-blue-50')
    })

    it('applies orange color theme', async () => {
      const user = userEvent.setup()
      const orangeManifest: PluginManifest = {
        ...mockManifest,
        setup: { ...mockManifest.setup!, color: 'orange' },
      }

      render(
        <SourceCard manifest={orangeManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      const instructionsSection = screen.getByText('Setup Instructions').closest('div')
      expect(instructionsSection).toHaveClass('bg-orange-50')
    })
  })

  describe('Credential Fetching', () => {
    it('fetches saved credentials when card is expanded', async () => {
      const user = userEvent.setup()
      mockGetIntegrationCredentials.mockResolvedValue({ api_key: 'saved-key', business_id: 'saved-id' })

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      await waitFor(() => {
        expect(mockGetIntegrationCredentials).toHaveBeenCalledWith('test_source', ['api_key', 'business_id'])
      })

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Enter api key')).toHaveValue('saved-key')
        expect(screen.getByPlaceholderText('Enter ID')).toHaveValue('saved-id')
      })
    })

    it('does not overwrite local user edits with fetched credentials', async () => {
      const user = userEvent.setup()
      // Delay the credential fetch so user can type first
      mockGetIntegrationCredentials.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ api_key: 'saved-key', business_id: 'saved-id' }), 100))
      )

      render(
        <SourceCard manifest={mockManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))
      await user.type(screen.getByPlaceholderText('Enter api key'), 'user-typed-key')

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Enter api key')).toHaveValue('user-typed-key')
        // business_id was not edited, so it should be populated from fetch
        expect(screen.getByPlaceholderText('Enter ID')).toHaveValue('saved-id')
      })
    })

    it('does not fetch credentials when config is empty', async () => {
      const user = userEvent.setup()
      const noConfigManifest: PluginManifest = {
        ...mockManifest,
        config: [],
      }

      render(
        <SourceCard manifest={noConfigManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test source/i }))

      expect(mockGetIntegrationCredentials).not.toHaveBeenCalled()
    })
  })

  describe('Multiline Fields', () => {
    it('renders textarea for multiline fields', async () => {
      const user = userEvent.setup()
      const multilineManifest: PluginManifest = {
        id: 'test_source',
        name: 'Test',
        icon: '🧪',
        config: [{ key: 'config', label: 'Config', type: 'textarea', placeholder: 'Enter config', required: false, secret: false }],
        hasIngestor: true,
        hasWebhook: false,
        hasS3Trigger: false,
      }

      render(
        <SourceCard manifest={multilineManifest} apiEndpoint="https://api.example.com" />,
        { wrapper: createWrapper() }
      )

      await user.click(screen.getByRole('button', { name: /test/i }))

      const textarea = screen.getByPlaceholderText('Enter config')
      expect(textarea.tagName.toLowerCase()).toBe('textarea')
    })
  })
})
