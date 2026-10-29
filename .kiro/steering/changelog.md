# Versioning and CHANGELOG — required for every change

Every change that lands on `main` bumps the version and records itself in `CHANGELOG.md`, in the SAME commit
as the change (or the release branch's final commit before its PR merges). `scripts/check-version.mjs` (a
`scripts/validate.sh` step) fails when they disagree.

## Branches and PRs

`main` is the only long-lived branch and the repository is public, so every pushed branch is public.

1. Start each release from the current `main`: `git fetch origin && git switch -c release/<x.yy.zz> origin/main`
   (or a topic name such as `fix/<what>`). Never base work on a local branch whose history is not on `origin`.
2. Commit there (it is fine to make several commits), bump once for the release (below), run the full
   `bash scripts/validate.sh` once, then push the branch and open a PR against `main`.
3. Before the first push, check that you publish only new work: `git rev-list --count <branch> --not --remotes`
   must equal the number of commits you made.
4. The PR is squash-merged once CI (`scripts/validate.sh`) is green. `main` takes no direct pushes; a repository
   admin may merge with `gh pr merge --squash --admin`.

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

- Topic branches that feed one release branch do NOT bump: they add their bullets under `## [Unreleased]`
  only. Whoever merges them into the release branch turns `[Unreleased]` into the new release section and
  bumps once.
- When `main` moves while your PR is open, rebase or merge `origin/main` into your branch; on a CHANGELOG
  conflict, keep both sides' sections in version order (yours on top, renumbered past `main`'s), and on a
  `package.json` version conflict take the higher version and re-run the check.
- Never rewrite or renumber a released section; correct it with a new entry instead.
