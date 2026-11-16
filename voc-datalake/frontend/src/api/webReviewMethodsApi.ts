/**
 * @fileoverview The methods this workspace learned for its review sites (`/integrations/web_reviews/methods`;
 * lambda/api/integrations_handler.py, lambda/shared/web_review_methods.py, docs/web-reviews.md → Learning which
 * method works).
 *
 * An Automatic review page's runs record, per site (`domain`: the page's host without `www.`), which method read it
 * (`best_method`, `none` until one did), each method's last outcome and, for a site another method reads, when the
 * browser is tried again (`browser_recheck_due_at`). Every workspace learns from its own runs
 * only, starting empty; a request names its workspace in `X-Workspace-Id` like every integrations call. Any member
 * reads the list; clearing a site's record (so its next run tries every method again) is for the workspace's admins
 * (the deployment's admins without a workspace). Read leniently: a record this build cannot read is left out.
 * @module api/webReviewMethodsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { del } from './requestKit'

const StepSchema = z.enum(['browser', 'bedrock_web_search', 'agentcore_web_search'])

const StatsSchema = z.object({
  last_outcome: z.string().catch(''),
  last_at: z.string().catch(''),
  successes: z.number().int().nonnegative().catch(0),
  failures: z.number().int().nonnegative().catch(0),
  last_reviews: z.number().int().nonnegative().catch(0),
})

const RecordSchema = z.object({
  domain: z.string().min(1),
  best_method: z.union([StepSchema, z.literal('none')]).catch('none'),
  learned_at: z.string().nullable().catch(null),
  /** When a run tries the browser again on a site another method reads; null for a browser site or none learned. */
  browser_recheck_due_at: z.string().nullable().catch(null),
  methods: z.record(z.string(), z.unknown()).catch({}).transform((methods) => Object.fromEntries(
    Object.entries(methods).flatMap(([name, stats]) => {
      const step = StepSchema.safeParse(name)
      const parsed = StatsSchema.safeParse(stats)
      return step.success && parsed.success ? [[step.data, parsed.data] as const] : []
    }),
  )),
})
export type WebReviewMethodRecord = z.infer<typeof RecordSchema>

const ListSchema = z.object({ methods: z.array(z.unknown()) })
const ClearedSchema = z.object({ success: z.boolean(), domain: z.string(), cleared: z.boolean().catch(false) })
type ClearedMethod = z.infer<typeof ClearedSchema>

/** The records of a `GET /integrations/web_reviews/methods` answer this build can read, in the server's order. */
export function readWebReviewMethods(raw: unknown): WebReviewMethodRecord[] {
  const parsed = ListSchema.safeParse(raw)
  if (!parsed.success) return []
  return parsed.data.methods.flatMap((row) => {
    const record = RecordSchema.safeParse(row)
    return record.success ? [record.data] : []
  })
}

/** The learned methods of the current workspace's review sites (one read for every card of the page). */
export const webReviewMethodsKey = () => ['web-review-methods'] as const

// Each path is written out in full, so the route audit (scripts/audit/py_route_callers.py) reads it as the caller.
export const webReviewMethodsApi = {
  list: async (): Promise<WebReviewMethodRecord[]> =>
    readWebReviewMethods(await fetchApi<unknown>('/integrations/web_reviews/methods')),
  /** Admins only: forget what was learned for `domain`, so its next run tries every method again. */
  clear: async (domain: string): Promise<ClearedMethod> =>
    ClearedSchema.parse(await fetchApi<unknown>(`/integrations/web_reviews/methods/${encodeURIComponent(domain)}`, del())),
}
