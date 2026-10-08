/**
 * @fileoverview REST client for assistant sessions on the ChatApi Lambda's
 * `/chat/conversations/{proxy+}` routes (per Cognito user, server-scoped).
 *
 * @module assistant/sessions/sessionsApi
 */
import { fetchApi } from '../../api/client'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import {
  isValidSessionId, normalizeSessionList, normalizeSessionRecord,
} from './schema'
import { dropOldestTurns } from './serialize'
import type { SessionRecord, SessionSummary } from './schema'
import type { SaveSessionBody } from './serialize'

const PAYLOAD_TOO_LARGE = 413

function sessionPath(id: string): string {
  if (!isValidSessionId(id)) throw new Error('Invalid session id')
  return `/chat/conversations/${encodeURIComponent(id)}`
}

export async function listSessions(): Promise<SessionSummary[]> {
  return normalizeSessionList(await fetchApi<unknown>('/chat/conversations/_list?kind=assistant'))
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  return normalizeSessionRecord(await fetchApi<unknown>(sessionPath(id)))
}

function postSession(body: SaveSessionBody): Promise<unknown> {
  return fetchApi<unknown>(sessionPath(body.id), { method: 'POST', body: JSON.stringify(body) })
}

/** Save; on 413 drop the oldest turns once and retry. */
export async function saveSession(body: SaveSessionBody): Promise<void> {
  try {
    await postSession(body)
  } catch (error) {
    if (apiErrorStatus(error) !== PAYLOAD_TOO_LARGE) throw error
    await postSession({ ...body, messages: dropOldestTurns(body.messages) })
  }
}

export async function deleteSession(id: string): Promise<void> {
  await fetchApi<unknown>(sessionPath(id), { method: 'DELETE' })
}
