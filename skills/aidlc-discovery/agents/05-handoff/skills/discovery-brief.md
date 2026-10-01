# Discovery Brief — Skill (Handoff)

## Purpose

Write the single document that carries a Discovery engagement into AI-DLC.
The team starts AI-DLC with this file, in a profile that skips AI-DLC's own
Ideation phase, and AI-DLC Requirements Analysis reads it as its primary input.

Supported AI-DLC: **2.10.0 or later** (`awslabs/aidlc-workflows`). The brief
relies on AI-DLC's single-document input (UTF-8 text, at most 200,000
characters), the `workshop` and `classic` profiles, and the team-knowledge
folder `aidlc/knowledge/aidlc-product-agent/`.

## Required Artifacts

Handoff refuses to write the brief until these exist under
`discovery/[project]/`. List what is missing and offer to run that phase.

| Artifact | Path |
|----------|------|
| Signal Analysis Report | `signals/signal-summary.md` |
| Personas (at least two) | `working-backwards/personas/*.md` |
| PR/FAQ | `working-backwards/prfaq.md` |
| PRD | `working-backwards/prd.md` |
| HTML prototype | `prototype/index.html` |
| Prioritized problems with open hypotheses | `validate/prioritization.md` |
| Current-product map (only when a codebase exists) | `signals/current-product-map.md` |

## Brief Template

Write `discovery/[project]/handoff/discovery-brief.md` with exactly these
sections, in this order. Summarize; link to the full artifacts instead of
copying them. Keep the whole file under 200,000 characters.

```markdown
# Discovery brief: [product or feature name]

## 1. Engagement reference
Intake record: [number, or "Self-serve"] | Date: [YYYY-MM-DD] | Route: AI-DLC workshop | Receiving profile: workshop | classic

## 2. Problem and evidence
The problem in two or three sentences, then the top signals with frequency,
severity, and reach, each with one anonymized customer quote.

## 3. Target customers and personas
One paragraph per persona, starting with the persona's name in bold: who they
are, the job they need done, and their main pain. Full personas are in AI-DLC
team knowledge.

## 4. PR/FAQ summary
The press-release headline, the customer benefit, and the three FAQ answers
that most constrain the build.

## 5. Success metrics
Measurable outcomes with a baseline where the evidence gives one.

## 6. Scope
In scope and out of scope, as two lists.

## 7. Prioritized backlog
The PRD features as a ranked list with P0/P1/P2 and one line each.

## 8. Prototype screens and user flows
Each prototype screen as a structured text description (purpose, main
elements, actions), then the core user flow as numbered steps. Note the
in-codebase prototype branch if one exists, and that it is disposable.

## 9. Current product
The current-product map summary, or "Greenfield: no existing codebase."

## 10. Constraints
Constraints the team stated: regulation, systems that must integrate,
deadlines. No architecture or technology choices.

## 11. Open hypotheses and assumptions
Every hypothesis Validate did not confirm or refute, and every assumption,
each as a question for AI-DLC Inception.

## 12. Full artifacts
Relative links to every artifact under discovery/[project]/.
```

## Rules

1. **Evidence only.** Every claim traces to a Discovery artifact; label
   anything else as an assumption in section 11.
2. **No implementation.** No architecture, stack, or code in the brief;
   AI-DLC owns those decisions.
3. **No opportunity IDs.** The engagement reference is the intake record
   number only. Never write an opportunity ID or account revenue into the
   customer's repository.
4. **Anonymized.** Quotes carry no names, emails, or account identifiers.

## Also Write

- `aidlc/knowledge/aidlc-product-agent/discovery-personas.md` — all personas
  in full, so AI-DLC's product agent loads them automatically. Create the
  folder if it does not exist.
- `.gitignore` — add `discovery/data/` so raw customer feedback is never
  committed. Create the file if it does not exist.

## Finish

Print the start command; do not start AI-DLC. The AI-DLC workshop is a separate
session, often days later.

```text
aidlc config --harness <claude | kiro | kiro-ide | codex | cursor | opencode | copilot>
/aidlc workshop Build [product or feature name] from the Discovery brief at discovery/[project]/handoff/discovery-brief.md (engagement [intake record])
```

Use `/aidlc classic` instead of `/aidlc workshop` when the team continues on
its own after the engagement. In Amazon Quick, which does not run AI-DLC, tell
the team to commit the `discovery/` folder to the repository where they will
build and run the command there.
