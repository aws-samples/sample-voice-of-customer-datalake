/**
 * @fileoverview Lenient boundary for a prototype draft (docs/prototype-builder.md, part 2):
 * `GET /projects/{id}/prototypes/{document_id}/drafts/{draft_id}` answers
 * `{draft_id, base_document_id, base_version, instruction, summary, preview_url, completed_at}`,
 * at EDIT only (the page reads all but `completed_at`). The draft's job row holds what it was made from; this is the only read of it.
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

const draftSchema = z.object({
  draft_id: z.string().min(1),
  base_document_id: z.string().min(1),
  base_version: z.number().int().positive(),
  instruction: z.string().catch('').transform((text) => text.slice(0, MAX_DRAFT_TEXT)),
  summary: z.string().catch('').transform((text) => text.slice(0, MAX_DRAFT_TEXT)),
  // A signed CloudFront URL (its own key only), or null when signing is unavailable. Only http(s):
  // it becomes a frame's `src`.
  preview_url: z.url({ protocol: /^https?$/ }).nullable().catch(null),
})

export type PrototypeDraft = z.output<typeof draftSchema>

/** The draft GET's answer, or null when it is not a draft the page can show. */
export function normalizePrototypeDraft(raw: unknown): PrototypeDraft | null {
  const parsed = draftSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The summary as plain lines (blank ones dropped): the model writes one "screen: what changed" per line. */
export function summaryLines(summary: string): string[] {
  return summary.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
}
