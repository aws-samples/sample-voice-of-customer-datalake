/**
 * @fileoverview Argument schema of `draft_prototype_revision` (docs/prototype-builder.md, parts 2 and 3): the
 * assistant proposes a draft of a prototype, from the editor's instruction or from selected tester pins (their
 * ids only, never their text: the server reads the pins and writes the instruction itself); approving it starts
 * the draft job (`POST /projects/{id}/prototypes/{document_id}/drafts`). There is no apply tool: the prototype's
 * page applies a draft, beside its full preview.
 *
 * LOCKSTEP with the stream Lambda's tool schema (`lambda/stream/src/assistant/tools/client/prototype-draft.ts`;
 * pinned by `prototypeSchemas.lockstep.test.ts`): a longer instruction or more pins on one side would be a card
 * the user approves and the route then refuses.
 *
 * @module assistant/approvals/prototypeSchemas
 */
import { z } from 'zod'
import { nonEmpty } from '@stream/assistant/tools/client/text-schemas'
import { WALKTHROUGH_LIMITS } from '../../api/prototypeWalkthroughSchema'
import { idSchema } from './schemas'

/**
 * = the drafts route's bounds: an instruction of 1–2,000 characters after trimming, or 1–50 distinct pin ids
 * (MAX_BATCH_PINS in lambda/shared/prototype_pins.py).
 */
const DRAFT_PROTOTYPE_LIMITS = { instructionChars: 2000, pins: 50 } as const

/**
 * Each pin id takes the stream tool's own rule (`idSchema`, as its `pin_ids` does); the route checks the pin-id
 * format and answers a malformed one with its 400. A repeated id is folded, as the route folds it.
 */
const pinIdsSchema = z.array(idSchema).min(1).max(DRAFT_PROTOTYPE_LIMITS.pins)
  .transform((ids) => [...new Set(ids)])

export const draftPrototypeRevisionArgs = z.union([
  z.strictObject({ project_id: idSchema, document_id: idSchema, instruction: nonEmpty(DRAFT_PROTOTYPE_LIMITS.instructionChars) }),
  z.strictObject({ project_id: idSchema, document_id: idSchema, pin_ids: pinIdsSchema }),
])

export type DraftPrototypeRevisionArgs = z.infer<typeof draftPrototypeRevisionArgs>

/**
 * `set_prototype_walkthrough` (Part 1): the steps saved as the prototype's next version (`[]` removes them); the
 * same bounds as the route and the stream tool (`WALKTHROUGH_LIMITS`, pinned by the lockstep test).
 */
const share = z.number().min(0).max(1)
const walkthroughStep = z.strictObject({
  title: nonEmpty(WALKTHROUGH_LIMITS.title),
  body: nonEmpty(WALKTHROUGH_LIMITS.body),
  selector: nonEmpty(WALKTHROUGH_LIMITS.selector).optional(),
  anchor: z.strictObject({
    // Optional for the model (as the stream tool's); '' (this screen) when it names none.
    route: z.string().max(WALKTHROUGH_LIMITS.route).default(''),
    bbox: z.strictObject({ x: share, y: share, w: share, h: share }),
  }).optional(),
}).refine((step) => step.selector !== undefined || step.anchor !== undefined, 'Each step needs a selector or an anchor.')

export const setPrototypeWalkthroughArgs = z.strictObject({
  project_id: idSchema,
  document_id: idSchema,
  steps: z.array(walkthroughStep).max(WALKTHROUGH_LIMITS.steps),
})

export type SetPrototypeWalkthroughArgs = z.infer<typeof setPrototypeWalkthroughArgs>
