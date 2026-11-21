/**
 * @fileoverview Administration's shell (7.59.00, Settings.tsx): main's header and tab row again, a WAI-ARIA tablist (a
 * select below `md`) with the arrow keys; on a tab with sections the section switch; the "Needs attention" strip on
 * General and its count badges on the tabs; the search in the header jumps to a tab, a section and a card; who sees
 * which tab; `/` focuses the search. The sections' own cards have their own specs (mocked here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { renderWithQueryClient } from '../../test/query-client'
import { tokenConnection } from '../../test/tokenConnectionFixtures'
import { ACME } from '../../test/workspaceFixtures'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import { useConfigStore } from '../../store/configStore'

const auth = { isAdmin: true, isPlatformAdmin: false, agents: false }
vi.mock('../../store/authStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../store/authStore')>(),
  useIsAdmin: () => auth.isAdmin,
  useIsPlatformAdmin: () => auth.isPlatformAdmin,
}))
vi.mock('../../config/menuConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../config/menuConfig')>(),
  isMenuItemEnabled: () => auth.agents,
}))
vi.mock('../../runtimeConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../runtimeConfig')>(),
  isEngineeringAvailable: () => true,
}))

const api = {
  getBrandSettings: vi.fn<() => Promise<unknown>>(),
  getUsers: vi.fn<() => Promise<unknown>>(),
  getSourcesStatus: vi.fn<() => Promise<unknown>>(),
  getModelCapacity: vi.fn<() => Promise<unknown>>(),
}
vi.mock('../../api/client', () => ({ api }))
const listConnections = vi.fn<() => Promise<unknown>>()
vi.mock('../../api/engineeringConnectionsApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/engineeringConnectionsApi')>(),
  engineeringConnectionsApi: { list: () => listConnections() },
}))
vi.mock('../../plugins', () => ({ getEnabledPlugins: () => [{ id: 'webscraper', name: 'Web Scraper' }, { id: 'app_reviews_ios', name: 'App Store' }] }))

vi.mock('../../components/UserAdmin/UserAdmin', () => ({
  default: ({ openItem }: { readonly openItem: string | null }) => <p data-testid="user-admin">open: {openItem ?? 'none'}</p>,
}))
vi.mock('./GeneralTab', async () => {
  const { CardAnchor } = await import('./CardAnchor')
  return { default: () => <><p data-testid="general-tab">General</p><CardAnchor card="theme"><p>Default theme</p></CardAnchor></> }
})
vi.mock('./DataSourcesPage', () => ({ default: () => <p data-testid="data-sources-page">Source settings</p> }))
vi.mock('./IntegrationsSection', () => ({ default: () => <p data-testid="integrations">Integrations</p> }))
vi.mock('./EmailInboxCard', () => ({ default: () => <p data-testid="email-inbox">Email inbox</p> }))
vi.mock('./RadarSection', () => ({ default: () => <p data-testid="radar">Radar</p> }))
vi.mock('./LogsSection', () => ({ default: () => <p data-testid="logs-section">Logs</p> }))
vi.mock('./AiModelSection', () => ({ default: () => <p data-testid="ai-model-section">AI models</p> }))
vi.mock('./VersionSection', () => ({ default: () => <p data-testid="version-section">Version</p> }))
vi.mock('./boards/BoardsSection', () => ({ default: () => <p data-testid="boards-section">Boards</p> }))
vi.mock('./PlatformWorkspacesSection', () => ({ default: () => <p data-testid="platform-workspaces">Workspaces</p> }))
vi.mock('./DeploymentBrandCard', () => ({ default: () => <p data-testid="deployment-brand">Deployment brand</p> }))
vi.mock('./EngineeringAgentsTab', () => ({ default: () => <p data-testid="engineering-agents">Engineering agents</p> }))
vi.mock('../WorkspaceSettings/WorkspaceSettings', () => ({ WorkspaceSettingsCards: () => <p data-testid="workspace-settings">This workspace</p> }))
vi.mock('../Members/Members', () => ({ WorkspaceMembers: () => <p data-testid="workspace-members">Members</p> }))
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
  return { router, user: userEvent.setup(), at: () => `${router.state.location.pathname}${router.state.location.hash}` }
}

const tabRow = () => screen.getByRole('tablist', { name: 'Administration tabs' })
const tabNames = () => within(tabRow()).getAllByRole('tab').map((tab) => tab.textContent)

beforeEach(() => {
  useConfigStore.setState((state) => ({ config: { ...state.config, apiEndpoint: 'https://api.example.com' } }))
  Object.assign(auth, { isAdmin: true, isPlatformAdmin: false, agents: false })
  api.getBrandSettings.mockResolvedValue({ brand_name: 'Acme' })
  api.getUsers.mockResolvedValue({ success: true, users: [
    { username: 'u-1', email: 'ada@example.com', enabled: true, groups: ['admins'], ai_mode: { mode: 'ai_driven', saved: true } },
    { username: 'u-2', email: 'bo@example.com', enabled: true, groups: [] },
    { username: 'u-3', email: 'cy@example.com', enabled: false, groups: [] },
  ] })
  api.getSourcesStatus.mockResolvedValue({ sources: { webscraper: { enabled: true, circuit: TRIPPED }, app_reviews_ios: { enabled: true, circuit: CLOSED } } })
  api.getModelCapacity.mockResolvedValue({ models: [], image: null })
  listConnections.mockReset()
  listConnections.mockResolvedValue({ connections: [], limit: 50 })
})
afterEach(() => { act(() => setCurrentWorkspace(null)) })

describe("main's header and tab row", () => {
  it('heads the page "Administration" with its one line and the search', () => {
    mount('/admin')
    expect(screen.getByRole('heading', { level: 1, name: 'Administration' })).toBeInTheDocument()
    expect(screen.getByText('Configure the platform for everyone (administrators only).')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Search settings' })).toBeInTheDocument()
  })

  it("lists main's tabs in main's order, General open on /admin", async () => {
    const { at } = mount('/admin')
    await waitFor(() => { expect(at()).toBe('/admin/general') })
    expect(tabNames()).toStrictEqual(['General', 'Sources', 'Taxonomy', 'Privacy & access', 'AI models', 'System'])
    expect(screen.getByRole('tab', { name: 'General', selected: true })).toHaveAttribute('aria-controls', 'admin-tab-panel')
    const panel = screen.getByRole('tabpanel', { name: 'General' })
    expect([panel.textContent.includes('Your brand and the default theme'), panel.contains(screen.getByTestId('general-tab'))])
      .toStrictEqual([true, true])
  })

  it('has one tab stop, the selected tab', () => {
    mount('/admin/general')
    expect(within(tabRow()).getAllByRole('tab').map((tab) => tab.tabIndex)).toStrictEqual([0, -1, -1, -1, -1, -1])
  })

  it('moves between tabs with the arrow keys, Home and End, the tab reached selected and focused', async () => {
    const { user, at } = mount('/admin/general')
    await user.click(screen.getByRole('tab', { name: 'General' }))
    const visited: string[] = []
    for (const key of ['{ArrowRight}', '{End}', '{Home}']) {
      const before = at()
      await user.keyboard(key)
      await waitFor(() => { expect(at()).not.toBe(before) })
      visited.push(at())
    }
    expect(visited).toStrictEqual(['/admin/sources/plugins', '/admin/system/logs', '/admin/general'])
    expect(screen.getByRole('tab', { name: 'General', selected: true })).toHaveFocus()
  })

  it('offers the same tabs as a select (the phone layout), which opens the one chosen', async () => {
    const { user, at } = mount('/admin/general')
    const select = screen.getByRole('combobox', { name: 'Administration tabs' })
    await waitFor(() => { expect(within(select).getAllByRole('option').map((option) => option.textContent)[1]).toBe('Sources (1)') })
    await user.selectOptions(select, 'ai')
    await waitFor(() => { expect(at()).toBe('/admin/ai') })
    expect(screen.getByTestId('ai-model-section')).toBeInTheDocument()
  })
})

describe('a tab with sections', () => {
  it('shows the section switch, a tablist named by the tab, and the open section in its panel', async () => {
    const { user, at } = mount('/admin/sources/plugins')
    const switcher = screen.getByRole('tablist', { name: 'Sources' })
    expect(within(switcher).getAllByRole('tab').map((tab) => tab.textContent)).toStrictEqual(['Source settings', 'Integrations', 'Email inbox', 'Radar'])
    expect(screen.getByRole('tabpanel', { name: 'Source settings' })).toContainElement(screen.getByTestId('data-sources-page'))
    await user.click(within(switcher).getByRole('tab', { name: 'Radar' }))
    await waitFor(() => { expect(at()).toBe('/admin/sources/radar') })
    expect(screen.getByTestId('radar')).toBeInTheDocument()
  })

  it.each([
    ['/admin/sources/integrations', 'integrations'],
    ['/admin/sources/inbox', 'email-inbox'],
    ['/admin/taxonomy/categories', 'categories-section'],
    ['/admin/taxonomy/dimensions', 'dimensions-section'],
    ['/admin/access/policies', 'source-policies'],
    ['/admin/access/boards', 'boards-section'],
    ['/admin/system/logs', 'logs-section'],
    ['/admin/system/version', 'version-section'],
  ])('%s shows its section', (path, testId) => {
    mount(path)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  it('heads Users with its card and opens the person the path names', () => {
    mount('/admin/access/users/u-1')
    expect(screen.getByRole('heading', { level: 2, name: 'User Administration' })).toBeInTheDocument()
    expect(screen.getByTestId('user-admin')).toHaveTextContent('open: u-1')
  })

  it('focuses the card the hash names', async () => {
    mount('/admin/general#theme')
    await waitFor(() => { expect(document.activeElement).toHaveAttribute('id', 'admin-card-theme') })
  })

  it("leads a 7.54.00 address to its new place (a bookmark of People's editor)", async () => {
    const { at } = mount('/admin/people/u-1')
    await waitFor(() => { expect(at()).toBe('/admin/access/users/u-1') })
    expect(screen.getByRole('tab', { name: /Privacy & access/, selected: true })).toBeInTheDocument()
  })
})

describe('needs attention', () => {
  it('says what on General, by name, with a way to it', async () => {
    mount('/admin/general')
    const strip = (await screen.findByRole('heading', { name: 'Needs attention' })).closest('[role="status"]')
    expect(strip).toHaveTextContent('1 source paused after errors: Web Scraper')
    expect(strip).toHaveTextContent('1 person has no way of working set')
    expect(screen.getByRole('link', { name: 'Review sources' })).toHaveAttribute('href', '/admin/sources/plugins')
    expect(screen.getByRole('link', { name: 'Open Users' })).toHaveAttribute('href', '/admin/access/users')
  })

  it('badges the tabs concerned, in words for a screen reader', async () => {
    mount('/admin/taxonomy/categories')
    expect(await screen.findByRole('tab', { name: 'Sources, 1 needs attention' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Privacy & access, 1 needs attention' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Needs attention' }), 'the strip is General\'s').not.toBeInTheDocument()
  })

  it('shows nothing when nothing needs it, and counts the AI models this account cannot call', async () => {
    api.getSourcesStatus.mockResolvedValue({ sources: {} })
    api.getUsers.mockResolvedValue({ success: true, users: [] })
    api.getModelCapacity.mockResolvedValue({ models: [{ model_id: 'm', access: { status: 'no_access' } }], image: null })
    mount('/admin/general')
    expect(await screen.findByRole('link', { name: 'Open AI models' })).toHaveAttribute('href', '/admin/ai')
    expect(screen.getByRole('tab', { name: 'Sources' })).toBeInTheDocument()
  })

  it("counts the fine-grained tokens to replace (7.60.00) on Engineering agents' GitHub connections", async () => {
    auth.agents = true
    listConnections.mockResolvedValue({ limit: 50, connections: [
      tokenConnection('c-soon', 'partner-org/sdk', 3), tokenConnection('c-fine', 'partner-org/docs', 60),
      tokenConnection('c-gone', 'partner-org/cli', 0),
    ] })
    mount('/admin/general')
    // (7.66.00: where each is replaced, Agents → Connections)
    expect(await screen.findByRole('link', { name: 'Open GitHub connections' })).toHaveAttribute('href', '/agents/connections')
    expect(screen.getByRole('heading', { name: 'Needs attention' }).closest('[role="status"]'))
      .toHaveTextContent('2 fine-grained tokens expire soon or need replacing')
    expect(screen.getByRole('tab', { name: 'Engineering agents, 2 need attention' })).toBeInTheDocument()
  })

  it('reads no connections while the Engineering agents tab is hidden', async () => {
    mount('/admin/general')
    await screen.findByRole('heading', { name: 'Needs attention' })
    expect(listConnections).not.toHaveBeenCalled()
  })
})

describe('the search in the header', () => {
  it('jumps to the tab, the section and the card it finds', async () => {
    const { user, at } = mount('/admin/general')
    await user.type(screen.getByRole('combobox', { name: 'Search settings' }), 'erase')
    await user.keyboard('{Enter}')
    await waitFor(() => { expect(at()).toBe('/admin/access/policies#erasure') })
    expect(screen.getByTestId('source-policies')).toBeInTheDocument()
  })

  it('is focused by "/" outside a field, and "/" types into a field', async () => {
    const { user } = mount('/admin/general')
    await user.keyboard('/')
    const search = screen.getByRole('combobox', { name: 'Search settings' })
    expect(search).toHaveFocus()
    await user.keyboard('/')
    expect(search).toHaveValue('/')
  })
})

describe('who sees what', () => {
  it('gives a platform admin inside a workspace, with the engineering agents on, every tab', () => {
    Object.assign(auth, { isPlatformAdmin: true, agents: true })
    act(() => setCurrentWorkspace(ACME))
    mount('/admin/workspaces/settings')
    expect(tabNames()).toStrictEqual(['General', 'Sources', 'Taxonomy', 'Privacy & access', 'AI models', 'Workspaces', 'Engineering agents', 'System'])
    expect(within(screen.getByRole('tablist', { name: 'Workspaces' })).getAllByRole('tab').map((tab) => tab.textContent))
      .toStrictEqual(['This workspace', 'Members', 'All workspaces', 'Deployment brand'])
    expect(screen.getByTestId('workspace-settings')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Workspaces → This workspace' })).toHaveAttribute('href', '/admin/workspaces/settings')
  })

  it.each([
    ['/admin/workspaces/members', 'workspace-members'],
    ['/admin/workspaces/all', 'platform-workspaces'],
    ['/admin/workspaces/deployment-brand', 'deployment-brand'],
    ['/admin/agents', 'engineering-agents'],
  ])('%s shows its section to them', (path, testId) => {
    Object.assign(auth, { isPlatformAdmin: true, agents: true })
    act(() => setCurrentWorkspace(ACME))
    mount(path)
    expect(screen.getByTestId(testId)).toBeInTheDocument()
  })

  it('sends a plain administrator\'s Workspaces link to General', async () => {
    const { at } = mount('/admin/workspaces/all')
    await waitFor(() => { expect(at()).toBe('/admin/general') })
  })

  it('leaves anyone else General, Sources, Taxonomy, AI models and System, without the admin-only sections', () => {
    auth.isAdmin = false
    mount('/admin/sources/plugins')
    expect(tabNames()).toStrictEqual(['General', 'Sources', 'Taxonomy', 'AI models', 'System'])
    expect(screen.queryByRole('tablist', { name: 'Sources' }), 'one section: no switch').not.toBeInTheDocument()
  })
})
