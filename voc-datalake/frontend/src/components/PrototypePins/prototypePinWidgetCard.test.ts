/**
 * The validation card of the prototype pin widget (7.68.00, lambda/shared/static/prototype-pin-widget.js): once
 * mounted it asks its OWN form's public submit route for the card with an empty response, shows "Tell us how it went"
 * when the form asks questions, and sends the tester's answers the same way, standalone straight to that one URL (the
 * prototype CSP's single connect-src, which the card leaves as it is) or framed through the host. No card, no network,
 * or a host that predates the card: pins work as before. Each case evaluates the real source afresh.
 */
import { describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../lib/typeGuards'
import { FORM_ID, SUBMIT_URL, fakeChannels, frameBy, installWidgetSandbox, loadWidget } from '../../test/pinWidgetHarness'

const CARD = {
  form_id: FORM_ID, revision: 2, language: 'en', title: 'Tell us how it went', description: 'A few questions.',
  questions: [
    { id: 'q_vt_t00aa11', type: 'single_select', headline: 'Pay the invoice', subheader: 'Could you do this?',
      options: [{ code: 'yes', label: 'Yes' }, { code: 'no', label: 'No' }] },
    { id: 'q_v_ces', type: 'ces', headline: 'How easy was it?', range: [1, 7] },
    { id: 'q_v_missing', type: 'open_text', headline: 'What was missing?' },
  ],
  thanks: 'Thank you!', labels: { send: 'Send', cancel: 'Cancel', empty: 'Answer one.', failed: 'Not sent.' },
}

const fetchMock = installWidgetSandbox()
const answered = (body: unknown) => ({ ok: true, json: () => Promise.resolve(body) })
const settle = () => new Promise((done) => { setTimeout(done, 0) })
const cardButton = () => document.getElementById('voc-pin-card-button')
const panel = () => document.getElementById('voc-pin-panel')

function click(text: string): void {
  const button = [...document.querySelectorAll('button')].find((one) => one.textContent === text)
  if (button === undefined) throw new Error(`no button ${text}`)
  button.click()
}

function sentBodies(): unknown[] {
  return fetchMock.mock.calls.map((call: unknown[]): unknown => {
    const init = call[1]
    if (!isRecord(init) || typeof init['body'] !== 'string') return null
    const body: unknown = JSON.parse(init['body'])
    return body
  })
}

describe('standalone', () => {
  it('asks its own submit URL for the card, and nothing else, with an empty response', async () => {
    fetchMock.mockResolvedValue(answered({ success: true, card: CARD }))
    loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    await settle()
    expect(fetchMock.mock.calls.map((call: unknown[]) => call[0])).toStrictEqual([SUBMIT_URL])
    expect(sentBodies()).toStrictEqual([{ answers: {} }])
    expect(cardButton()?.textContent).toBe('Tell us how it went')
  })

  it('sends what the tester answered with the revision and language the card showed, then thanks them', async () => {
    fetchMock.mockResolvedValueOnce(answered({ success: true, card: CARD })).mockResolvedValueOnce(answered({ success: true }))
    loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    await settle()
    cardButton()?.click()
    click('Yes')
    click('6')
    click('Send')
    await settle()
    expect(sentBodies()[1]).toStrictEqual({ answers: { q_vt_t00aa11: { code: 'yes' }, q_v_ces: 6 }, form_revision: 2,
      language: 'en' })
    expect(fetchMock.mock.calls.every((call: unknown[]) => call[0] === SUBMIT_URL)).toBe(true)
    expect(panel()?.textContent).toContain('Thank you!')
    expect(cardButton()).toBeNull()
  })

  it('asks for one answer before sending', async () => {
    fetchMock.mockResolvedValue(answered({ success: true, card: CARD }))
    loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    await settle()
    cardButton()?.click()
    click('Send')
    expect(sentBodies()).toStrictEqual([{ answers: {} }])
    expect(document.getElementById('voc-pin-card-status')?.textContent).toBe('Answer one.')
  })

  it('keeps the card open with the answers given when the send fails', async () => {
    fetchMock.mockResolvedValueOnce(answered({ success: true, card: CARD })).mockRejectedValueOnce(new TypeError('offline'))
    loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    await settle()
    cardButton()?.click()
    click('No')
    click('Send')
    await settle()
    expect(document.getElementById('voc-pin-card-status')?.textContent).toBe('Not sent.')
    expect(document.querySelector('[aria-pressed="true"]')?.textContent).toBe('No')
    expect(cardButton()).not.toBeNull()
  })

  it.each([
    ['a form that asks none (400 validation_closed)', () => fetchMock.mockResolvedValue({ ok: false, status: 400 })],
    ['no network', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
    ['an answer with no questions', () => fetchMock.mockResolvedValue(answered({ card: { ...CARD, questions: [] } }))],
  ])('shows no card for %s, and the Feedback button stays', async (_label, arrange) => {
    arrange()
    loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    await settle()
    expect(cardButton()).toBeNull()
    expect(document.getElementById('voc-pin-button')).not.toBeNull()
  })

  it('asks nothing without a submit URL', async () => {
    loadWidget({ formId: FORM_ID })
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('framed by the SPA viewer', () => {
  it('asks the host for the card and never the network', () => {
    fakeChannels()
    const parent = { postMessage: vi.fn() }
    frameBy(parent)
    loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { source: 'voc-pin-widget', type: 'card', formId: FORM_ID, requestId: 'v1', body: { answers: {} } },
      window.location.origin)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the card the host answers on its port, and no card while a host never answers', async () => {
    const channels = fakeChannels()
    frameBy({ postMessage: vi.fn() })
    loadWidget({ formId: FORM_ID })
    await settle()
    expect(cardButton()).toBeNull()
    channels[0]?.port1.onmessage?.({ data: { source: 'voc-pin-host', type: 'card', requestId: 'v1', ok: true, card: CARD } })
    await settle()
    expect(cardButton()).not.toBeNull()
  })
})
