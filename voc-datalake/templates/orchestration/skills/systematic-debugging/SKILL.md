---
name: systematic-debugging
description: "Finds a root cause before a fix, with a fix-attempt budget: four phases, one hypothesis at a time, and a stop after three failed fixes to question the design. Read it when facing a bug, test failure, crash, flake or unexpected behaviour, before proposing a fix."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/systematic-debugging"
license: MIT
adapted: "Slash-command cross-references name library skills (read_skill); the GPU skill reference is dropped. History steps (git log, bisect) say the run's checkout is one commit without history. Production-only bugs and design questions end in the finish for a person to decide, never a question to a user mid-task. The red-phase proof undoes the fix with write_file. The report is the finish summary; description reworded for Claude 5.5 skill discovery"
---

Find the root cause of the failure your task names.


Adapted from the debugging discipline in [obra/superpowers](https://github.com/obra/superpowers) (MIT).

Domain specialisations: the `perf-debug` skill for latency and memory, the `cdk-doctor` skill for CDK and ECS
deployment failures. Use this skill for the general case and when those skills hand back an unexplained failure.

## The Rule

No fix before the root cause is identified with evidence. A fix that removes the symptom
without explaining the cause is a defect that has moved, not a defect that is gone.

## Step 1: Read the Evidence You Already Have

Do this before opening any source file.

- [ ] Read the full error and the full stack trace, bottom frame included
- [ ] Note file, line, error class, and error code verbatim
- [ ] Read log lines before the failure, not only the failure line
- [ ] Check for a second, earlier error that the visible one is a consequence of

Error messages frequently name the fix. Skipping them costs more than reading them.

## Step 2: Reproduce Deterministically

| Reproduction | Next action |
|---|---|
| Every run | Proceed to Step 3 |
| Intermittent | Find the varying input: ordering, clock, concurrency, network, cache, locale, random seed |
| Only in CI | Diff the environments: versions, env vars, timezone, filesystem case, parallelism |
| Only in production | You cannot see production: `finish` naming the instrumentation that would show it. Do not guess from the diff |
| Cannot reproduce | Stop. Gather data. A fix without reproduction cannot be verified |

Record the exact command (its `run` argv) and input that triggers it. That command becomes the proving
command for the `verification-before-completion` skill. For a flaky test, capture and pin the random
seed (`pytest -p randomly --randomly-seed=12345`, or log `PYTHONHASHSEED`) so the same run
replays instead of rolling new dice each time.

## Step 3: Narrow the Blast Radius

Run these in order. Stop when the failing component is identified.

1. **Check recent changes.** When the task or the issue names the change that broke it (a commit, a pull request,
   a version bump), start there. The run's checkout holds the run's commit and no history, so `git log` and
   `git bisect` are not available: say so in your finish when a bisect is what the bug needs.
2. **Compare against a working case.** Find similar code in the same repo that works.
   List every difference. Do not dismiss a difference as irrelevant before testing it.
3. **Instrument boundaries.** For multi-component flows, log what enters and what leaves
   each component. One run reveals which boundary corrupts the data.
4. **Trace backwards from the bad value.** Where did it originate? What called that with
   the bad input? Keep walking up until the first frame that had correct data.

Fix at the origin. A guard added at the crash site leaves every sibling caller broken.

## Step 4: One Hypothesis, One Change

Write the hypothesis down before editing: "X causes Y because Z."

- Change one variable. Two changes make the result uninterpretable.
- Prefer the smallest change that discriminates between two candidate causes.
- If the hypothesis is wrong, discard it and return to Step 3. Do not stack a second fix
  on top of the first.
- Delete the instrumentation you added before moving on, or convert it to a permanent log
  line with a real level and message.

## Step 5: The Fix-Attempt Budget

Count every attempt. The count is the signal.

| Attempts | Action |
|---|---|
| 1 failed | Return to Step 3 with what the failure taught you |
| 2 failed | Return to Step 1. Re-read the error. Your model of the system is wrong |
| 3 failed | STOP. Do not attempt a fourth. Escalate to Step 6 |

Three failures with three different causes is not bad luck. It means the fixes are
addressing symptoms of one structural problem.

## Step 6: Escalate to a Design Question

Signals that the design is the defect, not the line:

- Each fix reveals a new failure in a different file
- The correct fix needs edits in more than five call sites
- The fix reintroduces a bug that was fixed before
- Two components both own the same piece of state
- Correctness depends on call ordering that nothing enforces

State the structural problem, the options, and the cost of each, then `finish` with them: a person decides
whether a redesign starts. Do not silently convert a bug fix into a redesign.

## Step 7: Fix the Cause and Prove It

1. Write a failing test that reproduces the symptom. The `tdd` skill has the cycle.
2. Apply one fix at the origin of the bad value.
3. Run the new test, the file, then the full suite.
4. Undo the fix with `write_file` (the original lines, from your notes), confirm the test fails, write the fix
   back. Record both exit codes. Never `git stash` or `git revert` in the checkout: its git is the harness's.
5. Check the fix does not depend on the instrumentation you removed.

No bundled cleanup. No "while I am here" refactors. They hide which change fixed it.

## Step 8: Report

Put this in your `finish` summary:

```
## Debug: [symptom]

### Root cause
[One sentence: the mechanism, not the location]

### Evidence
| Step | Finding | Source |
|---|---|---|
| Trace | `user_id` null at handler entry | src/api.py:41 log line |
| Origin | Session parser drops the claim on refresh | src/session.py:88 |

### Fix
- Change: [file:line, one sentence]
- Attempts before this one: N
- Alternatives rejected: [why]

### Verification
- Reproduction command: [command], before: exit 1, after: exit 0
- Red-phase proof: fix undone -> exit 1, restored -> exit 0
- Full suite: X passed, Y failed

### Residual risk
[Sibling call sites checked, related paths not covered, follow-up needed]
```

## Rationalisations to Refuse

| Excuse | Reality |
|---|---|
| "Quick fix now, investigate later" | The first fix sets the pattern. Later never arrives |
| "It is probably X" | Probably is a hypothesis. Test it at Step 4 |
| "Emergency, no time for process" | Guess-and-check is slower than tracing. Measure both if unsure |
| "Try both fixes and see" | Then you cannot attribute the result |
| "The test is flaky, re-run it" | Flakiness is a bug with an unread root cause |
| "One more attempt" (after 3) | Budget spent. Go to Step 6 |
| "I will add a null check here" | Only if the null is legitimate. Otherwise fix the producer |

## Self-Check

- [ ] Read the full stack trace before reading source
- [ ] Reproduced the failure with a recorded command
- [ ] Traced to the origin of the bad value, not the crash site
- [ ] One hypothesis and one change per attempt
- [ ] Attempt count tracked, escalated at three
- [ ] Instrumentation removed or promoted to real logging
- [ ] Fix covered by a test proven to fail without it
- [ ] Sibling callers of the changed function checked

Before you claim the bug is fixed, apply the `verification-before-completion` skill.
