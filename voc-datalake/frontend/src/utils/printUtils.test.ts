/**
 * @fileoverview Tests for printUtils module
 * @module utils/printUtils.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'

describe('printUtils', () => {
  let mockPrintBtn: { addEventListener: ReturnType<typeof vi.fn> }
  let mockWindow: {
    document: {
      write: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      getElementById: ReturnType<typeof vi.fn>
    }
    print: ReturnType<typeof vi.fn>
    onload: (() => void) | null
    onbeforeunload: (() => void) | null
  }

  beforeEach(() => {
    mockPrintBtn = { addEventListener: vi.fn() }
    mockWindow = {
      document: {
        write: vi.fn(),
        close: vi.fn(),
        getElementById: vi.fn().mockReturnValue(mockPrintBtn),
      },
      print: vi.fn(),
      onload: null,
      onbeforeunload: null,
    }
    vi.spyOn(window, 'open').mockReturnValue(mockWindow as unknown as Window)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('openPrintWindow', () => {
    it('opens a new window', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      expect(window.open).toHaveBeenCalledWith('', '_blank')
    })

    it('returns null when popup is blocked', async () => {
      vi.spyOn(window, 'open').mockReturnValue(null)
      
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      const result = openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      expect(result).toBeNull()
    })

    it('writes HTML to the new window', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      expect(mockWindow.document.write).toHaveBeenCalled()
      const writtenHtml = mockWindow.document.write.mock.calls[0][0] as string
      expect(writtenHtml).toContain('Test Title')
      expect(writtenHtml).toContain('<!DOCTYPE html>')
    })

    it('closes the document after writing', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      expect(mockWindow.document.close).toHaveBeenCalled()
    })

    it('sets up onload handler to trigger print', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      expect(mockWindow.onload).toBeDefined()
    })

    it('sets up onbeforeunload handler when onClose is provided', async () => {
      const { openPrintWindow } = await import('./printUtils')
      const onClose = vi.fn()
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
        onClose,
      })

      expect(mockWindow.onbeforeunload).toBe(onClose)
    })

    it('does not set onbeforeunload when onClose is not provided', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      expect(mockWindow.onbeforeunload).toBeNull()
    })

    it('escapes HTML in title', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: '<script>alert("xss")</script>',
        content: createElement(TestContent),
      })

      const writtenHtml = mockWindow.document.write.mock.calls[0][0] as string
      expect(writtenHtml).not.toContain('<script>alert("xss")</script>')
      expect(writtenHtml).toContain('&lt;script&gt;')
    })

    it('includes print styles in the HTML', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      const writtenHtml = mockWindow.document.write.mock.calls[0][0] as string
      expect(writtenHtml).toContain('@media print')
      expect(writtenHtml).toContain('@page')
    })

    it('includes print button in the HTML', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      const writtenHtml = mockWindow.document.write.mock.calls[0][0] as string
      expect(writtenHtml).toContain('Print / Save as PDF')
      expect(writtenHtml).toContain('id="print-btn"')
    })

    it('returns the window reference', async () => {
      const { openPrintWindow } = await import('./printUtils')
      
      const TestContent = () => createElement('div', null, 'Test content')
      const result = openPrintWindow({
        title: 'Test Title',
        content: createElement(TestContent),
      })

      expect(result).toBe(mockWindow)
    })
  })
})
