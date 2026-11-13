/**
 * @fileoverview Argument schema of `draft_prototype_revision` (docs/prototype-builder.md, part 2): the
 * assistant proposes a draft of a prototype from the editor's instruction; approving it starts the
 * draft job (`POST /projects/{id}/prototypes/{document_id}/drafts`). There is no apply tool: the
 * prototype's page applies a draft, beside its full preview.
 *
 * LOCKSTEP with the stream Lambda's tool schema (`lambda/stream/src/assistant/tools/client/`; pinned by
 * `prototypeSchemas.lockstep.test.ts`): a longer instruction on one side would be a card the user
 * approves and the route then refuses.
 *
 * @module assistant/approvals/prototypeSchemas
 */
import { z } from 'zod'
import { nonEmpty } from '@stream/assistant/tools/client/text-schemas'
import { idSchema } from './schemas'

/** = the drafts route's instruction bound (1–2,000 characters after trimming). */
const DRAFT_PROTOTYPE_LIMITS = { instructionChars: 2000 } as const

export const draftPrototypeRevisionArgs = z.strictObject({
  project_id: idSchema,
  document_id: idSchema,
  instruction: nonEmpty(DRAFT_PROTOTYPE_LIMITS.instructionChars),
})

export type DraftPrototypeRevisionArgs = z.infer<typeof draftPrototypeRevisionArgs>
