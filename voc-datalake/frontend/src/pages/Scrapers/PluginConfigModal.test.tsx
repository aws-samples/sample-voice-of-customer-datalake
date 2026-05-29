import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PluginConfigModal from './PluginConfigModal'
import type { PluginManifest } from '../../plugins/types'

const mockGetAppConfigs = vi.fn()
const mockSaveAppConfig = vi.fn()
const mockDeleteAppConfig = vi.fn()
const mockGetSourcesStatus = vi.fn()
const mockRunSource = vi.fn()
const mockEnableSource = vi.fn()
const mockDisableSource = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getAppConfigs: (s: string) => mockGetAppConfigs(s),
    saveAppConfig: (s: string, a: Record<string, string>) => mockSaveAppConfig(s, a),
    deleteAppConfig: (s: string, id: string) => mockDeleteAppConfig(s, id),
    getSourcesStatus: (s: string[]) => mockGetSourcesStatus(s),
    enableSource: (s: string) => mockEnableSource(s),
    disableSource: (s: string) => mockDisableSource(s),
    runSource: (s: string) => mockRunSource(s),
  },
}))
vi.mock('../../store/configStore', () => ({ useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }) }))

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const plugin: PluginManifest = {
  id: 'app_reviews_android', name: 'Android App Reviews', icon: 'Android',
  description: 'Collect reviews from Google Play Store', category: 'reviews',
  config: [
    { key: 'app_name', label: 'App Name', type: 'text', required: true, placeholder: 'my-app', secret: false },
    { key: 'package_name', label: 'Package Name', type: 'text', required: true, placeholder: 'com.example.app', secret: false },
  ],
  setup: { title: 'Android Setup', color: 'green', steps: ['Step 1'] },
  hasIngestor: true, hasWebhook: false, hasS3Trigger: false, version: '1.0.0', enabled: true,
}

const mockApps = [
  { id: 'a1', app_name: 'Zara', package_name: 'com.inditex.zara' },
  { id: 'a2', app_name: 'H&M', package_name: 'com.hm.app' },
]

describe('PluginConfigModal', () => {
  const onClose = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAppConfigs.mockResolvedValue({ apps: mockApps })
    mockGetSourcesStatus.mockResolvedValue({ sources: { app_reviews_android: { enabled: false } } })
    mockSaveAppConfig.mockResolvedValue({ success: true, app: {} })
    mockDeleteAppConfig.mockResolvedValue({ success: true })
    mockRunSource.mockResolvedValue({ success: true, message: 'Triggered' })
  })

  it('renders plugin name and description', () => {
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    expect(screen.getByText('Android App Reviews')).toBeInTheDocument()
    expect(screen.getByText('Collect reviews from Google Play Store')).toBeInTheDocument()
  })

  it('displays configured apps after loading', async () => {
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Zara')).toBeInTheDocument()
      expect(screen.getByText('H&M')).toBeInTheDocument()
    })
  })

  it('shows empty state when no apps configured', async () => {
    mockGetAppConfigs.mockResolvedValue({ apps: [] })
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('No apps configured yet')).toBeInTheDocument() })
  })

  it('opens add form when Add App clicked', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    await user.click(screen.getByRole('button', { name: /add app/i }))
    expect(screen.getByText('Add New App')).toBeInTheDocument()
  })

  it('saves new app config when form submitted', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    await user.click(screen.getByRole('button', { name: /add app/i }))
    await user.type(screen.getByPlaceholderText('my-app'), 'Nike')
    await user.type(screen.getByPlaceholderText('com.example.app'), 'com.nike.app')
    await user.click(screen.getByRole('button', { name: /add app$/i }))
    await waitFor(() => {
      expect(mockSaveAppConfig).toHaveBeenCalledWith('app_reviews_android', expect.objectContaining({ app_name: 'Nike', package_name: 'com.nike.app' }))
    })
  })

  it('shows delete confirmation when delete clicked', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    const deleteButtons = screen.getAllByTitle('Delete')
    await user.click(deleteButtons[0])
    expect(screen.getByText('Delete App')).toBeInTheDocument()
  })

  it('calls close when Close button clicked', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await user.click(screen.getByRole('button', { name: /close/i }))
    // eslint-disable-next-line vitest/prefer-called-with
    expect(onClose).toHaveBeenCalled()
  })

  it('shows Run Now when apps exist', async () => {
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument()
  })

  it('hides Run Now when no apps', async () => {
    mockGetAppConfigs.mockResolvedValue({ apps: [] })
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('No apps configured yet')).toBeInTheDocument() })
    expect(screen.queryByRole('button', { name: /run now/i })).not.toBeInTheDocument()
  })

  it('cancels add form without saving', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    await user.click(screen.getByRole('button', { name: /add app/i }))
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByText('Add New App')).not.toBeInTheDocument()
    expect(mockSaveAppConfig).not.toHaveBeenCalled()
  })
})
