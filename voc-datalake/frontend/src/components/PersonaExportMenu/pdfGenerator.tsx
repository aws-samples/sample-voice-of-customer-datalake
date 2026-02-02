/**
 * @fileoverview PDF generation utilities for persona export.
 * Uses browser print dialog for PDF generation.
 * @module components/PersonaExportMenu/pdfGenerator
 */

import type { ProjectPersona } from '../../api/client'
import { openPrintWindow } from '../../utils/printUtils'
import PersonaPDFContent from './PersonaPDFContent'

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
    throw new Error('Failed to open print window. Please allow popups for this site.')
  }
}
