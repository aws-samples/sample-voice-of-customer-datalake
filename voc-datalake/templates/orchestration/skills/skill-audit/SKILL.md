---
name: skill-audit
description: "Scores a role's skill before and after the coach's change: static checks on the instructions and examples (sections, imperative steps, reasons, own tools, examples, size, filler, duplicates) and why the failed agent missed what its skill says. Read it when the coach checks a proposal."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/skill-audit"
license: MIT
adapted: "Rewritten for the coach's one model call: it audits the one role's skill it is about to change (the current version, then its own proposal), not a folder of skill files, and the trigger, undertrigger and coverage analyses became why the failed agent did not follow its skill. The research-backed scoring is kept as a reference for the Library's readers. Under 4,000 characters; description reworded for Claude 5.5 skill discovery"
---

Score the role's current skill before you change it, and your proposal before you answer. A proposal must score
at least as well as the version it replaces.

## The static checks

| # | Check | MUST/SHOULD |
|---|---|---|
| 1 | The sections are Role, Reads, Writes, Steps, Rules, When to stop, in that order | MUST |
| 2 | Steps are numbered, one imperative action each | MUST |
| 3 | No conversational filler ("Let's", "Note that", "Please", "It is important to") | MUST |
| 4 | Every MUST-level rule carries its reason ("because ...") | MUST |
| 5 | Only the role's own tools are named, in backticks, as the current version names them | MUST |
| 6 | Nothing about tools, the model, budgets, caps, the dial, safety rules or the gate's bar | MUST |
| 7 | Each worked example is a When and a Do, generalised, naming its tools | MUST |
| 8 | No rule stated twice, no rule that contradicts another | SHOULD |
| 9 | The most important rules come first in their section (a long prompt's middle is read worst) | SHOULD |
| 10 | Reference data is a table, not prose | SHOULD |
| 11 | Every failure the run showed has a When to stop line or a rule that covers it | SHOULD |
| 12 | The instructions stay well under the record's limit of 20,000 characters; shorter is better | SHOULD |

Count them: a proposal fails no MUST check and passes at least as many SHOULD checks as the current version.

## Why the agent did not follow its skill

Before you add a rule, find which of these it was:

| Finding | Meaning | The change |
|---|---|---|
| **Missing** | The skill does not say it | Add the rule, with its reason |
| **Buried** | It says it, in the middle of a long section | Move it to the top of its section, or into the steps |
| **Vague** | It says it in words the agent could read another way | Rewrite it concretely; add a worked example |
| **Contradicted** | Another rule or example points the other way | Remove or reconcile the other |
| **Out of reach** | It needs a tool or a limit the role does not have | Not the coach's: say so in `why` and change nothing |

A missing rule is the rarest cause. A rule the agent had and did not follow needs a sharper form, not a copy.

## Before you answer

- [ ] The current version scored, its weakest checks named
- [ ] The cause found (missing, buried, vague, contradicted, out of reach)
- [ ] The proposal fails no MUST check
- [ ] It passes at least as many SHOULD checks as the current version
- [ ] `why` says the cause and the check the change fixes
