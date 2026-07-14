/**
 * @fileoverview Resolution-key building for Problem Analysis (issue #66).
 *
 * Problems have no server-side identity — they are grouped client-side from
 * feedback items by category → subcategory → similar problem text. Resolved
 * status is persisted under a normalized composite key so it survives
 * reloads and is shared across users.
 * @module pages/ProblemAnalysis/problemResolution
 */
import type { FeedbackItem } from '../../api/client'

/** Map of resolution keys to their resolution metadata, as stored server-side. */
export type ResolvedProblemsMap = Record<string, { resolved_at: string }>

/**
 * Shared shape of the client-side problem tree (issue #66 review feedback:
 * previously duplicated across ProblemAnalysis/ProblemRow/SubcategoryRow —
 * a field added to one copy would silently type-check).
 */
export interface ProblemGroup {
  problem: string
  similarProblems: string[]
  rootCause: string | null
  items: FeedbackItem[]
  avgSentiment: number
  urgentCount: number
  resolved?: boolean
}

export interface SubcategoryGroup {
  subcategory: string
  problems: ProblemGroup[]
  totalItems: number
  urgentCount: number
}

export interface CategoryGroup {
  category: string
  subcategories: SubcategoryGroup[]
  totalItems: number
  urgentCount: number
}

/**
 * Build the stable key a problem group is resolved under.
 *
 * All three components are normalized (trim + lowercase + collapsed
 * whitespace): they are LLM-classified values, so casing/whitespace drift
 * ("Delivery" vs "delivery") must not orphan a resolution. `|` is the
 * component separator, and since categories are user-configurable it is
 * normalized out of the values themselves so a literal pipe in a category
 * name can't merge two different problems under one key.
 */
export function buildResolutionKey(category: string, subcategory: string, problem: string): string {
  const normalize = (value: string) =>
    value.replaceAll('|', ' ').trim().toLowerCase().replaceAll(/\s+/g, ' ')
  return `${normalize(category)}|${normalize(subcategory)}|${normalize(problem)}`
}


function annotateProblems(
  category: string,
  subcategory: string,
  problems: ProblemGroup[],
  resolvedMap: ResolvedProblemsMap,
): ProblemGroup[] {
  return problems.map((problemGroup) => ({
    ...problemGroup,
    resolved: buildResolutionKey(category, subcategory, problemGroup.problem) in resolvedMap,
  }))
}

function withoutResolved(subcategoryGroup: SubcategoryGroup): SubcategoryGroup {
  const problems = subcategoryGroup.problems.filter((problemGroup) => !problemGroup.resolved)
  return {
    ...subcategoryGroup,
    problems,
    totalItems: problems.reduce((sum, p) => sum + p.items.length, 0),
    urgentCount: problems.reduce((sum, p) => sum + p.urgentCount, 0),
  }
}

/**
 * Annotate every problem group with its shared resolved status and, unless
 * `showResolved`, drop resolved groups — recomputing subcategory/category
 * totals so headers reflect what is actually rendered.
 */
export function applyResolution(
  categories: CategoryGroup[],
  resolvedMap: ResolvedProblemsMap,
  showResolved: boolean,
): { visible: CategoryGroup[]; resolvedCount: number } {
  const annotated = categories.map((categoryGroup) => ({
    ...categoryGroup,
    subcategories: categoryGroup.subcategories.map((subcategoryGroup) => ({
      ...subcategoryGroup,
      problems: annotateProblems(
        categoryGroup.category, subcategoryGroup.subcategory,
        subcategoryGroup.problems, resolvedMap,
      ),
    })),
  }))

  const resolvedCount = annotated.reduce(
    (total, categoryGroup) => total + categoryGroup.subcategories.reduce(
      (subtotal, subcategoryGroup) =>
        subtotal + subcategoryGroup.problems.filter((p) => p.resolved).length,
      0,
    ),
    0,
  )

  if (showResolved) {
    return { visible: annotated, resolvedCount }
  }

  const visible = annotated
    .map((categoryGroup) => {
      const subcategories = categoryGroup.subcategories
        .map((subcategoryGroup) => withoutResolved(subcategoryGroup))
        .filter((subcategoryGroup) => subcategoryGroup.problems.length > 0)
      return {
        ...categoryGroup,
        subcategories,
        totalItems: subcategories.reduce((sum, s) => sum + s.totalItems, 0),
        urgentCount: subcategories.reduce((sum, s) => sum + s.urgentCount, 0),
      }
    })
    .filter((categoryGroup) => categoryGroup.subcategories.length > 0)
  return { visible, resolvedCount }
}
