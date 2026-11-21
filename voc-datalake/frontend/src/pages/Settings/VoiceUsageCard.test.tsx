/**
 * Administration → AI's voice minutes (7.69.00): for an administrator on a deployment with `features.voice` only,
 * this month's minutes of the budget, sessions, cost, live conversations of the cap, the limits and the model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const voice = { available: true }
vi.mock('../../runtimeConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../runtimeConfig')>(),
  isVoiceAvailable: () => voice.available,
}))

const { default: VoiceUsageCard } = await import('./VoiceUsageCard')

const USAGE = {
  enabled: true, month: '2026-11', minutes_used: 42.4, monthly_minutes: 300, minutes_left: 257.6, sessions: 9,
  cost_cents: 81.3, live_sessions: 1, max_concurrent: 8, session_minutes: 15, daily_sessions: 5, model_id: 'amazon.nova-2-5-sonic',
}

beforeEach(() => {
  resetFetchApi()
  voice.available = true
})

describe('VoiceUsageCard', () => {
  it('shows the month to an administrator', async () => {
    routeFetchApi({ 'GET /projects/voice/usage': () => USAGE })
    renderWithQueryClient(<VoiceUsageCard isAdmin />)
    expect(await screen.findByText('42 of 300')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Voice personas' })).toHaveTextContent(
      /month 2026-11.*Sessions this month9.*Estimated cost\$0\.813.*Live now1 of 8.*amazon\.nova-2-5-sonic/)
  })

  it.each([
    ['a non-administrator', false, true],
    ['a deployment without voice', true, false],
  ])('shows nothing to %s and reads nothing', (_label, isAdmin, available) => {
    voice.available = available
    const { container } = renderWithQueryClient(<VoiceUsageCard isAdmin={isAdmin} />)
    expect([container.innerHTML, fetchApi.mock.calls.length]).toStrictEqual(['', 0])
  })

  it('says when the usage cannot be read', async () => {
    routeFetchApi({})
    renderWithQueryClient(<VoiceUsageCard isAdmin />)
    expect(await screen.findByText('Voice usage could not be loaded.')).toBeInTheDocument()
  })
})
