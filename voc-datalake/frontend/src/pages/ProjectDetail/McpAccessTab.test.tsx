import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import McpAccessTab from './McpAccessTab'
import type { Project } from '../../api/types'

// Mock the API client
const mockListApiTokens = vi.fn()
const mockCreateApiToken = vi.fn()
const mockDeleteApiToken = vi.fn()
const mockAutoseedProject = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    listApiTokens: (...args: unknown[]) => mockListApiTokens(...args),
    createApiToken: (...args: unknown[]) => mockCreateApiToken(...args),
    deleteApiToken: (...args: unknown[]) => mockDeleteApiToken(...args),
    autoseedProject: (...args: unknown[]) => mockAutoseedProject(...args),
  },
}))

vi.mock('../../api/baseUrl', () => ({
  stripTrailingSlashes: (url: string) => url.replace(/\/$/, ''),
}))

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com/v1' },
  }),
}))

const mockProject: Project = {
  project_id: 'proj-123',
  name: 'Test Project',
  description: 'A test project',
  status: 'active',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  persona_count: 0,
  document_count: 0,
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function renderTab(projectId = 'proj-123') {
  const qc = createQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <McpAccessTab
        projectId={projectId}
        project={mockProject}
        personas={[]}
        documents={[]}
        onSaveKiroPrompt={vi.fn()}
      />
    </QueryClientProvider>
  )
}

const mockPersonas = [
  { persona_id: 'p1', name: 'Persona A', tagline: 'Tag A', created_at: '' },
  { persona_id: 'p2', name: 'Persona B', tagline: 'Tag B', created_at: '' },
]

const mockDocuments = [
  { document_id: 'd1', title: 'Doc A', document_type: 'prd' as const, content: '', created_at: '' },
]

function renderTabWithData(projectId = 'proj-123') {
  const qc = createQueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <McpAccessTab
        projectId={projectId}
        project={mockProject}
        personas={mockPersonas}
        documents={mockDocuments}
        onSaveKiroPrompt={vi.fn()}
      />
    </QueryClientProvider>
  )
}

/** Personas and documents — the two sections a picker can offer. */
const PICKER_SECTION_COUNT = 2

/**
 * Empties every picker section via its bulk control.
 *
 * Bulk rather than per-checkbox because the sections are collapsed by default, so
 * the individual rows are not rendered — but each header's Select all / Deselect
 * all always is. Each click flips that section's control to "Select all", so the
 * query is re-run rather than holding stale handles.
 *
 * Bounded: if a regression stopped the label flipping, an unbounded loop would
 * spin to the test timeout instead of failing here with a usable message.
 */
async function deselectEverySection(user: ReturnType<typeof userEvent.setup>) {
  const deselectAll = () => screen.queryAllByRole('button', { name: /^Deselect all$/ })
  for (let attempt = 0; attempt <= PICKER_SECTION_COUNT; attempt += 1) {
    const remaining = deselectAll()
    if (remaining.length === 0) return
    await user.click(remaining[0])
  }
  throw new Error('Deselect all never stopped appearing — the bulk control is not flipping state')
}

const mockToken: ApiToken = {
  token_id: 'tok-1',
  name: 'My Kiro token',
  scopes: ['feedback:read', 'metrics:read', 'projects:read'],
  projects: ['proj-123'],
  read_reach: 'workspace',
  created_at: '2026-03-20T10:00:00Z',
  last_used_at: '2026-03-21T15:00:00Z',
}

const ALL_SCOPES = ['feedback:read', 'metrics:read', 'projects:read'] as const

/**
 * Tick scope checkboxes. The form starts with NONE checked on purpose — the
 * mint route requires `scopes` so the laziest request cannot mint the widest
 * credential, and a pre-checked form would defeat that — so every test that
 * submits has to choose explicitly, exactly as a user does.
 */
async function selectScopes(
  user: ReturnType<typeof userEvent.setup>,
  scopes: readonly string[] = ALL_SCOPES,
) {
  for (const scope of scopes) {
    await user.click(screen.getByRole('checkbox', { name: new RegExp(scope) }))
  }
}

/** The payload the form sends when every scope is ticked and reach is left alone. */
const DEFAULT_MINT_BODY = {
  scopes: [...ALL_SCOPES],
  read_reach: 'workspace',
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
    const user = userEvent.setup()
    renderTab()
    // Expand the Active Tokens section first (collapsed by default)
    await waitFor(() => {
      expect(screen.getByText('Active Tokens (0)')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Active Tokens (0)'))
    expect(screen.getByText('No API tokens yet')).toBeInTheDocument()
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
    expect(screen.getByText('Whole workspace')).toBeInTheDocument()
  })

  it('shows create form when Generate Token is clicked', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    expect(screen.getByLabelText('Token name')).toBeInTheDocument()
    // Two independent axes, so two controls: scopes (which data) and reach
    // (how far). One select could not express "write here, read everywhere".
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    expect(screen.getByLabelText('Read reach')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument()
  })

  it('disables Generate button when name is empty', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
  })

  it('needs both a name and a scope before Generate enables', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Test token')
    await selectScopes(user)
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
    await selectScopes(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(screen.getByText('Token created successfully')).toBeInTheDocument()
    })
    expect(mockCreateApiToken).toHaveBeenCalledWith('proj-123', {
      name: 'Test token', ...DEFAULT_MINT_BODY,
    })
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

  it('renders an MCP config snippet with no X-Project-Id header', async () => {
    const user = userEvent.setup()
    renderTab()
    expect(screen.getByText('MCP Client Configuration')).toBeInTheDocument()
    // Expand the MCP Client Configuration section
    await user.click(screen.getByText('MCP Client Configuration'))
    // The credential resolves itself now, so the snippet carries only the
    // Authorization header. Leaving X-Project-Id in would have people paste a
    // contract the server ignores.
    expect(screen.getByText(/Bearer <YOUR_API_TOKEN>/)).toBeInTheDocument()
    expect(screen.queryByText(/X-Project-Id/)).not.toBeInTheDocument()
  })

  it('copies MCP config to clipboard', async () => {
    const user = userEvent.setup()
    renderTab()
    // Expand the MCP Client Configuration section first
    await user.click(screen.getByText('MCP Client Configuration'))
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
    await selectScopes(user)
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
    await selectScopes(user)
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(screen.getByText('Token created successfully')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Dismiss'))
    expect(screen.queryByText('Token created successfully')).not.toBeInTheDocument()
  })

  it('mints a narrower credential when a scope is unchecked', async () => {
    const user = userEvent.setup()
    mockCreateApiToken.mockResolvedValue({
      token: 'voc_tok_aaaaaaaaaaaaaaaa_narrow', token_id: 'tok-narrow', name: 'Narrow',
      scopes: ['feedback:read', 'metrics:read'], projects: ['proj-123'],
      read_reach: 'workspace',
    })
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Narrow')
    // Ticking only two is the point of per-domain scopes: a credential that
    // reads feedback without reading anybody's product strategy.
    await selectScopes(user, ['feedback:read', 'metrics:read'])
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(mockCreateApiToken).toHaveBeenCalledWith('proj-123', {
        name: 'Narrow',
        scopes: ['feedback:read', 'metrics:read'],
        read_reach: 'workspace',
      })
    })
  })

  it('mints a sealed credential when the reach is narrowed', async () => {
    const user = userEvent.setup()
    mockCreateApiToken.mockResolvedValue({
      token: 'voc_tok_bbbbbbbbbbbbbbbb_sealed', token_id: 'tok-sealed', name: 'Sealed',
      scopes: ['feedback:read', 'metrics:read', 'projects:read'],
      projects: ['proj-123'], read_reach: 'project-set',
    })
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Sealed')
    await selectScopes(user)
    await user.selectOptions(screen.getByLabelText('Read reach'), 'project-set')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(mockCreateApiToken).toHaveBeenCalledWith('proj-123', {
        name: 'Sealed', ...DEFAULT_MINT_BODY, read_reach: 'project-set',
      })
    })
  })

  it('renders each scope description, not an i18n fallback', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))

    // Regression: scope names contain a COLON, which is i18next's default
    // namespace separator, so `t('mcp.scopeDesc.feedback:read')` was parsed as
    // namespace `mcp.scopeDesc.feedback` + key `read`, resolved to nothing, and
    // rendered the literal "read" under every checkbox. Found in a browser
    // against the deployed site; invisible here until something asserted the
    // description text, because the key still "resolved" to a plausible word.
    expect(screen.getByText('Search and read customer feedback')).toBeInTheDocument()
    expect(screen.getByText('Read dashboards and metric breakdowns')).toBeInTheDocument()
    expect(screen.getByText('Read projects, personas and documents')).toBeInTheDocument()

    // And the fallback string must not appear on its own anywhere.
    expect(screen.queryAllByText('read')).toHaveLength(0)
  })

  it('starts with no scope checked and cannot submit until one is', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Empty')

    // No scope is pre-selected: the backend requires `scopes` precisely so the
    // laziest request cannot mint the widest credential, and a pre-checked form
    // would hand that default back, making the requirement enforcement-only.
    for (const scope of ALL_SCOPES) {
      expect(screen.getByRole('checkbox', { name: new RegExp(scope) })).not.toBeChecked()
    }
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()

    // One tick is enough to proceed — the friction is a choice, not a wall.
    await selectScopes(user, ['feedback:read'])
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
    expect(mockCreateApiToken).not.toHaveBeenCalled()
  })

  it('says out loud that the default reach is workspace-wide', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    // The default is the WIDEST option, so the form has to say so rather than
    // presenting the choices as equivalent. This is the UI half of the owner's
    // read-reach decision.
    expect(screen.getByLabelText('Read reach')).toHaveValue('workspace')
    expect(screen.getByText(/every project/i)).toBeInTheDocument()
  })

  it('badges a workspace-reach token in the list', async () => {
    const user = userEvent.setup()
    mockListApiTokens.mockResolvedValue({ tokens: [mockToken] })
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('Active Tokens (1)')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Active Tokens (1)'))
    // The list is where someone notices a credential reaches further than they
    // assumed, so the reach is shown per row, not only at mint time.
    expect(screen.getByText('Whole workspace')).toBeInTheDocument()
    expect(screen.getByText(/feedback:read/)).toBeInTheDocument()
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

  it('shows loading state', async () => {
    const user = userEvent.setup()
    mockListApiTokens.mockReturnValue(new Promise(() => {})) // never resolves
    renderTab()
    // Expand the Active Tokens section to see the loading state
    await user.click(screen.getByText('Active Tokens (0)'))
    expect(screen.getByText('Loading tokens\u2026')).toBeInTheDocument()
  })
})

describe('McpAccessTab \u2014 AutoseedContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListApiTokens.mockResolvedValue({ success: true, tokens: [] })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows error message when clipboard write fails in Kiro Autoseed section', async () => {
    const user = userEvent.setup()
    const mockWriteText = vi.fn().mockRejectedValue(new Error('Permission denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: mockWriteText } })
    renderTabWithData()

    // Expand the Kiro Autoseed collapsible section
    await user.click(screen.getByText('Kiro Autoseed'))

    const copyBtn = screen.getByRole('button', { name: /Copy Kiro Prompt/i })
    await user.click(copyBtn)

    await waitFor(() => {
      // The localized 'autoseed.copyFailed' string is shown, not the raw error.
      expect(screen.getByRole('alert')).toHaveTextContent('Copy failed')
    })
  })

  it('disables Kiro Autoseed copy button when nothing is selected', async () => {
    const user = userEvent.setup()
    renderTabWithData()

    // Expand the Kiro Autoseed collapsible section
    await user.click(screen.getByText('Kiro Autoseed'))

    const copyBtn = screen.getByRole('button', { name: /Copy Kiro Prompt/i })
    // Starts enabled \u2014 all items are pre-selected
    expect(copyBtn).toBeEnabled()

    await deselectEverySection(user)

    expect(copyBtn).toBeDisabled()
  })
})

describe('McpAccessTab \u2014 ExportCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListApiTokens.mockResolvedValue({ success: true, tokens: [] })
  })

  afterEach(() => {
    // Unconditionally restore any stubbed globals (e.g. navigator.clipboard)
    // so a failing assertion above doesn't leak the stub into the next test.
    vi.unstubAllGlobals()
  })

  it('calls autoseedProject and copies to clipboard on success', async () => {
    const user = userEvent.setup()
    const mockWriteText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: mockWriteText } })
    mockAutoseedProject.mockResolvedValue({
      project: {},
      files: [{ path: 'steering.md', content: '# Context' }],
    })
    renderTabWithData()

    const copyBtn = screen.getByRole('button', { name: /Copy to clipboard/i })
    await user.click(copyBtn)

    await waitFor(() => {
      expect(mockAutoseedProject).toHaveBeenCalledWith('proj-123', expect.any(Object))
    })
    expect(mockWriteText).toHaveBeenCalledWith('# Context')
  })

  it('shows error message when autoseedProject rejects', async () => {
    const user = userEvent.setup()
    mockAutoseedProject.mockRejectedValue(new Error('Network error'))
    renderTabWithData()

    const copyBtn = screen.getByRole('button', { name: /Copy to clipboard/i })
    await user.click(copyBtn)

    await waitFor(() => {
      // The localized 'export.copyFailed' string is shown, not the raw error message.
      expect(screen.getByRole('alert')).toHaveTextContent('Copy failed')
    })
  })

  it('disables copy button when nothing is selected (all deselected)', async () => {
    const user = userEvent.setup()
    renderTabWithData()

    // The copy button starts enabled because all items are pre-selected.
    const copyBtn = screen.getByRole('button', { name: /Copy to clipboard/i })
    expect(copyBtn).toBeEnabled()

    await deselectEverySection(user)

    expect(copyBtn).toBeDisabled()
  })
})

describe('token expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListApiTokens.mockResolvedValue({ success: true, tokens: [] })
  })

  // NOTE: the omission case — expiry left at its 'never' default sends NO
  // expires_in_days field — is pinned by the exact-payload assertion in
  // 'calls createApiToken on submit' above ({ name, scope } and nothing else).

  it('sends expires_in_days when a lifetime is chosen and shows the deadline on the banner', async () => {
    const user = userEvent.setup()
    const expiresAt = '2026-09-17T14:00:00+00:00'
    mockCreateApiToken.mockResolvedValue({
      success: true,
      token: 'voc_abc123secret',
      token_id: 'tok-new',
      name: 'Expiring token',
      expires_at: expiresAt,
    })
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 'Expiring token')
    await selectScopes(user)
    await user.selectOptions(screen.getByLabelText('Expiration'), '30')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => {
      expect(screen.getByText('Token created successfully')).toBeInTheDocument()
    })
    expect(mockCreateApiToken).toHaveBeenCalledWith('proj-123', {
      name: 'Expiring token',
      ...DEFAULT_MINT_BODY,
      expires_in_days: 30,
    })
    // The banner names the deadline of THE credential just minted.
    expect(
      screen.getByText(`This token expires on ${new Date(expiresAt).toLocaleDateString()}.`),
    ).toBeInTheDocument()
  })

  it('resets the expiry choice after a successful create', async () => {
    const user = userEvent.setup()
    mockCreateApiToken.mockResolvedValue({
      success: true, token: 'voc_x', token_id: 'tok-x', name: 't', expires_at: null,
    })
    renderTab()
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    await user.type(screen.getByLabelText('Token name'), 't')
    await selectScopes(user)
    await user.selectOptions(screen.getByLabelText('Expiration'), '90')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => {
      expect(screen.getByText('Token created successfully')).toBeInTheDocument()
    })
    // Reopen the form (the generate button hides while the banner is up, so
    // dismiss first): a stale 90-day choice would silently mint the NEXT
    // token with a lifetime nobody picked this time around.
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    await user.click(screen.getByRole('button', { name: /Generate Token/i }))
    expect(screen.getByLabelText('Expiration')).toHaveValue('never')
  })

  it('renders a dated row for a future expiry and nothing for legacy tokens', async () => {
    const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    mockListApiTokens.mockResolvedValue({
      success: true,
      tokens: [
        { ...mockToken, token_id: 'tok-legacy' },
        { ...mockToken, token_id: 'tok-dated', name: 'Dated', expires_at: future },
      ],
    })
    const user = userEvent.setup()
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('Active Tokens (2)')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Active Tokens (2)'))
    // Exactly one row carries the expiry line — the legacy row renders as it
    // always did, byte-for-byte the pre-expiry UI.
    expect(screen.getAllByText(`Expires ${new Date(future).toLocaleDateString()}`)).toHaveLength(1)
    expect(screen.queryByText(/^Expired /)).not.toBeInTheDocument()
  })

  it('marks an expired token as expired, matching what the backend enforces', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    mockListApiTokens.mockResolvedValue({
      success: true,
      tokens: [{ ...mockToken, token_id: 'tok-dead', name: 'Dead', expires_at: past }],
    })
    const user = userEvent.setup()
    renderTab()
    await waitFor(() => {
      expect(screen.getByText('Active Tokens (1)')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Active Tokens (1)'))
    // The backend refuses this credential at auth time; the row must not
    // read as quietly usable.
    expect(screen.getByText(`Expired ${new Date(past).toLocaleDateString()}`)).toBeInTheDocument()
    expect(screen.queryByText(/^Expires /)).not.toBeInTheDocument()
  })
})
