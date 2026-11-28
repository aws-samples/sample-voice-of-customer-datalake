---
item: 7.101.00
test: voc-datalake/lambda/api/test/test_example.py::TestExample::test_member_reads
digest: <the digest `python3 scripts/feature_gate.py brief <item> <test>` prints>
verdict: ACCEPT
evaluator: <your session id: never the author's root>
author: <the entry's written_by>
sha: <the commit the change was evaluated on: the tree's HEAD (the change staged on it), 7 to 40 hex digits>
tree: <git write-tree of the staged tree you evaluated, 40 hex digits (informational)>
checks:
  tests_item: true
  real_path: true
  fails_on_break: true
  not_tautology: true
  stable_3x: true
  runs_in_gate: true
---

<!-- The verdict of one independent evaluator on one test of one roadmap item (docs/feature-tests/README.md).
Copy this file to the place `brief` names (docs/test-verdicts/<item>/<runner>-<hash>.md; a REJECT goes to
<runner>-<hash>.reject-<n>.md, n its number among the test's REJECTs), redact local paths (a home directory, scratch, worktree or venv path: write `<home>`, `<scratch>`,
`<worktree>`, `<venv>`, in backticks outside code blocks), fill every section from
what you ran yourself, then `python3 scripts/feature_gate.py accept|reject <item> <test> --verdict <file>
--session <you>`. Start from the brief only: not from the author's explanation.

The six checks (each true only with its evidence below; an ACCEPT needs all six):
  tests_item     the assertions check what the item says the user gets (values, the file written, the page drawn),
                 not that a function was called or that no error happened
  real_path      the product's own code runs (fakes only at the true edges: clock, network, store, process launch);
                 an e2e drives the real build or the deployed site
  fails_on_break you broke the feature in a scratch tree (never the shared one) and saw this test go red
  not_tautology  no assert-what-you-just-set, no expected value computed by the code under test, no golden file the
                 run writes itself
  stable_3x      green 3 runs in a row after restoring, no sleep-based wait or wall-clock limit
  runs_in_gate   its id resolves and the gate runs it (not skipped, not .only / .fixme): `check` agrees
A REJECT sets the checks it failed to false, says what to fix under Reasons, and needs only Command and Reasons.

What `check` reads (statically: it does not rerun what you ran): every file of the Break diff is product code and
changes a line that is not a comment; Red names the test (its pytest node id, or its vitest / Playwright title) and
shows a failure; each of the three Green blocks shows 1 passed and 0 skipped (for vitest, whose -t reports the
file's other tests as skipped: exactly 1 passed, 0 failed and the test's own title on a passing line), and no run
shows a failed, error, flaky or rerun count; sha is HEAD or an ancestor of it; the
digest is the test's current one. The flow for a change not yet committed: the author stages it, you evaluate the
staged tree and record its HEAD as sha and `git write-tree` as tree, then it is committed with this file. -->

## Item

<What the release says the user gets, in your words, from its CHANGELOG section.>

## Command

```bash
<the exact command `brief` printed, run from the repository root>
```

## Break

<What you broke and how (commented out the fix, inverted the condition, returned early, a mutant), in a scratch
tree. Every file of the diff must be product code: voc-datalake/lambda/**, voc-datalake/frontend/src/** or
voc-datalake/lib/**, never a test, test support or a fixture; and change a line that is not a comment.>

```diff
diff --git a/voc-datalake/lambda/shared/example.py b/voc-datalake/lambda/shared/example.py
--- a/voc-datalake/lambda/shared/example.py
+++ b/voc-datalake/lambda/shared/example.py
@@ -1,2 +1,2 @@
 def is_member(row):
-    return row is not None
+    return True
```

## Red

<The test's output on the break: the line naming the test (its node id or title) and the failing assertion.>

```
<output>
```

## Green

<Three runs after restoring the tree, each its own block, each showing 1 passed and 0 skipped (vitest: exactly 1
passed, 0 failed, and the test's own passing line; the file's other tests may show as skipped).>

```
<run 1>
```

```
<run 2>
```

```
<run 3>
```

## Reasons

<Why it holds (or what the author must fix): which assertion proves the item, which edge is faked and why that is the
edge, why the expected values do not come from the code under test.>
