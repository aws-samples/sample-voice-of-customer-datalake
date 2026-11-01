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
  100,000 rows per request and per import day, and reads a 30,000-review import day in full
  (see [Capacity](#capacity)). The list routes keep their 5,000-row cap.
- **The caller's scope.** A viewer restricted to some categories or sources sees the tree of
  those only, with exact counts (the scope is pushed into every day's query).
- **The walk budget.** The read stops after 20 s like every other window walk. The answer then
  carries `is_partial: true`, `partial_reason: 'time_budget'` and `scanned_through` (the oldest
  day read in full), and the page says "Counts cover reviews back to …". When the 100,000-row
  cap cuts a day instead, `partial_reason` is `'row_cap'` and `scanned_through` is the day walked
  just before the cut day (omitted when the first day walked was cut).
- **Bounded answer.** At most 1,000 problems are listed (the largest). Every total still counts
  all of them (`problem_count` per subcategory), and `problems_truncated: true` makes the page say
  so. The cap stays on purpose: Lambda answers at most 6 MB and a listed problem costs up to about
  2 KB (wordings, root cause, sample ids), and the browser renders, sorts and exports every listed
  problem, so an uncapped tree of 20,000 one-review problems would be slow to load and to use
  while adding nothing a reader acts on. The review counts are never capped.

## `GET /feedback/problems`

Cognito, read-only, served by `voc-metrics-api` and memoized like the other read routes.

| Parameter | Meaning |
|---|---|
| `days`, `date_basis` | The window, as on every other page: the header's period (`days=0` = all time) and its date basis (`date_basis=review` = when the review was written; the review-date cutoff is the requested window, so reviews imported recently but written long ago are counted) |
| `source`, `channel`, `dims`, `tag`, `rating_min`/`rating_max` | Row filters, as on `/feedback`. `dims` takes several values of one key with `\|` and the choice `~unset` for "no value yet": the page's type filter sends `dims=feedback_type:bug\|service_failure\|…\|~unset` |
| `category`, `subcategory` | Exact match; a missing category groups as `uncategorized`, a missing subcategory as `general` |
| `urgent=1` | Urgent reviews only |
| `similarity` | `low` (0.2), `med` (0.4, default), `high` (0.6) or `off` (1.0): the keyword Jaccard similarity at which two problem wordings merge. Anything else is a 400 |

```json
{
  "period_days": 30, "is_partial": false,
  "window": {"kind": "days", "days": 0, "walk_days": 120, "date_basis": "review"},
  "type_counts": {"bug": 820, "service_failure": 410, "untyped": 300, "usability": 270},
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

`window` says which window was read: `{kind: 'days', days, walk_days, date_basis}` (`days` as
requested, `walk_days` the import days walked). `type_counts` counts the window's
reviews (after the row filters) per `feedback_type`, with `untyped` for reviews that have no
type yet.

## The window: the header's period

The page follows the period and date basis picked at the top of the page, like every other
page; the PDF export is titled with that period. Pick the **review date** basis to see an
import of old reviews by when customers wrote them: 26,000 reviews imported yesterday but
written months earlier are all in "last 7 days" by import date and spread over the months on
the review-date basis.

The "Latest 2,000 reviews" select of 5.45.00 is gone, and so is its `latest=N` parameter. An
old link with `window=…` opens on the header's period (the parameter is ignored and dropped
on the next filter change), and the server ignores a `latest` it is still sent.

## Review types

The review-type pills filter by review type (the built-in `feedback_type` dimension,
[dimensions.md](dimensions.md)). The Categories page has the same pills
([categories.md](categories.md#review-types)); the component is
`frontend/src/components/ReviewTypeFilter/`.

- **Problems only** is this page's default: bug, service failure, performance, usability,
  pricing and billing, support experience. Feature requests, praise, questions and other
  reviews are hidden.
- **All types** is no type filter: no type pill is pressed. **Clear** goes there too, with
  the other filters, so Clear is offered on the default view (Problems only is a filter).
- **One type in one click**: while Problems only shows (or no pill is pressed), a click on a
  type pill selects only that type. Later clicks add or remove pills; turning off the last one
  is no type filter again, not Problems only.
- Each pill shows its count in the window. Reviews with no type yet (stored before review types
  existed) are always kept in view, and the page says how many: an administrator classifies them
  with the reprocess job in Administration → Taxonomy. While most reviews are untyped, a type
  choice changes little, because those reviews stay in every view.
- The choice is in the URL: absent = Problems only, `types=all` = every type,
  `types=bug,praise` = those types.

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

## Capacity

Measured in 5.46.00 (`lambda/api/test/test_metrics_problems_capacity.py`, run with
`-o log_cli=true --log-cli-level=INFO` to see the numbers): 30,000 reviews imported in ONE day,
written over the 400 days before, about 2 KB each as stored, with thousands of distinct problem
wordings and a third of them in one subcategory. The test reads them through the real route from
an in-memory index that pages like DynamoDB (1 MB of full items per page).

| Window | Route CPU time (local, reads instant) | Reviews counted | Problems (listed) | Response |
|---|---|---|---|---|
| All time, review date, Similarity off | 1.1 s | 30,000, complete | 21,905 (1,000) | 306 KB |
| All time, import date | 1.2 s | 30,000, complete | 21,905 (1,000) | 306 KB |
| 90 days, import date | 1.15 s | 30,000, complete | 21,905 (1,000) | 306 KB |
| All time, Similarity medium (default) | 1.5 s | 30,000, complete | 2,109 (1,000) | 455 KB |
| All time, Similarity low | 1.2 s | 30,000, complete | 488 (488) | 152 KB |
| All time, Problems only (the page default) | 1.2 s | 23,290, complete | 1,777 (1,000) | 451 KB |

- **Nothing cuts a 30,000-review day.** One day and one request may hold 100,000 slim rows
  (`PROBLEM_READ`), so the day is read in full and the answer is not partial. Past 100,000 rows in
  the window the answer says it is partial.
- **The reads are the real cost.** DynamoDB fills a page with 1 MB of the stored items before the
  projection, so 30,000 reviews of 2 KB are about 58 pages, plus one query per day of the window
  (178 queries for all time over 120 days of history). At a typical 50–100 ms per 1 MB page that
  is 3–6 s, inside the 20 s walk budget; larger stored reviews mean proportionally more pages.
  When the budget does run out, the answer is partial and says back to which day it counted.
- **Merging wordings stays small.** The whole route, merge included, used at most 1.5 s of CPU,
  well inside the 9 s left after the walk budget. Per subcategory only the 5,000 largest distinct
  wordings are merged (`similarity_partial`); merging 25,000 distinct wordings at Similarity low
  took 4 s locally.
- **Memory and size.** 30,000 slim rows are a few tens of MB in a 1,769 MB function; the answer
  stays under 0.5 MB because only 1,000 problems are listed.

The Dashboard and the Categories page do not share this walk when no filter is set: their counts
come from the per-day counters, whatever the size of a day. With the review-date basis or a
source / channel / type filter they read the reviews themselves, as slim rows with this route's
capacity (5.47.00: 100,000 rows per request and per import day), so a 30,000-review day counts in
full there too (`lambda/api/test/test_metrics_aggregate_capacity.py`; before, they stopped at the
list routes' 5,000 rows and showed about 3,900 of 23,290 reviews in that test).
