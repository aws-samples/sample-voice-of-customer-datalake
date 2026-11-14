/**
 * @fileoverview The engineering agents' repository connections (administrators only): `GET
 * /agents/engineering/connections` lists them, `PUT …/connections/<id>` stores one with its credential, `DELETE
 * …/connections/<id>` removes it and its stored credential; `POST` / `DELETE …/connections/<id>/ci-attestation`
 * records or withdraws an administrator's attestation that the repository's CI meets the setup guide (the broker
 * refuses every push and pull request on a connection while none holds; a repository change or a removal voids it).
 *
 * The credential, a GitHub App's (its ids and its private key), is write-only: the server stores it in SSM and no
 * answer ever carries the key back; a connection says only whether one is set, and the App's ids. A save sends it to
 * add a connection or to change its repository or App, and leaves it out to keep the stored one. A connection the
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

/** A text the server may leave out: null then, never made up. */
const optionalText = () => z.string().nullable().catch(null)

const CredentialStateSchema = z.object({
  kind: z.literal('app').catch('app'),
  set: z.boolean().catch(false),
  app_id: optionalText(),
  installation_id: optionalText(),
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
  by: optionalText(),
  at: optionalText(),
  reason: optionalText(),
  cause: optionalText(),
})

export type CiAttestation = z.output<typeof CiAttestationSchema>

const ConnectionSchema = z.object({
  connection_id: z.string().min(1),
  host: z.string().catch('github'),
  repository: z.string().min(1),
  default_branch: z.string().catch('main'),
  credential: CredentialStateSchema,
  created_at: optionalText(),
  created_by: optionalText(),
  updated_at: optionalText(),
  updated_by: optionalText(),
  /** The connection's version: what an attestation names as the one reviewed (any change of the connection moves it). */
  version: z.number().int().catch(0),
  /** None yet (null), or its newest version; an answer the page cannot read is none, so it never shows a made-up one. */
  ci_attestation: CiAttestationSchema.nullable().catch(null),
})

export type EngineeringConnection = z.output<typeof ConnectionSchema>

/** Whether the connection's newest version is an attestation that holds (the only state the broker serves). */
export const isCiAttested = (connection: EngineeringConnection): boolean => connection.ci_attestation?.state === 'attested'

export interface ConnectionList {
  connections: EngineeringConnection[]
  limit: number
}

/** The GitHub App credential a save sends: never read back, never kept anywhere but the request. */
interface CredentialInput {
  app_id: string
  installation_id: string
  private_key: string
}

export interface ConnectionRequest {
  host: 'github'
  repository: string
  default_branch: string
  /** Left out to keep the stored credential (the repository and the App's ids unchanged). */
  credential?: CredentialInput
}

export interface SavedConnection {
  connection: EngineeringConnection
  created: boolean
}

/** The list as the server answered it; an answer with no list is an error. */
function parseConnectionList(raw: unknown): ConnectionList {
  if (!isRecord(raw) || !Array.isArray(raw.connections)) throw new Error('The connections answer was unreadable')
  const limit = typeof raw.limit === 'number' && raw.limit > 0 ? raw.limit : DEFAULT_CONNECTION_LIMIT
  return { connections: parseEach(ConnectionSchema, raw.connections), limit }
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
}
