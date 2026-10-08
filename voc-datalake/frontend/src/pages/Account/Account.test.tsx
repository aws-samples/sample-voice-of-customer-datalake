/**
 * Account (todofeatures §6.1) is ONE page: profile, password, language & theme,
 * the caller's own objectives & KPIs, MCP tokens pointer and sign out. It
 * replaced the old user-profile modal and the two-tab Account page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { QueryClient } from '@tanstack/react-query'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { useConfigStore } from '../../store/configStore'
import { languageNames, supportedLanguages } from '../../i18n/languages'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
const signOut = vi.fn<() => void>()
const navigate = vi.fn<(to: string) => void>()
interface TestUser { name?: string; email?: string; username?: string; groups: string[] }
const ADA: TestUser = { name: 'Ada Lovelace', email: 'ada@example.com', username: 'ada', groups: ['users'] }
const state = vi.hoisted((): { isAdmin: boolean; user: TestUser | null } => ({ isAdmin: false, user: null }))

vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))
vi.mock('../../store/authStore', () => ({
  useIsAdmin: () => state.isAdmin,
  useAuthStore: () => ({ user: state.user }),
}))
vi.mock('../../services/auth', () => ({ authService: { signOut: () => signOut(), changePassword: vi.fn() } }))
vi.mock('../../i18n/languages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/languages')>()
  return { ...actual, changeLanguage: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

const { default: Account } = await import('./Account')
const { changeLanguage } = await import('../../i18n/languages')

function renderAt(search = '', queryClient: QueryClient = createTestQueryClient()) {
  return renderWithQueryClient(<TestRouter initialEntries={[`/account${search}`]}><Account /></TestRouter>, queryClient)
}

function section(name: string | RegExp): HTMLElement {
  return screen.getByRole('region', { name })
}

beforeEach(() => {
  fetchApi.mockReset()
  fetchApi.mockResolvedValue({ objectives: [] })
  signOut.mockReset()
  navigate.mockReset()
  state.isAdmin = false
  state.user = ADA
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com' } }))
})

/** The `<dd>` text of every `<dt>` in the profile section, keyed by label. */
function profileValues(): Record<string, string> {
  const profile = section('Profile')
  return Object.fromEntries(within(profile).getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent.trim() ?? '']))
}

describe('Account — one page, no tabs, no dialog', () => {
  it.each(['Profile', 'Language & theme', 'Change Password', 'My MCP tokens', 'Sign out'])('shows the "%s" section as a labelled region', (name) => {
    renderAt()
    expect(section(name)).toBeInTheDocument()
  })

  it('puts objectives on the same page under one h1, with no tabs and no dialog', async () => {
    renderAt()
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Add objective' })).toBeInTheDocument()
    expect([screen.queryByRole('tablist'), screen.queryByRole('tab'), screen.queryByRole('dialog')]).toStrictEqual([null, null, null])
  })

  it('heads the page with the avatar initial and the user name', () => {
    renderAt()
    expect(screen.getByText('A', { selector: '[aria-hidden="true"]' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 }).nextElementSibling).toHaveTextContent('Ada Lovelace')
  })

  it('the old profile modal no longer exists anywhere in the source', () => {
    const sources = import.meta.glob(['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })
    const paths = Object.keys(sources)
    expect(paths.length).toBeGreaterThan(100)
    expect(paths.filter((path) => path.includes('UserProfileModal'))).toStrictEqual([])
    expect(Object.entries(sources).filter(([, text]) => String(text).includes('UserProfileModal')).map(([path]) => path)).toStrictEqual([])
  })
})

describe('Account — profile (was the modal profile tab + the page profile card)', () => {
  it('lists name, email, username, role and groups', () => {
    renderAt()
    expect(profileValues()).toStrictEqual({ Name: 'Ada Lovelace', Email: 'ada@example.com', Username: 'ada', Role: 'User', Groups: 'users' })
  })

  it('shows Administrator and the admins group for admins', () => {
    state.isAdmin = true
    state.user = { name: 'Root', email: 'root@example.com', username: 'root', groups: ['admins', 'users'] }
    renderAt()
    expect(profileValues()).toMatchObject({ Role: 'Administrator' })
    expect(within(section('Profile')).getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual(['admins', 'users'])
  })

  it('renders a dash for missing fields and hides groups when there are none', () => {
    state.user = { email: 'x@example.com', groups: [] }
    renderAt()
    expect(profileValues()).toStrictEqual({ Name: '—', Email: 'x@example.com', Username: '—', Role: 'User' })
  })
})

describe('Account — language & theme', () => {
  it('offers every shipped locale under a labelled select and switches language', async () => {
    renderAt()
    const select = within(section('Language & theme')).getByRole('combobox', { name: 'Language' })
    expect(select).toHaveValue('en')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toStrictEqual(supportedLanguages.map((l) => languageNames[l]))
    await userEvent.selectOptions(select, 'de')
    expect(changeLanguage).toHaveBeenCalledWith('de')
  })

  it('carries the theme toggle', () => {
    renderAt()
    expect(within(section('Language & theme')).getByText('Theme')).toBeInTheDocument()
    expect(within(section('Language & theme')).getByRole('button')).toBeInTheDocument()
  })
})

describe('Account — objectives & KPIs (was the second Account tab)', () => {
  // The stub's restore function is the teardown.
  beforeEach(() => stubElementScrollIntoView())

  it('saves the caller\u2019s own objective with a KPI', async () => {
    const save = vi.fn((body: unknown) => body)
    fetchApi.mockImplementation((endpoint, options) => {
      if (options?.method === 'PUT') return Promise.resolve(save(JSON.parse(String(options.body))))
      return endpoint === '/settings/my-context' ? Promise.resolve({ objectives: [] }) : Promise.reject(new Error('API Error: 404'))
    })
    renderAt()
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

  it('scrolls to the objectives on the old ?tab=objectives deep link', async () => {
    renderAt('?tab=objectives')
    await screen.findByRole('button', { name: 'Add objective' })
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('waits for the objectives to load before scrolling (an early scroll is clamped by the short page)', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    fetchApi.mockReturnValue(new Promise((resolve) => { resolvers.push(resolve) }))
    renderAt('?tab=objectives')
    await waitFor(() => expect(fetchApi.mock.calls.filter(([endpoint]) => endpoint === '/settings/my-context')).toHaveLength(1))
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
    resolvers.forEach((resolve) => resolve({ objectives: [] }))
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1))
  })

  it('does not scroll on a plain /account visit', async () => {
    renderAt()
    await screen.findByRole('button', { name: 'Add objective' })
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it('asks for configuration instead of calling the API when no endpoint is set', () => {
    useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: '' } }))
    renderAt()
    expect(fetchApi).not.toHaveBeenCalled()
  })
})

describe('Account — MCP tokens and sign out', () => {
  it('points MCP tokens to Connect', () => {
    renderAt()
    expect(within(section('My MCP tokens')).getByRole('link', { name: 'Go to Connect' })).toHaveAttribute('href', '/connect')
  })

  it('signs out from the page: clears cached data, ends the session, goes to /login', async () => {
    const queryClient = createTestQueryClient({ gcTime: Infinity })
    renderAt('', queryClient)
    queryClient.setQueryData(['feedback'], { items: ['private'] })
    await userEvent.click(within(section('Sign out')).getByRole('button', { name: 'Sign out' }))
    expect(queryClient.getQueryData(['feedback'])).toBeUndefined()
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/login')
  })
})

describe('Account — setup checklist (the way back to the onboarding buddy)', () => {
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
        server.onboarding = { ...server.onboarding, ...stateChange, ...('start_page' in changes ? { start_page: changes.start_page } : {}) }
      }
      return Promise.resolve(server.onboarding)
    })
  })

  it('switches "open the dashboard when I sign in" off again', async () => {
    server.onboarding = { state: 'dismissed', visible: false, start_page: 'dashboard' }
    renderAt()
    const control = await within(section('Setup checklist')).findByRole('switch', { name: 'Open the dashboard when I sign in' })
    await waitFor(() => expect(control).toBeChecked())
    await userEvent.click(control)
    await waitFor(() => expect(control).not.toBeChecked())
    const puts = fetchApi.mock.calls.filter(([endpoint, options]) => endpoint === ONBOARDING && options?.method === 'PUT')
    expect(puts.map(([, options]) => options?.body)).toStrictEqual([JSON.stringify({ start_page: 'home' })])
  })

  it('says the checklist is off and brings it back on Home, server-side', async () => {
    renderAt()
    const region = section('Setup checklist')
    expect(await within(region).findByText('Turned off')).toBeInTheDocument()
    await userEvent.click(within(region).getByRole('button', { name: 'Show on Home' }))
    expect(await within(region).findByText('Showing on Home')).toBeInTheDocument()
    const puts = fetchApi.mock.calls.filter(([endpoint, options]) => endpoint === ONBOARDING && options?.method === 'PUT')
    expect(puts.map(([, options]) => options?.body)).toStrictEqual([JSON.stringify({ state: 'active' })])
    expect(within(region).getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/')
  })

  it('shows when a snooze ends', async () => {
    server.onboarding = { state: 'hidden', visible: false, hidden_until: '2026-10-07T12:00:00+00:00' }
    renderAt()
    expect(await within(section('Setup checklist')).findByText(/^Hidden until /)).toBeInTheDocument()
  })
})
