/**
 * @fileoverview PDF generation for feedback list export.
 * Uses browser print dialog following the same pattern as persona PDF export.
 * @module pages/Feedback/feedbackPdfGenerator
 */

import { openPrintWindow } from '../../utils/printUtils'
import FeedbackPDFContent from './FeedbackPDFContent'
import type { FeedbackPDFProps } from './FeedbackPDFContent'

/**
 * Opens a print-friendly view of the feedback list.
 * Users can save as PDF or print directly from the browser's native dialog.
 */
export function generateFeedbackPDF(props: FeedbackPDFProps): void {
  const printWindow = openPrintWindow({
    title: 'Feedback Report',
    content: <FeedbackPDFContent {...props} />,
  })

  if (!printWindow) {
    throw new TypeError('Failed to open print window. Please allow popups for this site.')
  }
}
