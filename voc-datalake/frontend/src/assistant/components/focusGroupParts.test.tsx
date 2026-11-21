/**
 * @fileoverview A persona focus group in the thread: the stream's events folded into the thread (cards with their
 * round, colour and citation chips; the synthesis card), kept through a save and a reload, re-sent by Regenerate, and
 * saved as a `focus_group` document with its derivation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventType } from '@ag-ui/core'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { TestRouter } from '@test/TestRouter'
import LocationSearch from '@test/LocationSearch'
import { createThreadState, threadReducer } from '../thread/reducer'
import { threadFromSession, toSaveBody } from '../sessions/serialize'
import { focusGroupOfLastTurn } from '../runtime/focusGroupOfTurn'
import { citedParts, personaColours, transcriptMarkdown, turnOf } from './focusGroupModel'
import { CitedText, FocusGroupCard } from './focusGroupParts'
import { PersonaAnswers } from './messageParts'
import { parsePersonaResponses } from './messageHelpers'
import type { AguiEvent } from '../agui/sse'
import type { ThreadState } from '../thread/types'
import type { FocusGroupEvent } from '@stream/assistant/contract'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const CONFIG = { persona_ids: ['pa', 'pb'], rounds: 2, documents: [{ document_id: 'd1' }] }
const FINISHED: FocusGroupEvent = {
  status: 'finished', config: CONFIG, rounds_completed: 2, cited_feedback_ids: ['f1'], missing_persona_ids: [],
  synthesis: { agreements: ['Both want reliability [fb:f1]'], disagreements: ['Price'], open_questions: [] },
}

function card(round: number, persona: string, name: string, answer: string, citations: unknown[] = []) {
  return JSON.stringify({ responses: [{ persona_id: persona, name, answer, round, citations }] })
}

function call(id: string, persona: string, parent: string): AguiEvent[] {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: 'consult_personas', parentMessageId: parent },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify({ question: 'q', persona_ids: [persona] }) },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ]
}

function text(id: string, delta: string): AguiEvent[] {
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta },
    { type: EventType.TEXT_MESSAGE_END, messageId: id },
  ]
}

const CITED = { feedback_id: 'f1', text: 'The parcel was late', source_platform: 'web' }

const EVENTS: AguiEvent[] = [
  { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
  ...call('focus_r1_a', 'pa', 'm1'), ...call('focus_r1_b', 'pb', 'm1'),
  { type: EventType.TOOL_CALL_RESULT, messageId: 'x1', toolCallId: 'focus_r1_a', role: 'tool', content: card(1, 'pa', 'Ada', 'Late again [fb:f1].', [CITED]) },
  { type: EventType.TOOL_CALL_RESULT, messageId: 'x2', toolCallId: 'focus_r1_b', role: 'tool', content: card(1, 'pb', 'Bea', 'Fine by me.') },
  ...text('m2', 'What would change your mind?'),
  ...call('focus_r2_a', 'pa', 'm3'), ...call('focus_r2_b', 'pb', 'm3'),
  { type: EventType.TOOL_CALL_RESULT, messageId: 'x3', toolCallId: 'focus_r2_a', role: 'tool', content: card(2, 'pa', 'Ada', 'Tracking.') },
  { type: EventType.TOOL_CALL_RESULT, messageId: 'x4', toolCallId: 'focus_r2_b', role: 'tool', content: card(2, 'pb', 'Bea', 'Price.') },
  ...text('m4', '**Agreements**\n- Both want reliability'),
  { type: EventType.CUSTOM, name: 'assistant.focus_group', value: FINISHED },
  { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1', outcome: { type: 'success' } },
]

function threadOf(): ThreadState {
  const start = threadReducer(createThreadState('t1'), {
    type: 'local/user_message', message: { id: 'u1', role: 'user', content: 'Shorter slots?' },
  })
  return EVENTS.reduce((state, event) => threadReducer(state, { type: 'event', event }), start)
}

beforeEach(() => {
  resetFetchApi()
})

describe('the thread', () => {
  it('keeps the focus group\'s state on its last message, through a save and a reload', () => {
    const thread = threadOf()
    expect(thread.focusGroups).toStrictEqual({ m4: FINISHED })
    const body = toSaveBody(thread, null, '2026-11-21T00:00:00Z')
    const restored = threadFromSession({ id: 't1', messages: body.messages, pendingInterrupts: [], createdAt: '', updatedAt: '',
      runStatus: null, revision: 0 })
    expect(restored.focusGroups).toStrictEqual({ m4: FINISHED })
  })

  it('drops a state the contract does not read', () => {
    const thread = threadReducer(threadOf(), { type: 'event', event: {
      type: EventType.CUSTOM, name: 'assistant.focus_group', value: { status: 'finished' } } })
    expect(thread.focusGroups).toStrictEqual({ m4: FINISHED })
  })

  it('gives Regenerate the group as it was configured', () => {
    expect(focusGroupOfLastTurn(threadOf())).toStrictEqual(CONFIG)
    expect(focusGroupOfLastTurn(createThreadState('t2'))).toBeUndefined()
  })

  it('reads the turn back: the topic, each round with its moderator follow-up and answers', () => {
    const turn = turnOf(threadOf(), 'm4')
    expect({ topic: turn.topic, rounds: turn.rounds.map((round) => ({ round: round.round, followUp: round.followUp,
      names: round.responses.map((response) => response.name) })) }).toStrictEqual({
      topic: 'Shorter slots?', rounds: [{ round: 1, followUp: undefined, names: ['Ada', 'Bea'] },
        { round: 2, followUp: 'What would change your mind?', names: ['Ada', 'Bea'] }],
    })
  })

  it('colours each persona by its first appearance', () => {
    expect([...personaColours(threadOf())]).toStrictEqual([['pa', 'border-chart-1'], ['pb', 'border-chart-2']])
  })
})

describe('citations', () => {
  it('cuts a text at its citations, numbering each review by its first citation', () => {
    expect(citedParts('a [fb:x] b [fb:y] c [fb:x]')).toStrictEqual([
      { kind: 'text', value: 'a ' }, { kind: 'cite', id: 'x', index: 1 }, { kind: 'text', value: ' b ' },
      { kind: 'cite', id: 'y', index: 2 }, { kind: 'text', value: ' c ' }, { kind: 'cite', id: 'x', index: 1 }])
    expect(citedParts('none')).toStrictEqual([{ kind: 'text', value: 'none' }])
  })

  it('renders a chip that opens the review', async () => {
    const user = userEvent.setup()
    renderWithQueryClient(<TestRouter><CitedText text="Late [fb:f1]." citations={new Map([['f1', CITED]])} /><LocationSearch /></TestRouter>)
    await user.click(screen.getByRole('button', { name: 'Open cited review 1' }))
    expect(await screen.findByTestId('search')).toHaveTextContent('review=f1')
  })

  it('shows each answer\'s round, colour and chips', () => {
    const responses = parsePersonaResponses(card(1, 'pa', 'Ada', 'Late [fb:f1].', [CITED]))
    renderWithQueryClient(<TestRouter><PersonaAnswers responses={responses} colours={new Map([['pa', 'border-chart-1']])} /></TestRouter>)
    expect(screen.getByText('Round 1')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveClass('border-l-4', 'border-chart-1')
    expect(screen.getByRole('button', { name: 'Open cited review 1' })).toBeInTheDocument()
  })
})

describe('the synthesis card', () => {
  it('shows the three lists, the synthetic label, and saves the whole group as a focus_group document', async () => {
    const user = userEvent.setup()
    routeFetchApi({ 'POST /projects/p1/documents': () => ({ success: true, document: { document_id: 'doc_1', document_type: 'focus_group',
      title: 't', content: 'c' } }) })
    renderWithQueryClient(<TestRouter><FocusGroupCard event={FINISHED} thread={threadOf()} messageId="m4" projectId="p1" /></TestRouter>)
    const region = screen.getByRole('region', { name: 'Focus group synthesis' })
    expect(within(region).getByText('Synthetic')).toBeInTheDocument()
    expect(within(region).getByText('Agreements')).toBeInTheDocument()
    await user.click(within(region).getByRole('button', { name: 'Save focus group' }))
    expect(await within(region).findByRole('button', { name: 'Saved to documents' })).toBeDisabled()
    const [, options] = fetchApi.mock.calls.find(([path]) => path === '/projects/p1/documents') ?? []
    const body = JSON.parse(String(options?.body)) as { document_type: string; derivation: unknown; content: string }
    expect({ type: body.document_type, derivation: body.derivation }).toStrictEqual({ type: 'focus_group', derivation: {
      persona_ids: ['pa', 'pb'], feedback_ids: ['f1'], document_ids: ['d1'], library_item_ids: [], rounds: 2 } })
  })

  it('files the transcript: the banner, each round with its follow-up, the synthesis and the reviews cited (ids only)', () => {
    const t = (key: string, options?: Record<string, unknown>) => `${key}${options === undefined ? '' : JSON.stringify(options)}`
    const markdown = transcriptMarkdown(t, FINISHED, turnOf(threadOf(), 'm4'))
    expect(markdown.split('\n').filter((line) => line !== '')).toStrictEqual([
      '# assistant:focusGroup.document.heading{"topic":"Shorter slots?"}',
      '> assistant:focusGroup.document.banner',
      '## assistant:focusGroup.round{"round":1}', '**Ada:** Late again [fb:f1].', '**Bea:** Fine by me.',
      '## assistant:focusGroup.round{"round":2}', '_assistant:focusGroup.moderator:_ What would change your mind?',
      '**Ada:** Tracking.', '**Bea:** Price.',
      '## assistant:focusGroup.synthesis.title', '### assistant:focusGroup.synthesis.agreements', '- Both want reliability [fb:f1]',
      '### assistant:focusGroup.synthesis.disagreements', '- Price',
      '## assistant:focusGroup.document.cited', '- [fb:f1]',
    ])
  })

  it('says a stopped group has no synthesis, and still saves the rounds it had', () => {
    renderWithQueryClient(<TestRouter><FocusGroupCard event={{ ...FINISHED, status: 'stopped', synthesis: undefined }}
      thread={threadOf()} messageId="m3" projectId="p1" /></TestRouter>)
    expect(screen.getByText(/Stopped before the end/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save focus group' })).toBeInTheDocument()
  })

  it('reads a stopped group\'s last round from the message it ended on', () => {
    expect(turnOf(threadOf(), 'm3').rounds.map((round) => round.round)).toStrictEqual([1, 2])
  })
})
