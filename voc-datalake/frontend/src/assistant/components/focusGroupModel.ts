/**
 * @fileoverview A persona focus group's turn as data (docs/project-workspace.md → Persona focus groups): each persona's
 * colour, an answer's citations cut out of its text, the turn's topic and rounds read back from the thread, and the
 * markdown a saved focus group files. Pure: the components are in focusGroupParts.tsx.
 *
 * @module assistant/components/focusGroupModel
 */
import { FEEDBACK_CITATION, FOCUS_GROUP_TOOL_CALL_PREFIX } from '@stream/assistant/contract'
import { contentToText } from '../thread/reducer'
import { ownEntry } from '../ownEntry'
import { parsePersonaResponses, type PersonaCitation, type PersonaResponse } from './messageHelpers'
import type { Message, ToolCall } from '@ag-ui/core'
import type { FocusGroupEvent } from '@stream/assistant/contract'
import type { ThreadState } from '../thread/types'

/** Each persona's colour, in the order the group first shows them (the categorical chart palette, never a tone). */
const PERSONA_COLOURS = ['border-chart-1', 'border-chart-2', 'border-chart-3', 'border-chart-4', 'border-chart-5',
  'border-chart-6'] as const

/** The persona a focus group call asks (its arguments' one `persona_ids`), or undefined. */
function personaOfCall(thread: Pick<ThreadState, 'toolCallArgs'>, call: ToolCall): string | undefined {
  const args = ownEntry(thread.toolCallArgs, call.id)
  const ids = typeof args === 'object' && args !== null && 'persona_ids' in args ? args.persona_ids : undefined
  return Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : undefined
}

/** The colour class of each persona of the thread's focus groups, by first appearance. */
export function personaColours(thread: Pick<ThreadState, 'messages' | 'toolCallArgs'>): ReadonlyMap<string, string> {
  const ids = thread.messages.flatMap((message) => (message.role === 'assistant' ? message.toolCalls ?? [] : []))
    .filter((call) => call.id.startsWith(FOCUS_GROUP_TOOL_CALL_PREFIX))
    .flatMap((call) => personaOfCall(thread, call) ?? [])
  return new Map([...new Set(ids)].map((id, index) => [id, PERSONA_COLOURS[index % PERSONA_COLOURS.length] ?? PERSONA_COLOURS[0]]))
}

type CitedPart = { kind: 'text'; value: string } | { kind: 'cite'; id: string; index: number }

/** `text` cut at its citations: text runs, and each citation numbered by its first appearance. */
export function citedParts(text: string): CitedPart[] {
  const matches = [...text.matchAll(FEEDBACK_CITATION)]
  const numbers = new Map<string, number>()
  for (const match of matches) {
    const id = match[1] ?? ''
    if (!numbers.has(id)) numbers.set(id, numbers.size + 1)
  }
  const ends = matches.map((match) => match.index + match[0].length)
  const parts = matches.flatMap((match, n): CitedPart[] => {
    const from = n === 0 ? 0 : ends[n - 1] ?? 0
    const id = match[1] ?? ''
    const before: CitedPart[] = match.index > from ? [{ kind: 'text', value: text.slice(from, match.index) }] : []
    return [...before, { kind: 'cite', id, index: numbers.get(id) ?? 1 }]
  })
  const tail = ends.at(-1) ?? 0
  return tail < text.length ? [...parts, { kind: 'text', value: text.slice(tail) }] : parts
}

/** Every citation the responses carry, by review id (the first one seen wins). */
export function citationsOf(responses: readonly PersonaResponse[]): ReadonlyMap<string, PersonaCitation> {
  const found = new Map<string, PersonaCitation>()
  for (const citation of responses.flatMap((response) => response.citations ?? [])) {
    if (!found.has(citation.feedback_id)) found.set(citation.feedback_id, citation)
  }
  return found
}

export interface TurnRound { round: number; followUp?: string; responses: PersonaResponse[] }

/** The focus group turn that ends on `messageId`: its topic and rounds, read from the thread's own messages. A
 *  message with no persona call is the moderator's follow-up, which opens the round after it. */
export function turnOf(thread: ThreadState, messageId: string): { topic: string; rounds: TurnRound[] } {
  const end = thread.messages.findIndex((message) => message.id === messageId)
  const start = thread.messages.slice(0, end + 1).reduce((found, message, index) => (message.role === 'user' ? index : found), -1)
  // Its own message too: a stopped group ends on its last round's calls (no synthesis message after them).
  const turn: readonly Message[] = thread.messages.slice(start + 1, end + 1)
  const topic = start === -1 ? '' : contentToText(thread.messages[start]?.content ?? '')
  const folded = turn.reduce<{ rounds: TurnRound[]; followUp?: string }>((acc, message) => {
    if (message.role !== 'assistant') return acc
    const calls = (message.toolCalls ?? []).filter((call) => call.id.startsWith(FOCUS_GROUP_TOOL_CALL_PREFIX))
    if (calls.length === 0) {
      const text = contentToText(message.content ?? '').trim()
      return text === '' ? acc : { ...acc, followUp: text }
    }
    const responses = calls.flatMap((call) => parsePersonaResponses(ownEntry(thread.toolResults, call.id) ?? ''))
    const round: TurnRound = { round: acc.rounds.length + 1, ...(acc.followUp === undefined ? {} : { followUp: acc.followUp }), responses }
    return { rounds: [...acc.rounds, round] }
  }, { rounds: [] })
  return { topic, rounds: folded.rounds }
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** The saved document's markdown: the topic, a synthetic banner, the rounds, the synthesis and the reviews cited. */
export function transcriptMarkdown(t: Translate, event: FocusGroupEvent, turn: { topic: string; rounds: TurnRound[] }): string {
  const synthesis = event.synthesis
  const list = (title: string, items: readonly string[]) => (items.length === 0 ? [] : [`### ${title}`, ...items.map((item) => `- ${item}`), ''])
  return [
    `# ${t('assistant:focusGroup.document.heading', { topic: turn.topic })}`, '',
    `> ${t('assistant:focusGroup.document.banner')}`, '',
    ...turn.rounds.flatMap((round) => [
      `## ${t('assistant:focusGroup.round', { round: round.round })}`, '',
      ...(round.followUp === undefined ? [] : [`_${t('assistant:focusGroup.moderator')}:_ ${round.followUp}`, '']),
      ...round.responses.flatMap((response) => [`**${response.name}:** ${response.answer}`, '']),
    ]),
    ...(synthesis === undefined ? [] : [
      `## ${t('assistant:focusGroup.synthesis.title')}`, '',
      ...list(t('assistant:focusGroup.synthesis.agreements'), synthesis.agreements),
      ...list(t('assistant:focusGroup.synthesis.disagreements'), synthesis.disagreements),
      ...list(t('assistant:focusGroup.synthesis.openQuestions'), synthesis.open_questions),
    ]),
    ...(event.cited_feedback_ids.length === 0 ? [] : [
      `## ${t('assistant:focusGroup.document.cited')}`, '',
      // Ids only, never a review's text: the document is read by everyone on the project, whatever their access, and
      // an erasure removes the id from its lineage but never rewrites its text.
      ...event.cited_feedback_ids.map((id) => `- [fb:${id}]`),
    ]),
  ].join('\n')
}
