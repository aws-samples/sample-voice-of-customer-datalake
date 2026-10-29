/**
 * Persona cards survive a reload: a saved persona round longer than the 4,000-character tool cap
 * used to be cut into invalid JSON, so the cards vanished when the conversation was opened again.
 */
import { describe, expect, it } from 'vitest'
import { createThreadState } from '../thread/reducer'
import { parsePersonaResponses } from '../components/messageHelpers'
import { normalizeSessionRecord } from './schema'
import { MAX_STORED_TOOL_CHARS, dropOldestTurns, threadFromSession, toSaveBody } from './serialize'
import type { Message } from '@ag-ui/core'

const LONG_ANSWER = `I would ship it, "but" not like this.\n${'Detail. '.repeat(600)}`

function roundMessages(): Message[] {
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'consult_personas', arguments: '{}' } })
  const result = (personaId: string) => JSON.stringify({
    responses: [{ persona_id: personaId, name: `Persona ${personaId}`, avatar_url: 'https://cdn.example/a.png', answer: LONG_ANSWER }],
  })
  return [
    { id: 'u1', role: 'user', content: '@all review' },
    { id: 'a1', role: 'assistant', toolCalls: [call('mention_1'), call('mention_2')] },
    { id: 't1', role: 'tool', toolCallId: 'mention_1', content: result('p1') },
    { id: 't2', role: 'tool', toolCallId: 'mention_2', content: result('p2') },
  ]
}

function reload(messages: readonly Message[]) {
  const record = normalizeSessionRecord({ id: 'thread_1', kind: 'assistant', title: 't', messages, page: null, updatedAt: '2026-01-01' })
  if (record === null) throw new TypeError('record refused')
  return threadFromSession(record)
}

describe('persona cards after a reload', () => {
  it('saves a long persona round whole and shows every card again', () => {
    const saved = toSaveBody({ ...createThreadState('thread_1'), messages: roundMessages() }, null, '2026-01-01')
    const thread = reload(saved.messages)
    expect(LONG_ANSWER.length).toBeGreaterThan(MAX_STORED_TOOL_CHARS)
    expect(['mention_1', 'mention_2'].map((id) => parsePersonaResponses(thread.toolResults[id] ?? '').map((r) => r.answer)))
      .toStrictEqual([[LONG_ANSWER], [LONG_ANSWER]])
  })

  it('keeps every card when a one-turn record is shrunk after a 413 (an answer within the retry cap stays whole)', () => {
    const cards = dropOldestTurns(roundMessages())
      .flatMap((message) => (message.role === 'tool' ? parsePersonaResponses(String(message.content)) : []))
    expect(cards.map((card) => ({ id: card.persona_id, cut: card.answer.endsWith('…') })))
      .toStrictEqual([{ id: 'p1', cut: false }, { id: 'p2', cut: false }])
  })
})
