import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import McpAccessTab from './McpAccessTab'

// Mock the API client
const mockListApiTokens = vi.fn()
const mockCreateApiToken = vi.fn()
const mockDeleteApiToken = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    listApiTokens: (...args: unknown[]) => mockListApiTokens(...args),
    createApiToken: (...args: unknown[]) => mockCreateApiToken(...args),
    deleteApiToken: (...args: unknown[]) => mockDeleteApiToken(...args),
  },
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com/v1' },
  }),
}))

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function renderTab(projectId = 'proj-123') {
  const qc = createQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <McpAccessTab projectId={projectId} personas={[]} documents={[]} />
    </QueryClientProvider>
  )
}

const mockToken = {
  token_id: 'tok-1',
  name: 'My Kiro token',
  scope: 'read' as const,
  created_at: '2026-03-20T10:00:00Z',
  last_used_at: '2026-03-21T15:00:00Z',
  project_id: 'proj-123',
}

describe('McpAccessTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListApiTokens.mockResolvedValue({ success: true, tokens: [] })
  })

  it('renders the header and generate button', async () => {
    renderTab()
    expect(screen.getByText('MCP Access')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate Token/i })).toBeInTheDocument()
  })

  it('shows empty state when no tokens exist', async () => {
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('No API tokens yet')).toBeInTheDocument()
    })
  })

  it('renders token list when tokens exist', async () => {
    const user = userEvent.setup()
    mockListApiTokens.mockResolvedValue({ success: true, tokens: [mockToken] })
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('Active Tokens (1)')).toBeInTheDocument()
    })
    // Expand the collapsible list
    await user.click(screen.getByText('Active Tokens (1)'))
    expect(screen.getByText('My Kiro token')).toBeInTheDocument()
    expect(screen.getByText('read')).toBeInTheDocument()
  })

  it('shows create form when Generate Token is clicked', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    expect(screen.getByLabelText('Token name')).toBeInTheDocument()
    expect(screen.getByLabelText('Scope')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument()
  })

  it('disables Generate button when name is empty', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
  })

  it('enables Generate button when name is provided', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Test token')
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
  })

  it('calls createApiToken on submit and shows the new token', async () => {
    const user = userEvent.setup()
    mockCreateApiToken.mockResolvedValue({
      success: true,
      token: 'voc_abc123secret',
      token_id: 'tok-new',
      name: 'Test token',
    })
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Test token')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(screen.getByText('Token created successfully')).toBeInTheDocument()
    })
    expect(mockCreateApiToken).toHaveBeenCalledWith('proj-123', { name: 'Test token', scope: 'read' })
  })

  it('hides create form on cancel', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    expect(screen.getByLabelText('Token name')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Token name')).not.toBeInTheDocument()
  })

  it('calls deleteApiToken when revoke is clicked', async () => {
    const user = userEvent.setup()
    mockListApiTokens.mockResolvedValue({ success: true, tokens: [mockToken] })
    mockDeleteApiToken.mockResolvedValue({ success: true, message: 'Deleted' })
    renderTab()

    await waitFor(() => {
      expect(screen.getByText('Active Tokens (1)')).toBeInTheDocument()
    })
    // Expand the collapsible list
    await user.click(screen.getByText('Active Tokens (1)'))
    await user.click(screen.getByTitle('Revoke token'))
    expect(mockDeleteApiToken).toHaveBeenCalledWith('proj-123', 'tok-1')
  })

  it('renders MCP config snippet with project ID', async () => {
    renderTab()
    expect(screen.getByText('MCP Client Configuration')).toBeInTheDocument()
    // The config should contain the project ID
    const pre = screen.getByText(/X-Project-Id/)
    expect(pre).toBeInTheDocument()
  })

  it('copies MCP config to clipboard', async () => {
    const user = userEvent.setup()
    renderTab()
    // The Copy button inside the MCP config section
    const copyButton = screen.getByRole('button', { name: /^Copy$/ })
    await user.click(copyButton)
    // After clicking, the button text changes to "Copied"
    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument()
    })
  })

  it('shows token with toggle visibility', async () => {
    const user = userEvent.setup()
    mockCreateApiToken.mockResolvedValue({
      success: true,
      token: 'voc_secret_token_value',
      token_id: 'tok-new',
      name: 'Test',
    })
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Test')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(screen.getByText('Token created successfully')).toBeInTheDocument()
    })

    // Token should be hidden by default (dots)
    expect(screen.queryByText('voc_secret_token_value')).not.toBeInTheDocument()

    // Click show
    await user.click(screen.getByTitle('Reveal token'))
    expect(screen.getByText('voc_secret_token_value')).toBeInTheDocument()

    // Click hide
    await user.click(screen.getByTitle('Hide token'))
    expect(screen.queryByText('voc_secret_token_value')).not.toBeInTheDocument()
  })

  it('dismisses the new token banner', async () => {
    const user = userEvent.setup()
    mockCreateApiToken.mockResolvedValue({
      success: true,
      token: 'voc_abc',
      token_id: 'tok-new',
      name: 'Test',
    })
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Test')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(screen.getByText('Token created successfully')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Dismiss'))
    expect(screen.queryByText('Token created successfully')).not.toBeInTheDocument()
  })

  it('allows selecting read-write scope', async () => {
    const user = userEvent.setup()
    mockCreateApiToken.mockResolvedValue({
      success: true,
      token: 'voc_rw',
      token_id: 'tok-rw',
      name: 'RW token',
    })
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'RW token')
    await user.selectOptions(screen.getByLabelText('Scope'), 'read-write')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(mockCreateApiToken).toHaveBeenCalledWith('proj-123', { name: 'RW token', scope: 'read-write' })
    })
  })

  it('shows last used date when available', async () => {
    const user = userEvent.setup()
    mockListApiTokens.mockResolvedValue({ success: true, tokens: [mockToken] })
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('Active Tokens (1)')).toBeInTheDocument()
    })
    // Expand the collapsible list
    await user.click(screen.getByText('Active Tokens (1)'))
    expect(screen.getByText(/Last used/)).toBeInTheDocument()
  })

  it('shows loading state', () => {
    mockListApiTokens.mockReturnValue(new Promise(() => {})) // never resolves
    renderTab()
    expect(screen.getByText('Loading tokens\u2026')).toBeInTheDocument()
  })
})
