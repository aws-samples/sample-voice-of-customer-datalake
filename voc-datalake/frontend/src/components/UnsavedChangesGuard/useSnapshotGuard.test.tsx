/**
 * The guard of an editor dialog whose edits are one value (useSnapshotGuard): its `close` leaves at once while the
 * value is the one it opened with, and otherwise asks Save / Discard / Cancel first.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { saveIgnoringFailure, useSnapshotGuard } from './useSnapshotGuard'

/** A one-field editor dialog: its Close is the guard's `close`. */
function NameEditor({ onSave, onClose }: Readonly<{ onSave: (name: string) => Promise<unknown>; onClose: () => void }>) {
  const [name, setName] = useState('Ana')
  const { close, dialog } = useSnapshotGuard({ value: { name }, onSave: () => onSave(name), onClose })
  return (
    <div>
      <label>Name <input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <button type="button" onClick={close}>Close</button>
      {dialog}
    </div>
  )
}

function renderEditor() {
  const onSave = vi.fn<(name: string) => Promise<unknown>>(() => Promise.resolve())
  const onClose = vi.fn<() => void>()
  render(<MemoryRouter><NameEditor onSave={onSave} onClose={onClose} /></MemoryRouter>)
  return { user: userEvent.setup(), onSave, onClose }
}

const guardDialog = () => screen.getByRole('dialog', { name: 'Unsaved changes' })

describe('useSnapshotGuard', () => {
  it('closes at once while the value is the one it opened with', async () => {
    const { user, onClose } = renderEditor()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledWith()
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument()
  })

  it('asks first once the value changed, and Save saves it before closing', async () => {
    const { user, onSave, onClose } = renderEditor()
    await user.type(screen.getByLabelText('Name'), 'ia')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(within(guardDialog()).getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledWith() })
    expect(onSave).toHaveBeenCalledWith('Anaia')
  })

  it('stays open when the save fails, saying so', async () => {
    const { user, onSave, onClose } = renderEditor()
    onSave.mockRejectedValue(new Error('Network down'))
    await user.type(screen.getByLabelText('Name'), 'ia')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(within(guardDialog()).getByRole('button', { name: 'Save' }))
    expect(await within(guardDialog()).findByRole('alert')).toHaveTextContent('Could not save. Your changes are still here; try again or cancel.')
    expect(onClose).not.toHaveBeenCalledWith()
  })

  it('Discard closes without saving', async () => {
    const { user, onSave, onClose } = renderEditor()
    await user.type(screen.getByLabelText('Name'), 'ia')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(within(guardDialog()).getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledWith()
    expect(onSave).not.toHaveBeenCalledWith(expect.anything())
  })
})

describe('saveIgnoringFailure', () => {
  it('fires the save and leaves a failure to the host', async () => {
    const save = vi.fn<() => Promise<unknown>>(() => Promise.reject(new Error('Network down')))
    saveIgnoringFailure(save)
    await waitFor(() => { expect(save).toHaveBeenCalledWith() })
  })
})
