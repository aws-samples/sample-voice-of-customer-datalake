# Data quality: the usefulness band

"Great!" and a 300-word account of a specific failure used to weigh the same everywhere. Every
review now carries a **usefulness** band, `low`, `medium` or `high`, and the Data Explorer shows how
the bands spread over each source. A source that produces mostly `low` feedback is the usual sign of
a misconfigured scraper or a form field people skip.

## How the band is computed

The band is a deterministic **heuristic**, computed by the processor while it enriches a review
(`lambda/shared/usefulness.py`). It uses the text and the enrichment the processor already has, so it
costs no extra model call. It is an ordinal band on purpose, not a score: the inputs are rough, and a
number such as 0.73 would claim a precision the rule does not have.

Each of these signals adds one point:

| Signal | Rule (named constant) |
|---|---|
| Detailed | at least 15 words (`DETAILED_WORDS`) |
| Long | at least 50 words (`LONG_WORDS`), on top of the point above |
| A number | a digit anywhere: a date, a version, an amount, an order or flight number |
| A product term | one of `SPECIFIC_TERMS` (crash, error, login, refund, checkout, booking, ...) |
| A concrete issue or request | the built-in `feedback_type` is a problem, a request or a question (`CONCRETE_TYPES`: not `praise` or `other`); with no type yet, the enrichment wrote a `problem_summary` |

A review is `low` whatever its points when it is near-empty (fewer than 3 words or 12 characters,
`MIN_WORDS` / `MIN_CHARS`) or boilerplate (`BOILERPLATE`: "Great!", "ok", "n/a", "thank you", ...).
Otherwise 3 points or more is `high` (`HIGH_POINTS`), 1 or 2 is `medium` (`MEDIUM_POINTS`), and 0 is
`low`.

The cue words are English, so the rule reads `normalized_text` (the translation the processor stores
for a review in another language) when there is one. Length is script-aware: without a translation, a
review in a script written without spaces (Chinese, Japanese, Thai, ...) counts every 2 characters
(`CJK_CHARS_PER_WORD`) as one word and each character as 2 toward `MIN_CHARS`, so it is not rated
`low` just because it has no spaces. Its product terms still only match in English. A `summary_only`
source is rated on the full text at ingestion, before the storage policy replaces it with the summary.

The band is stored as the top-level `usefulness` attribute of the feedback item. It is recomputed
when the text changes: an in-place refresh of a GitHub issue (`shared/source_updates.py`) and every
category reprocess mode.

## Backfill: optional field, "Not rated"

Decision (issue #238): the field is optional. Reviews stored before the band existed have no
`usefulness` and count as **unrated** everywhere: the API answers them as `unrated`, the Data Explorer
shows them as "Not rated", the aggregator writes no band row for them, and the LLM-context sample
ranks them last among equals but never drops them.

To rate them, run a **category reprocess** (Administration → Taxonomy → Categories → "Reprocess
existing feedback", [categories](categories.md#reprocessing-existing-feedback)). Every mode computes
the band from the stored text, with no extra model call for the band itself:

- `processed` and `raw`: the band is written with the new category; when the category comes out
  unchanged but the band is missing or different, a band-only update is made. Reviews with a manual
  category are skipped by these modes, as before (use `include_manual`, or the `dimensions` mode).
- `dimensions`: the band is written with the re-inferred dimensions (it reads `feedback_type`); when
  the dimensions come out unchanged, a band-only update is made. Manual categories do not stop this
  mode.

A band-only update counts as `updated` in the job's counters and is conditional on the band being what
was read, so a concurrent change wins. A review from a `summary_only` source keeps the band it was
given at ingestion (from the full text, which is no longer stored): a reprocess re-rates it only when it
has no band yet, and then rates the stored summary.

## Per-source counters

The aggregator (`lambda/aggregator/handler.py`, `usefulness_bucket`) keeps one daily counter per source
and band in `voc-aggregates`:

```
pk = METRIC#daily_usefulness#<source_platform>#<band>    sk = YYYY-MM-DD    count
metric_type = usefulness                                 (on gsi1-by-metric-type)
```

Only rated reviews have a row. An insert adds one, a REMOVE takes one away, and a MODIFY that moves
the band (or a reprocess that rates an unrated review) moves it like any other counter: the decrement
and increment are the symmetric difference of the two images. The counters start at deploy time; days
before that have no band rows, so their reviews read as unrated until a reprocess rates them.

## Per-source profile

Next to the band, each source has a **profile** (`lambda/shared/source_profile.py`; ported from PR #429
by @aws-bryan): how its reviews are rated, their sentiment, and how long their text is. No model call, no
worker: the aggregator keeps three more daily counters per review, one per facet.

```
pk = METRIC#daily_profile_rating#<source_platform>#<1|2|3|4|5|none>                   metric_type = profile_rating
pk = METRIC#daily_profile_sentiment#<source_platform>#<positive|neutral|negative|mixed|other>  metric_type = profile_sentiment
pk = METRIC#daily_profile_length#<source_platform>#<short|medium|long|very_long>     metric_type = profile_length
sk = YYYY-MM-DD    count
```

| Facet | Buckets |
|---|---|
| Rating | Whole stars, rounded half up (4.5 = 5); `none` for no rating or a value outside 0–5 |
| Sentiment | The stored `sentiment_label`; `neutral` when absent (the aggregator's default), `other` for any other label |
| Text length | Characters of the stored `original_text` (after the source's privacy policy): `short` < 50, `medium` < 200, `long` < 1000, `very_long` otherwise |

Every profiled review has exactly one row per facet, so `profiled` (the sum of a source's rating rows)
is how many of its reviews the profile covers.

**Older days lack the profile.** The counters start when this release is deployed. Reviews stored
before then have no profile rows: the API counts them in `total` but not in `profiled`, and the Data
Explorer says how much of the range that is. A MODIFY or REMOVE of such a review is safe: its
decrement finds no row and is refused like any absent counter (nothing goes negative), and the increment
of a MODIFY counts the review from then on. The one inexact case is a review stored on the deploy day
itself and edited later that day, which can move one count between buckets. To fill a window, run
`scripts/retention/rebuild_aggregates.py` for it (docs/processing-pipeline.md): it recomputes every
counter, the profile rows included, from the stored reviews.

## `GET /metrics/data-quality`

On the metrics Lambda (`metrics_handler.py`, served by the `/metrics/{proxy+}` route), Cognito, read-only.

| Parameter | Meaning |
|---|---|
| `days` | 0–9999, `0` = all time (default 30), like every `/metrics/*` route |
| `date_basis` | `imported` (default) or `review` |

```json
{
  "period_days": 30,
  "is_partial": false,
  "sources": [
    {"source": "webscraper", "low": 12, "medium": 40, "high": 31, "unrated": 120, "total": 203,
     "profile": {"profiled": 150,
                 "rating": {"1": 20, "2": 10, "3": 15, "4": 40, "5": 55, "none": 10},
                 "sentiment": {"positive": 80, "neutral": 30, "negative": 35, "mixed": 5, "other": 0},
                 "length": {"short": 60, "medium": 70, "long": 18, "very_long": 2}}}
  ],
  "overall": {"low": 12, "medium": 40, "high": 31, "unrated": 120, "total": 203, "profile": {"profiled": 150, "…": "…"}}
}
```

`profile` is additive: a client that reads only the band fields is unaffected.

Busiest source first, ties by name; a source with nothing in the window is left out. `unrated` is the
source's total (`METRIC#daily_source#<source>`) minus its banded rows, never below zero.

- **Counters** answer a caller who sees every category and source, on the import-date basis: five
  `gsi1-by-metric-type` reads (sources, bands, and one per profile facet), no feedback walk. `is_partial`
  when any read left rows behind.
- **Items** answer a caller with a category or source rule, or the `review` basis, exactly like the
  sibling `/metrics/*` routes: the window's visible reviews are walked (projected, `usefulness`,
  `rating`, `sentiment_label` and `original_text` included) and counted. On this path every review is
  profiled, older ones too. A walk stopped by its time budget says so (`is_partial`, `partial_reason`).

The route is memoized like its siblings and keyed on the data version (docs/caching.md), so a write
batch refreshes it.

## In the Data Explorer

The **Data quality** section sits on the Processed Feedback tab of the Data Explorer (admins only) and
follows the header's time range. It shows a stacked bar per source (the 8 busiest) and a table of every
source with each band's count and share, an all-sources row, and the not-rated share with a pointer to
the reprocess when there is any. Below it, **Source profile** shows one facet at a time (Rating,
Sentiment, Text length): per source, each bucket's count and its share of the profiled reviews, and a
note with the share of the range stored before the profile was counted.

## In the LLM context

The persona, research and document generators read an even sample of the window
(`shared/feedback_sampling.py`, `sample_evenly`). The band is used only as a **tiebreaker**, never as a
filter: the reviews of one day are equal candidates for that day's share of the sample, so a pick that
lands on a day takes that day's next-best review by band (high, medium, low, unrated). Every day keeps
exactly its share, a day of only `low` reviews is still sampled, a pool with one band throughout is the
plain even sample, and the sample stays nested (pages and trims are unchanged). A channel-filtered
sample reads through `gsi5-by-channel`, which does not project the band, so it has no tiebreak.
