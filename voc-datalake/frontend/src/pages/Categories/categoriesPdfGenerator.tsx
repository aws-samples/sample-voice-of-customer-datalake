/**
 * @fileoverview PDF generation for categories analysis export.
 * @module pages/Categories/categoriesPdfGenerator
 */

import { createPdfGenerator } from '../../utils/printUtils'
import CategoriesPDFContent from './CategoriesPDFContent'
import type { CategoriesPDFProps } from './CategoriesPDFContent'

export const generateCategoriesPDF = createPdfGenerator<CategoriesPDFProps>(
  'Categories Analysis Report',
  (props) => <CategoriesPDFContent {...props} />,
)
