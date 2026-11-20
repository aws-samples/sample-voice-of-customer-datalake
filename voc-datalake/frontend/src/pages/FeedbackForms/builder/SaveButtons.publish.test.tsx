/**
 * What Publish and Update live form check first (audit §2.3, F17): text under 3:1 on its background blocks Publish and
 * a live form's colour change, never Save (nothing is lost while the colours are fixed); a live form kept on the
 * unreadable theme it already has only warns, and Update live form goes through; a language that is incomplete asks first
 * ("Polski respondents will see 2 texts in English", Publish anyway or Translate); the server's own refusal of an
 * unreadable theme is kept as its code, for the header to word.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FormV2, LoadedForm } from '../model/formsV2'
import { DEFAULT_THEME } from '../model/formsV2'

const api = vi.hoisted(() => ({
  saveForm: vi.fn<(formId: string, form: FormV2, revision: number) => Promise<LoadedForm>>(),
}))

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../api/feedbackFormsV2Api')>()
  return { ...real, feedbackFormsV2Api: { ...real.feedbackFormsV2Api, ...api } }
})

import { FormsApiError } from '../../../api/feedbackFormsV2Api'
import { STORED_META, renameDraft, renderWithDraft, sampleForm } from '../test/draftHarness'
import SaveButtons from './SaveButtons'
import { THEME_UNREADABLE } from './useFormDraft'

const GREY = sampleForm({ theme: { ...DEFAULT_THEME, text_color: '#9ca3af' } })
const BILINGUAL = sampleForm({ languages: ['en', 'pl'] })
const stored = (form: FormV2): LoadedForm => ({ form, meta: { ...STORED_META, revision: 4 } })

function renderButtons(form: FormV2) {
  const harness = renderWithDraft(<SaveButtons />, form)
  return { ...harness, user: userEvent.setup() }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.saveForm.mockImplementation((_id, form) => Promise.resolve(stored(form)))
})

describe('an unreadable theme', () => {
  it('blocks Publish with the reason, and never Save', async () => {
    const harness = renderButtons(GREY)
    await renameDraft(harness)
    const publish = await screen.findByRole('button', { name: 'Publish' })
    expect(publish).toHaveAttribute('aria-disabled', 'true')
    await harness.user.click(publish)
    expect(api.saveForm).not.toHaveBeenCalled()
    await harness.user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ enabled: false }), 3, null, 5) })
  })

  it('only warns on a live form kept on its own unreadable theme: Update live form goes through', async () => {
    const harness = renderButtons({ ...GREY, enabled: true })
    await renameDraft(harness)
    const update = await screen.findByRole('button', { name: 'Update live form' })
    expect(update).not.toHaveAttribute('aria-disabled', 'true')
    expect(harness.probe.current?.errors).toStrictEqual([])
    expect(harness.probe.current?.problems.map((problem) => [problem.severity, problem.code]))
      .toContainEqual(['warning', 'themeUnreadableLive'])
    await harness.user.click(update)
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ name: 'Renamed' }), 3, null, 5) })
  })

  it.each([
    ['a readable live form', sampleForm({ enabled: true })],
    ['a live form already unreadable', { ...GREY, enabled: true }],
  ])('blocks Update live form when %s gets unreadable colours', async (_name, form) => {
    const harness = renderButtons(form)
    await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
    harness.probe.current?.update((current) => ({ ...current, theme: { ...current.theme, text_color: '#b0b0b0' } }))
    const update = await screen.findByRole('button', { name: 'Update live form' })
    expect(update).toHaveAttribute('aria-disabled', 'true')
    expect(harness.probe.current?.errors.map((problem) => problem.code)).toStrictEqual(['themeUnreadable'])
  })

  it('keeps the server’s refusal as its code, for the header to word', async () => {
    api.saveForm.mockRejectedValueOnce(new FormsApiError(400, 'The text on the light background is 2.5:1', THEME_UNREADABLE, {
      errors: [], retryAfterSeconds: null, current: null,
    }))
    const harness = renderButtons(sampleForm())
    await harness.user.click(screen.getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(harness.probe.current?.status).toStrictEqual({ kind: 'failed', reason: THEME_UNREADABLE }) })
  })
})

describe('an incomplete language (F17)', () => {
  it('asks before publishing, then publishes anyway', async () => {
    const harness = renderButtons(BILINGUAL)
    await harness.user.click(screen.getByRole('button', { name: 'Publish' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Publish with missing translations?')
    expect(dialog).toHaveTextContent('Polski respondents will see 2 texts in English.')
    expect(api.saveForm).not.toHaveBeenCalled()
    await harness.user.click(within(dialog).getByRole('button', { name: 'Publish anyway' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ enabled: true }), 3, null, 5) })
  })

  it('goes to the language to translate it instead', async () => {
    const harness = renderButtons(BILINGUAL)
    await harness.user.click(screen.getByRole('button', { name: 'Publish' }))
    await harness.user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Translate Polski' }))
    expect(harness.go).toHaveBeenCalledWith('languages', ['pl'])
    expect([screen.queryByRole('dialog'), api.saveForm.mock.calls.length]).toStrictEqual([null, 0])
  })

  it('asks before updating a live form too', async () => {
    const harness = renderButtons({ ...BILINGUAL, enabled: true })
    await renameDraft(harness)
    await harness.user.click(await screen.findByRole('button', { name: 'Update live form' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Update the live form with missing translations?')
    await harness.user.click(within(dialog).getByRole('button', { name: 'Update anyway' }))
    await waitFor(() => { expect(api.saveForm).toHaveBeenCalledWith('f_test', expect.objectContaining({ name: 'Renamed', enabled: true }), 3, null, 5) })
  })
})
