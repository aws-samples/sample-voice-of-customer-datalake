/**
 * "Stop" while the AI drafts (the owner's decision of 2026-11-18): it asks first; "Stop drafting" stops the request and
 * "Keep drafting" leaves it running. The picker and "Improve with AI" show it only while a draft is generating.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../test/test-utils'
import StopDraftButton from './StopDraftButton'

/** The button, pressed once: its confirm is open. */
async function pressStop() {
  const user = userEvent.setup()
  const onStop = vi.fn<() => void>()
  render(<StopDraftButton onStop={onStop} />)
  await user.click(screen.getByRole('button', { name: 'Stop' }))
  return { user, onStop }
}

describe('StopDraftButton', () => {
  it('asks before it stops, then stops the draft', async () => {
    const { user, onStop } = await pressStop()
    expect(onStop).not.toHaveBeenCalled()
    await user.click(within(screen.getByRole('dialog', { name: 'Stop drafting?' })).getByRole('button', { name: 'Stop drafting' }))
    expect(onStop).toHaveBeenCalledWith()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps drafting when the person changes their mind', async () => {
    const { user, onStop } = await pressStop()
    await user.click(screen.getByRole('button', { name: 'Keep drafting' }))
    expect(onStop).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
