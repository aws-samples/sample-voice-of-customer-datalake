/**
 * @fileoverview The engineering agents' repository connections (administrators only): `GET
 * /agents/engineering/connections` lists them, `PUT …/connections/<id>` stores one with its credential, `DELETE
 * …/connections/<id>` removes it and its stored credential.
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
import { del, put } from './requestKit'
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
})

export type EngineeringConnection = z.output<typeof ConnectionSchema>

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

const connectionPath = (connectionId: string) => `/agents/engineering/connections/${encodeURIComponent(connectionId)}`

export const engineeringConnectionsKeys = { list: () => ['engineering-connections'] as const }

export const engineeringConnectionsApi = {
  list: async (): Promise<ConnectionList> => parseConnectionList(await fetchApi<unknown>('/agents/engineering/connections')),
  save: async (connectionId: string, request: ConnectionRequest): Promise<SavedConnection> =>
    parseSavedConnection(await fetchApi<unknown>(connectionPath(connectionId), put(request))),
  remove: async (connectionId: string): Promise<void> => {
    await fetchApi<unknown>(connectionPath(connectionId), del())
  },
}
