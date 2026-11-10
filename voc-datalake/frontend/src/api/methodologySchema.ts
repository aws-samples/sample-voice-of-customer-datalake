/**
 * The methodology the server reports (lambda/shared/methodology.py, docs/project-workspace.md → Methodology).
 *
 * Two shapes cross the wire:
 * - the block a generation route answers and stores on the document it produced
 *   (`skipped` upstream steps, `warnings` by code, `evidence` = feedback items that
 *   reached the prompt; 0 on a hand-written document);
 * - the per-step overview `GET /projects/{id}` carries, which the Overview cards
 *   render instead of computing the gaps themselves.
 *
 * Both are parsed leniently: an unknown step or code is kept as a string (the UI
 * falls back to the server's English message), a malformed block is dropped.
 */
import { z } from 'zod'

const StepIdSchema = z.string().min(1)

const SkippedStepSchema = z.object({
  step: StepIdSchema,
  reason: z.string().catch('missing'),
})

const MethodologyWarningSchema = z.looseObject({
  code: z.string().min(1),
  message: z.string().catch(''),
  step: z.string().optional().catch(undefined),
  document_ids: z.array(z.string()).optional().catch(undefined),
  cap: z.number().int().nonnegative().optional().catch(undefined),
})

/** A list of which only the valid rows are kept (one bad row never drops the block). */
function validRows<T extends z.ZodType>(row: T) {
  return z.array(z.unknown()).catch(() => []).transform((rows) => rows.flatMap((raw) => {
    const parsed = row.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  }))
}

/** `raw` through `schema`, or undefined when it is absent or does not parse (never a throw). */
function leniently<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> | undefined {
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

const MethodologyBlockSchema = z.object({
  step: z.string().catch(''),
  skipped: validRows(SkippedStepSchema),
  warnings: validRows(MethodologyWarningSchema),
  evidence: z.number().int().nonnegative().nullable().optional().catch(undefined),
})

export type MethodologyBlock = z.infer<typeof MethodologyBlockSchema>
export type MethodologyWarning = z.infer<typeof MethodologyWarningSchema>

/** A document's or a route answer's `methodology`, or undefined when absent or malformed. */
export const optionalMethodologyBlock = z.unknown().optional()
  .transform((raw) => leniently(MethodologyBlockSchema, raw))

const OverviewStepSchema = z.object({
  missing: z.array(z.string()).catch(() => []),
  count: z.number().int().nonnegative().catch(0),
  blocked: z.boolean().optional().catch(undefined),
})

const ProjectMethodologySchema = z.object({
  order: z.array(z.string()).catch(() => []),
  steps: z.record(z.string(), OverviewStepSchema).catch(() => ({})),
})

export type ProjectMethodology = z.infer<typeof ProjectMethodologySchema>

/** `GET /projects/{id}`'s `methodology`, or undefined (an older API, or a malformed value). */
export const optionalProjectMethodology = z.unknown().optional()
  .transform((raw) => leniently(ProjectMethodologySchema, raw))

/** The upstream steps the server says `step` is missing, or undefined when it did not say. */
export function serverMissing(methodology: ProjectMethodology | undefined, step: string): readonly string[] | undefined {
  return methodology?.steps[step]?.missing
}
