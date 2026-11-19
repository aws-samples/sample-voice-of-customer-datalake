# Architecture Principles for the Skills Library

For the people who add or change a skill of the platform's skills library (`templates/orchestration/skills/`) and
map it to roles. Adapted from the source library's governance rules for coding-assistant skills: the loading model
is the same idea, progressive disclosure.

How a library skill reaches an agent:

- **Every session of a role** starts with the role's skills listed in its system prompt: each skill's name and its
  one-line description. That line is paid for on every session, used or not.
- **`read_skill(name)`** answers the full SKILL.md, only when the agent decides the description fits its step.
- **`read_skill(name, reference)`** answers one reference file, only when the SKILL.md sends the agent to it.

## Decision Gate 1: Should This Be a New Skill?

Check these in order before adding one.

### Gate 1.1: Scope Broadening
**Question**: Can an existing skill's scope be extended to cover this use case?

- Existing skill: anti-slop (detects AI hallucination and copy-paste patterns)
- New request: "Review generated code for quality slop"
- Decision: extend anti-slop, do not add a skill
- Why: a new skill adds a description line to every session of every role mapped to it

**Rule**: broadening a skill (a section or a reference) costs less than a new one. Broaden first.

### Gate 1.2: Audience Alignment
**Question**: Will most roles that use the parent skill also need this?

- Parent skill: code-review (every reviewer)
- New request: frontend quality checks (accessibility, performance, design slop)
- Decision: a peer skill (frontend-quality), mapped only to the roles that meet frontend code

**Rule**: if fewer than about 70% of the parent's uses need it, make a separate skill and map it narrowly; else
extend the parent.

### Gate 1.3: Pre-requisite Dependencies
**Question**: Is the skill only useful together with another?

**Rule**: then it is a section or reference of that other skill, not a skill of its own.

### Gate 1.4: Cost vs Benefit
**Question**: Is the value worth the listing line on every session of the roles it is mapped to?

| Proposal | Benefit | Verdict |
|---|---|---|
| frontend-quality | High (accessibility and design slop the reviewers miss) | ADD, mapped to the builder and the reviewers |
| a narrow data-validation skill | Low (a niche of one language) | DON'T ADD. Extend use-the-sdk or python-engineer |

## Decision Gate 2: Description Hygiene

The description is how an agent decides to read a skill: a vague or overlapping one is read when it should not be,
or never.

### Overlap Table
| Word | Skills | Risk | Action |
|---|---|---|---|
| "review" | code-review, red-team, security-audit, frontend-quality | HIGH | Each description says which change it is for |
| "quality" | code-review, frontend-quality, quality-gates, anti-slop | MEDIUM | Each has its own angle (frontend-quality = design, accessibility, performance) |
| "audit" | security-audit, aws-security, cicd-pipeline | MEDIUM | Application code, infrastructure code, workflow changes |

### Adding a New Skill: Description Audit
For each key word of the new skill's description:
1. Search the other descriptions for it.
2. If two or more have it, say in the new description (or theirs) which situation is whose.

**Example**: a "deploy-audit" skill would overlap security-audit and aws-security on "audit": its description
names the deployment targets it covers and points at those two for the rest.

## Decision Gate 3: Reference Load Patterns

### Pattern 1: Embedded Checklist (no references)
**When**: the checklist fits in the SKILL.md (under about 200 lines). One `read_skill` call is enough.

### Pattern 2: On-Demand Reference
**When**: a detailed checklist (200-400 lines) that only some tasks need. Example: code-review's per-language
checks and API verification, each read only when the change has that language or calls a third-party API. The
SKILL.md says when to read each.

### Pattern 3: Indexed Reference Suite
**When**: several related references (3+ files) an agent might read in part. Example: anti-slop's numbered
patterns, looked up by number.

| Complexity | Checklist Size | References | Load Pattern |
|---|---|---|---|
| Simple | < 200 lines | None | Embedded |
| Detailed | 200-400 lines | 1-2 files | On-Demand |
| Complex | 400+ lines | 3+ files | Indexed Suite |

Every reference a SKILL.md names must exist (the validator checks it), and every file is size-capped.

## Decision Gate 4: Instruction Effectiveness

If agents ignore a skill's instructions, do not add more. Shorten and clarify.

**Rule**: constraints work best when they are:
1. Hierarchical (MUST, then SHOULD, then MAY)
2. Justified ("because ...") for at least the MUST items
3. A table or a decision tree, not prose
4. Under 10 per skill

## Anti-Patterns to Avoid

### 1. Hidden Prerequisites
A skill that assumes knowledge its description does not state. **Fix**: state it, or fold the skill into the one
that teaches the prerequisite.

### 2. Overlapping Severity Labels
MUST and SHOULD mixed so the easy item gets fixed and the critical one forgotten. **Fix**: MUST = security, data
loss, broken behaviour; SHOULD = maintainability, performance. Separate sections.

### 3. Vague Descriptions
"For better code quality" overlaps half the library. **Fix**: name the change or the situation it is for.

### 4. Tools Mismatch
A skill that tells an agent to use a tool it does not have (a shell pipe, a web fetch, a deploy, git push).
**Fix**: write to the platform's tools; a step that needs something the agents lack is a person's, and the skill
says so.

### 5. Circular References
anti-slop says "run code-review after", code-review says "run anti-slop after". **Fix**: state the order once.

## Library Governance Checklist

When adding or changing a library skill:

- [ ] **Scope**: can an existing skill cover this? Broaden first, add last
- [ ] **Audience**: mapped only to the roles that meet its situations
- [ ] **Dependencies**: prerequisites stated
- [ ] **Description**: one line, specific, overlaps resolved
- [ ] **References**: the right load pattern; every named reference exists
- [ ] **Constraints**: hierarchical, justified, under 10
- [ ] **Tools**: only the platform's tools; nothing that conflicts with the platform rules
- [ ] **Provenance**: `source`, `license` and `adapted` in the front matter; a vendored source in
      THIRD-PARTY-LICENSES.md
