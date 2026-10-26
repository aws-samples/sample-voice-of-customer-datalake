/**
 * `GET /feedback/problems` for the dev mock: the Problem Analysis tree in the real
 * route's wire shape (`lambda/shared/problem_aggregation.py`). The caller passes the
 * already windowed, scoped and source / channel filtered fixture reviews; this module
 * applies the category / subcategory / urgent narrowing and the similarity merge
 * (brute force: the fixture is small) and answers counts, never reviews.
 */

const SIMILARITY = { low: 0.2, med: 0.4, high: 0.6, off: 1.0 };
const MAX_SAMPLE_IDS = 10;
const MAX_SIMILAR_LISTED = 10;

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'was', 'are', 'not', 'too', 'very', 'this', 'that', 'from', 'has', 'have']);

function keywordsOf(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().split(' ');
  return new Set(words.filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared);
}

const categoryOf = (f) => f.category || 'uncategorized';
const subcategoryOf = (f) => f.subcategory || 'general';

/** `{error}` for an unknown similarity, else the parsed narrowing. */
function parseQuery(searchParams) {
  const similarity = searchParams.get('similarity') || 'med';
  if (!(similarity in SIMILARITY)) return { error: 'similarity must be one of low, med, high, off' };
  return {
    category: searchParams.get('category') || null,
    subcategory: searchParams.get('subcategory') || null,
    urgentOnly: ['1', 'true'].includes(searchParams.get('urgent') ?? ''),
    threshold: SIMILARITY[similarity],
  };
}

function admits(query, f, ignoreSubcategory = false) {
  return (query.category === null || categoryOf(f) === query.category)
    && (ignoreSubcategory || query.subcategory === null || subcategoryOf(f) === query.subcategory)
    && (!query.urgentOnly || f.urgency === 'high');
}

function mergedGroup(reviews, texts) {
  const labels = {};
  for (const f of reviews) {
    const label = f.sentiment_label || 'neutral';
    labels[label] = (labels[label] ?? 0) + 1;
  }
  const similar = texts.slice(1);
  return {
    problem: texts[0],
    similar_problems: similar.slice(0, MAX_SIMILAR_LISTED),
    similar_count: similar.length,
    root_cause: reviews.find((f) => f.problem_root_cause_hypothesis)?.problem_root_cause_hypothesis ?? null,
    count: reviews.length,
    urgent_count: reviews.filter((f) => f.urgency === 'high').length,
    avg_sentiment: reviews.reduce((sum, f) => sum + (Number(f.sentiment_score) || 0), 0) / reviews.length,
    sentiment_counts: labels,
    sample_ids: reviews.slice(0, MAX_SAMPLE_IDS).map((f) => f.feedback_id),
  };
}

function subcategoryNode(name, reviews, threshold) {
  const groups = [];
  for (const f of reviews) {
    const text = f.problem_summary.trim();
    const words = keywordsOf(text);
    const group = groups.find((g) => g.texts.some((t) => jaccard(words, keywordsOf(t)) >= threshold));
    if (group) {
      group.reviews.push(f);
      if (!group.texts.includes(text)) group.texts.push(text);
    } else {
      groups.push({ texts: [text], reviews: [f] });
    }
  }
  const problems = groups.map((g) => mergedGroup(g.reviews, g.texts)).sort((a, b) => b.count - a.count);
  return {
    subcategory: name,
    total_items: problems.reduce((sum, p) => sum + p.count, 0),
    urgent_count: problems.reduce((sum, p) => sum + p.urgent_count, 0),
    problem_count: problems.length,
    problems,
  };
}

const byTotal = (nodes) => nodes.sort((a, b) => b.total_items - a.total_items);

/** The route's body for `items`, or a 400 envelope for a bad `similarity`. */
export function problemTree(items, searchParams) {
  const query = parseQuery(searchParams);
  if (query.error) return { __status: 400, body: { success: false, message: query.error } };
  const tree = new Map();
  for (const f of items) {
    if (!f.problem_summary?.trim() || !admits(query, f)) continue;
    const subs = tree.get(categoryOf(f)) ?? new Map();
    tree.set(categoryOf(f), subs);
    subs.set(subcategoryOf(f), [...(subs.get(subcategoryOf(f)) ?? []), f]);
  }
  const categories = byTotal([...tree].map(([category, subs]) => {
    const subcategories = byTotal([...subs].map(([name, reviews]) => subcategoryNode(name, reviews, query.threshold)));
    return {
      category,
      subcategories,
      total_items: subcategories.reduce((sum, s) => sum + s.total_items, 0),
      urgent_count: subcategories.reduce((sum, s) => sum + s.urgent_count, 0),
    };
  }));
  const subcategories = [...new Set(items.filter((f) => f.subcategory && admits(query, f, true)).map((f) => f.subcategory))].sort();
  return {
    period_days: Number(searchParams.get('days')) || 30,
    is_partial: false,
    feedback_count: categories.reduce((sum, c) => sum + c.total_items, 0),
    problem_count: categories.reduce((sum, c) => sum + c.subcategories.reduce((n, s) => n + s.problem_count, 0), 0),
    problems_truncated: false,
    subcategories,
    categories,
  };
}
