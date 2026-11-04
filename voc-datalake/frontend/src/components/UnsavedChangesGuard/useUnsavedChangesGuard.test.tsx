/**
 * The shared unsaved-changes guard (E2E F6): route changes (useBlocker),
 * beforeunload, imperative `requestLeave`, the registry for local-state
 * navigation, and the Save / Discard / Cancel dialog's outcomes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom'
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard'
import { runGuarded } from './guardRegistry'
import type { UnsavedChangesGuardOptions } from './useUnsavedChangesGuard'
import type { ReactNode } from 'react'

type GuardUserSession = ReturnType<typeof userEvent.setup>

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

/** `/editor` showing `editor` (under a data router, so `useBlocker` is live) and an `/elsewhere` page. */
function renderEditorRoute(editor: ReactNode, initialEntries: string[] = ['/editor']) {
  const router = createMemoryRouter(
    [
      { path: '/editor', element: editor },
      { path: '/elsewhere', element: <p>Elsewhere page</p> },
    ],
    { initialEntries },
  )
  render(<RouterProvider router={router} />)
  return { user: userEvent.setup(), router }
}

function renderInDataRouter(props: Parameters<typeof Editor>[0]) {
  return renderEditorRoute(<Editor {...props} />)
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

describe('useUnsavedChangesGuard — two editors on one page', () => {
  /** A guard that never has edits: mounted AFTER the dirty editor, like a card below a form. */
  function CleanEditor() {
    const guard = useUnsavedChangesGuard({ dirty: false, onSave: () => Promise.resolve(true) })
    return <>{guard.dialog}</>
  }

  // react-router keeps ONE blocker per router and the last one mounted wins: a clean editor
  // below a dirty one used to take it, so leaving with unsaved edits went through unasked.
  it('a clean editor mounted after a dirty one does not take its route guard', async () => {
    const { router, user } = renderEditorRoute(<><Editor onSave={vi.fn()} /><CleanEditor /></>)
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(dialog()).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/editor')
    expect(screen.queryByText('Elsewhere page')).not.toBeInTheDocument()
  })

  /** A second one-field editor with its own label, mounted after the first. */
  function OtherEditor() {
    const [value, setValue] = useState('')
    const guard = useUnsavedChangesGuard({ dirty: value !== '', onSave: () => Promise.resolve(true), onDiscard: () => setValue('') })
    return <><label>Other <input value={value} onChange={(e) => setValue(e.target.value)} /></label>{guard.dialog}</>
  }

  /** Opened from /elsewhere, so Back has somewhere to go. */
  const renderTwoDirty = () => renderEditorRoute(<><Editor onSave={vi.fn()} /><OtherEditor /></>, ['/elsewhere', '/editor'])

  const nextDialog = async () => within(await screen.findByRole('dialog', { name: 'Unsaved changes' }))

  /** Discard in the next dialog, and the held leave lands on the Elsewhere page. */
  async function expectLeftAfterNextDiscard(user: GuardUserSession) {
    await user.click((await nextDialog()).getByRole('button', { name: 'Discard' }))
    expect(await screen.findByText('Elsewhere page')).toBeInTheDocument()
  }

  /** Follow the Elsewhere link and expect the dialog: the leave is guarded. */
  async function expectLeaveGuarded(user: GuardUserSession) {
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
  }

  /** Both editors dirty, a leave (a link by default), then Discard in the first dialog. */
  async function bothDirtyThenDiscardFirst(leave?: (router: ReturnType<typeof renderTwoDirty>['router']) => Promise<void>) {
    const rendered = renderTwoDirty()
    const { router, user } = rendered
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.type(screen.getByLabelText('Other'), 'y')
    if (leave === undefined) await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    else await leave(router)
    await user.click(within(dialog()).getByRole('button', { name: 'Discard' }))
    return rendered
  }

  // Both dirty: only one blocker exists, so the editor that caught the change holds it while the other asks.
  it('asks every dirty editor in turn, and leaves only after both let it go', async () => {
    const { router, user } = await bothDirtyThenDiscardFirst()
    expect(router.state.location.pathname).toBe('/editor')
    await expectLeftAfterNextDiscard(user)
  })

  // One blocker per router: with both editors dirty only the owner renders one, so react-router
  // never warns "A router only supports one blocker at a time".
  it('mounts a single route blocker however many editors are dirty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { user } = renderTwoDirty()
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.type(screen.getByLabelText('Other'), 'y')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    await screen.findByRole('dialog', { name: 'Unsaved changes' })
    expect([...warn.mock.calls, ...error.mock.calls].flat().map(String).join(' ')).not.toContain('only supports one blocker')
  })

  // The first dirty editor owns the page's one blocker; when it unmounts, the other dirty
  // editor must take the blocker over, or its edits would be lost unasked.
  it('hands the route blocker on when its owner unmounts, so the other editor still asks', async () => {
    const hide = { current: () => {} }
    const onHideReady = (fn: () => void) => { hide.current = fn }
    const { user } = renderEditorRoute(<><Link to="/elsewhere">Leave</Link><OwnerThatUnmounts onHideReady={onHideReady} /><OtherEditor /></>)
    await user.type(screen.getByLabelText('Owner'), 'x')
    await user.type(screen.getByLabelText('Other'), 'y')
    act(() => { hide.current() })
    await user.click(screen.getByRole('link', { name: 'Leave' }))
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
    expect(screen.queryByText('Elsewhere page')).not.toBeInTheDocument()
  })

  /** A guarded editor ("Owner") that the test can unmount. */
  function OwnerThatUnmounts({ onHideReady }: Readonly<{ onHideReady: (hide: () => void) => void }>) {
    const [shown, setShown] = useState(true)
    useEffect(() => { onHideReady(() => setShown(false)) }, [onHideReady])
    return shown ? <KeepsEditsEditor label="Owner" /> : null
  }

  /** Both editors dirty, a leave, Discard in the first dialog, Cancel in the second. */
  async function discardThenCancel() {
    const rendered = await bothDirtyThenDiscardFirst()
    await rendered.user.click((await nextDialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(queryDialog()).not.toBeInTheDocument())
    return rendered
  }

  it('Cancel in the second dialog stays, and the editor that asked second keeps its edits', async () => {
    const { router } = await discardThenCancel()
    expect(router.state.location.pathname).toBe('/editor')
    // The editor dirtied first owns the page's one blocker and asked first: its Discard cleared
    // it, and the other editor, which asked second, keeps its edits after Cancel.
    expect(screen.getByLabelText('Name')).toHaveDisplayValue('')
    expect(screen.getByLabelText('Other')).toHaveDisplayValue('y')
  })

  it('after that Cancel, a new attempt to leave is guarded again', async () => {
    const { user } = await discardThenCancel()
    await expectLeaveGuarded(user)
  })

  it('guards the same leave again after it went through and the page came back', async () => {
    const { router, user } = await bothDirtyThenDiscardFirst()
    await user.click((await nextDialog()).getByRole('button', { name: 'Discard' }))
    await screen.findByText('Elsewhere page')
    await act(() => router.navigate('/editor'))
    await user.type(screen.getByLabelText('Name'), 'again')
    await expectLeaveGuarded(user)
  })

  // The held navigation itself goes on: a Back stays a Back, with no extra history entry.
  it('lets a held Back through as a Back once both editors let it go', async () => {
    const { router, user } = await bothDirtyThenDiscardFirst(async (r) => { await act(() => r.navigate(-1)) })
    await user.click((await nextDialog()).getByRole('button', { name: 'Discard' }))
    expect(await screen.findByText('Elsewhere page')).toBeInTheDocument()
    expect(router.state.historyAction).toBe('POP')
    await act(() => router.navigate(1))
    expect(router.state.location.pathname).toBe('/editor')
  })

  /** An editor with no `onDiscard`: it still reads dirty after its Discard. */
  function KeepsEditsEditor({ label }: Readonly<{ label: string }>) {
    const [value, setValue] = useState('')
    const guard = useUnsavedChangesGuard({ dirty: value !== '', onSave: () => Promise.resolve(true) })
    return <><label>{label} <input value={value} onChange={(e) => setValue(e.target.value)} /></label>{guard.dialog}</>
  }

  // Each editor asks once: one with no `onDiscard` still reads dirty after answering, and two of
  // them used to hand the change back and forth (only the last one to answer was skipped).
  it('asks each dirty editor once, even when neither forgets its edits on Discard', async () => {
    const { user } = renderEditorRoute(<><Link to="/elsewhere">Elsewhere</Link><KeepsEditsEditor label="First" /><KeepsEditsEditor label="Second" /></>)
    await user.type(screen.getByLabelText('First'), 'x')
    await user.type(screen.getByLabelText('Second'), 'y')
    await user.click(screen.getByRole('link', { name: 'Elsewhere' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Discard' }))
    await expectLeftAfterNextDiscard(user)
  })

  // react-router consults only the last blocker mounted. The brand form (it lets ?tab= through)
  // dirtied after the Default theme card (any query change loses it) mounted its blocker last,
  // and a tab switch then dropped the card's pick unasked. Any dirty editor's rule now holds it.
  it('a tab switch asks the editor that would lose its edits, even when another one blocked last', async () => {
    const pathOnly = (current: { pathname: string }, next: { pathname: string }) => current.pathname !== next.pathname
    const { router, user } = renderEditorRoute(<><KeepsEditsEditor label="Card" /><Editor onSave={vi.fn()} options={{ shouldBlock: pathOnly }} /></>)
    await user.type(screen.getByLabelText('Card'), 'nord')
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.click(screen.getByRole('link', { name: 'Tab B' }))
    expect(router.state.location.search).toBe('')
    await user.click(within(dialog()).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(router.state.location.search).toBe('?tab=b'))
  })

  /** The second editor behind a switch the test flips, as a card a tab switch removes. */
  function SwitchableOther({ onHideReady }: Readonly<{ onHideReady: (hide: () => void) => void }>) {
    const [shown, setShown] = useState(true)
    useEffect(() => { onHideReady(() => setShown(false)) }, [onHideReady])
    return shown ? <OtherEditor /> : null
  }

  // A chained dialog that disappears unanswered resets the held change instead of leaving the
  // router blocked with no dialog: the editor that held it guards its next edits as before.
  it('resets the held leave when a chained editor disappears with its dialog open', async () => {
    const hide = { current: () => {} }
    const onHideReady = (fn: () => void) => { hide.current = fn }
    const { router, user } = renderEditorRoute(
      <><Link to="/elsewhere">Leave</Link><Editor onSave={vi.fn()} /><SwitchableOther onHideReady={onHideReady} /></>,
      ['/elsewhere', '/editor'],
    )
    await user.type(screen.getByLabelText('Name'), 'x')
    await user.type(screen.getByLabelText('Other'), 'y')
    await user.click(screen.getByRole('link', { name: 'Leave' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Discard' }))
    await nextDialog()
    act(() => { hide.current() })
    await waitFor(() => expect(queryDialog()).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/editor')
    await user.type(screen.getByLabelText('Name'), 'z')
    await user.click(screen.getByRole('link', { name: 'Leave' }))
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
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
