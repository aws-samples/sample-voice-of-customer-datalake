import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createQueryWrapper } from '../Categories/categories-fixtures'
import { expectScheduleToggleLocked, sourceScheduleMocks } from './scrapers-fixtures'
import PluginConfigModal from './PluginConfigModal'
// Imported rather than restated: the subject of these assertions is the GATE, not
// the wording, so a later decision to translate the tooltip must not fail a test
// about admin access. See the constant's own docstring for why it is still English.
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import type { PluginManifest } from '../../plugins/types'
import { at } from '@test/defined'

const mockGetAppConfigs = vi.fn<(...args: unknown[]) => unknown>()
const mockSaveAppConfig = vi.fn<(...args: unknown[]) => unknown>()
const mockDeleteAppConfig = vi.fn<(...args: unknown[]) => unknown>()
const mockGetSourcesStatus = vi.fn<(...args: unknown[]) => unknown>()
const mockRunSource = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getAppConfigs: (s: string) => mockGetAppConfigs(s),
    saveAppConfig: (s: string, a: Record<string, string>) => mockSaveAppConfig(s, a),
    deleteAppConfig: (s: string, id: string) => mockDeleteAppConfig(s, id),
    getSourcesStatus: (s: string[]) => mockGetSourcesStatus(s),
    enableSource: (s: string) => sourceScheduleMocks.enableSource(s),
    disableSource: (s: string) => sourceScheduleMocks.disableSource(s),
    runSource: (s: string) => mockRunSource(s),
  },
}))
vi.mock('../../store/configStore', () => ({ useConfigStore: () => ({ config: { apiEndpoint: 'https://api.example.com' } }) }))

const createWrapper = () => createQueryWrapper()

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

  /** Render the modal and wait for the configured apps to load; returns a user for interaction. */
  async function renderLoaded(isAdmin: boolean) {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin={isAdmin} />, { wrapper: createWrapper() })
    await waitFor(() => { expect(screen.getByText('Zara')).toBeInTheDocument() })
    return user
  }

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
    await user.click(at(deleteButtons, 0))
    expect(screen.getByText('Delete App')).toBeInTheDocument()
  })

  it('calls close when Close button clicked', async () => {
    const user = userEvent.setup()
    render(<PluginConfigModal plugin={plugin} onClose={onClose} isAdmin />, { wrapper: createWrapper() })
    await user.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
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
   * `/integrations/{source}/apps` serves only the app-review plugins and answers
   * 400 for any other source. The S3 import and GitHub Issues tiles opened this
   * modal, fired that request twice (a console error each), and offered an app
   * editor whose save the API refuses (QA s1, production 2.13.00).
   */
  describe('a plugin without app configs (s3_import)', () => {
    const s3Plugin: PluginManifest = {
      ...plugin, id: 's3_import', name: 'S3 Bulk Import', category: 'import',
      config: [{ key: 'bucket_name', label: 'Bucket', type: 'text', required: true, placeholder: '', secret: false }],
    }

    it('never asks /integrations/{source}/apps and offers no app editor', async () => {
      render(<PluginConfigModal plugin={s3Plugin} onClose={onClose} isAdmin />, { wrapper: createQueryWrapper(['/scrapers']) })
      await waitFor(() => { expect(mockGetSourcesStatus).toHaveBeenCalledWith(['s3_import']) })
      expect(mockGetAppConfigs).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: /add app|add your first app/i })).not.toBeInTheDocument()
      expect(screen.queryByText('Configured Apps')).not.toBeInTheDocument()
    })

    it('points to the data source settings instead', async () => {
      render(<PluginConfigModal plugin={s3Plugin} onClose={onClose} isAdmin />, { wrapper: createQueryWrapper(['/scrapers']) })
      await waitFor(() => { expect(mockGetSourcesStatus).toHaveBeenCalledWith(['s3_import']) })
      expect(screen.getByRole('link', { name: 'Open data source settings' })).toHaveAttribute('href', '/admin?tab=plugins')
    })
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
      const user = await renderLoaded(false)

      const run = screen.getByRole('button', { name: /run now/i })
      expect(run).toBeDisabled()
      expect(run).toHaveAttribute('title', ADMIN_ONLY_TITLE)
      await user.click(run)
      expect(mockRunSource).not.toHaveBeenCalled()
    })

    it('does not toggle the schedule', async () => {
      const user = await renderLoaded(false)

      await expectScheduleToggleLocked(user)
    })

    it('does not open the editor, so nothing can be saved', async () => {
      const user = await renderLoaded(false)

      const add = screen.getByRole('button', { name: /add app/i })
      expect(add).toBeDisabled()
      await user.click(add)
      expect(screen.queryByText('Add New App')).not.toBeInTheDocument()
      expect(mockSaveAppConfig).not.toHaveBeenCalled()
    })

    it('does not delete an app config', async () => {
      const user = await renderLoaded(false)

      // Located by its position in the per-app row rather than by title: `title` is
      // what the assertion is ABOUT, so selecting on it would find the Run button
      // (which carries the same title) and pass with the delete gate removed. There
      // is one delete button per app; the two apps are the loaded fixture.
      const perApp = screen.getAllByRole('button')
        .filter((el) => el.getAttribute('title') === ADMIN_ONLY_TITLE
          && el.querySelector('svg.lucide-trash2') !== null)
      expect(perApp).toHaveLength(2)

      await user.click(at(perApp, 0))
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
