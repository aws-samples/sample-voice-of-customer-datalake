/**
 * The shared unsaved-changes guard (E2E F6): route changes (useBlocker),
 * beforeunload, imperative `requestLeave`, the registry for local-state
 * navigation, and the Save / Discard / Cancel dialog's outcomes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom'
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard'
import { runGuarded } from './guardRegistry'
import type { UnsavedChangesGuardOptions } from './useUnsavedChangesGuard'

type Overrides = Partial<Pick<UnsavedChangesGuardOptions, 'canSave' | 'shouldBlock'>>

/** A one-field editor: typing makes it dirty, `onSave` is the test's. */
function Editor({ onSave, onDiscard, options = {} }: Readonly<{
  onSave: (value: string) => Promise<boolean>
  onDiscard?: () => void
  options?: Overrides
}>) {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState('')
  const [closed, setClosed] = useState(false)
  const guard = useUnsavedChangesGuard({
    dirty: value !== saved,
    onSave: async () => {
      const ok = await onSave(value)
      if (ok) setSaved(value)
      return ok
    },
    onDiscard: () => {
      setValue(saved)
      onDiscard?.()
    },
    ...options,
  })
  const { pathname, search } = useLocation()
  return (
    <div>
      <p data-testid="where">{pathname + search}</p>
      <label>Name <input value={value} onChange={(e) => setValue(e.target.value)} /></label>
      <Link to="/elsewhere">Elsewhere</Link>
      <Link to="/editor?tab=b">Tab B</Link>
      <button type="button" onClick={() => guard.requestLeave(() => setClosed(true))}>Close editor</button>
      {closed && <p>editor closed</p>}
      {guard.dialog}
    </div>
  )
}

function renderInDataRouter(props: Parameters<typeof Editor>[0]) {
  const router = createMemoryRouter(
    [
      { path: '/editor', element: <Editor {...props} /> },
      { path: '/elsewhere', element: <p>Elsewhere page</p> },
    ],
    { initialEntries: ['/editor'] },
  )
  render(<RouterProvider router={router} />)
  return { user: userEvent.setup(), router }
}

const dialog = () => screen.getByRole('dialog', { name: 'Unsaved changes' })
const queryDialog = () => screen.queryByRole('dialog', { name: 'Unsaved changes' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useUnsavedChangesGuard — route changes', () => {
  it('lets a clean editor navigate without asking', async () => {
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(screen.getByText('Elsewhere page')).toBeInTheDocument()
    expect(queryDialog()).not.toBeInTheDocument()
  })

  it('opens one named dialog with Save, Discard and Cancel when a dirty editor navigates', async () => {
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(dialog()).toBeInTheDocument()
    for (const name of ['Save', 'Discard', 'Cancel']) expect(screen.getByRole('button', { name })).toBeInTheDocument()
    // Focus starts on the safe choice.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(screen.queryByText('Elsewhere page')).not.toBeInTheDocument()
  })

  it('Cancel stays on the page with the edits intact', async () => {
    const onSave = vi.fn()
    const { user } = renderInDataRouter({ onSave })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(queryDialog()).not.toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/editor')
    expect(screen.getByLabelText('Name')).toHaveValue('draft')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Escape is Cancel', async () => {
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    await user.keyboard('{Escape}')
    expect(queryDialog()).not.toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('draft')
  })

  it('Discard throws the edits away and navigates without saving', async () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    const { user } = renderInDataRouter({ onSave, onDiscard })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(await screen.findByText('Elsewhere page')).toBeInTheDocument()
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Save runs the editor save and navigates once it succeeds', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    const { user } = renderInDataRouter({ onSave })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Elsewhere page')).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledWith('draft')
  })

  it.each([
    ['resolves false', () => Promise.resolve(false)],
    ['rejects', () => Promise.reject(new Error('500'))],
  ])('Save that %s stays put, says so, and keeps the dialog open', async (_label, impl) => {
    const onSave = vi.fn(impl)
    const { user } = renderInDataRouter({ onSave })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(/could not save/i)
    expect(screen.queryByText('Elsewhere page')).not.toBeInTheDocument()
    // Cancel after a failure still returns to the edits.
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('Name')).toHaveValue('draft')
  })

  it('disables Save when the draft cannot be saved, leaving Discard and Cancel', async () => {
    const { user } = renderInDataRouter({ onSave: vi.fn(), options: { canSave: false } })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()
  })

  it('blocks a query-only change (?tab=) by default', async () => {
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('link', { name: 'Tab B' }))
    expect(dialog()).toBeInTheDocument()
  })

  it('shouldBlock can let same-path tab switches through', async () => {
    const { user } = renderInDataRouter({
      onSave: vi.fn(),
      options: { shouldBlock: (current, next) => current.pathname !== next.pathname },
    })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('link', { name: 'Tab B' }))
    expect(queryDialog()).not.toBeInTheDocument()
    expect(screen.getByTestId('where')).toHaveTextContent('/editor?tab=b')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(dialog()).toBeInTheDocument()
  })
})

describe('useUnsavedChangesGuard — beforeunload', () => {
  it('registers beforeunload only once dirty, and the event asks for the browser prompt', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    const registered = () => add.mock.calls.filter(([type]) => type === 'beforeunload')
    expect(registered()).toHaveLength(0)
    await user.type(screen.getByLabelText('Name'), 'x')
    expect(registered()).toHaveLength(1)
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('removes the beforeunload listener when the editor is clean again', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.clear(screen.getByLabelText('Name'))
    await waitFor(() => expect(remove.mock.calls.filter(([type]) => type === 'beforeunload')).toHaveLength(1))
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})

describe('useUnsavedChangesGuard — requestLeave and the registry', () => {
  it('runs the action at once when the editor is clean', async () => {
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    await user.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(screen.getByText('editor closed')).toBeInTheDocument()
  })

  it('a dirty editor asks before an imperative close (a modal X), and Cancel keeps it open', async () => {
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('button', { name: 'Close editor' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('editor closed')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close editor' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByText('editor closed')).toBeInTheDocument()
  })

  it('runGuarded routes local-state navigation through the dirty editor on screen', async () => {
    const { user } = renderInDataRouter({ onSave: vi.fn() })
    const action = vi.fn()
    runGuarded(action)
    expect(action).toHaveBeenCalledTimes(1)

    await user.type(screen.getByLabelText('Name'), 'draft')
    runGuarded(action)
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
    expect(action).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('works without a data router (no blocker), so page tests under MemoryRouter still render', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter initialEntries={['/editor']}><Editor onSave={vi.fn()} /></MemoryRouter>)
    await user.type(screen.getByLabelText('Name'), 'draft')
    await user.click(screen.getByRole('button', { name: 'Close editor' }))
    expect(dialog()).toBeInTheDocument()
  })
})
