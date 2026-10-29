/**
 * @fileoverview The SPA approval boundary of the `participants` pack writes —
 * `create_participant_list` and `add_participants` (docs/participants.md) — and
 * the pure builder their card and executor share, so the card shows exactly
 * who is sent: `uniquePeople` collapses repeats of one address (compared
 * case-insensitively, first row wins).
 *
 * Limits are IDENTICAL to the stream Lambda's
 * (`lambda/stream/src/assistant/tools/client/participant-schemas.ts`) and to
 * what the engagement routes accept; `participantSchemas.lockstep.test.ts`
 * compares all three.
 *
 * @module assistant/approvals/participantSchemas
 */
import { z } from 'zod'
import { LIST_KINDS } from '../../api/participantsSchema'
import { optionalNonEmpty } from './schemas'

export const SPA_PARTICIPANT_LIMITS = {
  // per list
  maxListNameChars: 120, maxListDescriptionChars: 1000,
  // per person
  maxTags: 20, maxTagChars: 40, maxTitleChars: 160, maxCompanyChars: 160, maxNameChars: 160, maxEmailChars: 254,
  // per card
  maxPeople: 200,
} as const

const LOCAL_PART = /^[a-z0-9._%+-]{1,64}$/
const DOMAIN_LABEL = /^[a-z0-9-]{1,63}$/
/** Participant list ids (`lst_` + 16 hex). */
export const LIST_ID_PATTERN = /^lst_[0-9a-f]{16}$/

/** The route's address rule (`ops_alerts.normalize_email`) on the lower-cased address. */
export function isParticipantEmail(value: string): boolean {
  const lower = value.toLowerCase()
  const at = lower.indexOf('@')
  if (at < 0 || lower.includes('@', at + 1)) return false
  const domainLabels = lower.slice(at + 1).split('.')
  return domainLabels.length > 1 && !domainLabels.some((label) => !DOMAIN_LABEL.test(label)) && LOCAL_PART.test(lower.slice(0, at))
}

const L = SPA_PARTICIPANT_LIMITS

const tagArg = z.string().trim().min(1).max(L.maxTagChars)
const emailArg = z.string().trim().max(L.maxEmailChars).refine(isParticipantEmail, 'must be a valid email address')

/** One person row: the email is required, everything else only when the user gave it. */
export const participantPersonArgs = z.strictObject({
  tags: z.array(tagArg).max(L.maxTags).optional(),
  title: optionalNonEmpty(L.maxTitleChars),
  company: optionalNonEmpty(L.maxCompanyChars),
  name: optionalNonEmpty(L.maxNameChars),
  email: emailArg,
})

export const addParticipantsArgs = z.strictObject({
  people: z.array(participantPersonArgs).min(1).max(L.maxPeople),
  list_id: z.string().trim().regex(LIST_ID_PATTERN, 'must be a list_id from list_participant_lists'),
})

export const createParticipantListArgs = z.strictObject({
  name: z.string().trim().min(1).max(L.maxListNameChars),
  kind: z.enum(LIST_KINDS),
  description: optionalNonEmpty(L.maxListDescriptionChars),
})

export type ParticipantPerson = z.infer<typeof participantPersonArgs>
export type AddParticipantsArgs = z.infer<typeof addParticipantsArgs>
export type CreateParticipantListArgs = z.infer<typeof createParticipantListArgs>

/** The rows sent, one per address (first occurrence wins), and how many repeats were dropped. */
export function uniquePeople(people: readonly ParticipantPerson[]): { people: ParticipantPerson[]; duplicates: number } {
  const seen = new Set<string>()
  const unique = people.filter((person) => {
    const key = person.email.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { people: unique, duplicates: people.length - unique.length }
}
