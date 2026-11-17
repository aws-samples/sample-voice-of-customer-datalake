/**
 * @fileoverview Ways of working with AI, per user (docs/ways-of-working.md).
 *
 * - `human_driven`: the AI answers, explains the method and reviews; it never writes a
 *   PR/FAQ or PRD for the person, unless an admin unlocked that type
 *   (`ai_writing_prfaq` / `ai_writing_prd`).
 * - `ai_assisted`: the AI drafts, suggests and rewrites with the person.
 * - `ai_driven` (the default for documents): plus autonomous agents and plans may write for them.
 *
 * Admins set it with `PUT /users/{username}/flags` (the same route as the other user
 * flags); `GET /users` rows carry `ai_mode`; a person reads their own with
 * `GET /users/me/ai-mode`. The server enforces it (`lambda/shared/ai_writing.py`); the
 * SPA only shapes the editor to match.
 *
 * Since 7.50.02 the block says whether a mode is stored at all (`saved`): with nothing saved
 * documents work AI-driven, but the engineering agents push nothing for the person (their dial
 * takes only an explicitly saved AI-assisted or AI-driven), so the Users page shows "Not set"
 * ({@link readStoredAiMode}) rather than AI-driven.
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

/** A user's way of working as stored: the mode read and whether one is saved (false: `mode` is the default). */
export interface StoredAiMode extends AiMode {
  readonly saved: boolean
}

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

const SavedSchema = z.object({
  mode: z.unknown(),
  /** (an older answer without it: a mode it names counts as saved) */
  saved: z.boolean().catch(true),
})

/**
 * The `ai_mode` block with whether a mode is saved (the Users page): no block, or a block whose mode is
 * not one of {@link AI_MODES}, is not saved.
 */
export function readStoredAiMode(raw: unknown): StoredAiMode {
  const block = CarrierSchema.safeParse(raw).data?.ai_mode
  const stored = SavedSchema.safeParse(block)
  const saved = stored.success && stored.data.saved && AI_MODES.some((name) => name === stored.data.mode)
  return { ...readAiMode(raw), saved }
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
  /**
   * An administrator saves their OWN way of working (7.50.02, `PUT /users/me/ai-mode`: the caller's subject from the
   * token, never another person's; administrators only, as every way-of-working write).
   */
  saveMine: async (mode: AiModeName): Promise<StoredAiMode> =>
    readStoredAiMode(await fetchApi<unknown>('/users/me/ai-mode', put({ ai_mode: mode }))),
}
