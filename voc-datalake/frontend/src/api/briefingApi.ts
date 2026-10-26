/**
 * @fileoverview The morning brief (docs/briefing.md): the caller's own preferences, their
 * newest brief, Refresh and per-card state. All under `/settings/my-briefing` (self only).
 * Every answer is normalised through a lenient schema: a malformed field costs itself.
 * @module api/briefingApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { lenientText, optionalText, parsedList } from './schemaList'
import { isSupportedLanguage, supportedLanguages } from '../i18n/languages'

const EMAIL_STATUSES = ['off', 'pending', 'confirmed'] as const
/** `ui` = the brief follows the app's language; `chosen` = picked in the brief settings (it wins). */
const LANGUAGE_SOURCES = ['ui', 'chosen'] as const
const BRIEF_STATUSES = ['none', 'pending', 'ready', 'failed'] as const
const SEVERITIES = ['info', 'warn', 'alert'] as const
export type BriefSeverity = typeof SEVERITIES[number]
const CARD_STATES = ['seen', 'dismissed', 'acted'] as const
export type CardState = typeof CARD_STATES[number]
export const MAX_INSTRUCTIONS_CHARS = 2000

const PreferencesSchema = z.object({
  enabled: z.boolean().catch(false),
  hour: z.number().int().min(0).max(23).catch(8),
  time_zone: z.string().min(1).catch('UTC'),
  // The UI languages; shared/briefing_prefs.py LANGUAGES is lockstepped to the same file.
  language: z.enum(supportedLanguages).catch('en'),
  // A row without a source follows the app (docs/briefing.md → "Which language").
  language_source: z.enum(LANGUAGE_SOURCES).catch('ui'),
  instructions: lenientText,
  email: z.boolean().catch(false),
  email_status: z.enum(EMAIL_STATUSES).catch('off'),
  updated_at: optionalText,
})
export type BriefPreferences = z.output<typeof PreferencesSchema>
export const DEFAULT_PREFERENCES: BriefPreferences = PreferencesSchema.parse({})

/** A PUT names only what it changes. */
export type BriefPreferenceChanges = Partial<Pick<BriefPreferences,
  'enabled' | 'hour' | 'time_zone' | 'language' | 'language_source' | 'instructions' | 'email'>>

const ActionSchema = z.object({ label: z.string().min(1), prompt: z.string().min(1) })

const CardSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  layer: z.enum(['org', 'personal']).catch('org'),
  severity: z.enum(SEVERITIES).catch('info'),
  title: lenientText,
  body: lenientText,
  facts: z.record(z.string(), z.unknown()).catch({}),
  actions: parsedList(ActionSchema),
  feedback_ids: parsedList(z.string()),
  urls: parsedList(z.string()),
})
export type BriefCard = z.output<typeof CardSchema>

const CardStateMapSchema = z.record(z.string(), z.enum(CARD_STATES).catch('seen')).catch({})

const BriefSchema = z.object({
  status: z.enum(BRIEF_STATUSES).catch('none'),
  day: optionalText,
  generated_at: optionalText,
  requested_at: optionalText,
  headline: lenientText,
  summary: lenientText,
  language: optionalText,
  cards: parsedList(CardSchema),
  card_state: CardStateMapSchema,
})
export type Brief = z.output<typeof BriefSchema>
export const NO_BRIEF: Brief = BriefSchema.parse({})

const RefreshSchema = z.object({
  status: z.enum(['up_to_date', 'pending']).catch('pending'),
  brief: BriefSchema.catch(NO_BRIEF),
})
export type RefreshResult = z.output<typeof RefreshSchema>

const CardStatesResultSchema = z.object({ day: optionalText, card_state: CardStateMapSchema })

function parsedOr<S extends z.ZodType>(schema: S, raw: unknown, fallback: z.output<S>): z.output<S> {
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : fallback
}

export const briefPreferencesKey = () => ['settings', 'my-briefing'] as const
export const briefKey = () => ['settings', 'my-briefing', 'brief'] as const

const PATH = '/settings/my-briefing'
const BRIEF_PATH = '/settings/my-briefing/brief'
const REFRESH_PATH = '/settings/my-briefing/refresh'
const CARDS_PATH = '/settings/my-briefing/cards'

/** The refresh body `{language}`, only when the UI language is one the brief supports. */
function refreshBody(uiLanguage: string | undefined): Pick<RequestInit, 'body'> {
  return uiLanguage !== undefined && isSupportedLanguage(uiLanguage) ? { body: JSON.stringify({ language: uiLanguage }) } : {}
}

export const briefingApi = {
  getPreferences: async (): Promise<BriefPreferences> =>
    parsedOr(PreferencesSchema, await fetchApi<unknown>(PATH), DEFAULT_PREFERENCES),
  savePreferences: async (changes: BriefPreferenceChanges): Promise<BriefPreferences> =>
    parsedOr(PreferencesSchema, await fetchApi<unknown>(PATH, { method: 'PUT', body: JSON.stringify(changes) }),
      DEFAULT_PREFERENCES),
  getBrief: async (): Promise<Brief> => parsedOr(BriefSchema, await fetchApi<unknown>(BRIEF_PATH), NO_BRIEF),
  /** `uiLanguage` = the language the reader uses the app in; the brief follows it unless they chose one. */
  refresh: async (uiLanguage?: string): Promise<RefreshResult> =>
    parsedOr(RefreshSchema, await fetchApi<unknown>(REFRESH_PATH, { method: 'POST', ...refreshBody(uiLanguage) }),
      { status: 'pending', brief: NO_BRIEF }),
  setCardStates: async (day: string, states: Record<string, CardState>): Promise<Record<string, CardState>> =>
    parsedOr(CardStatesResultSchema, await fetchApi<unknown>(CARDS_PATH, {
      method: 'PUT', body: JSON.stringify({ day, states }),
    }), { day: undefined, card_state: {} }).card_state,
}
