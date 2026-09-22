# Project: AnyCompany Insights Platform

## Metadata

```yaml
name: "AnyCompany Insights Platform"
customer: "AnyCompany"
date: "2026-06-21"
status: "active"
team: ["Martha Rivera", "Mateo Jackson"]
focus: "Onboarding, Adoption & Reporting Experience"
industry: "Software / SaaS"
```

> Fictional example. "AnyCompany" is a placeholder brand and all feedback is
> synthetic sample data — no real customer or product.

## Context

Workshop to improve **AnyCompany Insights**, a SaaS product-feedback & analytics
tool. Based on the customer feedback dataset in
`knowledge-base/voc-data/example-feedback.json` (10 reviews across app-store,
in-app, support, G2, and feature-request channels, June 2026).

## Core Problems (from Signal Analysis)

Derived from the VoC dataset — see `signals/signal-summary.md`:

1. **Confusing onboarding & outdated docs** — new users can't complete first-run
   setup; documentation doesn't match the current UI. `[review_001]`
2. **Steep learning curve / low team adoption** — non-technical teammates revert
   to spreadsheets. `[review_003]`
3. **Broken reporting & exports** — PDF exports show wrong dates, charts fail to
   render, and the date-range picker resets on tab switch. `[review_004]`
4. **No SMB pricing tier** — low-volume customers pay enterprise rates; there is
   no startup tier. `[review_006]`
5. **Weak multilingual support** — inaccurate translations and sentiment analysis
   fails on non-English (German/French) feedback. `[review_008, review_009]`

**What's working (protect these):** AI auto-categorization `[review_002]`, mobile
app + push notifications `[review_005]`, Slack integration + sentiment alerts
`[review_007]`, developer API & webhooks `[review_010]`.

## Workshop Goal

Define an integrated **"AnyCompany Onboard"** initiative that:
- Adds guided, in-product onboarding and refreshes the documentation
- Simplifies the experience for non-technical roles to drive team adoption
- Makes reporting and exports reliable (correct dates, rendered charts,
  persisted filters)
- Introduces an SMB / startup pricing tier
- Improves translation quality and multilingual sentiment analysis
