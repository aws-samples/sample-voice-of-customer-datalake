/**
 * The header's save status on a live form kept on its own unreadable theme (saved before 7.04.00): a warning in
 * words with the way to its colours, never the error that blocks Update live form; a draft whose colours become
 * unreadable is told instead that publishing waits.
 */
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_THEME } from '../model/formsV2'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import BuilderHeader from './BuilderHeader'

const GREY = { ...DEFAULT_THEME, text_color: '#9ca3af' }

describe('the save status and an unreadable theme', () => {
  it('warns on a live form kept on it, with the way to its colours', async () => {
    const harness = renderWithDraft(<BuilderHeader />, sampleForm({ enabled: true, theme: GREY }))
    const status = await screen.findByText("This form's text is hard to read.")
    expect(status.closest('[role="status"]')).not.toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fix its colours' }))
    expect(harness.go).toHaveBeenCalledWith('settings', ['appearance'])
  })

  it('says nothing of it on a readable form, and that publishing waits once a change makes it unreadable', async () => {
    const harness = renderWithDraft(<BuilderHeader />, sampleForm({ enabled: false }))
    await waitFor(() => { expect(harness.probe.current).not.toBeNull() })
    expect(screen.queryByText("This form's text is hard to read.")).not.toBeInTheDocument()
    harness.probe.current?.update((form) => ({ ...form, theme: GREY }))
    expect(await screen.findByText(/to publish\. Saving still works\./)).toBeInTheDocument()
    expect(screen.queryByText("This form's text is hard to read.")).not.toBeInTheDocument()
  })
})
