/**
 * @fileoverview Tests for Layout component.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next, { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'
import commonDe from '../../../public/locales/de/common.json'
import commonEn from '../../../public/locales/en/common.json'

// Mock API before importing component
const mockGetUrgentFeedback = vi.fn()
const mockGetSummary = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getUrgentFeedback: (params: unknown) => mockGetUrgentFeedback(params),
    getSummary: (params: unknown) => mockGetSummary(params),
  },
  getDaysFromRange: vi.fn(() => 7),
  getDateRangeParams: () => ({ days: 7 }),
}))

// Mock stores
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    timeRange: '7d',
    config: { apiEndpoint: 'https://api.example.com', brandName: 'Test Brand' },
  })),
}))

const mockSignOut = vi.fn()
vi.mock('../../services/auth', () => ({
  authService: {
    signOut: () => mockSignOut(),
  },
}))

// Mock authStore with useIsAdmin
vi.mock('../../store/authStore', () => ({
  useAuthStore: vi.fn(() => ({
    isAuthenticated: true,
    user: { username: 'testuser', email: 'test@example.com' },
  })),
  useIsAdmin: vi.fn(() => true),
}))

// Mock menu config so P11 gating tests can toggle individual items.
// Defaults to all-enabled so existing tests see every nav link.
const mockIsMenuItemEnabled = vi.fn((_key: string) => true)
vi.mock('../../config/menuConfig', () => ({
  isMenuItemEnabled: (key: string) => mockIsMenuItemEnabled(key),
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

// Mock child components to simplify testing
vi.mock('../TimeRangeSelector', () => ({
  default: () => <div data-testid="time-range-selector">TimeRangeSelector</div>,
}))

vi.mock('../Breadcrumbs', () => ({
  default: () => <div data-testid="breadcrumbs">Breadcrumbs</div>,
}))

vi.mock('../UserProfileModal', () => ({
  default: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? <div data-testid="profile-modal"><button onClick={onClose}>Close</button></div> : null,
}))

import Layout from './Layout'
import { useIsAdmin } from '../../store/authStore'

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
            <Route path="/settings" element={<div>Settings Content</div>} />
          </Route>
        </Routes>
      </TestRouter>
    </QueryClientProvider>
  )
}

/**
 * A German instance for the one case that has to RENDER in German.
 *
 * NOT `.use(initReactI18next)`: that plugin re-points the shared `i18next`
 * singleton `src/test/setup.ts` initialized in English for the whole suite, so
 * every other case in this file — and every other file in the same worker — would
 * render in German. `I18nextProvider` passes this instance explicitly, which makes
 * the plugin unnecessary as well as harmful. Same construction as
 * `TimeRangeSelector.localization.test.tsx`.
 */
const german = createInstance()

beforeAll(async () => {
  await german.init({
    lng: 'de',
    fallbackLng: false,
    defaultNS: 'common',
    ns: ['common'],
    resources: { de: { common: commonDe } },
    interpolation: { escapeValue: false },
  })
})

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

    it('does not display a Feedback nav link (consolidated into Categories, issue #198)', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /categories/i })).toBeInTheDocument()
      })
      expect(screen.queryByRole('link', { name: /^feedback$/i })).not.toBeInTheDocument()
    })

    it('displays AI Chat nav link', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /ai chat/i })).toBeInTheDocument()
      })
    })

    it('displays Settings nav link', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument()
      })
    })

    it('displays Categories nav link', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByRole('link', { name: /categories/i })).toBeInTheDocument()
      })
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
        expect(mockGetSummary).toHaveBeenCalled()
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

    it('renders the title and subtitle from the catalogue, not from JSX literals', async () => {
      // RENDERED in German, not merely compared against the German catalogue.
      // Both strings were hardcoded English and stayed English on every page after
      // switching the deployed app to German — and an English assertion passes
      // against exactly that literal, so it cannot be the proof. The catalogue is
      // the shipped `de` file, so a key added to `en` alone fails here too.
      render(
        <I18nextProvider i18n={german}><Layout /></I18nextProvider>,
        { wrapper: createWrapper() },
      )

      await waitFor(() => {
        expect(screen.getByTestId('app-header-title'))
          .toHaveTextContent(commonDe.header.title)
      })
      expect(screen.getByTestId('app-header-subtitle'))
        .toHaveTextContent(commonDe.header.subtitle)
      // The negative half: the English literal is gone, which is the defect.
      expect(screen.getByTestId('app-header-title'))
        .not.toHaveTextContent(commonEn.header.title)
      expect(screen.getByTestId('app-header-subtitle'))
        .not.toHaveTextContent(commonEn.header.subtitle)
    })

    it('keeps the default English instance untouched by the German fixture', () => {
      // Guards the guard: `createInstance` must not have re-pointed the shared
      // `i18next` singleton that every other case in this file renders through —
      // the English title case above would then be asserting German.
      expect(i18next.language).not.toBe('de')
    })

    it('renders TimeRangeSelector component', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
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
  })

  describe('sidebar collapse', () => {
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
  })
})

describe('Layout with authenticated user', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSummary.mockResolvedValue({ urgent_count: 0 })
  })

  it('displays sign out button when authenticated', async () => {
    render(<Layout />, { wrapper: createWrapper() })
    
    await waitFor(() => {
      expect(screen.getByTitle('Sign out')).toBeInTheDocument()
    })
  })

  /*
   * Sign-out is an in-app navigation, so the QueryClient survives it. Without
   * an explicit clear, the next person to sign in on this browser sees the
   * previous session's cached feedback while their own loads.
   */
  it('leaves no cached data behind when signing out', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(['feedback'], { count: 1, items: [{ feedback_id: 'private' }] })
    const user = userEvent.setup()

    render(<Layout />, { wrapper: createWrapper(['/'], queryClient) })
    await user.click(await screen.findByTitle('Sign out'))

    expect(queryClient.getQueryData(['feedback'])).toBeUndefined()
    expect(mockSignOut).toHaveBeenCalledWith()
  })
})

describe('workflow sections and gating (P11 — AI-PDLC phases)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSummary.mockResolvedValue({ urgent_count: 0 })
    mockIsMenuItemEnabled.mockImplementation(() => true)
    vi.mocked(useIsAdmin).mockReturnValue(true)
  })

  it('renders the AI-PDLC phase section headers', async () => {
    render(<Layout />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('Sources')).toBeInTheDocument()
    })
    expect(screen.getByText('Signals')).toBeInTheDocument()
    expect(screen.getByText('Ideation')).toBeInTheDocument()
    expect(screen.getByText('Validation')).toBeInTheDocument()
  })

  it('shows Home and Dashboard as top-level links above the first phase section', async () => {
    render(<Layout />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('Sources')).toBeInTheDocument()
    })
    // Home and Dashboard are entry-point links, not phase section headers.
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
    const nav = screen.getByRole('navigation')
    const text = nav.textContent ?? ''
    // Home sits above Dashboard, and both sit above the first phase header.
    expect(text.indexOf('Home')).toBeLessThan(text.indexOf('Dashboard'))
    expect(text.indexOf('Dashboard')).toBeLessThan(text.indexOf('Sources'))
  })

  it('orders phases sources → signals → ideation → validation', async () => {
    render(<Layout />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('Sources')).toBeInTheDocument()
    })
    const nav = screen.getByRole('navigation')
    const text = nav.textContent ?? ''
    expect(text.indexOf('Sources')).toBeLessThan(text.indexOf('Signals'))
    expect(text.indexOf('Signals')).toBeLessThan(text.indexOf('Ideation'))
    expect(text.indexOf('Ideation')).toBeLessThan(text.indexOf('Validation'))
  })

  it('hides a section header when all of its items are disabled by menu config', async () => {
    // Disable both items in the "Validation" section (feedback-forms + prioritization).
    mockIsMenuItemEnabled.mockImplementation(
      (key: string) => key !== 'feedback-forms' && key !== 'prioritization',
    )

    render(<Layout />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('Sources')).toBeInTheDocument()
    })
    // The "Validation" header auto-hides because it has no visible items.
    expect(screen.queryByText('Validation')).not.toBeInTheDocument()
    // Sibling sections are unaffected.
    expect(screen.getByText('Signals')).toBeInTheDocument()
    expect(screen.getByText('Ideation')).toBeInTheDocument()
  })

  it('hides Settings (link and section) for non-admins', async () => {
    vi.mocked(useIsAdmin).mockReturnValue(false)

    render(<Layout />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('Sources')).toBeInTheDocument()
    })
    // Settings is the only item in its section, so both the link and the
    // section header disappear for non-admins.
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    // Non-admin still sees the rest of the nav.
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument()
  })
})
