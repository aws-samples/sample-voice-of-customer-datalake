/**
 * The focus view's behaviour: the address (the document path's `/focus`; entering and leaving are history entries, so
 * Back leaves full screen and Forward comes back), the button, Ctrl/⌘+Shift+F, Escape (unless something open owns it;
 * never the page's own toolbar), focus moves, and the shell's flag.
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useCallback, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { useProjectPlace } from '../../../pages/ProjectDetail/useProjectPlace'
import { setFocusViewActive, useFocusViewActive } from './focusView'
import { isFocusViewShortcut, useFocusView } from './useFocusView'

/** As the document page wires it: the place's `/focus`, entered and left as history entries. */
function Harness({ focusCanvas }: Readonly<{ focusCanvas: () => void }>) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { place, go } = useProjectPlace()
  const setFocus = useCallback((on: boolean) => { go({ ...place, focus: on }) }, [go, place])
  const focus = useFocusView(place.focus, setFocus, focusCanvas, buttonRef)
  const location = useLocation()
  const navigate = useNavigate()
  const shell = useFocusViewActive()
  return (
    <div>
      <p data-testid="path">{location.pathname}</p>
      <p data-testid="shell">{String(shell)}</p>
      <button ref={buttonRef} type="button" aria-pressed={focus.active} onClick={focus.toggle}>Full screen</button>
      <button type="button" onClick={() => { void navigate(-1) }}>Back</button>
      <button type="button" onClick={() => { void navigate(1) }}>Forward</button>
    </div>
  )
}

function renderAt(entry: string, focusCanvas = vi.fn()) {
  const view = render(
    <MemoryRouter initialEntries={['/projects/p/documents', entry]} initialIndex={1}>
      <Harness focusCanvas={focusCanvas} />
    </MemoryRouter>,
  )
  return { ...view, focusCanvas, user: userEvent.setup() }
}

const toggle = () => screen.getByRole('button', { name: 'Full screen' })
/** The address, the button's pressed state and the shell's flag, as one value. */
const seen = () => ({
  path: screen.getByTestId('path').textContent,
  pressed: toggle().getAttribute('aria-pressed'),
  shell: screen.getByTestId('shell').textContent,
})
const path = () => screen.getByTestId('path').textContent

afterEach(() => { setFocusViewActive(false) })

describe('useFocusView', () => {
  it('enters on the button: `/focus` in the address, the shell steps aside, focus goes to the canvas', async () => {
    const { user, focusCanvas } = renderAt('/projects/p/documents/d')
    expect(seen()).toStrictEqual({ path: '/projects/p/documents/d', pressed: 'false', shell: 'false' })
    await user.click(toggle())
    expect(seen()).toStrictEqual({ path: '/projects/p/documents/d/focus', pressed: 'true', shell: 'true' })
    expect(focusCanvas).toHaveBeenCalledTimes(1)
  })

  it('leaves on the button, focus back on the button', async () => {
    const { user } = renderAt('/projects/p/documents/d')
    await user.click(toggle())
    toggle().blur()
    await user.click(toggle())
    expect(seen()).toStrictEqual({ path: '/projects/p/documents/d', pressed: 'false', shell: 'false' })
    expect(toggle()).toHaveFocus()
  })

  it('is a history entry: Back leaves full screen, Forward comes back to it', async () => {
    const { user } = renderAt('/projects/p/documents/d')
    await user.click(toggle())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(seen()).toStrictEqual({ path: '/projects/p/documents/d', pressed: 'false', shell: 'false' })
    await user.click(screen.getByRole('button', { name: 'Forward' }))
    expect(seen()).toStrictEqual({ path: '/projects/p/documents/d/focus', pressed: 'true', shell: 'true' })
  })

  it('keeps an older version on screen as it enters and leaves', async () => {
    const { user } = renderAt('/projects/p/documents/d/v/2')
    await user.click(toggle())
    expect(path()).toBe('/projects/p/documents/d/v/2/focus')
    await user.click(toggle())
    expect(path()).toBe('/projects/p/documents/d/v/2')
  })

  it('keeps it on load (a reload, a link) without moving focus', () => {
    const { focusCanvas } = renderAt('/projects/p/documents/d/focus')
    expect(seen()).toStrictEqual({ path: '/projects/p/documents/d/focus', pressed: 'true', shell: 'true' })
    expect(focusCanvas).not.toHaveBeenCalled()
  })

  it('toggles on Ctrl+Shift+F and ⌘+Shift+F', async () => {
    const { user } = renderAt('/projects/p/documents/d')
    await user.keyboard('{Control>}{Shift>}F{/Shift}{/Control}')
    expect(path()).toBe('/projects/p/documents/d/focus')
    await user.keyboard('{Meta>}{Shift>}F{/Shift}{/Meta}')
    expect(path()).toBe('/projects/p/documents/d')
  })

  it('leaves on Escape', async () => {
    const { user } = renderAt('/projects/p/documents/d/focus')
    await user.keyboard('{Escape}')
    expect(path()).toBe('/projects/p/documents/d')
  })

  it('leaves Escape alone when it is not in focus view', async () => {
    const { user } = renderAt('/projects/p/documents/d')
    await user.keyboard('{Escape}')
    expect(path()).toBe('/projects/p/documents/d')
  })

  it('leaves on Escape with the page\'s own toolbar there: that row owns no Escape', () => {
    renderAt('/projects/p/documents/d/focus')
    const bar = document.createElement('div')
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('data-document-toolbar', '')
    document.body.append(bar)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(path()).toBe('/projects/p/documents/d')
    bar.remove()
  })

  it('leaves Escape to an open dialog or menu, and to a popover that took it', () => {
    renderAt('/projects/p/documents/d/focus')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(path()).toBe('/projects/p/documents/d/focus')
    dialog.remove()

    const taken = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    taken.preventDefault()
    act(() => { window.dispatchEvent(taken) })
    expect(path()).toBe('/projects/p/documents/d/focus')
  })

  it('leaves on Escape in the canvas\'s text, which the editor marks handled, unless a popover was open', () => {
    renderAt('/projects/p/documents/d/focus')
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
    expect(path(), 'the format bar was open: its Escape').toBe('/projects/p/documents/d/focus')
    bar.remove()
    press()
    expect(path()).toBe('/projects/p/documents/d')
    text.remove()
  })

  it('clears the shell\'s flag when the page goes', () => {
    const { unmount } = renderAt('/projects/p/documents/d/focus')
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
