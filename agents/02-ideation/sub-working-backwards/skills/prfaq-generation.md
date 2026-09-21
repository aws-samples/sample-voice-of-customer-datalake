# PR/FAQ Generation Prompt Chain

## Purpose
Generate Amazon Working Backwards PR/FAQ documents using a 4-step LLM chain grounded in customer data and personas.

> **Upstream:** ported from the [voc-datalake platform](https://github.com/aws-samples/sample-voice-of-customer-datalake)'s
> [`lambda/api/prompts/prfaq-generation.json`](https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/voc-datalake/lambda/api/prompts/prfaq-generation.json).
> Treat that JSON as the source of truth if the two drift.

---

## Step 1: Customer Thinking

### System Prompt
```
You are thinking deeply about customers and their needs.
Channel the voice of real customers based on the feedback data.
```

### User Prompt Template
```
Think deeply about what customers really want and need.

FEATURE IDEA: {feature_idea}

USER PERSONAS:
{personas_context}

CUSTOMER FEEDBACK:
{feedback_context}

Answer these questions from the customer's perspective:
1. What problem does this solve for me?
2. Why should I care about this?
3. How will this make my life better?
4. What would make me skeptical?
5. What would delight me about this?
```

---

## Step 2: Press Release

### System Prompt
```
You are writing an Amazon-style press release announcing a new feature.
Write as if the feature is already launched and successful. Be specific and customer-focused.
```

### User Prompt Template
```
Write a press release for this feature.

Customer insights:
{previous_step_output}

The press release should include:
1. **Headline**: Attention-grabbing, customer-benefit focused
2. **Subheadline**: Expand on the headline
3. **City, Date**: [City, Date]
4. **Opening Paragraph**: Who, what, when, where, why
5. **Problem Paragraph**: The customer problem being solved
6. **Solution Paragraph**: How the feature solves it
7. **Quote from Leadership**: Vision and commitment
8. **Customer Quote**: From one of the personas
9. **How It Works**: Brief explanation
10. **Call to Action**: How to get started

Write in professional press release style.
```

---

## Step 3: Customer FAQ

### System Prompt
```
You are anticipating customer questions about a new feature.
Think like a skeptical but interested customer.
```

### User Prompt Template
```
Generate the Customer FAQ section.

Press Release:
{previous_step_output}

Create 5-7 customer FAQs covering:
- How does this work?
- How much does it cost?
- When is it available?
- What if I have problems?
- How is this different from alternatives?
- Questions specific to each persona

Format as Q&A pairs.
```

---

## Step 4: Internal FAQ

### System Prompt
```
You are anticipating internal stakeholder questions.
Think like executives, engineers, and business partners.
```

### User Prompt Template
```
Generate the Internal FAQ section.

Press Release and Customer FAQ:
{previous_step_output}

Create 5-7 internal FAQs covering:
- Why now? Why this?
- What are the technical requirements?
- What are the risks?
- How do we measure success?
- What resources are needed?
- What's the timeline?

Format as Q&A pairs.
```

---

## Final Assembly

After all 4 steps, combine into a single document with sections:
1. Press Release
2. Customer FAQ
3. Internal FAQ

Save as `knowledge-base/projects/{project}/ideation/prfaq.md`
