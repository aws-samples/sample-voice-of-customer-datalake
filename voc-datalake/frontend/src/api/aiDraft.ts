/**
 * @fileoverview The wire shape the document wizard's AI drafts share (`documents/suggest-brief`,
 * `prfaq-autofill`): the feedback selection they ground in, and the caps on the typed text.
 *
 * The caps are the server's (`lambda/shared/draft_intent.py`, over a cap → 400); the wizard's
 * inputs carry them as `maxLength` so a person cannot type past what the route accepts.
 * @module api/aiDraft
 */

/** The wizard's feedback selection; omitted = the project's saved filters. */
export interface AiDraftFilters {
  readonly days: number
  readonly sources: readonly string[]
  readonly categories: readonly string[]
  readonly sentiments: readonly string[]
}

export const AI_DRAFT_LIMITS = {
  title: 200,
  description: 4000,
  answer: 4000,
} as const
