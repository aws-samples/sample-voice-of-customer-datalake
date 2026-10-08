/**
 * Connect (todofeatures §6.3): mint / list / revoke personal tokens for the
 * global MCP endpoint, copy the endpoint and mcp.json, get the skill.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { useConfigStore } from '../../store/configStore'
import { at } from '@test/defined'

const listTokens = vi.fn<() => unknown>()
const mintToken = vi.fn<(request: unknown) => unknown>()
const revokeToken = vi.fn<(tokenId: string) => unknown>()
const tokenDetail = vi.fn<(tokenId: string) => unknown>()
const getProjects = vi.fn<() => unknown>()

vi.mock('../../api/connectApi', () => ({
  CONNECT_TOKENS_KEY: ['connect', 'tokens'],
  connectApi: {
    listTokens: () => listTokens(),
    mintToken: (request: unknown) => mintToken(request),
    revokeToken: (tokenId: string) => revokeToken(tokenId),
    tokenDetail: (tokenId: string) => tokenDetail(tokenId),
  },
}))
vi.mock('../../api/projectsApi', () => ({ projectsApi: { getProjects: () => getProjects() } }))

const { default: Connect } = await import('./Connect')

const ACTIVE = {
  token_id: 'tok_0123456789abcdef', name: 'Kiro laptop', scope: 'write', project_id: undefined,
  created_at: '2026-10-01T10:00:00+00:00', expires_at: '2026-10-31T10:00:00+00:00',
  last_used_at: undefined, revoked_at: undefined, status: 'active', can_run_agents: false,
}
const REVOKED = { ...ACTIVE, token_id: 'tok_fedcba9876543210', name: 'Old', status: 'revoked', scope: 'read' }

function listing(tokens: unknown[] = [ACTIVE], extra: Record<string, unknown> = {}) {
  return {
    tokens, endpoint_path: '/mcp/global', can_mint_agent_runner: false,
    limits: { default_expiry_days: 30, max_expiry_days: 90, max_active_tokens: 20 }, ...extra,
  }
}

function renderConnect(path = '/connect') {
  return renderWithQueryClient(<TestRouter initialEntries={[path]}><Connect /></TestRouter>)
}

beforeEach(() => {
  for (const mock of [listTokens, mintToken, revokeToken, tokenDetail, getProjects]) mock.mockReset()
  getProjects.mockResolvedValue({ projects: [{ project_id: 'proj_1', name: 'Checkout revamp' }] })
  listTokens.mockResolvedValue(listing())
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com/v1/' } }))
})

describe('Connect', () => {
  it('shows the global endpoint and an mcp.json that carries no real token', async () => {
    renderConnect()

    expect(await screen.findByTestId('connect-endpoint')).toHaveTextContent('https://api.example.com/v1/mcp/global')
    const snippet = screen.getByTestId('connect-mcp-json').textContent
    expect(JSON.parse(snippet)).toStrictEqual({
      mcpServers: { 'voc-datalake': { url: 'https://api.example.com/v1/mcp/global',
        headers: { Authorization: 'Bearer <YOUR_VOC_TOKEN>' } } },
    })
    expect(screen.getByRole('link', { name: /Open skill/ })).toHaveAttribute('href', '/voc-mcp-skill.md')
  })

  it('cannot mint until a name and a scope are chosen, then shows the token once', async () => {
    const user = userEvent.setup()
    mintToken.mockResolvedValue({ ...ACTIVE, token: `voc_tok_0123456789abcdef_${'a'.repeat(64)}` })
    renderConnect()

    const create = await screen.findByRole('button', { name: 'Create token' })
    await user.type(screen.getByLabelText('Name'), 'Copilot')
    expect(create).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /Read only/ }))
    await user.click(create)

    expect(mintToken).toHaveBeenCalledWith({ name: 'Copilot', scope: 'read', expires_in_days: 30 })
    expect(await screen.findByTestId('connect-new-token')).toHaveTextContent(/^voc_tok_/)
    expect(screen.getByText(/it will not be shown again/)).toBeInTheDocument()
  })

  it('pre-scopes a token to the project it was opened from', async () => {
    const user = userEvent.setup()
    mintToken.mockResolvedValue({ ...ACTIVE, project_id: 'proj_1', token: `voc_tok_0123456789abcdef_${'b'.repeat(64)}` })
    renderConnect('/connect?project=proj_1')

    await screen.findByRole('option', { name: 'Checkout revamp' })
    expect(screen.getByLabelText('Project')).toHaveValue('proj_1')
    await user.type(screen.getByLabelText('Name'), 'Scoped')
    await user.click(screen.getByRole('radio', { name: /Read and write/ }))
    await user.selectOptions(screen.getByLabelText('Expires after'), '7')
    await user.click(screen.getByRole('button', { name: 'Create token' }))

    expect(mintToken).toHaveBeenCalledWith({ name: 'Scoped', scope: 'write', expires_in_days: 7, project_id: 'proj_1' })
  })

  it('offers agent runs in the write hint only to an admin', async () => {
    listTokens.mockResolvedValue(listing([], { can_mint_agent_runner: true }))
    renderConnect()
    expect(await screen.findByText(/can also run autonomous agents/)).toBeInTheDocument()
  })

  it('lists my tokens and revokes an active one after confirming', async () => {
    const user = userEvent.setup()
    listTokens.mockResolvedValue(listing([ACTIVE, REVOKED]))
    revokeToken.mockResolvedValue({ ...ACTIVE, status: 'revoked' })
    renderConnect()

    const rows = await screen.findAllByRole('listitem')
    expect(within(at(rows, 0)).getByText('Active')).toBeInTheDocument()
    expect(within(at(rows, 1)).getByText('Revoked')).toBeInTheDocument()
    expect(within(at(rows, 1)).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument()

    await user.click(within(at(rows, 0)).getByRole('button', { name: /Revoke/ }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    expect(revokeToken).toHaveBeenCalledWith('tok_0123456789abcdef')
  })

  it('shows a token\u2019s audit log: tool, project and outcome only', async () => {
    const user = userEvent.setup()
    tokenDetail.mockResolvedValue({
      token: ACTIVE, next_cursor: undefined,
      events: [{ tool: 'create_document', at: '2026-10-02T09:00:00+00:00', project_id: 'proj_1', outcome: 'denied' }],
    })
    renderConnect()

    await user.click(await screen.findByRole('button', { name: 'Show activity of Kiro laptop' }))

    const table = await screen.findByRole('table', { name: 'Tool calls' })
    expect(within(table).getByText('create_document')).toBeInTheDocument()
    expect(within(table).getByText('proj_1')).toBeInTheDocument()
    expect(within(table).getByText('Denied')).toBeInTheDocument()
    expect(tokenDetail).toHaveBeenCalledWith('tok_0123456789abcdef')
  })

  it('says when there are no tokens yet', async () => {
    listTokens.mockResolvedValue(listing([]))
    renderConnect()
    expect(await screen.findByText('You have no MCP tokens yet.')).toBeInTheDocument()
  })

  it('reports a failed load instead of a blank page', async () => {
    listTokens.mockRejectedValue(new Error('boom'))
    renderConnect()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your MCP tokens')
  })

  it('asks for the API endpoint before anything else', () => {
    useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: '' } }))
    renderConnect()
    expect(screen.getByText('Configure the API endpoint first.')).toBeInTheDocument()
    expect(listTokens).not.toHaveBeenCalled()
  })
})
