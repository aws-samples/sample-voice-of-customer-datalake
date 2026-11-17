/**
 * @fileoverview The page variant's frame: the pane (a card on the page, or the whole window in focus view), its live
 * note, the header kept in reach while the text scrolls (the bar: menus, save status, toolbar), and the sheet the
 * text sits on (centred and capped at the reading width, or the full width). An older version, when one shows,
 * takes the sheet while the page's own version stays mounted out of sight (its draft, its comments).
 *
 * @module components/Document/surface/PageFrame
 */
import clsx from 'clsx'
import { PAGE_SHEET_CLASS, PAGE_SHEET_WIDE_CLASS } from '../pageStyles'
import type { ReactNode, RefObject } from 'react'

export interface PageFrameProps {
  /** The focus view: the page is the window. */
  readonly focusActive: boolean
  readonly fullWidth: boolean
  /** Unsaved changes: room under the text for a phone's pinned Save bar. */
  readonly dirty: boolean
  /** The polite live note (full screen, an older version on screen). */
  readonly note: string
  readonly headerRef: RefObject<HTMLElement | null>
  readonly bar: ReactNode
  /** An older version on screen (null: the page's own). */
  readonly aside: ReactNode
  readonly documentId: string
  readonly children: ReactNode
}

/** The pane: a card on the page, or (focus view) the window; unsaved, room under the text for a phone's Save bar. */
function paneClass(focusActive: boolean, dirty: boolean): string {
  return clsx('bg-card min-w-0', focusActive ? 'min-h-screen' : 'rounded-xl border lg:min-h-[500px]', dirty && 'max-sm:pb-20')
}

/** The sheet the text sits on: centred and capped, or the full width (the reading column uncapped too). */
function sheetClass(fullWidth: boolean): string {
  return clsx(fullWidth ? PAGE_SHEET_WIDE_CLASS : PAGE_SHEET_CLASS, fullWidth && '[&_[data-reading-column]]:max-w-none')
}

export default function PageFrame({
  focusActive, fullWidth, dirty, note, headerRef, bar, aside, documentId, children,
}: PageFrameProps) {
  return (
    <div data-testid="document-detail-pane" data-focus-view={focusActive ? '' : undefined} data-document={documentId}
      className={paneClass(focusActive, dirty)}>
      <p aria-live="polite" className="sr-only" data-testid="canvas-focus-note">{note}</p>
      {/* The bar: one row (wrapping on a phone), kept in reach while the text scrolls (from lg). The focus view
          brings it to the top of the window and keeps it there at every width: its way out is in it. */}
      <header ref={headerRef} className={clsx('border-b border-border bg-card px-3 py-1.5 sm:px-4',
        focusActive ? 'sticky top-0 z-20' : 'rounded-t-xl lg:sticky lg:top-0 lg:z-20')}>
        {bar}
      </header>
      <div className={sheetClass(fullWidth)}>
        {aside}
        {/* The page's own version: out of sight while an older one shows, never unmounted. */}
        <div hidden={aside !== null}>{children}</div>
      </div>
    </div>
  )
}
