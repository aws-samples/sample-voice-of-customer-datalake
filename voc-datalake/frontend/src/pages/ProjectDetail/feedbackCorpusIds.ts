/**
 * @fileoverview The ids a corpus list shows (#236): `input_feedback_ids` as stored, cleaned.
 * @module pages/ProjectDetail/feedbackCorpusIds
 */

/** The backend's cap (`MAX_INPUT_FEEDBACK_IDS` in lambda/shared/feedback_sampling.py). */
const MAX_CORPUS_IDS = 500

/** The distinct, non-empty ids in their stored (prompt) order, capped. */
export function corpusIds(ids: readonly string[] | undefined): readonly string[] {
  return [...new Set((ids ?? []).filter((id) => id !== ''))].slice(0, MAX_CORPUS_IDS)
}
