/**
 * @fileoverview PDF generation for dashboard export.
 * @module pages/Dashboard/dashboardPdfGenerator
 */

import { createPdfGenerator } from '../../utils/printUtils'
import DashboardPDFContent from './DashboardPDFContent'
import type { DashboardPDFProps } from './DashboardPDFContent'

export const generateDashboardPDF = createPdfGenerator<DashboardPDFProps>(
  'Dashboard Report',
  (props) => <DashboardPDFContent {...props} />,
)
