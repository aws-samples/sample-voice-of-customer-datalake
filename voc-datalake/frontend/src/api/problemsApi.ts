/**
 * @fileoverview The Problem Analysis tree, aggregated on the server — `GET /feedback/problems`.
 *
 * The server reads the WHOLE window (slim rows, the caller's scope, the walk budget)
 * and answers category → subcategory → problem with counts, urgent counts, sentiment,
 * a root-cause hypothesis and a few sample review ids per problem — never the reviews
 * themselves (`lambda/shared/problem_aggregation.py`). Ported from PR #429 by
 * @aws-bryan. The response is normalized through a lenient Zod schema at this
 * boundary, so one malformed node degrades instead of blanking the page.
 *
 * @module api/problemsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import type { DateRangeParams } from './client'

/** One problem (similar wordings merged), as the page renders it. */
export interface ProblemGroup {
  problem: string
  /** The first few merged wordings; `similarCount` is how many there are in all. */
  similarProblems: string[]
  similarCount: number
  rootCause: string | null
  /** Reviews with this problem. */
  count: number
  avgSentiment: number
  urgentCount: number
  sentimentCounts: Record<string, number>
  /** A few of its reviews, newest first, for the expanded row. */
  sampleIds: string[]
  resolved?: boolean
}

export interface SubcategoryGroup {
  subcategory: string
  /** The listed problems (the largest, when the server left out a long tail). */
  problems: ProblemGroup[]
  /** Every problem of the subcategory, listed or not. */
  problemCount: number
  totalItems: number
  urgentCount: number
}

export interface CategoryGroup {
  category: string
  subcategories: SubcategoryGroup[]
  totalItems: number
  urgentCount: number
}

export interface ProblemTreeResponse {
  categories: CategoryGroup[]
  /** Subcategories the filter can offer (of the chosen category). */
  subcategories: string[]
  feedbackCount: number
  problemCount: number
  /** Only the largest problems are listed; every count still covers them all. */
  problemsTruncated: boolean
  /** The window was read only in part (the walk budget or its row cap ran out). */
  isPartial: boolean
  /** The oldest day read in full when the walk stopped early. */
  scannedThrough: string | null
  /** Reviews per `feedback_type` in the window (after the filters), `untyped` = no type yet. */
  typeCounts: Record<string, number>
}

export interface ProblemTreeParams extends DateRangeParams {
  source?: string | null
  category?: string | null
  subcategory?: string | null
  urgentOnly?: boolean
  /** `low | med | high | off`; `med` is the server's default and is not sent. */
  similarity?: string
  /** `key:value[|value…]` pairs (`shared/item_filters.py`), e.g. the review-type filter. */
  dims?: string
}

const count = z.coerce.number().catch(0)
const text = z.string().catch('')

const ProblemSchema = z.object({
  problem: text,
  similar_problems: z.array(z.string()).catch([]),
  similar_count: count,
  root_cause: z.string().nullable().catch(null),
  count,
  urgent_count: count,
  avg_sentiment: count,
  sentiment_counts: z.record(z.string(), z.coerce.number()).catch({}),
  sample_ids: z.array(z.string()).catch([]),
}).transform((p): ProblemGroup => ({
  problem: p.problem,
  similarProblems: p.similar_problems,
  similarCount: Math.max(p.similar_count, p.similar_problems.length),
  rootCause: p.root_cause === '' ? null : p.root_cause,
  count: p.count,
  avgSentiment: p.avg_sentiment,
  urgentCount: p.urgent_count,
  sentimentCounts: p.sentiment_counts,
  sampleIds: p.sample_ids,
}))

const SubcategorySchema = z.object({
  subcategory: z.string().catch('general'),
  problems: z.array(ProblemSchema).catch([]),
  problem_count: count,
  total_items: count,
  urgent_count: count,
}).transform((s): SubcategoryGroup => ({
  subcategory: s.subcategory,
  problems: s.problems.filter((p) => p.problem !== ''),
  problemCount: Math.max(s.problem_count, s.problems.length),
  totalItems: s.total_items,
  urgentCount: s.urgent_count,
}))

const CategorySchema = z.object({
  category: z.string().catch('uncategorized'),
  subcategories: z.array(SubcategorySchema).catch([]),
  total_items: count,
  urgent_count: count,
}).transform((c): CategoryGroup => ({
  category: c.category,
  subcategories: c.subcategories,
  totalItems: c.total_items,
  urgentCount: c.urgent_count,
}))

const ResponseSchema = z.object({
  categories: z.array(CategorySchema).catch([]),
  subcategories: z.array(z.string()).catch([]),
  feedback_count: count,
  problem_count: count,
  problems_truncated: z.boolean().catch(false),
  is_partial: z.boolean().catch(false),
  scanned_through: z.string().nullable().optional().catch(null),
  type_counts: z.record(z.string(), z.coerce.number()).catch({}),
}).transform((r): ProblemTreeResponse => ({
  categories: r.categories,
  subcategories: r.subcategories,
  feedbackCount: r.feedback_count,
  problemCount: r.problem_count,
  problemsTruncated: r.problems_truncated,
  isPartial: r.is_partial,
  scannedThrough: r.scanned_through ?? null,
  typeCounts: r.type_counts,
}))

/** Lenient read of a `/feedback/problems` body; anything unreadable is an empty tree. */
export function parseProblemTree(payload: unknown): ProblemTreeResponse {
  const parsed = ResponseSchema.safeParse(payload)
  return parsed.success ? parsed.data : ResponseSchema.parse({})
}

/** The query string for `params` (empty values and the defaults left out). */
export function problemTreeSearch(params: ProblemTreeParams): string {
  const entries: [string, string | undefined][] = [
    ['days', params.days === undefined ? undefined : String(params.days)],
    ['date_basis', params.date_basis],
    ['source', params.source ?? undefined],
    ['category', params.category ?? undefined],
    ['subcategory', params.subcategory ?? undefined],
    ['urgent', params.urgentOnly === true ? '1' : undefined],
    ['similarity', params.similarity === 'med' ? undefined : params.similarity],
    ['dims', params.dims],
  ]
  return new URLSearchParams(
    entries.filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''),
  ).toString()
}

export async function getProblemTree(params: ProblemTreeParams): Promise<ProblemTreeResponse> {
  return parseProblemTree(await fetchApi<unknown>(`/feedback/problems?${problemTreeSearch(params)}`))
}
