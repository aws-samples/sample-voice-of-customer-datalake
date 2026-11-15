/**
 * @fileoverview A prototype version's walkthrough (docs/prototype-builder.md Part 1): the steps the server
 * extracted from the version's HTML and re-validated. `GET …/prototypes/{document_id}/walkthrough` (VIEW)
 * answers `{steps}`; the editor saves them with `PUT` (EDIT, a new version) and drafts them with
 * `POST …/walkthrough/draft` (an assist job whose result is `{steps}`, nothing written).
 *
 * A step: a title (1–80), a body (1–280, plain text) and where it points: a selector (≤ 512) and / or a position
 * (the in-prototype route ≤ 300 and the box as shares 0–1 of the viewport). At most ten steps. A step the page
 * cannot show is dropped at this boundary rather than shown as something else.
 *
 * @module api/prototypeWalkthroughSchema
 */
import { z } from 'zod'

/** = the server's caps (lambda/shared/prototype_walkthrough.py) and the runtime's. */
export const WALKTHROUGH_LIMITS = { steps: 10, title: 80, body: 280, selector: 512, route: 300 } as const

const share = z.number().min(0).max(1)

export const walkthroughAnchorSchema = z.object({
  route: z.string().max(WALKTHROUGH_LIMITS.route).catch(''),
  bbox: z.object({ x: share, y: share, w: share, h: share }),
})

/** One step as the editor holds it (the texts may still be empty while it is being written). */
export interface WalkthroughStep {
  readonly title: string
  readonly body: string
  readonly selector?: string
  readonly anchor?: z.infer<typeof walkthroughAnchorSchema>
}

const stepSchema = z.object({
  title: z.string().trim().min(1).max(WALKTHROUGH_LIMITS.title),
  body: z.string().trim().min(1).max(WALKTHROUGH_LIMITS.body),
  selector: z.string().trim().min(1).max(WALKTHROUGH_LIMITS.selector).optional().catch(undefined),
  anchor: walkthroughAnchorSchema.optional().catch(undefined),
}).refine((step) => step.selector !== undefined || step.anchor !== undefined)

/** The steps of an answer (`{steps}`), each valid one kept, at most ten; anything else is none. */
export function normalizeWalkthroughSteps(raw: unknown): WalkthroughStep[] {
  const rows = z.object({ steps: z.array(z.unknown()) }).safeParse(raw).data?.steps ?? []
  return rows.flatMap((row) => {
    const parsed = stepSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  }).slice(0, WALKTHROUGH_LIMITS.steps)
}

/** Why a step cannot be saved yet: its title or body is empty, or it points nowhere; null when it can. */
export function stepProblem(step: WalkthroughStep): 'title' | 'body' | 'anchor' | null {
  if (step.title.trim() === '') return 'title'
  if (step.body.trim() === '') return 'body'
  if ((step.selector ?? '') === '' && step.anchor === undefined) return 'anchor'
  return null
}
