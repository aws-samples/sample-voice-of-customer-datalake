/**
 * @fileoverview PDF generation for categories analysis export.
 * Uses browser print dialog following the same pattern as persona PDF export.
 * @module pages/Categories/categoriesPdfGenerator
 */

import { openPrintWindow } from '../../utils/printUtils'
import CategoriesPDFContent from './CategoriesPDFContent'
import type { CategoriesPDFProps } from './CategoriesPDFContent'

/**
 * Opens a print-friendly view of the categories analysis report.
 * Users can save as PDF or print directly from the browser's native dialog.
 */
export function generateCategoriesPDF(props: CategoriesPDFProps): void {
  const printWindow = openPrintWindow({
    title: 'Categories Analysis Report',
    content: <CategoriesPDFContent {...props} />,
  })

  if (!printWindow) {
    throw new TypeError('Failed to open print window. Please allow popups for this site.')
  }
}
