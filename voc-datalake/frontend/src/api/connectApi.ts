/**
 * @fileoverview Connect page API: personal tokens for the global MCP endpoint
 * (`/connect/tokens`, lambda/api/mcp_tokens_handler.py). Every response is
 * parsed through api/connectSchema.ts.
 *
 * @module api/connectApi
 */
import { fetchApi } from './client'
import {
  MintResponseSchema, RevokeResponseSchema, TokenDetailResponseSchema, TokenListResponseSchema,
} from './connectSchema'
import type { ConnectScope, MintResponse, TokenDetailResponse, TokenListResponse, ConnectToken } from './connectSchema'

export interface MintTokenRequest {
  name: string
  scope: ConnectScope
  expires_in_days: number
  project_id?: string
}

const TOKENS_PATH = '/connect/tokens'

/** TanStack Query key of the token list; a token's detail/audit query extends it. */
export const CONNECT_TOKENS_KEY = ['connect', 'tokens'] as const

export const connectApi = {
  listTokens: async (): Promise<TokenListResponse> =>
    TokenListResponseSchema.parse(await fetchApi<unknown>(TOKENS_PATH)),

  mintToken: async (request: MintTokenRequest): Promise<MintResponse> =>
    MintResponseSchema.parse(await fetchApi<unknown>(TOKENS_PATH, { method: 'POST', body: JSON.stringify(request) })),

  revokeToken: async (tokenId: string): Promise<ConnectToken> =>
    RevokeResponseSchema.parse(await fetchApi<unknown>(`${TOKENS_PATH}/${encodeURIComponent(tokenId)}`, { method: 'DELETE' })).token,

  tokenDetail: async (tokenId: string, cursor?: string): Promise<TokenDetailResponse> => {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    return TokenDetailResponseSchema.parse(await fetchApi<unknown>(`${TOKENS_PATH}/${encodeURIComponent(tokenId)}${query}`))
  },
}
