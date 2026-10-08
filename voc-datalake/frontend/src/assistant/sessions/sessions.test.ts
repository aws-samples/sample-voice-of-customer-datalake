/**
 * Sessions: lenient boundary schemas, save-body trimming, 413 retry, and
 * restoring a thread (including re-raised and expired approvals).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/client', () => ({ fetchApi: vi.fn() }))

import { fetchApi } from '../../api/client'
import { normalizeSessionList, normalizeSessionRecord, isValidSessionId } from './schema'
import {
  MAX_RETRY_TOOL_CHARS, MAX_STORED_TOOL_CHARS, dropOldestTurns, sessionTitle, threadFromSession, toSaveBody,
} from './serialize'
import { deleteSession, getSession, listSessions, saveSession } from './sessionsApi'
import { createThreadState } from '../thread/reducer'
import type { Message } from '@ag-ui/core'
import type { SaveSessionBody } from './serialize'
import { at, defined } from '@test/defined'

const fetchMock = vi.mocked(fetchApi)

describe('session schemas', () => {
  it('normalises the list leniently, newest first, assistant kind only', () => {
    const list = normalizeSessionList({
      conversations: [
        { id: 'old', title: 'Old', kind: 'assistant', messageCount: 2, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        { id: 'new', title: 42, kind: 'assistant', updatedAt: '2026-02-01' },
        { id: 'chat', title: 'legacy chat', kind: 'chat', updatedAt: '2026-03-01' },
        { id: 'bad id!', title: 'x' },
        'junk',
      ],
    })
    expect(list.map((s) => s.id)).toStrictEqual(['new', 'old'])
    expect(list[0]).toStrictEqual({ id: 'new', title: '', kind: 'assistant', messageCount: 0, createdAt: '', updatedAt: '2026-02-01' })
    expect(normalizeSessionList(null)).toStrictEqual([])
  })

  it('normalises a record, dropping invalid messages and unknown interrupts', () => {
    const record = normalizeSessionRecord({
      id: 't1',
      title: 'Q',
      messages: [{ id: 'u', role: 'user', content: 'hi' }, { id: 'x', role: 'alien' }, { role: 'user' }],
      page: { kind: 'project', path: '/projects/p', projectId: 'p' },
      pendingInterrupts: [{ id: 'approval:c', reason: 'tool_approval', toolCallId: 'c' }, { id: 'z', reason: 'other', toolCallId: 'z' }],
      createdAt: 'c',
      updatedAt: 'u',
    })
    expect(record?.messages).toStrictEqual([{ id: 'u', role: 'user', content: 'hi' }])
    expect(record?.page).toStrictEqual({ kind: 'project', path: '/projects/p', projectId: 'p' })
    expect(record?.pendingInterrupts.map((i) => i.id)).toStrictEqual(['approval:c'])
    expect(normalizeSessionRecord({ id: '../etc' })).toBeNull()
  })

  it('validates session ids against the route pattern', () => {
    expect(isValidSessionId(crypto.randomUUID())).toBe(true)
    expect(isValidSessionId('a/b')).toBe(false)
    expect(isValidSessionId('x'.repeat(65))).toBe(false)
  })
})

describe('save body', () => {
  const state = {
    ...createThreadState('t1'),
    messages: [
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'What   about\nthis screenshot of the checkout page that keeps failing on mobile?' }, { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' }, metadata: { name: 'shot.png' } }] },
      { id: 'a', role: 'assistant', content: 'ok' },
      { id: 't', role: 'tool', toolCallId: 'c', content: 'y'.repeat(10_000) },
    ] satisfies Message[],
    sources: { a: { feedback: [{ feedback_id: 'f1' }], web: [] } },
  }
  const saved = () => toSaveBody(state, { kind: 'home', path: '/' }, '2026-01-01T00:00:00Z')

  it('titles an assistant session from the first user message, collapsed and capped', () => {
    const body = saved()
    expect(body.kind).toBe('assistant')
    expect(body.title.length).toBeLessThanOrEqual(60)
    expect(body.title.startsWith('What about this screenshot')).toBe(true)
    expect(sessionTitle([])).toBe('')
  })

  it('strips attachment data but keeps its type and name', () => {
    expect(saved().messages[0]).toMatchObject({ content: [{ type: 'text' }, { type: 'image', source: { type: 'data', value: '', mimeType: 'image/png' }, metadata: { name: 'shot.png' } }] })
  })

  it('keeps sources on the answer and trims tool contents', () => {
    const { messages } = saved()
    expect(messages[1]).toMatchObject({ metadata: { voc: { sources: { feedback: [{ feedback_id: 'f1' }], web: [] } } } })
    expect(messages[2]).toMatchObject({ role: 'tool', content: 'y'.repeat(MAX_STORED_TOOL_CHARS) })
  })

  it('keeps an assistant message encryptedValue through save and restore', () => {
    const state = {
      ...createThreadState('t1'),
      messages: [
        { id: 'u', role: 'user', content: 'rename it' },
        { id: 'a', role: 'assistant', content: '', encryptedValue: 'opaque==' },
      ] satisfies Message[],
    }
    const body = toSaveBody(state, null, '2026-01-01T00:00:00Z')
    expect(body.messages[1]).toStrictEqual({ id: 'a', role: 'assistant', content: '', encryptedValue: 'opaque==' })
    const record = normalizeSessionRecord({ ...body, updatedAt: '2026-01-01T00:00:00Z' })
    expect(record?.messages[1]).toMatchObject({ id: 'a', encryptedValue: 'opaque==' })
  })

  it('drops the oldest half of the turns, keeping a user-first list', () => {
    const msgs: Message[] = ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4'].map((id) => (id.startsWith('u')
      ? { id, role: 'user', content: id }
      : { id, role: 'assistant', content: id }))
    expect(dropOldestTurns(msgs).map((m) => m.id)).toStrictEqual(['u3', 'a3', 'u4', 'a4'])
  })

  it('keeps the only user message and every tool pair of a single-turn thread, shrinking tool contents instead', () => {
    const msgs: Message[] = [
      { id: 'u1', role: 'user', content: 'compare all personas' },
      { id: 'a1', role: 'assistant', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'list_personas', arguments: '{}' } }] },
      { id: 't1', role: 'tool', toolCallId: 'c1', content: 'p'.repeat(4000) },
      { id: 'a2', role: 'assistant', content: 'summary' },
    ]
    const retried = dropOldestTurns(msgs)
    expect(retried.map((m) => m.id)).toStrictEqual(['u1', 'a1', 't1', 'a2'])
    expect(at(retried, 2).role === 'tool' && String(at(retried, 2).content).length).toBe(MAX_RETRY_TOOL_CHARS)
  })

  it('windows the saved messages to the newest turns within 300 messages', () => {
    const messages: Message[] = Array.from({ length: 160 }, (_, i): Message[] => [
      { id: `u${i}`, role: 'user', content: `q${i}` },
      { id: `a${i}`, role: 'assistant', content: `a${i}` },
    ]).flat()
    const body = toSaveBody({ ...createThreadState('t1'), messages }, null, '2026-01-01T00:00:00Z')
    expect(body.messages).toHaveLength(300)
    expect(body.messages[0]).toMatchObject({ id: 'u10', role: 'user' })
    expect(body.messages.at(-1)).toMatchObject({ id: 'a159' })
  })
})

describe('sessions API', () => {
  beforeEach(() => fetchMock.mockReset())

  const body: SaveSessionBody = {
    id: 't1',
    kind: 'assistant',
    title: 'T',
    messages: [
      { id: 'u1', role: 'user', content: '1' }, { id: 'a1', role: 'assistant', content: '1' },
      { id: 'u2', role: 'user', content: '2' }, { id: 'a2', role: 'assistant', content: '2' },
    ],
    page: null,
    pendingInterrupts: [],
    baseRevision: 0,
    createdAt: 'c',
  }

  it('lists, gets and deletes through the conversations routes', async () => {
    fetchMock.mockResolvedValueOnce({ conversations: [] })
    await listSessions()
    expect(fetchMock).toHaveBeenLastCalledWith('/chat/conversations/_list?kind=assistant')
    fetchMock.mockResolvedValueOnce({ id: 't1', messages: [] })
    expect((await getSession('t1'))?.id).toBe('t1')
    fetchMock.mockResolvedValueOnce({})
    await deleteSession('t1')
    expect(fetchMock).toHaveBeenLastCalledWith('/chat/conversations/t1', { method: 'DELETE' })
    await expect(getSession('../x')).rejects.toThrow('Invalid session id')
  })

  it('retries once with fewer messages after a 413', async () => {
    fetchMock.mockRejectedValueOnce(new Error('API Error: 413')).mockResolvedValueOnce({})
    await saveSession(body)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retried: unknown = JSON.parse(String(at(fetchMock.mock.calls, 1)[1]?.body))
    expect(retried).toMatchObject({ id: 't1', messages: [{ id: 'u2' }, { id: 'a2' }] })
  })

  it('does not retry other failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('API Error: 500'))
    await expect(saveSession(body)).rejects.toThrow('API Error: 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('threadFromSession', () => {
  const messages: Message[] = [
    { id: 'u', role: 'user', content: 'make docs' },
    {
      id: 'a',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 's1', type: 'function', function: { name: 'get_documents', arguments: '{}' } },
        { id: 'w1', type: 'function', function: { name: 'create_document', arguments: '{"title":"T"}' } },
        { id: 'w2', type: 'function', function: { name: 'delete_document', arguments: '{"document_id":"d"}' } },
      ],
      metadata: { voc: { navigation: [{ path: '/projects', label: 'Projects' }] } },
    },
    { id: 'r1', role: 'tool', toolCallId: 's1', content: '[]' },
  ]

  const restored = () => threadFromSession({
    id: 't1',
    title: '',
    kind: 'assistant',
    messages,
    page: null,
    pendingInterrupts: [
      { id: 'approval:w1', toolCallId: 'w1', expiresAt: '2999-01-01T00:00:00Z' },
      { id: 'approval:w2', toolCallId: 'w2', expiresAt: '2000-01-01T00:00:00Z' },
    ],
    createdAt: '',
    updatedAt: '',
    runStatus: null,
    revision: 0,
  })

  it('re-raises pending approvals in order and awaits them', () => {
    const state = restored()
    expect(state.status).toBe('awaiting_approval')
    expect(state.pendingInterrupts.map((i) => i.id)).toStrictEqual(['approval:w1', 'approval:w2'])
  })

  it('brings expired approvals back already declined with reason "expired"', () => {
    const { resolutions } = restored()
    expect(Object.keys(resolutions)).toStrictEqual(['approval:w2'])
    expect(defined(resolutions['approval:w2'], 'approval:w2').outcome).toStrictEqual({ status: 'declined', reason: 'expired' })
  })

  it('restores tool-call args, statuses and navigation', () => {
    const state = restored()
    expect(state.toolCallArgs.w1).toStrictEqual({ title: 'T' })
    expect(state.toolCallStatus).toMatchObject({ s1: 'complete', w1: 'awaiting_approval' })
    expect(state.navigation.a).toStrictEqual([{ path: '/projects', label: 'Projects' }])
  })

  it('ignores interrupts that already have a tool result', () => {
    const state = threadFromSession({
      id: 't1', title: '', kind: 'assistant', messages, page: null,
      pendingInterrupts: [{ id: 'approval:s1', toolCallId: 's1' }], createdAt: '', updatedAt: '', runStatus: null, revision: 0,
    })
    expect(state.status).toBe('idle')
    expect(state.pendingInterrupts).toStrictEqual([])
  })
})
