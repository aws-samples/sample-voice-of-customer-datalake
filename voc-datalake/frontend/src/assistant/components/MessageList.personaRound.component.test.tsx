/**
 * The persona round of an @mention message: each persona's reply is a card with its name, in
 * the order the personas answered, above the assistant's own short synthesis.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { render } from '@test/test-utils'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { createThreadState } from '../thread/reducer'
import MessageList from './MessageList'
import type { Message } from '@ag-ui/core'

function reply(personaId: string, name: string, answer: string): string {
  return JSON.stringify({ responses: [{ persona_id: personaId, name, answer }] })
}

const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'consult_personas', arguments: '{}' } })

/** Each round call's result, by tool call id. */
const RESULTS: Record<string, string> = {
  mention_a: reply('p1', 'Deadline Dana', 'The FAQ dodges delivery dates.'),
  mention_b: reply('p2', 'Value Victor', 'Say what it costs.'),
}

const MESSAGES: Message[] = [
  { id: 'u1', role: 'user', content: '@all please review #PR/FAQ (v1)' },
  { id: 'round', role: 'assistant', content: '', toolCalls: Object.keys(RESULTS).map(call) },
  ...Object.entries(RESULTS).map(([toolCallId, content]): Message => ({ id: `t-${toolCallId}`, role: 'tool', toolCallId, content })),
  { id: 'a2', role: 'assistant', content: 'Both want plainer facts up front.' },
]

describe('persona round in the thread', () => {
  beforeEach(() => stubElementScrollIntoView())

  it('shows each persona reply as its own named card, then the synthesis', () => {
    const thread = { ...createThreadState('t1'), messages: MESSAGES, toolResults: RESULTS }
    render(<MessageList thread={thread} page={{ kind: 'project', path: '/projects/proj_1', projectId: 'proj_1' }} />)

    const cards = within(screen.getByRole('list', { name: 'Persona answers' })).getAllByRole('listitem')
    expect(cards.map((card) => card.textContent)).toStrictEqual([
      'Deadline DanaThe FAQ dodges delivery dates.',
      'Value VictorSay what it costs.',
    ])
    expect(screen.getByText('Both want plainer facts up front.')).toBeInTheDocument()
  })
})
