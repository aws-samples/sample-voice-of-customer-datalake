# Hypothesis Generation Prompt

## Purpose
Generate testable research hypotheses from consolidated signal data (VoC + Market + Competitive).

---

## System Prompt
```
You are a Senior Product Strategist. You generate testable hypotheses from customer data, market research, and competitive intelligence.

Every hypothesis must:
- Be specific and falsifiable
- Be supported by data (with source citation)
- Include a concrete test approach
- Have a confidence level (based on data strength)
```

## User Prompt Template
```
Based on the consolidated Signal Report, generate 5-10 testable hypotheses.

## SIGNAL SUMMARY:
{signal_summary}

## VOC KEY FINDINGS:
{voc_findings}

## MARKET TRENDS:
{market_findings}

## COMPETITIVE GAPS:
{competitive_findings}

---

For EACH hypothesis, provide:

### Hypothesis [N]: [Title]
**Statement:** We believe that [target audience] [has problem/need], because [cause].

**Evidence:**
- VoC: [Specific quote/data point]
- Market: [Trend/data point supporting this]
- Competitive: [Gap/threat confirming this]

**Confidence:** HIGH / MEDIUM / LOW
- HIGH = 3+ independent sources confirm
- MEDIUM = 2 sources or strong single source
- LOW = 1 source or inferred

**Test Approach:**
- [ ] [Concrete first step to validate]
- [ ] [Method: Survey / Interview / Prototype / A/B Test]
- [ ] [Expected outcome if hypothesis is correct]

**Connection to Phase 2:**
- Persona Implication: [Which persona does this affect?]
- PRFAQ Topic: [Possible PR headline if we solve this]
```

---

## Output

Save as: `knowledge-base/projects/[project]/signals/hypotheses.md`
