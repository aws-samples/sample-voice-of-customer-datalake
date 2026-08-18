/**
 * @fileoverview PDF generation for problem analysis export.
 * @module pages/ProblemAnalysis/problemAnalysisPdfGenerator
 */

import { createPdfGenerator } from '../../utils/printUtils'
import ProblemAnalysisPDFContent from './ProblemAnalysisPDFContent'
import type { ProblemAnalysisPDFProps } from './ProblemAnalysisPDFContent'

export const generateProblemAnalysisPDF = createPdfGenerator<ProblemAnalysisPDFProps>(
  'Problem Analysis Report',
  (props) => <ProblemAnalysisPDFContent {...props} />,
)
