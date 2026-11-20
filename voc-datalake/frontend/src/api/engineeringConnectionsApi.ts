/**
 * @fileoverview The engineering agents' repository connections (administrators only): `GET
 * /agents/engineering/connections` lists them, `PUT …/connections/<id>` stores one with its credential, `DELETE
 * …/connections/<id>` removes it and its stored credential; `POST` / `DELETE …/connections/<id>/ci-attestation`
 * records or withdraws an administrator's attestation that the repository's CI meets the setup guide (the broker
 * refuses every push and pull request on a connection while none holds; a repository change or a removal voids it).
 * Since 7.57.00 a connection has a kind (a public repository read only, or a person's fork of one): `POST
 * …/connections/<id>/fork` starts a fork of a public one, `PUT …/connections/<id>/upstream` acknowledges the upstream's
 * current licence again (7.58.00; api/publicRepositoriesApi.ts finds and connects public repositories). Since 7.60.00 a
 * public repository can also be connected with a person's fine-grained token limited to it (`fine_grained`:
 * api/tokenConnectionsApi.ts saves and replaces the token; the token itself is never answered, only its login, its
 * expiry and whether the viewer saved it).
 *
 * The credential is write-only: a GitHub App's (its ids and its private key) or a GitLab project access token. The
 * server stores it in SSM and no answer ever carries it back; a connection says only whether one is set, and the
 * App's ids (GitHub) or the token's expiry as GitLab reported it at the save (GitLab). A save sends it to add a
 * connection or to change its host, repository or App, and leaves it out to keep the stored one. A connection the
 * answer cannot read is left out (never shown with made-up fields), but an answer without a list is an error, never
 * "no connections".
 *
 * @module api/engineeringConnectionsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { del, post, put } from './requestKit'
import { parseEach } from './lenientFields'
import { isRecord } from '../lib/typeGuards'

/** The most connections the server stores (its answer's `limit` wins when it gives one). */
const DEFAULT_CONNECTION_LIMIT = 20

/** A text the server may leave out: null then, never made up (githubAppsApi.ts's App rows too). */
export const optionalServerText = () => z.string().nullable().catch(null)

/** The repository hosts a connection reaches. */
export const CONNECTION_HOSTS = ['github', 'gitlab'] as const

export type ConnectionHost = (typeof CONNECTION_HOSTS)[number]

/**
 * A connection's credential kinds: a GitHub App's pasted key (`app`), a reference to one of the deployment's GitHub
 * Apps whose key is stored once for all its connections (`app_reference`, 7.45.00: a connection the in-app connect flow
 * saved), a GitLab project access token (`project_token`), (7.57.00) a public repository read through one of the
 * deployment's GitHub Apps with a read-only token (`public_read`: nothing is ever written with it), or (7.60.00) a
 * person's fine-grained token limited to the repository (`fine_grained_token`: only its final push and pull request).
 */
const CREDENTIAL_KINDS = ['app', 'app_reference', 'project_token', 'public_read', 'fine_grained_token'] as const

const CredentialStateSchema = z.object({
  /** A kind the page does not know reads as `app` (a GitHub App's, its ids shown as they are). */
  kind: z.enum(CREDENTIAL_KINDS).catch('app'),
  set: z.boolean().catch(false),
  app_id: optionalServerText(),
  installation_id: optionalServerText(),
  /** A token's expiry (`YYYY-MM-DD`): GitLab's at the save, or a fine-grained token's as GitHub said it; null for none known. */
  expires_at: optionalServerText(),
  /** (7.60.00) Whole days from today (UTC) to `expires_at` (0 or less: expired); null when the server sent none. */
  expires_in_days: z.number().int().nullable().catch(null),
  /** (7.60.00) A fine-grained token's GitHub login; null on every other kind. */
  login: optionalServerText(),
  /** (7.60.00) The viewer saved the fine-grained token: only they may give a run on it its go. */
  saved_by_you: z.boolean().catch(false),
  /** (7.60.00) Who saved the fine-grained token (their name); null on every other kind. */
  owner: optionalServerText(),
})

/**
 * The setup guide's points an administrator confirms for a connection's CI, by the ids the server takes, in its order
 * (lambda/engineering/connectors/attestations.py POINTS). An attestation confirms every one of them.
 */
export const CI_POINTS = [
  'protected_secrets', 'read_only_token', 'oidc_pinned', 'no_self_hosted_runner', 'no_privileged_pull_request',
  'branch_rules',
] as const

export type CiPoint = (typeof CI_POINTS)[number]

/** An attestation's state: it holds (`attested`), or an administrator withdrew it, or a change of the connection voided it. */
const CI_STATES = ['attested', 'withdrawn', 'voided'] as const

/**
 * The newest version of a connection's CI attestation. A state the page does not know reads as `voided` (never as
 * attested): only the server's `attested` says the broker lets the agents push.
 */
const CiAttestationSchema = z.object({
  version: z.number().int().catch(0),
  state: z.enum(CI_STATES).catch('voided'),
  repository: z.string().catch(''),
  points: z.array(z.string()).catch([]),
  by: optionalServerText(),
  at: optionalServerText(),
  reason: optionalServerText(),
  cause: optionalServerText(),
})

export type CiAttestation = z.output<typeof CiAttestationSchema>

/**
 * What a connection is (7.57.00): a repository the deployment's App or credential reaches (`repository`), any public
 * repository read only (`public_read`: issues as feedback, Understand and the knowledge docs, triage and bug hunts, all
 * kept in VoC: nothing is written to GitHub), or a person's fork of one (`fork`), whose agents push to the fork and
 * whose run ends with a pull request on the upstream, opened as the fork connection's owner; or (7.60.00) a public
 * repository whose run ends with a branch and a pull request on it, pushed with a person's fine-grained token after
 * their go (`fine_grained`). A kind the page does not know reads as `repository`.
 */
const CONNECTION_KINDS = ['repository', 'public_read', 'fork', 'fine_grained'] as const

/** A public repository's facts as the read-only connection recorded them; null for any other kind. */
const PublicFactsSchema = z.object({
  stars: z.number().int().nonnegative().catch(0),
  /** Its licence's SPDX id (`MIT`, `Apache-2.0`, `NOASSERTION` for another licence); null for none. */
  licence: optionalServerText(),
  archived: z.boolean().catch(false),
  pushed_at: optionalServerText(),
}).nullable().catch(null)

/** A fork connection's upstream and its owner (whose fork and pull requests these are). */
const ForkFactsSchema = z.object({
  upstream: z.string().min(1),
  upstream_connection: optionalServerText(),
  upstream_default_branch: z.string().catch('main'),
  /** The person who made the fork connection (their name). */
  owner: z.string().catch(''),
  owned_by_me: z.boolean().catch(false),
  /** The upstream's licence (SPDX) its owner acknowledged; null for none. */
  licence: optionalServerText(),
  /** The fork's account on GitHub (a person's login or an organization's), and its kind. */
  account: z.string().catch(''),
  account_type: z.string().catch(''),
}).nullable().catch(null)

export type ForkFacts = NonNullable<z.output<typeof ForkFactsSchema>>

const ConnectionSchema = z.object({
  connection_id: z.string().min(1),
  host: z.enum(CONNECTION_HOSTS).catch('github'),
  repository: z.string().min(1),
  default_branch: z.string().catch('main'),
  credential: CredentialStateSchema,
  created_at: optionalServerText(),
  created_by: optionalServerText(),
  updated_at: optionalServerText(),
  updated_by: optionalServerText(),
  /** The connection's version: what an attestation names as the one reviewed (any change of the connection moves it). */
  version: z.number().int().catch(0),
  /** None yet (null), or its newest version; an answer the page cannot read is none, so it never shows a made-up one. */
  ci_attestation: CiAttestationSchema.nullable().catch(null),
  /** Whether GitHub said the repository is private when an App's installation saved it; null when not known. */
  repository_private: z.boolean().nullable().catch(null),
  /** (7.57.00) What the connection is; a row stored before it is a `repository`. */
  kind: z.enum(CONNECTION_KINDS).catch('repository'),
  public: PublicFactsSchema.optional().transform((facts) => facts ?? null),
  fork: ForkFactsSchema.optional().transform((facts) => facts ?? null),
})

export type EngineeringConnection = z.output<typeof ConnectionSchema>

/** A connection as the server answered it, or null when it cannot be read (never shown with made-up fields). */
export function parseConnection(raw: unknown): EngineeringConnection | null {
  const parsed = ConnectionSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** A read-only connection to a public repository (7.57.00): nothing is ever written to it, so no CI to attest. */
export const isPublicRead = (connection: EngineeringConnection): boolean => connection.kind === 'public_read'

/** (7.60.00) A connection whose final push and pull request go with a person's fine-grained token. */
export const isTokenConnection = (connection: EngineeringConnection): boolean => connection.kind === 'fine_grained'

/** Whether the connection's newest version is an attestation that holds (the only state the broker serves). */
export const isCiAttested = (connection: EngineeringConnection): boolean => connection.ci_attestation?.state === 'attested'

export interface ConnectionList {
  connections: EngineeringConnection[]
  limit: number
}

/** The credential a save sends (a GitHub App's, a GitLab token): never read back, never kept but in the request. */
interface AppCredentialInput {
  app_id: string
  installation_id: string
  private_key: string
}

interface TokenCredentialInput {
  token: string
}

interface ConnectionFields {
  repository: string
  default_branch: string
  /** Why the change is made (kept with the connection's audit row); left out when none. */
  reason?: string
}

/** A save; its credential left out to keep the stored one (the host, the repository and the App's ids unchanged). */
export type ConnectionRequest =
  | (ConnectionFields & { host: 'github'; credential?: AppCredentialInput })
  | (ConnectionFields & { host: 'gitlab'; credential?: TokenCredentialInput })

export interface SavedConnection {
  connection: EngineeringConnection
  created: boolean
}

/**
 * A list answer's `key` items, each read by `schema` (one it cannot read is left out), and its `limit` (`fallback` when
 * it gives none): the connections' and the GitHub Apps' (githubAppsApi.ts). An answer with no list is an error
 * (`message`), never an empty list.
 */
export function parseLimitedList<T>(
  raw: unknown, key: string, schema: z.ZodType<T>, fallback: number, message: string,
): { items: T[]; limit: number } {
  const list = isRecord(raw) ? raw[key] : undefined
  if (!isRecord(raw) || !Array.isArray(list)) throw new Error(message)
  const limit = typeof raw.limit === 'number' && raw.limit > 0 ? raw.limit : fallback
  return { items: parseEach(schema, list), limit }
}

/** The list as the server answered it; an answer with no list is an error. */
function parseConnectionList(raw: unknown): ConnectionList {
  const { items, limit } = parseLimitedList(raw, 'connections', ConnectionSchema, DEFAULT_CONNECTION_LIMIT,
    'The connections answer was unreadable')
  return { connections: items, limit }
}

/** A save's answer: the connection as stored (its credential's state only). */
function parseSavedConnection(raw: unknown): SavedConnection {
  if (!isRecord(raw)) throw new Error('The saved connection was unreadable')
  const connection = ConnectionSchema.safeParse(raw.connection)
  if (!connection.success) throw new Error('The saved connection was unreadable')
  return { connection: connection.data, created: raw.created === true }
}

export interface RecordedAttestation {
  attestation: CiAttestation
  /** The connection's version after it (a recorded attestation moves it). */
  connectionVersion: number
}

/** An attestation's answer: the version that holds (just recorded, or already there), and the connection's version. */
function parseAttestation(raw: unknown): RecordedAttestation {
  const attestation = isRecord(raw) ? CiAttestationSchema.safeParse(raw.attestation) : null
  if (attestation?.success !== true || !isRecord(raw) || typeof raw.connection_version !== 'number') {
    throw new Error('The CI attestation was unreadable')
  }
  return { attestation: attestation.data, connectionVersion: raw.connection_version }
}

/** Where a fork goes (7.57.00): the person's own account (the default), or an organization they administer. */
type ForkDestination = { account: 'user' } | { account: 'organization'; org: string }

/** Contributing, step 2: the destination, the licence acknowledged (its SPDX id), the App, the workspace. */
export type ForkRequest = ForkDestination & { licence: string; app_id?: string; workspace?: string }

/**
 * What step 2 goes to (its answer's `fork_url`, GitHub's own fork page, is step 1's link already, which the card makes
 * from the upstream's name before anything is asked of the server).
 */
export interface ForkLinks {
  /** The App's installation page with a single-use state: installed on the fork, it saves the fork connection. */
  installUrl: string
}

/** (7.58.00) The upstream's current licence acknowledged again by the fork connection's owner (its SPDX id). */
export interface UpstreamLicence {
  licence: string
  reason?: string
}

const GITHUB_PAGES = 'https://github.com/'

function parseForkLinks(raw: unknown): ForkLinks {
  const install = isRecord(raw) ? raw.install_url : undefined
  if (typeof install !== 'string' || !install.startsWith(GITHUB_PAGES)) throw new Error('The fork links were unreadable')
  return { installUrl: install }
}

function parseUpstreamSaved(raw: unknown): EngineeringConnection {
  const connection = isRecord(raw) ? parseConnection(raw.connection) : null
  if (connection === null) throw new Error('The saved connection was unreadable')
  return connection
}

const connectionPath = (connectionId: string) => `/agents/engineering/connections/${encodeURIComponent(connectionId)}`
const attestationPath = (connectionId: string) => `${connectionPath(connectionId)}/ci-attestation`

/** The administrator's reason, sent only when given. */
const withReason = (reason: string) => (reason.trim() === '' ? {} : { reason: reason.trim() })

export const engineeringConnectionsKeys = { list: () => ['engineering-connections'] as const }

export const engineeringConnectionsApi = {
  list: async (): Promise<ConnectionList> => parseConnectionList(await fetchApi<unknown>('/agents/engineering/connections')),
  save: async (connectionId: string, request: ConnectionRequest): Promise<SavedConnection> =>
    parseSavedConnection(await fetchApi<unknown>(connectionPath(connectionId), put(request))),
  remove: async (connectionId: string): Promise<void> => {
    await fetchApi<unknown>(connectionPath(connectionId), del())
  },
  /**
   * Attest that the repository's CI meets every point of the setup guide (all of `CI_POINTS`), for the repository and
   * the connection version the administrator reviewed: the server refuses it (409) once the connection changed.
   */
  attest: async (connection: EngineeringConnection, reason: string): Promise<RecordedAttestation> =>
    parseAttestation(await fetchApi<unknown>(attestationPath(connection.connection_id), post({
      points: [...CI_POINTS], repository: connection.repository, version: connection.version, ...withReason(reason),
    }))),
  /** Withdraw the connection's CI attestation: the agents push nothing on it again until it is attested again. */
  withdraw: async (connectionId: string, reason: string): Promise<void> => {
    await fetchApi<unknown>(attestationPath(connectionId), del(withReason(reason)))
  },
  /**
   * Contributing to a read-only public connection, step 2 (7.57.00): GitHub's fork page and the App's install
   * link (a single-use state). Refused (409) for an archived upstream, one that opts out of bot pull requests, one
   * without a licence, or a licence other than the one acknowledged.
   */
  fork: async (connectionId: string, request: ForkRequest): Promise<ForkLinks> =>
    parseForkLinks(await fetchApi<unknown>(`${connectionPath(connectionId)}/fork`, post(request))),
  /**
   * (7.58.00) Acknowledge the upstream's current licence again, the fork connection's owner's alone (409 for anyone
   * else, or for a licence that is not the upstream's now, saying which it is); the upstream's default branch is
   * refreshed with it.
   */
  acknowledgeLicence: async (connectionId: string, request: UpstreamLicence): Promise<EngineeringConnection> =>
    parseUpstreamSaved(await fetchApi<unknown>(`${connectionPath(connectionId)}/upstream`, put(request))),
}
