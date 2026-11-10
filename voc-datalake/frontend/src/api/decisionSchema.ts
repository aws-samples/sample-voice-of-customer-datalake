/**
 * @fileoverview Decision records: a project document of type `decision`, read
 * leniently at the boundary (`lambda/shared/decision_records.py`).
 *
 * A document is a decision only when its `document_type` is `decision` AND its
 * verdict is one of the three known verdicts; anything else stays an ordinary
 * document. Every other field degrades to an empty value rather than throwing.
 *
 * @module api/decisionSchema
 */
import { z } from 'zod'

export const VERDICTS = ['pursue', 'park', 'reject'] as const
export type Verdict = typeof VERDICTS[number]

const text = z.string().catch('')
const nullableText = z.string().nullable().catch(null)
const ids = z.array(z.string()).catch([]).transform((values) => values.filter((v) => v !== ''))

const DecisionFieldsSchema = z.looseObject({
  verdict: z.enum(VERDICTS),
  rationale: text,
  success_metric: text,
  kill_criterion: text,
  evidence: z.object({ feedback_ids: ids, document_ids: ids }).catch({ feedback_ids: [], document_ids: [] }),
  review_by: nullableText,
  launched_at: nullableText,
  decided_by_name: text,
  decided_at: text,
})

const DecisionDocumentSchema = z.looseObject({
  document_id: z.string().min(1),
  document_type: z.literal('decision'),
  title: text,
  revision: z.number().int().positive().catch(1),
  created_at: text,
  decision: DecisionFieldsSchema,
  seeded_prfaq_job_id: nullableText.optional().transform((value) => value ?? null),
})

export interface Decision {
  documentId: string
  title: string
  verdict: Verdict
  rationale: string
  successMetric: string
  killCriterion: string
  feedbackIds: string[]
  documentIds: string[]
  reviewBy: string | null
  launchedAt: string | null
  decidedByName: string
  decidedAt: string
  revision: number
  seededPrfaqJobId: string | null
}

/** The decision a project document records, or null for any other document. */
export function decisionFromDocument(raw: unknown): Decision | null {
  const parsed = DecisionDocumentSchema.safeParse(raw)
  if (!parsed.success) return null
  const { decision } = parsed.data
  return {
    documentId: parsed.data.document_id,
    title: parsed.data.title,
    verdict: decision.verdict,
    rationale: decision.rationale,
    successMetric: decision.success_metric,
    killCriterion: decision.kill_criterion,
    feedbackIds: decision.evidence.feedback_ids,
    documentIds: decision.evidence.document_ids,
    reviewBy: decision.review_by,
    launchedAt: decision.launched_at,
    decidedByName: decision.decided_by_name,
    decidedAt: decision.decided_at || parsed.data.created_at,
    revision: parsed.data.revision,
    seededPrfaqJobId: parsed.data.seeded_prfaq_job_id,
  }
}

/** Every decision among `documents`, the most recently decided first. */
export function decisionsOf(documents: readonly unknown[]): Decision[] {
  const decisions = documents
    .map(decisionFromDocument)
    .filter((d): d is Decision => d !== null)
  return [...decisions].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
}

export function isVerdict(value: unknown): value is Verdict {
  return VERDICTS.some((verdict) => verdict === value)
}
