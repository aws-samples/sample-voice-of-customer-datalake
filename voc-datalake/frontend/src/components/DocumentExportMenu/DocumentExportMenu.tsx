/**
 * @fileoverview Document export menu component.
 *
 * Export options for PRDs, PR/FAQs, and research documents:
 * - Copy as Markdown
 * - Copy as Kiro prompt (with project context)
 * - Download as PDF (via browser print)
 *
 * @module components/DocumentExportMenu
 */

import {
  Copy, Check, FileDown, MoreVertical, FileText, FileType, Sparkles,
} from 'lucide-react'
import {
  useState, useRef, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  downloadFile, sanitizeFilename,
} from '../../utils/file'
import { openPrintWindow } from '../../utils/printUtils'
import DocumentPDFContent from './DocumentPDFContent'
import type {
  ProjectDocument, Project,
} from '../../api/types'

interface DocumentExportMenuProps {
  document: ProjectDocument | null
  project?: Project | null
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

function KiroSection({
  doc, project, copiedKiro, onCopyToKiro, t,
}: Readonly<{
  doc: ProjectDocument
  project?: Project | null
  copiedKiro: boolean
  onCopyToKiro: () => void
  t: (key: string) => string
}>) {
  if (doc.document_type !== 'prd' && doc.document_type !== 'prfaq') return null
  return (
    <>
      <hr className="my-1 border-gray-100" />
      <button
        onClick={onCopyToKiro}
        className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-purple-700 hover:bg-purple-50 active:bg-purple-100"
        role="menuitem"
      >
        {copiedKiro ? <Check size={16} className="text-green-500 flex-shrink-0" /> : <Sparkles size={16} className="flex-shrink-0" />}
        <span className="truncate">{copiedKiro ? t('documentExport.copied') : t('documentExport.copyToKiro')}</span>
      </button>
      {(project?.kiro_export_prompt == null || project.kiro_export_prompt === '') && (
        <p className="px-3 py-1 text-xs text-gray-400">
          {t('documentExport.kiroPromptTip')}
        </p>
      )}
    </>
  )
}

export default function DocumentExportMenu({
  document: doc, project,
}: Readonly<DocumentExportMenuProps>) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedKiro, setCopiedKiro] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation('components')

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

  if (!doc) return null

  const copyContent = async () => {
    await navigator.clipboard.writeText(doc.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const copyToKiro = async () => {
    const kiroPrompt = project?.kiro_export_prompt != null && project.kiro_export_prompt !== '' ? project.kiro_export_prompt : ''
    const prdSection = `# ${doc.title}\n\n${doc.content}`
    const fullContent = kiroPrompt === ''
      ? prdSection
      : `${kiroPrompt}\n\n---\n\n## PRD Document\n\n${prdSection}`

    await navigator.clipboard.writeText(fullContent)
    setCopiedKiro(true)
    setTimeout(() => setCopiedKiro(false), 2000)
    setIsOpen(false)
  }

  const downloadAsMarkdown = () => {
    downloadFile(doc.content, `${sanitizeFilename(doc.title)}.md`, 'text/markdown')
    setIsOpen(false)
  }

  const downloadAsTxt = () => {
    const plainText = stripMarkdownLinks(doc.content)
      .replaceAll(/#{1,6}\s/g, '')
      .replaceAll(/\*\*(.+?)\*\*/g, '$1')
      .replaceAll(/\*(.+?)\*/g, '$1')
      .replaceAll(/`(.+?)`/g, '$1')
      .replaceAll('```', '')
      .replaceAll(/^[-*+]\s/gm, '• ')
      .replaceAll(/^\d+\.\s+/gm, '')

    downloadFile(plainText, `${sanitizeFilename(doc.title)}.txt`, 'text/plain')
    setIsOpen(false)
  }

  const downloadAsPDF = () => {
    try {
      const printWindow = openPrintWindow({
        title: doc.title,
        content: <DocumentPDFContent document={doc} />,
      })

      if (!printWindow && import.meta.env.DEV) {
        console.error('Failed to open print window. Popups may be blocked.')
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('PDF export failed:', error)
      }
    } finally {
      setIsOpen(false)
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        title={t('documentExport.downloadOptions')}
        aria-label={t('documentExport.downloadOptions')}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <MoreVertical size={18} />
      </button>

      {isOpen ? <div
        className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-52 max-w-[calc(100vw-2rem)] py-1"
        role="menu"
        aria-orientation="vertical"
      >
        <button
          onClick={() => void copyContent()}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          {copied ? <Check size={16} className="text-green-500 flex-shrink-0" /> : <Copy size={16} className="flex-shrink-0" />}
          <span className="truncate">{copied ? t('documentExport.copied') : t('documentExport.copy')}</span>
        </button>

        <hr className="my-1 border-gray-100" />

        <button
          onClick={downloadAsMarkdown}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          <FileText size={16} className="flex-shrink-0" />
          <span className="truncate">{t('documentExport.downloadMarkdown')}</span>
        </button>

        <button
          onClick={downloadAsPDF}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          <FileDown size={16} className="flex-shrink-0" />
          <span className="truncate">{t('documentExport.downloadPDF')}</span>
        </button>

        <button
          onClick={downloadAsTxt}
          className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
          role="menuitem"
        >
          <FileType size={16} className="flex-shrink-0" />
          <span className="truncate">{t('documentExport.downloadTXT')}</span>
        </button>

        <KiroSection doc={doc} project={project} copiedKiro={copiedKiro} onCopyToKiro={() => void copyToKiro()} t={t} />
      </div> : null}
    </div>
  )
}
