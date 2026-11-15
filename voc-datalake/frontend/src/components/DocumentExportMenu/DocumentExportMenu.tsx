/**
 * @fileoverview Document export menu component.
 *
 * Export options for PRDs, PR/FAQs, and research documents:
 * - Copy as Markdown
 * - Copy as Kiro prompt (with project context)
 * - Print or save as PDF (the browser print dialog; its "Save as PDF" writes the file), with the option "Include open
 *   comments" for a commented document (PR/FAQ, PRD): the open threads placed in the printed text (or on the whole
 *   document), each with its quote, after the text
 *
 * The document page's "File" menu is this menu with the page's own items around the exports (`leading`, `children`).
 *
 * @module components/DocumentExportMenu
 */

import { Check, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  downloadFile, sanitizeFilename,
} from '../../utils/file'
import { openPrintWindow } from '../../utils/printUtils'
import ExportMenuShell from '../ExportMenuShell/ExportMenuShell'
import { useCopiedFlag } from '../../hooks/useCopiedFlag'
import DocumentPDFContent from './DocumentPDFContent'
import { documentText } from './documentText'
import { printedThreads } from './printedThreads'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { MenuSlot } from '../ExportMenuShell/ExportMenuShell'
import type { CommentThread } from '../../api/documentReviewSchema'
import type {
  ProjectDocument,
} from '../../api/types'
import type {
  Project,
} from '../../api/projectTypes'

interface DocumentExportMenuProps {
  document: ProjectDocument | null
  project?: Project | null
  /** The document's comment threads (a PR/FAQ or PRD, once loaded): offers "Include open comments" for the PDF. */
  threads?: readonly CommentThread[] | null
  /** A labelled trigger with this text instead of the "Download options" kebab. */
  triggerLabel?: string
  /** Items before the exports, and after them (ExportMenuShell's slots). */
  leading?: (menu: MenuSlot) => ReactNode
  children?: (menu: MenuSlot) => ReactNode
  exportDescribedBy?: string
}

/** "Include open comments": a checkbox item of the menu; it keeps the menu open. */
function IncludeCommentsItem({ checked, onToggle }: Readonly<{ checked: boolean; onToggle: () => void }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={onToggle}
      className="menu-item py-2.5 sm:py-1.5 pl-9 active:bg-bg-hover">
      <span aria-hidden="true" className="inline-flex size-4 flex-shrink-0 items-center justify-center rounded-sm border border-border">
        {checked ? <Check size={12} /> : null}
      </span>
      <span className="truncate">{t('canvas.menu.includeComments')}</span>
    </button>
  )
}

// Helper to find all markdown link positions
function findMarkdownLinks(text: string): Array<{
  start: number;
  end: number;
  textStart: number;
  textEnd: number
}> {
  const links: Array<{
    start: number;
    end: number;
    textStart: number;
    textEnd: number
  }> = []
  const openBrackets = Array.from(text.matchAll(/\[/g))

  for (const match of openBrackets) {
    const start = match.index
    const closeBracket = text.indexOf(']', start)
    if (closeBracket === -1) continue
    if (text[closeBracket + 1] !== '(') continue

    const closeParen = text.indexOf(')', closeBracket)
    if (closeParen === -1) continue

    links.push({
      start,
      end: closeParen + 1,
      textStart: start + 1,
      textEnd: closeBracket,
    })
  }
  return links
}

// Helper to strip markdown links without vulnerable regex
function stripMarkdownLinks(text: string): string {
  const links = findMarkdownLinks(text)
  if (links.length === 0) return text

  const initialState: {
    parts: string[];
    lastEnd: number
  } = {
    parts: [],
    lastEnd: 0,
  }

  const {
    parts, lastEnd,
  } = links.reduce(
    (acc, link) => {
      // Skip overlapping
      if (link.start < acc.lastEnd) return acc
      return {
        parts: [
          ...acc.parts,
          text.slice(acc.lastEnd, link.start),
          text.slice(link.textStart, link.textEnd),
        ],
        lastEnd: link.end,
      }
    },
    initialState,
  )

  return [...parts, text.slice(lastEnd)].join('')
}

/**
 * Heading for the document section of the "Copy to Kiro" clipboard payload.
 *
 * Deliberately plain English regardless of locale: the payload is instructions
 * for a coding agent, and its structural markdown is English by design rather
 * than by omission.
 *
 * Keyed rather than a `prfaq ? … : 'PRD Document'` ternary so that widening
 * KiroSection's document_type gate below cannot silently label another document
 * type as a PRD. The 'Document' fallback is unreachable while that gate admits
 * only these two types.
 */
const KIRO_SECTION_HEADINGS: Partial<Record<ProjectDocument['document_type'], string>> = {
  prd: 'PRD Document',
  prfaq: 'PR/FAQ Document',
}

function KiroSection({
  doc, copiedKiro, onCopyToKiro, t,
}: Readonly<{
  doc: ProjectDocument
  copiedKiro: boolean
  onCopyToKiro: () => void
  /** The menu's `components` t: typed so the i18n audit charges its keys to `components`, not this file's first hook. */
  t: TFunction<'components'>
}>) {
  if (doc.document_type !== 'prd' && doc.document_type !== 'prfaq') return null
  return (
    <>
      <hr className="menu-separator border-0" />
      <button
        onClick={onCopyToKiro}
        className="menu-item py-2.5 sm:py-1.5 text-aim hover:bg-aim-subtle focus-visible:bg-aim-subtle active:bg-aim-subtle"
        role="menuitem"
      >
        {copiedKiro ? <Check size={16} className="text-ok flex-shrink-0" /> : <Sparkles size={16} className="flex-shrink-0" />}
        <span className="truncate">{copiedKiro ? t('documentExport.copied') : t('documentExport.copyToKiro')}</span>
      </button>
    </>
  )
}

export default function DocumentExportMenu({
  document: doc, project, threads = null, triggerLabel, leading, children, exportDescribedBy,
}: Readonly<DocumentExportMenuProps>) {
  const [copiedKiro, flashCopiedKiro] = useCopiedFlag()
  const [includeComments, setIncludeComments] = useState(false)
  const { t } = useTranslation('components')
  const { t: tPage } = useTranslation('projectDetail')

  // Prototype artifacts own their open/download controls in PrototypeView. Raw
  // prototype content is never a prose or Kiro export, including legacy inline
  // HTML/JSON prototypes that do not have a prototype_url.
  if (!doc || doc.document_type === 'prototype') return null

  const copyContent = () => navigator.clipboard.writeText(documentText(doc))

  const copyToKiro = async (close: () => void) => {
    // The server's one Kiro prompt. A project's stored per-project prompt
    // (pre-3.00.00, no longer editable) is not read.
    const effectivePrompt = project?.kiro_default_export_prompt ?? ''
    const sectionHeading = KIRO_SECTION_HEADINGS[doc.document_type] ?? 'Document'
    const prdSection = `# ${doc.title}\n\n${documentText(doc)}`
    const fullContent = effectivePrompt === ''
      ? prdSection
      : `${effectivePrompt}\n\n---\n\n## ${sectionHeading}\n\n${prdSection}`

    await navigator.clipboard.writeText(fullContent)
    flashCopiedKiro()
    close()
  }

  const downloadAsMarkdown = () => {
    downloadFile(documentText(doc), `${sanitizeFilename(doc.title)}.md`, 'text/markdown')
  }

  const downloadAsTxt = () => {
    const plainText = stripMarkdownLinks(documentText(doc))
      .replaceAll(/#{1,6}\s/g, '')
      .replaceAll(/\*\*(.+?)\*\*/g, '$1')
      .replaceAll(/\*(.+?)\*/g, '$1')
      .replaceAll(/`(.+?)`/g, '$1')
      .replaceAll('```', '')
      .replaceAll(/^[-*+]\s/gm, '• ')
      .replaceAll(/^\d+\.\s+/gm, '')

    downloadFile(plainText, `${sanitizeFilename(doc.title)}.txt`, 'text/plain')
  }

  // A throw is logged and swallowed by the shell.
  const downloadAsPDF = () => {
    // The open threads on this (saved) version's text with their quotes, when asked for (resolved ones are
    // settled: not part of the read-out).
    const pdfComments = threads !== null && includeComments
      ? {
          heading: tPage('canvas.menu.commentsHeading'),
          wholeDocument: tPage('canvas.menu.wholeDocument'),
          threads: printedThreads(doc, threads.filter((thread) => thread.status === 'open')),
        }
      : null
    const printWindow = openPrintWindow({
      title: doc.title,
      content: <DocumentPDFContent document={doc} comments={pdfComments} />,
    })
    if (!printWindow && import.meta.env.DEV) {
      console.error('Failed to prepare the print document.')
    }
  }

  return (
    <ExportMenuShell
      labels={{
        trigger: triggerLabel ?? t('documentExport.downloadOptions'),
        copy: t('documentExport.copy'),
        copied: t('documentExport.copied'),
        downloadMarkdown: t('documentExport.downloadMarkdown'),
        downloadPDF: t('documentExport.downloadPDF'),
        downloadTXT: t('documentExport.downloadTXT'),
      }}
      labelled={triggerLabel !== undefined}
      onCopy={copyContent}
      onDownloadMarkdown={downloadAsMarkdown}
      onDownloadPDF={downloadAsPDF}
      onDownloadTXT={downloadAsTxt}
      leading={leading}
      exportDescribedBy={exportDescribedBy}
      afterPdf={threads === null ? null : (
        <IncludeCommentsItem checked={includeComments} onToggle={() => setIncludeComments((on) => !on)} />
      )}
    >
      {(menu) => (
        <>
          <KiroSection doc={doc} copiedKiro={copiedKiro} onCopyToKiro={() => void copyToKiro(menu.close)} t={t} />
          {children?.(menu)}
        </>
      )}
    </ExportMenuShell>
  )
}
