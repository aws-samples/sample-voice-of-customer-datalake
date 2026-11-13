# Review guide

What a reviewer, human or AI, should look for in this repository. Both AI reviews read this file: `npm run
validate:tenets` / `validate:commit` and the `AI review` pull request workflow. TENETS.md is the bar; this file
says where changes usually go wrong. Keep it short. When a reviewer keeps raising the same point, add it here
instead of answering it again.

## What failure looks like here

| Area | It fails when… |
| --- | --- |
| Docs, steering, CHANGELOG | **it lies**: a route, path, limit, version or behaviour that the code does not have. A doc that names a file must name one that exists. |
| IAM and stacks (`voc-datalake/lib/stacks/`) | a grant is wider than the code needs (`grantReadWriteData` where it only reads, `*` resources), a new role can delete customer data, or a resource adds a fixed monthly cost by default (tenet 7). |
| API routes (`voc-datalake/lambda/api/`) | a route lacks its auth or admin check, a public route lacks a throttle, or the handler and the SPA type, Zod schema, dev mock or MCP tool disagree on a payload. |
| Data (`voc-feedback`, `raw/`, projects) | a write overwrites instead of versioning (D1), drops actor, time or version (D4), or deletes outside `voc-retention` (D5); a workspace reads or writes another's data outside the workspace layer (D8). |
| AI writing (`shared/ai_writing.py`, prompts, model ids) | an AI path skips the person's AI mode (tenet 3), or a model id changes without its IAM ARN. |
| Frontend (`voc-datalake/frontend/`) | a user-visible string has no i18n key in every locale, runtime data is trusted without its Zod normaliser, or a rule exists only in the UI (tenet 4). |
| CI and the reviewers (`.github/`, `scripts/ai-review/`, `tools/ai-review-ci/`) | pull request code runs with secrets, a token or role gets wider, or a check can pass without checking. |
| Tests | a changed behaviour has no test that would fail if it were reverted, or a test cannot fail. |

## How to report

- **Evidence**: every finding names a file and line, and quotes the code. Never judge a file by its name.
- **Severity is earned**: blocking only with a concrete trigger and outcome. What you cannot ground is a should-fix.
- **One finding per class of mistake**: list every place it occurs in that one finding.
- **At most 3 nits.** Leave formatting, wording and naming to the linters unless they mislead.
- **Start with a count** ("2 findings, 1 blocking"), and say plainly when there is nothing to fix.

## Skip

- `package-lock.json`, `*/public/locales/*` (checked by `npm run check:i18n`), build output, images.
- `voc-datalake/lib/test-support/baseline.json` hash changes after a version bump: the release number is in the
  Api and Processing templates, so every release moves those two hashes.
- What the deterministic gates of `scripts/validate.sh` already enforce (lint, types, coverage, knip, jscpd, CodeQL,
  the audit detectors).
