# Versioning and CHANGELOG — required for every change

Every change that lands (a commit or merge into the integration branch `kiro-voc`, or `main`) bumps the
version and records itself in `CHANGELOG.md`, in the SAME commit as the change (or the merge that brings
it in). `scripts/check-version.mjs` (a `scripts/validate.sh` step) fails when they disagree.

## Pick the bump

| Bump | When | Example |
|---|---|---|
| **major** `X.00.00` | A redesign, or a breaking change to an API route/payload, a stack (renamed/replaced resource), stored data, or a deploy step | the Kiro redesign = `2.00.00` |
| **minor** `2.YY.00` | New or changed behaviour a user, an API caller or an operator can notice | a new page, route, plugin, setting, model default |
| **patch** `2.09.ZZ` | A bug fix, tests only, docs only, tooling/CI, a refactor with no behaviour change | mutation-hardening suites, lint fixes |

Several changes merged together take ONE bump: the highest kind among them.

## Apply it (all in one commit)

1. **`CHANGELOG.md`**: add a release section directly under `## [Unreleased]` (leave that heading empty):
   `## [2.10.00] - YYYY-MM-DD` — two-digit minor and patch, today's date (`date +%F`). Under it a one-line
   summary, then the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) groups that apply, in this
   order: `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`,
   `### Upgrade notes`. One bullet per user-visible change: what changed and where (route, page, stack,
   setting), written for the person deploying or using the platform, linking the doc in `docs/` when there
   is one. Not a commit log: no hashes, no agent names, no file-by-file lists. Anything an operator must do
   or know before deploying (migrations, new Bedrock models, data retention, deploy order, quotas) goes in
   **Upgrade notes**.
2. **`package.json` × 3** (repo root, `voc-datalake/`, `voc-datalake/frontend/`) get the same number in
   strict SemVer without the padding (`2.10.0`) — npm rejects leading zeros. Run, in each of the three
   directories: `npm version 2.10.0 --no-git-tag-version` (updates the lockfile too).
   `voc-datalake/lambda/stream/package.json` keeps its own version.
3. Run `node scripts/check-version.mjs` (or `bash scripts/validate.sh`).

## Parallel work

- Feature/track branches do NOT bump: they add their bullets under `## [Unreleased]` only. The agent
  that merges them into `kiro-voc` turns `[Unreleased]` into the new release section and bumps once.
- On a CHANGELOG conflict, keep both sides' bullets (union, de-duplicated) under the newer version; on a
  `package.json` version conflict, take the higher version and re-run the check.
- Never rewrite or renumber a released section; correct it with a new entry instead.
