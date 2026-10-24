/**
 * @fileoverview The Problem Analysis tree in the PDF export's shape. The tree itself
 * is built on the server (`GET /feedback/problems`, shared/problem_aggregation.py).
 * @module pages/ProblemAnalysis/problemGrouping
 */
import { PDF_REPORT_LOCALE } from '../../components/PdfParts/pdfParts'
import { formatCount } from '../../utils/numberFormat'
import type { DisplayLabels } from '../../hooks/useDisplayLabels'
import type { CategoryGroup } from '../../api/problemsApi'

// Map the problem tree to the PDF export shape (the problem level names its count itemCount).
// The PDF renders outside React's providers, so the names arrive labelled.
export function toPDFCategories(groups: CategoryGroup[], labels: Pick<DisplayLabels, 'category' | 'subcategory'>) {
  return groups.map((c) => ({
    category: labels.category(c.category),
    totalItems: c.totalItems,
    urgentCount: c.urgentCount,
    subcategories: c.subcategories.map((s) => ({
      subcategory: labels.subcategory(s.subcategory, c.category),
      totalItems: s.totalItems,
      // Every problem of the subcategory, not only the listed ones (the server lists the largest).
      problemCount: s.problemCount,
      urgentCount: s.urgentCount,
      problems: s.problems.map((p) => ({
        problem: p.problem,
        similarCount: p.similarCount,
        rootCause: p.rootCause,
        itemCount: p.count,
        avgSentiment: p.avgSentiment,
        urgentCount: p.urgentCount,
        // With "Show resolved" on, resolved groups reach the export — the
        // PDF must annotate them, since strike-through/badge is UI-only.
        resolved: p.resolved === true,
      })),
    })),
  }))
}


/** "12 problems", or "12 problems (largest 3 listed)" when the server listed only the largest (PDF text, English, so its numbers are too). */
export function problemsLine(subcategory: { readonly problemCount: number; readonly problems: readonly unknown[] }): string {
  const listed = subcategory.problems.length
  const total = Math.max(subcategory.problemCount, listed)
  const count = (n: number) => formatCount(n, PDF_REPORT_LOCALE)
  return listed < total ? `${count(total)} problems (largest ${count(listed)} listed)` : `${count(total)} problems`
}
