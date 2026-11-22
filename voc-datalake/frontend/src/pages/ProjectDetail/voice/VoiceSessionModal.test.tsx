/**
 * A live voice session in its dialog, on a hand-driven socket and audio: the synthetic label, captions of both sides
 * (the persona's unspoken text muted, then final), a citation, the clock and cost, a notice, End asking the relay,
 * the end posted once, the filed transcript linked and saved to the Library, and each failure said in words (an end
 * that could not be recorded after its retries, with Try again). While it runs, Escape does not close the dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { fakeXhrPerTest } from '@test/fakeXhr'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { FakeSocket, fakeAudio, stubWebSocket } from '@test/voiceDoubles'
import { Q3_ID, libraryItem } from '../../Library/library-fixtures'
import VoiceSessionModal from './VoiceSessionModal'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const SESSION = '/projects/proj_1/personas/p1/voice-sessions/s1'
const STARTED = {
  session_id: 's1', connect_url: 'wss://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/x/ws', expires_in: 60,
  minutes_left: 120, session_minutes: 15, voice_id: 'tiffany' as const, voice_gender: 'feminine' as const,
  languages: { supported: ['en'], unsupported: [] }, estimated_cents_per_minute: 2,
}
const FILED = { session_id: 's1', status: 'finalized', seconds: 64, cost_cents: 2, end_reason: 'ended_by_person', transcript_document_id: 'doc_9' }
const xhr = fakeXhrPerTest()

function serve(extra: Record<string, RouteHandler> = {}) {
  routeFetchApi({ [`POST ${SESSION}/end`]: () => ({ success: true, status: 'finalizing', job_id: 'job_1' }), [`GET ${SESSION}`]: () => FILED, ...extra })
}

function renderSession() {
  const onClose = vi.fn()
  render(<VoiceSessionModal target={{ projectId: 'proj_1', personaId: 'p1', started: STARTED, audio: fakeAudio() }} name="Ada" onClose={onClose} />)
  const socket = FakeSocket.last()
  act(() => { socket.open() })
  return { socket, onClose }
}

function relay(socket: FakeSocket, ...messages: unknown[]) {
  act(() => { for (const message of messages) socket.receive(message) })
}

beforeEach(() => {
  resetFetchApi()
  stubWebSocket()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('VoiceSessionModal', () => {
  it('shows the synthetic label, the captions of both sides, a citation, the clock and cost, and a notice', () => {
    serve()
    const { socket } = renderSession()
    relay(socket,
      { type: 'ready', voice_id: 'tiffany', session_seconds: 900, minutes_left: 120 },
      { type: 'caption', role: 'assistant', stage: 'speculative', text: 'Hi, I am Ada', turn: 1 },
      { type: 'caption', role: 'user', stage: 'final', text: 'How are deliveries?', turn: 2 },
      { type: 'citation', turn: 1, feedback_ids: ['fb1'] },
      { type: 'usage', seconds: 65, cents: 2.2 },
      { type: 'notice', code: 'time_almost_up' })
    const captions = screen.getByRole('list', { name: 'Live captions' })
    expect(screen.getByText('Synthetic voice')).toBeInTheDocument()
    expect(captions).toHaveTextContent(/^Ada: Hi, I am Ada1You: How are deliveries\?$/)
    expect(within(captions).getByRole('button', { name: 'Open cited review 1' })).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toHaveTextContent(/One minute left in this session\..*Time: 1:05 \/ 15:00Cost so far: \$0\.022/)
  })

  it('ends through the relay, posts the end once and links the filed transcript', async () => {
    serve()
    const user = userEvent.setup()
    const { socket, onClose } = renderSession()
    await user.click(screen.getByRole('button', { name: 'End' }))
    relay(socket, { type: 'ended', reason: 'ended_by_person' })
    expect(socket.controls()).toStrictEqual([{ type: 'end' }])
    expect(await screen.findByRole('link', { name: 'Open transcript' })).toHaveAttribute('href', '/projects/proj_1/documents/doc_9')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect([onClose.mock.calls.length, fetchApi.mock.calls.filter(([path]) => path === `${SESSION}/end`).length]).toStrictEqual([1, 1])
  })

  it('saves the filed transcript to the Library', async () => {
    serve({
      'GET /projects/proj_1': () => ({ project: { project_id: 'proj_1', name: 'P' }, personas: [], documents: [
        { document_id: 'doc_9', document_type: 'persona_interview', title: 'Interview with Ada', content: '## Summary', synthetic: true }] }),
      'POST /projects/library': () => ({ item: libraryItem({ status: 'pending' }), upload: { url: 'https://s3.example.com/put', headers: {}, expires_in: 900 } }),
      [`POST /projects/library/${Q3_ID}/uploaded`]: () => ({ item: libraryItem({ status: 'extracting' }) }),
    })
    const user = userEvent.setup()
    const { socket } = renderSession()
    relay(socket, { type: 'ended', reason: 'session_limit' })
    await user.click(await screen.findByRole('button', { name: 'Save to Library' }))
    await vi.waitFor(() => { expect(xhr.sent).toHaveLength(1) })
    act(() => { xhr.last().respond(200) })
    expect(await screen.findByText('Saved to the Library.')).toBeInTheDocument()
    expect(screen.getByText('The session reached its time limit.')).toBeInTheDocument()
  })

  it('says when the transcript could not be filed', async () => {
    serve({ [`GET ${SESSION}`]: () => ({ ...FILED, status: 'failed', transcript_document_id: null }) })
    const { socket } = renderSession()
    relay(socket, { type: 'ended', reason: 'error' })
    expect(await screen.findByText(/could not be filed/)).toBeInTheDocument()
  })

  it('retries an end that fails, says when none was recorded, and Try again records it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const answers = ['fail', 'fail', 'fail']
    serve({ [`POST ${SESSION}/end`]: () => {
      if (answers.shift() === 'fail') throw new Error('API Error: 500')
      return { success: true, status: 'finalizing', job_id: 'job_1' }
    } })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    const { socket } = renderSession()
    relay(socket, { type: 'ended', reason: 'error' })
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(await screen.findByText(/could not be recorded/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Open transcript' })).toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([path]) => path === `${SESSION}/end`)).toHaveLength(4)
    vi.useRealTimers()
  })

  it('sends the end with keepalive when the page goes away during the session', () => {
    serve()
    renderSession()
    act(() => { globalThis.dispatchEvent(new Event('pagehide')) })
    const sent = fetchApi.mock.calls.filter(([path]) => path === `${SESSION}/end`)
    expect(sent.map(([, init]) => init?.keepalive)).toStrictEqual([true])
  })

  it('keeps the dialog open on Escape while the session runs, and says a dropped connection', async () => {
    serve()
    const user = userEvent.setup()
    const { socket } = renderSession()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    act(() => { socket.close() })
    expect(await screen.findByText('The connection was lost.')).toBeInTheDocument()
  })
})
