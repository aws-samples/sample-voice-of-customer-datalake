/**
 * @fileoverview The export menu shared by the document and persona export menus.
 *
 * Owns what both menus used to copy from each other: the trigger button with its ARIA menu attributes, the WAI-ARIA
 * menu button behaviour (components/ProfileMenu/useMenuButton: focus moves into the menu, arrow keys / Home / End move
 * between items, Escape closes it and returns focus to the trigger, Tab or a press outside closes it), the "Copied!"
 * flash on the copy item, and the three download items (Markdown, PDF, TXT) that close the menu after they run.
 *
 * Menu-specific items come in through slots, each given `close` (which returns focus to the trigger): `leading` before
 * the copy item (the document page's Save and Share), `afterPdf` right under the PDF item (its options), `children`
 * after the downloads (the document menu's "Copy to Kiro", History and Delete). The trigger is a kebab icon, or a
 * labelled button (`labelled`: the document page's "File").
 *
 * @module components/ExportMenuShell
 */

import {
  Copy, Check, FileDown, MoreHorizontal, MoreVertical, FileText, FileType,
} from 'lucide-react'
import { useId } from 'react'
import type { ReactNode } from 'react'
import { useCopiedFlag } from '../../hooks/useCopiedFlag'
import { useMenuButton } from '../ProfileMenu/useMenuButton'
import { MENUBAR_POPUP_CLASS, MENUBAR_TRIGGER_CLASS } from '../DocumentCanvas/actions/menuBar'

/** The user-facing labels of the shell's own items, already translated by the caller. */
interface ExportMenuLabels {
  /** The trigger's name: its `aria-label`/`title` (kebab), or its visible text (`labelled`). */
  readonly trigger: string
  readonly copy: string
  readonly copied: string
  readonly downloadMarkdown: string
  readonly downloadPDF: string
  readonly downloadTXT: string
}

/** What a slot gets: `close` shuts the menu and puts focus back on the trigger. */
export interface MenuSlot {
  readonly close: () => void
}

export interface ExportMenuShellProps {
  readonly labels: ExportMenuLabels
  /** Writes to the clipboard; the item shows `labels.copied` for two seconds once it resolves. */
  readonly onCopy: () => Promise<void>
  readonly onDownloadMarkdown: () => void
  /** May throw (a blocked popup, a renderer failure): the shell logs it in dev and swallows it. */
  readonly onDownloadPDF: () => void
  readonly onDownloadTXT: () => void
  /** Items before the copy item. */
  readonly leading?: (menu: MenuSlot) => ReactNode
  /** Items right after the PDF item (its options). */
  readonly afterPdf?: ReactNode
  /** Extra items rendered after the downloads. */
  readonly children?: (menu: MenuSlot) => ReactNode
  /** The id of a text describing the export items (e.g. "Export uses the saved version"). */
  readonly exportDescribedBy?: string
  /** A labelled button instead of the kebab icon. */
  readonly labelled?: boolean
  /**
   * A menu of the document page's menu bar ("Document"; DocumentCanvas/actions/menuBar): its quiet labelled button
   * (`data-menubar-trigger`, so the bar's arrow keys reach it) and the menu under its start. Implies `labelled`.
   */
  readonly menuBar?: boolean
}

const MENU_ITEM_CLASS = 'menu-item py-2.5 sm:py-1.5 active:bg-bg-hover'

function triggerClass(labelled: boolean, menuBar: boolean): string {
  if (menuBar) return MENUBAR_TRIGGER_CLASS
  return labelled ? 'btn btn-secondary btn-sm' : 'icon-btn p-2 rounded-lg'
}

/** The trigger's look and name: a kebab is named by its label (`aria-label`, `title`), a labelled one by its text. */
function triggerAttributes(label: string, labelled: boolean, menuBar: boolean) {
  const named = labelled || menuBar
  return {
    className: triggerClass(labelled, menuBar),
    'data-menubar-trigger': menuBar ? '' : undefined,
    title: named ? undefined : label,
    'aria-label': named ? undefined : label,
  }
}

/** The trigger's face: the bar's plain label, a labelled button, or the kebab. */
function TriggerContent({ label, labelled, menuBar }: Readonly<{ label: string; labelled: boolean; menuBar: boolean }>) {
  if (menuBar) return <>{label}</>
  if (labelled) return <><MoreHorizontal size={14} aria-hidden="true" />{label}</>
  return <MoreVertical size={18} aria-hidden="true" />
}

export default function ExportMenuShell({
  labels, onCopy, onDownloadMarkdown, onDownloadPDF, onDownloadTXT, leading, afterPdf, children, exportDescribedBy,
  labelled = false, menuBar = false,
}: ExportMenuShellProps) {
  const { open: isOpen, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown } = useMenuButton()
  const panelId = useId()
  const triggerId = useId()
  const [copied, flashCopied] = useCopiedFlag()
  const slot: MenuSlot = { close: () => close(true) }

  const copy = async () => {
    await onCopy()
    flashCopied()
  }

  /** Run a download and close the menu whether or not it threw. */
  const download = (run: () => void) => () => {
    try {
      run()
    } finally {
      close(true)
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
    <div className="relative">
      <button
        ref={buttonRef}
        id={triggerId}
        type="button"
        onClick={toggle}
        onKeyDown={onButtonKeyDown}
        {...triggerAttributes(labels.trigger, labelled, menuBar)}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-controls={isOpen ? panelId : undefined}
      >
        <TriggerContent label={labels.trigger} labelled={labelled} menuBar={menuBar} />
      </button>

      {isOpen ? <div
        ref={menuRef}
        id={panelId}
        className={menuBar ? MENUBAR_POPUP_CLASS : 'menu absolute right-0 top-full mt-1 z-20 w-60 max-w-[calc(100vw-2rem)]'}
        role="menu"
        aria-labelledby={triggerId}
        aria-orientation="vertical"
        onKeyDown={onMenuKeyDown}
      >
        {leading?.(slot)}

        <button type="button" onClick={() => void copy()} className={MENU_ITEM_CLASS} role="menuitem" aria-describedby={exportDescribedBy}>
          {copied ? <Check size={16} className="text-ok flex-shrink-0" aria-hidden="true" /> : <Copy size={16} className="flex-shrink-0" aria-hidden="true" />}
          <span className="truncate">{copied ? labels.copied : labels.copy}</span>
        </button>

        <hr className="menu-separator border-0" />

        <button type="button" onClick={download(onDownloadMarkdown)} className={MENU_ITEM_CLASS} role="menuitem" aria-describedby={exportDescribedBy}>
          <FileText size={16} className="flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{labels.downloadMarkdown}</span>
        </button>

        <button type="button" onClick={download(exportPdf)} className={MENU_ITEM_CLASS} role="menuitem" aria-describedby={exportDescribedBy}>
          <FileDown size={16} className="flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{labels.downloadPDF}</span>
        </button>

        {afterPdf}

        <button type="button" onClick={download(onDownloadTXT)} className={MENU_ITEM_CLASS} role="menuitem" aria-describedby={exportDescribedBy}>
          <FileType size={16} className="flex-shrink-0" aria-hidden="true" />
          <span className="truncate">{labels.downloadTXT}</span>
        </button>

        {children?.(slot)}
      </div> : null}
    </div>
  )
}
