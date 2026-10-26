/**
 * @fileoverview Tests for Layout component.
 */
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { tabTimes } from '@test/keyboard'
import { Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/TestRouter'

// Mock API before importing component
const mockGetUrgentFeedback = vi.fn<(params: unknown) => Promise<unknown>>()
const mockGetSummary = vi.fn<(params: unknown) => Promise<unknown>>()
const mockGetBrandSettings = vi.fn(() => Promise.resolve({ brand_name: 'Test Brand' }))

// Mock stores
vi.mock('../../store/configStore', () => import('@test/page-mocks').then((m) => m.configStoreHookMock({
  timeRange: '7d',
  config: { apiEndpoint: 'https://api.example.com', brandName: 'Test Brand' },
  setConfig: () => undefined,
})))

vi.mock('../../api/client', () => ({
  api: {
    getUrgentFeedback: (params: unknown) => mockGetUrgentFeedback(params),
    getSummary: (params: unknown) => mockGetSummary(params),
    getBrandSettings: () => mockGetBrandSettings(),
  },
  getDateRangeParams: () => ({ days: 7 }),
}))

const mockSignOut = vi.fn<() => void>()
vi.mock('../../services/auth', () => ({
  authService: {
    signOut: () => mockSignOut(),
  },
}))

// Mock authStore with useIsAdmin
const authState = vi.hoisted(() => ({
  DEFAULT: { isAuthenticated: true, user: { username: 'testuser', email: 'test@example.com' } },
}))
vi.mock('../../store/authStore', () => ({
  useAuthStore: vi.fn(() => authState.DEFAULT),
  useIsAdmin: vi.fn(() => true),
}))

// Mock menu config so P11 gating tests can toggle individual items.
// Defaults to all-enabled so existing tests see every nav link.
const mockIsMenuItemEnabled = vi.fn((_key: string) => true)
vi.mock('../../config/menuConfig', () => ({
  isMenuItemEnabled: (key: string) => mockIsMenuItemEnabled(key),
}))

vi.mock('react-router-dom', () => import('@test/page-mocks').then((m) => m.routerWithNavigateSpy()))

// Mock child components to simplify testing
vi.mock('../TimeRangeSelector/TimeRangeSelector', () => ({
  default: () => <div data-testid="time-range-selector">TimeRangeSelector</div>,
}))

vi.mock('../Breadcrumbs/Breadcrumbs', () => ({
  default: () => <div data-testid="breadcrumbs">Breadcrumbs</div>,
}))

// The assistant has its own suites (src/assistant); here only its mount point matters.
vi.mock('../../assistant/components/AssistantRoot', () => ({
  default: () => <div data-testid="assistant-root" />,
}))

vi.mock('../ReviewModal/ReviewModalHost', () => ({
  default: () => <div data-testid="review-modal-host" />,
}))

import Layout from './Layout'
import { useAuthStore, useIsAdmin } from '../../store/authStore'

/**
 * @param initialEntries - router history to start from
 * @param queryClient - pass one in to inspect the cache after interacting
 */
function createWrapper(
  initialEntries = ['/'],
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={initialEntries}>
        <Routes>
          <Route element={children}>
            <Route path="/" element={<div>Dashboard Content</div>} />
            <Route path="/categories" element={<div>Categories Content</div>} />
            <Route path="/chat" element={<div>Chat Content</div>} />
            <Route path="/admin" element={<div>Administration Content</div>} />
            {/* Any other path still renders the shell, so header behaviour can be checked per route. */}
            <Route path="*" element={<div>Other Content</div>} />
          </Route>
        </Routes>
      </TestRouter>
    </QueryClientProvider>
  )
}

/** Mount the layout and wait until the phase headers have rendered. */
async function renderNavWithPhases() {
  render(<Layout />, { wrapper: createWrapper() })
  await screen.findByText('Listen')
}

describe('Layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSummary.mockResolvedValue({ urgent_count: 0 })
  })

  describe('sidebar', () => {
    it('displays brand name from config', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Test Brand')).toBeInTheDocument()
      })
    })

    it('displays VoC Analytics title', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('VoC Analytics')).toBeInTheDocument()
      })
    })
  })

  describe('navigation', () => {
    it('displays Dashboard nav link', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
      })
    })

    it.each([
      ['AI Chat', /ai chat/i],
      ['Administration', /administration/i],
      ['Categories', /categories/i],
    ])('displays the %s nav link', async (_label, name) => {
      render(<Layout />, { wrapper: createWrapper() })

      expect(await screen.findByRole('link', { name })).toBeInTheDocument()
    })

    it('does not display a Feedback nav link (consolidated into Categories, issue #198)', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /categories/i })).toBeInTheDocument()
      })
      expect(screen.queryByRole('link', { name: /^feedback$/i })).not.toBeInTheDocument()
    })

    it('displays Projects nav link', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /projects/i })).toBeInTheDocument()
      })
    })
  })

  describe('urgent feedback badge', () => {
    it('shows the urgent count from the summary aggregate', async () => {
      mockGetSummary.mockResolvedValue({ urgent_count: 5 })

      render(<Layout />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument()
      })
    })

    it('does not show badge when there are no urgent items', async () => {
      mockGetSummary.mockResolvedValue({ urgent_count: 0 })

      render(<Layout />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.queryByText('0')).not.toBeInTheDocument()
      })
    })

    // Regression: the badge used to call /feedback/urgent and render its
    // `count`, which is one page's length and is clamped by `limit`. Because
    // Dashboard requests the same endpoint with a different limit under an
    // identical query key, the badge rendered the other component's page size.
    // Reverting to getUrgentFeedback makes this assert 3 instead of 11.
    it('reports the true total even when the urgent list page is smaller', async () => {
      mockGetSummary.mockResolvedValue({ urgent_count: 11 })
      mockGetUrgentFeedback.mockResolvedValue({ count: 3, items: [] })

      render(<Layout />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(screen.getByText('11')).toBeInTheDocument()
      })
      expect(screen.queryByText('3')).not.toBeInTheDocument()
    })

    it('does not fetch the paginated urgent list at all', async () => {
      render(<Layout />, { wrapper: createWrapper() })

      await waitFor(() => {
        expect(mockGetSummary).toHaveBeenCalledWith({ days: 7 })
      })
      expect(mockGetUrgentFeedback).not.toHaveBeenCalled()
    })
  })

  describe('header', () => {
    it('displays Voice of the Customer title', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Voice of the Customer')).toBeInTheDocument()
      })
    })

    it('renders TimeRangeSelector on a time-scoped page', async () => {
      render(<Layout />, { wrapper: createWrapper(['/dashboard']) })
      
      await waitFor(() => {
        expect(screen.getByTestId('time-range-selector')).toBeInTheDocument()
      })
    })

    it.each(['/', '/projects', '/admin', '/feedback-forms', '/chat'])('hides TimeRangeSelector on %s, which ignores the range', async (path) => {
      render(<Layout />, { wrapper: createWrapper([path]) })

      await waitFor(() => {
        expect(screen.getByText('Voice of the Customer')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('time-range-selector')).not.toBeInTheDocument()
    })

    it('keeps TimeRangeSelector on nested time-scoped routes', async () => {
      render(<Layout />, { wrapper: createWrapper(['/categories/delivery']) })

      await waitFor(() => {
        expect(screen.getByTestId('time-range-selector')).toBeInTheDocument()
      })
    })

    it('renders Breadcrumbs component', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTestId('breadcrumbs')).toBeInTheDocument()
      })
    })
  })

  describe('mobile menu', () => {
    it('displays hamburger menu button on mobile', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByLabelText('Open menu')).toBeInTheDocument()
      })
    })

    // Design audit D-NAV: the drawer was Tab-reachable while off-canvas, ignored
    // Escape, and never took or gave back focus.
    it('is out of the Tab order while closed on a phone (invisible below lg)', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      const drawer = await screen.findByRole('complementary', { name: 'Main sidebar' })
      expect(drawer.className.split(' ')).toContain('max-lg:invisible')
    })

    it('takes focus when opened, closes on Escape and gives focus back to the menu button', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      const menuButton = await screen.findByRole('button', { name: 'Open menu' })
      await userEvent.click(menuButton)

      const drawer = screen.getByRole('complementary', { name: 'Main sidebar' })
      expect(drawer.className.split(' ')).not.toContain('max-lg:invisible')
      expect(drawer).toContainElement(document.activeElement instanceof HTMLElement ? document.activeElement : null)

      await userEvent.keyboard('{Escape}')
      expect(drawer.className.split(' ')).toContain('max-lg:invisible')
      expect(menuButton).toHaveFocus()
    })

    it('closes when Tab leaves the drawer (it covers the page)', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }))
      const drawer = screen.getByRole('complementary', { name: 'Main sidebar' })
      const stops = drawer.querySelectorAll('a[href], button:not([disabled])').length
      await tabTimes(userEvent, stops + 1)
      expect(drawer.className.split(' ')).toContain('max-lg:invisible')
    })
  })

  describe('headings', () => {
    // Wave 6 (owner request): the row is top-aligned and the title's first line is
    // centred on the controls' centre line (pt-1 + leading-7 = half of 2.25rem).
    it('aligns the header row to one centre line with one gap', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      await screen.findByText('Voice of the Customer')
      expect(screen.getByTestId('header-row')).toHaveClass('items-start', 'gap-2')
      expect(screen.getByTestId('header-actions')).toHaveClass('gap-2')
      expect(screen.getByTestId('header-title')).toHaveClass('leading-7', 'pt-1')
      expect(screen.getByRole('button', { name: 'Open menu' })).toHaveClass('header-control', 'w-9')
    })

    // Wave 6: at 390 px / 200 % text the title column was ~110 px and "Voice",
    // "Customer" broke mid-word with no hyphen; in a narrow row it takes its own line.
    it('moves the title to its own line when the header row is narrow', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      await screen.findByText('Voice of the Customer')
      expect(screen.getByTestId('header-row')).toHaveClass('@container', 'flex-wrap')
      expect(screen.getByTestId('header-main')).toHaveClass('flex-1', '@max-[15em]:order-last', '@max-[15em]:basis-full')
      expect(screen.getByTestId('header-actions')).toHaveClass('ml-auto')
    })
    it('the account avatar has an opaque card fill (a tint behind the initials was 4.1:1)', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      const avatar = await screen.findByRole('button', { name: 'Account menu for test@example.com' })
      expect(avatar).toHaveClass('bg-card')
      expect(avatar).not.toHaveClass('bg-accent-subtle')
    })
    // D-STRUCT: the brand wordmark (h1) and header title (h2) came before every
    // page's own <h1>, so each page had two h1s and its outline started at h2.
    it('the shell renders no heading, leaving the page <h1> as the first', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      await screen.findByText('Voice of the Customer')
      expect(screen.queryAllByRole('heading')).toStrictEqual([])
    })
  })

  describe('sidebar collapse', () => {
    // Wave 4 clip pass: "Autonomous age…" beside its count, "Voice of the Custo…" at 1024 px.
    it('wraps nav labels and the header title instead of truncating them', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      const label = await screen.findByText('Autonomous agents')
      expect(label).toHaveClass('min-w-0', 'flex-1', 'break-words')
      expect(label).not.toHaveClass('truncate')
      expect(screen.getByTestId('header-title')).not.toHaveClass('truncate')
    })

    // Wave 5: "Custom/er" at 390 px + 200 % text — a word broke with no hyphen.
    it('breaks a header word only with a hyphen, never anywhere', () => {
      render(<Layout />, { wrapper: createWrapper() })
      const title = screen.getByTestId('header-title')
      expect(title).toHaveClass('break-words', 'hyphens-auto')
      expect(title).not.toHaveClass('[overflow-wrap:anywhere]')
    })

    it('sizes the open rail in rem so it grows with the text size', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      const drawer = await screen.findByRole('complementary', { name: 'Main sidebar' })
      expect(drawer).toHaveClass('w-[14.75rem]')
    })
    it('displays collapse button', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByTitle(/collapse sidebar|expand sidebar/i)).toBeInTheDocument()
      })
    })
  })

  describe('page content', () => {
    it('renders outlet content for dashboard route', async () => {
      render(<Layout />, { wrapper: createWrapper(['/']) })
      
      await waitFor(() => {
        expect(screen.getByText('Dashboard Content')).toBeInTheDocument()
      })
    })

    it('renders outlet content for categories route', async () => {
      render(<Layout />, { wrapper: createWrapper(['/categories']) })
      
      await waitFor(() => {
        expect(screen.getByText('Categories Content')).toBeInTheDocument()
      })
    })

    // Regression (double scrollbar on /radar): the page scroller must be a positioned containing
    // block. Otherwise absolute descendants (`.sr-only` spans) resolve against the initial
    // containing block, extend the document past the viewport and the window scrolls too.
    it('makes the page scroller the containing block of its absolute descendants', async () => {
      render(<Layout />, { wrapper: createWrapper(['/']) })
      const scroller = await screen.findByTestId('page-scroller')
      expect(scroller).toHaveClass('relative', 'overflow-auto')
      expect(scroller).toContainElement(screen.getByText('Dashboard Content'))
    })
  })
})

describe('Layout with authenticated user', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSummary.mockResolvedValue({ urgent_count: 0 })
  })

  // Owner request (wave 4): the name + "Sign out" block left the rail; the account
  // menu at the top right of the header carries both.
  it('has no user name or Sign out in the sidebar', async () => {
    render(<Layout />, { wrapper: createWrapper() })
    const sidebar = await screen.findByRole('complementary', { name: 'Main sidebar' })
    expect(sidebar).not.toHaveTextContent('test@example.com')
    expect(sidebar).not.toHaveTextContent('Sign out')
  })

  it('puts the account menu in the header, after the theme toggle', async () => {
    render(<Layout />, { wrapper: createWrapper() })
    const trigger = await screen.findByRole('button', { name: 'Account menu for test@example.com' })
    expect(screen.getByRole('banner')).toContainElement(trigger)
    const themeToggle = document.querySelector('[data-theme-pref]')
    expect(themeToggle?.compareDocumentPosition(trigger)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('shows no account menu when nobody is signed in', async () => {
    vi.mocked(useAuthStore).mockReturnValue({ isAuthenticated: false, user: null })
    onTestFinished(() => { vi.mocked(useAuthStore).mockReturnValue(authState.DEFAULT) })
    render(<Layout />, { wrapper: createWrapper() })
    await screen.findByText('Voice of the Customer')
    expect(screen.queryByRole('button', { name: /account menu/i })).not.toBeInTheDocument()
  })

  /*
   * Sign-out is an in-app navigation, so the QueryClient survives it. Without
   * an explicit clear, the next person to sign in on this browser sees the
   * previous session's cached feedback while their own loads.
   */
  it('leaves no cached data behind when signing out from the account menu', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['feedback'], { count: 1, items: [{ feedback_id: 'private' }] })
    const user = userEvent.setup()

    render(<Layout />, { wrapper: createWrapper(['/'], queryClient) })
    await user.click(await screen.findByRole('button', { name: 'Account menu for test@example.com' }))
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))

    expect(queryClient.getQueryData(['feedback'])).toBeUndefined()
    expect(mockSignOut).toHaveBeenCalledWith()
  })
})

describe('nav sections and gating (Listen → Understand → Build → Validate, Knowledge, Connect, Administration)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSummary.mockResolvedValue({ urgent_count: 0 })
    mockIsMenuItemEnabled.mockImplementation(() => true)
    vi.mocked(useIsAdmin).mockReturnValue(true)
  })

  it('renders every section header', async () => {
    await renderNavWithPhases()
    for (const header of ['Understand', 'Build', 'Validate', 'Knowledge', 'Connect']) {
      expect(screen.getByText(header)).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: /administration/i })).toHaveAttribute('href', '/admin')
  })

  it('shows Home and Dashboard as top-level links above the first section', async () => {
    await renderNavWithPhases()
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument()
    const text = screen.getByRole('navigation').textContent
    expect(text.indexOf('Home')).toBeLessThan(text.indexOf('Dashboard'))
    expect(text.indexOf('Dashboard')).toBeLessThan(text.indexOf('Listen'))
  })

  it('orders sections listen → understand → build → validate → knowledge → connect → administration', async () => {
    await renderNavWithPhases()
    const text = screen.getByRole('navigation').textContent
    const order = ['Listen', 'Understand', 'Build', 'Validate', 'Knowledge', 'Connect', 'Administration'].map((h) => text.indexOf(h))
    expect(order).toStrictEqual([...order].sort((a, b) => a - b))
    expect(order.includes(-1)).toBe(false)
  })

  it('puts Company and Memory under Knowledge, and the Connect page under Connect', async () => {
    await renderNavWithPhases()
    const text = screen.getByRole('navigation').textContent
    expect(text.indexOf('Knowledge')).toBeLessThan(text.indexOf('Company'))
    expect(text.indexOf('Memory')).toBeLessThan(text.indexOf('Connect'))
    expect(screen.getByRole('link', { name: /mcp & skills/i })).toHaveAttribute('href', '/connect')
  })

  it('hides a section header when all of its items are disabled by menu config', async () => {
    // Disable both items in the "Validate" section (feedback-forms + prioritization).
    mockIsMenuItemEnabled.mockImplementation(
      (key: string) => key !== 'feedback-forms' && key !== 'prioritization',
    )

    await renderNavWithPhases()
    expect(screen.queryByText('Validate')).not.toBeInTheDocument()
    expect(screen.getByText('Understand')).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
  })

  it('hides Administration (link and section) for non-admins', async () => {
    vi.mocked(useIsAdmin).mockReturnValue(false)

    await renderNavWithPhases()
    // Administration is the only item in its section, so both the link and the
    // section header disappear for non-admins.
    expect(screen.queryByText('Administration')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
  })

  it('names the account menu after the user and opens My profile, outside the rail sections', async () => {
    vi.mocked(useAuthStore).mockReturnValue({
      isAuthenticated: true,
      user: { username: 'alex', email: 'alex@example.com', name: 'Alex Rivera', groups: [] },
    })
    onTestFinished(() => { vi.mocked(useAuthStore).mockReturnValue(authState.DEFAULT) })
    const user = userEvent.setup()
    await renderNavWithPhases()
    const trigger = screen.getByRole('button', { name: 'Account menu for Alex Rivera' })
    expect(trigger).toHaveTextContent(/^AR$/)
    expect(screen.getByRole('navigation')).not.toContainElement(trigger)
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'My profile' }))
    expect(screen.getByText('Other Content')).toBeInTheDocument()
  })

  it('keeps the account menu in the header when the rail is collapsed', async () => {
    const user = userEvent.setup()
    render(<Layout />, { wrapper: createWrapper() })
    await user.click(await screen.findByRole('button', { name: 'Collapse sidebar' }))
    expect(screen.getByRole('banner')).toContainElement(screen.getByRole('button', { name: 'Account menu for test@example.com' }))
  })

  it('mounts the floating assistant once, inside the layout', async () => {
    render(<Layout />, { wrapper: createWrapper() })
    await waitFor(() => {
      expect(screen.getAllByTestId('assistant-root')).toHaveLength(1)
    })
  })

  it('mounts the review modal host after the assistant, so the modal paints over the full-screen assistant', async () => {
    render(<Layout />, { wrapper: createWrapper() })
    const host = await screen.findByTestId('review-modal-host')
    const following = screen.getByTestId('assistant-root').compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING
    expect(following).not.toBe(0)
  })
})

describe('Layout loads the brand on every page (E2E F12)', () => {
  it('asks for the brand settings on a non-admin page', async () => {
    mockGetSummary.mockResolvedValue({ urgent_count: 0 })
    render(<Layout />, { wrapper: createWrapper(['/dashboard']) })

    await waitFor(() => expect(mockGetBrandSettings).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Test Brand')).toBeInTheDocument()
  })
})
