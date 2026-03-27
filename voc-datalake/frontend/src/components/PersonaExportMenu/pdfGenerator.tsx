/**
 * @fileoverview PDF generation utilities for persona export.
 * Uses browser print dialog for PDF generation.
 * @module components/PersonaExportMenu/pdfGenerator
 */

import { openPrintWindow } from '../../utils/printUtils'
import PersonaPDFContent from './PersonaPDFContent'
import type { ProjectPersona } from '../../api/types'

class PdfGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfGenerationError'
  }
}

/**
 * Opens a print-friendly view of the persona profile.
 * Users can save as PDF or print directly from the browser's native dialog.
 */
export function generatePersonaPDF(persona: ProjectPersona): void {
  const printWindow = openPrintWindow({
    title: persona.name,
    content: <PersonaPDFContent persona={persona} />,
  })

  if (!printWindow) {
    throw new PdfGenerationError('Failed to open print window. Please allow popups for this site.')
  }
}
