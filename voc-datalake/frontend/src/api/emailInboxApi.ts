/**
 * @fileoverview The email inbox (`/settings/email-inbox*`, settings Lambda,
 * `lambda/shared/email_intake_settings.py`, docs/email-intake.md): whether it is
 * deployed, its addresses, the daily caps and today's counters. Every route is admin-only.
 *
 * Every response is normalized through a lenient Zod schema: a drifted or missing
 * field reads as "not deployed / zero", never as "on".
 *
 * @module api/emailInboxApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { lenientText, optionalText } from './schemaList'

/** DROP_REASONS / DEDUPE_REASONS in shared/email_intake_settings.py, in display order. */
export const DROP_REASONS = [
  'spam', 'virus', 'auto_reply', 'bulk', 'loop_sender', 'sender_cap', 'no_text', 'unparseable', 'too_large',
] as const
export const DEDUPE_REASONS = ['duplicate_message', 'seen_in_thread', 'no_new_info', 'forward_duplicate'] as const

/** CAP_BOUNDS in shared/email_intake_settings.py. */
export const CAP_BOUNDS = {
  daily_cap: { min: 1, max: 5000 },
  sender_daily_cap: { min: 1, max: 500 },
  daily_model_calls: { min: 0, max: 10000 },
} as const
export type CapKey = keyof typeof CAP_BOUNDS
export const CAP_KEYS: readonly CapKey[] = ['daily_cap', 'sender_daily_cap', 'daily_model_calls']

const count = z.number().int().nonnegative().catch(0)

/** DEFAULT_CAPS in shared/email_intake_settings.py, for an answer that omits one. */
const DEFAULT_CAPS = { daily_cap: 200, sender_daily_cap: 20, daily_model_calls: 400 } as const

const CapsSchema = z.object({
  daily_cap: z.number().int().catch(DEFAULT_CAPS.daily_cap),
  sender_daily_cap: z.number().int().catch(DEFAULT_CAPS.sender_daily_cap),
  daily_model_calls: z.number().int().catch(DEFAULT_CAPS.daily_model_calls),
})
export type EmailInboxCaps = z.output<typeof CapsSchema>

const DroppedSchema = z.object({
  spam: count, virus: count, auto_reply: count, bulk: count, loop_sender: count,
  sender_cap: count, no_text: count, unparseable: count, too_large: count,
})
const DedupedSchema = z.object({
  duplicate_message: count, seen_in_thread: count, no_new_info: count, forward_duplicate: count,
})

const TodaySchema = z.object({
  date: lenientText,
  received: count,
  accepted: count,
  model_calls: count,
  deferred: count,
  dropped: DroppedSchema.catch(DroppedSchema.parse({})),
  deduped: DedupedSchema.catch(DedupedSchema.parse({})),
})
export type EmailInboxToday = z.output<typeof TodaySchema>

const EmailInboxSchema = z.object({
  enabled: z.boolean().catch(false),
  domain: optionalText,
  addresses: z.array(z.string()).catch([]),
  rule_set: optionalText,
  rule_set_needs_activation: z.boolean().catch(false),
  caps: CapsSchema.catch(CapsSchema.parse({})),
  defaults: CapsSchema.catch(CapsSchema.parse({})),
  today: TodaySchema.catch(TodaySchema.parse({})),
  pii: z.enum(['allow', 'redact', 'summary_only']).catch('redact'),
  profile_configured: z.boolean().catch(false),
  feedback_type_dimension: z.boolean().catch(false),
  updated_at: optionalText,
})
export type EmailInboxStatus = z.output<typeof EmailInboxSchema>

export const DEFAULT_EMAIL_INBOX: EmailInboxStatus = EmailInboxSchema.parse({})

export function normalizeEmailInbox(raw: unknown): EmailInboxStatus {
  const parsed = EmailInboxSchema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_EMAIL_INBOX
}

export const emailInboxKey = () => ['settings', 'email-inbox'] as const

const PATH = '/settings/email-inbox'
const DIMENSION_PATH = '/settings/email-inbox/feedback-type-dimension'

export const emailInboxApi = {
  get: async (): Promise<EmailInboxStatus> => normalizeEmailInbox(await fetchApi<unknown>(PATH)),
  saveCaps: async (caps: EmailInboxCaps): Promise<EmailInboxStatus> =>
    normalizeEmailInbox(await fetchApi<unknown>(PATH, { method: 'PUT', body: JSON.stringify(caps) })),
  createFeedbackTypeDimension: () => fetchApi<unknown>(DIMENSION_PATH, { method: 'POST', body: '{}' }),
}
