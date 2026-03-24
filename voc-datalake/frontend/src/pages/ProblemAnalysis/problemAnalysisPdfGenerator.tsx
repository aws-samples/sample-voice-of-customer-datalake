/**
 * @fileoverview PDF generation for problem analysis export.
 * Uses browser print dialog following the same pattern as persona PDF export.
 * @module pages/ProblemAnalysis/problemAnalysisPdfGenerator
 */

import { openPrintWindow } from '../../utils/printUtils'
import ProblemAnalysisPDFContent from './ProblemAnalysisPDFContent'
import type { ProblemAnalysisPDFProps } from './ProblemAnalysisPDFContent'

/**
 * Opens a print-friendly view of the problem analysis report.
 * Users can save as PDF or print directly from the browser's native dialog.
 */
export function generateProblemAnalysisPDF(props: ProblemAnalysisPDFProps): void {
  const printWindow = openPrintWindow({
    title: 'Problem Analysis Report',
    content: <ProblemAnalysisPDFContent {...props} />,
  })

  if (!printWindow) {
    throw new Error('Failed to open print window. Please allow popups for this site.')
  }
}
