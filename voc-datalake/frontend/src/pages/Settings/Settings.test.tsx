/**
 * @fileoverview Tests for Settings page component.
 * @module pages/Settings
 * 
 * The Settings page uses a tabbed interface:
 * - General tab: API config, brand settings, language & locale, danger zone
 * - Data Sources tab: Plugin configurations
 * - Categories tab: Category management
 * - Logs tab: Validation/processing logs
 * - Users tab: User administration (admin only)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock API
const mockGetBrandSettings = vi.fn()
const mockSaveBrandSettings = vi.fn()
const mockGetLogsSummary = vi.fn()
const mockGetReviewSettings = vi.fn()
const mockSaveReviewSettings = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getBrandSettings: () => mockGetBrandSettings(),
    saveBrandSettings: (settings: unknown) => mockSaveBrandSettings(settings),
    getReviewSettings: () => mockGetReviewSettings(),
    saveReviewSettings: (settings: unknown) => mockSaveReviewSettings(settings),
    getLogsSummary: () => mockGetLogsSummary(),
    getValidationLogs: () => Promise.resolve({ logs: [], count: 0, days: 7 }),
    getProcessingLogs: () => Promise.resolve({ logs: [], count: 0, days: 7 }),
    getScrapers: () => Promise.resolve({ scrapers: [] }),
  },
}))

// Mock config store
const mockSetConfig = vi.fn()
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
vi.mock('../../components/CategoriesManager', () => ({
  default: () => <div data-testid="categories-manager">Categories Manager</div>,
}))

vi.mock('../../components/UserAdmin', () => ({
  default: () => <div data-testid="user-admin">User Admin</div>,
}))

vi.mock('../../components/ConfirmModal', () => ({
  default: ({ isOpen, onConfirm, onCancel, title }: { isOpen: boolean; onConfirm: () => void; onCancel: () => void; title: string }) =>
    isOpen ? (
      <div data-testid="confirm-modal">
        <span>{title}</span>
        <button onClick={onConfirm}>Confirm Reset</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}))

vi.mock('./SourceCard', () => ({
  default: ({ manifest }: { manifest: { id: string } }) => (
    <div data-testid={`source-card-${manifest.id}`}>Source: {manifest.id}</div>
  ),
}))

vi.mock('./LogsSection', () => ({
  default: () => <div data-testid="logs-section">Logs Section</div>,
}))

// Mock i18n config (the real one initializes i18n with HTTP backend)
const mockChangeLanguage = vi.fn()
vi.mock('../../i18n/config', () => ({
  supportedLanguages: ['en', 'es', 'fr'] as const,
  languageNames: { en: 'English', es: 'Español', fr: 'Français' } as Record<string, string>,
  changeLanguage: (...args: unknown[]) => mockChangeLanguage(...args),
}))

import Settings from './Settings'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={['/settings']}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBrandSettings.mockResolvedValue({
      brand_name: 'Test Brand',
      brand_handles: ['@testbrand'],
      hashtags: ['#testbrand'],
      urls_to_track: ['https://example.com'],
    })
    mockSaveBrandSettings.mockResolvedValue({ success: true })
    mockGetReviewSettings.mockResolvedValue({ primary_language: 'en' })
    mockSaveReviewSettings.mockResolvedValue({ success: true })
    mockGetLogsSummary.mockResolvedValue({
      summary: { validation_failures: {}, processing_errors: {}, total_validation_failures: 0, total_processing_errors: 0 },
      days: 7,
    })
  })

  describe('header', () => {
    it('displays page title', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Settings')).toBeInTheDocument()
    })

    it('displays page description', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Configure your VoC platform/i)).toBeInTheDocument()
    })

    it('displays Save Changes button', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument()
    })
  })

  describe('tab navigation', () => {
    it('displays general, data sources, and categories tabs', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getAllByRole('button', { name: /General/i }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: /Data Sources/i }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: /Categories/i }).length).toBeGreaterThan(0)
    })

    it('displays logs and users tabs for admin users', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getAllByRole('button', { name: /Logs/i }).length).toBeGreaterThan(0)
      expect(screen.getAllByRole('button', { name: /Users/i }).length).toBeGreaterThan(0)
    })

    it('starts on General tab by default', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Brand Configuration')).toBeInTheDocument()
    })

    it('switches to Categories tab when clicked', async () => {
      const user = userEvent.setup()
      render(<Settings />, { wrapper: createWrapper() })
      
      // Click the Categories tab (there are multiple buttons with this text due to mobile/desktop)
      const categoriesButtons = screen.getAllByRole('button', { name: /Categories/i })
      await user.click(categoriesButtons[0])
      
      expect(screen.getByTestId('categories-manager')).toBeInTheDocument()
    })

    it('switches to Data Sources tab when clicked', async () => {
      const user = userEvent.setup()
      render(<Settings />, { wrapper: createWrapper() })
      
      const dataSourcesButtons = screen.getAllByRole('button', { name: /Data Sources/i })
      await user.click(dataSourcesButtons[0])
      
      expect(screen.getByText(/Data Sources & Integrations/i)).toBeInTheDocument()
    })

    it('switches to Logs tab when clicked', async () => {
      const user = userEvent.setup()
      render(<Settings />, { wrapper: createWrapper() })
      
      const logsButtons = screen.getAllByRole('button', { name: /Logs/i })
      await user.click(logsButtons[0])
      
      expect(screen.getByTestId('logs-section')).toBeInTheDocument()
    })

    it('switches to Users tab when clicked', async () => {
      const user = userEvent.setup()
      render(<Settings />, { wrapper: createWrapper() })
      
      const usersButtons = screen.getAllByRole('button', { name: /Users/i })
      await user.click(usersButtons[0])
      
      expect(screen.getByTestId('user-admin')).toBeInTheDocument()
    })
  })

  describe('brand tab - API configuration section', () => {
    it('displays API Configuration heading', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('API Configuration')).toBeInTheDocument()
    })

    it('shows Connected indicator when API is configured', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Connected/i)).toBeInTheDocument()
    })

    it('expands API config when clicked', async () => {
      const user = userEvent.setup()
      render(<Settings />, { wrapper: createWrapper() })
      
      // Click to expand API config
      await user.click(screen.getByText('API Configuration'))
      
      expect(screen.getByPlaceholderText(/your-api-id.execute-api/i)).toBeInTheDocument()
    })
  })

  describe('brand tab - brand configuration section', () => {
    it('displays Brand Configuration heading', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Brand Configuration')).toBeInTheDocument()
    })

    it('displays brand name input', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByPlaceholderText(/Your Brand Name/i)).toBeInTheDocument()
    })

    it('shows synced indicator when API endpoint is configured', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getAllByText(/Synced to backend/i).length).toBeGreaterThan(0)
    })
  })

  describe('brand tab - danger zone section', () => {
    it('displays Danger Zone heading', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Danger Zone')).toBeInTheDocument()
    })

    it('displays Reset Settings button', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByRole('button', { name: /Reset Settings/i })).toBeInTheDocument()
    })
  })

  describe('save functionality', () => {
    it('saves settings when Save Changes is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /Save Changes/i }))
      
      await waitFor(() => {
        // eslint-disable-next-line vitest/prefer-called-with
        expect(mockSetConfig).toHaveBeenCalled()
        // eslint-disable-next-line vitest/prefer-called-with
        expect(mockSaveBrandSettings).toHaveBeenCalled()
      })
    })

    it('shows Saved! message after successful save', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /Save Changes/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/Saved!/i)).toBeInTheDocument()
      })
    })

    it('shows Saving... while save is in progress', async () => {
      const user = userEvent.setup()
      mockSaveBrandSettings.mockReturnValue(new Promise(() => {}))
      mockSaveReviewSettings.mockReturnValue(new Promise(() => {}))
      
      render(<Settings />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /Save Changes/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/Saving.../i)).toBeInTheDocument()
      })
    })
  })

  describe('reset functionality', () => {
    it('opens confirm modal when Reset Settings is clicked', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /Reset Settings/i }))
      
      expect(screen.getByTestId('confirm-modal')).toBeInTheDocument()
    })

    it('resets settings when confirmed', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /Reset Settings/i }))
      await user.click(screen.getByRole('button', { name: /Confirm Reset/i }))
      
      expect(mockSetConfig).toHaveBeenCalledWith(expect.objectContaining({
        apiEndpoint: '',
        brandName: '',
      }))
    })

    it('closes modal when cancelled', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
      await user.click(screen.getByRole('button', { name: /Reset Settings/i }))
      await user.click(screen.getByRole('button', { name: /Cancel/i }))
      
      expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument()
    })
  })

  describe('form inputs', () => {
    it('updates brand name when typed', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/Your Brand Name/i)
      await user.type(input, ' Updated')
      
      expect(input).toHaveValue('Test Brand Updated')
    })

    it('updates API endpoint when expanded and typed', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
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
      render(<Settings />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        // eslint-disable-next-line vitest/prefer-called-with
        expect(mockGetBrandSettings).toHaveBeenCalled()
      })
    })

    it('shows loading indicator while fetching settings', () => {
      mockGetBrandSettings.mockReturnValue(new Promise(() => {}))
      
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Loading settings/i)).toBeInTheDocument()
    })
  })
})

describe('Settings without admin access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBrandSettings.mockResolvedValue({
      brand_name: 'Test Brand',
      brand_handles: [],
      hashtags: [],
      urls_to_track: [],
    })
    mockGetReviewSettings.mockResolvedValue({ primary_language: 'en' })
    
    vi.doMock('../../store/authStore', () => ({
      useIsAdmin: vi.fn(() => false),
    }))
  })

  it('hides Users tab for non-admin users', async () => {
    vi.resetModules()
    vi.doMock('../../store/authStore', () => ({
      useIsAdmin: () => false,
    }))
    
    const { default: SettingsNonAdmin } = await import('./Settings')
    
    render(<SettingsNonAdmin />, { wrapper: createWrapper() })
    
    // Users tab should not be visible
    expect(screen.queryByRole('button', { name: /^Users$/i })).not.toBeInTheDocument()
  })
})
