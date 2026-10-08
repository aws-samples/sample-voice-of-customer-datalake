/**
 * Thread reducer over full AG-UI event sequences, as the stream Lambda emits
 * them (COMMON "AG-UI event sequence"), including the interrupt path.
 */
import { describe, it, expect } from 'vitest'
import { EventType } from '@ag-ui/core'
import { allInterruptsResolved, createThreadState, threadReducer } from './reducer'
import { buildResume, expiredResolution, isExpired, resumeEntryFor } from './resume'
import { keepNewestTurns, toWireMessages } from './wire'
import type { AguiEvent } from '../agui/sse'
import type { Message } from '@ag-ui/core'
import type { ThreadState } from './types'
import { at, defined } from '@test/defined'

function run(events: AguiEvent[], start: ThreadState = createThreadState('t1')): ThreadState {
  return events.reduce((s, event) => threadReducer(s, { type: 'event', event }), start)
}

const started: AguiEvent = { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' }
const context: AguiEvent = { type: EventType.CUSTOM, name: 'assistant.context', value: { page: {}, packs: ['core', 'project'], model: 'm', webSearch: false } }

describe('threadReducer — text, reasoning, server tools', () => {
  const sequence: AguiEvent[] = [
    started,
    context,
    { type: EventType.REASONING_START, messageId: 'rs1' },
    { type: EventType.REASONING_MESSAGE_START, messageId: 'rs1', role: 'reasoning' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'rs1', delta: 'Let me ' },
    { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'rs1', delta: 'look.' },
    { type: EventType.REASONING_MESSAGE_END, messageId: 'rs1' },
    { type: EventType.REASONING_END, messageId: 'rs1' },
    // Turn 1: tool calls only, no text message.
    { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'search_feedback', parentMessageId: 'a1' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"query":' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '"late delivery"}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
    { type: EventType.TOOL_CALL_RESULT, messageId: 'tm1', toolCallId: 'tc1', content: '{"items":[]}', role: 'tool' },
    // Turn 2: answer text.
    { type: EventType.TEXT_MESSAGE_START, messageId: 'a2', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a2', delta: 'Customers ' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a2', delta: 'complain.' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'a2' },
    { type: EventType.CUSTOM, name: 'assistant.navigation', value: { path: '/categories', label: 'Categories' } },
    { type: EventType.CUSTOM, name: 'assistant.navigation', value: { path: '//evil.example', label: 'x' } },
    { type: EventType.CUSTOM, name: 'assistant.sources', value: { feedback: [{ feedback_id: 'f1', original_text: 'late', source_platform: 'web' }, { nope: 1 }], web: [{ title: 'T', url: 'https://example.com' }, { title: 'bad', url: 'javascript:alert(1)' }] } },
    { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1', outcome: { type: 'success' }, usage: [{ inputTokens: 10, cachedInputTokens: 8 }] },
  ]
  const state = run(sequence)

  it('builds AG-UI messages in model order: assistant(toolUse) → tool → assistant(text)', () => {
    expect(state.messages.map((m) => [m.role, m.id])).toStrictEqual([['assistant', 'a1'], ['tool', 'tm1'], ['assistant', 'a2']])
    expect(state.messages[0]).toMatchObject({ toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'search_feedback', arguments: '{"query":"late delivery"}' } }] })
    expect(state.messages[2]).toMatchObject({ content: 'Customers complain.' })
  })

  it('parses tool args at TOOL_CALL_END and records results', () => {
    expect(state.toolCallArgs.tc1).toStrictEqual({ query: 'late delivery' })
    expect(state.toolCallStatus.tc1).toBe('complete')
    expect(state.toolResults.tc1).toBe('{"items":[]}')
  })

  it('attaches reasoning to the assistant message it preceded', () => {
    expect(state.reasoningByMessage).toStrictEqual({ a1: 'Let me look.' })
  })

  it('anchors sources and safe navigation on the last assistant message', () => {
    expect(state.navigation).toStrictEqual({ a2: [{ path: '/categories', label: 'Categories' }] })
    expect(defined(state.sources.a2, 'sources.a2').feedback).toStrictEqual([{ feedback_id: 'f1', text: 'late', source_platform: 'web', sentiment_label: undefined, rating: undefined }])
    expect(defined(state.sources.a2, 'sources.a2').web).toStrictEqual([{ title: 'T', url: 'https://example.com' }])
  })

  it('finishes idle with context and usage', () => {
    expect(state.status).toBe('idle')
    expect(state.context).toStrictEqual({ model: 'm', packs: ['core', 'project'], webSearch: false })
    expect(state.usage).toStrictEqual([{ inputTokens: 10, cachedInputTokens: 8 }])
  })

  it('keeps an unparsable args buffer as undefined instead of throwing', () => {
    const s = run([
      started,
      { type: EventType.TOOL_CALL_START, toolCallId: 'x', toolCallName: 'get_metrics' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'x', delta: '{"broken' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'x' },
    ])
    expect(s.toolCallArgs.x).toBeUndefined()
    // No parent id and no prior assistant message: one is minted.
    expect(s.messages).toHaveLength(1)
  })

  it('returns the same state for events it does not handle', () => {
    const s = createThreadState('t')
    expect(threadReducer(s, { type: 'event', event: { type: EventType.STEP_STARTED, stepName: 'x' } })).toBe(s)
  })
})

const interruptSequence: AguiEvent[] = [
  started,
  { type: EventType.TEXT_MESSAGE_START, messageId: 'a1', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a1', delta: 'I can create those.' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'a1' },
  { type: EventType.TOOL_CALL_START, toolCallId: 'w1', toolCallName: 'create_document', parentMessageId: 'a1' },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: 'w1', delta: '{"project_id":"p1","title":"T","content":"C"}' },
  { type: EventType.TOOL_CALL_END, toolCallId: 'w1' },
  { type: EventType.TOOL_CALL_START, toolCallId: 'w2', toolCallName: 'delete_document', parentMessageId: 'a1' },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: 'w2', delta: '{"project_id":"p1","document_id":"d1","reason":"dup"}' },
  { type: EventType.TOOL_CALL_END, toolCallId: 'w2' },
  {
    type: EventType.RUN_FINISHED,
    threadId: 't1',
    runId: 'r1',
    outcome: {
      type: 'interrupt',
      interrupts: [
        { id: 'approval:w1', reason: 'tool_approval', toolCallId: 'w1', message: 'Create "T"', expiresAt: '2999-01-01T00:00:00Z', metadata: { toolName: 'create_document', risk: 'write', projectId: 'p1' } },
        { id: 'approval:w2', reason: 'tool_approval', toolCallId: 'w2', metadata: { toolName: 'delete_document', risk: 'destructive' } },
        { id: 'other', reason: 'something_else' },
      ],
    },
  },
]

describe('threadReducer — RUN_ERROR', () => {
  it('cancels tool calls still in flight when the run errors', () => {
    const state = run([
      started,
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'search_feedback', parentMessageId: 'a1' },
      { type: EventType.TOOL_CALL_START, toolCallId: 'tc2', toolCallName: 'list_projects', parentMessageId: 'a1' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tc2' },
      { type: EventType.RUN_ERROR, message: 'Bedrock failed', code: 'service_error' },
    ])
    expect(state.toolCallStatus).toStrictEqual({ tc1: 'cancelled', tc2: 'cancelled' })
    expect(state.status).toBe('error')
    expect(state.error).toStrictEqual({ message: 'Bedrock failed', code: 'service_error' })
  })
})

describe('threadReducer — interrupts and resume', () => {
  const state = run(interruptSequence)

  it('parks tool-approval interrupts and awaits approval', () => {
    expect(state.status).toBe('awaiting_approval')
    expect(state.pendingInterrupts.map((i) => i.id)).toStrictEqual(['approval:w1', 'approval:w2'])
    expect(at(state.pendingInterrupts, 0).metadata).toStrictEqual({ toolName: 'create_document', risk: 'write', projectId: 'p1' })
    expect(state.toolCallStatus).toMatchObject({ w1: 'awaiting_approval', w2: 'awaiting_approval' })
  })

  const resolveFirst = () => threadReducer(state, { type: 'local/resolution', resolution: { interruptId: 'approval:w1', toolCallId: 'w1', outcome: { status: 'executed', summary: 'Created T' } } })
  const resolveBoth = () => threadReducer(resolveFirst(), { type: 'local/resolution', resolution: { interruptId: 'approval:w2', toolCallId: 'w2', outcome: { status: 'declined' } } })

  it('counts as resolved only when every interrupt has a resolution', () => {
    expect(allInterruptsResolved(resolveFirst())).toBe(false)
    expect(allInterruptsResolved(resolveBoth())).toBe(true)
  })

  it('builds resume entries and tool messages in interrupt order', () => {
    const both = resolveBoth()
    const { toolMessages, resume } = buildResume(both.pendingInterrupts, both.resolutions)
    expect(resume).toStrictEqual([
      { interruptId: 'approval:w1', status: 'resolved', payload: { approved: true } },
      { interruptId: 'approval:w2', status: 'resolved', payload: { approved: false } },
    ])
    expect(toolMessages.map((m) => (m.role === 'tool' ? [m.toolCallId, JSON.parse(String(m.content))] : null))).toStrictEqual([
      ['w1', { status: 'executed', summary: 'Created T' }],
      ['w2', { status: 'declined' }],
    ])
  })

  it('applying the resolutions clears the interrupts and appends the tool messages', () => {
    const both = resolveBoth()
    const { toolMessages } = buildResume(both.pendingInterrupts, both.resolutions)
    const applied = threadReducer(both, { type: 'local/apply_resolutions', toolMessages })
    expect(applied.pendingInterrupts).toStrictEqual([])
    expect(applied.toolCallStatus).toMatchObject({ w1: 'executed', w2: 'declined' })
    expect(applied.messages.slice(-2).map((m) => m.role)).toStrictEqual(['tool', 'tool'])
  })

  it('maps expired approvals to cancelled resume entries', () => {
    const interrupt = { id: 'approval:x', toolCallId: 'x', expiresAt: '2000-01-01T00:00:00Z' }
    expect(isExpired(interrupt)).toBe(true)
    expect(isExpired({ ...interrupt, expiresAt: undefined })).toBe(false)
    expect(resumeEntryFor(expiredResolution(interrupt))).toStrictEqual({ interruptId: 'approval:x', status: 'cancelled', payload: { approved: false } })
  })

  it('RUN_ERROR sets the error', () => {
    const errored = run([started, { type: EventType.RUN_ERROR, message: 'Throttled', code: 'THROTTLED' }])
    expect(errored.status).toBe('error')
    expect(errored.error).toStrictEqual({ message: 'Throttled', code: 'THROTTLED' })
  })

  it('abort cancels in-flight tool calls and keeps partial text', () => {
    const partial = run([
      started,
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a1', delta: 'Half an ans' },
      { type: EventType.TOOL_CALL_START, toolCallId: 'q', toolCallName: 'get_metrics', parentMessageId: 'a1' },
    ])
    const aborted = threadReducer(partial, { type: 'local/aborted' })
    expect(aborted.status).toBe('idle')
    expect(aborted.toolCallStatus.q).toBe('cancelled')
    expect(aborted.messages[0]).toMatchObject({ content: 'Half an ans' })
  })

  it('a stream that closes without RUN_FINISHED is an error', () => {
    const s = threadReducer(run([started]), { type: 'local/stream_closed' })
    expect(s.status).toBe('error')
    expect(s.error?.code).toBe('STREAM_CLOSED')
    const finished = run(interruptSequence)
    expect(threadReducer(finished, { type: 'local/stream_closed' })).toBe(finished)
  })
})

describe('wire messages', () => {
  const user = (id: string): Message => ({ id, role: 'user', content: id })
  const assistant = (id: string): Message => ({ id, role: 'assistant', content: id, metadata: { voc: {} } })

  it('drops UI metadata, clamps tool content and replaces stripped attachments', () => {
    const wire = toWireMessages([
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'data', value: '', mimeType: 'image/png' }, metadata: { name: 'shot.png' } }] },
      assistant('a'),
      { id: 't', role: 'tool', toolCallId: 'c', content: 'x'.repeat(30_000) },
    ])
    expect(wire[0]).toStrictEqual({ id: 'u', role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'text', text: '[attachment "shot.png" not available in restored conversation]' }] })
    expect(wire[1]).toStrictEqual({ id: 'a', role: 'assistant', content: 'a' })
    expect(at(wire, 2).role === 'tool' && String(at(wire, 2).content).length).toBe(20_000)
  })

  it('keeps whole newest turns within the cap', () => {
    const messages = [user('u1'), assistant('a1'), user('u2'), assistant('a2'), user('u3'), assistant('a3')]
    expect(keepNewestTurns(messages, 3).map((m) => m.id)).toStrictEqual(['u3', 'a3'])
    expect(keepNewestTurns(messages, 10)).toHaveLength(6)
  })

  it('keeps the user message and whole assistant+tool groups when the newest turn alone exceeds the cap', () => {
    const call = (id: string): Message => ({ id, role: 'assistant', toolCalls: [{ id: `c${id}`, type: 'function', function: { name: 'search_feedback', arguments: '{}' } }] })
    const result = (id: string): Message => ({ id: `t${id}`, role: 'tool', toolCallId: `c${id}`, content: 'r' })
    const messages = [user('u1'), call('1'), result('1'), call('2'), result('2'), call('3'), result('3'), assistant('done')]
    expect(keepNewestTurns(messages, 5).map((m) => m.id)).toStrictEqual(['u1', '3', 't3', 'done'])
  })
})

describe('signed thinking (REASONING_ENCRYPTED_VALUE)', () => {
  const encrypted: AguiEvent = { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'message', entityId: 'm1', encryptedValue: 'opaque==' }
  const toolStart: AguiEvent = { type: EventType.TOOL_CALL_START, toolCallId: 'c1', toolCallName: 'update_project', parentMessageId: 'm1' }

  it('stores the value on the assistant message it names, creating it when the turn has no text', () => {
    const state = run([started, encrypted, toolStart])
    expect(state.messages).toStrictEqual([{
      id: 'm1', role: 'assistant', content: '', encryptedValue: 'opaque==',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'update_project', arguments: '' } }],
    }])
  })

  it('ignores a tool-call subtype', () => {
    const toolCallValue: AguiEvent = { type: EventType.REASONING_ENCRYPTED_VALUE, subtype: 'tool-call', entityId: 'c1', encryptedValue: 'x' }
    const before = run([started])
    expect(threadReducer(before, { type: 'event', event: toolCallValue })).toBe(before)
  })

  it('sends the value back unchanged on the wire', () => {
    const wire = toWireMessages(run([started, encrypted, toolStart]).messages)
    expect(wire[0]).toMatchObject({ id: 'm1', role: 'assistant', encryptedValue: 'opaque==' })
  })
})
