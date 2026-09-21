# Signal Analysis Prompt Chain

## Purpose
Analyze raw customer feedback data to extract structured insights: sentiment, categories, urgency, root causes, and persona signals.

> **Upstream:** mirrors the [voc-datalake platform](https://github.com/aws-samples/sample-voice-of-customer-datalake)'s
> processor enrichment prompt ([`lambda/processor/handler.py`](https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/voc-datalake/lambda/processor/handler.py))
> and its [`schemas/feedback-event.schema.json`](https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/voc-datalake/schemas/feedback-event.schema.json)
> field names. Treat the platform as the source of truth if the two drift.

## Per-Item Analysis Prompt

### System Prompt
```
You are an expert customer experience analyst. Analyze feedback and return ONLY valid JSON.
- Be objective and accurate
- Never invent PII
- Use exact enum values specified
- Keep summaries under 500 chars
```

### User Prompt Template
```
Analyze this feedback and return JSON:

Source: {source_platform} | Channel: {source_channel} | Rating: {rating}
Text: {text}

Available categories: {categories_list}

Return ONLY this JSON structure:
{
  "category": "one of the categories above",
  "subcategory": "more specific classification",
  "journey_stage": "awareness|consideration|purchase|usage|support|advocacy",
  "sentiment_label": "positive|neutral|negative|mixed",
  "sentiment_score": -1.0 to 1.0,
  "urgency": "low|medium|high",
  "impact_area": "product|operations|cx|tech|pricing|brand|legal|other",
  "problem_summary": "Brief description of the issue (max 500 chars)",
  "problem_root_cause_hypothesis": "Potential root cause",
  "direct_customer_quote": "Most impactful quote from the text",
  "persona": "Inferred customer persona type"
}
```

## Batch Aggregation Prompt

### System Prompt
```
You are a data analyst summarizing customer feedback metrics. Be precise and data-driven.
```

### User Prompt Template
```
Summarize these {count} analyzed feedback items:

{aggregated_data}

Provide:
1. **Volume Overview**: Total count, by source, by day
2. **Sentiment Distribution**: % positive/negative/neutral/mixed, average score
3. **Top Categories**: Ranked by frequency
4. **Urgency Breakdown**: Count by low/medium/high
5. **Emerging Patterns**: New or growing issues (week-over-week)
6. **Key Quotes**: 5 most impactful customer quotes
7. **Recommended Focus Areas**: Top 3 areas needing attention
```

