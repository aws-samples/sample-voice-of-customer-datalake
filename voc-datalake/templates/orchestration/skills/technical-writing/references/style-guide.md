# Technical Writing Style Guide

Detailed rules with examples. Referenced from SKILL.md.

## Banned Words: Full Replacement Tables

### Weasel Words

| Banned | Why It Fails | Replace With |
|---|---|---|
| simply, just | Dismisses complexity | Delete, or state the actual steps |
| easy, straightforward | Subjective | State prerequisite knowledge and time |
| obviously, clearly | Condescending | Delete |
| robust, scalable, seamless | Meaningless without evidence | State the metric: "handles 10,000 req/sec" |
| very, really, extremely, highly | Empty intensifiers | Precise term: "very fast" -> "sub-millisecond" |
| some, many, most, several, numerous | Vague quantities | Actual numbers or percentages |
| helps, enables, allows, facilitates | Hedge verbs | Direct action: "enables you to deploy" -> "you deploy" |
| best-in-class, world-class, cutting-edge | Marketing fluff | Delete, or cite a benchmark |
| arguably, generally, typically | Escape hatches | State the condition or cite the source |
| leverage | Corporate jargon | "use" |

### AI Slop Phrases (ban entirely)

These are hallmarks of AI-generated text. Delete on sight:

```
"In today's rapidly evolving landscape..."
"It's worth noting that..."
"Leveraging the power of..."
"Let's dive in / dive deep..."
"This comprehensive guide will..."
"In conclusion, [restates everything]"
"Whether you're a beginner or expert..."
"In this blog post, we will..."
"In this section, we will..."
"As we can see..."
"It is important to note that..."
"At the end of the day..."
"Due to the fact that..." (use "because")
"In order to..." (use "to")
"As a matter of fact..."
"It goes without saying..."
"Without further ado..."
"Before we begin..."
"First and foremost..."
```

### AI Slop Words (single-word tells)

Isolated instances can be legitimate. Three or more in one document is a pattern. Source: see `references/sources.md`.

| Category | Words |
|---|---|
| Significance inflation | crucial, pivotal, vital, key role, testament, underscore(s), highlight(s) importance |
| Vague intensity | intricate, meticulous, profound, vibrant, rich, diverse array |
| Hedge transitions | delve, foster(ing), garner, bolster(ed), align with |
| Copula avoidance | serves as, stands as, functions as, operates as, boasts, showcases, exemplifies |
| Scene-setting cliches | nestled, landscape, tapestry, interplay, enduring |
| Credibility without a source | "industry reports", "experts argue", "some critics argue", "observers have cited" |

### Filler Phrases

| Filler | Replace With |
|---|---|
| "It is important to note that X" | State X directly |
| "In order to" | "To" |
| "Due to the fact that" | "Because" |
| "At this point in time" | "Now" |
| "A large number of" | State the number |
| "In the event that" | "If" |
| "Prior to" | "Before" |
| "Subsequent to" | "After" |
| "With regard to" | "About" or "For" |
| "Make a decision" | "Decide" |
| "Perform an analysis" | "Analyze" |
| "Conduct a review" | "Review" |

## Voice Rules

### Active Voice

```markdown
# PASSIVE (rewrite)
"The bucket policy is configured by the administrator."
"The deployment was triggered by the pipeline."
"The data is processed in real time."

# ACTIVE (correct)
"The administrator configures the bucket policy."
"The pipeline triggers the deployment."
"The service processes data in real time."
```

For instructions, use second person:
```markdown
# PASSIVE
"The configuration file should be updated."

# ACTIVE
"Update the configuration file."
# or
"You update the configuration file."
```

### Lead With the Conclusion

```markdown
# BURIED (rewrite)
"After considering the options and evaluating the tradeoffs between
latency and throughput, we recommend using DynamoDB for this use case."

# DIRECT (correct)
"Use DynamoDB for this use case. It offers the best balance of
latency (single-digit ms) and throughput (on-demand scaling)."
```

## Grammar Rules

### Common Mistakes

| Rule | Correct | Incorrect |
|---|---|---|
| its vs. it's | "Its configuration" (possessive); "It's a managed service" (it is) | Mixing them up |
| that vs. which | "The bucket that stores logs" (restrictive, no comma); "The bucket, which stores logs, is in us-east-1" (non-restrictive, with comma) | "which" without comma for restrictive |
| affect vs. effect | "This affects latency" (verb); "The effect is measurable" (noun) | Swapping them |
| fewer vs. less | "Fewer errors" (countable); "Less latency" (uncountable) | "Less errors" |
| ensure vs. insure | Prefer "verify the policy is attached". "Insure" only for insurance | either word where "verify" or "check" is meant |
| comprise vs. compose | "The system comprises three services" | "is comprised of" |

### Nominalizations

Turn noun phrases back into verbs:

| Nominalization | Verb |
|---|---|
| Make a decision | Decide |
| Perform an analysis | Analyze |
| Conduct a review | Review |
| Provide assistance | Help |
| Give consideration to | Consider |
| Make an improvement | Improve |
| Carry out an investigation | Investigate |

### Specific Verbs Over Generic Ones

| Generic | Specific Alternatives |
|---|---|
| use | configure, deploy, invoke, provision, attach |
| make | build, create, generate, assemble |
| do | execute, run, process, calculate |
| get | fetch, retrieve, query, download |
| put | store, write, upload, insert |
| change | update, modify, patch, migrate |

## Punctuation Details

### Em Dashes: Replacement Guide

| Em Dash Function | Replace With | Example |
|---|---|---|
| Parenthetical aside | Commas or parentheses | "The service, which launched last year, handles 10K req/sec" |
| Introducing explanation | Colon | "There is one requirement: you need an IAM role" |
| Adding contrast | Semicolon or period | "Latency dropped; throughput stayed flat." |
| Listing | Colon + list | "Three services: Lambda, S3, and DynamoDB." |
| Dramatic pause | Period (new sentence) | "We tested every configuration. Nothing worked." |

### Hyphens, En Dashes, Em Dashes

- **Hyphen (-):** Compound modifiers ("well-architected framework", "real-time processing")
- **En dash (-):** Ranges ("pages 10-15", "2024-2025"). Note: in plain text, a hyphen is acceptable for ranges
- **Em dash:** Avoid. Replace as shown above

## Data Presentation Rules

### When You Have Data
- Cite the source. Every number needs one: official docs, benchmarks, or your testing
- State the conditions. "Latency averaged 120ms under 1,000 concurrent connections in us-east-1"
- Date your data. "As of March 2026" or "Tested on 2026-03-15"
- Use tables for comparisons. Never bury numbers in prose
- Distinguish your measurements from vendor claims

### When You Lack Data
- Say so. "We did not benchmark this configuration" beats hedging
- Never fabricate numbers
- Scope your claims. "In our testing with 500 concurrent users..." not "This scales to any workload"
- Link to where the reader can find the data

### Rounding
- Latency: nearest millisecond
- Cost: two decimal places
- Percentages: one decimal place
- Sample sizes: always include. "78% (n=500)" not "78%"
- Consistent units: do not mix ms and seconds, MB and GB in the same comparison

## Heading Rules

### Action-Oriented Headings

```markdown
# NOUN-BASED (rewrite)
## S3 Bucket Configuration
## Authentication Overview
## Error Handling Strategy

# ACTION-BASED (correct)
## Configure the S3 Bucket
## Set Up Authentication
## Handle Errors
```

### Heading Hierarchy
- H1: Document title only (one per document)
- H2: Major sections
- H3: Subsections within H2
- H4: Rarely needed. If you need H4, your structure may be too deep
- Never skip levels (H2 -> H4)
