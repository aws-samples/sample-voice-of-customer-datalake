/**
 * @fileoverview Talking to a project's persona by voice (7.69.00, `-c voicePersonas=true`, docs/voice-personas.md),
 * on the projects API's `/projects/{proxy+}` (lambda/shared/voice_session_routes.py):
 *
 * - `GET  /projects/{id}/personas/{pid}/voice-sessions` → the offer the consent dialog reads: whether voice is on,
 *   the persona's voice, the languages the model speaks, the minutes left this month and today's sessions left;
 * - `POST /projects/{id}/personas/{pid}/voice-sessions` `{consent: true, language}` → a session and its presigned
 *   `connect_url` (a `wss://` URL valid 60 s: the browser never holds AWS credentials);
 * - `GET  …/voice-sessions/{sid}` → its status, seconds, cost and, once the transcript is filed, its document;
 * - `POST …/voice-sessions/{sid}/end` → stops it and files the transcript (a `persona_interview` document); sent with
 *   `keepalive` as the page goes away, so the request outlives it;
 * - `GET  /projects/voice/usage` → this month's voice minutes for the deployment (administrators).
 *
 * Every answer is parsed leniently: a field the server drops or a later release adds never breaks the page.
 *
 * @module api/voiceSessionsApi
 */
import { z } from 'zod'
import { VOICE_END_REASONS, VOICE_IDS } from '@stream/voice/protocol'
import { fetchApi } from './client'
import { post } from './requestKit'
import { asRecord } from './wireRecord'

const count = z.number().nonnegative().catch(0)
const languagesSchema = z.object({
  supported: z.array(z.string()).catch([]),
  unsupported: z.array(z.string()).catch([]),
}).catch({ supported: [], unsupported: [] })
const voiceIdSchema = z.enum(VOICE_IDS).catch('tiffany')
const genderSchema = z.enum(['feminine', 'masculine']).catch('feminine')

const offerSchema = z.object({
  enabled: z.boolean().catch(false),
  voice_id: voiceIdSchema,
  voice_gender: genderSchema,
  languages: languagesSchema,
  session_minutes: count,
  minutes_left: count,
  sessions_left_today: count,
  estimated_cents_per_minute: count,
})

export type VoiceOffer = z.infer<typeof offerSchema>

const startedSchema = z.object({
  session_id: z.string().min(1),
  connect_url: z.string().regex(/^wss?:\/\//),
  expires_in: count,
  minutes_left: count,
  session_minutes: count,
  voice_id: voiceIdSchema,
  voice_gender: genderSchema,
  languages: languagesSchema,
  estimated_cents_per_minute: count,
})

export type StartedVoiceSession = z.infer<typeof startedSchema>

const VOICE_SESSION_STATUSES =['minted', 'live', 'ended', 'finalizing', 'finalized', 'failed'] as const

const optionalText = z.string().nullish().catch(null).transform((value) => value ?? null)

const sessionSchema = z.object({
  session_id: z.string().catch(''),
  status: z.enum(VOICE_SESSION_STATUSES).catch('ended'),
  seconds: count,
  cost_cents: count,
  end_reason: z.enum(VOICE_END_REASONS).nullish().catch(null).transform((value) => value ?? null),
  transcript_document_id: optionalText,
  job_id: optionalText,
})

export type VoiceSessionStatus = z.infer<typeof sessionSchema>

const endedSchema = z.object({
  status: z.enum(VOICE_SESSION_STATUSES).catch('finalizing'),
  job_id: optionalText,
})

const usageSchema = z.object({
  enabled: z.boolean().catch(false),
  month: z.string().catch(''),
  minutes_used: count,
  monthly_minutes: count,
  minutes_left: count,
  sessions: count,
  cost_cents: count,
  live_sessions: count,
  max_concurrent: count,
  session_minutes: count,
  daily_sessions: count,
  model_id: z.string().catch(''),
})

export type VoiceUsage = z.infer<typeof usageSchema>

function sessionsPath(projectId: string, personaId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/personas/${encodeURIComponent(personaId)}/voice-sessions`
}

const sessionPath = (projectId: string, personaId: string, sessionId: string): string =>
  `${sessionsPath(projectId, personaId)}/${encodeURIComponent(sessionId)}`

/** The persona's offer (`['voice-offer', …]`), a session's status (`['voice-session', …]`), the month (`['voice-usage']`). */
export const voiceKeys = {
  offer: (projectId: string, personaId: string) => ['voice-offer', projectId, personaId] as const,
  session: (sessionId: string) => ['voice-session', sessionId] as const,
  usage: () => ['voice-usage'] as const,
}

export const voiceSessionsApi = {
  getOffer: async (projectId: string, personaId: string): Promise<VoiceOffer> =>
    offerSchema.parse(asRecord(await fetchApi<unknown>(sessionsPath(projectId, personaId))) ?? {}),

  start: async (projectId: string, personaId: string, language: string): Promise<StartedVoiceSession> =>
    startedSchema.parse(asRecord(await fetchApi<unknown>(sessionsPath(projectId, personaId), post({ consent: true, language }))) ?? {}),

  getSession: async (projectId: string, personaId: string, sessionId: string): Promise<VoiceSessionStatus> =>
    sessionSchema.parse(asRecord(await fetchApi<unknown>(sessionPath(projectId, personaId, sessionId))) ?? {}),

  end: async (projectId: string, personaId: string, sessionId: string, keepalive = false): Promise<z.infer<typeof endedSchema>> =>
    endedSchema.parse(asRecord(await fetchApi<unknown>(`${sessionPath(projectId, personaId, sessionId)}/end`, { method: 'POST', keepalive })) ?? {}),

  getUsage: async (): Promise<VoiceUsage> =>
    usageSchema.parse(asRecord(await fetchApi<unknown>('/projects/voice/usage')) ?? {}),
}
