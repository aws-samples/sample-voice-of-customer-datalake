# Contributing Guidelines

Thank you for your interest in contributing to our project. Whether it's a bug report, new feature, correction, or additional
documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests to ensure we have all the necessary
information to effectively respond to your bug report or contribution.


## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already
reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

* A reproducible test case or series of steps
* The version of our code being used
* Any modifications you've made relevant to the bug
* Anything unusual about your environment or deployment


## Contributing via Pull Requests
Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the *main* branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Modify the source; please focus on the specific change you are contributing. If you also reformat all the code, it will be hard for us to focus on your change.
3. Ensure local tests pass.
4. Commit to your fork using clear commit messages.
5. Send us a pull request and fill in the description from the template
   ([.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)): the goal in one sentence, why it matters,
   what is not a goal, what changed, backwards compatibility, the tests that ran, and the release it adds. If the
   release section in `CHANGELOG.md` has a `### Fixed` group, also add one `Proof:` line (the test that fails without
   the fix, or `not provable -- <reason>: <detail>`) and a sibling sweep (other places with the same defect, or
   `Siblings: none -- <why>`). One `Proof:` line and one sweep cover a release that bundles several fixes.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.
   The **PR description** check (`.github/workflows/pr-description.yml`, rules and limits in
   `scripts/pr-checks/check-pr-body.mjs`) reads the description again on every edit. It checks the form only, and
   it skips drafts and Dependabot pull requests.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).


## Development setup
From the repository root (Node.js 22.22.2+ or 24.15+, Python 3.12+ for the local tooling (the Lambdas run Python 3.14), Docker or Finch for layer builds):

```bash
npm run install:all                               # root, CDK and frontend packages
npm install --prefix voc-datalake/lambda/stream   # the AI assistant Lambda
cd voc-datalake && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt \
  -r lambda/layers/ingestion-deps/requirements.txt -r lambda/layers/processing-deps/requirements.txt \
  -r lambda/layers/signing-deps/requirements.txt -r lambda/layers/email-intake-deps/requirements.txt && cd ..
npm run dev                                       # frontend + local mock API with sample data
```

Every frontend API call must also have a route in the local mock (`npm run check:mock` checks it); see
[docs/deployment.md → Quality Checks](docs/deployment.md#quality-checks) for the individual scripts.


## Branches and pull requests
`main` is the only long-lived branch. Start each change from the current `main`, keep separate commits for
separate changes, and open a pull request against `main`. Pull requests are rebase-merged once CI is green, so
each commit lands on `main` as it is and `main` keeps a linear history: bring a branch up to date with
`git rebase origin/main`, not a merge commit.


## Versioning and the changelog
Every pull request that lands on `main` bumps the version once and records its changes in
[CHANGELOG.md](CHANGELOG.md), usually in its last commit: **major** for a redesign or a breaking API/stack/data
change, **minor** for new or changed behaviour, **patch** for fixes, tests, docs and tooling. Several changes in
one pull request take one bump, the highest kind among them. The changelog writes releases as `2.09.00` with
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) groups (Added, Changed, Deprecated, Removed, Fixed,
Security, Upgrade notes); the three `package.json` files (root, `voc-datalake/`, `voc-datalake/frontend/`) carry
the same number in strict SemVer (`2.9.0`, via `npm version 2.9.0 --no-git-tag-version` in each directory).
`scripts/check-version.mjs`, a `validate.sh` step, fails when they disagree. Branches that feed a release branch
add their bullets under `[Unreleased]`, and whoever merges them cuts the release.

## Tenets

Read [TENETS.md](TENETS.md) before you design a change. Every change is checked against it: the pull request
description names the tenets it touches (`## Tenets`, `Tenets touched: <ids> | none`, checked by the PR description
check), the CDK suite fails on a new fixed monthly cost that is on by default (tenet 7), and the pre-push and Kiro
reviewers report a tenet violation as blocking.

### AI reviews in `validate.sh`

Two steps of the full gate ask YOUR coding agent to read the change since `origin/main` (the working tree, untracked
files included), so their findings are fixed before the push instead of one round per push on GitHub:

- `tenets: AI review` (`npm run validate:tenets`): does the change move the platform away from a tenet? A complete
  `VIOLATION` (a tenet id, a trigger and an outcome) fails the step; a `CONCERN` only prints.
- `commit: AI review` (`npm run validate:commit`): a review of the whole change, with its commit messages, like the
  GitHub pull request review. A complete `MUST-FIX` (a trigger and an outcome) fails the step; `SHOULD-FIX` and `NIT`
  only print.

Both live in `scripts/ai-review/review.mjs` (`--kind tenets|commit`). They use `kiro-cli` when it is installed, else
`claude` (Claude Code), with your own sign-in: no key or token lives in the repository. Neither installed, not signed
in, a timeout, or CI = the step prints why and passes, so the gate runs on every machine.

- `AI_REVIEW=kiro|claude` forces one CLI (and fails when it is missing); `AI_REVIEW=off` skips both steps.
- `AI_REVIEW_MODEL=<id>` passes `--model`; `AI_REVIEW_TIMEOUT=<seconds>` (default 600) bounds a run;
  `AI_REVIEW_BASE=<ref>` diffs against another base.
- The same change is reviewed once: answers are cached in `.cache/ai-review/` (`AI_REVIEW_CACHE=0` re-runs).
- The agents can only read, and only inside the repository (Kiro: `.kiro/agents/tenets-reviewer.json` and
  `commit-reviewer.json`, the read tool with `allowedPaths: ['./**']` and nothing trusted; Claude Code: Read and Glob
  in `dontAsk` mode with repository-scoped allow rules, no MCP servers). Paths shaped like a secret (`.env`, `*.pem`,
  `*credentials*`, … `SECRET_PATHS` in `scripts/ai-review/lib.mjs`) are left out of the diff and named in the
  output, and the tools themselves refuse to read them (Kiro `deniedPaths`, Claude Code deny rules). The diff is
  treated as data. They are
  language models: a PASS is not proof, and two runs can differ. `validate-affected.sh` never runs them (groups
  `tenets` and `commit`).

### AI review on pull requests

The `AI review` workflow (`.github/workflows/ai-review.yml`, `scripts/ai-review/ci-review.mjs`) runs the same two
reviews on every pull request, the tenets first and then the code, and posts them as one comment. It is advisory: it
fails no check.

- **Same prompts as `validate.sh`.** They are read from `main`, so a pull request cannot change the review it gets.
  The model is Claude Opus 5.5 on Amazon Bedrock, called directly with no tools. It sees:
  - TENETS.md and [REVIEW.md](REVIEW.md), the guide to what failure looks like in each area of the repository;
  - the pull request's title, description and comments, and the commit messages;
  - the diff, cut at 150,000 characters (the comment says so when it is cut);
  - the current text of the changed files and of the files the change names by path, within a size limit.

  What it cannot check, it reports as a `CONCERN` or a `SHOULD-FIX`.
- **Depth follows the changed paths.** A documentation-only change gets a short review. A change to CI, the git
  hooks and the gates that enforce the tenets, the reviewers, TENETS.md or REVIEW.md, IAM and stacks, data deletion, authentication and
  access checks, or the AI-writing guard gets a deep one with a larger budget.
- **Rounds converge.** The first push gets a full review. Every later push gets a new round that:
  - reviews only the commits since the last review, with the whole diff as context. Each pass (tenets, code) resumes
    from the last commit it reviewed to the end, so a pass that failed, was cut short or gave no verdict reviews what it
    missed;
  - gives every earlier finding a status by id: **resolved** (a blocking finding only with the commit and file:line
    that fix it), **answered by the author** (a reply with a reason the reviewer accepts; a blocking finding only when
    the answer names a person who commented, so answer a blocking finding in a comment, not only in the description)
    or **still open**, listed in one line and never explained again;
  - shows that recap above its new findings.

  A blocking finding still open keeps the round's verdict at BLOCK. There is no limit on rounds. A rewritten history
  (a rebase or amend) gets the whole diff again, still with the recap.
- **Nothing of the pull request runs.** The diff is read from git objects. The answer is posted verbatim in a code
  block.
- **A push that leaves the diff unchanged gets no new review.** The comment's hidden marker carries the diff's hash,
  so a rebase onto a moved `main` with the same change costs nothing.
- **When it skips:** pull requests from forks (they get no credentials), drafts and Dependabot. It also skips when
  the repository has no `AI_REVIEW_ROLE_ARN` secret, so a fork of this sample stays green.
- **Where it runs.** The AWS role it uses is development tooling, deployed on its own and never with the platform:
  [tools/ai-review-ci/README.md](tools/ai-review-ci/README.md).

### Running part of the gate

| Command | Runs |
|---|---|
| `npm run validate` | every step (the release gate, once per release) |
| `npm run validate:affected` | only the steps for the paths you changed (`scripts/validate-affected.sh`) |
| `npm run validate:failed` | only the steps that did not pass in the last run (`validate.sh --failed`: FAIL, stopped or not-run); repeat until it says nothing is left |
| `npm run validate:test` | the four test suites (pytest, frontend, CDK, stream vitest) |
| `npm run validate:tenets`, `npm run validate:commit` | one AI review |

`--failed` reads the newest run, so a narrower run in between (say `npm run validate:test`) hides the failures of the
full run before it. It also trusts that a fix did not break a step that already passed; the full run before the push
is still the gate.

## Quality gates
`npm run validate` (`scripts/validate.sh`) runs every gate: ruff, vulture (dead code), pyright, a check that every
pytest test asserts, tsc for each TypeScript program (all with `noUncheckedIndexedAccess`, specs included), ESLint in
each package (`voc-datalake/`, `frontend/`, `lambda/stream/`, sharing `eslint-rules/quality-gates.mjs`; specs linted
too, and `eslint-rules/` itself linted under the same rules), knip (default and `--production --strict`), jscpd over code and tests, the i18n audit (`npm run check:i18n` on its own: no missing, extra or empty locale keys, every source key in English; it is read-only, while the frontend's `i18n:validate` also runs `i18next-parser`, which rewrites the locale files), a gitleaks scan of the
working tree (`scripts/gitleaks-tree.sh`; install gitleaks 8.30+, e.g. `brew install gitleaks`), CodeQL's
security-and-quality queries over JS/TS and Python with zero errors and warnings (`scripts/codeql.sh`; install the
CLI with `brew install codeql`; about 5 minutes; skipped on GitHub Actions, where code scanning runs the same
analysis on every PR), the code-audit detectors in `scripts/audit/` (dead code, renamed clones and re-implemented
helpers; one `audit: …` step each, plus their own tests and lint: [docs/code-audit.md](docs/code-audit.md#in-the-gate)),
pytest and vitest with a per-file coverage floor and a shrink-only baseline ([docs/coverage-gate.md](docs/coverage-gate.md)),
and actionlint + zizmor over `.github/workflows` (`scripts/actions-lint.sh`; install both, e.g. `brew install actionlint zizmor`).
CI (`.github/workflows/quality-gates.yml`) runs that script and nothing else. Each gate allows zero findings.
Outside `validate.sh`, pull requests also get the license gate and the dependency vulnerability audit; Dependabot PRs
need a release bump before they merge ([docs/dependencies.md](docs/dependencies.md)). Before starting a feature
(and at least once a week), run `npm run deps:freshness`: it lists every dependency, Lambda runtime, toolchain and workflow pin
behind its newest release, so the work starts from current versions.

### When to run what
- **Topic branches: the affected gates only.** `bash scripts/validate-affected.sh [<base>]`
  (base defaults to `origin/main`) maps the changed paths (committed, uncommitted and untracked) to the steps that
  matter for them, and `--explain` prints that mapping without running anything. While iterating, run the single
  tool you need (`ruff check <files>`, `pytest <test files>`, `npx vitest run <spec>`).
- **The release branch: the full `scripts/validate.sh`, once, just before it is pushed for its pull request**
  (after any topic branches are merged into it). It is the backstop for anything the affected mapping misses, so
  it is never skipped; CI runs it again on the pull request.

### How validate.sh runs
The steps run in six parallel lanes: `py` (ruff, vulture, pyright, pytest with pytest-xdist), `tsc` (type checks,
knip, small node checks, most code-audit detectors), `lint` (ESLint on worker threads, `--concurrency auto`, jscpd, gitleaks, `ts_reachability`), `test` (vite build, the synth-based audit detectors, then the CDK
and stream vitest suites), `web` (the frontend vitest suite), `sec` (CodeQL). CI runs each lane except `sec` as its own job on its own
runner (`--lane <name>`; the repository's CodeQL code scanning stands in for `sec`), and a final `scripts/validate.sh` job is green only when every lane is. The first failing step stops the other lanes and its log tail is printed; every run ends with a table
of each step's status and duration, and every step's full log is in `.cache/validate/logs/<run>/`. Options:
`--serial` (one step after another), `--keep-going` (let the other lanes finish after a failure), `--only <groups>`,
`--lane <lanes>` (only those lanes' steps, as one CI job runs them), `--list`, `--pytest-first` (pytest alone, then the
other lanes, see [docs/coverage-gate.md](docs/coverage-gate.md#tests-that-assert-a-time-budget)), `--dry-run` (every
command a no-op, to test the runner). `VALIDATE_PYTEST_WORKERS` sets the pytest-xdist worker count (default: CPUs − 4).

pytest runs in several processes in any order, so a test must not depend on another test having run or on a
fixed path; tests that must share one process are marked `@pytest.mark.xdist_group('<name>')`. Parametrize ids
must be the same in every process (no random values in an id: pass `ids=`). An order audit, on demand (not a gate,
and not installed in `.venv`, because installed it reorders every pytest run):
`uv pip install --target /tmp/pytest-randomly pytest-randomly==5.0.0 --no-deps`, then from `voc-datalake/`
`PYTHONPATH=/tmp/pytest-randomly .venv/bin/python -m pytest -o addopts= -p randomly -n 8` (the seed is printed;
replay that order with the same command plus `--randomly-seed=<seed>`).

A new gate that arrives with existing findings can be pended while its findings are fixed: list it in a
`PENDING_*` map of the package's `eslint.config` (or the matching ruff configuration), count it in
`scripts/quality-baseline.sh`, and move it into `validate.sh` in the change that brings it to zero. The list only
shrinks:

- Never add a pending entry, raise a limit (complexity 12, depth 3, 400 lines, 4 expects, 0 clones, vulture 60 %),
  or add a suppression comment (`eslint-disable`, `@ts-ignore`, blanket `# noqa`, `# type: ignore`). Fix the code
  or make the type tell the truth.
- Export only what another module imports. A function or export that only a test uses is dead.
- Before merging, run `npm run mutation:report -- origin/main` and resolve every survivor it prints: kill it with
  a test, delete the statement it proves has no effect, or mark it equivalent with the reason.

### Code audit (in the gate)
`npm run audit:code` (`scripts/audit/run-all.sh`) runs the detectors in `scripts/audit/`: renamed and near clones
that jscpd misses, re-implementations of helpers the platform already has, and the dead-code detectors. Each is also
a `scripts/validate.sh` step (`validate-affected.sh` picks the ones whose inputs changed), so a new finding fails
the gate: fix it, or allowlist it in `scripts/audit/allowlists/<tool>.json` with a reason. `npm run test:audit` runs
their own tests and `npm run lint:audit` lints them (both gate steps too). See [docs/code-audit.md](docs/code-audit.md).

### Code the SPA shares with the stream Lambda
The assistant's wire contract, plan contract and several approval-card bounds live once, in the stream Lambda
(`voc-datalake/lambda/stream/src`). The SPA imports them through the `@stream/*` alias
(`voc-datalake/frontend/streamSource.ts`, with `zod` deduplicated so the bundle keeps one copy) instead of keeping a
mirrored copy pinned by a lockstep test. Those modules run in the browser, so the `browser-safe` block of
`lambda/stream/eslint.config.js` (`BROWSER_SAFE_FILES`) forbids Node built-ins, `@aws-sdk/*` and `@smithy/*` in them,
type-only imports included (the SPA type-checks them with only its own `node_modules`; `zod` is mapped to the SPA's
copy), and `lambda/stream/src/browser-safe.test.ts` fails when the SPA imports a stream module,
or a listed module imports a stream file, that the list does not name. When the SPA needs something the stream
module does not have (its own message, an SPA-only builder), put it in a small SPA module next to its users.

### Optional: AI review before push
`scripts/git-hooks/pre-push` reviews the diff you are pushing with three Kiro CLI agents (`.kiro/agents/`), run in
parallel on each chunk of the diff:

- `security-reviewer` checks the boundaries this platform has (per-resource authorization, public routes, MCP tokens,
  SSRF, PII, IAM) and also a tightening that would refuse a legitimate operation. A CRITICAL finding blocks the push.
- `quality-reviewer` checks logic, edge cases, contracts, error handling and missing tests for the behaviour that
  changed, not what `scripts/validate.sh` already enforces. A BLOCKING finding blocks the push.
- `first-principles-reviewer` asks whether each thing the diff adds needs to exist, already exists, or fixes only a
  symptom, and suggests deletions only. It is advisory: it never blocks.

A finding blocks only when it names a concrete trigger and an observable outcome. Warnings, missing tests, or a
review that did not finish ask before pushing (and block without a terminal). The hook skips itself when `kiro-cli`
is not installed, or with `SKIP_AI_REVIEW=1`. Git does not run it until you install it in your clone:
`cp scripts/git-hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push`. Its parsing of the agents'
output is tested by `node --test scripts/git-hooks/pre-push.test.mjs`.

### Review gate before commit
The rule for every commit is the review gate, in this order (the pre-commit hook below enforces the record of it once
installed):

1. `npm run validate` is green.
2. At most three review rounds, each on exactly the change about to be committed: `AI_REVIEW_CACHE=0 npm run
   validate:tenets`, `AI_REVIEW_CACHE=0 npm run validate:commit`, and the `security-reviewer`, `quality-reviewer` and
   `first-principles-reviewer` agents (`.kiro/agents/`). Every blocking finding is fixed (or rejected with a reason);
   a round with no blocking finding ends the loop. The two `validate:` reviews read the working tree (unstaged and
   untracked files included) against the merge base, so stage the whole change first and leave nothing else in the
   working tree. A review that printed `skipped:` (a timeout, no CLI, no base to diff against) did not run, even
   though it exited 0: rerun it before its round counts. If the third round still has a blocking finding, there is
   no GO for this change: split or rework it and start the gate again at round 1.
3. One fresh agent, which took no part in the rounds, answers GO or NO-GO. Only a GO is committed; after a NO-GO,
   rework the change and start again at round 1.
4. The GO is recorded: write the record as JSON outside the working tree (or in an ignored path) and run `node
   scripts/ai-review/gate.mjs record --file <record.json>`. `record` refuses while the working tree differs from the
   index: an unstaged change to a tracked file (`git diff --quiet` fails) or an untracked file that is not ignored
   (`git ls-files --others --exclude-standard` lists it). So the tree the reviews read is the tree that is committed.

The record is `{ tree, rounds: [{ round, reviews: [{ reviewer, findings: [{ id, severity, summary,
outcome, note }] }] }], go: { verdict, reasons }, recordedAt? }`: `tree` is `git write-tree` of the index (what is
staged), `reviewer` one of `tenets`, `commit`, `security`, `quality`, `first-principles` (each exactly once per
round), `severity` one of `blocking`, `should-fix`, `nit`, `outcome` one of `fixed`, `rejected`, `deferred`.
`record` refuses it unless the verdict is GO with its reasons, there are one to three rounds numbered in order, every
round but the last had a blocking finding and the last has none, no blocking finding is deferred, a rejected one has a
note, `tree` is the tree staged now and the working tree is the index. It always records the staged tree (it takes no
`--tree`). It keeps the record in `.cache/ai-review/gate/<tree>.json` (ignored by git; `recordedAt` is filled in when
absent). `gate.mjs check` exits 0 when the staged tree has a GO record and 1 with what to do when it has none;
`gate.mjs show` prints the record and the line for the commit message (`review gate: 2 rounds, GO`); both
take `--tree <hash>` to look at another tree's record. Stage anything after the record and the tree changes: review that change and record again.

`scripts/git-hooks/pre-commit` calls `gate.mjs`'s `main(['check'])` (with `NODE_OPTIONS` unset) and lets the commit
through only when it answers 0: a gate that exits without answering, a missing node or a missing `gate.mjs` is a
refusal. It judges the index git commits, so `git commit -a` with changes that were not staged at review time is
refused. No environment variable skips it; only git's own `git commit --no-verify` does. Git does not run it until
you install it in your clone, into `core.hooksPath` when that is set, else the clone's hooks directory (run from the
top level, where a relative `core.hooksPath` is resolved):

```bash
hooks=$(git config core.hooksPath || git rev-parse --git-path hooks)
cp scripts/git-hooks/pre-commit "$hooks/pre-commit" && chmod +x "$hooks/pre-commit"
```

The hooks directory belongs to the clone and is shared by all its worktrees, so the hook then checks every commit in
every worktree and on every branch, as intended: a branch whose checkout has no `scripts/ai-review/gate.mjs` is refused
(fail closed). Tested by `node --test scripts/ai-review/gate.test.mjs scripts/git-hooks/pre-commit.test.mjs` (both
are `validate.sh` steps).

The record is written by you or your agent and lives only on your machine: the gate checks its shape and that it names
the staged tree, not that the reviews it lists ran or found what it says. The hook runs the `gate.mjs` of the
checked-out tree, so a local edit to that file changes the check. CI does not see any of it.


## Finding contributions to work on
Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.


## Code of Conduct
This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.


## Security issue notifications
If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.


## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.
