/**
 * @fileoverview The built-in `feedback_type` dimension (lambda/shared/feedback_types.py):
 * what kind of feedback a review is, one primary type per review, inferred by the
 * enrichment model on every source.
 *
 * Labels live in `common.json` → `feedbackTypes.<value>`, one-line explanations in
 * `common.json` → `feedbackTypeDescriptions.<value>` (all locales). The keys are held
 * as literal data in `FEEDBACK_TYPE_COPY` so scripts/i18n-check.mjs sees every
 * one (it cannot read a template-literal key).
 *
 * @module api/feedbackTypes
 */

export const FEEDBACK_TYPE_KEY = 'feedback_type'

/** Dimension keys defined in code: shown read-only, never saved by the dimensions editor. */
export const BUILTIN_DIMENSION_KEYS: ReadonlySet<string> = new Set([FEEDBACK_TYPE_KEY])

/** Every value in the backend's order, with its label and description keys. */
const FEEDBACK_TYPE_COPY = {
  bug: { labelKey: 'common:feedbackTypes.bug', descriptionKey: 'common:feedbackTypeDescriptions.bug' },
  service_failure: { labelKey: 'common:feedbackTypes.service_failure', descriptionKey: 'common:feedbackTypeDescriptions.service_failure' },
  feature_request: { labelKey: 'common:feedbackTypes.feature_request', descriptionKey: 'common:feedbackTypeDescriptions.feature_request' },
  usability: { labelKey: 'common:feedbackTypes.usability', descriptionKey: 'common:feedbackTypeDescriptions.usability' },
  performance: { labelKey: 'common:feedbackTypes.performance', descriptionKey: 'common:feedbackTypeDescriptions.performance' },
  pricing_billing: { labelKey: 'common:feedbackTypes.pricing_billing', descriptionKey: 'common:feedbackTypeDescriptions.pricing_billing' },
  support_experience: { labelKey: 'common:feedbackTypes.support_experience', descriptionKey: 'common:feedbackTypeDescriptions.support_experience' },
  praise: { labelKey: 'common:feedbackTypes.praise', descriptionKey: 'common:feedbackTypeDescriptions.praise' },
  question: { labelKey: 'common:feedbackTypes.question', descriptionKey: 'common:feedbackTypeDescriptions.question' },
  other: { labelKey: 'common:feedbackTypes.other', descriptionKey: 'common:feedbackTypeDescriptions.other' },
} as const

type FeedbackType = keyof typeof FEEDBACK_TYPE_COPY

function isFeedbackType(value: string): value is FeedbackType {
  return Object.hasOwn(FEEDBACK_TYPE_COPY, value)
}

/** The copy of a stored value, or undefined when it is not one of the built-in types. */
export function feedbackTypeCopy(value: string): { labelKey: string; descriptionKey: string } | undefined {
  return isFeedbackType(value) ? FEEDBACK_TYPE_COPY[value] : undefined
}
