/**
 * @fileoverview Tests for Settings page component.
 * @module pages/Settings
 * 
 * The Administration page (was Settings, `/admin`) uses a tabbed interface:
 * - Brand tab: API config, brand settings, danger zone
 * - Data Sources tab: Plugin configurations
 * - Categories tab: Category management
 * - Logs tab: Validation/processing logs
 * - Users tab: User administration (admin only)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { TestRouter } from '../../test/TestRouter'

// Mock API
const mockGetBrandSettings = vi.fn<(...args: unknown[]) => unknown>()
const mockSaveBrandSettings = vi.fn<(...args: unknown[]) => unknown>()
const mockGetLogsSummary = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getBrandSettings: () => mockGetBrandSettings(),
    saveBrandSettings: (settings: unknown) => mockSaveBrandSettings(settings),
    getLogsSummary: () => mockGetLogsSummary(),
    getValidationLogs: () => Promise.resolve({ logs: [], count: 0, days: 7 }),
    getProcessingLogs: () => Promise.resolve({ logs: [], count: 0, days: 7 }),
    getScrapers: () => Promise.resolve({ scrapers: [] }),
  },
}))

// Mock config store
const mockSetConfig = vi.fn<(config: { apiEndpoint?: string; brandName?: string }) => void>()
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: {
      apiEndpoint: 'https://api.example.com',
      brandName: 'Test Brand',
      brandHandles: ['@testbrand'],
      hashtags: ['#testbrand'],
      urlsToTrack: ['https://example.com'],
      sources: {},
    },
    setConfig: mockSetConfig,
  })),
}))

// Mock auth store
vi.mock('../../store/authStore', () => ({
  useIsAdmin: vi.fn(() => true),
}))

// Mock child components
vi.mock('../../components/CategoriesManager/CategoriesManager', () => ({
  default: () => <div data-testid="categories-manager">Categories Manager</div>,
}))

vi.mock('../../components/UserAdmin/UserAdmin', () => ({
  default: () => <div data-testid="user-admin">User Admin</div>,
}))

vi.mock('../../components/ConfirmModal/ConfirmModal', () => import('@test/page-mocks').then((m) => m.confirmModalMock('Confirm Reset')))

vi.mock('./SourceCard', () => ({
  default: ({ manifest }: { manifest: { id: string } }) => (
    <div data-testid={`source-card-${manifest.id}`}>Source: {manifest.id}</div>
  ),
}))

vi.mock('./LogsSection', () => ({
  default: () => <div data-testid="logs-section">Logs Section</div>,
}))

vi.mock('./AiModelSection', () => ({
  default: () => <div data-testid="ai-model-section">AI models</div>,
}))

vi.mock('./DataGovernanceSections', () => ({
  DimensionsSection: () => <div data-testid="dimensions-section">Dimensions</div>,
  SourcesSection: () => <div data-testid="sources-section">Sources</div>,
}))

vi.mock('./IntegrationsSection', () => ({
  default: () => <div data-testid="integrations-section">Integrations</div>,
}))

// Plugin manifests come from a generated file; stub the loader so the empty
// state is reachable regardless of which plugins this checkout has enabled.
const mockGetEnabledPlugins = vi.fn<() => Array<{ id: string }>>(() => [{ id: 'webscraper' }])
vi.mock('../../plugins', () => ({ getEnabledPlugins: () => mockGetEnabledPlugins() }))

/** Renders the page and switches to the Data Sources tab. */
async function openDataSourcesTab() {
  const user = userEvent.setup()
  renderSettings()
  await user.click(at(screen.getAllByRole('button', { name: /Data Sources/i }), 0))
}

import Settings from './Settings'
import { at } from '@test/defined'

/** Renders `ui` (the page by default) with a no-retry query client inside its router. */
function renderSettings(ui: React.ReactElement = <Settings />) {
  return renderWithQueryClient(<TestRouter initialEntries={['/admin']}>{ui}</TestRouter>)
}

/** Renders the page and presses Save Changes. */
async function renderAndSave() {
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('button', { name: /Save Changes/i }))
}

/** Renders the page and opens the Reset Settings confirmation; returns the session. */
async function openResetConfirm() {
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('button', { name: /Reset Settings/i }))
  return user
}

/** The save wrote the brand fields to the local config store. */
async function expectBrandWrittenLocally() {
  await waitFor(() => {
    expect(mockSetConfig).toHaveBeenCalledWith(expect.objectContaining({ brandName: 'Test Brand' }))
  })
}

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetEnabledPlugins.mockReturnValue([{ id: 'webscraper' }])
    mockGetBrandSettings.mockResolvedValue({
      brand_name: 'Test Brand',
      brand_handles: ['@testbrand'],
      hashtags: ['#testbrand'],
      urls_to_track: ['https://example.com'],
    })
    mockSaveBrandSettings.mockResolvedValue({ success: true })
    mockGetLogsSummary.mockResolvedValue({
      summary: { validation_failures: {}, processing_errors: {}, total_validation_failures: 0, total_processing_errors: 0 },
      days: 7,
    })
  })

  describe('header', () => {
    it('displays page title', () => {
      renderSettings()
      
      expect(screen.getByText('Administration')).toBeInTheDocument()
    })

    it('displays page description', () => {
      renderSettings()
      
      expect(screen.getByText(/Configure the platform for everyone/i)).toBeInTheDocument()
    })

    it('displays Save Changes button', () => {
      renderSettings()
      
      expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument()
    })
  })

  describe('tab navigation', () => {
    it('displays all tabs for admin users', () => {
      renderSettings()
      
      // Verify all tab buttons exist (getAllByRole since there are mobile + desktop versions)
      const tabNames = [/General/i, /Data Sources/i, /Categories/i, /Logs/i, /Users/i]
      const missing = tabNames.filter((name) => screen.queryAllByRole('button', { name }).length === 0)
      expect(missing.map(String)).toStrictEqual([])
    })

    it('starts on Brand tab by default', () => {
      renderSettings()
      
      expect(screen.getByText('Brand Configuration')).toBeInTheDocument()
    })

    it('switches to Categories tab when clicked', async () => {
      const user = userEvent.setup()
      renderSettings()
      
      // Click the Categories tab (there are multiple buttons with this text due to mobile/desktop)
      const categoriesButtons = screen.getAllByRole('button', { name: /Categories/i })
      await user.click(at(categoriesButtons, 0))
      
      expect(screen.getByTestId('categories-manager')).toBeInTheDocument()
    })

    it('switches to Data Sources tab when clicked', async () => {
      const user = userEvent.setup()
      renderSettings()
      
      const dataSourcesButtons = screen.getAllByRole('button', { name: /Data Sources/i })
      await user.click(at(dataSourcesButtons, 0))
      
      expect(screen.getByText(/Data Sources & Integrations/i)).toBeInTheDocument()
    })

    it('renders a card per enabled plugin on the Data Sources tab', async () => {
      await openDataSourcesTab()

      expect(screen.getByTestId('source-card-webscraper')).toBeInTheDocument()
      expect(screen.queryByText(/No data source plugins found/)).not.toBeInTheDocument()
    })

    it('shows the translated empty hint, with the command in a code element, when no plugin is enabled', async () => {
      mockGetEnabledPlugins.mockReturnValue([])
      await openDataSourcesTab()

      const hint = screen.getByText(/No data source plugins found/)
      expect(hint).toHaveTextContent('No data source plugins found. Run npm run generate:manifests to generate plugin manifests.')
      // The <code> wrapper comes from the Trans `components` map, not from the catalog string.
      expect(within(hint).getByText('npm run generate:manifests').tagName).toBe('CODE')
    })

    it('switches to Logs tab when clicked', async () => {
      const user = userEvent.setup()
      renderSettings()
      
      const logsButtons = screen.getAllByRole('button', { name: /Logs/i })
      await user.click(at(logsButtons, 0))
      
      expect(screen.getByTestId('logs-section')).toBeInTheDocument()
    })

    it('switches to Users tab when clicked', async () => {
      const user = userEvent.setup()
      renderSettings()
      
      const usersButtons = screen.getAllByRole('button', { name: /Users/i })
      await user.click(at(usersButtons, 0))
      
      expect(screen.getByTestId('user-admin')).toBeInTheDocument()
    })

    it('has AI models on its own tab, not on General', async () => {
      const user = userEvent.setup()
      renderSettings()
      expect(screen.queryByTestId('ai-model-section')).not.toBeInTheDocument()

      await user.click(at(screen.getAllByRole('button', { name: /AI models/i }), 0))

      expect(screen.getByTestId('ai-model-section')).toBeInTheDocument()
    })

    it('has an Integrations tab (Figma / GitHub secrets)', async () => {
      const user = userEvent.setup()
      renderSettings()

      await user.click(at(screen.getAllByRole('button', { name: /Integrations/i }), 0))

      expect(screen.getByTestId('integrations-section')).toBeInTheDocument()
    })

    it('has Dimensions and Sources & privacy tabs for admins', async () => {
      const user = userEvent.setup()
      renderSettings()

      await user.click(at(screen.getAllByRole('button', { name: /^Dimensions$/ }), 0))
      expect(screen.getByTestId('dimensions-section')).toBeInTheDocument()
      await user.click(at(screen.getAllByRole('button', { name: /Sources & privacy/ }), 0))
      expect(screen.getByTestId('sources-section')).toBeInTheDocument()
    })
  })

  describe('brand tab - API configuration section', () => {
    it('displays API Configuration heading in development mode', () => {
      // In vitest, import.meta.env.DEV is true by default.
      renderSettings()

      // Assert it renders with the same query we use in the production test —
      // this proves the query WOULD find it if present.
      expect(screen.getByText('API Configuration')).toBeInTheDocument()
    })

    it('shows Connected indicator when API is configured', () => {
      renderSettings()

      expect(screen.getByText(/Connected/i)).toBeInTheDocument()
    })

    it('expands API config when clicked', async () => {
      const user = userEvent.setup()
      renderSettings()

      // Click to expand API config
      await user.click(screen.getByText('API Configuration'))

      expect(screen.getByPlaceholderText(/your-api-id.execute-api/i)).toBeInTheDocument()
    })
  })

  describe('brand tab - API configuration section (production mode gate)', () => {
    afterEach(() => {
      // Restore any stubbed env vars so later tests in this file always run
      // under the default (DEV = true) Vitest environment.
      vi.unstubAllEnvs()
    })

    it('hides API Configuration section when import.meta.env.DEV is false', () => {
      vi.stubEnv('DEV', false)

      renderSettings()

      // The editable endpoint field must NOT be present in a production build.
      expect(screen.queryByText('API Configuration')).not.toBeInTheDocument()
      // The URL input is definitely absent.
      expect(screen.queryByPlaceholderText(/your-api-id.execute-api/i)).not.toBeInTheDocument()
    })

    it('shows API Configuration section when import.meta.env.DEV is true', () => {
      // Confirm positive case with the same query, proving the test is not vacuous.
      vi.stubEnv('DEV', true)

      renderSettings()

      expect(screen.getByText('API Configuration')).toBeInTheDocument()
    })

    /**
     * The claim of the fix, asserted end-to-end rather than inferred from three
     * files: in a production build there is no path from user input to a
     * persisted endpoint, because the only control that could originate one is
     * not rendered.
     *
     * The layers below this still matter — a stale value persisted by a pre-fix
     * build reaches `setConfig` and `getAuthHeaders` without passing through
     * any UI — so this is not an argument that layer 2 is dead code.
     */
    it('offers no control that can originate an endpoint in a production build', async () => {
      vi.stubEnv('DEV', false)
      const user = userEvent.setup()

      renderSettings()

      // No editable endpoint control is rendered, nor the disclosure that
      // reveals one. Asserting the disclosure matters: the section is collapsed
      // by default when an endpoint is already set, so checking only for the
      // input would pass even with the gate removed.
      expect({
        disclosure: screen.queryByText('API Configuration'),
        endpointInput: screen.queryByPlaceholderText(/your-api-id.execute-api/i),
        anyUrlInput: document.querySelector('input[type="url"]'),
      }).toStrictEqual({ disclosure: null, endpointInput: null, anyUrlInput: null })

      // Saving brand fields still works and carries only the endpoint the app
      // already held — never a user-originated one.
      await user.click(screen.getByRole('button', { name: /Save Changes/i }))

      await expectBrandWrittenLocally()
      // Only the writes that carry an endpoint are relevant; brand-only writes
      // omit the field entirely and leave the persisted value untouched.
      const writtenEndpoints = mockSetConfig.mock.calls
        .map(([written]) => written.apiEndpoint)
        .filter((endpoint) => endpoint !== undefined)
      // At least one write carried an endpoint, and every one carried the held value.
      expect(new Set(writtenEndpoints)).toStrictEqual(new Set(['https://api.example.com']))
    })
  })

  describe('brand tab - brand configuration section', () => {
    it('displays Brand Configuration heading', () => {
      renderSettings()
      
      expect(screen.getByText('Brand Configuration')).toBeInTheDocument()
    })

    it('displays brand name input', () => {
      renderSettings()
      
      expect(screen.getByPlaceholderText(/Your Brand Name/i)).toBeInTheDocument()
    })

    it('shows synced indicator when API endpoint is configured', async () => {
      renderSettings()
      
      expect(await screen.findByText(/Synced to backend/i)).toBeInTheDocument()
    })

    it('shows an error with retry instead of "synced" when the brand load fails', async () => {
      mockGetBrandSettings.mockRejectedValue(new Error('boom'))
      const user = userEvent.setup()
      renderSettings()

      expect(await screen.findByText(/Couldn’t load brand settings/i)).toBeInTheDocument()
      expect(screen.getByText(/Not synced/i)).toBeInTheDocument()
      expect(screen.queryByText(/Synced to backend/i)).not.toBeInTheDocument()

      mockGetBrandSettings.mockResolvedValue({ brand_name: 'Recovered' })
      await user.click(screen.getByRole('button', { name: /Retry/i }))
      expect(await screen.findByText(/Synced to backend/i)).toBeInTheDocument()
    })

    it('reports a failed save instead of "Saved!"', async () => {
      mockSaveBrandSettings.mockRejectedValue(new Error('nope'))
      const user = userEvent.setup()
      renderSettings()

      await user.click(screen.getByRole('button', { name: /Save Changes/i }))

      expect(await screen.findByText(/Couldn’t save to the server/i)).toHaveAttribute('role', 'alert')
      expect(screen.queryByText(/Saved!/i)).not.toBeInTheDocument()
    })
  })

  describe('brand tab - danger zone section', () => {
    it('displays Danger Zone heading', () => {
      renderSettings()
      
      expect(screen.getByText('Danger Zone')).toBeInTheDocument()
    })

    it('displays Reset Settings button', () => {
      renderSettings()
      
      expect(screen.getByRole('button', { name: /Reset Settings/i })).toBeInTheDocument()
    })
  })

  describe('save functionality', () => {
    it('saves settings when Save Changes is clicked', async () => {
      await renderAndSave()

      await expectBrandWrittenLocally()
      await waitFor(() => {
        expect(mockSaveBrandSettings).toHaveBeenCalledWith({
          brand_name: 'Test Brand',
          brand_handles: ['@testbrand'],
          hashtags: ['#testbrand'],
          urls_to_track: ['https://example.com'],
        })
      })
    })

    it('shows Saved! message after successful save', async () => {
      await renderAndSave()

      await waitFor(() => {
        expect(screen.getByText(/Saved!/i)).toBeInTheDocument()
      })
    })

    it('shows Saving... while save is in progress', async () => {
      mockSaveBrandSettings.mockReturnValue(new Promise(() => {}))

      await renderAndSave()

      await waitFor(() => {
        expect(screen.getByText(/Saving.../i)).toBeInTheDocument()
      })
    })
  })

  describe('reset functionality', () => {
    it('opens confirm modal when Reset Settings is clicked', async () => {
      await openResetConfirm()

      expect(screen.getByTestId('confirm-modal')).toBeInTheDocument()
    })

    it('resets settings when confirmed', async () => {
      const user = await openResetConfirm()
      await user.click(screen.getByRole('button', { name: /Confirm Reset/i }))

      expect(mockSetConfig).toHaveBeenCalledWith(expect.objectContaining({
        apiEndpoint: '',
        brandName: '',
      }))
    })

    it('closes modal when cancelled', async () => {
      const user = await openResetConfirm()
      await user.click(screen.getByRole('button', { name: /Cancel/i }))

      expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument()
    })
  })

  describe('form inputs', () => {
    it('updates brand name when typed', async () => {
      const user = userEvent.setup()
      
      renderSettings()
      
      const input = screen.getByPlaceholderText(/Your Brand Name/i)
      await user.type(input, ' Updated')
      
      expect(input).toHaveValue('Test Brand Updated')
    })

    it('updates API endpoint when expanded and typed', async () => {
      const user = userEvent.setup()
      
      renderSettings()
      
      // Expand API config first
      await user.click(screen.getByText('API Configuration'))
      
      const input = screen.getByPlaceholderText(/your-api-id.execute-api/i)
      await user.clear(input)
      await user.type(input, 'https://new-api.example.com')
      
      expect(input).toHaveValue('https://new-api.example.com')
    })
  })

  describe('backend settings sync', () => {
    it('fetches brand settings from backend on mount', async () => {
      renderSettings()
      
      await waitFor(() => {
        expect(mockGetBrandSettings).toHaveBeenCalledWith()
      })
    })

    it('shows loading indicator while fetching settings', () => {
      mockGetBrandSettings.mockReturnValue(new Promise(() => {}))
      
      renderSettings()
      
      expect(screen.getByText(/Loading settings/i)).toBeInTheDocument()
    })
  })
})

describe('Settings without admin access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBrandSettings.mockResolvedValue({
      brand_name: 'Test Brand',
      brand_handles: [],
      hashtags: [],
      urls_to_track: [],
    })
    
    vi.doMock('../../store/authStore', () => ({
      useIsAdmin: vi.fn(() => false),
    }))
  })

  it('hides Users tab for non-admin users', async () => {
    vi.resetModules()
    vi.doMock('../../store/authStore', () => ({
      useIsAdmin: () => false,
    }))
    
    const { default: SettingsNonAdmin } = await import('./Settings')
    
    renderSettings(<SettingsNonAdmin />)
    
    // Users tab should not be visible
    expect(screen.queryByRole('button', { name: /^Users$/i })).not.toBeInTheDocument()
    // Nor the data-governance tabs
    expect(screen.queryByRole('button', { name: /^Dimensions$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Sources & privacy/ })).not.toBeInTheDocument()
  })
})
