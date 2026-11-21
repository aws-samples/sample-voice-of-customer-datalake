/**
 * @fileoverview Pure helpers for assistant message rendering.
 *
 * @module assistant/components/messageHelpers
 */
import { z } from 'zod'
import { parseEach } from '../../api/lenientFields'
import { ownEntry } from '../ownEntry'
import type { Message } from '@ag-ui/core'
import type { NavigationSuggestion } from '../thread/types'

/** `get_feedback_item` → "Get feedback item". */
export function humanizeToolName(name: string): string {
  const words = name.replace(/_/g, ' ').trim()
  return words === '' ? name : words.charAt(0).toUpperCase() + words.slice(1)
}

/** A review a focus group answer cites (`[fb:<id>]`): its chip's id and tooltip. */
const citationSchema = z.object({
  feedback_id: z.string().min(1),
  text: z.string().catch(''),
  source_platform: z.string().catch(''),
})

export type PersonaCitation = z.infer<typeof citationSchema>

const personaResponseSchema = z.object({
  persona_id: z.string(),
  name: z.string().catch(''),
  avatar_url: z.string().optional().catch(undefined),
  answer: z.string().catch(''),
  /** A focus group's round (1–3); absent on a mention round's or the model's consultation. */
  round: z.number().int().positive().optional().catch(undefined),
  citations: z.array(z.unknown()).optional().catch(undefined)
    .transform((rows) => (rows === undefined ? undefined : parseEach(citationSchema, rows))),
})

export type PersonaResponse = z.infer<typeof personaResponseSchema>

/** `consult_personas` result content → persona answers (empty when unparsable). */
export function parsePersonaResponses(content: string): PersonaResponse[] {
  try {
    const parsed: unknown = JSON.parse(content)
    const envelope = z.object({ responses: z.unknown() }).safeParse(parsed)
    return envelope.success ? parseEach(personaResponseSchema, envelope.data.responses) : []
  } catch {
    return []
  }
}


interface TurnNavigation {
  readonly byMessage: Readonly<Record<string, readonly NavigationSuggestion[]>>
  readonly pending: readonly NavigationSuggestion[]
  readonly lastAssistantId: string | null
}

function flushTurn(acc: TurnNavigation): TurnNavigation {
  if (acc.lastAssistantId === null || acc.pending.length === 0) return { ...acc, pending: [], lastAssistantId: null }
  return { byMessage: { ...acc.byMessage, [acc.lastAssistantId]: acc.pending }, pending: [], lastAssistantId: null }
}

function addChips(pending: readonly NavigationSuggestion[], chips: readonly NavigationSuggestion[]): NavigationSuggestion[] {
  const fresh = chips.filter((chip) => !pending.some((p) => p.path === chip.path && p.label === chip.label))
  return [...pending, ...fresh]
}

/**
 * Navigation chips placed under the LAST assistant message of each answer.
 *
 * A chip is anchored to the message that was streaming when the model offered
 * it; when the model offers the link before it writes (a tool round first), that
 * is an earlier message than the text, and the chip rendered ABOVE the answer
 * that said "the link is below" (live 5.14). One answer = the assistant
 * messages between two user turns; identical chips are shown once.
 */
export function navigationAtTurnEnd(
  messages: readonly Message[],
  navigation: Readonly<Record<string, readonly NavigationSuggestion[]>>,
): Readonly<Record<string, readonly NavigationSuggestion[]>> {
  const start: TurnNavigation = { byMessage: {}, pending: [], lastAssistantId: null }
  const end = messages.reduce<TurnNavigation>((acc, message) => {
    if (message.role === 'user') return flushTurn(acc)
    if (message.role !== 'assistant') return acc
    return { ...acc, pending: addChips(acc.pending, ownEntry(navigation, message.id) ?? []), lastAssistantId: message.id }
  }, start)
  return flushTurn(end).byMessage
}
