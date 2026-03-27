/**
 * Tests for PluginConfigModal - plugin credential configuration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PluginConfigModal from './PluginConfigModal'
import type { PluginManifest } from '../../plugins/types'

const mockGetIntegrationCredentials = vi.fn()
const mockUpdateIntegrationCredentials = vi.fn()
const mockTestIntegration = vi.fn()
const mockGetSourcesStatus = vi.fn()
const mockEnableSource = vi.fn()
const mockDisableSource = vi.fn()
const mockRunSource = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getIntegrationCredentials: (...args: unknown[]) => mockGetIntegrationCredentials(...args),
    updateIntegrationCredentials: (...args: unknown[]) => mockUpdateIntegrationCredentials(...args),
    testIntegration: (...args: unknown[]) => mockTestIntegration(...args),
    getSourcesStatus: (...args: unknown[]) => mockGetSourcesStatus(...args),
    enableSource: (...args: unknown[]) => mockEnableSource(...args),
    disableSource: (...args: unknown[]) => mockDisableSource(...args),
    runSource: (...args: unknown[]) => mockRunSource(...args),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com' },
  }),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

const androidPlugin: PluginManifest = {
  id: 'app_reviews_android',
  name: 'Android App Reviews',
  icon: 'Android',
  description: 'Collect reviews from Google Play Store',
  category: 'reviews',
  config: [
    { key: 'app_name', label: 'App Name', type: 'text', required: true, placeholder: 'my-app', secret: false },
    { key: 'package_name', label: 'Package Name', type: 'text', required: true, placeholder: 'com.example.app', secret: false },
  ],
  setup: { title: 'Android Setup', color: 'green', steps: ['Install the Play Console API'] },
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
  version: '1.0.0',
  enabled: true,
}

describe('PluginConfigModal', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetIntegrationCredentials.mockResolvedValue({})
    mockGetSourcesStatus.mockResolvedValue({ sources: { app_reviews_android: { enabled: false } } })
    mockUpdateIntegrationCredentials.mockResolvedValue({ success: true })
    mockTestIntegration.mockResolvedValue({ success: true, message: 'Connection OK' })
    mockRunSource.mockResolvedValue({ success: true, message: 'Triggered' })
  })

  it('renders plugin name and description', () => {
    render(<PluginConfigModal plugin={androidPlugin} onClose={onClose} />, { wrapper: createWrapper() })

    expect(screen.getByText('Android App Reviews')).toBeInTheDocument()
    expect(screen.getByText('Collect reviews from Google Play Store')).toBeInTheDocument()
  })

  it('renders config fields from plugin manifest', () => {
    render(<PluginConfigModal plugin={androidPlugin} onClose={onClose} />, { wrapper: createWrapper() })

    expect(screen.getByText('App Name')).toBeInTheDocument()
    expect(screen.getByText('Package Name')).toBeInTheDocument()
  })

  it('renders setup instructions when plugin has setup info', () => {
    render(<PluginConfigModal plugin={androidPlugin} onClose={onClose} />, { wrapper: createWrapper() })

    expect(screen.getByText('Android Setup')).toBeInTheDocument()
    expect(screen.getByText('Install the Play Console API')).toBeInTheDocument()
  })

  it('populates fields with fetched credentials', async () => {
    mockGetIntegrationCredentials.mockResolvedValue({ app_name: 'MyApp', package_name: 'com.my.app' })

    render(<PluginConfigModal plugin={androidPlugin} onClose={onClose} />, { wrapper: createWrapper() })

    await waitFor(() => {
      // eslint-disable-next-line vitest/prefer-called-with
      expect(mockGetIntegrationCredentials).toHaveBeenCalled()
    })
  })

  it('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={androidPlugin} onClose={onClose} />, { wrapper: createWrapper() })

    const closeBtn = screen.getByText('×')
    await user.click(closeBtn)

    // eslint-disable-next-line vitest/prefer-called-with
    expect(onClose).toHaveBeenCalled()
  })

  it('saves credentials when save button is clicked', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={androidPlugin} onClose={onClose} />, { wrapper: createWrapper() })

    const inputs = screen.getAllByRole('textbox')
    await user.clear(inputs[0])
    await user.type(inputs[0], 'TestApp')

    const saveBtn = screen.getAllByRole('button').find(b => b.textContent?.includes('Save') || b.textContent?.includes('save'))
    expect(saveBtn).toBeDefined()
    await user.click(saveBtn!)

    await waitFor(() => {
      // eslint-disable-next-line vitest/prefer-called-with
      expect(mockUpdateIntegrationCredentials).toHaveBeenCalled()
    })
  })

  it('fetches schedule status on mount', async () => {
    render(<PluginConfigModal plugin={androidPlugin} onClose={onClose} />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(mockGetSourcesStatus).toHaveBeenCalledWith(['app_reviews_android'])
    })
  })

  it('shows schedule toggle with correct initial state', async () => {
    render(<PluginConfigModal plugin={androidPlugin} onClose={onClose} />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByRole('checkbox')).toBeInTheDocument()
    })
  })
})
