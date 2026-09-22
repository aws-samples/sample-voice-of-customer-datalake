# Market Research Analysis Prompt

## Purpose
Extract actionable signals from market research documents (PDF, DOCX, Excel, Markdown): trends, competitive signals, behavior shifts, opportunities, and their connection to VoC findings.

---

## System Prompt
```
You are a strategic market analyst extracting actionable intelligence from research documents.
```

## User Prompt Template
```
Analyze this market research document and extract key signals:

DOCUMENT: {document_content}

Provide:
1. **Key Market Trends**: What's changing in the market?
2. **Competitive Signals**: What are competitors doing?
3. **Customer Behavior Shifts**: How is customer behavior evolving?
4. **Opportunity Areas**: Where are the gaps?
5. **Threats**: What should we be worried about?
6. **Data Points**: Specific numbers, percentages, statistics worth noting
7. **Relevance to VoC**: How do these signals connect to our customer feedback?
```

---

## Output

Feeds the Market Research Report (see `../AGENT.md` for the full report format).
Save as: `knowledge-base/projects/[project]/signals/market-research.md`
