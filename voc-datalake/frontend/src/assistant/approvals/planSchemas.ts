/**
 * @fileoverview Argument schemas of the plan-mode client tools
 * (docs/assistant-plan-mode.md → "New tools"): `run_source`, `set_source_enabled`, `build_prototype`,
 * `cancel_plan` and `propose_plan`.
 *
 * LOCKSTEP with the stream Lambda's tool schemas (`lambda/stream/src/assistant/
 * tools/client/*.ts`, track S; pinned by `planSchemas.lockstep.test.ts`); the REST request each executor makes is pinned
 * to `plan/write-requests.ts` by `plan/writeRequests.lockstep.test.ts`.
 *
 * @module assistant/approvals/planSchemas
 */
import { z } from 'zod'
import { PLAN_ID_RE, planSchema } from '../plan/schema'
import { idSchema, nonEmpty } from './schemas'

/**
 * The plugins whose ingestor `POST /sources/{source}/run` starts by hand (every
 * plugin with an ingestor except `webscraper`, which runs per scraper through
 * `run_scraper`).
 */
const RUN_SOURCE_IDS = ['app_reviews_ios', 'app_reviews_android', 'github_issues', 's3_import', 'synthetic_reviews', 'web_reviews'] as const

export const runSourceArgs = z.strictObject({ source: z.enum(RUN_SOURCE_IDS) })

/**
 * The plugins with an EventBridge schedule `PUT /sources/{source}/enable|disable`
 * toggles (`set_source_enabled`; the stream's `SCHEDULED_SOURCE_IDS`).
 */
const SCHEDULED_SOURCE_IDS = ['app_reviews_ios', 'app_reviews_android', 'github_issues', 'web_reviews', 'webscraper'] as const

export const setSourceEnabledArgs = z.strictObject({ source: z.enum(SCHEDULED_SOURCE_IDS), enabled: z.boolean() })

/** Bounds of the free-text fields (FREE_TEXT_FIELDS `build_prototype`: title, feedback). */
const BUILD_PROTOTYPE_LIMITS = { titleChars: 200, feedbackChars: 4000 } as const

/**
 * `POST /projects/{id}/build-prototype`; the arguments keep the route's body
 * names (stream `tools/client/plan-writes.ts`): `feedback` revises
 * `base_prototype_id`; `source_prd_id` / `source_prfaq_id` build from those
 * documents instead of the newest PRD / PR/FAQ.
 */
export const buildPrototypeArgs = z.strictObject({
  project_id: idSchema,
  title: nonEmpty(BUILD_PROTOTYPE_LIMITS.titleChars).optional(),
  feedback: nonEmpty(BUILD_PROTOTYPE_LIMITS.feedbackChars).optional(),
  base_prototype_id: idSchema.optional(),
  source_prd_id: idSchema.optional(),
  source_prfaq_id: idSchema.optional(),
})

export const cancelPlanArgs = z.strictObject({ plan_id: z.string().regex(PLAN_ID_RE, 'must be pl_<12 hex>') })

/** The client tool that proposes a plan (its card is the PlanCard with plan buttons). */
export const PLAN_PROPOSAL_TOOL = 'propose_plan'

/** The proposal's arguments ARE the `voc-plan/1` plan. */
export const proposePlanArgs = planSchema

export type RunSourceArgs = z.infer<typeof runSourceArgs>
export type SetSourceEnabledArgs = z.infer<typeof setSourceEnabledArgs>
export type BuildPrototypeArgs = z.infer<typeof buildPrototypeArgs>
export type CancelPlanArgs = z.infer<typeof cancelPlanArgs>
export type ProposePlanArgs = z.infer<typeof proposePlanArgs>
