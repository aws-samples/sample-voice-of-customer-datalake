/**
 * @fileoverview Tests for Home: the getting-started page with the onboarding
 * buddy (self-checking checklist, Ready, Hide / Don't show again / Skip,
 * re-open), the collapsible sections (a skipped checklist or guide starts
 * collapsed, expanding un-skips it), the brief settings living on Account
 * (Home keeps the subscribe call to action and a Settings link), and the live
 * agent-decision cards.
 * @module pages/Home
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { LANDING_STATE } from '../../utils/landing'

const auth = vi.hoisted(() => ({ isAdmin: true, sub: 'me-sub' }))

vi.mock('../../api/client', async (importOriginal) => {
  const { clientWithMockedFetchApi, fetchApi: routed } = await import('@test/fetchApiRoutes')
  const mocked = await clientWithMockedFetchApi(importOriginal)
  // useCategoriesConfig calls api.getCategoriesConfig, whose fetchApi is module-internal.
  return {
    ...mocked,
    api: {
      ...mocked.api,
      getCategoriesConfig: () => routed('/settings/categories'),
      getSummary: (range: { days?: number }) => routed(`/metrics/summary?days=${range.days ?? 0}`),
    },
  }
})
vi.mock('../../store/authStore', () => ({
  useIsAdmin: () => auth.isAdmin,
  useAuthStore: () => ({ user: { sub: auth.sub, name: 'Ana', email: 'user@example.com', groups: auth.isAdmin ? ['admins'] : ['users'] } }),
}))
vi.mock('../../assistant/store/openAssistant', () => ({ openAssistant: vi.fn() }))

const { default: Home } = await import('./Home')

const PATH = '/settings/my-onboarding'
const SESSIONS = '/chat/conversations/_list?kind=assistant'
const NO_SIGNALS = { feedback_present: false, feedback_form_configured: false }
const WAITING_RUN = {
  run_id: 'run_1', agent_id: 'ag_1', status: 'needs_human', finished_at: '2026-10-06T09:30:00Z', actions: ['accept'],
  needs_human: { reason: 'loop_exhausted', node_id: 'review', node_title: 'Persona review', max_rounds: 3, verdicts: [] },
}
const waitingAgent = (id: string, runId: string) =>
  ({ agent_id: id, name: `Agent ${id}`, stats: { last_run_status: 'needs_human', last_run_id: runId } })
const AGENT_RUNS_TODO = { id: 'todo_agent_runs_1', kind: 'todo_agent_runs', layer: 'personal', severity: 'info',
  title: '1 agent run waits for you', body: '', feedback_ids: [], facts: {}, actions: [] }

interface World {
  preference: Record<string, unknown>
  categories: unknown[]
  sessions: unknown[]
  projects: unknown[]
  scrapers: unknown[]
  agents: unknown[]
  briefCards: unknown[]
  /** What `GET /feedback/access` answers: the caller's scope. */
  access: Record<string, unknown>
  failPut?: boolean
}

const FULL_ACCESS = { all: true, categories: [], sources_all: true, sources: [], source_rule: 'all', sources_denied: [] }

function emptyWorld(): World {
  return {
    preference: { state: 'active', visible: true, signals: NO_SIGNALS },
    categories: [], sessions: [], projects: [], scrapers: [], agents: [], briefCards: [], access: FULL_ACCESS,
  }
}

function doneWorld(): World {
  return {
    preference: { state: 'active', visible: true, signals: { feedback_present: true, feedback_form_configured: true } },
    categories: [{ id: 'c1', name: 'delivery', product: 'Shop', subcategories: [] }],
    sessions: [{ id: 'thread_1', title: 'Top complaints', kind: 'assistant', updatedAt: '2026-10-06T10:00:00Z' }],
    projects: [{ project_id: 'p1', name: 'Mine', owner: { sub: 'me-sub', username: 'me', email: '' } }],
    scrapers: [], agents: [], briefCards: [], access: FULL_ACCESS,
  }
}

/** The in-memory server state the routes answer from (a holder, so tests replace it without `let`). */
const server: { world: World } = { world: emptyWorld() }

/** The shared setup stubs localStorage with no-op mocks; give this suite a real in-memory one. */
const storage = new Map<string, string>()
function useInMemoryStorage(): void {
  storage.clear()
  vi.mocked(window.localStorage.getItem).mockImplementation((key) => storage.get(key) ?? null)
  vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => { storage.set(key, value) })
}

/** Route every call Home makes against the in-memory `world`; PUTs behave like the server. */
function serve(): void {
  const routes: Record<string, RouteHandler> = {
    [`GET ${PATH}`]: () => server.world.preference,
    [`PUT ${PATH}`]: (body) => {
      if (server.world.failPut === true) throw new Error('API Error: 500')
      const changes = typeof body === 'object' && body !== null ? body : {}
      const stateChange = 'state' in changes ? { state: changes.state, visible: changes.state === 'active' } : {}
      const pageChange = 'start_page' in changes ? { start_page: changes.start_page } : {}
      const guideChange = 'guide' in changes ? { guide: changes.guide } : {}
      const promptChange = 'subscribe_prompt' in changes ? { subscribe_prompt: changes.subscribe_prompt } : {}
      const stored: unknown = server.world.preference.dismissed_decision_runs
      const runChange = 'dismiss_decision_run' in changes
        ? { dismissed_decision_runs: [changes.dismiss_decision_run, ...(Array.isArray(stored) ? stored.map(String) : [])] }
        : {}
      server.world.preference = {
        ...server.world.preference, ...stateChange, ...pageChange, ...guideChange, ...promptChange, ...runChange,
      }
      return server.world.preference
    },
    'GET /settings/categories': () => ({ categories: server.world.categories }),
    'GET /feedback/access': () => server.world.access,
    [`GET ${SESSIONS}`]: () => ({ conversations: server.world.sessions }),
    'GET /projects': () => ({ projects: server.world.projects }),
    'GET /scrapers': () => ({ scrapers: server.world.scrapers }),
    'GET /settings/my-briefing': () => ({ enabled: false, hour: 8, time_zone: 'UTC', language: 'en', email: false }),
    'GET /settings/my-briefing/brief': () => ({ status: 'ready', cards: server.world.briefCards, card_state: {} }),
    'GET /agents': () => ({ items: server.world.agents }),
    'GET /agents/ag_1/runs/run_1': () => ({ run: WAITING_RUN }),
    'GET /metrics/summary?days=7': () => ({ period_days: 7, total_feedback: 0, avg_sentiment: 0, urgent_count: 0 }),
    'GET /metrics/summary?days=14': () => ({ period_days: 14, total_feedback: 0, avg_sentiment: 0, urgent_count: 0 }),
  }
  routeFetchApi(routes)
}

/** A visit from the sidebar's Home link (not a landing), unless a test says otherwise. */
const FROM_SIDEBAR = { pathname: '/', key: 'sidebar' }

function renderHome(entry: string | Partial<Location> = FROM_SIDEBAR) {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<p>Dashboard page</p>} />
      </Routes>
    </TestRouter>,
  )
}

const calls = (method: string, path: string) =>
  fetchApi.mock.calls.filter(([endpoint, options]) => endpoint === path && (options?.method ?? 'GET') === method)

const putBodies = (): unknown[] =>
  calls('PUT', PATH).map(([, options]): unknown => (typeof options?.body === 'string' ? JSON.parse(options.body) : null))

async function findBuddy() {
  return screen.findByRole('region', { name: 'Your setup checklist' })
}

/** A collapsible section's chevron button (its heading), not another button of the same name. */
async function toggleOf(name: string): Promise<HTMLElement> {
  const toggle = (await screen.findAllByRole('button', { name })).find((button) => button.hasAttribute('aria-expanded'))
  if (toggle === undefined) throw new Error(`No "${name}" section toggle`)
  return toggle
}

function stepStatuses(): Record<string, string | null> {
  const items = [...document.querySelectorAll('[data-step]')]
  const entries = items.map((li): [string, string | null] => [li.getAttribute('data-step') ?? '', li.getAttribute('data-status')])
  return Object.fromEntries(entries)
}

beforeEach(() => {
  resetFetchApi()
  useInMemoryStorage()
  auth.isAdmin = true
  server.world = emptyWorld()
  serve()
})

describe('Home', () => {
  // Regression: the phase-2 card carried `{ to: '/feedback', labelKey:
  // 'common:nav.feedback' }`. Both were removed when the Feedback list was
  // consolidated into Categories, so i18next fell back to echoing the key and
  // the app's landing page rendered a chip labelled literally "nav.feedback" in
  // all 8 locales then shipped. Reverting the fix makes both of these fail.
  describe('no stale navigation or unresolved labels', () => {
    it('renders no raw i18n key anywhere on the page', async () => {
      const { container } = renderHome()
      await findBuddy()
      // An unresolved i18next key renders as its own dotted path, e.g.
      // "nav.feedback" or "home.phase1Title". Every segment starts lowercase.
      // That last part matters: `textContent` concatenates adjacent blocks
      // without whitespace, so prose yields tokens like "next.How" — requiring a
      // lowercase segment start excludes those without weakening the check.
      const rawKeys = container.textContent
        .split(/\s+/)
        .filter((token) => /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(token))
      expect(rawKeys).toStrictEqual([])
    })

    it('does not link to the removed /feedback route', async () => {
      const { container } = renderHome()
      await findBuddy()
      const hrefs = [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))
      expect(hrefs).not.toContain('/feedback')
      // The signals phase still offers its surviving destinations.
      expect(hrefs).toContain('/categories')
      expect(hrefs).toContain('/problems')
    })
  })

  // Wave 4: the live Home looked like it read the summary twice. It reads two WINDOWS — this
  // week and the fortnight the week-over-week arrows need — and each exactly once.
  it('reads each summary window once on load, never the same one twice', async () => {
    renderHome()
    await findBuddy()
    await waitFor(() => { expect(screen.getByText('Last 7 days')).toBeInTheDocument() })
    const summaries = fetchApi.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/metrics/summary'))
    expect([...summaries].sort((a, b) => a.localeCompare(b))).toStrictEqual(['/metrics/summary?days=14', '/metrics/summary?days=7'])
  })

  describe('greeting', () => {
    it('greets the reader by name', () => {
      renderHome()

      expect(screen.getByRole('heading', { level: 1, name: /^good (morning|afternoon|evening), ana$/i })).toBeInTheDocument()
    })
  })

  describe('how it works', () => {
    it('renders the section and all four phase titles in order', () => {
      renderHome()

      expect(screen.getByRole('heading', { name: /how it works/i })).toBeInTheDocument()

      const phase1 = screen.getByText('Collect & inspect data')
      const phase2 = screen.getByText('Read the signals')
      const phase3 = screen.getByText('Turn insight into ideas')
      const phase4 = screen.getByText('Validate & prioritize')

      expect([phase1, phase2, phase3, phase4].every((phase) => phase.isConnected)).toBe(true)

      // Phases render top-to-bottom in lifecycle order.
      const precedes = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      expect([precedes(phase1, phase2), precedes(phase2, phase3), precedes(phase3, phase4)]).toStrictEqual([true, true, true])
    })

    it('links each phase into the matching sidebar section', () => {
      renderHome()

      const expected = {
        'Data sources': '/scrapers',
        'Data Explorer': '/data-explorer',
        'Problem Analysis': '/problems',
        'AI Chat': '/chat',
        'Projects': '/projects',
        'Feedback Forms': '/feedback-forms',
        'Prioritization': '/prioritization',
      }
      const actual = Object.fromEntries(
        Object.keys(expected).map((name) => [name, screen.getByRole('link', { name }).getAttribute('href')]),
      )
      expect(actual).toStrictEqual(expected)
    })
  })
})

describe('onboarding buddy', () => {
  it('shows progress over the five first-run steps, none done on an empty deployment', async () => {
    renderHome()
    const buddy = await findBuddy()
    await waitFor(() => expect(stepStatuses()).toStrictEqual({
      categories: 'todo', source: 'todo', feedback: 'todo', assistant: 'todo', project: 'todo',
    }))
    const bar = within(buddy).getByRole('progressbar', { name: 'Setup progress' })
    expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax'), bar.getAttribute('aria-valuetext')])
      .toStrictEqual(['0', '5', '0 of 5 done'])
  })

  it('checks steps off from real state and links each to where it is done', async () => {
    server.world = { ...emptyWorld(), categories: doneWorld().categories, sessions: doneWorld().sessions, scrapers: [{ id: 's1', name: 'Shop', base_url: 'https://example.com' }] }
    serve()
    renderHome()
    const buddy = await findBuddy()
    await waitFor(() => expect(stepStatuses()).toStrictEqual({
      categories: 'done', source: 'done', feedback: 'todo', assistant: 'done', project: 'todo',
    }))
    expect(within(buddy).getByRole('progressbar').getAttribute('aria-valuetext')).toBe('3 of 5 done')
    const hrefOf = (name: string) => within(buddy).getByRole('link', { name }).getAttribute('href')
    expect({
      categories: hrefOf('Set up categories'), source: hrefOf('Add a source'), form: hrefOf('Create a form'),
      feedback: hrefOf('Browse feedback'), assistant: hrefOf('Open the assistant'), project: hrefOf('Create a project'),
    }).toStrictEqual({
      categories: '/admin?tab=taxonomy&section=categories', source: '/scrapers', form: '/feedback-forms',
      feedback: '/categories', assistant: '/chat', project: '/projects',
    })
  })

  it('does not count a project shared with the caller as their first', async () => {
    server.world = { ...emptyWorld(), projects: [{ project_id: 'p2', name: 'Theirs', owner: { sub: 'other', username: 'o', email: '' } }] }
    serve()
    renderHome()
    await findBuddy()
    await waitFor(() => expect(stepStatuses()['project']).toBe('todo'))
  })

  it('reads the scraper list only when the signals cannot prove a source', async () => {
    server.world = { ...emptyWorld(), preference: { state: 'active', visible: true, signals: { feedback_present: false, feedback_form_configured: true } } }
    serve()
    renderHome()
    await findBuddy()
    await waitFor(() => expect(stepStatuses()['source']).toBe('done'))
    expect(calls('GET', '/scrapers')).toHaveLength(0)
  })

  it('gives a non-admin only the steps they can take: no categories, source or import step', async () => {
    auth.isAdmin = false
    renderHome()
    await findBuddy()
    await waitFor(() => expect(Object.keys(stepStatuses())).toStrictEqual(['assistant', 'project']))
    expect(calls('GET', '/scrapers')).toHaveLength(0)
  })

  it('treats a restricted caller as unable to set up, and says what the tiles count (owner rule 2026-10-21)', async () => {
    server.world.access = { ...FULL_ACCESS, all: false, categories: ['delivery'], sources_all: false, source_rule: 'deny' }
    server.world.categories = [{ id: 'c1', name: 'delivery', description: 'Delivery', subcategories: [] }]
    renderHome()
    expect(await screen.findByRole('note')).toHaveTextContent('Showing Delivery only — the category you have access to.')
    await waitFor(() => expect(Object.keys(stepStatuses())).toStrictEqual(['assistant', 'project']))
  })

  it('offers Skip until everything is done; a skip is stored and collapses the checklist, still on Home', async () => {
    renderHome()
    const buddy = await findBuddy()
    expect(within(buddy).queryByRole('button', { name: "Don't show again" })).toBeNull()
    await userEvent.click(within(buddy).getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Your setup checklist' })).toHaveAttribute('aria-expanded', 'false'))
    expect({
      puts: putBodies(),
      steps: document.querySelectorAll('[data-step]').length,
      reopen: screen.queryByRole('button', { name: 'Show setup checklist' }),
    }).toStrictEqual({ puts: [{ state: 'skipped' }], steps: 0, reopen: null })
  })

  it('starts a skipped checklist collapsed, reads no step evidence, and expanding it un-skips it', async () => {
    server.world.preference = { state: 'skipped', visible: false, signals: NO_SIGNALS }
    renderHome()
    const toggle = await toggleOf('Your setup checklist')
    expect([toggle.getAttribute('aria-expanded'), calls('GET', SESSIONS).length]).toStrictEqual(['false', 0])
    await userEvent.click(toggle)
    await waitFor(() => expect(stepStatuses()['categories']).toBe('todo'))
    expect(putBodies()).toStrictEqual([{ state: 'active' }])
  })

  describe('when every step is done', () => {
    beforeEach(() => {
      server.world = doneWorld()
      serve()
    })

    it("shows the Ready state with Hide and Don't show again", async () => {
      renderHome()
      const buddy = await findBuddy()
      expect(await within(buddy).findByRole('heading', { name: "You're ready" })).toBeInTheDocument()
      expect(within(buddy).getByRole('progressbar').getAttribute('aria-valuetext')).toBe('5 of 5 done')
      const buttons = within(buddy).getAllByRole('button').map((b) => b.textContent.trim())
      expect(buttons).toStrictEqual(['Your setup checklist', 'Hide for now', "Don't show again"])
    })

    it.each([
      ['Hide for now', 'hidden'],
      ["Don't show again", 'dismissed'],
    ])('%s stores "%s" and shows the normal home', async (button, state) => {
      renderHome()
      const buddy = await findBuddy()
      await userEvent.click(await within(buddy).findByRole('button', { name: button }))
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Your setup checklist' })).toBeNull())
      expect(putBodies()).toStrictEqual([{ state }])
      expect(screen.getByRole('heading', { name: /how it works/i })).toBeInTheDocument()
    })
  })

  it('re-opens from the normal home', async () => {
    server.world.preference = { state: 'dismissed', visible: false, signals: NO_SIGNALS }
    renderHome()
    await userEvent.click(await screen.findByRole('button', { name: 'Show setup checklist' }))
    expect(await findBuddy()).toBeInTheDocument()
    expect(putBodies()).toStrictEqual([{ state: 'active' }])
  })

  it('reads no step evidence while the buddy is off', async () => {
    server.world.preference = { state: 'dismissed', visible: false, signals: NO_SIGNALS }
    renderHome()
    await screen.findByRole('button', { name: 'Show setup checklist' })
    expect([calls('GET', SESSIONS), calls('GET', '/projects'), calls('GET', '/scrapers')].map((c) => c.length)).toStrictEqual([0, 0, 0])
  })

  it('treats the server as the source of truth over a stale local cache', async () => {
    storage.set('voc-onboarding:me-sub', JSON.stringify({ state: 'dismissed', visible: false }))
    renderHome()
    // The cache bridges the first paint (no flash of the buddy)…
    expect(screen.getByRole('button', { name: 'Show setup checklist' })).toBeInTheDocument()
    // …then the server's answer (active) wins and is cached.
    expect(await findBuddy()).toBeInTheDocument()
    expect(JSON.parse(storage.get('voc-onboarding:me-sub') ?? '{}')).toMatchObject({ state: 'active', visible: true })
  })

  it('shows nothing in the buddy slot until the server answers on a fresh browser', () => {
    fetchApi.mockImplementation(() => new Promise(() => {}))
    renderHome()
    expect(screen.queryByRole('region', { name: 'Your setup checklist' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show setup checklist' })).toBeNull()
  })

  it('says so when the choice cannot be saved, and keeps the buddy', async () => {
    server.world.failPut = true
    renderHome()
    const buddy = await findBuddy()
    await userEvent.click(within(buddy).getByRole('button', { name: 'Skip' }))
    expect(await within(buddy).findByRole('alert')).toHaveTextContent("Couldn't save your choice. Try again.")
  })
})

describe('no dashboard shortcuts on Home', () => {
  it('offers neither an "Open dashboard" link nor the start-page switch (the switch lives on Account)', async () => {
    renderHome()
    await findBuddy()
    expect([
      screen.queryByRole('link', { name: 'Open dashboard' }),
      screen.queryByRole('switch', { name: 'Open the dashboard when I sign in' }),
    ]).toStrictEqual([null, null])
  })
})

describe('opening the app with a start page', () => {
  const onDashboard = () => {
    server.world.preference = { ...server.world.preference, start_page: 'dashboard' }
  }

  it.each([
    ['a fresh load of /', '/'],
    ['the redirect after sign-in', { pathname: '/', state: LANDING_STATE, key: 'signed-in' }],
  ])('goes straight to the dashboard on %s', async (_case, entry) => {
    onDashboard()
    renderHome(entry)
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('still shows Home from the sidebar link, with the dashboard start page on', async () => {
    onDashboard()
    renderHome()
    expect(await findBuddy()).toBeInTheDocument()
    expect(screen.queryByText('Dashboard page')).toBeNull()
  })

  it('stays on Home when the start page is Home', async () => {
    renderHome('/')
    expect(await findBuddy()).toBeInTheDocument()
    expect(screen.queryByText('Dashboard page')).toBeNull()
  })

  // Regression: the redirect was re-evaluated on every render, so a start page
  // that changed mid-visit (now: on Account, in another tab) sent the user away.
  it('a start page that changes after opening the app keeps the user on Home until next time', async () => {
    renderHome('/')
    const buddy = await findBuddy()
    server.world.preference = { ...server.world.preference, start_page: 'dashboard' }
    // Any save answers with the whole preference, so the new start page reaches the cache.
    await userEvent.click(within(buddy).getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(putBodies()).toStrictEqual([{ state: 'skipped' }]))
    expect(screen.queryByText('Dashboard page')).toBeNull()
  })

  it('shows nothing on a fresh browser until the start page is known (no flash of Home)', () => {
    fetchApi.mockImplementation(() => new Promise(() => {}))
    renderHome('/')
    expect([screen.queryByRole('heading', { level: 1 }), screen.queryByText('Dashboard page')]).toStrictEqual([null, null])
  })

  it('uses the cached start page at once on a known browser', async () => {
    storage.set('voc-onboarding:me-sub', JSON.stringify({ state: 'dismissed', visible: false, start_page: 'dashboard' }))
    fetchApi.mockImplementation(() => new Promise(() => {}))
    renderHome('/')
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument()
  })
})

describe('"How it works"', () => {
  it('starts expanded; Skip stores guide=skipped and collapses it', async () => {
    renderHome()
    const toggle = await toggleOf('How it works')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const section = screen.getByRole('region', { name: 'How it works' })
    await userEvent.click(within(section).getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'))
    expect([putBodies(), screen.queryByText('Collect & inspect data')]).toStrictEqual([[{ guide: 'skipped' }], null])
  })

  it('starts collapsed when skipped, and expanding it opens it again', async () => {
    server.world.preference = { ...server.world.preference, guide: 'skipped' }
    renderHome()
    await waitFor(() => expect(screen.getByRole('button', { name: 'How it works' })).toHaveAttribute('aria-expanded', 'false'))
    await userEvent.click(screen.getByRole('button', { name: 'How it works' }))
    expect(await screen.findByText('Collect & inspect data')).toBeInTheDocument()
    expect(putBodies()).toStrictEqual([{ guide: 'open' }])
  })
})

describe('brief settings live on Account (docs/account-vs-admin.md)', () => {
  it('shows only the compact subscribe call to action before the reader subscribes, not the settings form', async () => {
    renderHome()
    expect(await screen.findByRole('heading', { name: 'Subscribe to the morning brief' })).toBeInTheDocument()
    expect([screen.queryByRole('switch', { name: 'Email me the brief' }), screen.queryByRole('region', { name: 'Brief settings' })]).toStrictEqual([null, null])
    expect(screen.queryByRole('combobox', { name: 'Time to send' })).toBeNull()
  })

  it("links the header's Settings to Account's Morning brief section", async () => {
    renderHome()
    expect(await screen.findByRole('link', { name: 'Brief settings' })).toHaveAttribute('href', '/account?tab=briefing')
  })

  it('closes the subscribe card with its X, stored server-side as subscribe_prompt=dismissed', async () => {
    renderHome()
    await screen.findByRole('heading', { name: 'Subscribe to the morning brief' })
    await userEvent.click(screen.getByRole('button', { name: 'Close: Subscribe to the morning brief' }))
    expect(screen.queryByRole('heading', { name: 'Subscribe to the morning brief' })).toBeNull()
    await waitFor(() => expect(putBodies()).toStrictEqual([{ subscribe_prompt: 'dismissed' }]))
  })

  it('does not show the subscribe card once the reader closed it', async () => {
    server.world.preference = { ...server.world.preference, subscribe_prompt: 'dismissed' }
    renderHome()
    await findBuddy()
    expect(screen.queryByRole('heading', { name: 'Subscribe to the morning brief' })).toBeNull()
  })

  it('puts the subscribe card back when closing it cannot be saved', async () => {
    server.world.failPut = true
    renderHome()
    await screen.findByRole('heading', { name: 'Subscribe to the morning brief' })
    await userEvent.click(screen.getByRole('button', { name: 'Close: Subscribe to the morning brief' }))
    expect(await screen.findByRole('heading', { name: 'Subscribe to the morning brief' })).toBeInTheDocument()
  })
})

describe('agent decisions', () => {
  it('shows no decision card when no agent waits', async () => {
    server.world.agents = [{ agent_id: 'ag_2', name: 'Done', stats: { last_run_status: 'completed', last_run_id: 'r' } }]
    renderHome()
    await waitFor(() => expect(calls('GET', '/agents')).toHaveLength(1))
    expect(screen.queryByRole('region', { name: 'Agent decisions' })).toBeNull()
  })

  it.each([
    [true, 'Make the decision'],
    [false, 'Review the run'],
  ])('admin=%s: one card per waiting agent, with the reason and a "%s" link to its runs', async (isAdmin, label) => {
    auth.isAdmin = isAdmin
    server.world.agents = [waitingAgent('ag_1', 'run_1')]
    renderHome()
    const card = await screen.findByRole('heading', { name: 'Agent ag_1 needs your decision' })
    expect(await screen.findByText('The personas did not agree on the Persona review after 3 rounds.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: label }).getAttribute('href')).toBe('/agents/ag_1?tab=runs')
    expect(card).toBeInTheDocument()
  })

  it('still shows the card with the generic reason when its run cannot be read', async () => {
    server.world.agents = [waitingAgent('ag_9', 'run_gone')]
    renderHome()
    expect(await screen.findByRole('heading', { name: 'Agent ag_9 needs your decision' })).toBeInTheDocument()
    expect(screen.getByText('The run stopped for a person to decide.')).toBeInTheDocument()
  })

  it('closes a card with its X for that waiting run only, stored server-side', async () => {
    server.world.agents = [waitingAgent('ag_1', 'run_1'), waitingAgent('ag_9', 'run_gone')]
    renderHome()
    await screen.findByRole('heading', { name: 'Agent ag_1 needs your decision' })
    await userEvent.click(screen.getByRole('button', { name: 'Close: Agent ag_1 needs your decision' }))
    expect(screen.queryByRole('heading', { name: 'Agent ag_1 needs your decision' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Agent ag_9 needs your decision' })).toBeInTheDocument()
    await waitFor(() => expect(putBodies()).toStrictEqual([{ dismiss_decision_run: 'run_1' }]))
  })

  it.each([
    ['hides the card of a closed run', 'run_1', 0],
    ['shows the card again for a later waiting run', 'run_2', 1],
  ])('%s', async (_case, waitingRunId, cards) => {
    server.world.preference = { ...server.world.preference, dismissed_decision_runs: ['run_1'] }
    server.world.agents = [waitingAgent('ag_1', waitingRunId)]
    renderHome()
    await findBuddy()
    await waitFor(() => expect(calls('GET', '/agents')).toHaveLength(1))
    await waitFor(() => expect(screen.queryAllByRole('heading', { name: 'Agent ag_1 needs your decision' })).toHaveLength(cards))
  })

  it.each([
    ['hides', [waitingAgent('ag_1', 'run_1')], 0],
    ['keeps', [], 1],
  ])('%s the brief\'s "agent runs" to-do row', async (_case, agents, rows) => {
    server.world.agents = agents
    server.world.briefCards = [AGENT_RUNS_TODO]
    renderHome()
    await screen.findByRole('heading', { name: 'Things to do' })
    await waitFor(() => expect(calls('GET', '/agents')).toHaveLength(1))
    await waitFor(() => expect(document.querySelectorAll('[data-card-kind="todo_agent_runs"]')).toHaveLength(rows))
  })
})
