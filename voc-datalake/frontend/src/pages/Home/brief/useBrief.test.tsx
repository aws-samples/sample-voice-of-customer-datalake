/**
 * @fileoverview useBrief / useBriefPreferences against routed fetchApi: the wire shapes,
 * Refresh outcomes, and card states written to the caller's own brief.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactNode } from 'react'
import i18n from 'i18next'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', async (importOriginal) => {
  const { clientWithMockedFetchApi } = await import('@test/fetchApiRoutes')
  return clientWithMockedFetchApi(importOriginal)
})
vi.mock('../../../store/authStore', () => ({ useAuthStore: () => ({ user: { sub: 'sub-ana' } }) }))

const { useBrief } = await import('./useBrief')
const { useBriefPreferences } = await import('./useBriefPreferences')

const CARD = { id: 'whats_new_0123456789abcdef', kind: 'whats_new', title: '12 reviews' }
const READY = { status: 'ready', day: '2026-10-17', generated_at: '2026-10-17T08:00:00+00:00', cards: [CARD], card_state: {} }

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

const bodiesOf = (method: string, path: string): unknown[] => fetchApi.mock.calls
  .filter(([endpoint, options]) => endpoint === path && options?.method === method)
  .map(([, options]): unknown => (typeof options?.body === 'string' ? JSON.parse(options.body) : null))

beforeEach(() => {
  resetFetchApi()
})

describe('useBrief', () => {
  it('normalises the brief, keeping a malformed card out', async () => {
    routeFetchApi({ 'GET /settings/my-briefing/brief': () => ({ ...READY, cards: [CARD, { title: 'no id' }] }) })
    const { result } = renderHook(() => useBrief(), { wrapper })
    await waitFor(() => expect(result.current.brief.status).toBe('ready'))
    expect(result.current.brief.cards.map((c) => c.id)).toStrictEqual([CARD.id])
  })

  /** The hook after a ready brief loaded and Refresh answered `answer`. */
  async function refreshedWith(answer: unknown) {
    routeFetchApi({ 'GET /settings/my-briefing/brief': () => READY, 'POST /settings/my-briefing/refresh': () => answer })
    const hook = renderHook(() => useBrief(), { wrapper })
    await waitFor(() => expect(hook.result.current.brief.status).toBe('ready'))
    act(() => { hook.result.current.refresh() })
    return hook.result
  }

  it('reports an up-to-date refresh and keeps the brief', async () => {
    const result = await refreshedWith({ status: 'up_to_date', brief: READY })
    await waitFor(() => expect(result.current.refreshOutcome).toBe('up_to_date'))
    expect(result.current.brief.cards).toHaveLength(1)
  })

  it('is generating after a refresh starts a build, with the old cards still shown', async () => {
    const result = await refreshedWith({ status: 'pending', brief: { status: 'pending', cards: [] } })
    await waitFor(() => expect(result.current.generating && result.current.refreshOutcome === 'started').toBe(true))
    expect(result.current.brief.cards).toHaveLength(1)
  })

  it("writes card states to the day's brief and shows them at once", async () => {
    routeFetchApi({
      'GET /settings/my-briefing/brief': () => READY,
      'PUT /settings/my-briefing/cards': () => ({ day: READY.day, card_state: { [CARD.id]: 'dismissed' } }),
    })
    const { result } = renderHook(() => useBrief(), { wrapper })
    await waitFor(() => expect(result.current.brief.status).toBe('ready'))
    act(() => { result.current.setCardStates({ [CARD.id]: 'dismissed' }) })
    await waitFor(() => expect(result.current.brief.card_state).toStrictEqual({ [CARD.id]: 'dismissed' }))
    expect(bodiesOf('PUT', '/settings/my-briefing/cards')).toStrictEqual([{ day: READY.day, states: { [CARD.id]: 'dismissed' } }])
  })
})

describe('useBriefPreferences', () => {
  it('saves only the fields it names and shows the server answer', async () => {
    routeFetchApi({
      'GET /settings/my-briefing': () => ({ enabled: false }),
      'PUT /settings/my-briefing': (body) => ({ email_status: 'off', ...(typeof body === 'object' && body !== null ? body : {}) }),
    })
    const { result } = renderHook(() => useBriefPreferences(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => { result.current.save({ enabled: true, hour: 6 }) })
    await waitFor(() => expect(result.current.preferences.enabled).toBe(true))
    expect(bodiesOf('PUT', '/settings/my-briefing')).toStrictEqual([{ enabled: true, hour: 6 }])
  })
})

describe('the brief follows the app language', () => {
  afterEach(async () => { await i18n.changeLanguage('en') })

  async function refreshIn(language: string): Promise<unknown[]> {
    await i18n.changeLanguage(language)
    routeFetchApi({ 'GET /settings/my-briefing/brief': () => READY,
      'POST /settings/my-briefing/refresh': () => ({ status: 'pending', brief: READY }) })
    const { result } = renderHook(() => useBrief(), { wrapper })
    await waitFor(() => expect(result.current.brief.status).toBe('ready'))
    act(() => { result.current.refresh() })
    await waitFor(() => expect(result.current.refreshOutcome).toBe('started'))
    return bodiesOf('POST', '/settings/my-briefing/refresh')
  }

  it('Refresh sends the UI language', async () => {
    expect(await refreshIn('pl')).toStrictEqual([{ language: 'pl' }])
  })

  it('Refresh sends no language the brief does not support', async () => {
    expect(await refreshIn('it')).toStrictEqual([null])
  })

  async function preferencePutsIn(language: string, stored: Record<string, unknown>): Promise<unknown[]> {
    await i18n.changeLanguage(language)
    routeFetchApi({
      'GET /settings/my-briefing': () => stored,
      'PUT /settings/my-briefing': (body) => ({ ...stored, ...(typeof body === 'object' && body !== null ? body : {}) }),
    })
    const { result } = renderHook(() => useBriefPreferences(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    await waitFor(() => expect(result.current.isSaving).toBe(false))
    return bodiesOf('PUT', '/settings/my-briefing')
  }

  it('moves a subscribed brief that follows the app to the new UI language, once', async () => {
    const puts = await preferencePutsIn('pl', { enabled: true, language: 'en', language_source: 'ui' })
    expect(puts).toStrictEqual([{ language: 'pl', language_source: 'ui' }])
  })

  it('never moves a brief language the reader chose', async () => {
    expect(await preferencePutsIn('pl', { enabled: true, language: 'ja', language_source: 'chosen' })).toStrictEqual([])
  })

  it('leaves an unsubscribed reader to Refresh (no PUT on page load)', async () => {
    expect(await preferencePutsIn('pl', { enabled: false, language: 'en' })).toStrictEqual([])
  })
})
