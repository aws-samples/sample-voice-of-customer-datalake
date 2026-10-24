# Problem Analysis

The Problem Analysis page (`/problems`) groups the reviews of the selected period that
name a problem into category → subcategory → problem, merges problems worded alike, and
shows each problem's review count, urgent count, sentiment, likely root cause and a few
example reviews. Resolved marks are shared by the whole team (`/settings/resolved-problems`).

## Where the counts come from

One request, `GET /feedback/problems`, answers the whole tree. The metrics Lambda reads
**every** review of the window, aggregates them and returns counts, never the reviews.
Before this the page paged `/feedback` in the browser and stopped at the newest 2,000
reviews, so on a large workspace every count was a fraction of the real one.

- **Slim rows.** The day walk reads only the fields the tree needs (a
  `ProjectionExpression`: category, subcategory, problem summary, root cause, urgency,
  sentiment, the two dates, source, channel, dimensions, tags, rating), so it can hold up to
  100,000 rows and read a 25,000-review day in full. The list routes keep their 5,000-row cap.
- **The caller's scope.** A viewer restricted to some categories or sources sees the tree of
  those only, with exact counts (the scope is pushed into every day's query).
- **The walk budget.** The read stops after 20 s like every other window walk. The answer then
  carries `is_partial: true`, `partial_reason: 'time_budget'` and `scanned_through` (the oldest
  day read in full), and the page says "Counts cover reviews back to …".
- **Bounded answer.** At most 2,000 problems are listed (the largest). Every total still counts
  all of them (`problem_count` per subcategory), and `problems_truncated: true` makes the page say so.

## `GET /feedback/problems`

Cognito, read-only, served by `voc-metrics-api` and memoized like the other read routes.

| Parameter | Meaning |
|---|---|
| `days`, `date_basis` | The window (`days=0` = all time; `date_basis=review` = when the review was written) |
| `source`, `channel`, `dims`, `tag`, `rating_min`/`rating_max` | Row filters, as on `/feedback` |
| `category`, `subcategory` | Exact match; a missing category groups as `uncategorized`, a missing subcategory as `general` |
| `urgent=1` | Urgent reviews only |
| `similarity` | `low` (0.2), `med` (0.4, default), `high` (0.6) or `off` (1.0): the keyword Jaccard similarity at which two problem wordings merge. Anything else is a 400 |

```json
{
  "period_days": 30, "is_partial": false,
  "feedback_count": 26622, "problem_count": 4100, "problems_truncated": true,
  "subcategories": ["refunds", "shipping"],
  "categories": [{
    "category": "delivery", "total_items": 9120, "urgent_count": 610,
    "subcategories": [{
      "subcategory": "shipping", "total_items": 7400, "urgent_count": 590, "problem_count": 830,
      "problems": [{
        "problem": "Slow delivery times", "similar_problems": ["Delivery too slow"], "similar_count": 37,
        "root_cause": "Carrier backlog", "count": 1250, "urgent_count": 140,
        "avg_sentiment": -0.61, "sentiment_counts": {"negative": 1180, "neutral": 70},
        "sample_ids": ["…"]
      }]
    }]
  }]
}
```

`subcategories` lists what the subcategory filter can offer: the subcategories of the chosen
category, whatever subcategory is chosen. An expanded problem reads its `sample_ids` (up to
ten, newest first) with `GET /feedback/{id}`.

## Grouping

The merge is the one the browser used to run (`shared/problem_clustering.py`): a problem
summary becomes its stopword-filtered keywords, and a problem joins the first group, in the
order groups were opened, that holds any wording at least `similarity` alike; otherwise it
opens a group, and its wording names it. Reviews are read newest first, so the newest wording
names a group. The server indexes the wordings by their rarest keywords (a prefix-filtered
similarity join), which gives the same groups as comparing every pair, fast enough for tens
of thousands of distinct wordings.

## Checking it against the category totals

For an unrestricted caller, `feedback_count` of `GET /feedback/problems?days=N` is the number
of reviews in the window that carry a problem summary. It is at most the sum of
`GET /metrics/categories?days=N` (which also counts reviews without one), and a category's
`total_items` is at most that category's count there.
