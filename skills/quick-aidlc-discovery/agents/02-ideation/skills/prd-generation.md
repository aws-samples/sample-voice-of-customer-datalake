# PRD Generation Prompt Chain

## Purpose
Generate Product Requirements Documents using a 3-step LLM chain grounded in customer problems and persona needs.

> **Upstream:** ported from the [voc-datalake platform](https://github.com/aws-samples/sample-voice-of-customer-datalake)'s
> [`lambda/api/prompts/prd-generation.json`](https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/voc-datalake/lambda/api/prompts/prd-generation.json).
> Treat that JSON as the source of truth if the two drift.

---

## Step 1: Problem Analysis

### System Prompt
```
You are a product manager analyzing customer problems to define product requirements.
Be specific, data-driven, and focus on measurable outcomes.
```

### User Prompt Template
```
Analyze the customer feedback and personas to deeply understand the problem space.

FEATURE IDEA: {feature_idea}

USER PERSONAS:
{personas_context}

CUSTOMER FEEDBACK:
{feedback_context}

Provide a thorough problem analysis:
1. What are the core problems customers are experiencing?
2. How do these problems affect different personas?
3. What is the business impact of not solving these problems?
4. What are the root causes?
5. What constraints should we consider?
```

---

## Step 2: Solution Design

### System Prompt
```
You are a senior product manager designing solutions that address real customer needs.
Focus on feasibility, impact, and user-centered design.
```

### User Prompt Template
```
Based on the problem analysis, design a solution.

Previous analysis:
{previous_step_output}

Define:
1. **Solution Overview**: High-level description
2. **Key Features**: 3-5 core features with descriptions
3. **User Stories**: For each persona, write 2-3 user stories
4. **Success Metrics**: How will we measure success?
5. **Risks & Mitigations**: What could go wrong?
```

---

## Step 3: PRD Document

### System Prompt
```
You are creating a professional Product Requirements Document.
Be comprehensive but concise. Use clear formatting.
```

### User Prompt Template
```
Create a complete PRD document.

Previous analysis and solution design:
{previous_step_output}

Generate a PRD with these sections:
1. **Executive Summary**
2. **Problem Statement**
3. **Goals & Success Metrics**
4. **User Personas** (reference the generated personas)
5. **Requirements**
   - Functional Requirements (prioritized P0/P1/P2)
   - Non-Functional Requirements
6. **User Stories & Acceptance Criteria**
7. **Out of Scope**
8. **Dependencies & Risks**
9. **Timeline Considerations**

Format as a professional document in Markdown.
```

---

## Final Output

Save as `knowledge-base/projects/{project}/ideation/prd.md`
