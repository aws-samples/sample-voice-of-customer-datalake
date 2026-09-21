# Persona Generation Prompt Chain

## Purpose
Generate data-driven synthetic personas from VoC feedback using a 3-step LLM chain.

> **Upstream:** ported from the [voc-datalake platform](https://github.com/aws-samples/sample-voice-of-customer-datalake)'s
> [`lambda/api/prompts/persona-generation.json`](https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/voc-datalake/lambda/api/prompts/persona-generation.json).
> Treat that JSON as the source of truth if the two drift.

---

## Step 1: Research Analysis

### System Prompt
```
You are a senior UX researcher specializing in Voice of Customer analysis and persona development.

Your task is to identify distinct user segments from real customer feedback. You must:
1. Be rigorously data-driven - cite specific reviews and quotes
2. Look for behavioral patterns, not just demographics
3. Identify emotional drivers and underlying motivations
4. Consider customer journey stages
5. Pay attention to urgency levels and sentiment patterns
6. Look for workarounds and coping mechanisms
7. Identify tech savviness signals from language used
```

### User Prompt Template
```
Analyze this customer feedback dataset and identify exactly {persona_count} distinct user segments.

{feedback_stats}
{custom_instructions}

## CUSTOMER FEEDBACK DATA:
{feedback_context}

---

For EACH of the {persona_count} segments, provide detailed analysis:

1. **Segment Name**: A memorable, descriptive name
2. **Size Estimate**: What % of feedback represents this segment?
3. **Demographic Signals**: Age hints, occupation hints, location hints (only if evident)
4. **Defining Characteristics**: What makes this segment unique?
5. **Goals & Motivations**: What are they trying to achieve? Why?
6. **Pain Points**: What frustrates them? (cite specific reviews by number)
7. **Behaviors**: How do they interact? What tools do they mention?
8. **Emotional State**: How do they feel? What language reveals this?
9. **Tech Savviness**: Low/Medium/High based on language and expectations
10. **Representative Quotes**: Copy 3-4 EXACT quotes from the feedback
11. **Journey Stage**: awareness/consideration/purchase/usage/support/advocacy
12. **Workarounds**: How do they currently cope with problems?
13. **Context Clues**: When/where do they use the product? Time constraints?

Be specific and ground every insight in actual feedback data.
```

---

## Step 2: Persona Synthesis

### System Prompt
```
You are a UX researcher creating comprehensive persona profiles following an 8-section template.

Each persona must:
- Feel like a real, specific person with a name and story
- Be grounded in actual customer quotes (use REAL quotes only)
- Have actionable insights for product teams
- Include realistic scenarios
- Have appropriate confidence levels based on data support

CRITICAL: Output ONLY valid JSON. No markdown, no explanation, just the JSON array.
```

### User Prompt Template
```
Based on the segment analysis, create exactly {persona_count} comprehensive persona profiles.

## PREVIOUS ANALYSIS:
{previous_step_output}

## ORIGINAL FEEDBACK DATA (for accurate quotes):
{feedback_sample}
{custom_instructions}

---

Create exactly {persona_count} personas with ALL 8 SECTIONS. Output ONLY valid JSON:

[
  {
    "name": "First Last",
    "tagline": "The [Descriptive Label] - one compelling sentence",
    "confidence": "high|medium|low",
    "feedback_count": 12,
    
    "identity": {
      "age_range": "30-45",
      "location": "Urban, US",
      "occupation": "Specific job title",
      "income_bracket": "$100k-150k or null",
      "education": "Bachelor's degree or null",
      "family_status": "Married with kids or null",
      "bio": "2-3 sentence background story that feels real and specific."
    },
    
    "goals_motivations": {
      "primary_goal": "Their main objective in one clear sentence",
      "secondary_goals": ["Goal 2", "Goal 3"],
      "success_definition": "What success looks like to them",
      "underlying_motivations": ["Deeper emotional driver 1", "Driver 2"]
    },
    
    "pain_points": {
      "current_challenges": ["Challenge 1 with specific context", "Challenge 2"],
      "blockers": ["What specifically prevents them from achieving goals"],
      "workarounds": ["How they currently cope with the problem"],
      "emotional_impact": "How these frustrations make them feel"
    },
    
    "behaviors": {
      "current_solutions": ["How they solve the problem now"],
      "tools_used": ["Tool 1", "Tool 2"],
      "activity_frequency": "Daily|Weekly|Monthly|As needed",
      "tech_savviness": "low|medium|high",
      "decision_style": "Data-driven|Gut instinct|Consensus-seeking|Research-heavy"
    },
    
    "context_environment": {
      "usage_context": "When and where they typically engage",
      "devices": ["iPhone", "MacBook"],
      "time_constraints": "How much time they have",
      "social_context": "Their work/social environment",
      "influencers": ["Who influences their decisions"]
    },
    
    "quotes": [
      {"text": "Exact quote from feedback", "context": "Source/situation"},
      {"text": "Another real quote", "context": "Context"}
    ],
    
    "scenario": {
      "title": "Short descriptive title",
      "narrative": "3-4 sentence story showing them in a realistic situation.",
      "trigger": "What triggers this scenario",
      "outcome": "What they hope to achieve"
    },
    
    "supporting_evidence": ["Review #X", "Review #Y", "Review #Z"]
  }
]
```

---

## Step 3: Validation

### System Prompt
```
You are a critical reviewer ensuring personas are grounded in real data.
Validate claims, verify quotes, and ensure actionability.
```

### User Prompt Template
```
Review and validate these personas against the original feedback data.

## PERSONAS TO VALIDATE:
{previous_step_output}

## ORIGINAL FEEDBACK STATISTICS:
{feedback_stats}

## SAMPLE FEEDBACK FOR VERIFICATION:
{feedback_sample}

---

For each persona:
1. **Data Support**: Is this persona supported by multiple feedback items?
2. **Quote Accuracy**: Are quotes accurate or appropriately paraphrased?
3. **Consistency**: Any contradictions in the profile?
4. **Actionability**: Can product teams act on these insights?
5. **Confidence**: HIGH (5+ reviews) / MEDIUM (2-4 reviews) / LOW (1 review or inferred)

Output the FINAL validated personas as a JSON array with any refinements.
```
