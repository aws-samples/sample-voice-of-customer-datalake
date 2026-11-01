/**
 * @fileoverview Tests for Settings page component.
 * @module pages/Settings
 * 
 * The Administration page (was Settings, `/admin`) uses a tabbed interface:
 * - Brand tab: API config, brand settings (no Danger zone: it moved to Account → This browser)
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
import { RouterProvider, createMemoryRouter } from 'react-router-dom'

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
  SourcePoliciesSection: () => <div data-testid="source-policies-section">Source policies</div>,
}))

vi.mock('./EmailInboxCard', () => ({
  default: () => <div data-testid="email-inbox-card">Email inbox</div>,
}))

vi.mock('./RadarSection', () => ({
  default: () => <div data-testid="radar-section">Radar</div>,
}))

vi.mock('./IntegrationsSection', () => ({
  default: () => <div data-testid="integrations-section">Integrations</div>,
}))

vi.mock('./VersionSection', () => ({
  default: () => <div data-testid="version-section">Version</div>,
}))

// Plugin manifests come from a generated file; stub the loader so the empty
// state is reachable regardless of which plugins this checkout has enabled.
const mockGetEnabledPlugins = vi.fn<() => Array<{ id: string }>>(() => [{ id: 'webscraper' }])
vi.mock('../../plugins', () => ({ getEnabledPlugins: () => mockGetEnabledPlugins() }))

/** Renders the page (as `ui`) and presses the tab named `name` in the tab bar; returns the session. */
async function openTab(name: string, ui: React.ReactElement = <Settings />) {
  const user = userEvent.setup()
  renderSettings(ui)
  await user.click(screen.getByRole('button', { name, pressed: false }))
  return user
}

/** Renders the page and opens Sources (its first section is Data sources). */
async function openDataSourcesTab() {
  await openTab('Sources')
}

/** The labels of the tab bar (the desktop track; its buttons carry aria-pressed). */
function tabLabels(): string[] {
  return screen.getAllByRole('button').filter((button) => button.hasAttribute('aria-pressed')).map((button) => button.textContent)
}

/** The labels of the section switch. */
function sectionLabels(): string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent)
}

import Settings from './Settings'
import { at } from '@test/defined'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'

/** Renders `ui` (the page by default) with a no-retry query client inside its router. */
function renderSettings(ui: React.ReactElement = <Settings />, path = '/admin') {
  return renderWithQueryClient(<TestRouter initialEntries={[path]}>{ui}</TestRouter>)
}

/** Renders the page and presses Save Changes. */
async function renderAndSave() {
  const user = userEvent.setup()
  renderSettings()
  await user.click(screen.getByRole('button', { name: /Save Changes/i }))
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
    it('shows admins the six tabs, in order', () => {
      renderSettings()

      expect(tabLabels()).toStrictEqual(['General', 'Sources', 'Taxonomy', 'Privacy & access', 'AI models', 'System'])
    })

    it('starts on Brand tab by default', () => {
      renderSettings()
      
      expect(screen.getByText('Brand Configuration')).toBeInTheDocument()
    })

    it.each([
      ['Sources', ['Source settings', 'Integrations', 'Email inbox', 'Radar'], 'source-card-webscraper'],
      ['Taxonomy', ['Categories', 'Dimensions'], 'categories-manager'],
      ['Privacy & access', ['Source policies', 'Users', 'Boards'], 'source-policies-section'],
      ['System', ['Logs', 'Version'], 'logs-section'],
    ])('opens %s on its first section, under a switch of its sections', async (tab, sections, firstTestId) => {
      await openTab(tab)

      expect(sectionLabels()).toStrictEqual(sections)
      expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(at(sections, 0))
      expect(screen.getByTestId(firstTestId)).toBeInTheDocument()
    })

    it.each([
      ['Sources', 'Integrations', 'integrations-section'],
      ['Sources', 'Email inbox', 'email-inbox-card'],
      ['Sources', 'Radar', 'radar-section'],
      ['Taxonomy', 'Dimensions', 'dimensions-section'],
      ['Privacy & access', 'Users', 'user-admin'],
      ['System', 'Version', 'version-section'],
    ])('%s → %s opens its section in the tab panel', async (tab, section, testId) => {
      const user = await openTab(tab)
      await user.click(screen.getByRole('tab', { name: section }))

      expect(within(screen.getByRole('tabpanel')).getByTestId(testId)).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: section })).toHaveAttribute('aria-selected', 'true')
    })

    it('has AI models on its own tab, with no section switch', async () => {
      await openTab('AI models')

      expect(screen.getByTestId('ai-model-section')).toBeInTheDocument()
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
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

    it('shows Save Changes on General only', async () => {
      await openTab('System')

      expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument()
    })
  })

  describe('deep links', () => {
    /** Mounts the page at `path` in a data router (history actions observable). */
    function mountAt(path: string) {
      const router = createMemoryRouter([{ path: '/admin', element: <Settings /> }], { initialEntries: ['/start', path], initialIndex: 1 })
      renderWithQueryClient(<RouterProvider router={router} />)
      return router
    }

    it.each([
      ['/admin?tab=version', '?tab=system&section=version', 'version-section'],
      ['/admin?tab=radar', '?tab=sources&section=radar', 'radar-section'],
      ['/admin?tab=taxonomy', '?tab=taxonomy&section=categories', 'categories-manager'],
    ])('opens %s and replaces the URL with %s', async (path, canonical, testId) => {
      const router = mountAt(path)

      expect(screen.getByTestId(testId)).toBeInTheDocument()
      await waitFor(() => expect(router.state.location.search).toBe(canonical))
      expect(router.state.historyAction).toBe('REPLACE')
    })

    it('pushes the canonical query on a tab switch, then on a section switch', async () => {
      const user = userEvent.setup()
      const router = mountAt('/admin')
      await user.click(screen.getByRole('button', { name: 'Taxonomy', pressed: false }))
      const afterTab = { search: router.state.location.search, action: router.state.historyAction }
      await user.click(screen.getByRole('tab', { name: 'Dimensions' }))

      expect(afterTab).toStrictEqual({ search: '?tab=taxonomy&section=categories', action: 'PUSH' })
      expect(router.state.location.search).toBe('?tab=taxonomy&section=dimensions')
      expect(router.state.historyAction).toBe('PUSH')
    })

    it('goes Back to the previous section, and the page follows the URL', async () => {
      const user = userEvent.setup()
      const router = mountAt('/admin?tab=system&section=logs')
      await user.click(screen.getByRole('tab', { name: 'Version' }))
      await router.navigate(-1)

      expect(router.state.location.search).toBe('?tab=system&section=logs')
      expect(await screen.findByTestId('logs-section')).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
    })

    it('adds no history entry when the open tab is pressed again', async () => {
      const user = userEvent.setup()
      const router = mountAt('/admin?tab=ai')
      await user.click(screen.getByRole('button', { name: 'AI models', pressed: true }))

      expect(router.state.historyAction).toBe('POP')
    })

    it('opens the Sources tab\'s first section for ?tab=sources (no longer the pre-5.09 Source policies)', async () => {
      const router = mountAt('/admin?tab=sources')

      expect(screen.getByRole('tab', { name: 'Source settings' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.queryByTestId('source-policies-section')).not.toBeInTheDocument()
      await waitFor(() => expect(router.state.location.search).toBe('?tab=sources&section=plugins'))
    })

    it('keeps ?review= (the review modal) through a canonical redirect and a tab switch', async () => {
      const user = userEvent.setup()
      const router = mountAt('/admin?tab=version&review=fb_1')
      await waitFor(() => expect(router.state.location.search).toBe('?review=fb_1&tab=system&section=version'))
      await user.click(screen.getByRole('button', { name: 'Taxonomy', pressed: false }))
      expect(new URLSearchParams(router.state.location.search).get('review')).toBe('fb_1')
    })

    it('leaves a canonical link as it is', () => {
      const router = mountAt('/admin?tab=sources&section=inbox')

      expect(screen.getByTestId('email-inbox-card')).toBeInTheDocument()
      expect(router.state.historyAction).toBe('POP')
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

  describe('brand tab - software settings only (docs/account-vs-admin.md)', () => {
    it('no longer carries the Danger zone: resetting local settings moved to Account → This browser', () => {
      renderSettings()
      expect([screen.queryByText('Danger Zone'), screen.queryByRole('button', { name: /Reset Settings/i })]).toStrictEqual([null, null])
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

/** A fresh copy of the page whose `useIsAdmin` answers `isAdmin`. */
async function importSettingsAs(isAdmin: boolean) {
  vi.resetModules()
  vi.doMock('../../store/authStore', () => ({ useIsAdmin: () => isAdmin }))
  return (await import('./Settings')).default
}

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

  it('shows a non-admin General, Sources, Taxonomy, AI models and System only', async () => {
    const SettingsNonAdmin = await importSettingsAs(false)

    renderSettings(<SettingsNonAdmin />)

    expect(tabLabels()).toStrictEqual(['General', 'Sources', 'Taxonomy', 'AI models', 'System'])
  })

  it.each([
    ['Sources', 'source-card-webscraper'],
    ['Taxonomy', 'categories-manager'],
    ['System', 'logs-section'],
  ])('opens %s for a non-admin on its one open section, with no section switch', async (tab, testId) => {
    const SettingsNonAdmin = await importSettingsAs(false)
    await openTab(tab, <SettingsNonAdmin />)

    expect(screen.getByTestId(testId)).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('opens Logs, not Version, for a ?tab=version deep link from a non-admin', async () => {
    const SettingsNonAdmin = await importSettingsAs(false)

    renderSettings(<SettingsNonAdmin />, '/admin?tab=version')

    expect(screen.queryByTestId('version-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('logs-section')).toBeInTheDocument()
  })

  // PUT /settings/brand is admin-only (#242): the brand profile is shared deployment config.
  it('shows the brand form read-only to a non-admin', async () => {
    const SettingsNonAdmin = await importSettingsAs(false)

    renderSettings(<SettingsNonAdmin />)

    expect(await screen.findByText(/Only admins can change the brand configuration/)).toBeInTheDocument()
    for (const label of [/Brand Name/, /Brand Handles/, /Hashtags to Track/, /URLs to Track/]) {
      expect(screen.getByLabelText(label)).toBeDisabled()
    }
  })

  it('disables Save for a non-admin, so the brand is never saved', async () => {
    const SettingsNonAdmin = await importSettingsAs(false)
    const user = userEvent.setup()

    renderSettings(<SettingsNonAdmin />)

    const save = screen.getByRole('button', { name: /Save Changes/i })
    expect(save).toBeDisabled()
    expect(save).toHaveAttribute('title', ADMIN_ONLY_TITLE)
    await user.click(save)
    expect(mockSaveBrandSettings).not.toHaveBeenCalled()
  })

  it('keeps the brand form editable for an admin', async () => {
    const SettingsAdmin = await importSettingsAs(true)

    renderSettings(<SettingsAdmin />)

    expect(screen.getByLabelText(/Brand Name/)).toBeEnabled()
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeEnabled()
    expect(screen.queryByText(/Only admins can change the brand configuration/)).not.toBeInTheDocument()
  })
})
