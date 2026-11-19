---
name: red-team
description: "The adversarial critic's checklist for reviewing a high-blast-radius change (authentication, payment, IAM, novel algorithms, 200+ lines of new logic). Steel-man the approach first, then the security, quality and architecture rubric, with severity and confidence on every finding."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/red-team"
license: MIT
adapted: "Only the critic's checklist is kept: the steel man, the rubric, severity and confidence, and the verification rule. The proposer-critic sub-agent rounds are dropped (on the platform the fixer or builder proposes and the reviewers and the final go are the critics, each in its own task). Findings go through write_findings and the verdict through write_review or the final go's record."
---

Review the change your task names as an adversarial critic: find real problems, not style nits.

On the platform the roles are already separate: a fixer or builder proposes the change, and the commit reviewer,
the PR reviewer and the final go critique it, each in its own task, on the patch the task names. This skill is the
critic's checklist. Use it in full when the change is security-critical (authentication, authorisation, payment,
IAM), adds more than about 200 lines of new logic, or brings a novel algorithm; for a small, non-critical change the
`code-review` and `anti-slop` skills are enough.

## Step 1: Read the Change

Read the patch with `read_patch`, every page, and each changed file in context with `read_file` (the harness applied
the patch to your checkout). A finding about code you have not read is speculation.

## Step 2: Steel-Man (before any critique)

State the STRONGEST case for the author's approach:
1. What problems does it solve well?
2. What tradeoffs did it consciously accept?
3. What assumptions make this approach reasonable?

A critique that cannot first state the approach's best case usually attacks a straw man.

## Step 3: The Rubric (check ALL of these)

**Security**: apply the `security-audit` skill's checklist (authentication, input validation, information
disclosure). Key checks: no credentials in code or logs, external data validated at the boundary, no injection
vectors, no `eval`/`exec` on untrusted input, authorisation on protected routes. For infrastructure, the
`aws-security` skill.

**Code quality**: apply the `anti-slop` skill's patterns 1-12 and 12a-12f (code slop and AI hallucination). Key
checks: no silenced errors, no unsafe type casts, no dead code, no hallucinated imports, no language leaks, no
premature abstractions.

**Architecture**:
- Functions under 50 lines, files under 500 lines
- Cyclomatic complexity under 10
- No N+1 queries, no sync I/O in async context

## Step 4: Write Each Finding

- Be specific: cite file:line for every finding.
- Severity: MUST (blocks merge), SHOULD (improve), NIT (optional).
- Confidence: HIGH (certain), MEDIUM (likely), LOW (uncertain assumption).
- For MEDIUM or LOW confidence, state the assumption: "Wrong IF [assumption]".
- Do NOT modify files. Report only.

Write them with `write_findings` (a MUST is blocking; the confidence and its assumption go in the evidence), in
this shape:

```
### Steel Man
[2-3 sentences: strongest case for the author's approach]

### Verdict: PASS / REVISE / FAIL
[MUST] [HIGH] file:line - description + fix
[MUST] [MEDIUM] file:line - description (IF [assumption]) + fix
[SHOULD] [HIGH] file:line - description + fix
[NIT] file:line - description
```

| Verdict | Condition | As the platform records it |
|---|---|---|
| **PASS** | 0 MUST, 0 SHOULD | `write_review` approve (a final go: GO) |
| **REVISE** | 0 MUST, 1+ SHOULD | approve, with the SHOULD findings written |
| **FAIL** | 1+ MUST | `write_review` request_changes (a final go: NO-GO), with the blocking finding written |

## Step 5: A Second Look Is Bounded

When the change comes back revised (a new task on the fixer's next patch), check ONLY the items from the first
review: was each fixed, does a fix introduce a new issue, and is each dispute of a MEDIUM or LOW finding valid
(withdraw it) or overruled (it stands). Do not expand the scope: a critic that invents new findings every round
turns a bounded review into an open-ended loop.

## Step 6: Verify Before Any Verdict

A critic's opinion is not evidence. Before a PASS:

1. The tests and the linters ran on this tree: the gate record says so (`read_gate_record`, a final go), or your
   task says which checks the gate runs.
2. The patch changes what its author claims (Step 1).

A PASS with no evidence behind it is invalid. When the evidence cannot be had (no patch, a gate that stopped),
the verdict is `could_not_review` (a final go: NO-GO, saying why), never a pass. Full protocol: the
`verification-before-completion` skill.

## Why Bounded

Each additional round of critique compounds cost without a matching accuracy gain, and nothing stops a critic from
inventing new findings every round to justify its own existence. One critique and one verified re-check bound the
cost and force a final verdict. Reports on multi-agent systems found token usage explains most of the performance
variance and that heavier multi-agent setups use an order of magnitude more tokens than a single chat turn (see
`references/sources.md`).
