/**
 * @fileoverview The kebab export menu shared by the document and persona
 * export menus.
 *
 * Owns what both menus used to copy from each other: the trigger button with
 * its ARIA menu attributes, open/close state with click-outside dismissal, the
 * "Copied!" flash on the copy item, and the three download items (Markdown,
 * PDF, TXT) that close the menu after they run. Menu-specific extras (the
 * document menu's "Copy to Kiro" section) are passed as `children`, which
 * receive `close` so they can dismiss the menu themselves.
 *
 * @module components/ExportMenuShell
 */

import {
  Copy, Check, FileDown, MoreVertical, FileText, FileType,
} from 'lucide-react'
import {
  useCallback, useEffect, useRef, useState, type ReactNode,
} from 'react'
import { useCopiedFlash } from './useCopiedFlash'

/** The user-facing labels of the shell's own items, already translated by the caller. */
interface ExportMenuLabels {
  /** `aria-label`/`title` of the kebab trigger. */
  readonly trigger: string
  readonly copy: string
  readonly copied: string
  readonly downloadMarkdown: string
  readonly downloadPDF: string
  readonly downloadTXT: string
}

export interface ExportMenuShellProps {
  readonly labels: ExportMenuLabels
  /** Writes to the clipboard; the item shows `labels.copied` for two seconds once it resolves. */
  readonly onCopy: () => Promise<void>
  readonly onDownloadMarkdown: () => void
  /** May throw (a blocked popup, a renderer failure): the shell logs it in dev and swallows it. */
  readonly onDownloadPDF: () => void
  readonly onDownloadTXT: () => void
  /** Extra items rendered after the downloads. */
  readonly children?: (menu: { readonly close: () => void }) => ReactNode
}

const MENU_ITEM_CLASS = 'menu-item py-2.5 sm:py-1.5 active:bg-bg-hover'

export default function ExportMenuShell({
  labels, onCopy, onDownloadMarkdown, onDownloadPDF, onDownloadTXT, children,
}: ExportMenuShellProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, flashCopied] = useCopiedFlash()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target
      if (menuRef.current && target instanceof Node && !menuRef.current.contains(target)) {
        setIsOpen(false)
      }
    }
    window.document.addEventListener('mousedown', handleClickOutside)
    return () => window.document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const close = useCallback(() => setIsOpen(false), [])

  const copy = async () => {
    await onCopy()
    flashCopied()
  }

  /** Run a download and close the menu whether or not it threw. */
  const download = (run: () => void) => () => {
    try {
      run()
    } finally {
      close()
    }
  }

  /** PDF export is best-effort: a failure must not escape the click handler. */
  const exportPdf = () => {
    try {
      onDownloadPDF()
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('PDF export failed:', error)
      }
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="icon-btn p-2 rounded-lg"
        title={labels.trigger}
        aria-label={labels.trigger}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <MoreVertical size={18} />
      </button>

      {isOpen ? <div
        className="menu absolute right-0 top-full mt-1 z-20 w-52 max-w-[calc(100vw-2rem)]"
        role="menu"
        aria-orientation="vertical"
      >
        <button onClick={() => void copy()} className={MENU_ITEM_CLASS} role="menuitem">
          {copied ? <Check size={16} className="text-ok flex-shrink-0" /> : <Copy size={16} className="flex-shrink-0" />}
          <span className="truncate">{copied ? labels.copied : labels.copy}</span>
        </button>

        <hr className="menu-separator border-0" />

        <button onClick={download(onDownloadMarkdown)} className={MENU_ITEM_CLASS} role="menuitem">
          <FileText size={16} className="flex-shrink-0" />
          <span className="truncate">{labels.downloadMarkdown}</span>
        </button>

        <button onClick={download(exportPdf)} className={MENU_ITEM_CLASS} role="menuitem">
          <FileDown size={16} className="flex-shrink-0" />
          <span className="truncate">{labels.downloadPDF}</span>
        </button>

        <button onClick={download(onDownloadTXT)} className={MENU_ITEM_CLASS} role="menuitem">
          <FileType size={16} className="flex-shrink-0" />
          <span className="truncate">{labels.downloadTXT}</span>
        </button>

        {children?.({ close })}
      </div> : null}
    </div>
  )
}
