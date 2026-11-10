/**
 * #386, regressed by the opaque-origin prototype sandbox (4b5999df): Escape pressed INSIDE
 * the prototype frame closes the dialog again, because the frame's pin widget forwards it
 * as a message. Only a message from a frame inside THIS dialog, with the prototype's
 * origin and the exact payload, closes it.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ModalShell from './ModalShell'

const ESCAPE = { source: 'voc-pin-widget', type: 'escape' }

function setup(dismissable = true) {
  const onClose = vi.fn()
  render(
    <>
      <iframe title="Elsewhere" />
      <ModalShell isOpen onClose={onClose} ariaLabel="Prototype" dismissable={dismissable}>
        <button type="button">Close</button>
        <iframe title="Prototype frame" />
      </ModalShell>
    </>,
  )
  const windowOf = (title: string) => {
    const frame = screen.getByTitle(title)
    if (!(frame instanceof HTMLIFrameElement) || frame.contentWindow === null) throw new Error(`no window for ${title}`)
    return frame.contentWindow
  }
  const post = (data: unknown, source: Window, origin = 'null') => {
    window.dispatchEvent(new MessageEvent('message', { data, source, origin }))
  }
  return { onClose, post, inside: windowOf('Prototype frame'), elsewhere: windowOf('Elsewhere') }
}

describe('ModalShell: Escape forwarded from an opaque-origin frame (#386)', () => {
  it('closes the dialog when its own prototype frame forwards Escape', () => {
    const { onClose, post, inside } = setup()
    post(ESCAPE, inside)
    expect(onClose).toHaveBeenCalledExactlyOnceWith()
  })

  it('accepts the app\'s own origin (a prototype served before the sandbox) too', () => {
    const { onClose, post, inside } = setup()
    post(ESCAPE, inside, window.location.origin)
    expect(onClose).toHaveBeenCalledExactlyOnceWith()
  })

  it('ignores a frame outside the dialog, another origin, and any other payload', () => {
    const { onClose, post, inside, elsewhere } = setup()
    post(ESCAPE, elsewhere)
    post(ESCAPE, inside, 'https://example.com')
    post({ ...ESCAPE, extra: true }, inside)
    post({ source: 'voc-pin-widget', type: 'ready' }, inside)
    post('escape', inside)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('never closes a dialog that is not dismissable', () => {
    const { onClose, post, inside } = setup(false)
    post(ESCAPE, inside)
    expect(onClose).not.toHaveBeenCalled()
  })
})
