# Dependencies: updates, licenses, vulnerabilities

Four automated controls keep the dependency trees current and reviewable, and one report shows how far behind
the newest releases everything is. This page says what each one does, what makes it fail, and what to do when
it does.

| Control | Where | Runs | Fails on |
|---|---|---|---|
| Version updates | `.github/dependabot.yml` | Weekly (Monday 06:00 UTC) | Never; it opens pull requests |
| License gate | `.github/workflows/dependency-review.yml` + `.github/dependency-review-config.yml` | Every pull request | A changed dependency whose license is not allowed |
| Vulnerability audit | `.github/workflows/dependency-audit.yml` + `scripts/dependency-audit.mjs` | Pull requests touching dependencies, weekly, by hand | A known advisory above the bar (below) |
| Scheduled failure watch | `.github/workflows/scheduled-failure-watch.yml` + `scripts/scheduled-failure-watch.mjs` | After each scheduled run | Never; it opens and closes an issue |
| Freshness check | `scripts/dependency-freshness.mjs` (`npm run deps:freshness`) | By hand: weekly, and before starting a feature | Never by default (`--fail-on` makes it) |

Dependabot security alerts (repository setting) and CodeQL stay on as before; these controls add to them.
Every third-party action in `.github/workflows/` is pinned to a full commit SHA with a `# vX.Y.Z` comment,
and Dependabot updates both.

## Version updates (Dependabot)

Dependabot covers GitHub Actions, the six npm lockfiles (repo root, `voc-datalake/`, `voc-datalake/frontend/`,
`voc-datalake/frontend/e2e/`, `voc-datalake/lambda/stream/`, `tools/kiro-acp-bridge/`) and the Python
requirements files (`voc-datalake/requirements-dev.txt` and the four `voc-datalake/lambda/layers/*/requirements.txt`).

- One pull request per directory carries every minor and patch update together.
- **Major updates are not proposed** (`ignore: update-types: version-update:semver-major` on every ecosystem).
  A major changes an API or a default, so it is a deliberate upgrade: one major at a time, on its own branch,
  with the upstream release notes read and the full `bash scripts/validate.sh` run. Security updates still
  arrive, majors included: the ignore rule's `update-types` applies to version updates only. To see which
  majors are available, run `npm outdated` in a package directory or `pip list --outdated` in `voc-datalake/`.
- **Cooldown of 7 days**: a release is proposed only once it is a week old, so a malicious or broken release
  that is pulled within days never reaches a lockfile. Security updates are not delayed.

### Merging a Dependabot pull request

Every Dependabot pull request **fails `version: CHANGELOG ↔ package.json`** in the quality gates. That is
intended: every change on `main` bumps the version and records itself in `CHANGELOG.md`
(`.kiro/steering/changelog.md`). To merge one:

1. Read the update and its upstream release notes.
2. Check out the branch, add a patch release section under `## [Unreleased]` in `CHANGELOG.md` (a
   `### Changed` or `### Security` bullet naming what moved and why it matters to a deployer).
3. In the repo root, `voc-datalake/` and `voc-datalake/frontend/`, run `npm version <x.y.z> --no-git-tag-version`.
4. Run `node scripts/check-version.mjs`, push, and merge once CI is green.

Several Dependabot pull requests merged together take one bump.

## License gate

`actions/dependency-review-action` compares the dependency graph of the pull request with its base. A
dependency the pull request **adds or changes** must carry a license from `allow-licenses` in
`.github/dependency-review-config.yml`; anything else fails (default deny). Development dependencies are
judged too. Unchanged dependencies are not judged, and a dependency with no detectable license is reported
but does not fail.

The list is permissive licenses plus MPL-2.0 (consumed unmodified only), CC-BY-4.0 (data), OFL-1.1 (fonts)
and the Python Software Foundation license; the config file explains each. The repository itself is MIT-0.

### When the gate refuses a dependency

1. Look for an alternative under an allowed license. That is the usual answer.
2. If the package is needed, decide whether its license works for an MIT-0 sample that others deploy and
   modify. Strong copyleft (GPL, AGPL) in shipped code does not.
3. If it does, add the package to `allow-dependencies-licenses` as a purl (`pkg:npm/<name>`,
   `pkg:pypi/<name>`) with a comment: the license, where the package runs (shipped or development only), and
   why that is acceptable. The owner reviews that line in the pull request.

## Vulnerability audit

`scripts/dependency-audit.mjs` runs the same way locally and in CI:

```bash
python3 -m venv /tmp/pip-audit && /tmp/pip-audit/bin/pip install pip-audit==2.10.1
PIP_AUDIT=/tmp/pip-audit/bin/pip-audit AUDIT_PYTHON=python3 node scripts/dependency-audit.mjs
# --skip-npm or --skip-pip to run one half
```

| Tree | How | Fails on |
|---|---|---|
| npm production dependencies | `npm audit --omit=dev` per lockfile | high or critical |
| npm development dependencies | `npm audit`, minus the production findings | critical (high is reported only) |
| Lambda layer requirements | pip resolves for the Lambda target (CPython 3.14, arm64), then `pip-audit` | any known advisory |
| `requirements-dev.txt` | resolved for the host, then `pip-audit` | nothing (reported only) |

Development tools never ship to a Lambda or to the SPA bundle, so a high advisory in one should not block
unrelated pull requests; a critical one still runs on every contributor's machine and in CI, so it fails.
`pip-audit` reports no severity, so a layer advisory always fails. An audit that cannot run (network error,
broken lockfile, requirements that do not resolve) fails too: an empty result must mean "nothing known".

The audit only knows published advisories. Open ranges (`>=`) in the requirements files are audited at the
version pip resolves today, which is what a fresh layer build installs, not necessarily what is deployed.

### When the audit finds something

**Fix it** when a fixed release exists: update the direct dependency, or for a transitive npm one, the parent
that pulls it in (`npm update <pkg>` in that directory, or an `overrides` entry when the parent has not
released). For Python, raise the pin or floor in the requirements file. Then bump and record it as a
`### Security` bullet.

**Ignore it, reviewed and dated,** only when the vulnerable code cannot be reached (for example, a server
feature of a library we only use as a parser) or no fix exists yet. Add an entry to
`.github/dependency-audit-ignore.json`:

```json
{
  "id": "GHSA-xxxx-xxxx-xxxx",
  "package": "example-lib",
  "reason": "Only the CLI is affected; we import the parser module, never the CLI.",
  "expires": "2026-12-31"
}
```

`id` is the advisory id the audit printed (GHSA, PYSEC or CVE; a Python finding also matches on its aliases),
`reason` says why the risk does not apply or what is blocking the fix, and `expires` is at most 90 days ahead.
An expired or malformed entry fails the audit, so every ignore is looked at again. An entry that matched
nothing is printed as `UNUSED`: delete it.

## Freshness check

Dependabot proposes minor and patch updates only, and covers neither the Lambda runtimes, the Node / Python
lines nor the binaries pinned in the workflows. `npm run deps:freshness` (from the repo root, after `npm ci`
in each package so `npm outdated` can read the installed trees) lists everything that is behind its newest
release:

| Area | Compared | With |
|---|---|---|
| `npm` | every package of the six lockfiles (root, `voc-datalake`, `frontend`, `frontend/e2e`, `lambda/stream`, `tools/kiro-acp-bridge`) | the npm registry's `latest` (not the in-range `wanted`) |
| `pip` / `pip floor` | each `==` pin, and each `>=` / `~=` floor, in the four Lambda layers and `requirements-dev.txt` | PyPI. A floor is only informational: a fresh layer build already installs the newest release it allows |
| `Lambda runtime` | every `Runtime.PYTHON_3_x` / `Runtime.NODEJS_x_X` in `voc-datalake/lib` | the newest runtime the installed `aws-cdk-lib` knows |
| `toolchain` | `engines.node`, `.python-version`, the workflows' `node-version` / `python-version` | the newest Node LTS line and Python line (endoflife.date) |
| `GitHub Action`, `workflow tool` | each SHA-pinned `uses:` (its `# vX` comment) and `GITLEAKS_VERSION`, `ACTIONLINT_VERSION`, `ZIZMOR_VERSION` | the repository's latest GitHub release (`GITHUB_TOKEN` or `gh auth token` raises the API limit) |

Each line is classed `major`, `minor` or `patch`, majors first. Majors are upgraded deliberately, one at a
time on their own release branch (the reason Dependabot ignores them). A newer Python line than the Lambda
runtime does not mean Lambda supports it yet: the `Lambda runtime` line is the one that says so.

`--json` prints the findings as JSON; `--fail-on major|minor|patch` exits 1 when a finding at or above that
level exists. Exit 2 means a check could not run (no network, a directory without `node_modules`); it is
listed under **Not checked**, so a short report never hides an unchecked area.

## Scheduled failure watch

A scheduled run has no pull request and no author, so nobody is notified when it turns red. After every
scheduled run of a watched workflow (today, `dependency audit`), the watch:

- opens an issue titled `Scheduled workflow failing: <workflow>` when the run failed or timed out, or
  comments on the open one;
- comments and closes the issue when a later scheduled run is green.

Pull-request, push and manual runs never touch the issue. To triage, open the run linked in the latest
comment. For the audit, follow the section above. A manual run (workflow_dispatch) shows whether a fix on
`main` worked, but only the next green scheduled run closes the issue. To watch a new scheduled
workflow, add its `name:` under `workflow_run.workflows` in `scheduled-failure-watch.yml`.
