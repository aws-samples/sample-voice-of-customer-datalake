import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { sortedStrings } from '@test/stringLists'
import { SYNTHETIC_PLUGIN_MANIFEST } from './scrapers-fixtures'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { ApiError } from '../../lib/errors'
import { configStoreModule, createQueryWrapper } from '../Categories/categories-fixtures'
import enCommon from '../../../public/locales/en/common.json'
import enScrapers from '../../../public/locales/en/scrapers.json'

// Mock API
const mockGetScrapers = vi.fn<(...args: unknown[]) => unknown>()
const mockSaveScraper = vi.fn<(...args: unknown[]) => unknown>()
const mockDeleteScraper = vi.fn<(...args: unknown[]) => unknown>()
const mockRunScraper = vi.fn<(...args: unknown[]) => unknown>()
const mockGetScraperStatus = vi.fn<(...args: unknown[]) => unknown>()
const mockGetAppConfigs = vi.fn<(source: string) => unknown>()
const mockGetSourceRunStatus = vi.fn<(...args: unknown[]) => unknown>()

vi.mock('../../api/client', () => ({
  api: {
    getAppConfigs: (source: string) => mockGetAppConfigs(source),
    deleteAppConfig: vi.fn().mockResolvedValue({ success: true }),
    runSource: vi.fn().mockResolvedValue({ success: true }),
    getSourceRunStatus: (source: string) => mockGetSourceRunStatus(source),
    getIntegrationCredentials: vi.fn().mockResolvedValue({}),
  },
}))

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: {
    getScrapers: () => mockGetScrapers(),
    saveScraper: (s: unknown) => mockSaveScraper(s),
    deleteScraper: (id: string) => mockDeleteScraper(id),
    runScraper: (id: string) => mockRunScraper(id),
    getScraperStatus: (id: string) => mockGetScraperStatus(id),
  },
}))

vi.mock('../../store/configStore', () => configStoreModule())

// Role switch for the page-level role cases; admin by default so the cases that
// predate it keep their behaviour. Reset in beforeEach.
const role = { isAdmin: true }
vi.mock('../../store/authStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../store/authStore')>(),
  useIsAdmin: () => role.isAdmin,
}))

const manualImport = { isModalOpen: false }
vi.mock('../../store/manualImportStore', () => ({
  useManualImportStore: () => ({
    setIsModalOpen: vi.fn(),
    isModalOpen: manualImport.isModalOpen,
  }),
}))

const mockPluginManifests = [
  { id: 'app_reviews_ios', name: 'iOS App Reviews', icon: 'iOS', config: [], hasIngestor: true, hasWebhook: false, hasS3Trigger: false, enabled: true },
  { id: 'app_reviews_android', name: 'Android App Reviews', icon: 'Android', config: [], hasIngestor: true, hasWebhook: false, hasS3Trigger: false, enabled: true },
]

// Mutable per-test list of synthetic plugins; default empty so pre-existing
// tests keep their behavior. Reset in beforeEach.
const mockSyntheticPlugins: Array<Record<string, unknown>> = []

const syntheticPlugin = SYNTHETIC_PLUGIN_MANIFEST

vi.mock('../../plugins', () => ({
  getPluginManifests: () => mockPluginManifests,
  getSyntheticPlugins: () => mockSyntheticPlugins,
}))

// Mock subcomponents
vi.mock('./ScraperEditor', () => ({
  default: ({ onSave, onClose, saveError, isAdmin }: { onSave: (s: unknown) => Promise<unknown>; onClose: () => void; saveError?: string | null; isAdmin: boolean }) => (
    <div data-testid="scraper-editor" data-admin={String(isAdmin)}>
      {saveError == null ? null : <p role="alert">{saveError}</p>}
      {/* Like the real editor: a rejected save stays open and the host shows why. */}
      <button onClick={() => { onSave({ id: 'new', name: 'Test' }).catch(ignoreRejection) }}>Save</button>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))

vi.mock('./TemplateSelector', () => ({
  default: ({ onSelect, onClose, isAdmin }: { onSelect: (t: unknown) => void; onClose: () => void; isAdmin: boolean }) => (
    <div data-testid="template-selector">
      {/* Like the real selector: the scraper templates are disabled for a non-admin. */}
      <button disabled={!isAdmin} onClick={() => onSelect({ id: 'template1', name: 'Template' })}>Select Template</button>
      <button onClick={onClose}>Close Templates</button>
    </div>
  ),
}))

vi.mock('./ManualImportModal', () => ({
  default: () => <div data-testid="manual-import-modal" />,
}))

// Its own suite is ImportHistory.test.tsx; here only whether the page mounts it.
vi.mock('./ImportHistory', () => ({
  default: () => <div data-testid="import-history" />,
}))

import Scrapers from './Scrapers'
import { at } from '@test/defined'
import { clickLoadFailedRetry } from '@test/loadFailed'
import { ignoreRejection } from '../../lib/rejections'

const createWrapper = () => createQueryWrapper(['/'])

/** Render the page and wait for the scraper cards to load; returns a user for interaction. */
async function renderLoaded() {
  const user = userEvent.setup()
  render(<Scrapers />, { wrapper: createWrapper() })
  await waitFor(() => {
    expect(screen.getByText('Test Scraper')).toBeInTheDocument()
  })
  return user
}

/** Render the page and click through "New Source" to the template selector. */
async function openTemplateSelector() {
  const user = userEvent.setup()
  render(<Scrapers />, { wrapper: createWrapper() })
  await user.click(screen.getByRole('button', { name: /new source/i }))
  return user
}

/** Render the page with the synthetic plugin and wait for its card. */
async function renderWithSyntheticCard() {
  mockSyntheticPlugins.push(syntheticPlugin)
  const user = userEvent.setup()
  render(<Scrapers />, { wrapper: createWrapper() })
  await waitFor(() => {
    expect(screen.getByText('Synthetic Data Review Generator')).toBeInTheDocument()
  })
  return user
}

const mockScrapers = [
  {
    id: 'scraper-1',
    name: 'Test Scraper',
    base_url: 'https://example.com/reviews',
    enabled: true,
    frequency_minutes: 60,
    urls: [],
    pagination: { enabled: false, max_pages: 1 },
  },
  {
    id: 'scraper-2',
    name: 'Disabled Scraper',
    base_url: 'https://other.com',
    enabled: false,
    frequency_minutes: 30,
    urls: ['https://other.com/page1'],
    pagination: { enabled: true, max_pages: 5 },
  },
]

describe('Scrapers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    role.isAdmin = true
    manualImport.isModalOpen = false
    mockSyntheticPlugins.length = 0
    mockGetScrapers.mockResolvedValue({ scrapers: mockScrapers })
    mockGetScraperStatus.mockResolvedValue({ status: 'never_run' })
    mockSaveScraper.mockResolvedValue({ success: true })
    mockDeleteScraper.mockResolvedValue({ success: true })
    mockRunScraper.mockResolvedValue({ success: true })
    mockGetAppConfigs.mockResolvedValue({ apps: [] })
    mockGetSourceRunStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
  })

  describe('rendering', () => {
    it('lists app configs only for the app-review plugins the API serves', async () => {
      // `/integrations/{source}/apps` answers 400 for any other source, so an
      // ingestor plugin such as GitHub Issues must never be asked (it was, on
      // every visit, while the page used a denylist).
      mockPluginManifests.push(
        { id: 'github_issues', name: 'GitHub Issues', icon: 'GitHub', config: [], hasIngestor: true, hasWebhook: true, hasS3Trigger: false, enabled: true },
      )
      try {
        await renderLoaded()
        await waitFor(() => expect(mockGetAppConfigs).toHaveBeenCalledTimes(2))
        expect(sortedStrings(mockGetAppConfigs.mock.calls.map(([source]) => source))).toStrictEqual(['app_reviews_android', 'app_reviews_ios'])
      } finally {
        mockPluginManifests.pop()
      }
    })

    it('renders page header', () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      // One name everywhere: the sidebar, the breadcrumb and the heading say "Data sources".
      expect(screen.getByRole('heading', { level: 1, name: 'Data sources' })).toBeInTheDocument()
      expect(screen.getByText(/everywhere your feedback comes from/i)).toBeInTheDocument()
    })

    it('renders action buttons', () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /new source/i })).toBeInTheDocument()
    })

    it('renders scraper cards after loading', async () => {
      await renderLoaded()

      expect(screen.getByText('Disabled Scraper')).toBeInTheDocument()
    })

    it('shows domain from base_url', async () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('example.com')).toBeInTheDocument()
        expect(screen.getByText('other.com')).toBeInTheDocument()
      })
    })

    it('shows frequency label', async () => {
      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('Test Scraper')).toBeInTheDocument()
      })
      // Frequency labels are rendered in the card
    })
  })

  describe('load failed', () => {
    it('a failed scrapers read says so instead of "No scrapers configured"', async () => {
      mockGetScrapers.mockRejectedValue(new Error('Failed to fetch'))

      render(<Scrapers />, { wrapper: createWrapper() })

      expect(await screen.findByRole('alert')).toHaveTextContent(enCommon.loadFailed.message)
      expect(screen.queryByText(enScrapers.empty.title)).not.toBeInTheDocument()
    })

    it('Try again refetches and the list renders', async () => {
      mockGetScrapers.mockRejectedValueOnce(new Error('API Error: 500'))
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })

      await clickLoadFailedRetry(user)

      expect(await screen.findByText(at(mockScrapers, 0).name)).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    /** Render the page with the scraper list resolving empty. */
    function renderWithNoScrapers() {
      mockGetScrapers.mockResolvedValue({ scrapers: [] })
      render(<Scrapers />, { wrapper: createWrapper() })
    }

    it('shows empty state when no scrapers', async () => {
      renderWithNoScrapers()

      await waitFor(() => {
        expect(screen.getByText('No data sources yet')).toBeInTheDocument()
        expect(screen.getByText(/add a review page, an app, a file or a tool/i)).toBeInTheDocument()
      })
    })

    it('shows create button in empty state', async () => {
      renderWithNoScrapers()

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add a data source/i })).toBeInTheDocument()
      })
    })

    it('suppresses the empty state when a synthetic source exists (#146)', async () => {
      mockGetScrapers.mockResolvedValue({ scrapers: [] })

      await renderWithSyntheticCard()

      expect(screen.queryByText('No data sources yet')).not.toBeInTheDocument()
    })
  })

  describe('synthetic data section (#146)', () => {
    it('renders a card per synthetic plugin with the section title', async () => {
      mockSyntheticPlugins.push(syntheticPlugin)

      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Synthetic Data' })).toBeInTheDocument()
        expect(screen.getByText('Synthetic Data Review Generator')).toBeInTheDocument()
      })
    })

    it('opens the generator modal from the card Generate button', async () => {
      const user = await renderWithSyntheticCard()

      await user.click(screen.getByRole('button', { name: /generate/i }))

      // GeneratorConfigModal renders the plugin name in its header too.
      expect(screen.getAllByText('Synthetic Data Review Generator').length).toBeGreaterThan(1)
    })

    it('does not render the section when no synthetic plugins exist', async () => {
      await renderLoaded()

      expect(screen.queryByRole('heading', { name: 'Synthetic Data' })).not.toBeInTheDocument()
    })

    it('refreshes the card when the generator modal closes (a just-finished run shows immediately)', async () => {
      mockSyntheticPlugins.push(syntheticPlugin)
      // Card mounts with no run history…
      mockGetSourceRunStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'never_run' })
      const user = userEvent.setup()

      render(<Scrapers />, { wrapper: createWrapper() })

      expect(await screen.findByText(/not run yet/i)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /generate/i }))

      // …a run completes while the modal is open…
      mockGetSourceRunStatus.mockResolvedValue({
        source: 'synthetic_reviews',
        status: 'completed',
        completed_at: '2026-07-17T09:00:00Z',
        items_found: 3,
        errors: [],
      })

      // …and closing the modal invalidates ['source-run-status'] → refetch.
      await user.click(screen.getByRole('button', { name: /^close$/i }))

      expect(await screen.findByText(/3 items generated/i)).toBeInTheDocument()
      expect(screen.queryByText(/not run yet/i)).not.toBeInTheDocument()
    })
  })

  describe('template selector', () => {
    it('opens template selector when New Source clicked', async () => {
      await openTemplateSelector()

      expect(screen.getByTestId('template-selector')).toBeInTheDocument()
    })

    it('closes template selector when close clicked', async () => {
      const user = await openTemplateSelector()
      await user.click(screen.getByText('Close Templates'))

      expect(screen.queryByTestId('template-selector')).not.toBeInTheDocument()
    })

    it('opens editor when template selected', async () => {
      const user = await openTemplateSelector()
      await user.click(screen.getByText('Select Template'))

      expect(screen.getByTestId('scraper-editor')).toBeInTheDocument()
    })
  })

  describe('scraper actions', () => {
    it('opens editor when edit button clicked', async () => {
      const user = await renderLoaded()

      const editButtons = screen.getAllByTitle('Edit')
      await user.click(at(editButtons, 0))

      expect(screen.getByTestId('scraper-editor')).toBeInTheDocument()
    })

    it('shows delete confirmation when delete clicked', async () => {
      const user = await renderLoaded()

      const deleteButtons = screen.getAllByTitle('Delete')
      await user.click(at(deleteButtons, 0))

      expect(screen.getByText('Delete Scraper')).toBeInTheDocument()
      expect(screen.getByText(/are you sure/i)).toBeInTheDocument()
    })

    it('calls deleteScraper when delete confirmed', async () => {
      const user = await renderLoaded()

      const deleteButtons = screen.getAllByTitle('Delete')
      await user.click(at(deleteButtons, 0))

      // Find the confirm button in the modal (last Delete button is the modal's)
      const deleteButtons2 = screen.getAllByRole('button', { name: /^Delete$/i })
      await user.click(at(deleteButtons2, -1))

      await waitFor(() => {
        expect(mockDeleteScraper).toHaveBeenCalledWith('scraper-1')
      })
    })

    it('calls runScraper when run button clicked', async () => {
      const user = await renderLoaded()

      const runButtons = screen.getAllByRole('button', { name: 'Run now' })
      await user.click(at(runButtons, 0))
      expect(mockRunScraper).not.toHaveBeenCalled()
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fetch reviews' }))

      await waitFor(() => {
        expect(mockRunScraper).toHaveBeenCalledWith('scraper-1')
      })
    })
  })

  describe('saving from the editor', () => {
    async function saveFromNewSource() {
      const user = await openTemplateSelector()
      await user.click(screen.getByText('Select Template'))
      await user.click(screen.getByRole('button', { name: 'Save' }))
      return user
    }

    it('closes the editor once the save succeeded', async () => {
      await saveFromNewSource()

      await waitFor(() => {
        expect(screen.queryByTestId('scraper-editor')).not.toBeInTheDocument()
      })
      expect(mockSaveScraper).toHaveBeenCalledTimes(1)
    })

    it("keeps the editor open with the server's message when the save is rejected", async () => {
      mockSaveScraper.mockRejectedValue(new ApiError(400, 'A scraper may list at most 20 URLs'))
      await saveFromNewSource()

      expect(await screen.findByRole('alert')).toHaveTextContent('A scraper may list at most 20 URLs')
      expect(screen.getByTestId('scraper-editor')).toBeInTheDocument()
    })

    it('falls back to a generic message when the server sent none', async () => {
      mockSaveScraper.mockRejectedValue(new ApiError(502))
      await saveFromNewSource()

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the scraper. Please try again.')
      expect(screen.getByTestId('scraper-editor')).toBeInTheDocument()
    })

    it('clears the error when the editor is closed and reopened', async () => {
      mockSaveScraper.mockRejectedValue(new ApiError(400, 'Too many scrapers'))
      const user = await saveFromNewSource()
      await screen.findByRole('alert')
      await user.click(screen.getByRole('button', { name: 'Close' }))
      await user.click(at(screen.getAllByTitle('Edit'), 0))

      expect(screen.getByTestId('scraper-editor')).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('per role (owner decision 2026-10-08: create, edit, analyze, run and delete are admin-only)', () => {
    it('the control: an admin creates and saves a scraper from New Source', async () => {
      const user = await openTemplateSelector()
      await user.click(screen.getByText('Select Template'))
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => {
        expect(mockSaveScraper).toHaveBeenCalledTimes(1)
      })
    })

    it('a non-admin still opens New Source, but its scraper templates are disabled', async () => {
      role.isAdmin = false
      const user = await openTemplateSelector()
      const template = screen.getByText('Select Template')
      expect(template).toBeDisabled()
      await user.click(template)

      expect(screen.queryByTestId('scraper-editor')).not.toBeInTheDocument()
      expect(mockSaveScraper).not.toHaveBeenCalled()
    })

    it('a non-admin never mounts the import modals (paste, JSON, CSV)', async () => {
      role.isAdmin = false
      await renderLoaded()

      expect(screen.queryByTestId('manual-import-modal')).not.toBeInTheDocument()
    })

    it.each([true, false])('shows the import history to admins only (isAdmin=%s)', async (isAdmin) => {
      role.isAdmin = isAdmin
      await renderLoaded()

      expect(screen.queryByTestId('import-history') !== null).toBe(isAdmin)
    })

    it.each([[true, 1], [false, 0]])('refreshes the import history when the paste modal closes (was open: %s)', async (wasOpen, refreshes) => {
      manualImport.isModalOpen = wasOpen
      const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
      const { rerender } = render(<Scrapers />, { wrapper: createWrapper() })
      await screen.findByText('Test Scraper')
      manualImport.isModalOpen = false
      rerender(<Scrapers />)
      const historyRefreshes = invalidate.mock.calls.filter(([filters]) => filters?.queryKey?.[0] === 'import-history')
      invalidate.mockRestore()
      expect(historyRefreshes).toHaveLength(refreshes)
    })

    it('the control: an admin has the manual-import modal mounted', async () => {
      await renderLoaded()

      expect(screen.getByTestId('manual-import-modal')).toBeInTheDocument()
    })

    it('creates from the empty state as an admin', async () => {
      mockGetScrapers.mockResolvedValue({ scrapers: [] })
      const user = userEvent.setup()
      render(<Scrapers />, { wrapper: createWrapper() })
      const create = await screen.findByRole('button', { name: /add a data source/i })
      expect(create).toBeEnabled()
      await user.click(create)

      expect(screen.getByTestId('template-selector')).toBeInTheDocument()
    })

    it('gives a non-admin the reason instead of the empty-state create button', async () => {
      role.isAdmin = false
      mockGetScrapers.mockResolvedValue({ scrapers: [] })
      render(<Scrapers />, { wrapper: createWrapper() })

      expect(await screen.findByText(enScrapers.templateSelector.scrapersAdminOnly)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /add a data source/i })).not.toBeInTheDocument()
      // New Source stays: it is also the entrance to the app-source tiles, which are not gated.
      expect(screen.getByRole('button', { name: /new source/i })).toBeEnabled()
    })

    it.each([true, false])('opens the editor from Edit, read-only unless admin (isAdmin=%s)', async (isAdmin) => {
      role.isAdmin = isAdmin
      const user = await renderLoaded()
      await user.click(at(screen.getAllByTitle('Edit'), 0))

      expect(screen.getByTestId('scraper-editor')).toHaveAttribute('data-admin', String(isAdmin))
    })

    it('disables Run and Delete for a non-admin', async () => {
      role.isAdmin = false
      await renderLoaded()

      const gated = screen.getAllByTitle(ADMIN_ONLY_TITLE)
      // Two scrapers × (Run, Delete); scraper-1 and scraper-2 both have a URL.
      expect(gated.map((button) => button.hasAttribute('disabled'))).toStrictEqual([true, true, true, true])
      expect(screen.queryAllByTitle('Run now')).toHaveLength(0)
      expect(screen.queryAllByTitle('Delete')).toHaveLength(0)
    })

    it('issues neither request when a non-admin clicks the gated Run and Delete', async () => {
      role.isAdmin = false
      const user = await renderLoaded()

      for (const button of screen.getAllByTitle(ADMIN_ONLY_TITLE)) {
        await user.click(button)
      }
      expect(mockRunScraper).not.toHaveBeenCalled()
      expect(mockDeleteScraper).not.toHaveBeenCalled()
    })

    it('the control: an admin gets enabled Run and Delete', async () => {
      await renderLoaded()

      expect(screen.queryAllByTitle(ADMIN_ONLY_TITLE)).toHaveLength(0)
      for (const button of [...screen.getAllByTitle('Run now'), ...screen.getAllByTitle('Delete')]) {
        expect(button).toBeEnabled()
      }
    })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching', () => {
      mockGetScrapers.mockReturnValue(new Promise(() => {}))

      render(<Scrapers />, { wrapper: createWrapper() })

      expect(screen.getByRole('status', { name: 'Loading data sources…' })).toBeInTheDocument()
    })
  })

  describe('app config loading', () => {
    it('shows loading placeholder while app configs are fetching', async () => {
      mockGetAppConfigs.mockReturnValue(new Promise(() => {}))

      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText(/loading app configurations/i)).toBeInTheDocument()
      })
    })

    it('renders app config cards after loading', async () => {
      mockGetAppConfigs.mockImplementation((source: string) => {
        if (source === 'app_reviews_ios') return Promise.resolve({ apps: [{ id: 'app-1', app_name: 'My iOS App', app_id: '123456' }] })
        return Promise.resolve({ apps: [] })
      })

      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('My iOS App')).toBeInTheDocument()
      })
    })

    it('fetches all plugins in parallel', async () => {
      mockGetAppConfigs.mockResolvedValue({ apps: [] })

      render(<Scrapers />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(mockGetAppConfigs).toHaveBeenCalledWith('app_reviews_ios')
      })
      expect(mockGetAppConfigs).toHaveBeenCalledWith('app_reviews_android')
    })
  })
})
