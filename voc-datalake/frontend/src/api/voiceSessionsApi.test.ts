import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, resetFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { voiceKeys, voiceSessionsApi } from './voiceSessionsApi'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const PERSONA = { kind: 'persona', personaId: 'x' } as const

beforeEach(() => {
  resetFetchApi()
})

describe('voiceSessionsApi', () => {
  it('reads a persona\'s offer leniently, with the flag off as `enabled: false`', async () => {
    fetchApi.mockResolvedValueOnce({ enabled: false })
    const offer = await voiceSessionsApi.getOffer('p 1', { kind: 'persona', personaId: 'a/b' })
    expect(offer).toMatchObject({ enabled: false, voice_id: 'tiffany', minutes_left: 0, languages: { supported: [] } })
    expect(fetchApi).toHaveBeenCalledWith('/projects/p%201/personas/a%2Fb/voice-sessions', undefined)
  })

  it('starts a session with consent and the UI language', async () => {
    fetchApi.mockResolvedValueOnce({
      session_id: 's1', connect_url: 'wss://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/x/ws?a=1', expires_in: 60,
      minutes_left: 280, session_minutes: 15, voice_id: 'matthew', voice_gender: 'masculine',
      languages: { supported: ['en'], unsupported: ['ja'] }, estimated_cents_per_minute: 2,
    })
    const started = await voiceSessionsApi.start('p1', PERSONA, 'de')
    expect(started).toMatchObject({ session_id: 's1', voice_id: 'matthew', expires_in: 60 })
    expect(sentFetchApiBody('/projects/p1/personas/x/voice-sessions', 'POST')).toStrictEqual({ consent: true, language: 'de' })
  })

  it('refuses a start answer without a WebSocket URL', async () => {
    fetchApi.mockResolvedValueOnce({ session_id: 's1', connect_url: 'https://example.com' })
    await expect(voiceSessionsApi.start('p1', PERSONA, 'en')).rejects.toThrow(/connect_url/)
  })

  it('reads a session, ends it and reads the month', async () => {
    fetchApi
      .mockResolvedValueOnce({ session_id: 's1', status: 'finalized', seconds: 61, cost_cents: 2.5, end_reason: 'budget',
        transcript_document_id: 'doc_9' })
      .mockResolvedValueOnce({ success: true, status: 'finalizing', job_id: 'job_1' })
      .mockResolvedValueOnce({ enabled: true, month: '2026-11', minutes_used: 12, monthly_minutes: 300, live_sessions: 'x' })
    const session = await voiceSessionsApi.getSession('p1', PERSONA, 's1')
    const ended = await voiceSessionsApi.end('p1', PERSONA, 's1')
    const usage = await voiceSessionsApi.getUsage()
    expect({ session, ended, usage: { ...usage, keys: [voiceKeys.usage(), voiceKeys.session('s1')] } }).toMatchObject({
      session: { status: 'finalized', transcript_document_id: 'doc_9', end_reason: 'budget', job_id: null },
      ended: { status: 'finalizing', job_id: 'job_1' },
      usage: { minutes_used: 12, monthly_minutes: 300, live_sessions: 0, keys: [['voice-usage'], ['voice-session', 's1']] },
    })
  })

  it('runs the product interviewer on its own routes, sending its questions with the start', async () => {
    const product = { kind: 'product', questions: [{ field: 'product_name', question: 'What is it called?' }] } as const
    fetchApi
      .mockResolvedValueOnce({ enabled: true, voice_id: 'matthew' })
      .mockResolvedValueOnce({ session_id: 's2', connect_url: 'wss://x/ws', voice_id: 'matthew' })
      .mockResolvedValueOnce({ session_id: 's2', kind: 'product_interview', status: 'finalized', source_doc_id: 'doc_7' })
    await voiceSessionsApi.getOffer('p1', product)
    await voiceSessionsApi.start('p1', product, 'en')
    const session = await voiceSessionsApi.getSession('p1', product, 's2')
    expect(fetchApi.mock.calls.map((call) => call[0])).toStrictEqual([
      '/projects/p1/product-interview/voice-sessions', '/projects/p1/product-interview/voice-sessions',
      '/projects/p1/product-interview/voice-sessions/s2',
    ])
    expect(sentFetchApiBody('/projects/p1/product-interview/voice-sessions', 'POST')).toStrictEqual({
      consent: true, language: 'en', questions: [{ field: 'product_name', question: 'What is it called?' }],
    })
    expect(session).toMatchObject({ kind: 'product_interview', source_doc_id: 'doc_7', transcript_document_id: null })
    expect([voiceKeys.offer('p1', product), voiceKeys.offer('p1', PERSONA)]).toStrictEqual([
      ['voice-offer', 'p1', 'product'], ['voice-offer', 'p1', 'x'],
    ])
  })

  it('reads a session from before 7.104.00 as a persona\'s, with no source', async () => {
    fetchApi.mockResolvedValueOnce({ session_id: 's1', status: 'live' })
    expect(await voiceSessionsApi.getSession('p1', PERSONA, 's1')).toMatchObject({ kind: 'persona_interview', source_doc_id: null })
  })
})
