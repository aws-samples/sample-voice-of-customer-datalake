/**
 * Connect, MCP OAuth half (docs/mcp.md "OAuth sign-in"): the sign-in snippets carry no token, the
 * signed-in assistants list revokes, and a deployment with minting off hides the mint form.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { useConfigStore } from '../../store/configStore'

const listTokens = vi.fn<() => unknown>()
const listGrants = vi.fn<() => unknown>()
const revokeGrant = vi.fn<(grantId: string) => unknown>()

vi.mock('../../api/connectApi', () => ({
  CONNECT_TOKENS_KEY: ['connect', 'tokens'],
  connectApi: { listTokens: () => listTokens(), mintToken: vi.fn(), revokeToken: vi.fn(), tokenDetail: vi.fn() },
}))
vi.mock('../../api/oauthApi', () => ({
  OAUTH_GRANTS_KEY: ['connect', 'oauth', 'grants'],
  oauthApi: { listGrants: () => listGrants(), revokeGrant: (grantId: string) => revokeGrant(grantId) },
}))
vi.mock('../../api/projectsApi', () => ({ projectsApi: { getProjects: () => Promise.resolve({ projects: [] }) } }))

const { default: Connect } = await import('./Connect')

const CLIENTS = [{ kind: 'kiro', name: 'Kiro' }, { kind: 'claude-code', name: 'Claude Code' }, { kind: 'cursor', name: 'Cursor' }]
const GRANT = {
  grant_id: 'oag_0123456789abcdef0123456789abcdef01234567', client_kind: 'kiro', client_name: 'Kiro', scope: 'write',
  project_id: undefined, created_at: '2026-10-01T10:00:00+00:00', expires_at: '2026-12-30T10:00:00+00:00',
  last_used_at: undefined, revoked_at: undefined, status: 'active', signed_in: true,
}

function listing(extra: Record<string, unknown> = {}) {
  return {
    tokens: [], endpoint_path: '/mcp/global', can_mint_agent_runner: false,
    limits: { default_expiry_days: 30, max_expiry_days: 90, max_active_tokens: 20 },
    minting_enabled: true, oauth: { enabled: true, clients: CLIENTS }, ...extra,
  }
}

const MCP_URL = 'https://api.example.com/v1/mcp/global'

beforeEach(() => {
  for (const mock of [listTokens, listGrants, revokeGrant]) mock.mockReset()
  listTokens.mockResolvedValue(listing())
  listGrants.mockResolvedValue([GRANT])
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com/v1/' } }))
})

const renderConnect = () => renderWithQueryClient(<TestRouter initialEntries={['/connect']}><Connect /></TestRouter>)

describe('Connect: sign in with your account', () => {
  it('gives each verified client a snippet with the URL only, never a token', async () => {
    renderConnect()

    expect(JSON.parse(await screen.findByTestId('connect-oauth-kiro').then((el) => el.textContent)))
      .toStrictEqual({ mcpServers: { 'voc-datalake': { url: MCP_URL } } })
    expect(screen.getByTestId('connect-oauth-claude-code')).toHaveTextContent(`claude mcp add --transport http voc-datalake ${MCP_URL}`)
    expect(JSON.parse(screen.getByTestId('connect-oauth-cursor').textContent)).toStrictEqual({ mcpServers: { 'voc-datalake': { url: MCP_URL } } })
    expect(screen.getByTestId('connect-oauth-web')).toHaveTextContent(/not set up on this deployment/)
  })

  it('marks web assistants untested when the deployment configured them', async () => {
    listTokens.mockResolvedValue(listing({ oauth: { enabled: true, clients: [...CLIENTS, { kind: 'web', name: 'Web assistant' }] } }))
    renderConnect()

    expect(await screen.findByTestId('connect-oauth-web')).toHaveTextContent(/not been tested live/)
  })

  it('shows nothing about sign-in when OAuth is not configured', async () => {
    listTokens.mockResolvedValue(listing({ oauth: { enabled: false, clients: [] } }))
    renderConnect()

    expect(await screen.findByRole('button', { name: 'Create token' })).toBeInTheDocument()
    expect(screen.queryByTestId('connect-oauth-kiro')).not.toBeInTheDocument()
    expect(listGrants).not.toHaveBeenCalled()
  })

  it('revokes a signed-in assistant after confirmation', async () => {
    const user = userEvent.setup()
    revokeGrant.mockResolvedValue({ ...GRANT, status: 'revoked' })
    renderConnect()

    const row = await screen.findByTestId(`connect-grant-${GRANT.grant_id}`)
    await user.click(within(row).getByRole('button', { name: 'Sign out Kiro' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }))

    expect(revokeGrant).toHaveBeenCalledWith(GRANT.grant_id)
  })

  it('hides the mint form when minting is off, and says how to connect instead', async () => {
    listTokens.mockResolvedValue(listing({ minting_enabled: false }))
    renderConnect()

    expect(await screen.findByTestId('connect-minting-off')).toHaveTextContent(/cannot be created on this deployment/)
    expect(screen.queryByRole('button', { name: 'Create token' })).not.toBeInTheDocument()
  })
})
