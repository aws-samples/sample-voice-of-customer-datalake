# Signal Summary — AnyCompany Insights Platform

**Phase:** 1 (Signal Analysis)
**Source dataset:** `knowledge-base/voc-data/example-feedback.json`
**Items analyzed:** 10 &nbsp;|&nbsp; **Date range:** 2026-06-10 → 2026-06-17
**Channels:** app_store_review, in_app_feedback, support_ticket, g2_review, feature_request

> Fictional example built from synthetic sample feedback — no real customer.
> This is a worked Phase-1 output so the Phase 1 → Phase 2 chain is reproducible.

## Overview

| Metric | Value |
|--------|-------|
| Reviews | 10 |
| Average rating | 3.2 / 5 |
| Negative (rating ≤ 2) | 4 |
| Neutral (rating = 3) | 2 |
| Positive (rating ≥ 4) | 4 |

## Top Themes

| # | Theme | Sentiment | Evidence |
|---|-------|-----------|----------|
| 1 | Onboarding & documentation | Negative | `review_001` |
| 2 | Team adoption / learning curve | Negative | `review_003` |
| 3 | Reporting & export reliability | Negative | `review_004` |
| 4 | Pricing (no SMB tier) | Negative | `review_006` |
| 5 | Multilingual translation & sentiment | Negative | `review_008`, `review_009` |
| 6 | AI auto-categorization | Positive | `review_002` |
| 7 | Mobile app & notifications | Positive | `review_005` |
| 8 | Slack integration & sentiment alerts | Positive | `review_007` |
| 9 | Developer API & webhooks | Positive | `review_010` |

## Core Problems (prioritized)

1. **Confusing onboarding & outdated docs** — users abandon first-run setup;
   docs lag the current UI. `[review_001]`
2. **Steep learning curve / low adoption** — non-technical teams revert to
   spreadsheets. `[review_003]`
3. **Broken reporting & exports** — wrong PDF dates, charts don't render,
   date-range filter resets on tab switch. `[review_004]`
4. **No SMB pricing tier** — flat pricing penalizes low-volume customers.
   `[review_006]`
5. **Weak multilingual support** — poor translation quality; sentiment fails on
   non-English text (~40% of some customers' feedback). `[review_008, review_009]`

## Validated Strengths (do not break)

- AI auto-categorization saves users hours weekly `[review_002]`
- Mobile app + push notifications for urgent feedback `[review_005]`
- Slack integration with real-time sentiment alerts `[review_007]`
- Excellent developer experience — API docs + webhooks `[review_010]`

## Representative Quotes

- *"The onboarding process was incredibly confusing… the documentation is
  outdated and doesn't match the current UI."* — `review_001` (rating 2)
- *"The learning curve is too steep for non-technical users. My marketing team
  just goes back to spreadsheets."* — `review_003` (rating 3)
- *"Reporting is broken. Exported PDFs have wrong dates, charts don't render…"*
  — `review_004` (rating 1)
