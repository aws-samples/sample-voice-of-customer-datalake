/**
 * @fileoverview The board editor's draft, pure: slugs, the audience email list, status keys, the
 * catalogue switches, what is still wrong with a draft, and the PUT body it saves as.
 * @module pages/Settings/boards/boardDraft
 */
import { BOARD_LIMITS, isValidSlug } from '../../../api/boardFields'
import type { BoardFields, BoardStatus, FieldKey, FieldLevel, FieldSwitch } from '../../../api/boardFields'
import type { AudienceMode, BoardPatch, FeatureBoard } from '../../../api/featureBoardsSchema'

const STATUS_KEY_PATTERN = /^[a-z_]{1,30}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

export interface BoardDraft {
  readonly name: string
  readonly slug: string
  readonly description: string
  /** `{request: {key: switch}, support: {...}}`, the API's own shape (api/boardFields.ts). */
  readonly fields: BoardFields
  readonly statuses: readonly BoardStatus[]
  readonly mode: AudienceMode
  readonly domains: readonly string[]
  /** The audience emails as typed (one per line or comma-separated). */
  readonly emailsText: string
}

/** `text` without leading and trailing `char` (by index: an anchored `+` regex backtracks). */
function trimChar(text: string, char: string): string {
  const chars = Array.from(text)
  const start = chars.findIndex((c) => c !== char)
  if (start === -1) return ''
  const fromEnd = [...chars].reverse().findIndex((c) => c !== char)
  return chars.slice(start, chars.length - fromEnd).join('')
}

/** A slug from a name: lower-case ASCII words joined by `-`, at most 60 characters ('' when nothing is left). */
export function slugFromName(name: string): string {
  const words = name.normalize('NFKD').toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim().split(' ')
  return trimChar(words.filter(Boolean).join('-').slice(0, BOARD_LIMITS.slug), '-')
}

/** The share link a slug would have, on the origin of the board's current share link (else this page's). */
export function sharePreview(shareUrl: string, slug: string): string {
  const origin = URL.canParse(shareUrl) ? new URL(shareUrl).origin : window.location.origin
  return `${origin}/board/${slug}`
}

export interface ParsedEmails {
  readonly valid: string[]
  readonly invalid: string[]
}

/** The typed audience emails: lower-cased, de-duplicated, split into valid and invalid entries. */
export function parseEmails(text: string): ParsedEmails {
  const entries = [...new Set(text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean))]
  return {
    valid: entries.filter((entry) => EMAIL_PATTERN.test(entry)),
    invalid: entries.filter((entry) => !EMAIL_PATTERN.test(entry)),
  }
}

/** Status keys allow only `[a-z_]`, so a clash is resolved with a letter suffix (≤ 8 statuses: 26 always suffice). */
const KEY_SUFFIXES = Array.from('abcdefghijklmnopqrstuvwxyz')

/** A key for a new status from its label, unique among `taken` (`status_<letter>` when the label has no ASCII letters). */
export function statusKeyFor(label: string, taken: readonly string[]): string {
  // Two characters stay free for a `_<letter>` suffix.
  const base = trimChar(label.normalize('NFKD').toLowerCase().replaceAll(/[^a-z]+/g, '_'), '_')
    .slice(0, BOARD_LIMITS.statusKey - 2)
  const usable = STATUS_KEY_PATTERN.test(base)
  if (usable && !taken.includes(base)) return base
  const stem = usable ? base : 'status'
  return KEY_SUFFIXES.map((suffix) => `${stem}_${suffix}`).find((key) => !taken.includes(key)) ?? `${stem}_zz`
}

/** Swap the status at `index` with its neighbour `step` (-1 up, 1 down); out of range = unchanged. */
export function moveStatus(statuses: readonly BoardStatus[], index: number, step: -1 | 1): BoardStatus[] {
  const target = index + step
  const next = [...statuses]
  const [from, to] = [next[index], next[target]]
  if (from === undefined || to === undefined) return next
  next[index] = to
  next[target] = from
  return next
}

const OFF: FieldSwitch = { enabled: false, required: false }

export function fieldSetting(draft: BoardDraft, level: FieldLevel, key: FieldKey): FieldSwitch {
  return draft.fields[level][key] ?? OFF
}

/** The fields with one catalogue switch of one level changed; switching a field off also makes it optional. */
export function withFieldSetting(
  fields: BoardFields, level: FieldLevel, key: FieldKey, change: Partial<FieldSwitch>,
): BoardFields {
  const merged = { ...(fields[level][key] ?? OFF), ...change }
  return { ...fields, [level]: { ...fields[level], [key]: merged.enabled ? merged : OFF } }
}

/** An admin reads the full audience; a list the API left out (a non-admin answer) reads as empty. */
export function toDraft(board: FeatureBoard): BoardDraft {
  return {
    name: board.name,
    slug: board.slug,
    description: board.description,
    fields: board.fields,
    statuses: board.statuses,
    mode: board.audience.mode,
    domains: board.audience.domains ?? [],
    emailsText: (board.audience.emails ?? []).join('\n'),
  }
}

export type DraftProblem =
  | 'nameRequired' | 'slugInvalid' | 'statusesEmpty' | 'statusLabelRequired' | 'emailsInvalid' | 'emailsTooMany'
  | 'listEmpty'

function audienceProblems(draft: BoardDraft): DraftProblem[] {
  if (draft.mode !== 'list') return []
  const emails = parseEmails(draft.emailsText)
  const problems: DraftProblem[] = []
  if (emails.invalid.length > 0) problems.push('emailsInvalid')
  if (emails.valid.length > BOARD_LIMITS.emails) problems.push('emailsTooMany')
  if (draft.domains.length === 0 && emails.valid.length === 0) problems.push('listEmpty')
  return problems
}

/** Everything that stops the draft from being saved, in the order the form shows it. */
export function boardDraftProblems(draft: BoardDraft): DraftProblem[] {
  const problems: DraftProblem[] = []
  if (draft.name.trim() === '') problems.push('nameRequired')
  if (!isValidSlug(draft.slug)) problems.push('slugInvalid')
  if (draft.statuses.length === 0) problems.push('statusesEmpty')
  if (draft.statuses.some((status) => status.label.trim() === '')) problems.push('statusLabelRequired')
  return [...problems, ...audienceProblems(draft)]
}

/** The PUT body of a draft (the whole configuration; the server keeps what it does not name). */
export function toChanges(draft: BoardDraft): BoardPatch {
  const listed = draft.mode === 'list'
  return {
    name: draft.name.trim(),
    slug: draft.slug,
    description: draft.description.trim(),
    fields: draft.fields,
    statuses: draft.statuses.map((status) => ({ key: status.key, label: status.label.trim() })),
    audience: {
      mode: draft.mode,
      domains: listed ? [...draft.domains] : [],
      emails: listed ? parseEmails(draft.emailsText).valid : [],
    },
  }
}
