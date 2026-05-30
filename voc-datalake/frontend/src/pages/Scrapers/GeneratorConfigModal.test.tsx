import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import {
  render, screen, waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  QueryClient, QueryClientProvider,
} from '@tanstack/react-query'
import GeneratorConfigModal from './GeneratorConfigModal'
import type { PluginManifest } from '../../plugins/types'

const mockGetIntegrationCredentials = vi.fn()
const mockUpdateIntegrationCredentials = vi.fn()
const mockRunSource = vi.fn()
const mockGetSourceRunStatus = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getIntegrationCredentials: (s: string, keys: string[]) => mockGetIntegrationCredentials(s, keys),
    updateIntegrationCredentials: (s: string, creds: Record<string, string>) => mockUpdateIntegrationCredentials(s, creds),
    runSource: (s: string) => mockRunSource(s),
    getSourceRunStatus: (s: string) => mockGetSourceRunStatus(s),
  },
}))

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const plugin: PluginManifest = {
  id: 'synthetic_reviews',
  name: 'Synthetic Data Review Generator',
  icon: '🧪',
  description: 'Generate realistic synthetic customer reviews with AI.',
  category: 'synthetic',
  config: [
    {
      key: 'company_name', label: 'Company / Brand Name', type: 'text', required: true, placeholder: 'Acme Corp', secret: false,
    },
    {
      key: 'product_name', label: 'Product / Service Name', type: 'text', required: true, placeholder: 'Acme App', secret: false,
    },
    {
      key: 'num_reviews', label: 'Number of Reviews', type: 'text', required: false, placeholder: '10', secret: false,
    },
  ],
  setup: {
    title: 'Synthetic Setup', color: 'blue', steps: ['Step 1'],
  },
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
  version: '1.0.0',
  enabled: true,
}

describe('GeneratorConfigModal', () => {
  const onClose = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetIntegrationCredentials.mockResolvedValue({})
    mockUpdateIntegrationCredentials.mockResolvedValue({ success: true })
    mockRunSource.mockResolvedValue({
      success: true, message: 'Triggered', source: 'synthetic_reviews', execution_id: 'e1',
    })
    mockGetSourceRunStatus.mockResolvedValue({ source: 'synthetic_reviews', status: 'running', items_found: 0 })
  })

  it('renders the plugin name and config fields from the manifest', () => {
    render(<GeneratorConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    expect(screen.getByText('Synthetic Data Review Generator')).toBeInTheDocument()
    expect(screen.getByText('Company / Brand Name')).toBeInTheDocument()
    expect(screen.getByText('Product / Service Name')).toBeInTheDocument()
  })

  it('disables Generate until required fields are filled', () => {
    render(<GeneratorConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    expect(screen.getByRole('button', { name: /generat/i })).toBeDisabled()
  })

  it('saves config and triggers a run when Generate is clicked', async () => {
    const user = userEvent.setup()
    render(<GeneratorConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })

    await user.type(screen.getByPlaceholderText('Acme Corp'), 'Acme Corp')
    await user.type(screen.getByPlaceholderText('Acme App'), 'Acme App')

    const generateButton = screen.getByRole('button', { name: /generat/i })
    expect(generateButton).not.toBeDisabled()
    await user.click(generateButton)

    await waitFor(() => {
      expect(mockUpdateIntegrationCredentials).toHaveBeenCalledWith(
        'synthetic_reviews',
        expect.objectContaining({ company_name: 'Acme Corp', product_name: 'Acme App' }),
      )
    })
    expect(mockRunSource).toHaveBeenCalledWith('synthetic_reviews')
  })

  it('calls onClose when the Close button is clicked', async () => {
    const user = userEvent.setup()
    render(<GeneratorConfigModal plugin={plugin} onClose={onClose} />, { wrapper: createWrapper() })
    await user.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
