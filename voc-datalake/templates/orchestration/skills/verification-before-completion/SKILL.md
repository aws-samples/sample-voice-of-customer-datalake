---
name: verification-before-completion
description: "Evidence gate before any completion claim (done, fixed, passing, ready) and before submit_work, a review, a gate record or a finish. The proving command runs in the current turn and its exit code is read first; another agent's success is a claim until its patch or record is read."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/verification-before-completion"
license: MIT
adapted: "Commands are run's argv (the result carries the exit code; no shell pipes). Deploy-live and CI-green claims are dropped: the run never deploys and the people's CI is not the agent's to read. The sub-agent step became reading another agent's patch or record (read_patch, read_gate_record, read_findings). The red phase undoes the fix with write_file, not git stash. The Stop-hook enforcement section is dropped."
---

Gate the completion claim you are about to make.

Adapted from the verification discipline in [obra/superpowers](https://github.com/obra/superpowers) (MIT).

Most skills in this library audit code. This one audits your own statements about that code. Apply it whenever a
claim about state is about to go into a submission, a review, a gate record or a finish.

## The Rule

No completion claim without verification evidence produced in the current turn.

Evidence from an earlier turn is stale. Code changed since then. Re-run the command (with `run`).

## Step 1: Name the Proving Command

State the claim, then the single command whose output would falsify it.

| Claim | Proving command | Not proof |
|---|---|---|
| Tests pass | `pytest -q` / `pnpm vitest run` exit 0, failure count 0 | An earlier run, "should pass" |
| Build succeeds | `pnpm build` / `uv build` / `cdk synth` exit 0 | Linter passing, type checker passing |
| Infrastructure code is valid | `cdk synth` / `terraform validate` exit 0 (offline; never a deploy) | The code looking right |
| Types check | `pyright` / `tsc --noEmit` exit 0 | Editor showing no red squiggles |
| Lint clean | `ruff check` / `biome check` exit 0 | Partial run on one file |
| Bug fixed | Test reproducing the original symptom now passes | Code changed, cause understood |
| Regression test works | Red-green cycle verified (Step 4) | Test passes once |
| Requirements met | Line-by-line checklist against the request | Tests passing |
| Another agent's task done | Its patch read (`read_patch`), its gate record or findings read (`read_gate_record`, `read_findings`) | Its finish summary, the task's title |
| Performance improved | Before and after measurement, same conditions | Reasoning about complexity |

If no command can falsify the claim, the claim is an opinion. Label it as one.

## Step 2: Run It Fresh and Complete

- Run the full command, not a subset. One passing test file does not prove the suite.
- Read the exit code `run` answers first, then the output. `run` takes argv, not a shell line, so there is no pipe
  to hide it; a wrapper script that swallows the exit code hides it just the same.
- Read the whole output. Count failures. Check for skipped, xfailed, or deselected tests.
- A suite that collected 0 tests exits 0. That is not a pass.
- Watch for a stale result from a cache or watch mode: clear `.pytest_cache`, stop `vitest
  --watch`, and re-run with `--no-cache` / a one-shot flag if the runner supports it.

For example `run` with `["python", "-m", "pytest", "-q"]`: exit code first, then the counts.

## Step 3: Compare Output to Claim

| Result | Action |
|---|---|
| Output confirms the claim | State the claim with the evidence inline |
| Output contradicts the claim | State actual status, then fix (a fixer or builder) or record it (a reviewer, a gate). Never soften the wording instead |
| Command failed to run | Report the gap as a gap. Missing tooling is not a pass |
| Output ambiguous | Say so, name what would resolve it |

Report format (your finish summary):

```
Tests: 47 passed, 0 failed (uv run pytest -q, exit 0)
Types: pyright 0 errors
Lint:  ruff clean
Not verified: integration suite (needs AWS credentials)
```

## Step 4: Regression Tests Need a Red Phase

A test that has never failed proves nothing. It may assert on the wrong thing.

1. Write the test.
2. Run it. It passes with the fix in place.
3. Undo the fix only: write the changed lines back as they were with `write_file` (never `git stash` or
   `git revert`: the checkout's git is the harness's).
4. Run again. It MUST fail. If it passes, the test does not cover the bug.
5. Write the fix back. Run again. It passes.

Only after step 4 fails may you call the test a regression test. Full protocol: the `tdd` skill.

## Step 5: Verify Another Agent's Work Independently

Another agent's finish, or a task's title, is a claim, not evidence. When your task judges another agent's work (a
review, a gate, a final go):

- [ ] Read the patch (`read_patch`, every page), not the summary
- [ ] The files it claims to change are the files it changes
- [ ] Re-run the proving command yourself when your role runs code; read the gate record (`read_gate_record`) when it
      does not
- [ ] Check for files changed outside the task's scope

## Step 6: Requirements Checklist

Tests passing proves the code runs. It does not prove you built what was asked.

Re-read your task (and the run's issue, when it has one). List each requirement. Mark each: met (with evidence),
partial (with what is missing), or not started. Report gaps before claiming completion.
Scope creep counts as a gap: name anything built that was not requested.

## Rationalisations to Refuse

| Excuse | Reality |
|---|---|
| "Should work now" | Run it |
| "I am confident" | Confidence is not evidence |
| "Linter passed" | Linters do not compile or execute |
| "Types check" | Type checkers do not run tests |
| "The other agent said success" | Read the patch or the record |
| "Same as last run" | Code changed since then |
| "Only a comment changed" | Run it, the command is cheap |
| "Partial check is enough" | Partial output proves the part you ran |
| "Different wording avoids the rule" | The rule covers meaning, not phrasing |

## Red Flags in Your Own Draft

Stop and run the command if your draft contains:

- Hedges: "should", "probably", "seems to", "appears to", "ought to"
- Satisfaction before evidence: "Done", "Fixed", "All set", "Working now"
- Any past-tense success verb with no command output above it
- A `submit_work`, `write_review`, `write_gate_record` or `finish` about to happen with no proving command in this
  turn

## Step 7: Verdict

| Verdict | Meaning |
|---|---|
| **VERIFIED** | Every claim has fresh command output in this turn |
| **PARTIAL** | Some claims verified. Unverified ones named explicitly |
| **UNVERIFIED** | No proving command run. Do not claim completion |
| **BLOCKED** | Proving command cannot run here. Name the missing prerequisite |

Report `PARTIAL` honestly rather than upgrading it to `VERIFIED`. An honest gap costs one follow-up task. A false
pass costs a production incident.

## Self-Check

- [ ] Named a falsifiable command for every claim in the response
- [ ] Ran each command in this turn, not an earlier one
- [ ] Read exit codes, not only stdout
- [ ] Regression tests went through a red phase
- [ ] Another agent's work checked against its patch or record
- [ ] Requirements checked line by line against the task
- [ ] Unverifiable items labelled, not omitted
