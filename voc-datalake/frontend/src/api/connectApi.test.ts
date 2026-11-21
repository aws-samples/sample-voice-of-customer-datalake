/**
 * The Connect page's API (connectApi.ts): each call's path and method, and every answer read through its schema
 * (the token list, a mint's one-time credential, a revoke, a token's audit page and its cursor).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, resetFetchApi } from '@test/fetchApiRoutes'
import { connectApi } from './connectApi'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const TOKEN = {
  token_id: 'tok_0123456789abcdef', name: 'Kiro laptop', scope: 'read', created_at: '2026-10-01T10:00:00+00:00',
  expires_at: '2026-10-31T10:00:00+00:00', status: 'active', can_run_agents: false,
}

beforeEach(() => {
  resetFetchApi()
})

describe('connectApi', () => {
  it('lists the tokens and the page facts', async () => {
    fetchApi.mockResolvedValueOnce({ tokens: [TOKEN], endpoint_path: '/mcp/global', can_mint_agent_runner: false,
      limits: { default_expiry_days: 30, max_expiry_days: 90, max_active_tokens: 20 }, minting_enabled: true,
      oauth: { enabled: false, clients: [] } })
    const listed = await connectApi.listTokens()
    expect([listed.tokens.map((token) => token.token_id), fetchApi.mock.calls[0]?.[0]])
      .toStrictEqual([['tok_0123456789abcdef'], '/connect/tokens'])
  })

  it('mints a token with a POST and reads its one-time credential', async () => {
    fetchApi.mockResolvedValueOnce({ ...TOKEN, token: 'voc_fictional' })
    const minted = await connectApi.mintToken({ name: 'Kiro laptop', scope: 'read', expires_in_days: 30 })
    expect(minted.token).toBe('voc_fictional')
    expect(fetchApi).toHaveBeenCalledWith('/connect/tokens', expect.objectContaining({ method: 'POST' }))
  })

  it('revokes a token by its escaped id', async () => {
    fetchApi.mockResolvedValueOnce({ token: { ...TOKEN, status: 'revoked' } })
    await expect(connectApi.revokeToken('tok a')).resolves.toMatchObject({ status: 'revoked' })
    expect(fetchApi).toHaveBeenCalledWith('/connect/tokens/tok%20a', expect.objectContaining({ method: 'DELETE' }))
  })

  it('reads a token\'s audit page, from its cursor when given', async () => {
    fetchApi.mockResolvedValue({ token: TOKEN, events: [], next_cursor: null })
    await connectApi.tokenDetail('tok_1')
    await connectApi.tokenDetail('tok_1', 'c/1')
    expect(fetchApi.mock.calls.map(([path]) => path)).toStrictEqual(['/connect/tokens/tok_1', '/connect/tokens/tok_1?cursor=c%2F1'])
  })
})
