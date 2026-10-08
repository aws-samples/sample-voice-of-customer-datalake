/**
 * @fileoverview Persona export menu component.
 *
 * Export options for customer personas:
 * - Copy as Markdown
 * - Download as PDF with formatted sections
 *
 * @module components/PersonaExportMenu
 */

import { useTranslation } from 'react-i18next'
import {
  downloadFile, sanitizeFilename,
} from '../../utils/file'
import ExportMenuShell from '../ExportMenuShell/ExportMenuShell'
import { generatePersonaPDF } from './pdfGenerator'
import { personaToMarkdown } from './personaToMarkdown'
import type { ProjectPersona } from '../../api/projectTypes'

interface PersonaExportMenuProps { readonly persona: ProjectPersona | null }

function markdownToPlainText(markdown: string): string {
  return markdown
    .replaceAll(/#{1,6}\s/g, '')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/\*([^*]+)\*/g, '$1')
    .replaceAll(/^>\s/gm, '')
}

export default function PersonaExportMenu({ persona }: PersonaExportMenuProps) {
  const { t } = useTranslation('components')

  if (!persona) return null

  const copyContent = () => navigator.clipboard.writeText(personaToMarkdown(persona))

  const downloadAsMarkdown = () => {
    downloadFile(personaToMarkdown(persona), `${sanitizeFilename(persona.name)}_persona.md`, 'text/markdown')
  }

  const downloadAsTxt = () => {
    const content = markdownToPlainText(personaToMarkdown(persona))
    downloadFile(content, `${sanitizeFilename(persona.name)}_persona.txt`, 'text/plain')
  }

  // Failures are logged and swallowed by the shell.
  const downloadAsPDF = () => generatePersonaPDF(persona)

  return (
    <ExportMenuShell
      labels={{
        trigger: t('personaExport.exportPersona'),
        copy: t('personaExport.copyMarkdown'),
        copied: t('personaExport.copied'),
        downloadMarkdown: t('personaExport.downloadMarkdown'),
        downloadPDF: t('personaExport.downloadPDF'),
        downloadTXT: t('personaExport.downloadTXT'),
      }}
      onCopy={copyContent}
      onDownloadMarkdown={downloadAsMarkdown}
      onDownloadPDF={downloadAsPDF}
      onDownloadTXT={downloadAsTxt}
    />
  )
}
