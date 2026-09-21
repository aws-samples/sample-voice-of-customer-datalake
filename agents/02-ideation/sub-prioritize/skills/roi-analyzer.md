# ROI Analyzer — Skill (Prioritize Agent)

## Purpose

Calculate the Return on Investment for a feature/project based on PRD, PRFAQ, and research data. Delivers a structured cost-benefit analysis as a decision-making basis.

---

## Input

| Document | What comes from it |
|----------|-------------------|
| **PRD** | Scope, Features, Timeline, Dependencies → Effort estimation |
| **PRFAQ** | Customer Value, Market Size, Success Metrics → Revenue/Impact estimation |
| **Research** | Problem Frequency, Severity, Reach → Quantified customer benefit |
| **Prioritization Score** | Impact, TTM, Confidence → Risk assessment |

---

## ROI Model

### Costs (Investment)

| Cost Category | How estimated |
|--------------|---------------|
| **Engineering** | Number of Features × Complexity (S/M/L/XL) → Story Points → FTEs × Months |
| **Design** | UX Research + UI Design (% of Engineering) |
| **Infrastructure** | Cloud Costs (from PRD Non-Functional Requirements) |
| **Opportunity Cost** | What can we NOT build while we do this? |
| **Maintenance** | Ongoing costs after launch (% of Build) |

### Benefits (Return)

| Benefit Category | How estimated |
|-----------------|---------------|
| **Revenue Impact** | New Customers × Conversion × ARPU (from PRFAQ/Market Data) |
| **Retention Impact** | Churn Reduction × Customer LTV (from VoC Severity) |
| **Efficiency Gains** | Time saved × Number of Users × Hourly Rate |
| **Cost Avoidance** | Support Tickets reduced × Cost per Ticket |
| **Strategic Value** | Market Position, Competitive Defense (qualitative) |

### Formula

```
ROI (%) = ((Total Return - Total Investment) / Total Investment) × 100

Payback Period = Total Investment / Monthly Return

NPV (3 years) = Σ (Monthly Return / (1 + discount_rate)^month) - Investment
```

---

## Dialog with the User

### Step 1: Select Project/Feature
```
"For which project/feature should I calculate the ROI?
[List of available projects with PRFAQs]"
```

### Step 2: Clarify Assumptions
```
"I need a few assumptions:

💰 Team Costs:
- Engineering hourly rate? (Default: $120/h)
- Team size? (Default: derive from PRD Scope)

📈 Revenue Model:
- Is there a direct revenue impact? (New customers / Upsell / Pricing)
- Or rather retention/efficiency?

⏱️ Timeframe:
- ROI over what period? (Default: 12 months after launch)

Or should I calculate with standard assumptions and you correct?"
```

### Step 3: Calculation + Sensitivity Analysis
- Best Case / Base Case / Worst Case
- Which assumption has the biggest influence?

---

## Output: ROI Report

```markdown
# ROI Analysis: [Feature/Project]
**Created:** [Date]
**Timeframe:** [X months]
**Confidence:** HIGH | MEDIUM | LOW

## Summary

| Metric | Value |
|--------|-------|
| Total Investment | $XXX,XXX |
| Projected Return (12M) | $XXX,XXX |
| **ROI** | **XXX%** |
| Payback Period | X months |
| NPV (3 years, 8% Discount) | $XXX,XXX |

## Investment Breakdown

| Category | Effort | Cost |
|----------|--------|------|
| Engineering | X FTEs × Y months | $XXX |
| Design | X FTEs × Y months | $XXX |
| Infra (12M) | $XXX/month | $XXX |
| Opportunity Cost | [What won't be built] | $XXX |
| **Total** | | **$XXX,XXX** |

## Return Breakdown

| Category | Monthly | Annually | Justification |
|----------|---------|----------|---------------|
| Revenue | $XXX | $XXX | [From PRFAQ: X new customers × Y ARPU] |
| Retention | $XXX | $XXX | [From VoC: X% Churn Reduction × LTV] |
| Efficiency | $XXX | $XXX | [X users × Y min/day × hourly rate] |
| Cost Avoidance | $XXX | $XXX | [X tickets/month × $XX per ticket] |
| **Total** | **$XXX** | **$XXX,XXX** | |

## Sensitivity Analysis

| Scenario | ROI | Payback |
|----------|:---:|:-------:|
| 🟢 Best Case (+30%) | XXX% | X mo |
| 🔵 Base Case | XXX% | X mo |
| 🔴 Worst Case (-30%) | XXX% | X mo |

**Biggest Lever:** [Which assumption has the most impact?]

## Risks for the ROI

| Risk | Probability | Impact on ROI | Mitigation |
|------|:-----------:|:-------------:|------------|
| [Risk 1] | Medium | -XX% | [Action] |
| [Risk 2] | Low | -XX% | [Action] |

## Recommendation

[2-3 sentences: Invest? Yes/No/Conditional? Why?]

## Assumptions (for transparency)

- Engineering rate: $XXX/h
- Discount Rate: 8%
- [Further assumptions]
```

## Storage Location

`knowledge-base/projects/[name]/ideation/roi-analysis.md`

---

## Important Rules

1. **Transparent assumptions** — Every number must have a justification
2. **Best/Base/Worst** — Always show 3 scenarios
3. **Name qualitative values** — Strategic Value cannot always be expressed in dollars
4. **User corrects** — AI estimates, user validates the assumptions
5. **Connection to prioritization** — ROI flows into the Impact score of the Prioritize Agent
