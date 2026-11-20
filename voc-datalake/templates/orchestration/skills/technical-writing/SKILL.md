---
name: technical-writing
description: "Sets technical writing rules for docs, READMEs, pull request descriptions, comments and prose: active voice, 25-word sentences, banned and weasel words, punctuation, evidence-backed claims, scannable structure. Read it when writing or reviewing text."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/technical-writing"
license: MIT
adapted: "The spec-loader step reads VOICE.md and the repository's writing rules with read_file. The grep scan became a list of patterns to look for (the writers run no command). The public-content section keeps its rules without the unvendored narrative-writing dependency, and the blog-skill reference is dropped. Personal data from customer feedback is never quoted. Findings and fixes are the author's own text; the report goes in the finish; description reworded for Claude 5.5 skill discovery"
---

Write or review the technical text your task names: a pull request description, a triage, notes, a doc.

## Step 0: Load Project Specs

If the repository has a VOICE.md, read it with `read_file`; else the built-in defaults in this skill.

VOICE.md overrides: `banned_words`, `banned_phrases`, `sentence_max_words`, `paragraph_max_sentences`, `heading_max_depth`, `dash_policy`. Cite VOICE.md in findings (e.g., *"banned word 'robust' per VOICE.md:14"*).

## Step 1: Detect Content Type

| Type | Files | Focus |
|---|---|---|
| README | README.md, CONTRIBUTING.md | Answers: what, why, how to run, how to test |
| API docs | docs/*.md | Version-dated, code examples verified |
| Pull request description | the body you open the pull request with | What changed, why, how it was tested, what a reviewer should look at |
| Inline comments | *.py, *.ts, *.js | Explain WHY not WHAT |
| Commit messages | the message you write (the committer's) | Imperative mood, <72 chars, type prefix |

Read the repository's notes for contributors (`CONTRIBUTING.md`, a pull request template) for its writing rules: a
pull request description follows the repository's template when it has one.

## Step 2: Voice and Tone

- **Active voice, second person.** "You configure the bucket policy", not "The bucket policy is configured"
- **Answer first, explain second.** Lead with the conclusion, then give context
- **Confident and direct.** No hedging, no apologies, no "it should be noted"
- **Start with the customer.** Lead with the customer problem, not your solution. The first paragraph makes the reader feel the pain before offering the cure
- **No ampersands.** Write "and" instead. Always
- **No emoji of any kind.** Strip all emoji from technical content

## Step 2b: The "So What?" Test

Every paragraph must answer two questions: why should the reader care, and what action follows?

Apply this test during drafting and revision:

1. Read each paragraph in isolation
2. Ask: "So what? What does the reader do with this information?"
3. Cut or rewrite paragraphs that fail this test
4. If a paragraph informs without directing, add the action or merge it into a paragraph that does

A paragraph that passes: states a fact, explains the consequence, and points toward a decision or action. A paragraph that fails: restates background the reader already knows or describes without purpose.

## Step 3: Sentence and Paragraph Rules

- **Sentences: 25 words max.** If you need a breath in the middle, split it
- **Paragraphs: 4 sentences max.** White space helps readers scan
- **Vary length.** Mix short sentences (5-8 words) with medium ones (15-20). Monotonous length sounds robotic
- **One idea per paragraph.** New topic = new paragraph

## Step 4: Banned Words

Full replacement tables with examples: `references/style-guide.md`.

| Category | Examples | Action |
|---|---|---|
| Weasel words | simply, just, easy, obviously, robust, scalable, nearly, arguably, virtually, generally, fairly, somewhat, probably, hopefully | Delete or replace with specifics |
| Overused hedges | might (overused), could potentially | State what happens or state uncertainty directly |
| Empty intensifiers | very, really, extremely, highly | Replace: "very fast" → "sub-millisecond" |
| Vague quantities | some, many, most, several, numerous | Use actual numbers |
| Hedge verbs | helps, enables, allows, facilitates | State the direct action |
| Marketing fluff | best-in-class, cutting-edge, state-of-the-art | Delete entirely |
| AI slop phrases | "In today's rapidly evolving...", "Let's dive in..." | Delete entirely |
| AI slop words | delve, pivotal, crucial, underscore, foster, garner, boasts, nestled, tapestry, testament, serves as, stands as | Delete or state the fact plainly (3+ in one doc is a pattern, see `references/style-guide.md`) |
| Filler | "In order to", "Due to the fact that" | Shorten: "To", "Because" |
| Nominalizations | "make a decision", "perform an analysis" | Use the verb: "decide", "analyze" |
| Ampersands | and (written as &) | Write "and" in full |

## Step 5: Punctuation and Grammar

### Punctuation
- No em dashes. Use commas, periods, colons, or parentheses
- No ampersands. Write "and" in all contexts
- Oxford comma always (A, B, and C)
- Hyphens for compound modifiers (well-architected, real-time)
- En dashes for ranges (pages 10-15, 2024-2025)
- When in doubt, use a period and start a new sentence

### Grammar
Full rules with examples: `references/style-guide.md`.

- **Cut adverbs.** If you need "very", your adjective is too weak
- **Cut hedge words.** "Might", "could potentially", "it seems like"
- **Specific verbs.** "Use" → "configure", "deploy", "invoke", "attach"
- **No nominalizations.** "Make a decision" → "Decide"
- **its vs. it's:** "Its configuration" (possessive), "It's a service" (it is)
- **that vs. which:** "The bucket that stores logs" (restrictive, no comma), "The bucket, which stores logs, is in us-east-1" (non-restrictive, with comma)
- **fewer vs. less:** "Fewer errors" (countable), "Less latency" (uncountable)

## Step 6: Evidence and Data

- Every claim needs a source: docs, benchmarks, or your own testing
- State the conditions: "120ms latency under 1,000 concurrent connections in us-east-1"
- Date your data: "As of March 2026" or "Tested on 2026-03-15"
- If you lack data, say so. "We did not benchmark this" beats hedging with weasel words
- Never fabricate numbers
- Distinguish your measurements from vendor claims
- Round appropriately: latency to nearest ms, cost to 2 decimal places

### Attribution Format

Use this format for all data citations:

- Growth or change: "grew 23% (Q4 2025 vs Q4 2024, source: internal analytics)"
- Survey or sample data: "78% (n=500)" not "78%"
- Always include the comparison period for percentage changes
- Always include sample size for survey results
- Name the source explicitly: "source: AWS Cost Explorer", "source: CloudWatch metrics"
- Customer feedback is cited by its feedback ids only: never quote its text, and never write a name, an e-mail
  address or a handle from it

## Step 7: Structure

### Headings
- Action-oriented: "Configure the S3 bucket" not "S3 Bucket Configuration"
- Scannable: a reader understands the doc from headings alone
- Hierarchical: H2 for major sections, H3 for subsections. No skipping levels

### Topic Sentences

Topic sentences carry the argument. A reader skimming only topic sentences gets the full story.

Write topic sentences as assertions:
- Good: "Customer churn increased 15% after the pricing change"
- Bad: "This section discusses churn"

Every paragraph opens with a claim, a finding, or a direction. Never open with "This section..." or "The following..."

### Bias for Action

End sections with clear next steps or recommendations. Do not inform without directing action.

Every major section (H2) closes with one of:
- A concrete next step ("Run the migration script before proceeding")
- A recommendation ("Choose Option A for workloads under 10,000 requests per second")
- A decision prompt ("Evaluate your throughput needs against the cost table above")

### Lists vs Tables
- **Lists:** Sequential steps, related items, tips
- **Tables:** Comparisons, multi-field data, troubleshooting

### Code Snippets
- Language identifier on every code fence
- File name comment on line 1 (if applicable)
- Inline comments only on non-obvious lines
- No real credentials, account IDs, or secrets
- Max 10-20 lines per snippet in docs. Full code in separate files

## Public Content (when the audience is public)

When VOICE.md sets `audience=public`, or the text is for a public audience (a public repository's README or docs),
also apply:
- Service naming conventions (full name on first mention, short form after)
- Legal guardrails (no security guarantees, no "ensure" in security contexts)
- Opening hook formulas (problem-first, never "In this post we will...")
- SEO guidelines (primary keyword in title and first paragraph, action verbs in headings)

Flag violations under a separate "Public Content" category.

## Step 8: Scan

Check the text (your own draft before you send it, or the text you review) for these patterns. A role that runs
code can search files for them with `run` and `grep -inE`; the writers read for them.

| Check | Patterns (case-insensitive) |
|---|---|
| Weasel words | simply, just, easy, straightforward, obviously, clearly, robust, scalable, seamless, leverage, utilize, nearly, arguably, virtually, generally, fairly, somewhat, probably, hopefully |
| Overused hedges | might, could potentially |
| Empty intensifiers | very, really, extremely, highly |
| AI slop phrases | in today's, it's worth noting, let's dive, comprehensive guide, in this blog post, in this section, as we can see |
| AI slop words (3+ in one text is a pattern) | delve(s/d), pivotal, crucial, underscore(s/d), foster(ing/ed), garner(ed/ing), boast(s), nestled, tapestry, testament, meticulous, intricate, interplay, serves as, stands as, functions as |
| Filler | in order to, due to the fact, it is important to note, at the end of the day, as a matter of fact, it goes without saying |
| Passive voice indicators | is/are/was/were/been/being + configured, deployed, processed, created, used, implemented, designed |
| Em dashes | `—` |
| Ampersands (outside code blocks) | `&` |
| Marketing fluff | best-in-class, cutting-edge, state-of-the-art, world-class, next-generation, game-changing, revolutionary, industry-leading |
| Emoji | any character in U+1F300-U+1FAFF or U+2600-U+27BF |

Also manually check:
- Sentences >25 words (read each paragraph, flag run-on sentences)
- Paragraphs >4 sentences
- Missing evidence for claims (numbers without sources, performance claims without conditions)
- Headings that describe nouns instead of actions
- Paragraphs that fail the "So What?" test
- Topic sentences that describe instead of assert
- Sections that end without a next step or recommendation

Pre-publication checklist: `references/checklists.md`.

## Step 9: Report

A review of someone else's text is findings; for your own text, put the summary in your finish.

```
## Technical Writing Review: X issues found

### Summary
| Category | Issues |
|---|---|
| Weasel words | X |
| AI slop phrases | X |
| Passive voice | X |
| Sentence length | X |
| Missing evidence | X |
| Punctuation | X |
| Structure | X |
| So What? failures | X |
| Ampersands | X |
| Emoji | X |

### Quality Metrics
| Metric | Target | Actual |
|---|---|---|
| Weasel Word Ratio | 0 per 1000 words | X |
| Passive Voice | <10% of sentences | X% |
| Sentence Avg Length | <20 words | X words |
| Data-to-Adjective Ratio | >2:1 | X:1 |
| AI Slop Pattern Count | 0 | X |

### Findings
| # | Category | File:Line | Issue | Fix |
|---|----------|-----------|-------|-----|
```

## Step 9.5: Self-Review

Before delivering the final text, perform this check:

1. Read the fixed text aloud. Flag anything that causes stumbling
2. Check: could a smart newcomer follow this without a glossary?
3. Verify every section ends with a clear action or recommendation
4. Confirm every topic sentence works as a standalone assertion
5. Run the "So What?" test on the opening three paragraphs

If any sentence trips you when reading aloud, rewrite it. Shorter is almost always better.

## Step 10: Fix (your own text)

1. Replace weasel words with specifics or delete
2. Delete AI slop phrases and filler
3. Rewrite passive voice to active
4. Split sentences >25 words
5. Add evidence for unsupported claims
6. Fix punctuation (em dashes, ampersands, missing Oxford commas)
7. Rewrite paragraphs that fail the "So What?" test
8. Rewrite topic sentences that describe instead of assert
9. Add next steps to sections that inform without directing
10. Remove all emoji
11. Read fixes aloud. Rewrite anything that causes stumbling
