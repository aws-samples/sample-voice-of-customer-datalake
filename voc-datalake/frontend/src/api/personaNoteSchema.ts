/**
 * @fileoverview Lenient boundary for `POST /projects/{id}/personas/{pid}/notes`
 * (`projects.add_persona_note` answers `{success, note}`).
 *
 * Same precedent as `projectDetailSchema.ts`: the response is never trusted to
 * match its declared type, and a malformed field degrades rather than throws —
 * the note was already written, so a shape surprise must not report a failure.
 *
 * @module api/personaNoteSchema
 */
import { z } from 'zod'

const optionalText = z.string().optional().catch(undefined)

const personaNoteSchema = z.object({
  note_id: optionalText,
  text: optionalText,
  author: optionalText,
  created_at: optionalText,
})

const addPersonaNoteResponseSchema = z.object({
  success: z.boolean().catch(false),
  note: personaNoteSchema.optional().catch(undefined),
})

export type AddPersonaNoteResponse = z.infer<typeof addPersonaNoteResponseSchema>

export function normalizeAddPersonaNoteResponse(raw: unknown): AddPersonaNoteResponse {
  const parsed = addPersonaNoteResponseSchema.safeParse(raw)
  return parsed.success ? parsed.data : { success: false }
}
