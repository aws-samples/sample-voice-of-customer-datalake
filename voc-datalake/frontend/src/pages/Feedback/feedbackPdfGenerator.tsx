/**
 * @fileoverview PDF generation for feedback list export.
 * @module pages/Feedback/feedbackPdfGenerator
 */

import { createPdfGenerator } from '../../utils/printUtils'
import FeedbackPDFContent from './FeedbackPDFContent'
import type { FeedbackPDFProps } from './FeedbackPDFContent'

export const generateFeedbackPDF = createPdfGenerator<FeedbackPDFProps>(
  'Feedback Report',
  (props) => <FeedbackPDFContent {...props} />,
)
