/**
 * @fileoverview REST client for assistant sessions on the ChatApi Lambda's
 * `/chat/conversations/{proxy+}` routes (per Cognito user, server-scoped).
 *
 * @module assistant/sessions/sessionsApi
 */
import { del, post, put } from '../../api/requestKit'
import { z } from 'zod'
import { fetchApi } from '../../api/client'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import {
  isValidSessionId, normalizeSessionList, normalizeSessionRecord,
} from './schema'
import { dropOldestTurns } from './serialize'
import type { SessionRecord, SessionSummary } from './schema'
import type { SaveSessionBody } from './serialize'

const NOT_FOUND = 404
const PAYLOAD_TOO_LARGE = 413

function sessionPath(id: string): string {
  if (!isValidSessionId(id)) throw new Error('Invalid session id')
  return `/chat/conversations/${encodeURIComponent(id)}`
}

export async function listSessions(): Promise<SessionSummary[]> {
  return normalizeSessionList(await fetchApi<unknown>('/chat/conversations/_list?kind=assistant'))
}

/**
 * One stored session, or `null` when it does not exist. The route answers a
 * conversation that was deleted (in this tab, another tab or another browser)
 * with 404: that is a settled answer, not a failure, so it resolves to `null`
 * like a malformed record and every caller forgets the id — the restore on
 * page load drops a stale remembered id instead of asking for it on every load.
 * Any other failure (network, 5xx, throttling) still rejects.
 */
export async function getSession(id: string): Promise<SessionRecord | null> {
  try {
    return normalizeSessionRecord(await fetchApi<unknown>(sessionPath(id)))
  } catch (error) {
    if (apiErrorStatus(error) === NOT_FOUND) return null
    throw error
  }
}

function postSession(body: SaveSessionBody): Promise<unknown> {
  return fetchApi<unknown>(sessionPath(body.id), post(body))
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
  await fetchApi<unknown>(sessionPath(id), del())
}

const renamedSchema = z.object({ title: z.string().min(1) })

/**
 * Rename a saved conversation (`PUT /chat/conversations/{id}/title`). Every
 * later save keeps the name. Answers the stored title; 409 while a reply is
 * still being generated for it.
 */
export async function renameSession(id: string, title: string): Promise<string> {
  const raw = await fetchApi<unknown>(`${sessionPath(id)}/title`, put({ title }))
  const parsed = renamedSchema.safeParse(raw)
  return parsed.success ? parsed.data.title : title
}

/**
 * Stop the server's run `runId` of a conversation (`POST /chat/conversations/{id}/cancel`). The
 * browser's abort does not reach the stream Lambda, which keeps generating without a client;
 * this marker is what it polls, so it stops and saves the partial answer as `stopped`.
 */
export async function cancelServerRun(id: string, runId: string): Promise<void> {
  await fetchApi<unknown>(`${sessionPath(id)}/cancel`, post({ runId }))
}
