# Problem Prioritization Prompt

## Purpose
Score and rank identified problems by impact and effort to produce a prioritized backlog.

> **Scope — this ranks PROBLEMS.** It scores raw customer **problems** (from VoC
> feedback) into a backlog, using Frequency + Severity + Reach (1–10, summed, max
> 30). It is **distinct from** the Phase-2 Prioritize sub-agent
> (`agents/02-ideation/sub-prioritize/AGENT.md`), which ranks finished
> **projects/features** (PRFAQ/PRD) by Impact / Time-to-Market / Strategic-Fit /
> Confidence to decide build order. Different object, phase, and formula — the two
> are complementary, not redundant.

---

## Prioritization Prompt

### System Prompt
```
You are a product strategist skilled at prioritizing customer problems using data-driven frameworks.
Score each problem based on evidence from the feedback data. Never guess — if data is insufficient, mark confidence as LOW.
```

### User Prompt Template
```
Prioritize these identified problems based on the customer feedback data.

## PROBLEMS IDENTIFIED:
{problems_list}

## SUPPORTING DATA:
- Total feedback items analyzed: {total_count}
- Time period: {days} days
- Sources: {sources}

## FEEDBACK CONTEXT:
{feedback_context}

---

For EACH problem, score on these dimensions (1-10):

1. **Frequency** (1-10): How often does this appear in feedback?
   - 1-3: Rare (< 5% of feedback)
   - 4-6: Moderate (5-15%)
   - 7-10: Common (> 15%)

2. **Severity** (1-10): How badly does it affect customers?
   - Based on: sentiment scores, urgency levels, emotional language
   - 1-3: Mild inconvenience
   - 4-6: Significant frustration
   - 7-10: Blocking / causing churn

3. **Reach** (1-10): How many personas/segments are affected?
   - 1-3: One niche segment
   - 4-6: 2-3 segments
   - 7-10: Universal problem

4. **Trend** (↑ growing, → stable, ↓ declining): Is it getting worse?

5. **Effort Estimate** (S/M/L/XL): Rough implementation effort

## Output format:

| Rank | Problem | Frequency | Severity | Reach | Score | Trend | Effort | Confidence |
|------|---------|-----------|----------|-------|-------|-------|--------|-----------|
| 1    | ...     | 8         | 9        | 7     | 24    | ↑     | M      | HIGH      |

**Priority Score** = Frequency + Severity + Reach (max 30)

Also provide:
- **Quick Wins**: High score + Small effort
- **Big Bets**: High score + Large effort
- **Monitor**: Low score but growing trend
- **Defer**: Low score + stable/declining
```

---

## Output

Save as `knowledge-base/projects/{project}/validation/prioritization.md`
Include a summary table and recommended next actions.
