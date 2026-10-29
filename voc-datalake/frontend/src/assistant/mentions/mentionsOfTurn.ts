/**
 * @fileoverview The mentions of the last turn, read back from its persona round.
 *
 * The server answers each mentioned persona with its own `consult_personas` call whose id starts
 * with MENTION_TOOL_CALL_PREFIX and whose arguments name that persona and the tagged documents.
 * Those calls are saved with the conversation, so Regenerate can ask the same personas again
 * (an `@all` comes back as the personas it resolved to) without keeping anything else.
 *
 * @module assistant/mentions/mentionsOfTurn
 */
import { z } from 'zod'
import { MENTION_LIMITS, MENTION_TOOL_CALL_PREFIX, mentionsSchema } from '../contract'
import { parseToolArguments } from '../thread/reducer'
import type { Message, ToolCall } from '@ag-ui/core'
import type { Mentions } from '../contract'

const roundArgsSchema = z.object({
  persona_ids: z.array(z.string()).catch([]),
  document_ids: z.array(z.string()).optional().catch(undefined),
})

function isRoundCall(call: ToolCall): boolean {
  return call.function.name === 'consult_personas' && call.id.startsWith(MENTION_TOOL_CALL_PREFIX)
}

/** The tool calls after the last user message. */
function lastTurnCalls(messages: readonly Message[]): ToolCall[] {
  const lastUser = messages.reduce((found, message, index) => (message.role === 'user' ? index : found), -1)
  return messages.slice(lastUser + 1).flatMap((message) => (message.role === 'assistant' ? message.toolCalls ?? [] : []))
}

export function mentionsOfLastTurn(messages: readonly Message[]): Mentions | undefined {
  const rounds = lastTurnCalls(messages).filter(isRoundCall).flatMap((call) => {
    const parsed = roundArgsSchema.safeParse(parseToolArguments(call.function.arguments))
    return parsed.success ? [parsed.data] : []
  })
  const personaIds = [...new Set(rounds.flatMap((args) => args.persona_ids))].slice(0, MENTION_LIMITS.maxPersonas)
  const documentIds = [...new Set(rounds.flatMap((args) => args.document_ids ?? []))].slice(0, MENTION_LIMITS.maxDocuments)
  if (personaIds.length === 0) return undefined
  const parsed = mentionsSchema.safeParse({
    personas: personaIds,
    ...(documentIds.length > 0 ? { documents: documentIds.map((id) => ({ document_id: id })) } : {}),
  })
  return parsed.success ? parsed.data : undefined
}
