# Hypothesis regressions

The failing-example database of the property tests (`../properties.py`). Hypothesis saves a case that failed here
and replays it first on every later run. The folder is ignored but for this file, so a red run while a test is being
written leaves nothing to commit: the entry a fix needs is added on purpose with `git add -f`, with that fix, so the
case stays a test. A case worth reading in the test itself is better written there as `@example(...)`.
