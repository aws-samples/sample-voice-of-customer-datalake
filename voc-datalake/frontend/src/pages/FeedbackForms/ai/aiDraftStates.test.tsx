import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { z } from 'zod'
import { FormsApiError } from '../../../api/feedbackFormsV2Api'
import type { DraftAnswer, DraftRequest } from '../../../api/feedbackFormsV2Api'
import { renderPicker } from '../test/pickerHarness'
import { sampleForm } from '../test/draftHarness'

const draftForm = vi.hoisted(() => vi.fn<(request: DraftRequest, signal?: AbortSignal) => Promise<DraftAnswer>>())

vi.mock('../preview/PreviewFrame', () => import('../test/previewFrameStub'))
vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return { ...actual, feedbackFormsV2Api: { ...actual.feedbackFormsV2Api, draftForm } }
})

const DESCRIPTION = 'Ask app users who switch back to the old UI why, with predefined reasons.'

function refusal(status: number, code?: string, extra: Partial<{ errors: string[]; retryAfterSeconds: number }> = {}) {
  return new FormsApiError(status, 'Refused by the server', code, {
    errors: (extra.errors ?? []).map((message) => ({ message })), retryAfterSeconds: extra.retryAfterSeconds ?? null, current: null,
  })
}

async function describeAndDraft() {
  const user = userEvent.setup()
  renderPicker()
  await user.type(screen.getByRole('textbox', { name: 'Describe your form' }), DESCRIPTION)
  await user.click(screen.getByRole('button', { name: 'Draft it' }))
  return user
}

beforeEach(() => {
  draftForm.mockReset()
})

describe('drafting a form from a description, when the AI can\'t help (UX §12.4)', () => {
  it.each([
    ['a viewer', refusal(403, 'role'), 'Only editors and administrators can draft forms with AI.'],
    ['Human-driven', refusal(403, 'ai_mode'), "Human-driven: AI doesn't write forms for you. Start from a template, or let the assistant coach you."],
    ['no AI model', refusal(503, 'no_model'), "AI drafting isn't set up in this workspace: no AI model is available for it."],
    ['the spend limit', refusal(429, 'spend_cap'), "This workspace's AI budget for the month is used up."],
    ['a 5xx', refusal(502), "The AI didn't answer. Try again in a moment."],
    ['a network failure', new TypeError('Failed to fetch'), "The AI didn't answer. Try again in a moment."],
    ['another refusal', refusal(400, 'bad_language'), "The AI couldn't draft this form: Refused by the server"],
  ])('says so for %s, in its own words', async (_case, error, message) => {
    draftForm.mockRejectedValue(error)
    await describeAndDraft()
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('offers the assistant\'s coaching to a Human-driven person', async () => {
    draftForm.mockRejectedValue(refusal(403, 'ai_mode'))
    await describeAndDraft()
    expect(await screen.findByRole('button', { name: 'Coach me' })).toBeInTheDocument()
  })

  it('holds Draft it for the rest of a rate limit, and says for how long', async () => {
    draftForm.mockRejectedValue(refusal(429, 'rate_limited', { retryAfterSeconds: 240 }))
    await describeAndDraft()
    expect(await screen.findByText("You've reached the AI limit for now. Try again in 4 min.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Draft it' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('lists the validator\'s errors when the AI\'s form stayed invalid, and can try again', async () => {
    draftForm.mockRejectedValue(refusal(422, undefined, { errors: ['Question 4 has 52 options; a question has at most 50.'] }))
    const user = await describeAndDraft()
    expect(await screen.findByText("The AI couldn't turn this into a valid form.")).toBeInTheDocument()
    expect(screen.getByText('Question 4 has 52 options; a question has at most 50.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(draftForm).toHaveBeenCalledTimes(2)
  })
})

describe('drafting a form from a description', () => {
  it('sends the description, the language and where it runs', async () => {
    draftForm.mockRejectedValue(refusal(502))
    await describeAndDraft()
    await waitFor(() => expect(draftForm).toHaveBeenCalledWith({ description: DESCRIPTION, language: 'en', channel: 'link' }, expect.any(AbortSignal)))
  })

  it('opens the builder with the AI draft unsaved, its notes, and the addresses to confirm', async () => {
    const form = sampleForm({ endings: [{ id: 'end_thanks', title: { en: 'Thanks' }, button: { label: { en: 'Help' }, url: 'https://example.com/help' } }] })
    draftForm.mockResolvedValue({ form, notes: [{ message: 'Reasons are shuffled.' }], warnings: [] })
    await describeAndDraft()
    const handed: unknown = JSON.parse((await screen.findByTestId('handoff')).textContent)
    const ai = z.object({ ai: z.object({ description: z.string(), channel: z.string(), notes: z.array(z.unknown()), addresses: z.array(z.unknown()) }) }).parse(handed).ai
    expect(ai).toStrictEqual({
      description: DESCRIPTION, channel: 'link', notes: [{ message: 'Reasons are shuffled.' }],
      addresses: [{ kind: 'ending', id: 'end_thanks', field: 'button_url' }],
    })
  })

  it('shows Stop while it drafts, and Stop asks before it ends the draft', async () => {
    const signals: AbortSignal[] = []
    draftForm.mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
      if (signal !== undefined) signals.push(signal)
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const user = await describeAndDraft()
    // (said by the button and the preview card only: the status line under Describe repeated them; Runs waits)
    const runs = within(screen.getByRole('group', { name: 'Runs' })).getAllByRole('button').map((choice) => choice.getAttribute('aria-disabled'))
    expect([screen.getAllByText('Drafting your form… This usually takes 10 to 30 seconds.').length, runs])
      .toStrictEqual([1, ['true', 'true', 'true']])
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('dialog', { name: 'Stop drafting?' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep drafting' }))
    const afterKeep = signals.map((signal) => signal.aborted)
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await user.click(screen.getByRole('button', { name: 'Stop drafting' }))
    expect([afterKeep, signals.map((signal) => signal.aborted)]).toStrictEqual([[false], [true]])
    expect(screen.queryByText('Drafting your form… This usually takes 10 to 30 seconds.')).not.toBeInTheDocument()
  })

  it('opens nothing from a draft that was stopped, even when its answer comes after', async () => {
    const answers: Array<(answer: DraftAnswer) => void> = []
    draftForm.mockImplementation(() => new Promise((resolve) => { answers.push(resolve) }))
    const user = await describeAndDraft()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    await user.click(screen.getByRole('button', { name: 'Stop drafting' }))
    answers[0]?.({ form: sampleForm(), notes: [], warnings: [] })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Draft it' })).not.toHaveAttribute('aria-busy', 'true') })
    expect(screen.queryByTestId('handoff')).not.toBeInTheDocument()
  })
})
