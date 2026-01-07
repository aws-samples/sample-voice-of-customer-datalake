/**
 * @fileoverview Tests for Settings page component.
 * @module pages/Settings
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'

// Mock API
const mockGetBrandSettings = vi.fn()
const mockSaveBrandSettings = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getBrandSettings: () => mockGetBrandSettings(),
    saveBrandSettings: (settings: unknown) => mockSaveBrandSettings(settings),
  },
}))

// Mock config store
const mockSetConfig = vi.fn()
vi.mock('../../store/configStore', () => ({
  useConfigStore: vi.fn(() => ({
    config: {
      apiEndpoint: 'https://api.example.com',
      artifactBuilderEndpoint: 'https://artifact.example.com',
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
  default: ({ sourceKey }: { sourceKey: string }) => (
    <div data-testid={`source-card-${sourceKey}`}>Source: {sourceKey}</div>
  ),
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

  describe('API configuration section', () => {
    it('displays API Configuration heading', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('API Configuration')).toBeInTheDocument()
    })

    it('displays API endpoint input', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/API Endpoint URL/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/your-api-id.execute-api/i)).toBeInTheDocument()
    })

    it('displays Artifact Builder endpoint input', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Artifact Builder Endpoint/i)).toBeInTheDocument()
    })

    it('populates API endpoint from config', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/your-api-id.execute-api/i)
      expect(input).toHaveValue('https://api.example.com')
    })
  })

  describe('brand configuration section', () => {
    it('displays Brand Configuration heading', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Brand Configuration')).toBeInTheDocument()
    })

    it('displays brand name input', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Brand Name/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/Your Brand Name/i)).toBeInTheDocument()
    })

    it('displays brand handles input', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Brand Handles/i)).toBeInTheDocument()
    })

    it('displays hashtags input', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Hashtags to Track/i)).toBeInTheDocument()
    })

    it('displays URLs to track textarea', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/URLs to Track/i)).toBeInTheDocument()
    })

    it('shows synced indicator when API endpoint is configured', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Synced to backend/i)).toBeInTheDocument()
    })
  })

  describe('categories section', () => {
    it('displays Feedback Categories heading', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('Feedback Categories')).toBeInTheDocument()
    })

    it('renders CategoriesManager component', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByTestId('categories-manager')).toBeInTheDocument()
    })
  })

  describe('data sources section', () => {
    it('displays Data Sources heading', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText(/Data Sources & Integrations/i)).toBeInTheDocument()
    })
  })

  describe('user admin section', () => {
    it('displays User Administration heading for admin users', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByText('User Administration')).toBeInTheDocument()
    })

    it('renders UserAdmin component for admin users', () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      expect(screen.getByTestId('user-admin')).toBeInTheDocument()
    })
  })

  describe('danger zone section', () => {
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
        expect(mockSetConfig).toHaveBeenCalled()
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
    it('updates API endpoint when typed', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/your-api-id.execute-api/i)
      await user.clear(input)
      await user.type(input, 'https://new-api.example.com')
      
      expect(input).toHaveValue('https://new-api.example.com')
    })

    it('updates brand name when typed', async () => {
      const user = userEvent.setup()
      
      render(<Settings />, { wrapper: createWrapper() })
      
      const input = screen.getByPlaceholderText(/Your Brand Name/i)
      // Type additional text (don't clear since clear doesn't work well with controlled inputs)
      await user.type(input, ' Updated')
      
      expect(input).toHaveValue('Test Brand Updated')
    })
  })

  describe('backend settings sync', () => {
    it('fetches brand settings from backend on mount', async () => {
      render(<Settings />, { wrapper: createWrapper() })
      
      await waitFor(() => {
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
    
    vi.doMock('../../store/authStore', () => ({
      useIsAdmin: vi.fn(() => false),
    }))
  })

  it('hides User Administration section for non-admin users', async () => {
    vi.resetModules()
    vi.doMock('../../store/authStore', () => ({
      useIsAdmin: () => false,
    }))
    
    const { default: SettingsNonAdmin } = await import('./Settings')
    
    render(<SettingsNonAdmin />, { wrapper: createWrapper() })
    
    expect(screen.queryByText('User Administration')).not.toBeInTheDocument()
  })
})
