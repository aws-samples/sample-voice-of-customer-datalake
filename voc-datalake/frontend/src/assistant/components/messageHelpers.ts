/**
 * @fileoverview Pure helpers for assistant message rendering.
 *
 * @module assistant/components/messageHelpers
 */
import { z } from 'zod'
import { lenientList } from '../lenient'

/** `get_feedback_item` → "Get feedback item". */
export function humanizeToolName(name: string): string {
  const words = name.replace(/_/g, ' ').trim()
  return words === '' ? name : words.charAt(0).toUpperCase() + words.slice(1)
}

const personaResponseSchema = z.object({
  persona_id: z.string(),
  name: z.string().catch(''),
  avatar_url: z.string().optional().catch(undefined),
  answer: z.string().catch(''),
})

export type PersonaResponse = z.infer<typeof personaResponseSchema>

/** `consult_personas` result content → persona answers (empty when unparsable). */
export function parsePersonaResponses(content: string): PersonaResponse[] {
  try {
    const parsed: unknown = JSON.parse(content)
    const envelope = z.object({ responses: z.unknown() }).safeParse(parsed)
    return envelope.success ? lenientList(personaResponseSchema, envelope.data.responses) : []
  } catch {
    return []
  }
}

