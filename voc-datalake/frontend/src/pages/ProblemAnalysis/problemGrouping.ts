/**
 * @fileoverview Builds the Problem Analysis tree: groups feedback by category,
 * subcategory and problem, merging problems whose keywords are similar.
 * @module pages/ProblemAnalysis/problemGrouping
 */
import type { FeedbackItem } from '../../api/types'
import type { CategoryGroup, ProblemGroup, SubcategoryGroup } from './problemResolution'

// Normalize text for similarity comparison
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Extract key words from text
function extractKeywords(text: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
    'because', 'until', 'while', 'although', 'though', 'after', 'before', 'when', 'whenever',
    'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
    'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
    'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which',
    'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'been', 'being', 'get', 'got', 'getting'])
  
  const words = normalizeText(text).split(' ')
  return new Set(words.filter(w => w.length > 2 && !stopWords.has(w)))
}

// Calculate Jaccard similarity between two sets
function jaccardSimilarity(set1: Set<string>, set2: Set<string>): number {
  if (set1.size === 0 && set2.size === 0) return 1
  if (set1.size === 0 || set2.size === 0) return 0
  
  const intersection = new Set([...set1].filter(x => set2.has(x)))
  const union = new Set([...set1, ...set2])
  
  return intersection.size / union.size
}

// Check if keywords match any in a list above threshold
function matchesAnyKeywords(newKeywords: Set<string>, texts: string[], threshold: number): boolean {
  return texts.some(text => jaccardSimilarity(newKeywords, extractKeywords(text)) >= threshold)
}

// Find or create a similar problem group
function findSimilarProblem(
  problems: Map<string, ProblemGroup>,
  newProblem: string,
  threshold: number = 0.4
): string | null {
  const newKeywords = extractKeywords(newProblem)

  for (const [existingProblem, group] of problems) {
    const existingKeywords = extractKeywords(existingProblem)
    if (jaccardSimilarity(newKeywords, existingKeywords) >= threshold) {
      return existingProblem
    }
    if (matchesAnyKeywords(newKeywords, group.similarProblems, threshold)) {
      return existingProblem
    }
  }

  return null
}

function getOrCreateSubcategoryMap(
  categoryMap: Map<string, Map<string, Map<string, ProblemGroup>>>,
  category: string
): Map<string, Map<string, ProblemGroup>> {
  const existing = categoryMap.get(category)
  if (existing) return existing
  const newMap = new Map<string, Map<string, ProblemGroup>>()
  categoryMap.set(category, newMap)
  return newMap
}

function getOrCreateProblemMap(
  subcategoryMap: Map<string, Map<string, ProblemGroup>>,
  subcategory: string
): Map<string, ProblemGroup> {
  const existing = subcategoryMap.get(subcategory)
  if (existing) return existing
  const newMap = new Map<string, ProblemGroup>()
  subcategoryMap.set(subcategory, newMap)
  return newMap
}

function updateExistingGroup(group: ProblemGroup, item: FeedbackItem, problem: string, similarProblemKey: string): void {
  group.items.push(item)
  if (item.urgency === 'high') group.urgentCount++
  if (problem !== similarProblemKey && !group.similarProblems.includes(problem)) {
    group.similarProblems.push(problem)
  }
  if (!group.rootCause && item.problem_root_cause_hypothesis) {
    group.rootCause = item.problem_root_cause_hypothesis
  }
}

function addItemToProblemGroup(
  problemMap: Map<string, ProblemGroup>,
  item: FeedbackItem,
  problem: string,
  similarityThreshold: number
): void {
  const similarProblemKey = findSimilarProblem(problemMap, problem, similarityThreshold)

  if (similarProblemKey) {
    const group = problemMap.get(similarProblemKey)
    if (group) {
      updateExistingGroup(group, item, problem, similarProblemKey)
    }
  } else {
    problemMap.set(problem, {
      problem,
      similarProblems: [],
      rootCause: nonEmptyOr(item.problem_root_cause_hypothesis, null),
      items: [item],
      avgSentiment: 0,
      urgentCount: item.urgency === 'high' ? 1 : 0,
    })
  }
}

function buildSubcategoryGroup(problemMap: Map<string, ProblemGroup>, subcategory: string): SubcategoryGroup {
  const problems: ProblemGroup[] = []

  for (const group of problemMap.values()) {
    group.avgSentiment = group.items.reduce((sum, i) => sum + i.sentiment_score, 0) / group.items.length
    problems.push(group)
  }

  problems.sort((a, b) => b.items.length - a.items.length)
  const totalItems = problems.reduce((sum, p) => sum + p.items.length, 0)
  const urgentCount = problems.reduce((sum, p) => sum + p.urgentCount, 0)
  return { subcategory, problems, totalItems, urgentCount }
}

function buildCategoryGroups(categoryMap: Map<string, Map<string, Map<string, ProblemGroup>>>): CategoryGroup[] {
  const result: CategoryGroup[] = []

  for (const [category, subcategoryMap] of categoryMap) {
    const subcategories: SubcategoryGroup[] = []

    for (const [subcategory, problemMap] of subcategoryMap) {
      subcategories.push(buildSubcategoryGroup(problemMap, subcategory))
    }

    subcategories.sort((a, b) => b.totalItems - a.totalItems)
    const categoryTotalItems = subcategories.reduce((sum, s) => sum + s.totalItems, 0)
    const categoryUrgent = subcategories.reduce((sum, s) => sum + s.urgentCount, 0)
    result.push({ category, subcategories, totalItems: categoryTotalItems, urgentCount: categoryUrgent })
  }

  result.sort((a, b) => b.totalItems - a.totalItems)
  return result
}

// Map the in-memory grouping tree to the PDF export shape
// (the problem level uses itemCount instead of the full items array).
export function toPDFCategories(groups: CategoryGroup[]) {
  return groups.map((c) => ({
    category: c.category,
    totalItems: c.totalItems,
    urgentCount: c.urgentCount,
    subcategories: c.subcategories.map((s) => ({
      subcategory: s.subcategory,
      totalItems: s.totalItems,
      urgentCount: s.urgentCount,
      problems: s.problems.map((p) => ({
        problem: p.problem,
        similarProblems: p.similarProblems,
        rootCause: p.rootCause,
        itemCount: p.items.length,
        avgSentiment: p.avgSentiment,
        urgentCount: p.urgentCount,
        // With "Show resolved" on, resolved groups reach the export — the
        // PDF must annotate them, since strike-through/badge is UI-only.
        resolved: p.resolved === true,
      })),
    })),
  }))
}

/** `value` unless it is missing or empty, else `fallback` — an empty string groups like an absent one. */
function nonEmptyOr<F>(value: string | null | undefined, fallback: F): string | F {
  return value === undefined || value === null || value === '' ? fallback : value
}

/** Category → subcategory → (similarity-merged) problem tree of the given items, largest first. */
export function groupProblems(items: readonly FeedbackItem[], similarityThreshold: number): CategoryGroup[] {
  const categoryMap = new Map<string, Map<string, Map<string, ProblemGroup>>>()
  for (const item of items) {
    const category = item.category || 'uncategorized'
    const subcategory = nonEmptyOr(item.subcategory, 'general')
    const problem = nonEmptyOr(item.problem_summary, 'Unknown Issue')

    const subcategoryMap = getOrCreateSubcategoryMap(categoryMap, category)
    const problemMap = getOrCreateProblemMap(subcategoryMap, subcategory)
    addItemToProblemGroup(problemMap, item, problem, similarityThreshold)
  }
  return buildCategoryGroups(categoryMap)
}
