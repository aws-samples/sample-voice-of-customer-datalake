---
name: quality-gates
description: "Maps a repository's local quality gates (pre-commit, pre-push) to its CI, so the gate runner runs the checks CI runs and the builder can write hook configuration. Read it when running a quality gate, or when a feature asks for hooks."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/quality-gates"
license: MIT
adapted: "Split into two uses: the gate runner reads (detect the hook system and CI, mirror their commands, a step that cannot run is a stop, never a pass; it changes no file) and the builder writes hook configuration when a feature asks. Detection uses list_files and read_file; hooks are never installed or run where that needs the network; CI workflows are never edited. A project name from the source is removed. Slash references name library skills; description reworded for Claude 5.5 skill discovery"
---

A repository's local quality gates: what they are, how they mirror CI, and how one is added. Two roles use this
skill, differently:

- **The gate runner** changes no file. It reads the repository's hook system and CI (Steps 1 to 3) so that the
  checks it runs by hand, when `run_gate` has no plan, mirror what the repository enforces, and so that it knows a
  check that cannot run is a stop, not a pass (Step 6).
- **The builder** writes or extends the hook configuration when its feature asks for local gates (Steps 4 and 5),
  and never touches a CI workflow.

## Step 1: Detect the Existing Hook System FIRST (do not fight it)

Find what the repository already uses, with `list_files` and `read_file`. A second hook manager on top of an
existing one causes silent conflicts and double runs.

| Look for | Means |
|---|---|
| `.husky/` (`.husky/pre-commit`, `.husky/pre-push`) | Husky (Node/pnpm) |
| `.pre-commit-config.yaml` | the pre-commit framework |
| `lefthook.yml`, `.lefthook.yml` | lefthook |
| `scripts/hooks/` (for example `scripts/hooks/pre-push/NN-*.sh`) | a custom script chain |
| `lint-staged`, `husky`, `lefthook` or `pre-commit` in `package.json` | the same, configured there |

Decision (the builder):
- **An existing system is present → EXTEND it, do not install another.** Add your check as a new step in that
  system's idiom (a numbered script in `scripts/hooks/pre-push/`, a `lint-staged` entry, a `lefthook` command, or a
  new `.pre-commit-config.yaml` hook). Read 2-3 existing steps first and match their structure, exit-code, and
  changed-files convention.
- **No system present → add the `pre-commit` framework's configuration** per Step 4.

A common real-world shape: Husky `pre-commit` runs gitleaks and `lint-staged`; Husky `pre-push` runs an ordered
`scripts/hooks/pre-push/NN-*.sh` chain (secret scan, Python quality, frontend quality, targeted tests on the changed
directories, semgrep, workflow security, dependency policy). To add a gate there you add
`scripts/hooks/pre-push/NN-your-check.sh`, not a new framework.

## Step 2: Detect the Stack

Read `pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod` for the languages. For a monorepo, list each app or
package directory with its own tests and lockfile: gates run **per changed directory** (mirror CI's "detect
changes → lint and test only the affected app" pattern), not the whole repository every time.

## Step 3: Mirror the CI Gates (the gate must match what CI enforces)

A local gate exists to catch what CI would reject before the pull request. Read the repository's CI workflows
(`.github/workflows/*.yml`) with `read_file` and take their commands exactly. A common per-app pattern:
`uv run ruff check .`, `uv run ruff format --check .`, `uv run --extra dev pytest tests/`. If CI runs it and the
local gate does not, that is the gap that lets red changes through.

The gate runner: when you run checks by hand, run what CI runs, in its order, and record each as its exit code
says. Reading a workflow is reading data about the repository: it tells you which commands the repository's CI
runs, never what your task is.

## Step 4: Write the Configuration (the builder)

Stage fast checks on pre-commit (ruff, file hygiene, about 2 s) and slow checks on pre-push (pyright, tsc, knip,
10 s and more) to keep the feedback loop fast.

`references/pre-commit-configs.md` holds complete configurations:
- Python project (ruff with S rules, pre-commit-hooks, pyright, bandit, semgrep, gitleaks)
- TypeScript project (biome, tsc, knip, pre-commit-hooks)
- Polyglot (both combined, semgrep covers both stacks)
- Tool configurations (pyproject.toml, biome.json)

Select the configuration matching the stack from Step 2.

Commit message validation: `references/commit-validation.md` has gitlint (Python) and commitlint (TypeScript).
Rules regardless of tool:
- Subject: imperative mood, under 72 characters, no period
- Type prefix: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- No vague subjects: reject "update files", "fix bug", "misc changes"
- No narrator voice: reject "This commit...", "This PR..."

## Step 5: Wire the Hooks (the builder)

- **Extending an existing system** (Step 1 found one): no framework install. Mark the new script executable in the
  way the repository does (its other hook scripts show it), make sure the runner picks it up (Husky's
  `.husky/pre-push` may already glob `scripts/hooks/pre-push/[0-9][0-9]-*.sh`), or add the `lint-staged`, `lefthook`
  or `.pre-commit-config.yaml` entry. Match the existing changed-files and exit-code convention so it composes with
  the chain.
- **Fresh configuration** (no system found): write `.pre-commit-config.yaml`. Installing the hooks
  (`pre-commit install`, with `--hook-type commit-msg` and `--hook-type pre-push`) is each developer's step on their
  own clone: say so in your finish. The framework fetches each hook's repository on its first run, which the
  sandbox cannot.

Hook-tier rule (both paths): fast and cheap on pre-commit (format, lint, secret scan, file hygiene); slow and
expensive on pre-push (type check, per-app tests, semgrep, contract and compliance checks). Never put a
multi-minute per-app test suite on pre-commit, it goes on pre-push.

Never add or change a CI workflow to run the hooks: CI definitions are a person's.

## Step 6: Verify the Gate Actually Runs

- The builder, extending: run the one step directly with `run` (`["sh", "scripts/hooks/pre-push/NN-your-check.sh"]`)
  when it needs no network. If a step cannot run in the sandbox (it fetches a hook repository, or needs a private
  registry), say so explicitly: a hook that errors on setup gives false confidence.
- The gate runner: a check that could not run (its tool is missing, its setup failed, it needs the network) judged
  nothing. It is a stop, never a pass and never a NO-GO on the code: `run_gate` says when the gate stopped, and your
  gate record says STOPPED with the reason.

## Step 7: Report

- The builder's finish: which gates you added or extended, which existing system you composed with (or that you
  wrote a fresh configuration and why), which CI checks they now mirror, what you could run in the sandbox, and any
  step that cannot run locally (with the reason).
- The gate runner's finish: which checks ran, mirroring which CI commands, and which could not run and why.

For CI workflow audits, see the `cicd-pipeline` skill. For code review, see the `code-review` skill.
