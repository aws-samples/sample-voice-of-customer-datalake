/**
 * The focus view's behaviour: the address (`?view=focus`, written in place both ways, so Back goes to the page before,
 * never to an older version saved in focus view), the button, Ctrl/⌘+Shift+F, Escape (unless something open owns it), focus moves, and the shell's flag.
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { setFocusViewActive, useFocusViewActive } from './focusView'
import { isFocusViewShortcut, useFocusView } from './useFocusView'

function Harness({ focusCanvas }: Readonly<{ focusCanvas: () => void }>) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const focus = useFocusView(focusCanvas, buttonRef)
  const location = useLocation()
  const navigate = useNavigate()
  const [, setParams] = useSearchParams()
  const shell = useFocusViewActive()
  return (
    <div>
      <p data-testid="search">{location.search}</p>
      <p data-testid="shell">{String(shell)}</p>
      <button ref={buttonRef} type="button" aria-pressed={focus.active} onClick={focus.toggle}>Full screen</button>
      <button type="button" onClick={() => { void navigate(-1) }}>Back</button>
      <button type="button" onClick={() => {
        setParams((prev) => { const next = new URLSearchParams(prev); next.set('doc', 'v6'); return next }, { replace: true })
      }}>Select v6</button>
    </div>
  )
}

function renderAt(entry: string, focusCanvas = vi.fn()) {
  const view = render(
    <MemoryRouter initialEntries={['/projects/p?tab=documents', entry]} initialIndex={1}>
      <Harness focusCanvas={focusCanvas} />
    </MemoryRouter>,
  )
  return { ...view, focusCanvas, user: userEvent.setup() }
}

const toggle = () => screen.getByRole('button', { name: 'Full screen' })
const back = () => screen.getByRole('button', { name: 'Back' })
/** The address's query, the button's pressed state and the shell's flag, as one value. */
const seen = () => ({
  search: screen.getByTestId('search').textContent,
  pressed: toggle().getAttribute('aria-pressed'),
  shell: screen.getByTestId('shell').textContent,
})
const search = () => screen.getByTestId('search').textContent

afterEach(() => { setFocusViewActive(false) })

describe('useFocusView', () => {
  it('enters on the button: the option in the address, the shell steps aside, focus goes to the canvas', async () => {
    const { user, focusCanvas } = renderAt('/projects/p?tab=documents&doc=d')
    expect(seen()).toStrictEqual({ search: '?tab=documents&doc=d', pressed: 'false', shell: 'false' })
    await user.click(toggle())
    expect(seen()).toStrictEqual({ search: '?tab=documents&doc=d&view=focus', pressed: 'true', shell: 'true' })
    expect(focusCanvas).toHaveBeenCalledTimes(1)
  })

  it('leaves on the button in place, focus back on the button; Back then goes to the page before', async () => {
    const { user } = renderAt('/projects/p?tab=documents&doc=d')
    await user.click(toggle())
    toggle().blur()
    await user.click(toggle())
    expect(seen()).toStrictEqual({ search: '?tab=documents&doc=d', pressed: 'false', shell: 'false' })
    expect(toggle()).toHaveFocus()
    await user.click(back())
    expect(search()).toBe('?tab=documents')
  })

  it('adds no history entry: Back in focus view goes to the page before', async () => {
    const { user } = renderAt('/projects/p?tab=documents&doc=d')
    await user.click(toggle())
    await user.click(back())
    expect(seen()).toStrictEqual({ search: '?tab=documents', pressed: 'false', shell: 'false' })
  })

  it('after a save in focus view (the new version selected in place), Back never shows the older version', async () => {
    const { user } = renderAt('/projects/p?tab=documents&doc=v5')
    await user.click(toggle())
    // As the page's selection does on a save: `?doc=` rewritten in place.
    await user.click(screen.getByRole('button', { name: 'Select v6' }))
    expect(search()).toBe('?tab=documents&doc=v6&view=focus')

    await user.click(back())

    expect(search()).not.toContain('doc=v5')
    expect(search()).toBe('?tab=documents')
  })

  it('keeps it on load (a reload, a link) without moving focus, and leaves a link\'s entry in place', async () => {
    const { user, focusCanvas } = renderAt('/projects/p?doc=d&view=focus')
    expect(seen()).toStrictEqual({ search: '?doc=d&view=focus', pressed: 'true', shell: 'true' })
    expect(focusCanvas).not.toHaveBeenCalled()
    await user.click(toggle())
    expect(search()).toBe('?doc=d')
    await user.click(back())
    expect(search(), 'replaced: Back goes to the page before').toBe('?tab=documents')
  })

  it('toggles on Ctrl+Shift+F and ⌘+Shift+F', async () => {
    const { user } = renderAt('/projects/p?doc=d')
    await user.keyboard('{Control>}{Shift>}F{/Shift}{/Control}')
    expect(search()).toBe('?doc=d&view=focus')
    await user.keyboard('{Meta>}{Shift>}F{/Shift}{/Meta}')
    expect(search()).toBe('?doc=d')
  })

  it('leaves on Escape', async () => {
    const { user } = renderAt('/projects/p?doc=d&view=focus')
    await user.keyboard('{Escape}')
    expect(search()).toBe('?doc=d')
  })

  it('leaves Escape alone when it is not in focus view', async () => {
    const { user } = renderAt('/projects/p?doc=d')
    await user.keyboard('{Escape}')
    expect(search()).toBe('?doc=d')
  })

  it('leaves Escape to an open dialog or menu, and to a popover that took it', () => {
    renderAt('/projects/p?doc=d&view=focus')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(search()).toBe('?doc=d&view=focus')
    dialog.remove()

    const taken = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    taken.preventDefault()
    act(() => { window.dispatchEvent(taken) })
    expect(search()).toBe('?doc=d&view=focus')
  })

  it('leaves on Escape in the canvas\'s text, which the editor marks handled, unless a popover was open', () => {
    renderAt('/projects/p?doc=d&view=focus')
    const text = document.createElement('div')
    text.className = 'ProseMirror'
    document.body.append(text)
    const press = () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
      text.addEventListener('keydown', (e) => { e.preventDefault() }, { once: true })
      act(() => { text.dispatchEvent(event) })
    }
    const bar = document.createElement('div')
    bar.setAttribute('role', 'toolbar')
    document.body.append(bar)
    press()
    expect(search(), 'the format bar was open: its Escape').toBe('?doc=d&view=focus')
    bar.remove()
    press()
    expect(search()).toBe('?doc=d')
    text.remove()
  })

  it('clears the shell\'s flag when the page goes', () => {
    const { unmount } = renderAt('/projects/p?doc=d&view=focus')
    expect(screen.getByTestId('shell')).toHaveTextContent('true')
    unmount()
    render(<MemoryRouter><ShellProbe /></MemoryRouter>)
    expect(screen.getByTestId('probe')).toHaveTextContent('false')
  })
})

function ShellProbe() {
  return <p data-testid="probe">{String(useFocusViewActive())}</p>
}

describe('isFocusViewShortcut', () => {
  const key = (overrides: Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>>) =>
    ({ key: 'F', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, ...overrides })
  it.each([
    [key({ ctrlKey: true }), true],
    [key({ metaKey: true, key: 'f' }), true],
    [key({}), false],
    [key({ ctrlKey: true, shiftKey: false, key: 'f' }), false],
    [key({ ctrlKey: true, altKey: true }), false],
    [key({ ctrlKey: true, key: 'G' }), false],
  ])('%o -> %s', (event, expected) => {
    expect(isFocusViewShortcut(event)).toBe(expected)
  })
})
