/**
 * The consent before a voice session: its three statements (transcript kept and audio never, a synthetic voice, the
 * minutes left and the cost a minute), Start only once the person agrees, the microphone asked before the session is
 * started, and every refusal said in words (the microphone, the API's codes), the microphone released after one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { fakeAudio } from '@test/voiceDoubles'
import type { FakeAudio } from '@test/voiceDoubles'
import { ApiError } from '../../../lib/errors'
import VoiceConsentDialog from './VoiceConsentDialog'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
const audio: { next: FakeAudio; refusal: DOMException | null } = { next: fakeAudio(), refusal: null }
vi.mock('./voiceAudio', () => ({
  openVoiceAudio: () => (audio.refusal === null ? Promise.resolve(audio.next) : Promise.reject(audio.refusal)),
}))

const PATH = '/projects/proj_1/personas/p1/voice-sessions'
const PERSONA = { kind: 'persona', personaId: 'p1' } as const
const OFFER = {
  enabled: true, voice_id: 'tiffany', voice_gender: 'feminine', languages: { supported: ['en', 'de'], unsupported: ['ja'] },
  session_minutes: 15, minutes_left: 287.5, sessions_left_today: 4, estimated_cents_per_minute: 2,
}
const STARTED = { ...OFFER, session_id: 's1', connect_url: 'wss://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/x/ws', expires_in: 60 }

function serve(offer: Record<string, unknown>, start: () => unknown = () => STARTED) {
  routeFetchApi({ [`GET ${PATH}`]: () => offer, [`POST ${PATH}`]: start })
}

function renderDialog() {
  const onStarted = vi.fn()
  renderWithQueryClient(<VoiceConsentDialog projectId="proj_1" subject={PERSONA} name="Ada" onStarted={onStarted} onCancel={vi.fn()} />)
  return onStarted
}

beforeEach(() => {
  resetFetchApi()
  audio.next = fakeAudio()
  audio.refusal = null
})

describe('VoiceConsentDialog', () => {
  it('says the three things, starts only after agreeing, asks the microphone, then starts with consent', async () => {
    serve(OFFER)
    const user = userEvent.setup()
    const onStarted = renderDialog()
    expect(await screen.findByRole('list')).toHaveTextContent(
      /audio is never stored.*Ada speaks with a synthetic voice.*Voice minutes left this month: 287\./)
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Start talking' }))
    await vi.waitFor(() => { expect(onStarted.mock.calls[0]?.[0]).toMatchObject({ audio: audio.next, started: { session_id: 's1' } }) })
    expect(sentFetchApiBody(PATH, 'POST')).toStrictEqual({ consent: true, language: 'en' })
  })

  it.each([
    ['voice off', { enabled: false }, 'Voice is not turned on in this deployment.'],
    ['no minutes', { minutes_left: 0.5 }, "This month's voice minutes are used up."],
    ['no sessions today', { sessions_left_today: 0 }, "You have used all of today's voice sessions."],
  ])('offers no start with %s', async (_label, change, message) => {
    serve({ ...OFFER, ...change })
    renderDialog()
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled()
  })

  it('says a refused microphone and starts nothing', async () => {
    serve(OFFER)
    audio.refusal = new DOMException('denied', 'NotAllowedError')
    const user = userEvent.setup()
    renderDialog()
    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Start talking' }))
    expect(await screen.findByText(/The microphone could not be used/)).toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })

  it('says the API\'s refusal and releases the microphone it had opened', async () => {
    serve(OFFER, () => { throw new ApiError(429, 'Voice is busy', 'busy') })
    const opened = fakeAudio()
    audio.next = opened
    const user = userEvent.setup()
    renderDialog()
    await user.click(await screen.findByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Start talking' }))
    expect(await screen.findByText(/Voice is busy: too many conversations are live/)).toBeInTheDocument()
    expect(opened.closed.count).toBe(1)
  })

  it('notes a UI language the voice does not speak, with the ones it does', async () => {
    serve({ ...OFFER, languages: { supported: ['de', 'fr'], unsupported: ['en'] } })
    renderDialog()
    expect(await screen.findByRole('note')).toHaveTextContent('Speak German and French')
  })

  it('words the product interviewer\'s consent and starts it on its route with the questions (7.104.00)', async () => {
    const productPath = '/projects/proj_1/product-interview/voice-sessions'
    routeFetchApi({ [`GET ${productPath}`]: () => OFFER, [`POST ${productPath}`]: () => STARTED })
    const questions = [{ field: 'product_name', question: 'What is it called?' }]
    const onStarted = vi.fn()
    const user = userEvent.setup()
    renderWithQueryClient(<VoiceConsentDialog projectId="proj_1" subject={{ kind: 'product', questions }} name="Parcel Pilot" onStarted={onStarted} onCancel={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'Talk it through' })).toBeInTheDocument()
    // (the persona's "synthetic voice" statement is not among them)
    expect((await screen.findByRole('list')).textContent).toMatch(/^[^]*saved as a source of this project[^]*An AI interviewer asks the questions out loud(?![^]*synthetic voice)/)
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Start talking' }))
    await vi.waitFor(() => { expect(onStarted).toHaveBeenCalledTimes(1) })
    expect(sentFetchApiBody(productPath, 'POST')).toStrictEqual({ consent: true, language: 'en', questions })
  })

  describe('a product interview when the project holds its 20 sources (7.104.00)', () => {
    const productPath = '/projects/proj_1/product-interview/voice-sessions'
    const product = { kind: 'product', questions: [] } as const
    const FULL = /already holds 20 sources, the most it can[^]*Delete a source first/

    it('says so instead of the consent, and offers no start', async () => {
      routeFetchApi({ [`GET ${productPath}`]: () => ({ ...OFFER, sources_full: true }) })
      renderWithQueryClient(<VoiceConsentDialog projectId="proj_1" subject={product} name="Parcel Pilot" onStarted={vi.fn()} onCancel={vi.fn()} />)
      expect(await screen.findByRole('alert')).toHaveTextContent(FULL)
      expect(screen.getByRole('button', { name: 'Start talking' })).toBeDisabled()
    })

    it('words the start\'s refusal when the sources filled up after the offer', async () => {
      routeFetchApi({
        [`GET ${productPath}`]: () => OFFER,
        [`POST ${productPath}`]: () => { throw new ApiError(400, 'full', 'too_many_sources') },
      })
      const user = userEvent.setup()
      renderWithQueryClient(<VoiceConsentDialog projectId="proj_1" subject={product} name="Parcel Pilot" onStarted={vi.fn()} onCancel={vi.fn()} />)
      await user.click(await screen.findByRole('checkbox'))
      await user.click(screen.getByRole('button', { name: 'Start talking' }))
      expect(await screen.findByText(FULL)).toBeInTheDocument()
    })
  })
})
