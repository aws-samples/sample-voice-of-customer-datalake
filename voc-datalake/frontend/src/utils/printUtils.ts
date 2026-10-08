/**
 * @fileoverview Browser-based print utilities for PDF export.
 * Uses native browser print dialog instead of jsPDF for better quality and smaller bundle.
 *
 * The print document is loaded into a hidden, same-origin `<iframe srcdoc>` and
 * printed with `iframe.contentWindow.print()` once its `load` event fires — the
 * pattern MDN documents under "Print an external page without opening it"
 * (https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing).
 * This replaces the old `window.open('')` + `document.write()` popup:
 * `document.write` is strongly discouraged by the HTML spec and MDN, and the
 * popup was subject to popup blockers.
 *
 * CSP: an `about:srcdoc` document inherits the embedding page's policy and is
 * not a fetch, so `frame-src 'self'` does not block it (a `blob:` URL would need
 * `frame-src blob:`). The inline `<style>` below is allowed by the app's
 * `style-src 'unsafe-inline'`; the document carries no script.
 * @module utils/printUtils
 */

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'

/**
 * Fallback removal delay after `print()` returns, for browsers whose `print()`
 * is non-blocking and that never fire `afterprint` on the frame. Generous so a
 * dialog that is still open is not torn down under the user.
 */
const CLEANUP_FALLBACK_MS = 60_000

/**
 * Print styles applied to the print document.
 * Includes page break controls and print-optimized typography.
 */
const PRINT_STYLES = `
  @media print {
    @page {
      size: A4;
      margin: 15mm;
    }
    
    body {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    
    /* Prevent page breaks inside these elements */
    [data-pdf-section],
    blockquote,
    pre,
    table,
    img {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    
    /* Add some space before sections that start a new page */
    h1, h2, h3 {
      break-after: avoid;
      page-break-after: avoid;
    }
  }
  
  * {
    box-sizing: border-box;
  }
  
  body {
    margin: 0;
    padding: 20px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #ffffff;
    color: #19161d;
    line-height: 1.6;
  }
`

interface PrintOptions {
  /** Document title shown in the print dialog (and used as the default PDF file name) */
  title: string
  /** React component to render as print content */
  content: ReactElement
  /** Optional callback once printing has finished and the print frame is removed */
  onClose?: () => void
}

/** Builds the complete, script-free HTML document that is printed. */
function buildPrintHtml(title: string, content: ReactElement): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${PRINT_STYLES}</style>
</head>
<body>
  ${renderToStaticMarkup(content)}
</body>
</html>
`
}

/**
 * Creates the off-screen print frame. Not `display: none`: a frame without a
 * layout box may print blank in some engines, so it is sized to zero instead.
 */
function createPrintFrame(title: string, html: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.title = title
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  Object.assign(frame.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0',
    visibility: 'hidden',
  })
  frame.srcdoc = html
  return frame
}

/** Lifetime of one print frame: idempotent teardown plus its fallback timer. */
interface PrintSession {
  readonly cleanup: () => void
  readonly scheduleFallbackCleanup: () => void
  /** Aborted by `cleanup`; binds the frame's own (same-realm) listeners to the session. */
  readonly signal: AbortSignal
}

function createPrintSession(frame: HTMLIFrameElement, onClose?: () => void): PrintSession {
  // Aborted once torn down; the abort also detaches the frame's `load` listener.
  const lifetime = new AbortController()
  const timers: { fallback?: ReturnType<typeof setTimeout> } = {}
  const cleanup = () => {
    if (lifetime.signal.aborted) return
    lifetime.abort()
    clearTimeout(timers.fallback)
    frame.remove()
    onClose?.()
  }
  const scheduleFallbackCleanup = () => {
    if (!lifetime.signal.aborted) timers.fallback = setTimeout(cleanup, CLEANUP_FALLBACK_MS)
  }
  return { cleanup, scheduleFallbackCleanup, signal: lifetime.signal }
}

/** Prints the loaded frame, then removes it on `afterprint` (or the fallback timeout). */
function printLoadedFrame(frame: HTMLIFrameElement, session: PrintSession): void {
  const frameWindow = frame.contentWindow
  if (!frameWindow) {
    session.cleanup()
    return
  }
  // No `signal` here: the frame window is another realm, and `cleanup` is
  // idempotent anyway; the listener dies with the removed frame.
  frameWindow.addEventListener('afterprint', session.cleanup, { once: true })
  try {
    frameWindow.print()
  } catch {
    session.cleanup()
    return
  }
  session.scheduleFallbackCleanup()
}

/**
 * Renders print-optimized content into a hidden iframe and opens the browser's
 * print dialog for it. Users can save as PDF or print directly from the native
 * dialog. The frame removes itself after printing.
 *
 * @param options - Print configuration options
 * @returns The print frame's window, or null if no browsing context could be created
 */
export function openPrintWindow(options: PrintOptions): Window | null {
  const {
    title, content, onClose,
  } = options

  const frame = createPrintFrame(title, buildPrintHtml(title, content))
  const session = createPrintSession(frame, onClose)
  // `once`: an srcdoc frame fires exactly one load (for about:srcdoc) per the
  // HTML spec, but never print twice if an engine also reports about:blank.
  frame.addEventListener('load', () => printLoadedFrame(frame, session), { once: true, signal: session.signal })
  document.body.appendChild(frame)

  const frameWindow = frame.contentWindow
  if (!frameWindow) {
    session.cleanup()
    return null
  }
  return frameWindow
}

/**
 * Creates a PDF generator function that prints the given content.
 * Eliminates boilerplate across per-page PDF generators.
 *
 * @example
 * ```ts
 * export const generateFeedbackPDF = createPdfGenerator<FeedbackPDFProps>(
 *   'Feedback Report',
 *   (props) => <FeedbackPDFContent {...props} />,
 * )
 * ```
 */
export function createPdfGenerator<T>(
  title: string | ((props: T) => string),
  render: (props: T) => ReactElement,
): (props: T) => void {
  return (props: T) => {
    const resolvedTitle = typeof title === 'function' ? title(props) : title
    const printWindow = openPrintWindow({
      title: resolvedTitle,
      content: render(props),
    })
    if (!printWindow) {
      throw new TypeError('Failed to prepare the print document.')
    }
  }
}

/**
 * Escapes HTML special characters to prevent XSS.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
