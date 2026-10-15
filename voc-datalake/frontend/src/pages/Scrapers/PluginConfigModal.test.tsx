import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PluginConfigModal from './PluginConfigModal'
// Imported rather than restated: the subject of these assertions is the GATE, not
// the wording, so a later decision to translate the tooltip must not fail a test
// about admin access. See the constant's own docstring for why it is still English.
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
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
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    expect(screen.getByText('Android App Reviews')).toBeInTheDocument()
    expect(screen.getByText('Collect reviews from Google Play Store')).toBeInTheDocument()
  })

  it('displays configured apps after loading', async () => {
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getByText('Zara')).toBeInTheDocument()
      expect(screen.getByText('H&M')).toBeInTheDocument()
    })
  })

  it('shows empty state when no apps configured', async () => {
    mockGetAppConfigs.mockResolvedValue({ apps: [] })
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('No apps configured yet')).toBeInTheDocument() })
  })

  it('opens add form when Add App clicked', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    await user.click(screen.getByRole('button', { name: /add app/i }))
    expect(screen.getByText('Add New App')).toBeInTheDocument()
  })

  it('saves new app config when form submitted', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
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
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    const deleteButtons = screen.getAllByTitle('Delete')
    await user.click(deleteButtons[0])
    expect(screen.getByText('Delete App')).toBeInTheDocument()
  })

  it('calls close when Close button clicked', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await user.click(screen.getByRole('button', { name: /close/i }))
    // eslint-disable-next-line vitest/prefer-called-with
    expect(onClose).toHaveBeenCalled()
  })

  it('shows Run Now when apps exist', async () => {
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument()
  })

  it('hides Run Now when no apps', async () => {
    mockGetAppConfigs.mockResolvedValue({ apps: [] })
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('No apps configured yet')).toBeInTheDocument() })
    expect(screen.queryByRole('button', { name: /run now/i })).not.toBeInTheDocument()
  })

  it('cancels add form without saving', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    await user.click(screen.getByRole('button', { name: /add app/i }))
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.queryByText('Add New App')).not.toBeInTheDocument()
    expect(mockSaveAppConfig).not.toHaveBeenCalled()
  })

  /**
   * Every mutating route this modal calls is admin-gated server-side:
   * POST/DELETE `/integrations/{source}/apps`, `POST /sources/{source}/run` and
   * `PUT /sources/{source}/enable|disable`. None of them was, so a caller whose
   * only Cognito group was `users` could write the shared secret and invoke an
   * ingestor. The server is what refuses now; these cases pin that the UI does not
   * hand a non-admin a control that answers 403.
   *
   * Each asserts the API mock was NOT called, not merely that the button is
   * disabled: `disabled` on a styled button is easy to render and easy to bypass,
   * and the request not being issued is the observable the user actually gets.
   */
  describe('when the user is not an admin', () => {
    it('does not trigger a run', async () => {
      const user = userEvent.setup()
      render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin={false} />, { wrapper: createWrapper() })
      await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })

      const run = screen.getByRole('button', { name: /run now/i })
      expect(run).toBeDisabled()
      expect(run).toHaveAttribute('title', ADMIN_ONLY_TITLE)
      await user.click(run)
      expect(mockRunSource).not.toHaveBeenCalled()
    })

    it('does not toggle the schedule', async () => {
      const user = userEvent.setup()
      render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin={false} />, { wrapper: createWrapper() })
      await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })

      const toggle = screen.getByRole('checkbox')
      expect(toggle).toBeDisabled()
      await user.click(toggle)
      expect(mockEnableSource).not.toHaveBeenCalled()
      expect(mockDisableSource).not.toHaveBeenCalled()
    })

    it('does not open the editor, so nothing can be saved', async () => {
      const user = userEvent.setup()
      render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin={false} />, { wrapper: createWrapper() })
      await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })

      const add = screen.getByRole('button', { name: /add app/i })
      expect(add).toBeDisabled()
      await user.click(add)
      expect(screen.queryByText('Add New App')).not.toBeInTheDocument()
      expect(mockSaveAppConfig).not.toHaveBeenCalled()
    })

    it('does not delete an app config', async () => {
      const user = userEvent.setup()
      render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin={false} />, { wrapper: createWrapper() })
      await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })

      // Located by its position in the per-app row rather than by title: `title` is
      // what the assertion is ABOUT, so selecting on it would find the Run button
      // (which carries the same title) and pass with the delete gate removed. There
      // is one delete button per app; the two apps are the loaded fixture.
      const perApp = screen.getAllByRole('button')
        .filter((el) => el.getAttribute('title') === ADMIN_ONLY_TITLE
          && el.querySelector('svg.lucide-trash2') !== null)
      expect(perApp).toHaveLength(2)

      await user.click(perApp[0])
      // No confirmation dialog, so the mutation is unreachable rather than merely
      // guarded at the last step.
      expect(screen.queryByText('Delete App')).not.toBeInTheDocument()
      expect(mockDeleteAppConfig).not.toHaveBeenCalled()
    })

    it('still lists the app configs, which is deliberately not gated', async () => {
      // Non-vacuity, and the property the gates must not cost: GET
      // /integrations/{source}/apps stays open to any authenticated caller, so a
      // non-admin sees the same list. Without this, hiding the whole modal would
      // satisfy every case above.
      render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin={false} />, { wrapper: createWrapper() })
      await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
      expect(screen.getByText('H&M')).toBeInTheDocument()
    })
  })
})
