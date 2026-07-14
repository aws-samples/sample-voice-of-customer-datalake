/**
 * @fileoverview Resolution-key building for Problem Analysis (issue #66).
 *
 * Problems have no server-side identity — they are grouped client-side from
 * feedback items by category → subcategory → similar problem text. Resolved
 * status is persisted under a normalized composite key so it survives
 * reloads and is shared across users.
 * @module pages/ProblemAnalysis/problemResolution
 */
import { z } from 'zod'
import type { FeedbackItem } from '../../api/client'

/** Map of resolution keys to their resolution metadata, as stored server-side. */
export type ResolvedProblemsMap = Record<string, { resolved_at: string }>

const resolvedProblemsResponseSchema = z.object({
  resolved: z.record(z.string(), z.object({ resolved_at: z.string() })),
})

/**
 * Validate the GET /settings/resolved-problems response at the boundary.
 * A malformed payload degrades to an empty map (problems simply show as
 * unresolved) instead of crashing the tree pipeline.
 */
export function parseResolvedProblemsResponse(payload: unknown): { resolved: ResolvedProblemsMap } {
  const parsed = resolvedProblemsResponseSchema.safeParse(payload)
  if (!parsed.success) {
    console.error('Invalid resolved-problems response:', parsed.error.message)
    return { resolved: {} }
  }
  return parsed.data
}

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

// Server-side caps on stored keys (settings_handler.py): stay in lockstep.
const MAX_KEY_CHARS = 255
const MAX_KEY_BYTES = 255

/** Deterministic truncation to the server caps, so every client derives the
 * same key for the same problem group. Operates on whole CODE POINTS, never
 * UTF-16 code units — slicing a surrogate pair in half would leave a lone
 * surrogate that the server's UTF-8 encoding rejects. Single-pass: each
 * code point is encoded once and the prefix that fits the byte cap wins. */
function fitToKeyCaps(key: string): string {
  const encoder = new TextEncoder()
  const codePoints = Array.from(key).slice(0, MAX_KEY_CHARS)
  const fit = codePoints.reduce(
    (acc, codePoint) => {
      // Stop at the FIRST overflow: continuing would let later smaller code
      // points "fit" the running budget while the prefix slice still
      // includes the skipped one, breaking the byte cap.
      if (acc.stopped) return acc
      const nextBytes = acc.bytes + encoder.encode(codePoint).length
      return nextBytes <= MAX_KEY_BYTES
        ? { bytes: nextBytes, count: acc.count + 1, stopped: false }
        : { ...acc, stopped: true }
    },
    { bytes: 0, count: 0, stopped: false },
  )
  return codePoints.slice(0, fit.count).join('')
}

/**
 * Build the stable key a problem group is resolved under.
 *
 * All three components are normalized (trim + lowercase + collapsed
 * whitespace): they are LLM-classified values, so casing/whitespace drift
 * ("Delivery" vs "delivery") must not orphan a resolution. `|` is the
 * component separator, and since categories are user-configurable it is
 * normalized out of the values themselves so a literal pipe in a category
 * name can't merge two different problems under one key. The result is
 * deterministically truncated to the server's 255-char/255-byte caps.
 */
export function buildResolutionKey(category: string, subcategory: string, problem: string): string {
  const normalize = (value: string) =>
    value.replaceAll('|', ' ').trim().toLowerCase().replaceAll(/\s+/g, ' ')
  return fitToKeyCaps(`${normalize(category)}|${normalize(subcategory)}|${normalize(problem)}`)
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
