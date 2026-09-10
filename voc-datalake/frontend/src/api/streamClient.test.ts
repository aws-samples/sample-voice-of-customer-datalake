/**
 * @fileoverview Tests for the SSE stream client's auth handling.
 *
 * The stream path used to be the one place a dead session produced a message
 * and nothing else: no refresh attempt, no sign-out, so the app kept rendering
 * as if signed in. These cases pin the corrected behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: { apiEndpoint: 'https://api.example.com' },
      dateBasis: 'imported',
    }),
  },
}))

// The origin-check in baseUrl.ts reads the runtime config for the trusted
// allowlist. Without this mock the allowlist is empty and no Authorization
// header is ever attached, breaking the retry/token-refresh assertions.
vi.mock('../runtimeConfig', () => ({
  isConfigLoaded: vi.fn(() => true),
  getRuntimeConfig: vi.fn(() => ({
    apiEndpoint: 'https://api.example.com',
    cognito: { userPoolId: 'pool-1', clientId: 'client-1', region: 'us-east-1', identityPoolId: 'id-pool' },
  })),
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: () => true,
    getIdToken: vi.fn(() => 'stale-token'),
    refreshSession: vi.fn(),
  },
}))

vi.mock('../services/sessionExpiry', () => ({
  endExpiredSession: vi.fn(),
}))

import { streamChat } from './streamClient'
import { authService } from '../services/auth'
import { endExpiredSession } from '../services/sessionExpiry'

/** Drain the generator so the fetch and its error handling actually run. */
async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const event of gen) events.push(event)
  return events
}

/** A response whose body yields one SSE `done` event. */
function okStream() {
  const encoder = new TextEncoder()
  let sent = false
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          if (sent) return Promise.resolve({ done: true, value: undefined })
          sent = true
          return Promise.resolve({
            done: false,
            value: encoder.encode('data: {"type":"done"}\n'),
          })
        },
        releaseLock: () => undefined,
      }),
    },
  }
}

describe('streamChat auth handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(authService.getIdToken as ReturnType<typeof vi.fn>).mockReturnValue('stale-token')
    global.fetch = vi.fn()
  })

  it('refreshes once and retries when the first attempt is unauthorized', async () => {
    ;(authService.refreshSession as ReturnType<typeof vi.fn>).mockImplementation(() => {
      ;(authService.getIdToken as ReturnType<typeof vi.fn>).mockReturnValue('fresh-token')
      return Promise.resolve(undefined)
    })
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(okStream())

    const events = await drain(streamChat('https://api.example.com/chat/stream', { message: 'hi' }))

    expect(events).toEqual([{ type: 'done' }])
    expect(authService.refreshSession).toHaveBeenCalledWith()
    expect(endExpiredSession).not.toHaveBeenCalled()

    // The retry must carry the new token, not the one that just 401'd.
    const [, retryInit] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(retryInit.headers.Authorization).toBe('fresh-token')
  })

  it('ends the session when the refresh itself fails', async () => {
    ;(authService.refreshSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no session'))
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 401 })

    await expect(
      drain(streamChat('https://api.example.com/chat/stream', { message: 'hi' })),
    ).rejects.toThrow('Session expired')

    expect(endExpiredSession).toHaveBeenCalledWith()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('ends the session when the retry is still unauthorized', async () => {
    ;(authService.refreshSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: false, status: 401 })

    await expect(
      drain(streamChat('https://api.example.com/chat/stream', { message: 'hi' })),
    ).rejects.toThrow('Session expired')

    expect(endExpiredSession).toHaveBeenCalledWith()
  })

  it('leaves non-401 failures alone', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 })

    await expect(
      drain(streamChat('https://api.example.com/chat/stream', { message: 'hi' })),
    ).rejects.toThrow('Stream error: 500')

    expect(authService.refreshSession).not.toHaveBeenCalled()
    expect(endExpiredSession).not.toHaveBeenCalled()
  })

  it('still reports 403 as an auth problem without ending the session', async () => {
    // 403 is authorization, not an expired token — WAF and IAM produce it too,
    // so signing the user out would be the wrong response.
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 403 })

    await expect(
      drain(streamChat('https://api.example.com/chat/stream', { message: 'hi' })),
    ).rejects.toThrow('Access denied')

    expect(endExpiredSession).not.toHaveBeenCalled()
  })
})
