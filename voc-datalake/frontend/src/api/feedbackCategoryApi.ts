/**
 * @fileoverview Correcting a review's category — `PUT /feedback/{id}/category`.
 *
 * Shared by the "Change category" control (feedback detail + cards) and the
 * assistant's approved `set_feedback_category` tool, so both write the same way
 * and refresh the same caches. The response is normalized through a lenient Zod
 * schema; the refreshed caches are the source of truth afterwards.
 *
 * Errors keep `fetchApi`'s `API Error: <status>` shape (400 unknown category,
 * 404 not found / not visible, 409 changed concurrently); see
 * {@link categoryChangeErrorKey} for the user-facing reading.
 *
 * @module api/feedbackCategoryApi
 */
import { z } from 'zod'
import { messageKeyForStatus, type StatusMessage } from './apiErrorStatus'
import { fetchApi } from './client'
import { CategoryOverrideSchema } from './feedbackSchema'
import type { QueryClient, QueryKey } from '@tanstack/react-query'

export interface FeedbackCategoryChange {
  category: string
  subcategory?: string
}

const optionalText = z.string().optional().catch(undefined)

const ResponseSchema = z.object({
  feedback: z.object({
    feedback_id: z.string().catch(''),
    category: z.string().catch(''),
    subcategory: optionalText,
    category_source: optionalText,
    category_override: CategoryOverrideSchema.optional().catch(undefined),
  }).optional().catch(undefined),
}).catch({})

export type FeedbackCategoryResult = NonNullable<z.infer<typeof ResponseSchema>['feedback']>

export async function setFeedbackCategory(
  feedbackId: string,
  change: FeedbackCategoryChange,
): Promise<FeedbackCategoryResult | undefined> {
  const body = change.subcategory === undefined || change.subcategory === ''
    ? { category: change.category }
    : { category: change.category, subcategory: change.subcategory }
  const raw = await fetchApi<unknown>(`/feedback/${encodeURIComponent(feedbackId)}/category`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  return ResponseSchema.parse(raw).feedback
}

/**
 * Every cache a category change can move: the item itself, any list or search
 * that shows it, and every metric that buckets by category. Root keys, so each
 * prefix-matches all its parameterized variants (`['feedback', id]`,
 * `['categories', dateParams, source]`, …). Grep the pages for `queryKey` when
 * adding one.
 */
export const CATEGORY_CHANGE_KEYS: readonly QueryKey[] = [
  ['feedback'], ['feedback-similar'], ['feedback-problems'], ['urgent'],
  ['categories-feedback'], ['categories-feedback-search'], ['categories-feedback-urgent'],
  ['data-explorer-feedback'],
  ['summary'], ['categories'], ['sentiment'], ['sources'], ['entities'], ['entities-all-sources'],
]

export async function invalidateAfterCategoryChange(queryClient: QueryClient): Promise<void> {
  await Promise.all(CATEGORY_CHANGE_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}

/**
 * User-facing reading of a failed change, by HTTP status. Held as namespaced
 * `messageKey` table entries so scripts/i18n-check.mjs can see them.
 */
const CHANGE_ERRORS: readonly StatusMessage[] = [
  { status: 400, messageKey: 'components:categoryChange.errors.invalid' },
  { status: 404, messageKey: 'components:categoryChange.errors.notFound' },
  { status: 409, messageKey: 'components:categoryChange.errors.conflict' },
]
const GENERIC_CHANGE_ERROR = { messageKey: 'components:categoryChange.errors.generic' }

/** Namespaced translation key for a failed change. */
export function categoryChangeErrorKey(error: unknown): string {
  return messageKeyForStatus(error, CHANGE_ERRORS, GENERIC_CHANGE_ERROR)
}
