/**
 * In-app micro-feedback (7.66.00): shown only while it is on for the action and its form takes answers; a thumb, then
 * "What's missing?" and Send to the form's public submit route with no credentials; asked once per action instance;
 * named buttons, the thumb pressed, the text box focused, the outcome announced, a failure retried.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { BUILD_INFO } from '../../pages/Settings/buildInfo'
import { useAuthStore } from '../../store/authStore'
import MicroFeedback from './MicroFeedback'
import DocumentMicroFeedback from './DocumentMicroFeedback'
import { MAX_REMEMBERED, rememberAnswered, wasAnswered } from './answeredInstances'

const FORM = 'ff_app'
const ACTIVE = {
  enabled: true, form_id: FORM, actions: ['prd', 'research'], updated_at: null, tag: 'voc_app', active: true,
  form: { form_id: FORM, found: true, name: 'App feedback', enabled: true, languages: ['en'], problems: [] },
}

function serve(config: unknown = ACTIVE) {
  routeFetchApi({ 'GET /settings/app-feedback': () => config })
}

function render(ui = <MicroFeedback action="prd" instance="doc_1" />) {
  return renderWithQueryClient(<TestRouter initialEntries={['/projects/p_1/documents/doc_1']}>{ui}</TestRouter>)
}

const submits = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
/** This browser's storage for the spec (the shared setup's is a stub that keeps nothing). */
const stored = new Map<string, string>()

beforeEach(() => {
  resetFetchApi()
  stored.clear()
  vi.mocked(window.localStorage.getItem).mockImplementation((key) => stored.get(key) ?? null)
  vi.mocked(window.localStorage.setItem).mockImplementation((key, value) => { stored.set(key, value) })
  useAuthStore.setState({ user: { username: 'ada', email: 'ada@example.com', groups: [], sub: 'sub-ada' } })
  // (the page is the address's first segment: the browser's own, as the app reads it)
  window.history.replaceState({}, '', '/projects/p_1/documents/doc_1')
  submits.mockReset()
  submits.mockResolvedValue(new Response('{"success":true}', { status: 200 }))
  vi.stubGlobal('fetch', submits)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The JSON body of the `n`-th submit (undefined when there is none). */
function sentBody(n = 0): unknown {
  const body = submits.mock.calls[n]?.[1]?.body
  const parsed: unknown = typeof body === 'string' ? JSON.parse(body) : undefined
  return parsed
}

/** A thumb down, what is missing typed, Send, and the thanks shown. */
async function answerDown(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'No, this was not useful' }))
  await user.type(screen.getByRole('textbox', { name: "What's missing? (optional)" }), 'The pricing feedback')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  return screen.findByRole('status')
}

describe('MicroFeedback', () => {
  it('presses the thumb chosen and moves to "What\'s missing?"', async () => {
    serve()
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'No, this was not useful' }))
    expect(screen.getByRole('button', { name: 'No, this was not useful' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('textbox', { name: "What's missing? (optional)" })).toHaveFocus()
  })

  it("sends to the form's public submit route without credentials", async () => {
    serve()
    render()
    await answerDown(userEvent.setup())
    const [url, init] = submits.mock.calls[0] ?? []
    expect(url).toBe(`https://api.example.com/feedback-forms/${FORM}/submit`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' })
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
  })

  it('sends the verdict, what is missing and ids only, then thanks', async () => {
    serve()
    render()
    expect(await answerDown(userEvent.setup())).toHaveTextContent('Thanks. The team reads every answer.')
    expect(sentBody()).toStrictEqual({
      answers: { q_verdict: { code: 'down' }, q_missing: 'The pricing feedback' },
      hidden: { action: 'prd', page: 'projects', app_version: BUILD_INFO.version, workspace_role: 'none' },
      language: 'en',
    })
  })

  it('is asked once per instance: a sent or dismissed one never shows again', async () => {
    serve()
    const user = userEvent.setup()
    const { unmount } = render()
    await user.click(await screen.findByRole('button', { name: 'Not now' }))
    expect(screen.queryByTestId('micro-feedback')).not.toBeInTheDocument()
    unmount()
    render()
    await waitFor(() => expect(wasAnswered('sub-ada', 'prd', 'doc_1')).toBe(true))
    expect(screen.queryByTestId('micro-feedback')).not.toBeInTheDocument()
    render(<MicroFeedback action="prd" instance="doc_2" />)
    expect(await screen.findByTestId('micro-feedback')).toBeInTheDocument()
  })

  it('works from the keyboard', async () => {
    serve()
    const user = userEvent.setup()
    render()
    await screen.findByRole('button', { name: 'Yes, this was useful' })
    await user.tab()
    expect(screen.getByRole('button', { name: 'Yes, this was useful' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('textbox', { name: "What's missing? (optional)" })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Send' })).toHaveFocus()
    await user.keyboard('{Enter}')
    await screen.findByRole('status')
    expect(sentBody()).toMatchObject({ answers: { q_verdict: { code: 'up' } } })
  })

  it('says when the form refused it, keeps it unanswered and retries', async () => {
    serve()
    submits.mockResolvedValueOnce(new Response('{"success":false}', { status: 429 }))
    const user = userEvent.setup()
    render()
    await user.click(await screen.findByRole('button', { name: 'Yes, this was useful' }))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't send it.")
    expect(wasAnswered('sub-ada', 'prd', 'doc_1')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(wasAnswered('sub-ada', 'prd', 'doc_1')).toBe(true)
  })

  it.each([
    ['it is off', { ...ACTIVE, active: false, enabled: false }],
    ['the action is not one it asks after', { ...ACTIVE, actions: ['research'] }],
    ['no form is chosen', { ...ACTIVE, form_id: null, form: null }],
    ['the settings cannot be read', 'not json'],
  ])('shows nothing when %s', async (_why, config) => {
    serve(config)
    render()
    await waitFor(() => expect(screen.queryByTestId('micro-feedback')).not.toBeInTheDocument())
    expect(submits).not.toHaveBeenCalled()
  })
})

describe('DocumentMicroFeedback', () => {
  const doc = { document_id: 'doc_9', document_type: 'research', origin: undefined, source_documents: undefined }

  it('asks about a generated research report', async () => {
    serve()
    render(<DocumentMicroFeedback document={doc} />)
    expect(await screen.findByTestId('micro-feedback')).toHaveAttribute('data-action', 'research')
  })

  it.each([
    ['written by hand', { ...doc, document_type: 'prd', origin: 'human' }],
    ['a merge', { ...doc, document_type: 'prd', source_documents: ['a', 'b'] }],
    ['a custom document', { ...doc, document_type: 'custom' }],
  ])('does not ask about one %s', async (_why, document) => {
    serve()
    render(<DocumentMicroFeedback document={document} />)
    await waitFor(() => expect(screen.queryByTestId('micro-feedback')).not.toBeInTheDocument())
  })
})

describe('answeredInstances', () => {
  it('keeps the newest instances per person', () => {
    Array.from({ length: MAX_REMEMBERED + 1 }, (_, n) => `doc_${String(n)}`)
      .forEach((instance) => { rememberAnswered('sub-ada', 'prd', instance) })
    expect([wasAnswered('sub-ada', 'prd', 'doc_0'), wasAnswered('sub-ada', 'prd', `doc_${String(MAX_REMEMBERED)}`),
      wasAnswered('sub-bea', 'prd', `doc_${String(MAX_REMEMBERED)}`)]).toStrictEqual([false, true, false])
  })

  it('reads unreadable storage as nothing answered', () => {
    stored.set('voc-micro-feedback:sub-ada', '{nope')
    expect(wasAnswered('sub-ada', 'prd', 'doc_1')).toBe(false)
  })
})
