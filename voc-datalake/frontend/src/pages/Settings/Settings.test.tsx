/**
 * @fileoverview Administration's shell (7.54.00, Settings.tsx): the home at `/admin` and a tab's page under
 * "← Administration", its name and its job, with the grouped navigation; who sees which tab; no page-level Save;
 * a path naming a card focuses it; `/` focuses the search. The pages' own cards have their own specs (mocked here).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { renderWithQueryClient } from '../../test/query-client'
import { useConfigStore } from '../../store/configStore'

const auth = { isAdmin: true, isPlatformAdmin: false }
vi.mock('../../store/authStore', () => ({ useIsAdmin: () => auth.isAdmin, useIsPlatformAdmin: () => auth.isPlatformAdmin }))

const api = {
  getBrandSettings: vi.fn<() => Promise<unknown>>(),
  getUsers: vi.fn<() => Promise<unknown>>(),
  getSourcesStatus: vi.fn<() => Promise<unknown>>(),
  getLogsSummary: vi.fn<() => Promise<unknown>>(),
  getModelCapacity: vi.fn<() => Promise<unknown>>(),
}
vi.mock('../../api/client', () => ({ api }))
vi.mock('../../plugins', () => ({ getEnabledPlugins: () => [{ id: 'webscraper', name: 'Web Scraper' }, { id: 'app_reviews_ios', name: 'App Store' }] }))

vi.mock('../../components/UserAdmin/UserAdmin', () => ({
  default: ({ openItem }: { readonly openItem: string | null }) => <p data-testid="user-admin">open: {openItem ?? 'none'}</p>,
}))
vi.mock('./DataSourcesPage', () => ({ default: () => <p data-testid="data-sources-page">Data sources page</p> }))
vi.mock('./LogsSection', () => ({ default: () => <p data-testid="logs-section">Logs</p> }))
vi.mock('./AiModelSection', () => ({ default: () => <p data-testid="ai-model-section">AI models</p> }))
vi.mock('./BrandPage', () => ({ default: () => <p data-testid="brand-page">Brand page</p> }))
vi.mock('./VersionSection', () => ({ default: () => <p data-testid="version-section">Version</p> }))
vi.mock('./boards/BoardsSection', () => ({ default: () => <p data-testid="boards-section">Boards</p> }))
vi.mock('./PlatformWorkspacesSection', () => ({ default: () => <p data-testid="platform-workspaces">Workspaces</p> }))
vi.mock('./DeploymentBrandCard', () => ({ default: () => <p>Deployment brand</p> }))
vi.mock('./SettingsSections', async (importOriginal) => ({
  ...await importOriginal<typeof import('./SettingsSections')>(),
  CategoriesSection: () => <p data-testid="categories-section">Categories</p>,
}))
vi.mock('./DataGovernanceSections', () => ({
  DimensionsSection: () => <p data-testid="dimensions-section">Dimensions</p>,
  SourcePoliciesSection: () => <p data-testid="source-policies">Source policies</p>,
}))

const { default: Settings } = await import('./Settings')

const CLOSED = { tripped: false, tripped_at: null, failure_count: 0, last_error: null }
const TRIPPED = { tripped: true, tripped_at: '2026-11-16T09:00:00Z', failure_count: 5, last_error: null }

function mount(path: string) {
  const router = createMemoryRouter([{ path: '/admin/*', element: <Settings /> }, { path: '*', element: <p>Elsewhere</p> }],
    { initialEntries: [path] })
  renderWithQueryClient(<RouterProvider router={router} />)
  return router
}

const navLinks = () => within(screen.getByRole('navigation', { name: 'Administration' })).getAllByRole('link').map((link) => link.textContent)

beforeEach(() => {
  useConfigStore.setState((state) => ({ config: { ...state.config, apiEndpoint: 'https://api.example.com' } }))
  auth.isAdmin = true
  auth.isPlatformAdmin = false
  api.getBrandSettings.mockResolvedValue({ brand_name: 'Acme' })
  api.getUsers.mockResolvedValue({ success: true, users: [
    { username: 'u-1', email: 'ada@example.com', enabled: true, groups: ['admins'], ai_mode: { mode: 'ai_driven', saved: true } },
    { username: 'u-2', email: 'bo@example.com', enabled: true, groups: [] },
    { username: 'u-3', email: 'cy@example.com', enabled: false, groups: [] },
  ] })
  api.getSourcesStatus.mockResolvedValue({ sources: { webscraper: { enabled: true, circuit: TRIPPED }, app_reviews_ios: { enabled: true, circuit: CLOSED } } })
  api.getLogsSummary.mockResolvedValue({ summary: { validation_failures: {}, processing_errors: {}, total_validation_failures: 1, total_processing_errors: 2 }, days: 1 })
  api.getModelCapacity.mockResolvedValue({ models: [], image: null })
})

describe('the home (/admin)', () => {
  it('names the page and its job, and lists the groups by how often they are needed', () => {
    mount('/admin')
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument()
    expect(screen.getByText('People, data, categories and AI for this deployment.')).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent))
      .toStrictEqual(['Everyday', 'Regularly', 'Set up once', 'Rare', 'Elsewhere'])
  })

  it('names each Everyday card by its title and count', async () => {
    mount('/admin')
    expect(await screen.findByRole('link', { name: 'People 3 people' })).toHaveAttribute('href', '/admin/people')
    expect(await screen.findByRole('link', { name: 'Data sources 2 on · 1 paused' })).toHaveAttribute('href', '/admin/sources')
    expect(await screen.findByRole('link', { name: 'Logs 3 errors in the last 24 hours' })).toHaveAttribute('href', '/admin/logs')
    expect(screen.getByRole('link', { name: 'Invite person' })).toHaveAttribute('href', '/admin/people/invite')
  })

  it('says what needs attention: the paused sources by name, the people with no way of working saved', async () => {
    mount('/admin')
    const attention = (await screen.findByRole('heading', { name: 'Needs attention' })).closest('[role="status"]')
    expect(attention).toHaveTextContent('1 source paused after errors: Web Scraper')
    expect(attention).toHaveTextContent('1 person has no way of working set')
    expect(screen.getByRole('link', { name: 'Review sources' })).toHaveAttribute('href', '/admin/sources')
  })

  it('hides "Needs attention" when nothing does', async () => {
    api.getSourcesStatus.mockResolvedValue({ sources: {} })
    api.getUsers.mockResolvedValue({ success: true, users: [] })
    mount('/admin')
    await screen.findByRole('link', { name: 'People 0 people' })
    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument()
  })

  it('links the version line to the release notes, and the places that live elsewhere', () => {
    mount('/admin')
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute('href', '/admin/version')
    expect(screen.getByRole('link', { name: 'Your preferences: Account › Preferences' })).toHaveAttribute('href', '/account/preferences')
  })
})

describe('a tab\'s page', () => {
  it('heads it with "← Administration", its name and its job; the navigation marks it', () => {
    mount('/admin/people')
    expect(screen.getByRole('link', { name: 'Administration' })).toHaveAttribute('href', '/admin')
    expect(screen.getByRole('heading', { level: 1, name: 'People' })).toBeInTheDocument()
    expect(screen.getByText('Invite, remove, roles and ways of working')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'People', current: 'page' })).toHaveAttribute('href', '/admin/people')
  })

  it('lists the tabs in the navigation in their groups, Platform for a platform admin only', () => {
    auth.isPlatformAdmin = true
    mount('/admin/logs')
    expect(navLinks()).toStrictEqual(['People', 'Data sources', 'Logs', 'Categories', 'Feedback boards', 'AI models',
      'Brand & appearance', 'Privacy', 'Platform'])
  })

  it.each([
    ['/admin/sources', 'data-sources-page'],
    ['/admin/logs', 'logs-section'],
    ['/admin/categories', 'categories-section'],
    ['/admin/boards', 'boards-section'],
    ['/admin/ai', 'ai-model-section'],
    ['/admin/brand', 'brand-page'],
    ['/admin/privacy', 'source-policies'],
    ['/admin/version', 'version-section'],
  ])('%s shows its page', (path, testId) => {
    mount(path)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  it('opens the person a path names, and the invite', () => {
    mount('/admin/people/u-1')
    expect(screen.getByTestId('user-admin')).toHaveTextContent('open: u-1')
  })

  it('has no page-level Save: every card saves itself', () => {
    mount('/admin/brand')
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it('focuses the card a path names', async () => {
    mount('/admin/categories/dimensions')
    await waitFor(() => { expect(document.activeElement).toHaveAttribute('id', 'admin-section-dimensions') })
  })
})

describe('who sees what', () => {
  it('sends a plain administrator\'s Platform link, and an old address, to the home', async () => {
    const router = mount('/admin/platform')
    await waitFor(() => { expect(router.state.location.pathname).toBe('/admin') })
    await router.navigate('/admin/access/users')
    await waitFor(() => { expect(router.state.location.pathname).toBe('/admin') })
  })

  it('shows a platform admin Platform', () => {
    auth.isPlatformAdmin = true
    mount('/admin/platform')
    expect(screen.getByTestId('platform-workspaces')).toBeInTheDocument()
  })

  it('leaves a non-admin Data sources, Logs, Categories, AI models and Brand & appearance', () => {
    auth.isAdmin = false
    mount('/admin/logs')
    expect(navLinks()).toStrictEqual(['Data sources', 'Logs', 'Categories', 'AI models', 'Brand & appearance'])
  })
})

describe('the search shortcut', () => {
  it('focuses the search with "/" outside a field, and types "/" into a field', async () => {
    mount('/admin')
    const user = userEvent.setup()
    await user.keyboard('/')
    const search = screen.getByRole('combobox', { name: 'Search settings' })
    expect(search).toHaveFocus()
    await user.keyboard('/')
    expect(search).toHaveValue('/')
  })
})
