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
From the repository root (Node.js 22.18+ or 24.11+, Python 3.12+ for the local tooling (the Lambdas run Python 3.14), Docker or Finch for layer builds):

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
