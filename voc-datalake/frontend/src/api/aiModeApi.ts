/**
 * @fileoverview Ways of working with AI, per user (docs/ways-of-working.md).
 *
 * - `human_driven`: the AI answers, explains the method and reviews; it never writes a
 *   PR/FAQ or PRD for the person, unless an admin unlocked that type
 *   (`ai_writing_prfaq` / `ai_writing_prd`).
 * - `ai_assisted`: the AI drafts, suggests and rewrites with the person.
 * - `ai_driven` (the default): plus autonomous agents and plans may write for them.
 *
 * Admins set it with `PUT /users/{username}/flags` (the same route as the other user
 * flags); `GET /users` rows carry `ai_mode`; a person reads their own with
 * `GET /users/me/ai-mode`. The server enforces it (`lambda/shared/ai_writing.py`); the
 * SPA only shapes the editor to match.
 *
 * @module api/aiModeApi
 */
import { z } from 'zod'
import { put } from './requestKit'
import { fetchApi } from './client'

export const AI_MODES = ['human_driven', 'ai_assisted', 'ai_driven'] as const
export type AiModeName = (typeof AI_MODES)[number]

const AiModeSchema = z.object({
  mode: z.enum(AI_MODES).catch('ai_driven'),
  ai_writing_prfaq: z.boolean().catch(false),
  ai_writing_prd: z.boolean().catch(false),
})
export type AiMode = z.output<typeof AiModeSchema>

export const DEFAULT_AI_MODE: AiMode = { mode: 'ai_driven', ai_writing_prfaq: false, ai_writing_prd: false }

/** The fields `PUT /users/{username}/flags` accepts for the way of working. */
export interface AiModePatch {
  ai_mode?: AiModeName
  ai_writing_prfaq?: boolean
  ai_writing_prd?: boolean
}

const CarrierSchema = z.looseObject({ ai_mode: z.unknown().optional() })

/** The `ai_mode` block of a `GET /users` row, `PUT .../flags` or `GET /users/me/ai-mode` answer. */
export function readAiMode(raw: unknown): AiMode {
  const block = CarrierSchema.safeParse(raw).data?.ai_mode
  const parsed = AiModeSchema.safeParse(block)
  return parsed.success ? parsed.data : DEFAULT_AI_MODE
}

/** The document types whose writing the AI's role is restricted for. */
export type GatedDocType = 'prfaq' | 'prd'

export function isGatedDocType(value: unknown): value is GatedDocType {
  return value === 'prfaq' || value === 'prd'
}

/** True when the AI may draft or rewrite `docType` with this person (every other type: always). */
export function aiMayWrite(mode: AiMode, docType: unknown): boolean {
  if (!isGatedDocType(docType) || mode.mode !== 'human_driven') return true
  return docType === 'prfaq' ? mode.ai_writing_prfaq : mode.ai_writing_prd
}

export const aiModeApi = {
  mine: async (): Promise<AiMode> => readAiMode(await fetchApi<unknown>('/users/me/ai-mode')),
  save: async (username: string, patch: AiModePatch): Promise<AiMode> =>
    readAiMode(await fetchApi<unknown>(`/users/${encodeURIComponent(username)}/flags`, put(patch))),
}
