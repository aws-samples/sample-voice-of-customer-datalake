# Pre-Publication Checklists

Run through the relevant checklist before publishing.

## All Technical Content

### Content Quality
- [ ] Every claim backed by a number, mechanism, citation, or scoped assertion
- [ ] No weasel words (search: simply, just, robust, seamlessly, easy, straightforward, obviously)
- [ ] No AI slop phrases (search: "In today's", "It's worth noting", "Let's dive", "comprehensive guide")
- [ ] No AI slop words clustering (search: delve, pivotal, crucial, underscore, foster, garner, boasts, nestled, tapestry, testament)
- [ ] No filler phrases (search: "In order to", "Due to the fact", "It is important to note")
- [ ] All data is dated and sourced
- [ ] Missing data acknowledged, not hedged

### Voice and Grammar
- [ ] Active voice throughout (search for: "is configured", "was deployed", "are processed")
- [ ] Second person ("you", "your") for instructions
- [ ] No sentence exceeds 25 words
- [ ] No paragraph exceeds 4 sentences
- [ ] Sentence length varies (mix short and medium)
- [ ] No nominalizations (search: "make a decision", "perform an analysis")

### Punctuation
- [ ] Em dashes replaced with commas, colons, semicolons, or periods
- [ ] Oxford comma used consistently
- [ ] Hyphens for compound modifiers
- [ ] En dashes for ranges

### Structure
- [ ] Headings are action-oriented and scannable
- [ ] No heading levels skipped (H2 -> H4)
- [ ] Tables for comparisons, lists for steps
- [ ] Code snippets have language identifiers
- [ ] No real credentials or secrets in examples

### Final Read
- [ ] Read every sentence aloud. Rewrite anything that causes stumbling
- [ ] A reader unfamiliar with the topic can follow the content
- [ ] The document answers "why should I care?" in the first two paragraphs
- [ ] Every section earns its place. No filler sections

## README Checklist

- [ ] First paragraph: what it does (one sentence)
- [ ] Second paragraph: why someone would use it
- [ ] Prerequisites listed before install steps
- [ ] Install steps tested on a clean machine
- [ ] "How to run" with copy-paste commands
- [ ] "How to test" with copy-paste commands
- [ ] No sections copied from a template that don't apply
- [ ] No badge soup (>5 badges is clutter)

## Blog Post Checklist

- [ ] Title: 60-70 characters, action-oriented, includes primary technology
- [ ] TL;DR box: 50-80 words, immediately after title
- [ ] Introduction opens with the problem or business context
- [ ] "What you'll need" prerequisites listed
- [ ] Architecture diagram present and walked through in prose
- [ ] Code snippets: max 10-20 lines each, language identifiers, no secrets
- [ ] Full code linked to companion repo
- [ ] Troubleshooting table: 3-4 common issues (Issue, Cause, Fix)
- [ ] Clean Up section with resource deletion steps
- [ ] No "In this blog post, we will..." opening
- [ ] No "In conclusion" restating everything

## API Documentation Checklist

- [ ] Every endpoint documented: method, path, parameters, response
- [ ] Request/response examples for every endpoint
- [ ] Error codes and their meanings listed
- [ ] Authentication requirements stated upfront
- [ ] Rate limits documented
- [ ] Versioned (date or version number)
- [ ] Changelog for breaking changes
