/**
 * @fileoverview PDF generation for dashboard export.
 * Uses browser print dialog following the same pattern as persona PDF export.
 * @module pages/Dashboard/dashboardPdfGenerator
 */

import { openPrintWindow } from '../../utils/printUtils'
import DashboardPDFContent from './DashboardPDFContent'
import type { DashboardPDFProps } from './DashboardPDFContent'

/**
 * Opens a print-friendly view of the dashboard report.
 * Users can save as PDF or print directly from the browser's native dialog.
 */
export function generateDashboardPDF(props: DashboardPDFProps): void {
  const printWindow = openPrintWindow({
    title: 'Dashboard Report',
    content: <DashboardPDFContent {...props} />,
  })

  if (!printWindow) {
    throw new Error('Failed to open print window. Please allow popups for this site.')
  }
}
