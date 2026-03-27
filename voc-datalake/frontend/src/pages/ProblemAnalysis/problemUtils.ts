/**
 * Shared utilities for problem analysis — problem ID generation and resolved filtering.
 */

import type { CategoryGroup } from './problemGrouping'

/** Generate a deterministic problem ID from category + subcategory + problem text. */
export function generateProblemId(category: string, subcategory: string, problem: string): string {
  const input = `${category}:${subcategory}:${problem}`.toLowerCase().trim()
  const hash = Array.from(input).reduce((acc, char) => {
    const code = char.charCodeAt(0)
    return ((acc << 5) - acc + code) | 0
  }, 0)
  return Math.abs(hash).toString(36)
}

/** Filter out resolved problems from category groups when showResolved is false. */
export function filterResolvedProblems(
  groups: CategoryGroup[],
  resolvedIds: Set<string>,
  showResolved: boolean,
): CategoryGroup[] {
  if (showResolved || resolvedIds.size === 0) return groups

  return groups
    .map((cat) => {
      const subcategories = cat.subcategories
        .map((sub) => {
          const problems = sub.problems.filter((p) => {
            const id = generateProblemId(cat.category, sub.subcategory, p.problem)
            return !resolvedIds.has(id)
          })
          const totalItems = problems.reduce((sum, p) => sum + p.items.length, 0)
          const urgentCount = problems.reduce((sum, p) => sum + p.urgentCount, 0)
          return {
            ...sub,
            problems,
            totalItems,
            urgentCount,
          }
        })
        .filter((sub) => sub.problems.length > 0)

      const totalItems = subcategories.reduce((sum, s) => sum + s.totalItems, 0)
      const urgentCount = subcategories.reduce((sum, s) => sum + s.urgentCount, 0)
      return {
        ...cat,
        subcategories,
        totalItems,
        urgentCount,
      }
    })
    .filter((cat) => cat.subcategories.length > 0)
}
