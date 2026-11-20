/**
 * @fileoverview A person's go on an engineering run (`POST /agents/engineering/<run_id>/go`, administrators acting for
 * themselves): what an AI-assisted run's push and pull request wait for, and (7.60.00) every push of a run on a
 * fine-grained token connection, in every way of working, which only the token's owner may give (anyone else: 403
 * with the code `token_owner_go`). Written once: a go already given is answered as it stands (`created: false`).
 *
 * @module api/engineeringGoApi
 */
import { fetchApi } from './client'
import { post } from './requestKit'
import { isRecord } from '../lib/typeGuards'

export interface RunGo {
  /** Given now; false when a go was given already (who gave it and when stay on the server's record). */
  created: boolean
}

/** The refusal of a go from anyone but a token connection's owner. */
export const TOKEN_OWNER_GO = 'token_owner_go'

function parseGo(raw: unknown): RunGo {
  const go = isRecord(raw) ? raw.go : undefined
  if (!isRecord(go) || typeof go.by !== 'string') throw new Error('The go was unreadable')
  return { created: go.created === true }
}

export const engineeringGoApi = {
  give: async (runId: string): Promise<RunGo> =>
    parseGo(await fetchApi<unknown>(`/agents/engineering/${encodeURIComponent(runId)}/go`, post({}))),
}
