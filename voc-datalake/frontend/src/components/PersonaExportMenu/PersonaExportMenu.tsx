/**
 * @fileoverview Persona export menu component.
 *
 * Export options for customer personas:
 * - Copy as Markdown
 * - Download as PDF with formatted sections
 *
 * @module components/PersonaExportMenu
 */

import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, FileDown, MoreVertical, FileText, FileType } from 'lucide-react'
import type { ProjectPersona } from '../../api/client'
import { personaToMarkdown } from './personaToMarkdown'
import { generatePersonaPDF } from './pdfGenerator'

interface PersonaExportMenuProps {
  readonly persona: ProjectPersona | null
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '_')
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^>\s/gm, '')
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = window.document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function PersonaExportMenu({ persona }: PersonaExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
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

  if (!persona) return null

  const copyContent = async () => {
    await navigator.clipboard.writeText(personaToMarkdown(persona))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const downloadAsMarkdown = () => {
    downloadFile(personaToMarkdown(persona), `${sanitizeFilename(persona.name)}_persona.md`, 'text/markdown')
    setIsOpen(false)
  }

  const downloadAsTxt = () => {
    const content = markdownToPlainText(personaToMarkdown(persona))
    downloadFile(content, `${sanitizeFilename(persona.name)}_persona.txt`, 'text/plain')
    setIsOpen(false)
  }

  const downloadAsPDF = () => {
    try {
      generatePersonaPDF(persona)
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
        title={t('personaExport.exportPersona')}
        aria-label={t('personaExport.exportPersona')}
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
            <span className="truncate">{copied ? t('personaExport.copied') : t('personaExport.copyMarkdown')}</span>
          </button>

          <hr className="my-1 border-gray-100" />

          <button
            onClick={downloadAsMarkdown}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <FileText size={16} className="flex-shrink-0" />
            <span className="truncate">{t('personaExport.downloadMarkdown')}</span>
          </button>

          <button
            onClick={downloadAsPDF}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <FileDown size={16} className="flex-shrink-0" />
            <span className="truncate">{t('personaExport.downloadPDF')}</span>
          </button>

          <button
            onClick={downloadAsTxt}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <FileType size={16} className="flex-shrink-0" />
            <span className="truncate">{t('personaExport.downloadTXT')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
