# Versioning and CHANGELOG — required for every change

Every PR that lands on `main` bumps the version once and records its changes in `CHANGELOG.md`, in one of its
commits (usually the last one, so the release section describes everything the PR brings).
`scripts/check-version.mjs` (a `scripts/validate.sh` step) fails when they disagree. CI runs it on a PR's head and
on `main` after the merge, never per commit, so the commits before the bump may disagree; a `git bisect` that
lands on one of them should skip that check.

## Branches and PRs

`main` is the only long-lived branch and the repository is public, so every pushed branch is public.

1. Start each release from the current `main`: `git fetch origin && git switch -c release/<x.yy.zz> origin/main`
   (or a topic name such as `fix/<what>`). Never base work on a local branch whose history is not on `origin`.
2. Commit there as often as you like: keep separate commits for separate changes, and don't squash or rewrite
   history just to tidy it. Bump the version once for the release (below), and run the full
   `bash scripts/validate.sh` once.
3. Check that you publish only new work: `git rev-list --count <branch> --not --remotes` must equal the number of
   commits you made. Then push the branch and open a PR against `main`.
4. The PR is rebase-merged once CI (`scripts/validate.sh`) is green: `gh pr merge --rebase`, so each commit of the
   branch lands on `main` as it is (several commits are fine; squashing is not required). `main` keeps a linear
   history, so a merge commit is refused: bring the branch up to date with `git rebase origin/main`, not a merge.
   `main` takes no direct pushes and needs one approval from someone other than the last pusher; a repository admin
   may stand in for that approval with `gh pr merge --rebase --admin`, never for a red or missing CI run.
5. After the merge, delete the branch (GitHub deletes the remote one) and remove its local branch and worktrees:
   `git switch main && git pull --ff-only && git branch -d <branch> && git worktree prune`.

## Pick the bump

| Bump | When | Example |
|---|---|---|
| **major** `X.00.00` | A redesign, or a breaking change to an API route/payload, a stack (renamed/replaced resource), stored data, or a deploy step | the Kiro redesign = `2.00.00` |
| **minor** `2.YY.00` | New or changed behaviour a user, an API caller or an operator can notice | a new page, route, plugin, setting, model default |
| **patch** `2.09.ZZ` | A bug fix, tests only, docs only, tooling/CI, a refactor with no behaviour change | mutation-hardening suites, lint fixes |

Several changes merged together take ONE bump: the highest kind among them.

## Apply it (one commit)

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
- When `main` moves while your PR is open, rebase your branch on `origin/main` (`git rebase origin/main`, then
  `git push --force-with-lease` to your own branch; a merge commit cannot land on `main`); on a CHANGELOG
  conflict, keep both sides' sections in version order: `main`'s released sections stay as they are, and only your
  own not-yet-merged section moves on top with the next free number. On a `package.json` version conflict take
  that number and re-run the check.
- Never rewrite or renumber a released section; correct it with a new entry instead.
