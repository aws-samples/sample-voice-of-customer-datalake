/**
 * @fileoverview How a web_reviews run read each of its pages: the run row's `reads` (plugins/web_reviews/ingestor,
 * docs/web-reviews.md → Methods), one entry per target the run read, and the sentence a card says it in.
 *
 * Each entry names the target (`target_id`), its method (`auto`, `browser`, `bedrock_web_search`), the step that read
 * it (`method_used`: the browser, the Bedrock web index or AgentCore web search; null when none did), the reviews
 * sent, and every step tried with its outcome. For an Automatic page, `plan` says how its order was chosen:
 * `known` (straight to the method this workspace learned for the site, `known_method` / `learned_at`), `reprobe`
 * (the browser re-checked first) or `cascade` (every method in turn). Read leniently: an entry or a step this build
 * cannot read is left out, a field it cannot read takes its empty value, and the run record itself is never refused.
 * @module pages/Scrapers/reviewReads
 */
import { z } from 'zod'

const READ_STEPS = ['browser', 'bedrock_web_search', 'agentcore_web_search'] as const
export type ReadStep = typeof READ_STEPS[number]
const StepSchema = z.enum(READ_STEPS)

/** Each step's name (scrapers namespace). */
export const STEP_KEYS: Readonly<Record<ReadStep, string>> = {
  browser: 'scrapers:appCard.read.step.browser',
  bedrock_web_search: 'scrapers:appCard.read.step.bedrock_web_search',
  agentcore_web_search: 'scrapers:appCard.read.step.agentcore_web_search',
}

const StepReadSchema = z.object({
  method: StepSchema,
  outcome: z.enum(['readable', 'blocked', 'no_reviews', 'error', 'skipped_time', 'not_offered']),
  vendor: z.string().min(1).optional().catch(undefined),
  reviews: z.number().int().nonnegative().catch(0),
  detail: z.string().optional().catch(undefined),
})
export type StepRead = z.infer<typeof StepReadSchema>
export type StepOutcome = StepRead['outcome']

const TargetReadSchema = z.object({
  target: z.string().catch(''),
  target_id: z.string().catch(''),
  method: z.enum(['auto', 'browser', 'bedrock_web_search']).catch('auto'),
  method_used: StepSchema.nullable().catch(null),
  reviews: z.number().int().nonnegative().catch(0),
  plan: z.enum(['known', 'reprobe', 'cascade']).nullable().catch(null),
  known_method: StepSchema.nullable().catch(null),
  learned_at: z.string().nullable().catch(null),
  steps: z.array(z.unknown()).catch([]).transform((steps) => steps.flatMap((step) => {
    const parsed = StepReadSchema.safeParse(step)
    return parsed.success ? [parsed.data] : []
  })),
  excerpt: z.boolean().catch(false),
})
export type TargetRead = z.infer<typeof TargetReadSchema>

/** The run row's `reads`: the entries this build can read, in the row's order; undefined when it has none. */
export const ReadsSchema = z.array(z.unknown()).transform((reads) => reads.flatMap((read) => {
  const parsed = TargetReadSchema.safeParse(read)
  return parsed.success ? [parsed.data] : []
})).optional().catch(undefined)

/** The entry of the card's page: the one naming its id, else the run's only entry (a run of one page). */
export function readOfPage(reads: readonly TargetRead[] | undefined, appId: string): TargetRead | undefined {
  if (reads === undefined) return undefined
  const own = reads.find((read) => appId !== '' && read.target_id === appId)
  return own ?? (reads.length === 1 ? reads[0] : undefined)
}

/** Whether the page's reviews are AgentCore web search excerpts (cut passages of search results). */
export function readsExcerpts(read: TargetRead): boolean {
  return read.excerpt || read.method_used === 'agentcore_web_search'
}

/** How the run's sentence is built: the steps that failed before the one that read the page, and that one. */
export interface ReadChain {
  readonly failed: readonly StepRead[]
  readonly success: StepRead | undefined
}

export function readChain(read: TargetRead): ReadChain {
  const index = read.steps.findIndex((step) => step.outcome === 'readable' && step.method === read.method_used)
  if (index === -1) return { failed: read.steps.filter((step) => step.outcome !== 'readable'), success: undefined }
  return { failed: read.steps.slice(0, index).filter((step) => step.outcome !== 'readable'), success: read.steps[index] }
}
