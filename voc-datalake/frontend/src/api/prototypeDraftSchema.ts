/**
 * @fileoverview Lenient boundary for a prototype draft (docs/prototype-builder.md, part 2):
 * `GET /projects/{id}/prototypes/{document_id}/drafts/{draft_id}` answers
 * `{draft_id, base_document_id, base_version, kind, instruction, summary, preview_url, completed_at}`, and for
 * a feedback draft (part 3) `outcomes`, `withheld` and `ignored`, at EDIT only (the page reads all but
 * `completed_at` and `ignored`: an id the model made up changed nothing, so the page has nothing to say of it). The draft's job row holds what it was made from; this is the only read of it.
 *
 * A draft the page cannot show (no id, no base, no version number) is null: the page then shows no
 * banner rather than an Apply that names a version it does not know. The summary is the model's
 * plain text and stays text (the banner renders it as lines, never as Markdown or HTML).
 *
 * @module api/prototypeDraftSchema
 */
import { z } from 'zod'

/** = MAX_INSTRUCTION_CHARS / the summary's cap on the server (2,000 each). */
const MAX_DRAFT_TEXT = 2000
/** A pin outcome's note, as the banner shows it (the server caps it already). */
const MAX_NOTE_CHARS = 1000

const pinIds = z.array(z.string().min(1)).catch([])

/**
 * A feedback draft's answer per accepted pin (part 3): Done and what changed, or Not done and why. The model's
 * words as plain text; an entry that is not one of these is dropped, never shown as something else.
 */
const outcomeSchema = z.object({
  pin_id: z.string().min(1),
  outcome: z.enum(['done', 'not_done']),
  note: z.string().catch('').transform((text) => text.slice(0, MAX_NOTE_CHARS)),
})

const outcomesSchema = z.array(z.unknown()).catch([])
  .transform((rows) => rows.flatMap((row) => {
    const parsed = outcomeSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  }))

const draftSchema = z.object({
  draft_id: z.string().min(1),
  base_document_id: z.string().min(1),
  base_version: z.number().int().positive(),
  /** `feedback`: made from selected pins (part 3); anything else reads as an instruction's draft. */
  kind: z.enum(['chat', 'feedback']).catch('chat'),
  instruction: z.string().catch('').transform((text) => text.slice(0, MAX_DRAFT_TEXT)),
  summary: z.string().catch('').transform((text) => text.slice(0, MAX_DRAFT_TEXT)),
  // A signed CloudFront URL (its own key only), or null when signing is unavailable. Only http(s):
  // it becomes a frame's `src`.
  preview_url: z.url({ protocol: /^https?$/ }).nullable().catch(null),
  outcomes: outcomesSchema,
  /** Selected pins the server did not send to the model (instruction-shaped text). */
  withheld: pinIds,
})

export type PrototypeDraft = z.output<typeof draftSchema>
export type PinOutcome = PrototypeDraft['outcomes'][number]

/** The draft GET's answer, or null when it is not a draft the page can show. */
export function normalizePrototypeDraft(raw: unknown): PrototypeDraft | null {
  const parsed = draftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * What Apply did with a feedback draft's pins (part 3): the Done pins marked addressed by the new version, the
 * Not done ones given the model's reason as a reply, and each mark or reply it could not write, with why (the
 * version stands either way). Absent for an instruction's draft.
 */
const incorporationSchema = z.object({
  marked: pinIds,
  replied: pinIds,
  not_written: z.array(z.unknown()).catch([]).transform((rows) => rows.flatMap((row) => {
    const parsed = z.object({ pin_id: z.string().min(1), reason: z.string().catch('') }).safeParse(row)
    return parsed.success ? [{ pin_id: parsed.data.pin_id, reason: parsed.data.reason.slice(0, MAX_NOTE_CHARS) }] : []
  })),
})

export type Incorporation = z.output<typeof incorporationSchema>

/** Apply's `incorporation`, or null when the answer has none (an instruction's draft, or a shape not this one). */
export function normalizeIncorporation(raw: unknown): Incorporation | null {
  const parsed = incorporationSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The summary as plain lines (blank ones dropped): the model writes one "screen: what changed" per line. */
export function summaryLines(summary: string): string[] {
  return summary.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
}
