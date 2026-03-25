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

import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, FileDown, MoreVertical, FileText, FileType, Sparkles } from 'lucide-react'
import type { ProjectDocument, Project } from '../../api/client'
import { openPrintWindow } from '../../utils/printUtils'
import DocumentPDFContent from './DocumentPDFContent'

interface DocumentExportMenuProps {
  document: ProjectDocument | null
  project?: Project | null
}

// Helper to find all markdown link positions
function findMarkdownLinks(text: string): Array<{ start: number; end: number; textStart: number; textEnd: number }> {
  const links: Array<{ start: number; end: number; textStart: number; textEnd: number }> = []
  const openBrackets = Array.from(text.matchAll(/\[/g))
  
  for (const match of openBrackets) {
    const start = match.index ?? 0
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
  
  const initialState: { parts: string[]; lastEnd: number } = { parts: [], lastEnd: 0 }
  
  const { parts, lastEnd } = links.reduce(
    (acc, link) => {
      if (link.start < acc.lastEnd) return acc // skip overlapping
      return {
        parts: [
          ...acc.parts,
          text.slice(acc.lastEnd, link.start),
          text.slice(link.textStart, link.textEnd),
        ],
        lastEnd: link.end,
      }
    },
    initialState
  )
  
  return [...parts, text.slice(lastEnd)].join('')
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '_')
}

export default function DocumentExportMenu({ document: doc, project }: Readonly<DocumentExportMenuProps>) {
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
    const kiroPrompt = project?.kiro_export_prompt || ''
    const separator = kiroPrompt ? '\n\n---\n\n' : ''
    const prdSection = `# ${doc.title}\n\n${doc.content}`
    const fullContent = kiroPrompt 
      ? `${kiroPrompt}${separator}## PRD Document\n\n${prdSection}`
      : prdSection
    
    await navigator.clipboard.writeText(fullContent)
    setCopiedKiro(true)
    setTimeout(() => setCopiedKiro(false), 2000)
    setIsOpen(false)
  }

  const downloadAsMarkdown = () => {
    const blob = new Blob([doc.content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement('a')
    a.href = url
    a.download = `${sanitizeFilename(doc.title)}.md`
    a.click()
    URL.revokeObjectURL(url)
    setIsOpen(false)
  }

  const downloadAsTxt = () => {
    const plainText = stripMarkdownLinks(doc.content)
      .replace(/#{1,6}\s/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/```/g, '')
      .replace(/^[-*+]\s/gm, '• ')
      .replace(/^\d+\.\s+/gm, '')
    
    const blob = new Blob([plainText], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement('a')
    a.href = url
    a.download = `${sanitizeFilename(doc.title)}.txt`
    a.click()
    URL.revokeObjectURL(url)
    setIsOpen(false)
  }

  const downloadAsPDF = () => {
    try {
      const printWindow = openPrintWindow({
        title: doc.title,
        content: <DocumentPDFContent document={doc} />,
      })

      if (!printWindow) {
        if (import.meta.env.DEV) {
          console.error('Failed to open print window. Popups may be blocked.')
        }
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

      {isOpen && (
        <div 
          className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-52 max-w-[calc(100vw-2rem)] py-1"
          role="menu"
          aria-orientation="vertical"
        >
          <button
            onClick={copyContent}
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

          {(doc.document_type === 'prd' || doc.document_type === 'prfaq') && (
            <>
              <hr className="my-1 border-gray-100" />
              <button
                onClick={copyToKiro}
                className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-purple-700 hover:bg-purple-50 active:bg-purple-100"
                role="menuitem"
              >
                {copiedKiro ? <Check size={16} className="text-green-500 flex-shrink-0" /> : <Sparkles size={16} className="flex-shrink-0" />}
                <span className="truncate">{copiedKiro ? t('documentExport.copied') : t('documentExport.copyToKiro')}</span>
              </button>
              {!project?.kiro_export_prompt && (
                <p className="px-3 py-1 text-xs text-gray-400">
                  {t('documentExport.kiroPromptTip')}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
