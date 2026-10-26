/**
 * AG-UI client: auth handling ported from the old streamClient (one silent
 * refresh on 401, then a visible sign-out), SSE chunk reassembly, and dropping
 * frames that are not valid AG-UI events.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

const { storeState } = vi.hoisted(() => {
  const state: { timeRange: string; customDays: number | null } = { timeRange: '30d', customDays: null }
  return { storeState: state }
})

vi.mock('../../store/configStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: { apiEndpoint: 'https://api.example.com' },
      timeRange: storeState.timeRange,
      customDays: storeState.customDays,
      dateBasis: 'review',
    }),
  },
}))

vi.mock('../../runtimeConfig', () => ({
  isConfigLoaded: vi.fn(() => true),
  isWebSearchAvailable: vi.fn(() => false),
  getRuntimeConfig: vi.fn(() => ({
    apiEndpoint: 'https://api.example.com',
    cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
  })),
}))

const { refreshSession } = vi.hoisted(() => ({ refreshSession: vi.fn<() => Promise<unknown>>() }))

vi.mock('../../services/auth', () => ({
  authService: {
    isConfigured: () => true,
    getIdToken: vi.fn(() => 'stale-token'),
    refreshSession,
  },
}))

vi.mock('../../services/sessionExpiry', () => ({ endExpiredSession: vi.fn() }))

import { buildRunInput, runAgent } from './client'
import { buildForwardedProps } from './forwardedProps'
import { parseSseBuffer, parseSseLine } from './sse'
import { authService } from '../../services/auth'
import { endExpiredSession } from '../../services/sessionExpiry'
import type { AguiEvent } from './sse'

const encoder = new TextEncoder()

/** A 200 response whose body yields the given raw chunks. */
function streamResponse(chunks: string[]) {
  const queue = [...chunks]
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          const next = queue.shift()
          return Promise.resolve(next === undefined ? { done: true, value: undefined } : { done: false, value: encoder.encode(next) })
        },
        releaseLock: () => undefined,
      }),
    },
  }
}

const input = buildRunInput({ threadId: 't1', runId: 'r1', messages: [], forwardedProps: { page: { kind: 'home', path: '/' } } })

async function collect(): Promise<AguiEvent[]> {
  const events: AguiEvent[] = []
  await runAgent(input, (e) => events.push(e))
  return events
}

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<unknown>>()

const SentInit = z.object({ method: z.string(), headers: z.record(z.string(), z.string()), body: z.string() })

/** The `index`-th fetch the client made, with its init parsed (not trusted). */
function sentRequest(index: number) {
  const call = fetchMock.mock.calls.at(index)
  if (call === undefined) throw new Error(`fetch call ${index} was not made`)
  const [url, init] = call
  return { url, ...SentInit.parse(init) }
}

describe('runAgent auth handling', () => {
  beforeEach(() => {
    vi.mocked(authService.getIdToken).mockReturnValue('stale-token')
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('POSTs the RunAgentInput to /chat/stream with SSE accept and the token', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse([]))
    await collect()
    const { url, method, headers, body } = sentRequest(0)
    expect({ url, method, accept: headers.Accept, authorization: headers.Authorization }).toStrictEqual({
      url: 'https://api.example.com/chat/stream',
      method: 'POST',
      accept: 'text/event-stream',
      authorization: 'stale-token',
    })
    expect(JSON.parse(body)).toMatchObject({ protocolVersion: '1.0', threadId: 't1', runId: 'r1', tools: [], context: [] })
  })

  it('refreshes once and retries with the fresh token after a 401', async () => {
    refreshSession.mockImplementation(() => {
      vi.mocked(authService.getIdToken).mockReturnValue('fresh-token')
      return Promise.resolve(undefined)
    })
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(streamResponse(['data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}\n\n']))

    const events = await collect()

    expect(events.map((e) => e.type)).toStrictEqual(['RUN_STARTED'])
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(endExpiredSession).not.toHaveBeenCalled()
    expect(sentRequest(1).headers.Authorization).toBe('fresh-token')
  })

  it('ends the session when the refresh fails', async () => {
    refreshSession.mockRejectedValue(new Error('no session'))
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 })
    await expect(collect()).rejects.toThrow('Session expired')
    expect(endExpiredSession).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ends the session when the retry is still 401', async () => {
    refreshSession.mockResolvedValue(undefined)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 }).mockResolvedValueOnce({ ok: false, status: 401 })
    await expect(collect()).rejects.toThrow('Session expired')
    expect(endExpiredSession).toHaveBeenCalledTimes(1)
  })

  it('treats 403 as access denied without signing out', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 })
    await expect(collect()).rejects.toThrow('Access denied')
    expect(endExpiredSession).not.toHaveBeenCalled()
    expect(refreshSession).not.toHaveBeenCalled()
  })

  it('reports other statuses as stream errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(collect()).rejects.toThrow('Stream error: 500')
  })
})

describe('SSE parsing', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('reassembles events split across network chunks', async () => {
    const frame = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"héllo"}\n\n'
    fetchMock.mockResolvedValueOnce(streamResponse([frame.slice(0, 17), frame.slice(17, 40), frame.slice(40)]))
    const events = await collect()
    expect(events).toStrictEqual([{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'héllo' }])
  })

  it('accepts a final frame without trailing newline', async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(['data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}']))
    expect((await collect()).map((e) => e.type)).toStrictEqual(['TEXT_MESSAGE_END'])
  })

  it.each([
    ['malformed JSON', 'data: {not json'],
    ['an unknown type', 'data: {"type":"NOT_AN_EVENT"}'],
    ['a wrongly shaped known type', 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1"}'],
    ['a comment line', ': keep-alive comment'],
  ])('drops %s', (_label, line) => {
    expect(parseSseLine(line)).toBeNull()
  })

  it('keeps only valid events from a buffer and returns the partial tail', () => {
    const { events, remainder } = parseSseBuffer('data: {"type":"BOGUS"}\ndata: {"type":"TEXT_MESSAGE_END","messageId":"m"}\ndata: {"ty')
    expect(events.map((e) => e.type)).toStrictEqual(['TEXT_MESSAGE_END'])
    expect(remainder).toBe('data: {"ty')
  })
})

describe('buildForwardedProps', () => {
  it('carries page, days, date basis, language and web search', () => {
    const props = buildForwardedProps({ page: { kind: 'project', path: '/projects/p1', projectId: 'p1', title: 'x'.repeat(300) }, language: 'de', useWebSearch: true })
    expect(props).toStrictEqual({
      page: { kind: 'project', path: '/projects/p1', projectId: 'p1', title: 'x'.repeat(120) },
      days: 30,
      dateBasis: 'review',
      responseLanguage: 'de',
      useWebSearch: true,
    })
  })

  it('omits useWebSearch when off and includes resume only when given', () => {
    const props = buildForwardedProps({ page: { kind: 'home', path: '/' }, language: undefined, useWebSearch: false })
    expect(props).not.toHaveProperty('useWebSearch')
    expect(buildRunInput({ threadId: 't', messages: [], forwardedProps: props })).not.toHaveProperty('resume')
    expect(buildRunInput({ threadId: 't', messages: [], forwardedProps: props, resume: [{ interruptId: 'approval:x', status: 'resolved' }] }).resume).toHaveLength(1)
  })

  it.each([
    [0, 0],
    [9999, 9999],
  ])('forwards a custom window of %i days unchanged (0 = all time)', (customDays, expected) => {
    storeState.timeRange = 'custom'
    storeState.customDays = customDays
    try {
      expect(buildForwardedProps({ page: { kind: 'home', path: '/' }, language: undefined, useWebSearch: false }).days).toBe(expected)
    } finally {
      storeState.timeRange = '30d'
      storeState.customDays = null
    }
  })
})
