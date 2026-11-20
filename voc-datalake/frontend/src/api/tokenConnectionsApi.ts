/**
 * @fileoverview A public repository connected with a person's fine-grained token limited to it (7.60.00, administrators
 * only, while the engineering agents are on; docs/autonomous-engineering.md "A fine-grained token (7.60.00)").
 *
 * - `POST /agents/engineering/token-connections` checks the token on GitHub and saves the connection: the repository
 *   must be public, not archived, and the token must push to it, expire within 90 days and (the person's tick, sent as
 *   `only_this_repository: true`) reach only it. Reads go with the deployment's GitHub App's read-only token; the
 *   person's token is used only for a run's final push and pull request, after the gates and their own go.
 * - `PUT /agents/engineering/connections/<id>/token` replaces (renews) the token of such a connection, checked the same
 *   way against the connection's own repository.
 *
 * The token goes in the one request and is never answered: the connection says only the token's login, its expiry and
 * whether the viewer saved it. A refusal of the token itself is a 422 with a `code` (`TOKEN_REFUSAL_CODES`), said in
 * plain words by the dialog (pages/Agents/TokenConnectionDialog.tsx).
 *
 * @module api/tokenConnectionsApi
 */
import { fetchApi } from './client'
import { post, put } from './requestKit'
import { parseConnection } from './engineeringConnectionsApi'
import { isRecord } from '../lib/typeGuards'
import type { EngineeringConnection, SavedConnection } from './engineeringConnectionsApi'

/** A new token connection: the repository (`owner/name`), the token, and the administrator's reason when given. */
export interface TokenConnectionRequest {
  repository: string
  token: string
  reason?: string
}

/** A token replaced on a stored connection (its repository is the connection's own). */
export interface TokenReplaceRequest {
  token: string
  reason?: string
}

/** The reason, sent only when given. */
const withReason = (reason: string | undefined) => (reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() })

function parseSaved(raw: unknown): SavedConnection {
  const connection = isRecord(raw) ? parseConnection(raw.connection) : null
  if (connection === null || !isRecord(raw)) throw new Error('The saved connection was unreadable')
  return { connection, created: raw.created === true }
}

const CREATE_PATH = '/agents/engineering/token-connections'
const tokenPath = (connectionId: string) => `/agents/engineering/connections/${encodeURIComponent(connectionId)}/token`

export const tokenConnectionsApi = {
  /** Connect `repository` with the token (the person ticked "This token can reach only it"). */
  create: async ({ repository, token, reason }: TokenConnectionRequest): Promise<SavedConnection> =>
    parseSaved(await fetchApi<unknown>(CREATE_PATH, post({
      repository, token, only_this_repository: true, ...withReason(reason),
    }))),
  /** Replace the stored token of a token connection (the same checks, on the connection's repository). */
  replace: async (connectionId: string, { token, reason }: TokenReplaceRequest): Promise<EngineeringConnection> =>
    parseSaved(await fetchApi<unknown>(tokenPath(connectionId), put({
      token, only_this_repository: true, ...withReason(reason),
    }))).connection,
}
