import { describe, expect, it } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FormV2 } from '../model/formsV2'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import AiDraftBanner from './AiDraftBanner'

const drafted = (): FormV2 => sampleForm({
  endings: [{ id: 'end_thanks', title: { en: 'Thanks' }, button: { label: { en: 'Help' }, url: 'https://example.com/help' } }],
})

function renderAiDraft() {
  return renderWithDraft(<AiDraftBanner />, drafted(), {
    isNew: true,
    handoff: {
      ai: {
        notes: [{ message: 'Reasons are shuffled; "Something else" stays last.' }],
        warnings: [{ message: 'The ending button points to a help page.', target: 'end_thanks' }],
        description: 'Ask why people cancel', channel: 'link',
        addresses: [{ kind: 'ending', id: 'end_thanks', field: 'button_url' }],
      },
    },
  })
}

const aiAddressErrors = (harness: ReturnType<typeof renderAiDraft>) =>
  harness.probe.current?.errors.filter((problem) => problem.code === 'aiAddress').length

describe('AiDraftBanner', () => {
  it('says the AI draft is not saved yet, with its notes folded', async () => {
    const user = userEvent.setup()
    renderAiDraft()
    expect(screen.getByText('AI draft: review before publishing. Nothing is saved yet.')).toBeInTheDocument()
    expect(screen.queryByText('Reasons are shuffled; "Something else" stays last.')).not.toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Notes (1)' }))
    expect(screen.getByText('Reasons are shuffled; "Something else" stays last.')).toBeVisible()
  })

  it('always shows the warnings, and goes to the ending one names', async () => {
    const user = userEvent.setup()
    const harness = renderAiDraft()
    await user.click(screen.getByRole('button', { name: 'Go to' }))
    expect(harness.go).toHaveBeenCalledWith('questions', ['end', 'end_thanks'])
  })

  it('asks before discarding the draft, then returns to the picker with the description', async () => {
    const user = userEvent.setup()
    const harness = renderAiDraft()
    await user.click(screen.getByRole('button', { name: 'Discard draft' }))
    const dialog = screen.getByRole('dialog', { name: 'Discard the AI draft?' })
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }))
    expect(harness.leave).toHaveBeenCalledWith('/feedback-forms/new', { describe: 'Ask why people cancel' })
  })

  it('holds the suggested address as an error until it is confirmed', async () => {
    const user = userEvent.setup()
    const harness = renderAiDraft()
    expect(aiAddressErrors(harness)).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Confirm address' }))
    expect(aiAddressErrors(harness)).toBe(0)
    expect(harness.probe.current?.form.endings[0]?.button?.url).toBe('https://example.com/help')
  })

  it('removes a suggested address the person does not want', async () => {
    const user = userEvent.setup()
    const harness = renderAiDraft()
    await user.click(screen.getByRole('button', { name: 'Remove' }))
    expect(harness.probe.current?.form.endings[0]?.button).toBeUndefined()
    expect(aiAddressErrors(harness)).toBe(0)
  })

  it('undoes "Improve with AI": the form goes back to how it was, and the banner goes', async () => {
    const user = userEvent.setup()
    const before = sampleForm()
    const harness = renderWithDraft(<AiDraftBanner />, before)
    act(() => {
      harness.probe.current?.update((form) => ({ ...form, name: 'Changed by the AI' }))
      harness.probe.current?.setAi(() => ({ kind: 'improve', notes: [], warnings: [], marked: new Set(), unconfirmed: [], before, description: '' }))
    })
    await user.click(screen.getByRole('button', { name: 'Undo AI changes' }))
    expect([harness.probe.current?.form, harness.probe.current?.ai]).toStrictEqual([before, null])
    expect(screen.queryByText('Changed with AI: review before saving.')).not.toBeInTheDocument()
  })
})
