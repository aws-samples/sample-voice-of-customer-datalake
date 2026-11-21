/**
 * @fileoverview Any public GitHub repository for the engineering agents (7.57.00, administrators only, while the
 * engineering agents are on).
 *
 * - `GET /agents/engineering/public-repositories?q=…` searches GitHub on the server (a name, `owner/name` or a
 *   github.com address), read with the deployment's GitHub App's read-only token: each result's stars, licence (its
 *   SPDX id), whether it is archived, its last push, and the connection that already reads it. 409 while the
 *   deployment has no GitHub App installation to read with.
 * - `POST /agents/engineering/public-connections` connects one read-only (`public_read`): its issues are read as
 *   feedback, Understand and the knowledge docs, triage and bug hunts stay in VoC, and nothing is ever written to it
 *   (no label, comment or pull request). A private repository connects through the App's installation as before.
 *
 * No answer carries a token. A result the page cannot read is left out; an answer without a list is an error. Since
 * 7.60.00 each result says the ways it can be connected (`ways`: the App installed on it, a fine-grained token, a fork),
 * derived from its facts when the answer leaves them out.
 *
 * @module api/publicRepositoriesApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { post } from './requestKit'
import { parseEach } from './lenientFields'
import { optionalServerText, parseConnection } from './engineeringConnectionsApi'
import { parseIssuesFollow } from './issuesSourceApi'
import { isRecord } from '../lib/typeGuards'
import type { SavedConnection } from './engineeringConnectionsApi'
import type { IssuesFollow } from './issuesSourceApi'

/** The longest search the server takes. */
export const MAX_QUERY_CHARS = 200

const LicenceSchema = z.object({ spdx: optionalServerText(), name: z.string().catch('') }).nullable().catch(null)

const PublicRepositorySchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/),
  description: optionalServerText(),
  stars: z.number().int().nonnegative().catch(0),
  licence: LicenceSchema,
  archived: z.boolean().catch(false),
  pushed_at: optionalServerText(),
  default_branch: z.string().catch(''),
  /** Its page, only on github.com ('' for anything else: never linked). */
  html_url: z.string().catch('').transform((url) => (url.startsWith('https://github.com/') ? url : '')),
  fork: z.boolean().catch(false),
  /** The connection that already reads it; null for none. */
  connected: optionalServerText(),
})

export type PublicRepository = z.output<typeof PublicRepositorySchema>

export interface PublicSearch {
  repositories: PublicRepository[]
}

export interface ConnectedPublic extends SavedConnection {
  /** What followed for the deployment's GitHub Issues source, or null when none is deployed here. */
  issues: IssuesFollow | null
}

function parseSearch(raw: unknown): PublicSearch {
  if (!isRecord(raw) || !Array.isArray(raw.repositories)) throw new Error('The repository search answer was unreadable')
  return { repositories: parseEach(PublicRepositorySchema, raw.repositories) }
}

function parseConnected(raw: unknown): ConnectedPublic {
  const connection = isRecord(raw) ? parseConnection(raw.connection) : null
  if (connection === null || !isRecord(raw)) throw new Error('The connected repository was unreadable')
  return { connection, created: raw.created === true, issues: parseIssuesFollow(raw.issues) }
}

const SEARCH_PATH = '/agents/engineering/public-repositories'
const CONNECT_PATH = '/agents/engineering/public-connections'

export const publicRepositoriesKeys = { search: (query: string) => ['engineering-public-repositories', query] as const }

export const publicRepositoriesApi = {
  /** The public repositories GitHub finds for `query` (trimmed, at most `MAX_QUERY_CHARS`). */
  search: async (query: string): Promise<PublicSearch> =>
    parseSearch(await fetchApi<unknown>(`${SEARCH_PATH}?${new URLSearchParams({ q: query.trim() }).toString()}`)),
  /** Connect `repository` (`owner/name`) read-only; `reason` kept with its audit row when given. */
  connect: async (repository: string, reason = ''): Promise<ConnectedPublic> =>
    parseConnected(await fetchApi<unknown>(CONNECT_PATH, post(reason.trim() === '' ? { repository } : { repository, reason: reason.trim() }))),
}
