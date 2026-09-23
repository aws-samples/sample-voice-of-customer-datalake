# Results Dashboard — Skill

## Purpose

Generate an interactive dashboard as HTML artifact with Chart.js (MIT-licensed). Displays survey results, hypothesis validation, and prioritization.

---

## Input

CSV file with survey responses. Flexible format — the agent automatically recognizes:
- Google Forms Export
- Microsoft Forms Export
- Typeform Export
- Custom CSV

## Dashboard Components

### 1. NPS Gauge
```
Chart.js half-doughnut gauge: NPS Score (-100 to +100)
- Colors: Red (< 0), Yellow (0-30), Green (> 30)
- Breakdown: X% Detractors, Y% Passives, Z% Promoters
```

### 2. Star Rating Distribution
```
Chart.js horizontal bar:
⭐⭐⭐⭐⭐  ████████ 45%
⭐⭐⭐⭐     ███████  35%
⭐⭐⭐        ███     15%
⭐⭐           █       3%
⭐              █       2%
```

### 3. Likert Scale Stacked Bar
```
Chart.js stacked bar (per statement):
[Strongly Disagree | Disagree | Neutral | Agree | Strongly Agree]
```

### 4. Response Summary Cards
```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Responses   │  │  Avg Rating  │  │  NPS Score   │
│     42       │  │    4.2/5     │  │     +35      │
└──────────────┘  └──────────────┘  └──────────────┘
```

### 5. Hypothesis Validation Matrix
```
Styled HTML table (Chart.js core has no heatmap):
| Hypothesis | Metric | Target | Result | Status |
|------------|--------|--------|--------|--------|
| H1         | NPS    | >30    | 35     | ✅ Validated |
| H2         | Agree% | >60%   | 45%    | ❌ Refuted |
| H3         | Rating | >4.0   | 4.2    | ✅ Validated |
```

### 6. Prioritization Scatter (Impact vs. Effort)
```
Chart.js scatter:
Y-Axis: Impact (from survey data)
X-Axis: Effort (estimated)
Quadrants: Quick Wins | Big Bets | Fill-ins | Money Pit
```

### 7. Word Cloud (Free Text)
```
Most frequent terms from free-text responses
Size = Frequency
```

### 8. Trend / Timeline (when multiple surveys exist)
```
Chart.js line: NPS/Rating over time
```

---

## Prompt Template

### System Prompt
```
You create interactive dashboards as HTML artifacts with Chart.js.
The dashboards display survey results and hypothesis validation.

Rules:
- Everything in one HTML file (Chart.js CDN is allowed)
- Responsive layout (Grid/Flexbox)
- Dark Mode support
- Tooltips for details
- Export buttons (PNG/CSV) where appropriate
```

### User Prompt Template
```
Create a Results Dashboard for this survey data:

## DATA (CSV):
{csv_content}

## HYPOTHESES:
{hypotheses_with_targets}

## QUESTION MAPPING:
{question_to_hypothesis_mapping}

---

Create an HTML Dashboard with:
1. Summary Cards (Responses, Avg Rating, NPS)
2. Visualization per question type (NPS Gauge, Star Bars, Likert Stacked)
3. Hypothesis Validation Table (with ✅/❌ status)
4. Key Insights (3-5 bullet points)
5. Recommended Next Steps

Output: One HTML file with inline Chart.js.
```

---

## Output

- `knowledge-base/projects/[name]/validation/dashboard.html` — Interactive Dashboard
- Open the file for a live preview (Quick: `open_in_session_tab`; Kiro/Claude Code: open it in the editor or browser)

## Technical Details

- **Chart.js CDN:** `https://cdn.jsdelivr.net/npm/chart.js` (allowed in HTML artifacts; MIT license — chosen over Highcharts, which requires a paid license for commercial use)
- **Layout:** CSS Grid, max 2-3 charts per row
- **Responsive:** Mobile-friendly
- **Interactive:** Hover tooltips, click-to-filter where possible
