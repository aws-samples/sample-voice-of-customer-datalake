/**
 * @fileoverview Reviews a persona or document was written from that were later erased (`erased_evidence`).
 *
 * `voc-retention` (lambda/jobs/retention/lineage.py) removes an erased review's id from an artifact's
 * `input_feedback_ids` / `evidence_feedback_ids` and records `{count, job_id, mode, at}` on it; `count`
 * adds up over erasure runs. The artifact's text is never rewritten and no erased content is kept, so the
 * SPA reads only the count. Lenient at the boundary: anything without a positive whole `count` reads as
 * no mark.
 * @module api/erasedEvidence
 */

import { z } from 'zod'

const ErasedEvidenceSchema = z.object({ count: z.number().int().positive() })

export type ErasedEvidence = z.output<typeof ErasedEvidenceSchema>

/** The boundary field: a usable mark, else undefined (the key stays absent when the row has none). */
export const optionalErasedEvidenceSchema = ErasedEvidenceSchema.optional().catch(undefined)
