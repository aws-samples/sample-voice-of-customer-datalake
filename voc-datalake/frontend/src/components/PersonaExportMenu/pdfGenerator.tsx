/**
 * @fileoverview PDF generation for persona export.
 * @module components/PersonaExportMenu/pdfGenerator
 */

import { createPdfGenerator } from '../../utils/printUtils'
import PersonaPDFContent from './PersonaPDFContent'
import type { ProjectPersona } from '../../api/types'

export const generatePersonaPDF = createPdfGenerator<ProjectPersona>(
  (persona) => persona.name,
  (persona) => <PersonaPDFContent persona={persona} />,
)
