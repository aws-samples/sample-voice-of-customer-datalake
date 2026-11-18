/**
 * @fileoverview Registry → Create from a skill, the form's rules (CreateCardSheet.tsx): what to fix before the card is
 * made, and the body `POST …/registry/cards` takes. The server checks it all again (engineering/registry/cards.py):
 * these only say what to fix first, by field.
 *
 * - The role: one the Registry lists as launchable; the skill version: an ACCEPTED one of that role in the scope
 *   chosen (a proposal never makes a card).
 * - The slug: 1-40 lowercase letters, digits and dashes, not at either end; the card's id is `<role>-<slug>`.
 * - The title (optional, at most 80 characters) and the purpose (required, at most 300): plain text on one line.
 * - Each cap (optional: empty keeps the template's): a whole number above 0 and at most the template's.
 *
 * @module pages/Agents/Registry/createCardRules
 */
import type { CreateCardBody } from '../../../api/engineeringRegistryApi'

export const CARD_LIMITS = { maxTitle: 80, maxPurpose: 300, maxSlug: 40 } as const
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u
const WHOLE = /^[1-9]\d{0,9}$/u
/** Control characters (a line break among them): the server takes printable text only. */
const CONTROL = /\p{Cc}/u

export interface CardForm {
  readonly role: string
  /** '' for the shared skills, else a connection's id. */
  readonly connection: string
  /** The accepted skill version chosen (null: none yet). */
  readonly version: number | null
  readonly slug: string
  readonly title: string
  readonly purpose: string
  /** Each cap as typed ('' keeps the template's). */
  readonly caps: Readonly<Record<string, string>>
}

export type CardField = 'role' | 'version' | 'slug' | 'title' | 'purpose' | `cap:${string}`
type CardIssue =
  | 'role' | 'version' | 'slugMissing' | 'slugShape' | 'titleLong' | 'titleText'
  | 'purposeMissing' | 'purposeLong' | 'purposeText' | 'capShape' | 'capOver'

export interface FieldIssue { readonly field: CardField; readonly issue: CardIssue }

/** The card's id the slug makes (`fixer-careful`). */
export const madeCardId = (role: string, slug: string) => `${role}-${slug.trim()}`

function textIssues(form: CardForm): FieldIssue[] {
  const issues: FieldIssue[] = []
  const title = form.title.trim()
  if (title.length > CARD_LIMITS.maxTitle) issues.push({ field: 'title', issue: 'titleLong' })
  else if (CONTROL.test(title)) issues.push({ field: 'title', issue: 'titleText' })
  const purpose = form.purpose.trim()
  if (purpose === '') issues.push({ field: 'purpose', issue: 'purposeMissing' })
  else if (purpose.length > CARD_LIMITS.maxPurpose) issues.push({ field: 'purpose', issue: 'purposeLong' })
  else if (CONTROL.test(purpose)) issues.push({ field: 'purpose', issue: 'purposeText' })
  return issues
}

function capIssues(caps: CardForm['caps'], template: Readonly<Record<string, number>>): FieldIssue[] {
  return Object.entries(caps).flatMap(([name, typed]): FieldIssue[] => {
    const value = typed.trim()
    if (value === '') return []
    if (!WHOLE.test(value)) return [{ field: `cap:${name}`, issue: 'capShape' }]
    const most = template[name]
    return most !== undefined && Number(value) > most ? [{ field: `cap:${name}`, issue: 'capOver' }] : []
  })
}

/** What to fix before the card is made, in the form's order (none: it may be sent). */
export function cardIssues(form: CardForm, roles: readonly string[], templateCaps: Readonly<Record<string, number>>): FieldIssue[] {
  const issues: FieldIssue[] = []
  if (!roles.includes(form.role)) issues.push({ field: 'role', issue: 'role' })
  if (form.version === null) issues.push({ field: 'version', issue: 'version' })
  const slug = form.slug.trim()
  if (slug === '') issues.push({ field: 'slug', issue: 'slugMissing' })
  else if (!SLUG.test(slug)) issues.push({ field: 'slug', issue: 'slugShape' })
  return [...issues, ...textIssues(form), ...capIssues(form.caps, templateCaps)]
}

/** The body the form sends: the caps typed only (the rest stay the template's), the title only when given. */
export function createCardBody(form: CardForm): CreateCardBody {
  const caps = Object.fromEntries(Object.entries(form.caps)
    .filter(([, typed]) => typed.trim() !== '').map(([name, typed]) => [name, Number(typed.trim())]))
  const title = form.title.trim()
  return {
    from_skill: { role: form.role, ...(form.connection === '' ? {} : { connection: form.connection }), version: form.version ?? 0 },
    slug: form.slug.trim(),
    purpose: form.purpose.trim(),
    ...(title === '' ? {} : { title }),
    ...(Object.keys(caps).length === 0 ? {} : { caps }),
  }
}
