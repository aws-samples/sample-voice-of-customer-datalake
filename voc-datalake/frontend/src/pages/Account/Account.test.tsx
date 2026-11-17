/**
 * Account: the user's own preferences (docs/account-vs-admin.md) on the shared
 * top tab bar, five tabs each a path `/account/<id>`: Profile (details,
 * password, sign out), Preferences (language, theme, Home setup, assistant,
 * this browser), Morning brief, Objectives, Access & tokens (my access, MCP).
 * No query names a tab: an old `?tab=` / `?section=` link is not redirected (a pre-release change).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import type { QueryClient } from '@tanstack/react-query'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { useConfigStore } from '../../store/configStore'
import { useAssistantUiStore } from '../../assistant/store/assistantStore'
import { useBubbleStore } from '../../assistant/bubble/bubbleStore'
import { languageNames, supportedLanguages } from '../../i18n/languages'
import { parsedJson } from '@test/jsonText'
import { stubLocationAssign } from '@test/location'
import { withMemoryLocalStorage } from '@test/memoryLocalStorage'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
const signOut = vi.fn<() => void>()
interface TestUser { name?: string; email?: string; username?: string; groups: string[] }
const ADA: TestUser = { name: 'Ada Moreno', email: 'ada@example.com', username: 'ada', groups: ['users'] }
const state = vi.hoisted((): { isAdmin: boolean; user: TestUser | null } => ({ isAdmin: false, user: null }))

vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))
vi.mock('../../store/authStore', () => {
  type Snapshot = { user: TestUser | null }
  const useAuthStore = (selector?: (s: Snapshot) => unknown) => (selector ? selector({ user: state.user }) : { user: state.user })
  // The assistant store subscribes at import (sign-out wipe); nothing here signs out.
  return {
    useIsAdmin: () => state.isAdmin,
    useAuthStore: Object.assign(useAuthStore, { subscribe: () => () => {}, getState: () => ({ user: state.user }) }),
  }
})
vi.mock('../../services/auth', () => ({ authService: { signOut: () => signOut(), changePassword: vi.fn() } }))
vi.mock('../../i18n/languages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/languages')>()
  return { ...actual, changeLanguage: vi.fn().mockResolvedValue(undefined) }
})

const { default: Account } = await import('./Account')
const { changeLanguage } = await import('../../i18n/languages')

/** Account at `/account` + `rest` (a tab's path, or an old link's query). */
function renderAt(rest = '', queryClient: QueryClient = createTestQueryClient()) {
  return renderWithQueryClient(<TestRouter initialEntries={[`/account${rest}`]}><Account /></TestRouter>, queryClient)
}

/** Account under a data router (its route as routes.tsx declares it), so a test can read the location and how it changed. */
function renderInRouter(rest: string) {
  const router = createMemoryRouter([{ path: '/home', element: <p>Home</p> }, { path: '/account/*', element: <Account /> }],
    { initialEntries: ['/home', `/account${rest}`], initialIndex: 1 })
  renderWithQueryClient(<RouterProvider router={router} />)
  return router
}

const placeOf = (router: ReturnType<typeof renderInRouter>) => `${router.state.location.pathname}${router.state.location.search}`

function section(name: string | RegExp): HTMLElement {
  return screen.getByRole('region', { name })
}

const putBodies = (path: string): unknown[] => fetchApi.mock.calls
  .filter(([endpoint, options]) => endpoint === path && options?.method === 'PUT')
  .map(([, options]) => options?.body)

beforeEach(() => {
  fetchApi.mockReset()
  fetchApi.mockResolvedValue({ objectives: [] })
  signOut.mockReset()
  state.isAdmin = false
  state.user = ADA
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com' } }))
})

/** The `<dd>` text of every `<dt>` in the profile section, keyed by label. */
function profileValues(): Record<string, string> {
  const profile = section('Profile')
  return Object.fromEntries(within(profile).getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent.trim() ?? '']))
}

describe('Account — tab bar with deep links', () => {
  it('shows the five tabs on the design-system tabs track, Preferences selected by default (7.54.00, the landing)', () => {
    renderAt()
    const tablist = screen.getByRole('tablist', { name: 'Account' })
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent.trim()))
      .toStrictEqual(['Profile', 'Preferences', 'Morning brief', 'Objectives', 'Access & tokens'])
    expect(tablist).toHaveClass('tabs-track')
    expect(screen.getByRole('tab', { name: 'Preferences' })).toHaveAttribute('aria-selected', 'true')
  })

  it.each([
    ['profile', 'Profile'], ['profile', 'Change Password'], ['profile', 'Sign out'],
    ['preferences', 'Language & theme'], ['preferences', 'Setup checklist'], ['preferences', 'Assistant'],
    ['briefing', 'Morning brief'], ['access', 'My access'], ['access', 'My MCP tokens'],
  ])('/account/%s holds the "%s" card', (id, name) => {
    renderAt(`/${id}`)
    expect(section(name)).toBeInTheDocument()
  })

  it('shows one tab at a time and switches from the bar as a history entry; Back returns', async () => {
    const router = renderInRouter('/profile')
    await userEvent.click(screen.getByRole('tab', { name: 'Access & tokens' }))
    expect({ at: placeOf(router), action: router.state.historyAction }).toStrictEqual({ at: '/account/access', action: 'PUSH' })
    expect([section('My access'), screen.queryByRole('region', { name: 'Profile' })]).toStrictEqual([expect.anything(), null])
    await router.navigate(-1)
    expect(placeOf(router)).toBe('/account/profile')
    expect(await screen.findByRole('tab', { name: 'Profile', selected: true })).toBeInTheDocument()
  })

  it('keeps ?review= (the review modal) on a tab switch', async () => {
    const router = renderInRouter('/profile?review=fb_1')
    await userEvent.click(screen.getByRole('tab', { name: 'Access & tokens' }))
    expect(placeOf(router)).toBe('/account/access?review=fb_1')
  })

  it('reads no tab from the query: an old `?tab=` / `?section=` link opens Preferences, the landing (no redirect)', () => {
    renderAt('?tab=briefing&section=password')
    expect(screen.getByRole('tab', { name: 'Preferences' })).toHaveAttribute('aria-selected', 'true')
  })

  it.each([
    ['/nope', '/account/preferences'], ['/nope?review=fb_1', '/account/preferences?review=fb_1'], ['/briefing/x', '/account/briefing'],
  ])('replaces a path naming no tab, %s, with %s, in place', async (from, to) => {
    const router = renderInRouter(from)
    await waitFor(() => { expect(placeOf(router)).toBe(to) })
    expect(router.state.historyAction).toBe('REPLACE')
    await router.navigate(-1)
    expect(placeOf(router), 'no extra history entry').toBe('/home')
  })

  it('opens the objectives on /account/objectives (Company links here)', async () => {
    renderAt('/objectives')
    expect(await screen.findByRole('button', { name: 'Add objective' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Objectives' })).toHaveAttribute('aria-selected', 'true')
  })

  it('heads every tab with the avatar initial and the user name under one h1', () => {
    renderAt('/preferences')
    expect(screen.getByText('A', { selector: '[aria-hidden="true"]' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Account' }).nextElementSibling).toHaveTextContent('Ada Moreno')
  })

  it('the old profile modal no longer exists anywhere in the source', () => {
    const sources = import.meta.glob(['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })
    const paths = Object.keys(sources)
    expect(paths.length).toBeGreaterThan(100)
    expect(paths.filter((path) => path.includes('UserProfileModal'))).toStrictEqual([])
    expect(Object.entries(sources).filter(([, text]) => text.includes('UserProfileModal')).map(([path]) => path)).toStrictEqual([])
  })
})

describe('Account — morning brief (its only home; Home links here)', () => {
  it("offers the reader's own brief settings, read from their self-scoped preference", async () => {
    renderAt('/briefing')
    // Not subscribed yet (the fixture's default): only the Subscribe control shows.
    expect(await within(section('Morning brief')).findByRole('button', { name: 'Subscribe' })).toBeInTheDocument()
    expect(fetchApi.mock.calls.map(([endpoint]) => endpoint)).toContain('/settings/my-briefing')
  })
})

describe('Account — profile', () => {
  it('lists name, email, username, role and groups', () => {
    renderAt('/profile')
    expect(profileValues()).toStrictEqual({ Name: 'Ada Moreno', Email: 'ada@example.com', Username: 'ada', Role: 'User', Groups: 'users' })
  })

  it('shows Administrator and the admins group for admins', () => {
    state.isAdmin = true
    state.user = { name: 'Root', email: 'root@example.com', username: 'root', groups: ['admins', 'users'] }
    renderAt('/profile')
    expect(profileValues()).toMatchObject({ Role: 'Administrator' })
    expect(within(section('Profile')).getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual(['admins', 'users'])
  })

  it('wraps the page title and a long email instead of cutting them off (200 % text)', () => {
    state.user = { name: 'Ada Moreno', email: 'a-very-long-address.for-testing@example.com', username: 'ada', groups: [] }
    renderAt('/profile')
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveClass('truncate')
    const email = within(section('Profile')).getByText('a-very-long-address.for-testing@example.com')
    expect(email).not.toHaveClass('truncate')
    expect(email).toHaveClass('[overflow-wrap:anywhere]')
  })

  it('renders a dash for missing fields and hides groups when there are none', () => {
    state.user = { email: 'x@example.com', groups: [] }
    renderAt('/profile')
    expect(profileValues()).toStrictEqual({ Name: '—', Email: 'x@example.com', Username: '—', Role: 'User' })
  })
})

describe('Account — preferences: language & theme', () => {
  it('offers every shipped locale under a labelled select and switches language', async () => {
    renderAt('/preferences')
    const select = within(section('Language & theme')).getByRole('combobox', { name: 'Language' })
    expect(select).toHaveValue('en')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toStrictEqual(supportedLanguages.map((l) => languageNames[l]))
    await userEvent.selectOptions(select, 'de')
    expect(changeLanguage).toHaveBeenCalledWith('de')
  })

  it('carries the mode toggle and the colour theme picker', () => {
    renderAt('/preferences')
    expect(within(section('Language & theme')).getByText('Light or dark')).toBeInTheDocument()
    expect(within(section('Language & theme')).getByRole('button')).toBeInTheDocument()
    expect(within(section('Language & theme')).getByRole('radiogroup', { name: 'Colour theme' })).toBeInTheDocument()
  })
})

describe('Account — objectives & KPIs', () => {
  it('saves the caller\u2019s own objective with a KPI', async () => {
    const save = vi.fn((body: unknown) => body)
    fetchApi.mockImplementation((endpoint, options) => {
      if (options?.method === 'PUT') return Promise.resolve(save(parsedJson(options.body)))
      return endpoint === '/settings/my-context' ? Promise.resolve({ objectives: [] }) : Promise.reject(new Error('API Error: 404'))
    })
    renderAt('/objectives')
    await userEvent.click(await screen.findByRole('button', { name: 'Add objective' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Objective title' }), 'Ship returns redesign')
    await userEvent.click(screen.getByRole('button', { name: 'Add KPI' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'KPI name' }), 'Complaints')
    await userEvent.type(screen.getByRole('textbox', { name: 'Target' }), '-30')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
    // Typed `unknown` on purpose: the matcher is `any`, and an `unknown` slot keeps it out of the literal's type.
    const objectiveId: unknown = expect.stringMatching(/^pobj_/)
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      objectives: [{ id: objectiveId, title: 'Ship returns redesign', description: '', kpis: [{ name: 'Complaints', target: '-30' }] }],
    }))
  })

  it('asks for configuration instead of calling the API when no endpoint is set', () => {
    useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: '' } }))
    renderAt('/objectives')
    expect(fetchApi).not.toHaveBeenCalled()
  })
})

describe('Account — MCP tokens and sign out', () => {
  it('points MCP tokens to Connect', () => {
    renderAt('/access')
    expect(within(section('My MCP tokens')).getByRole('link', { name: 'Go to Connect' })).toHaveAttribute('href', '/connect')
  })

  it('signs out from the page: clears cached data, ends the session, loads /login', async () => {
    const queryClient = createTestQueryClient({ gcTime: Infinity })
    renderAt('/profile', queryClient)
    queryClient.setQueryData(['feedback'], { items: ['private'] })
    // A full page load to the plain sign-in page (hooks/useSignOut.ts).
    const assign = stubLocationAssign()
    await userEvent.click(within(section('Sign out')).getByRole('button', { name: 'Sign out' }))
    expect(queryClient.getQueryData(['feedback'])).toBeUndefined()
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledExactlyOnceWith('/login')
  })
})

describe('Account — preferences: setup checklist, start page, "How it works"', () => {
  const ONBOARDING = '/settings/my-onboarding'
  const server: { onboarding: Record<string, unknown> } = { onboarding: {} }

  beforeEach(() => {
    server.onboarding = { state: 'dismissed', visible: false }
    fetchApi.mockImplementation((endpoint, options) => {
      if (endpoint !== ONBOARDING) return Promise.resolve({ objectives: [] })
      if (options?.method === 'PUT') {
        const body: unknown = JSON.parse(typeof options.body === 'string' ? options.body : '{}')
        const changes = typeof body === 'object' && body !== null ? body : {}
        const stateChange = 'state' in changes ? { state: changes.state, visible: changes.state === 'active' } : {}
        server.onboarding = { ...server.onboarding, ...stateChange, ...changes }
      }
      return Promise.resolve(server.onboarding)
    })
  })

  it('switches "open the dashboard when I sign in" off again', async () => {
    server.onboarding = { state: 'dismissed', visible: false, start_page: 'dashboard' }
    renderAt('/preferences')
    const control = await within(section('Setup checklist')).findByRole('switch', { name: 'Open the dashboard when I sign in' })
    await waitFor(() => expect(control).toBeChecked())
    await userEvent.click(control)
    await waitFor(() => expect(control).not.toBeChecked())
    expect(putBodies(ONBOARDING)).toStrictEqual([JSON.stringify({ start_page: 'home' })])
  })

  // Live finding: the two inline switches ran together on one line.
  it('puts the start-page and "How it works" switches on rows of their own', async () => {
    renderAt('/preferences')
    const region = section('Setup checklist')
    const rows = (await within(region).findAllByRole('switch')).map((s) => s.closest('.flex-col'))
    expect(rows[0]).not.toBeNull()
    expect(new Set(rows).size).toBe(1)
  })

  it('says the checklist is off and brings it back on Home, server-side', async () => {
    renderAt('/preferences')
    const region = section('Setup checklist')
    expect(await within(region).findByText('Turned off')).toBeInTheDocument()
    await userEvent.click(within(region).getByRole('button', { name: 'Show on Home' }))
    expect(await within(region).findByText('Showing on Home')).toBeInTheDocument()
    expect(putBodies(ONBOARDING)).toStrictEqual([JSON.stringify({ state: 'active' })])
  })

  it('collapses "How it works" on Home from here (the guide preference)', async () => {
    server.onboarding = { state: 'dismissed', visible: false, guide: 'open' }
    renderAt('/preferences')
    const guide = await within(section('Setup checklist')).findByRole('switch', { name: 'Show "How it works" expanded on Home' })
    await waitFor(() => expect(guide).toBeChecked())
    await userEvent.click(guide)
    await waitFor(() => expect(putBodies(ONBOARDING)).toStrictEqual([JSON.stringify({ guide: 'skipped' })]))
  })

  it('shows when a snooze ends', async () => {
    server.onboarding = { state: 'hidden', visible: false, hidden_until: '2026-10-07T12:00:00+00:00' }
    renderAt('/preferences')
    expect(await within(section('Setup checklist')).findByText(/^Hidden until /)).toBeInTheDocument()
  })
})

describe('Account — assistant (the same store as the panel bell and the launcher)', () => {
  beforeEach(() => {
    useAssistantUiStore.setState({ notify: false })
    useBubbleStore.setState({ positions: {} })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('offers desktop notifications, and says why when this browser has none', () => {
    renderAt('/preferences')
    const control = within(section('Assistant')).getByRole('switch', { name: 'Desktop notifications' })
    expect(control).toBeDisabled()
    expect(control).toHaveAccessibleDescription(/This browser does not support notifications/)
  })

  it('turns notifications off in the shared store when the browser allows them', async () => {
    vi.stubGlobal('Notification', Object.assign(function FakeNotification() {}, { permission: 'granted', requestPermission: vi.fn() }))
    useAssistantUiStore.setState({ notify: true })
    renderAt('/preferences')
    const control = within(section('Assistant')).getByRole('switch', { name: 'Desktop notifications' })
    expect(control).toBeChecked()
    await userEvent.click(control)
    expect(useAssistantUiStore.getState().notify).toBe(false)
  })

  it("resets the caller's own bubble position and leaves other users' alone", async () => {
    useBubbleStore.setState({ positions: { ada: { right: 300, bottom: 200 }, other: { right: 10, bottom: 10 } } })
    renderAt('/preferences')
    await userEvent.click(within(section('Assistant')).getByRole('button', { name: 'Reset bubble position' }))
    expect(useBubbleStore.getState().positions).toStrictEqual({ other: { right: 10, bottom: 10 } })
    expect(screen.getByRole('button', { name: 'Reset bubble position' })).toBeDisabled()
  })
})

describe('Account — my access (read-only, GET /feedback/access)', () => {
  it('shows a restricted category list and the default source rule (restricted sources hidden)', async () => {
    fetchApi.mockImplementation((endpoint) => Promise.resolve(endpoint === '/feedback/access'
      ? { all: false, categories: ['delivery', 'pricing'], sources_all: false, sources: [], source_rule: 'deny', sources_denied: ['internal_tickets'] }
      : {}))
    renderAt('/access')
    const region = section('My access')
    expect(await within(region).findByText('Every source except:')).toBeInTheDocument()
    expect(within(region).getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual(['delivery', 'pricing', 'internal_tickets'])
    expect(within(region).getByText('User')).toBeInTheDocument()
  })

  it('says every category and every source for an unrestricted caller', async () => {
    fetchApi.mockResolvedValue({ all: true, categories: [], sources_all: true, sources: [], source_rule: 'all', sources_denied: [] })
    renderAt('/access')
    expect(await within(section('My access')).findByText('Every category')).toBeInTheDocument()
    expect(within(section('My access')).getByText('Every source')).toBeInTheDocument()
  })

  it('lists an explicit source grant', async () => {
    fetchApi.mockResolvedValue({ all: true, categories: [], sources_all: false, sources: ['webscraper'], source_rule: 'allow', sources_denied: [] })
    renderAt('/access')
    expect(await within(section('My access')).findByText('Only these sources:')).toBeInTheDocument()
    expect(within(section('My access')).getByRole('listitem')).toHaveTextContent('webscraper')
  })

  it('reports a failed read', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    renderAt('/access')
    expect(await within(section('My access')).findByRole('alert')).toHaveTextContent('Could not load your access.')
  })
})

function advanced(): HTMLElement {
  const summary = screen.getByText('Advanced', { selector: 'summary' })
  const details = summary.parentElement
  if (!(details instanceof HTMLDetailsElement)) throw new Error('Advanced is not a <details>')
  return details
}

describe('Account — this browser, under "Advanced" (moved from Administration → General)', () => {
  it("shows this browser's API endpoint and clears the local settings after confirming", async () => {
    useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com', brandName: 'Acme' } }))
    renderAt('/preferences')
    expect(within(advanced()).getByText('https://api.example.com')).toBeInTheDocument()
    await userEvent.click(within(advanced()).getByRole('button', { name: 'Reset Settings' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset' }))
    expect(useConfigStore.getState().config).toMatchObject({ apiEndpoint: '', brandName: '' })
  })

})

describe('Account — Reset local settings, in every workspace', () => {
  const saved = withMemoryLocalStorage()

  it("clears this browser's config in every workspace too, not only the page's own", async () => {
    // Where the config store keeps a workspace's record (store/configStore.ts, workspace/workspaceStorage.ts).
    saved.set('voc-config:w/juniper', '{"state":{"timeRange":"7d"},"version":3}')
    saved.set('voc-assistant-ui:w/juniper', '{}')
    renderAt('/preferences')
    await userEvent.click(within(advanced()).getByRole('button', { name: 'Reset Settings' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset' }))
    // The page's own config, cleared; juniper's gone; another store's record untouched.
    expect([...saved.keys()].filter((key) => key.startsWith('voc-config') || key.startsWith('voc-assistant-ui'))).toStrictEqual(['voc-assistant-ui:w/juniper', 'voc-config'])
  })

  it('is collapsed while an API endpoint is configured', () => {
    useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com' } }))
    renderAt('/preferences')
    expect(advanced()).not.toHaveAttribute('open')
  })

  it('is open when no API endpoint is set, so "Go to settings" lands on why', () => {
    useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: '' } }))
    renderAt('/preferences')
    expect(advanced()).toHaveAttribute('open')
  })
})
