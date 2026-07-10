/**
 * @fileoverview Tests for Layout component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock API before importing component
const mockGetUrgentFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getUrgentFeedback: (params: unknown) => mockGetUrgentFeedback(params),
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

function createWrapper(initialEntries = ['/']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={initialEntries}>
        <Routes>
          <Route element={children}>
            <Route path="/" element={<div>Dashboard Content</div>} />
            <Route path="/feedback" element={<div>Feedback Content</div>} />
            <Route path="/chat" element={<div>Chat Content</div>} />
            <Route path="/settings" element={<div>Settings Content</div>} />
          </Route>
        </Routes>
      </TestRouter>
    </QueryClientProvider>
  )
}

describe('Layout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUrgentFeedback.mockResolvedValue({ count: 0, items: [] })
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

    it('displays Feedback nav link', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // The link contains a span with "Feedback" text
        expect(screen.getByText('Feedback')).toBeInTheDocument()
      })
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
    it('shows urgent count badge when urgent items exist', async () => {
      mockGetUrgentFeedback.mockResolvedValue({ count: 5, items: [] })
      
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('5')).toBeInTheDocument()
      })
    })

    it('does not show badge when no urgent items', async () => {
      mockGetUrgentFeedback.mockResolvedValue({ count: 0, items: [] })
      
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.queryByText('0')).not.toBeInTheDocument()
      })
    })
  })

  describe('header', () => {
    it('displays Voice of the Customer title', async () => {
      render(<Layout />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('Voice of the Customer')).toBeInTheDocument()
      })
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

    it('renders outlet content for feedback route', async () => {
      render(<Layout />, { wrapper: createWrapper(['/feedback']) })
      
      await waitFor(() => {
        expect(screen.getByText('Feedback Content')).toBeInTheDocument()
      })
    })
  })
})

describe('Layout with authenticated user', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUrgentFeedback.mockResolvedValue({ count: 0, items: [] })
  })

  it('displays sign out button when authenticated', async () => {
    render(<Layout />, { wrapper: createWrapper() })
    
    await waitFor(() => {
      expect(screen.getByTitle('Sign out')).toBeInTheDocument()
    })
  })
})

describe('workflow sections and gating (P11 — AI-PDLC phases)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUrgentFeedback.mockResolvedValue({ count: 0, items: [] })
    mockIsMenuItemEnabled.mockImplementation(() => true)
    vi.mocked(useIsAdmin).mockReturnValue(true)
  })

  it('renders the AI-PDLC phase section headers', async () => {
    render(<Layout />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('Sources')).toBeInTheDocument()
    })
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Signals')).toBeInTheDocument()
    expect(screen.getByText('Ideation')).toBeInTheDocument()
    expect(screen.getByText('Validation')).toBeInTheDocument()
  })

  it('orders sections home → sources → signals → ideation → validation', async () => {
    render(<Layout />, { wrapper: createWrapper() })

    await waitFor(() => {
      expect(screen.getByText('Sources')).toBeInTheDocument()
    })
    const nav = screen.getByRole('navigation')
    const text = nav.textContent ?? ''
    expect(text.indexOf('Home')).toBeLessThan(text.indexOf('Sources'))
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
