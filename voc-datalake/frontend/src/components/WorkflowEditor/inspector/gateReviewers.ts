/**
 * @fileoverview A quality gate's reviewers (7.52.00 C2): its own list (`params.reviewers`), else the three it runs
 * when it names none, each blocking or advisory, and how one is stored (its advisory written only when it differs
 * from its default), as `engineeringRules.ts` holds them.
 *
 * @module components/WorkflowEditor/inspector/gateReviewers
 */
import { isRecord } from '../../../lib/typeGuards'

export interface Reviewer { readonly name: string; readonly focus?: string; readonly advisory: boolean; readonly model_id?: string }

/** The reviewers a gate runs when it names none, each with whether it is advisory (engineeringRules.ts's). */
const DEFAULT_REVIEWERS: readonly Reviewer[] = [
  { name: 'security', advisory: false }, { name: 'quality', advisory: false }, { name: 'first-principles', advisory: true },
]
export const DEFAULT_ADVISORY: Readonly<Record<string, boolean>> = { security: false, quality: false, 'first-principles': true }
export const REVIEWER_NAME = /^[a-z][a-z0-9-]{0,39}$/

/** A gate's reviewers as it runs them (its own list, else the default three). */
export function reviewersOf(params: Readonly<Record<string, unknown>>): Reviewer[] {
  const raw = params.reviewers
  if (!Array.isArray(raw)) return [...DEFAULT_REVIEWERS]
  return raw.flatMap((item: unknown) => {
    if (!isRecord(item) || typeof item.name !== 'string') return []
    return [{
      name: item.name,
      advisory: typeof item.advisory === 'boolean' ? item.advisory : DEFAULT_ADVISORY[item.name] ?? false,
      ...(typeof item.focus === 'string' ? { focus: item.focus } : {}),
      ...(typeof item.model_id === 'string' ? { model_id: item.model_id } : {}),
    }]
  })
}

/** What a reviewer is saved as (its advisory written only when it differs from its default). */
export const stored = (reviewer: Reviewer): Record<string, unknown> => ({
  name: reviewer.name,
  ...(reviewer.focus === undefined ? {} : { focus: reviewer.focus }),
  ...(reviewer.model_id === undefined ? {} : { model_id: reviewer.model_id }),
  ...(reviewer.advisory === (DEFAULT_ADVISORY[reviewer.name] ?? false) ? {} : { advisory: reviewer.advisory }),
})

