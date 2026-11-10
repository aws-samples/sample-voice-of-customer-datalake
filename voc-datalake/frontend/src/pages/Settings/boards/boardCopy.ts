/**
 * @fileoverview The translation keys of the Boards section's fixed vocabularies (templates,
 * audiences, catalogue fields, draft problems, refusals), held as data so the i18n audit sees them.
 * @module pages/Settings/boards/boardCopy
 */
import { serverReason } from '../../../lib/errors'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import type { BoardTemplate, FieldKey } from '../../../api/boardFields'
import type { AudienceMode } from '../../../api/featureBoardsSchema'
import type { DraftProblem } from './boardDraft'
import type { DescribedCopy } from './DescribedRadios'

export const TEMPLATE_COPY: Readonly<Record<BoardTemplate, DescribedCopy>> = {
  sales: { labelKey: 'settings:boards.templates.sales', descriptionKey: 'settings:boards.templates.salesHint' },
  service: { labelKey: 'settings:boards.templates.service', descriptionKey: 'settings:boards.templates.serviceHint' },
  beta: { labelKey: 'settings:boards.templates.beta', descriptionKey: 'settings:boards.templates.betaHint' },
  blank: { labelKey: 'settings:boards.templates.blank', descriptionKey: 'settings:boards.templates.blankHint' },
}

export const AUDIENCE_COPY: Readonly<Record<AudienceMode, DescribedCopy>> = {
  company: { labelKey: 'settings:boards.audience.company', descriptionKey: 'settings:boards.audience.companyHint' },
  list: { labelKey: 'settings:boards.audience.list', descriptionKey: 'settings:boards.audience.listHint' },
  anyone: { labelKey: 'settings:boards.audience.anyone', descriptionKey: 'settings:boards.audience.anyoneHint' },
}

/** One label per catalogue field key (request- and support-level share them). */
export const FIELD_LABEL_KEYS: Readonly<Record<FieldKey, string>> = {
  customer: 'settings:boards.fields.customer',
  deal: 'settings:boards.fields.deal',
  impact: 'settings:boards.fields.impact',
  amount_usd: 'settings:boards.fields.amount_usd',
  contact_email: 'settings:boards.fields.contact_email',
  kind: 'settings:boards.fields.kind',
  severity: 'settings:boards.fields.severity',
  reference: 'settings:boards.fields.reference',
  steps: 'settings:boards.fields.steps',
  affected_count: 'settings:boards.fields.affected_count',
  area: 'settings:boards.fields.area',
  outcome: 'settings:boards.fields.outcome',
  rating: 'settings:boards.fields.rating',
  link: 'settings:boards.fields.link',
  note: 'settings:boards.fields.note',
}

export const PROBLEM_KEYS: Readonly<Record<DraftProblem, string>> = {
  nameRequired: 'settings:boards.problems.nameRequired',
  slugInvalid: 'settings:boards.problems.slugInvalid',
  statusesEmpty: 'settings:boards.problems.statusesEmpty',
  statusLabelRequired: 'settings:boards.problems.statusLabelRequired',
  emailsInvalid: 'settings:boards.problems.emailsInvalid',
  emailsTooMany: 'settings:boards.problems.emailsTooMany',
  listEmpty: 'settings:boards.problems.listEmpty',
}

/** The API's reason codes (`{success: false, error}`) this section explains in its own words. */
const REASON_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['slug_taken', 'settings:boards.errors.slugTaken'],
  ['status_in_use', 'settings:boards.errors.statusInUse'],
]

const STATUS_KEYS: ReadonlyArray<readonly [number, string]> = [
  [403, 'settings:boards.errors.forbidden'],
  [404, 'settings:boards.errors.notFound'],
  [409, 'settings:boards.errors.conflict'],
]

type Translate = (key: string) => string

/** The sentence for a refused board request: its reason code first, else its status, else a generic one. */
export function boardErrorMessage(error: unknown, t: Translate): string {
  const reason = serverReason(error) ?? ''
  const byReason = REASON_KEYS.find(([code]) => reason.includes(code))
  if (byReason !== undefined) return t(byReason[1])
  const status = apiErrorStatus(error)
  const byStatus = STATUS_KEYS.find(([code]) => code === status)
  return t(byStatus?.[1] ?? 'settings:boards.errors.generic')
}
