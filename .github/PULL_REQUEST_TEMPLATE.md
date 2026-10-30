<!--
Title: start with the release this PR adds, e.g. "5.49.00: feedback boards can be paused".
The "PR description" check reads this description (scripts/pr-checks/check-pr-body.mjs). It ignores
these comments, so you can leave them in or delete them.
-->

## Goal

**Goal:** <!-- One sentence, in the user's or operator's terms: what can they do, or stop suffering, after this? -->

## Why it matters

<!-- Who hits this, how often, what it costs today. A measurement or a link to the issue helps. -->

## Not a goal

<!-- What a reviewer might expect here but is deliberately left out (and where it is tracked). "None." is fine. -->

## What changed

<!--
A fix: symptom -> root cause -> change.  Anything else: goal -> approach -> change.
Group by area, not by file. Name routes, pages, stacks, settings.
-->

## Backwards compatibility

<!--
First line, one of:
Compatible: <why nothing a caller, operator or stored record depends on changes>
Breaking: <what breaks and for whom>  (then the CHANGELOG release needs an "### Upgrade notes" group)
-->

## Tests

<!--
What ran: `bash scripts/validate.sh` (pass / fail and why), deployed checks, manual checks.
A fix (the CHANGELOG release has a "### Fixed" group) adds exactly ONE Proof line, even when the release
bundles several fixes; it may name several tests:
Proof: `voc-datalake/lambda/shared/test/test_x.py::test_y` fails without the fix
Proof: not provable -- <deployed-only | external-service | nondeterministic | no-runtime-behaviour | test-only>: <what was checked instead>
-->

## Sibling sweep

<!--
Fix PRs only (delete this section otherwise). Where else could the same defect live? One line per site:
- `path/from/repo/root.py:120` -- changed here
- `path/other.ts` -- follow-up #123
- `path/third.py` -- not affected: <why>
or one line:
Siblings: none -- <how you looked, e.g. the grep you ran>
-->

## Release

<!-- The CHANGELOG.md section this PR adds and its bump kind (.kiro/steering/changelog.md), e.g. "5.49.00 (minor)". -->
