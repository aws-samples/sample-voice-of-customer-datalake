/**
 * @fileoverview Client-side problem-text clustering for Problem Analysis.
 *
 * The server (`GET /feedback/problems`) now does the O(rows) pass over the full
 * window and returns FINEST-GRAIN problem leaves — rows bucketed by exact
 * (category, subcategory, problem_summary), each carrying its keyword set. This
 * module merges those leaves to the user's similarity threshold IN THE BROWSER,
 * over the few hundred distinct problems rather than the (up to 50k) raw rows,
 * so the slider stays instant.
 *
 * The primitives (`normalizeText`, `extractKeywords`, `jaccardSimilarity`) are a
 * FAITHFUL mirror of the server's `shared/problem_clustering.py`. Parity is
 * load-bearing: the server computes each leaf's keywords, and this module merges
 * on them, so a drift in either side mis-clusters. The shared fixture
 * `lambda/shared/test/fixtures/problem_clustering_cases.json` is asserted by both
 * this module's test and the Python test.
 *
 * @module pages/ProblemAnalysis/problemClustering
 */

// Mirrors `_STOP_WORDS` in shared/problem_clustering.py VERBATIM (128 words).
const STOP_WORDS = new Set<string>([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
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
  'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'get', 'got', 'getting',
])

/** Lowercase, strip non-alphanumerics, collapse whitespace. Mirrors `normalize_text`. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalized tokens longer than two chars that aren't stopwords. Mirrors `extract_keywords`. */
export function extractKeywords(text: string): Set<string> {
  const words = normalizeText(text).split(' ')
  return new Set(words.filter((w) => w.length > 2 && !STOP_WORDS.has(w)))
}

/** |A ∩ B| / |A ∪ B|, with the same empty-set edges as `jaccard_similarity`. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  const intersection = [...a].filter((x) => b.has(x)).length
  const union = a.size + b.size - intersection
  return intersection / union
}

/** One finest-grain problem leaf as returned by `GET /feedback/problems`. */
export interface ProblemLeaf {
  category: string
  subcategory: string
  problem: string
  keywords: string[]
  count: number
  urgent_count: number
  avg_sentiment: number
  root_cause: string | null
}

/** A merged problem: a representative leaf plus the ones folded into it. */
export interface MergedProblem {
  problem: string
  similarProblems: string[]
  rootCause: string | null
  count: number
  urgentCount: number
  avgSentiment: number
}

interface MergeAccumulator {
  representative: string
  keywords: Set<string>
  similar: string[]
  similarKeywords: Set<string>[]
  rootCause: string | null
  count: number
  urgentCount: number
  sentimentWeightedSum: number
}

/**
 * Merge leaves within one (category, subcategory) bucket by Jaccard similarity
 * of their keyword sets at `threshold`. Greedy and first-match-wins, mirroring
 * the browser's old `findSimilarProblem`: a leaf joins the first existing group
 * whose representative — or any already-folded member — is similar enough,
 * otherwise it starts a new group.
 *
 * Leaves arrive biggest-first from the server, so the representative of each
 * group is its largest member, matching the old behaviour where the first
 * problem seen for a group became its key.
 */
export function mergeLeaves(leaves: ProblemLeaf[], threshold: number): MergedProblem[] {
  const groups: MergeAccumulator[] = []

  for (const leaf of leaves) {
    const keywords = new Set(leaf.keywords)
    const match = groups.find(
      (g) =>
        jaccardSimilarity(keywords, g.keywords) >= threshold ||
        g.similarKeywords.some((k) => jaccardSimilarity(keywords, k) >= threshold),
    )
    if (match) {
      match.similar.push(leaf.problem)
      match.similarKeywords.push(keywords)
      match.count += leaf.count
      match.urgentCount += leaf.urgent_count
      match.sentimentWeightedSum += leaf.avg_sentiment * leaf.count
      if (!match.rootCause && leaf.root_cause) match.rootCause = leaf.root_cause
    } else {
      groups.push({
        representative: leaf.problem,
        keywords,
        similar: [],
        similarKeywords: [],
        rootCause: leaf.root_cause,
        count: leaf.count,
        urgentCount: leaf.urgent_count,
        sentimentWeightedSum: leaf.avg_sentiment * leaf.count,
      })
    }
  }

  return groups
    .map((g) => ({
      problem: g.representative,
      similarProblems: g.similar,
      rootCause: g.rootCause,
      count: g.count,
      urgentCount: g.urgentCount,
      // Weighted by each leaf's count so the merged mean matches a mean over
      // the underlying rows, not a mean of per-leaf means.
      avgSentiment: g.count > 0 ? g.sentimentWeightedSum / g.count : 0,
    }))
    .sort((x, y) => y.count - x.count)
}
