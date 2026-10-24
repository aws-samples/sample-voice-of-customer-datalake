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
5. Send us a pull request, answering any default questions in the pull request interface.
6. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

GitHub provides additional document on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).


## Versioning and the changelog
Every change that lands bumps the version and adds an entry to [CHANGELOG.md](CHANGELOG.md) in the same
commit: **major** for a redesign or a breaking API/stack/data change, **minor** for new or changed
behaviour, **patch** for fixes, tests, docs and tooling. The changelog writes releases as `2.09.00`; the
three `package.json` files (root, `voc-datalake/`, `voc-datalake/frontend/`) carry the same number in
strict SemVer (`2.9.0`, via `npm version 2.9.0 --no-git-tag-version`). `scripts/check-version.mjs`, a
`validate.sh` step, fails when they disagree. Branches merged by someone else add their bullets under
`[Unreleased]` and the merger cuts the release. The full rules are in `.kiro/steering/changelog.md`.

## Quality gates
`npm run validate` (`scripts/validate.sh`) runs every gate: ruff, vulture (dead code), pyright, a check that every
pytest test asserts, tsc for each TypeScript program (all with `noUncheckedIndexedAccess`, specs included), ESLint in
each package (`voc-datalake/`, `frontend/`, `lambda/stream/`, sharing `eslint-rules/quality-gates.mjs`; specs linted
too, and `eslint-rules/` itself linted under the same rules), knip (default and `--production --strict`), jscpd over code and tests, the i18n audit (`npm run check:i18n` on its own: no missing, extra or empty locale keys, every source key in English; read-only — the frontend's `i18n:validate` also runs `i18next-parser`, which rewrites the locale files), a gitleaks scan of the
working tree (`scripts/gitleaks-tree.sh`; install gitleaks 8.30+, e.g. `brew install gitleaks`), CodeQL's
security-and-quality queries over JS/TS and Python with zero errors and warnings (`scripts/codeql.sh`; install the
CLI with `brew install codeql`; about 5 minutes; skipped on GitHub Actions, where code scanning runs the same
analysis on every PR), the code-audit detectors in `scripts/audit/` (dead code, renamed clones and re-implemented
helpers; one `audit: …` step each, plus their own tests and lint — [docs/code-audit.md](docs/code-audit.md#in-the-gate)),
pytest and vitest.
CI (`.github/workflows/quality-gates.yml`) runs that script and nothing else. Each gate allows zero findings.

### When to run what
- **Track, agent and mutation branches: the affected gates only.** `bash scripts/validate-affected.sh [<base>]`
  (base defaults to `kiro-voc`) maps the changed paths — committed, uncommitted and untracked — to the steps that
  matter for them, and `--explain` prints that mapping without running anything. While iterating, run the single
  tool you need (`ruff check <files>`, `pytest <test files>`, `npx vitest run <spec>`).
- **The integration branch: the full `scripts/validate.sh`, ONCE, just before the release commit** (after the
  tracks are merged). It is the backstop for anything the affected mapping misses, so it is never skipped.

### How validate.sh runs
The steps run in five parallel lanes — `py` (ruff, vulture, pyright, pytest with pytest-xdist), `tsc` (type checks,
knip, small node checks, most code-audit detectors), `lint` (ESLint, jscpd, gitleaks, `ts_reachability`), `test` (vite build, the synth-based audit detectors, then the CDK,
stream and frontend vitest suites), `sec` (CodeQL). The first failing step stops the other lanes and its log tail is printed; every run ends with a table
of each step's status and duration, and every step's full log is in `.cache/validate/logs/<run>/`. Options:
`--serial` (one step after another), `--keep-going` (let the other lanes finish after a failure), `--only <groups>`,
`--list`. `VALIDATE_PYTEST_WORKERS` sets the pytest-xdist worker count (default: CPUs − 4).

pytest runs in several processes in any order, so a test must not depend on another test having run or on a
fixed path; tests that must share one process are marked `@pytest.mark.xdist_group('<name>')`. Parametrize ids
must be the same in every process (no random values in an id: pass `ids=`). An order audit, on demand (not a gate,
and not installed in `.venv`, because installed it reorders every pytest run):
`uv pip install --target /tmp/pytest-randomly pytest-randomly==5.0.0 --no-deps`, then from `voc-datalake/`
`PYTHONPATH=/tmp/pytest-randomly .venv/bin/python -m pytest -o addopts= -p randomly -n 8` (the seed is printed;
replay that order with the same command plus `--randomly-seed=<seed>`).

Nothing is pending today. The mechanism stays for a NEW gate that arrives with existing findings: pend it in the
`PENDING` block of `voc-datalake/ruff.toml` or a `PENDING_*` map of the package's `eslint.config`, count it in
`scripts/quality-baseline.sh`, and move it into `validate.sh` in the change that brings it to zero. That list only
shrinks:

- Never add a pending entry, raise a limit (complexity 12, depth 3, 400 lines, 4 expects, 0 clones, vulture 60 %),
  or add a suppression comment (`eslint-disable`, `@ts-ignore`, blanket `# noqa`, `# type: ignore`). Fix the code
  or make the type tell the truth.
- Export only what another module imports. A function or export that only a test uses is dead.
- Before merging, run `npm run mutation:report -- origin/development` and resolve every survivor it prints: kill it with
  a test, delete the statement it proves has no effect, or mark it equivalent with the reason.

### Code audit (in the gate)
`npm run audit:code` (`scripts/audit/run-all.sh`) runs the detectors in `scripts/audit/`: renamed and near clones
that jscpd misses, re-implementations of helpers the platform already has, and the dead-code detectors. Each is also
a `scripts/validate.sh` step (`validate-affected.sh` picks the ones whose inputs changed), so a new finding fails
the gate: fix it, or allowlist it in `scripts/audit/allowlists/<tool>.json` with a reason. `npm run test:audit` runs
their own tests and `npm run lint:audit` lints them (both gate steps too). See [docs/code-audit.md](docs/code-audit.md).

### Optional: AI review before push
`scripts/git-hooks/pre-push` reviews the diff you are pushing with Kiro CLI agents. It blocks on critical findings and asks
about warnings; it skips itself when `kiro-cli` is not installed, or with `SKIP_AI_REVIEW=1`. Git does not run it until
you install it in your clone: `cp scripts/git-hooks/pre-push .git/hooks/pre-push && chmod +x .git/hooks/pre-push`.


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
