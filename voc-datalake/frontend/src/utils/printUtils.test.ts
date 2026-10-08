/**
 * @fileoverview Tests for printUtils module (hidden srcdoc iframe printing).
 * @module utils/printUtils.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createPdfGenerator, openPrintWindow } from './printUtils'

const TestContent = () => createElement('div', null, 'Test content')

/**
 * Open a print frame for `TestContent` with the given title (and optional onClose).
 * The frame's `print` is stubbed at once: jsdom fires its own `load` for an
 * attached iframe and its `print` only logs "Not implemented".
 */
function openTestFrame(title = 'Test Title', onClose?: () => void) {
  const result = openPrintWindow({ title, content: createElement(TestContent), onClose })
  if (result) vi.spyOn(result, 'print').mockImplementation(() => undefined)
  return result
}

/** The single print frame currently attached to the document, if any. */
function printFrame(): HTMLIFrameElement | null {
  return document.body.querySelector('iframe')
}

/** The attached print frame; fails the test when there is none. */
function requireFrame(): HTMLIFrameElement {
  const frame = printFrame()
  if (!frame) throw new Error('expected a print frame to be attached')
  return frame
}

/** The attached frame's window; fails the test when there is none. */
function requireFrameWindow(): Window {
  const frameWindow = requireFrame().contentWindow
  if (!frameWindow) throw new Error('expected the print frame to have a window')
  return frameWindow
}

/** Fires the frame's load event, as the browser does once about:srcdoc is parsed. */
function loadFrame() {
  requireFrame().dispatchEvent(new Event('load'))
}

/** The stubbed `print` of the attached frame (installed by `openTestFrame`). */
function spyOnFramePrint() {
  return vi.mocked(requireFrameWindow().print)
}

describe('printUtils', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    for (const frame of document.body.querySelectorAll('iframe')) frame.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('openPrintWindow', () => {
    it('never opens a popup', () => {
      const open = vi.spyOn(window, 'open')

      openTestFrame()

      expect(open).not.toHaveBeenCalled()
    })

    it('attaches a hidden iframe carrying the full document via srcdoc', () => {
      openTestFrame()

      const frame = requireFrame()
      expect(frame.srcdoc).toMatch(/^<!DOCTYPE html>[\s\S]*<title>Test Title<\/title>[\s\S]*<div>Test content<\/div>/)
      expect(frame.getAttribute('src')).toBeNull()
    })

    it('keeps the frame invisible and out of the accessibility tree', () => {
      openTestFrame()

      const frame = requireFrame()
      expect(frame.getAttribute('aria-hidden')).toBe('true')
      expect(frame.style.visibility).toBe('hidden')
      expect([frame.style.width, frame.style.height]).toStrictEqual(['0px', '0px'])
    })

    it('embeds the print styles inline so they apply inside the frame', () => {
      openTestFrame()

      const { srcdoc } = requireFrame()
      expect(srcdoc).toContain('<style>')
      expect(srcdoc).toContain('@media print')
      expect(srcdoc).toContain('@page')
    })

    it('carries no script or inline handler (CSP script-src is self-only)', () => {
      openTestFrame()

      const { srcdoc } = requireFrame()
      expect(srcdoc).not.toMatch(/<script/i)
      expect(srcdoc).not.toMatch(/\son[a-z]+=/i)
    })

    it('escapes HTML in the title', () => {
      openTestFrame('<script>alert("xss")</script>')

      const { srcdoc } = requireFrame()
      expect(srcdoc).not.toContain('<script>alert("xss")</script>')
      expect(srcdoc).toContain('&lt;script&gt;')
    })

    it('returns the frame window', () => {
      const result = openTestFrame()

      expect(result).toBe(requireFrameWindow())
    })

    it('does not print before the frame has loaded', () => {
      openTestFrame()
      const print = spyOnFramePrint()

      expect(print).not.toHaveBeenCalled()
    })

    it('prints exactly once after load', () => {
      openTestFrame()
      const print = spyOnFramePrint()

      loadFrame()
      loadFrame()

      expect(print).toHaveBeenCalledTimes(1)
    })

    it('removes the frame and calls onClose on afterprint', () => {
      const onClose = vi.fn()
      openTestFrame('Test Title', onClose)
      spyOnFramePrint()
      const frameWindow = requireFrameWindow()

      loadFrame()
      expect(printFrame()).not.toBeNull()
      frameWindow.dispatchEvent(new Event('afterprint'))

      expect(printFrame()).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('falls back to removing the frame after a timeout when afterprint never fires', () => {
      const onClose = vi.fn()
      openTestFrame('Test Title', onClose)
      spyOnFramePrint()

      loadFrame()
      vi.advanceTimersByTime(59_999)
      expect(printFrame()).not.toBeNull()
      vi.advanceTimersByTime(1)

      expect(printFrame()).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('cleans up only once when afterprint precedes the fallback timeout', () => {
      const onClose = vi.fn()
      openTestFrame('Test Title', onClose)
      spyOnFramePrint()
      const frameWindow = requireFrameWindow()

      loadFrame()
      frameWindow.dispatchEvent(new Event('afterprint'))
      vi.runAllTimers()

      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('removes the frame when print() throws', () => {
      const onClose = vi.fn()
      openTestFrame('Test Title', onClose)
      vi.spyOn(requireFrameWindow(), 'print').mockImplementation(() => {
        throw new Error('printing disabled')
      })

      loadFrame()

      expect(printFrame()).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('returns null and removes the frame when no contentWindow is created', () => {
      const onClose = vi.fn()
      vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(null)

      expect(openTestFrame('Test Title', onClose)).toBeNull()
      expect(printFrame()).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('removes the frame without printing when the window is gone by load time', () => {
      const onClose = vi.fn()
      openTestFrame('Test Title', onClose)
      const frame = requireFrame()
      vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(null)

      frame.dispatchEvent(new Event('load'))

      expect(printFrame()).toBeNull()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('createPdfGenerator', () => {
    it('resolves a function title from the props', () => {
      const generate = createPdfGenerator<{ name: string }>(
        (p) => `Report ${p.name}`,
        () => createElement(TestContent),
      )

      generate({ name: 'Q3' })
      vi.spyOn(requireFrameWindow(), 'print').mockImplementation(() => undefined)

      expect(requireFrame().srcdoc).toContain('<title>Report Q3</title>')
    })

    it('throws when the print document cannot be prepared', () => {
      vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(null)
      const generate = createPdfGenerator('Report', () => createElement(TestContent))

      expect(() => generate(undefined)).toThrow('Failed to prepare the print document.')
    })
  })
})
