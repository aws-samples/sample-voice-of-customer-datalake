/**
 * @fileoverview Problem grouping logic with text similarity merging.
 * @module pages/ProblemAnalysis/problemGrouping
 */
import type { FeedbackItem } from '../../api/types'

export interface ProblemGroup {
  problem: string
  /** Original problem texts that were merged */
  similarProblems: string[]
  rootCause: string | null
  items: FeedbackItem[]
  avgSentiment: number
  urgentCount: number
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

function normalizeText(text: string): string {
  return text.toLowerCase().replaceAll(/[^a-z0-9\s]/g, '').replaceAll(/\s+/g, ' ').trim()
}

function extractKeywords(text: string): Set<string> {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
    'because', 'until', 'while', 'although', 'though', 'whenever',
    'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
    'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
    'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which',
    'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'get', 'got', 'getting'])
  const words = normalizeText(text).split(' ')
  return new Set(words.filter((w) => w.length > 2 && !stopWords.has(w)))
}

function jaccardSimilarity(set1: Set<string>, set2: Set<string>): number {
  if (set1.size === 0 && set2.size === 0) return 1
  if (set1.size === 0 || set2.size === 0) return 0
  const intersection = new Set([...set1].filter((x) => set2.has(x)))
  const union = new Set([...set1, ...set2])
  return intersection.size / union.size
}

function findSimilarProblem(problems: Map<string, ProblemGroup>, newProblem: string, threshold: number = 0.4): string | null {
  const newKeywords = extractKeywords(newProblem)
  for (const [existingProblem, group] of problems) {
    if (jaccardSimilarity(newKeywords, extractKeywords(existingProblem)) >= threshold) return existingProblem
    if (group.similarProblems.some((t) => jaccardSimilarity(newKeywords, extractKeywords(t)) >= threshold)) return existingProblem
  }
  return null
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  const existing = map.get(key)
  if (existing != null) return existing
  const newVal = factory()
  map.set(key, newVal)
  return newVal
}

function mergeIntoGroup(group: ProblemGroup, item: FeedbackItem, problem: string, primaryKey: string): void {
  group.items.push(item)
  if (item.urgency === 'high') group.urgentCount++
  if (problem !== primaryKey && !group.similarProblems.includes(problem)) group.similarProblems.push(problem)
  if ((group.rootCause == null || group.rootCause === '') && item.problem_root_cause_hypothesis != null && item.problem_root_cause_hypothesis !== '') {
    group.rootCause = item.problem_root_cause_hypothesis
  }
}

function addItemToProblemGroup(problemMap: Map<string, ProblemGroup>, item: FeedbackItem, problem: string, similarityThreshold: number): void {
  const similarProblemKey = findSimilarProblem(problemMap, problem, similarityThreshold)
  if (similarProblemKey != null && similarProblemKey !== '') {
    const group = problemMap.get(similarProblemKey)
    if (group) {
      mergeIntoGroup(group, item, problem, similarProblemKey)
    }
  } else {
    problemMap.set(problem, {
      problem,
      similarProblems: [],
      rootCause: item.problem_root_cause_hypothesis ?? null,
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
  return {
    subcategory,
    problems,
    totalItems: problems.reduce((s, p) => s + p.items.length, 0),
    urgentCount: problems.reduce((s, p) => s + p.urgentCount, 0),
  }
}

export interface GroupingOptions {
  showUrgentOnly: boolean
  selectedCategory: string | null
  selectedSubcategory: string | null
  selectedSource: string | null
  similarityThreshold: number
}

export function buildGroupedData(items: FeedbackItem[] | undefined, options: GroupingOptions): CategoryGroup[] {
  if (!items) return []
  const categoryMap = new Map<string, Map<string, Map<string, ProblemGroup>>>()
  const filteredItems = items
    .filter((item) => item.problem_summary != null && item.problem_summary !== '')
    .filter((item) => !options.showUrgentOnly || item.urgency === 'high')
    .filter((item) => (options.selectedCategory == null || options.selectedCategory === '') || item.category === options.selectedCategory)
    .filter((item) => (options.selectedSubcategory == null || options.selectedSubcategory === '') || item.subcategory === options.selectedSubcategory)
    .filter((item) => (options.selectedSource == null || options.selectedSource === '') || item.source_platform === options.selectedSource)

  for (const item of filteredItems) {
    const category = item.category === '' ? 'uncategorized' : item.category
    const subcategory = item.subcategory ?? 'general'
    const problem = item.problem_summary ?? ''
    const subcategoryMap = getOrCreate(categoryMap, category, () => new Map<string, Map<string, ProblemGroup>>())
    const problemMap = getOrCreate(subcategoryMap, subcategory, () => new Map<string, ProblemGroup>())
    addItemToProblemGroup(problemMap, item, problem, options.similarityThreshold)
  }

  const result: CategoryGroup[] = []
  for (const [category, subcategoryMap] of categoryMap) {
    const subcategories: SubcategoryGroup[] = []
    for (const [subcategory, problemMap] of subcategoryMap) {
      subcategories.push(buildSubcategoryGroup(problemMap, subcategory))
    }
    subcategories.sort((a, b) => b.totalItems - a.totalItems)
    result.push({
      category,
      subcategories,
      totalItems: subcategories.reduce((s, sub) => s + sub.totalItems, 0),
      urgentCount: subcategories.reduce((s, sub) => s + sub.urgentCount, 0),
    })
  }
  result.sort((a, b) => b.totalItems - a.totalItems)
  return result
}
