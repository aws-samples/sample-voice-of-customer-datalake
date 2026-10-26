/**
 * @fileoverview The decision editor's draft: from a stored decision, from a deep link,
 * and to the request body. Pure functions, so the form component stays a view.
 * @module pages/ProjectDetail/decisions/decisionDraft
 */
import { isVerdict } from '../../../api/decisionSchema'
import type { Decision, Verdict } from '../../../api/decisionSchema'
import type { DecisionInput } from '../../../api/decisionsApi'

export interface DecisionDraft {
  title: string
  verdict: Verdict
  rationale: string
  successMetric: string
  killCriterion: string
  /** Free text: ids separated by spaces or commas. */
  feedbackIds: string
  documentIds: string[]
  reviewBy: string
  launchedAt: string
}

export const EMPTY_DRAFT: DecisionDraft = Object.freeze({
  title: '', verdict: 'pursue', rationale: '', successMetric: '', killCriterion: '',
  feedbackIds: '', documentIds: [], reviewBy: '', launchedAt: '',
})

/** The query parameter that opens the editor (see `decisionDeepLink`). */
const NEW_DECISION_PARAM = 'newDecision'
/** Every parameter a deep link may carry, so the page can drop them once read. */
export const PREFILL_PARAMS = [NEW_DECISION_PARAM, 'title', 'verdict', 'rationale', 'feedback'] as const

const MAX_PREFILL_TEXT = 4000
const MAX_FEEDBACK_IDS = 50

/** Ids from free text: split on spaces and commas, de-duplicated, order kept. */
export function parseIds(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter((id) => id !== ''))]
}

export function draftFromDecision(decision: Decision): DecisionDraft {
  return {
    title: decision.title,
    verdict: decision.verdict,
    rationale: decision.rationale,
    successMetric: decision.successMetric,
    killCriterion: decision.killCriterion,
    feedbackIds: decision.feedbackIds.join(' '),
    documentIds: decision.documentIds,
    reviewBy: decision.reviewBy ?? '',
    launchedAt: decision.launchedAt ?? '',
  }
}

/** The draft a deep link asks for, or null when the link does not ask for the editor. */
export function draftFromParams(params: URLSearchParams): DecisionDraft | null {
  if (params.get(NEW_DECISION_PARAM) === null) return null
  const text = (name: string) => (params.get(name) ?? '').slice(0, MAX_PREFILL_TEXT)
  const verdict = params.get('verdict')
  return {
    ...EMPTY_DRAFT,
    title: text('title'),
    verdict: isVerdict(verdict) ? verdict : EMPTY_DRAFT.verdict,
    rationale: text('rationale'),
    feedbackIds: parseIds(text('feedback')).slice(0, MAX_FEEDBACK_IDS).join(' '),
  }
}

export function isSubmittable(draft: DecisionDraft): boolean {
  return draft.title.trim() !== '' && draft.rationale.trim() !== ''
}

export function draftToInput(draft: DecisionDraft): DecisionInput {
  return {
    title: draft.title.trim(),
    verdict: draft.verdict,
    rationale: draft.rationale.trim(),
    success_metric: draft.successMetric.trim(),
    kill_criterion: draft.killCriterion.trim(),
    evidence: { feedback_ids: parseIds(draft.feedbackIds), document_ids: draft.documentIds },
    review_by: draft.reviewBy === '' ? null : draft.reviewBy,
    launched_at: draft.launchedAt === '' ? null : draft.launchedAt,
  }
}

interface DecisionPrefill {
  title?: string
  verdict?: Verdict
  rationale?: string
  feedbackIds?: readonly string[]
}

/**
 * The in-app link that opens a project's Decisions tab with a new, prefilled decision.
 * For callers outside the project page (a brief card's "Decide" action): nothing is
 * saved until the user presses Save.
 */
export function decisionDeepLink(projectId: string, prefill: DecisionPrefill = {}): string {
  const params = new URLSearchParams({ tab: 'decisions', [NEW_DECISION_PARAM]: '1' })
  const entries: [string, string | undefined][] = [
    ['title', prefill.title], ['verdict', prefill.verdict], ['rationale', prefill.rationale],
    ['feedback', prefill.feedbackIds?.slice(0, MAX_FEEDBACK_IDS).join(',')],
  ]
  entries.forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, value)
  })
  return `/projects/${encodeURIComponent(projectId)}?${params.toString()}`
}
