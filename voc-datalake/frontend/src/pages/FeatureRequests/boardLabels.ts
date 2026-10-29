/**
 * @fileoverview Every translation key the board picks by a VALUE (a status, a field, a choice, a
 * template, a sort, a sign-in failure, a field error), held as `…Key: 'featureRequests:…'` data so
 * the i18n audit (`scripts/i18n-check.mjs`, data-held keys) sees each one and fails when one goes
 * missing. The records over closed enums are exhaustive, so a new value does not compile without
 * its label.
 *
 * @module pages/FeatureRequests/boardLabels
 */
import type { BoardTemplate, DescriptionRequiredTemplate, FieldErrorCode, FieldKey } from '../../api/boardFields'
import type { AudienceMode } from '../../api/featureBoardsSchema'
import type { SupportImpact } from '../../api/featureRequestsApi'
import type { BoardAuthErrorCode } from '../../services/boardCognito'
import type { RequestSort } from './boardFormat'

/** The templates' default status keys; an admin's own status shows its own label instead. */
export const STATUS_LABELS: Readonly<Record<string, { labelKey: string } | undefined>> = {
  new: { labelKey: 'featureRequests:status.new' },
  under_review: { labelKey: 'featureRequests:status.under_review' },
  planned: { labelKey: 'featureRequests:status.planned' },
  declined: { labelKey: 'featureRequests:status.declined' },
  shipped: { labelKey: 'featureRequests:status.shipped' },
  confirmed: { labelKey: 'featureRequests:status.confirmed' },
  fixed: { labelKey: 'featureRequests:status.fixed' },
  wont_fix: { labelKey: 'featureRequests:status.wont_fix' },
  seen: { labelKey: 'featureRequests:status.seen' },
  done: { labelKey: 'featureRequests:status.done' },
}

export const IMPACT_LABELS: Readonly<Record<SupportImpact, { labelKey: string }>> = {
  committed: { labelKey: 'featureRequests:impact.committed' },
  at_risk: { labelKey: 'featureRequests:impact.at_risk' },
  none: { labelKey: 'featureRequests:impact.none' },
}

export const FIELD_LABELS: Readonly<Record<FieldKey, { labelKey: string }>> = {
  customer: { labelKey: 'featureRequests:fields.customer' },
  deal: { labelKey: 'featureRequests:fields.deal' },
  impact: { labelKey: 'featureRequests:fields.impact' },
  amount_usd: { labelKey: 'featureRequests:fields.amount_usd' },
  contact_email: { labelKey: 'featureRequests:fields.contact_email' },
  kind: { labelKey: 'featureRequests:fields.kind' },
  severity: { labelKey: 'featureRequests:fields.severity' },
  reference: { labelKey: 'featureRequests:fields.reference' },
  steps: { labelKey: 'featureRequests:fields.steps' },
  affected_count: { labelKey: 'featureRequests:fields.affected_count' },
  area: { labelKey: 'featureRequests:fields.area' },
  outcome: { labelKey: 'featureRequests:fields.outcome' },
  rating: { labelKey: 'featureRequests:fields.rating' },
  link: { labelKey: 'featureRequests:fields.link' },
  note: { labelKey: 'featureRequests:fields.note' },
}

/** The words of each choice of a choice field (impact has its own record above). */
export const CHOICE_LABELS: Readonly<Record<string, { labelKey: string } | undefined>> = {
  'kind.bug': { labelKey: 'featureRequests:choices.kind.bug' },
  'kind.complaint': { labelKey: 'featureRequests:choices.kind.complaint' },
  'kind.missing_feature': { labelKey: 'featureRequests:choices.kind.missing_feature' },
  'kind.question': { labelKey: 'featureRequests:choices.kind.question' },
  'severity.low': { labelKey: 'featureRequests:choices.severity.low' },
  'severity.medium': { labelKey: 'featureRequests:choices.severity.medium' },
  'severity.high': { labelKey: 'featureRequests:choices.severity.high' },
  'severity.critical': { labelKey: 'featureRequests:choices.severity.critical' },
  'outcome.works': { labelKey: 'featureRequests:choices.outcome.works' },
  'outcome.broken': { labelKey: 'featureRequests:choices.outcome.broken' },
  'outcome.confusing': { labelKey: 'featureRequests:choices.outcome.confusing' },
  'impact.committed': IMPACT_LABELS.committed,
  'impact.at_risk': IMPACT_LABELS.at_risk,
  'impact.none': IMPACT_LABELS.none,
}

export const FIELD_ERROR_LABELS: Readonly<Record<FieldErrorCode, { messageKey: string }>> = {
  required: { messageKey: 'featureRequests:form.fieldErrors.required' },
  too_long: { messageKey: 'featureRequests:form.fieldErrors.too_long' },
  invalid_choice: { messageKey: 'featureRequests:form.fieldErrors.invalid_choice' },
  invalid_number: { messageKey: 'featureRequests:form.fieldErrors.invalid_number' },
  out_of_range: { messageKey: 'featureRequests:form.fieldErrors.out_of_range' },
  invalid_email: { messageKey: 'featureRequests:form.fieldErrors.invalid_email' },
  invalid_url: { messageKey: 'featureRequests:form.fieldErrors.invalid_url' },
}

export const TEMPLATE_LABELS: Readonly<Record<BoardTemplate, { labelKey: string }>> = {
  sales: { labelKey: 'featureRequests:templates.sales' },
  service: { labelKey: 'featureRequests:templates.service' },
  beta: { labelKey: 'featureRequests:templates.beta' },
  blank: { labelKey: 'featureRequests:templates.blank' },
}

/** "+1" in each template's words (a service +1 says "affected too"). */
export const PLUS_ONE_LABELS: Readonly<Record<BoardTemplate, { labelKey: string }>> = {
  sales: { labelKey: 'featureRequests:detail.plusOne' },
  service: { labelKey: 'featureRequests:detail.plusOneService' },
  beta: { labelKey: 'featureRequests:detail.plusOneOther' },
  blank: { labelKey: 'featureRequests:detail.plusOneOther' },
}

export const AUDIENCE_LABELS: Readonly<Record<AudienceMode, { labelKey: string }>> = {
  company: { labelKey: 'featureRequests:boards.audience.company' },
  list: { labelKey: 'featureRequests:boards.audience.list' },
  anyone: { labelKey: 'featureRequests:boards.audience.anyone' },
}

export const SORT_LABELS: Readonly<Record<RequestSort, { labelKey: string }>> = {
  newest: { labelKey: 'featureRequests:list.sort.newest' },
  committed: { labelKey: 'featureRequests:list.sort.committed' },
  at_risk: { labelKey: 'featureRequests:list.sort.at_risk' },
  supporters: { labelKey: 'featureRequests:list.sort.supporters' },
  affected: { labelKey: 'featureRequests:list.sort.people_affected' },
  rating: { labelKey: 'featureRequests:list.sort.rating' },
}

export const AUTH_ERROR_LABELS: Readonly<Record<BoardAuthErrorCode, { messageKey: string }>> = {
  domain_not_allowed: { messageKey: 'featureRequests:auth.errors.domain_not_allowed' },
  wrong_code: { messageKey: 'featureRequests:auth.errors.wrong_code' },
  expired: { messageKey: 'featureRequests:auth.errors.expired' },
  too_many: { messageKey: 'featureRequests:auth.errors.tooManyAttempts' },
  no_session: { messageKey: 'featureRequests:auth.errors.no_session' },
  invalid_email: { messageKey: 'featureRequests:auth.errors.invalid_email' },
  unknown: { messageKey: 'featureRequests:auth.errors.unknown' },
}

/** Why promote skipped an email (the API's `reason`); an unknown reason is shown as sent. */
export const SKIP_REASON_LABELS: Readonly<Record<string, { labelKey: string } | undefined>> = {
  external_not_allowed: { labelKey: 'featureRequests:promote.reasons.external_not_allowed' },
  invalid_email: { labelKey: 'featureRequests:promote.reasons.invalid_email' },
  unsubscribed: { labelKey: 'featureRequests:promote.reasons.unsubscribed' },
}

/** Field and request errors, by name. */
export const FORM_ERRORS = {
  title: { messageKey: 'featureRequests:form.errors.titleRequired' },
  customer: { messageKey: 'featureRequests:form.errors.customerRequired' },
  name: { messageKey: 'featureRequests:form.errors.nameRequired' },
  amountRequired: { messageKey: 'featureRequests:form.errors.amountRequired' },
  amountTooLarge: { messageKey: 'featureRequests:form.errors.amountTooLarge' },
  contactEmail: { messageKey: 'featureRequests:form.errors.contactEmail' },
} as const

/** The hint under a request's description, per board template (what that board asks for). */
export const DESCRIPTION_HINTS: Readonly<Record<BoardTemplate, { messageKey: string }>> = {
  sales: { messageKey: 'featureRequests:form.descriptionHint.sales' },
  service: { messageKey: 'featureRequests:form.descriptionHint.service' },
  beta: { messageKey: 'featureRequests:form.descriptionHint.beta' },
  blank: { messageKey: 'featureRequests:form.descriptionHint.blank' },
}

/** The sentence an empty description is refused with, on the templates that require one. */
export const DESCRIPTION_REQUIRED_ERRORS: Readonly<Record<DescriptionRequiredTemplate, { messageKey: string }>> = {
  sales: { messageKey: 'featureRequests:form.errors.descriptionRequired' },
  service: { messageKey: 'featureRequests:form.errors.descriptionRequiredService' },
}

/** Write failures by HTTP status, for `messageKeyForStatus`. */
export const WRITE_ERRORS = [
  { status: 403, messageKey: 'featureRequests:errors.forbidden' },
  { status: 404, messageKey: 'featureRequests:errors.notFound' },
  { status: 409, messageKey: 'featureRequests:errors.conflict' },
  { status: 429, messageKey: 'featureRequests:errors.throttled' },
] as const
export const GENERIC_WRITE_ERROR = { messageKey: 'featureRequests:errors.generic' } as const
/** 429 `rate_limited`: the board's own daily cap per poster (not the gateway's throttle). */
export const RATE_LIMITED_ERROR = { messageKey: 'featureRequests:errors.rateLimited' } as const
/** 409 codes a board write can answer, in words. */
export const CONFLICT_CODE_ERRORS: Readonly<Record<string, { messageKey: string } | undefined>> = {
  slug_taken: { messageKey: 'featureRequests:errors.slugTaken' },
  board_not_empty: { messageKey: 'featureRequests:errors.boardNotEmpty' },
  status_in_use: { messageKey: 'featureRequests:errors.statusInUse' },
  already_supported: { messageKey: 'featureRequests:errors.alreadySupported' },
}
