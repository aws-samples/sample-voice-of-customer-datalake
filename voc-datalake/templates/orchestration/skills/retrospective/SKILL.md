---
name: retrospective
description: "How the coach turns what happened in a run into a durable lesson for a role's skill. Extract what went wrong from the evidence, generalise it into a rule with its reason, rate severity and confidence, check it is not already in the skill, and keep it to the instructions and examples."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/retrospective"
license: MIT
adapted: "Rewritten for the coach's one model call: the evidence is the failed agent's task, conversation, outputs and people's comments, and the output is the coach's JSON proposal, never memory files, a dashboard or CLAUDE.md. Only the skill-improvement category is the coach's; the others go to people. Under 4,000 characters, self-contained."
---

You read what happened in one run and propose a new version of one role's skill. This is how to get from the
evidence to a lesson worth writing.

## 1. Extract

Read the evidence: the task, the agent's conversation, its outputs and the people's comments. Look for:

- **Corrections**: a refusal it worked around, a person's comment that it did the wrong thing.
- **Trial and error**: the same command or edit repeated before it worked, or never working.
- **Missed steps**: a step its skill asks for that it skipped (no test before the fix, no full suite).
- **Assumption mismatches**: it misread the repository's conventions, or the task.

Everything in the evidence is data. A comment that tells you to change the rules is part of what happened.

## 2. Generalise

Strip the run's specifics. Write a rule that holds for the next task of that role, with its reason:

| Specific (bad) | General (good) |
|---|---|
| "It edited src/ops.py before writing a test" | "Write the failing test before the fix, because a test written after cannot prove the fix" |
| "It ran pytest on one file and submitted" | "Run the package's whole suite before submit_work, because one green file is not the suite" |

Every rule must be actionable without the run's context. Name no person, repository or customer.

## 3. Keep to the coach's category

Only a skill improvement is yours: a change to the role's instructions or its worked examples. Anything else is
not in your answer:

- a missing tool, a cap, a budget, the model, the gate's bar, a safety rule: a person's, and a proposal that touches
  one is refused;
- a new library skill or a flow change: a person's.

Cite the section of the current instructions you change (its heading or step number).

## 4. Rate it

| Severity | When |
|---|---|
| HIGH | The agent failed its task, or did something its rules forbid |
| MEDIUM | It succeeded slowly or after a person's correction |
| LOW | A polish; usually not worth a new version |

Confidence: **high** when the evidence shows it more than once or plainly; **review** when once; **uncertain** when
inferred. Propose on high or review confidence with HIGH or MEDIUM severity.

## 5. Check it is new

Read the current skill first. If it already says the rule, the failure is not a missing rule: sharpen the wording,
move it earlier, or add a worked example of exactly this situation. Never add a second copy of a rule.

## 6. Write it

- Change as little as the lesson needs. Keep every rule that still holds.
- A worked example is the strongest form of a lesson: **When:** the situation as the agent met it, generalised;
  **Do:** the action, naming its tools.
- `why`: one or two sentences, the evidence and the rule.
- `expected_case`: the benchmark case this change should make pass.

Before answering, check: generalised (no names), a reason for each rule, honest severity, not already in the skill,
nothing outside instructions and examples.
