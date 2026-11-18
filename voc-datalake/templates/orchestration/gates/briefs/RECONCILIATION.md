# The gate packs against the owner's briefs (7.50.00)

The three briefs here are the owner's (`python-ts.md`, `rust-ts.md`, `java.md`). They are the source of truth for
what each pack runs. A brief sets the gates up **in** a repository: configs, pinned installs, a `scripts/validate.sh`.
A pack runs in a **target** repository the agents change, which works differently:

- it runs a tool only where the repository adopted it (`when_any`);
- it runs the repository's own `scripts/validate.sh` in place of its steps when there is one;
- every step but the dependency step runs offline.

So a repository set up from a brief is gated by its own `validate.sh`, and the pack's steps matter for repositories
without one.

This file lists every difference between each pack's `manifest.toml` and its brief, in tools, versions, steps and
failure messages. Each entry is fixed in the manifest or left, with the reason. Since 7.50.00 the two-language packs
are split per language: `python` and `typescript` come from `python-ts.md`, `rust` and `typescript` from `rust-ts.md`,
and `java` from `java.md`. `python-ts` and `rust-ts` stay as aliases of their two packs, for stored flows.

**The copies of the briefs** are the owner's text as staged, scanned again before commit. No secret, account id,
internal host, internal tool name, person or local path was found. One word changed: in `rust-ts.md`, an example
argument that looked like a private project's name became `src`. The meaning is unchanged: jscpd's option swallows
the next argument.

**Failure messages.** voc-gate-pack/1 has no key for a step's failure output, and the briefs' "must fail with" texts
are the tools' own output, which the gate record already keeps (the tail of each check). So none of them is copied.
Where a brief names a check (`vulture: production code`, `every test asserts`, `every test class ran and none was
skipped`), the step's `name` is that name.

## python (from python-ts.md)

| Difference | Fixed or left |
|---|---|
| `[image] python = "3.12"`: the brief's 3.12; the Python image is 3.14 today | **Left in the manifest (the brief's 3.12)**. The image must move to `python:3.12-slim` in the runtime work's image rebuild (wheels-only installs of older pins find cp312 wheels). |
| The markers had no `requirements-dev.txt` (the sandbox has it, with `pyproject.toml`) | **Fixed**: `requirements-dev.txt` is a marker. |
| The brief installs into the interpreter's own site-packages, which the sandbox's repository code cannot write (7.54.00: the first live run's `pip install` failed with `Errno 13` on the image's `/usr/local/lib/python3.12/site-packages`, and the gate stopped) | **Fixed**: `py.venv` (a setup step, before the install) makes a virtual environment per root outside the checkout with the sandbox's interpreter (`{base_python} -I -m venv --clear {venv}`); `{python}` is its interpreter, so `py.install` installs into it (still `-I`, `--isolated`, wheels only, PyPI) and every later step runs against what it installed. |
| A repository of test files with no marker was no Python root | **Fixed**: `root_globs = ["test_*.py", "tests/test_*.py"]`; its dependency step installs `pytest==8.4.2`, the brief's pin (a new `absent` condition says "no marker file"). |
| pyright comes from npm (`npx pyright --pythonpath`), not PyPI | **Fixed**: `py.pyright` prefers `npx --no-install pyright --pythonpath {python}` when `package.json` names pyright. A setup step `py.node-tools` runs `npm ci` (no scripts) when the lock file holds pyright. `node = "24"` and `registry.npmjs.org` join the pack. The Python image needs Node 24 (the runtime work's image rebuild). |
| vulture, two passes (production, then test support) | **Fixed**: `py.vulture` (`scripts/lint-python.sh --dead-code`, or `python -m vulture` with `[tool.vulture]`) and `py.vulture-tests` (`--dead-code-tests`), each only where the repository has that script or config. |
| `scripts/check_tests_assert.py` (every test asserts) | **Fixed**: `py.tests-assert`, where the repository has the script. It reads `git ls-files`, so the sandbox needs git. |
| pytest 8.4.2, ruff 0.15.11 and the other tool pins | **Left**: a target repository pins its own tools (its requirements file), and the gate never adds one. The one exception is pytest for a markerless root. |
| `mutmut==2.5.1` in the brief's requirements has no wheel, so a wheels-only dependency step fails on it | **Left (brief)**: the manifest cannot express it, and installing from sdists would run setup code. The brief should keep mutmut in a requirements file of its own. Until then, a repository that copies the brief's `requirements-dev.txt` stops at its dependency step. |
| Dev dependencies in `[dependency-groups].dev` (pyproject) get no install | **Left**: `pip install --group` needs pip 25.1 or later in the image, unverified. A repository with `requirements-dev.txt` is installed. |
| `ruff check` over the brief's Python directories against `ruff check .` | **Left**: the same files under the repository's own `extend-exclude`. |
| `py.format`, `py.mypy` (not in the brief) | **Left**: gated on the repository's own config, so they add no rule. |
| Mutation testing (mutmut) | **Left**: a report in the brief, not a gate. |

## typescript (from python-ts.md and rust-ts.md)

| Difference | Fixed or left |
|---|---|
| A TS-only repository was detected by both `python-ts` and `rust-ts`, so its record named two packs and its image needs pulled in PyPI, crates and Rust | **Fixed**: one `typescript` pack. A TS-only repository gets it alone; network `registry.npmjs.org`, image `node = "24"`. |
| knip (dead code), and knip `--production --strict` | **Fixed**: `ts.knip` (with `knip.json(c)` or a `dead-code` script) and `ts.knip-production` (a `dead-code:prod` script). |
| jscpd over code and tests, `--fail-on-empty` | **Fixed**: `ts.jscpd` (with `.jscpd.json` or a `duplication` script). |
| `vitest run` (the briefs define no `test` script) | **Fixed**: `ts.test` runs `npm test` when there is a test script, else `npx --no-install vitest run` with a vitest config. |
| One tsc per program (app and node configs) | **Fixed**: `ts.typecheck-app` and `ts.typecheck-node`, for `tsconfig.app.json` and `tsconfig.node.json`. |
| `eslint . --max-warnings 0`: neither brief blocks on warnings (a warning is a rule being measured before it blocks) | **Fixed**: `npx --no-install eslint .`, the repository's own severities. |
| Node 24 (python-ts) against Node 22 (rust-ts) | **Left at 24**: the image's Node. Both briefs run on it. |
| ESLint 9.39.5 against 10.14.0, sonarjs, vitest and stryker versions differ between the briefs | **Left**: the repository's lock file pins them, and `npx --no-install` runs its own. |
| `npm audit --omit=dev` (rust-ts) | **Left**: it needs the network, and only the dependency step has it. |
| Stryker, the yarn lock | **Left**: mutation is a report; there is no yarn in the images. |

## rust (from rust-ts.md)

| Difference | Fixed or left |
|---|---|
| The pack says 1.99.1; the Rust image floats `rust:1-slim` | **Left in the manifest (the brief's 1.99.1)**. The image must pin `rust:1.99.1-slim-bookworm` (the runtime work's image rebuild). |
| `[image]` named Node, which the Rust image lacks | **Fixed**: the rust pack has no Node. A Rust repository with TypeScript gets the typescript pack too, so its image needs Node 24 (the runtime work). |
| `rust-toolchain.toml` 1.99.1 makes rustup fetch the toolchain at the first cargo command, from a host the dependency step could not reach | **Fixed**: `static.rust-lang.org` joins `network`. |
| `scripts/rust-file-length.sh` | **Fixed**: `rust.file-length`, where the repository has it, with `expect_output` `rust-file-length: N files checked` (proof it looked). |
| `cargo fmt --check`, `clippy -D warnings`, `cargo test` (`test result: ok. N passed`) | **Already equal**. |
| ast-grep test and scan, cargo-shear, cargo-deny, gitleaks, zizmor | **Left**: the image has none of them, and shear and zizmor have no adoption marker, so running them would add rules. cargo-deny's advisory database needs the network. A repository with them runs them through its own `validate.sh`. |
| The brief's feature arguments to clippy and cargo test | **Left**: feature sets are each repository's own. |
| The brief's `validate.sh` runs `cargo deny check` and `npm audit`, which need the network | **Left (brief)**: a repository's own gate runs offline, so those two steps fail there. The brief's `validate.sh` should skip them when offline, or run them in CI only. |

## java (from java.md)

| Difference | Fixed or left |
|---|---|
| JDK 21 against the brief's Temurin 25; Maven and Gradle not pinned (the image has apt's Maven and no Gradle) | **Fixed in the manifest**: `java = "25"`, `maven = "3.9.16"`, `gradle = "9.8.0"`, and Gradle's version is recorded. **The image must follow**: Temurin 25, Maven 3.9.16 and Gradle 9.8.0, checksum-verified (the runtime work's image rebuild). Until it does, the brief's enforcer rule (`[25,26)`, Maven `[3.9.16,4)`) fails, and `java.gradle` reports a missing tool. |
| `gradle check` against `check buildHealth`, with no configuration cache | **Fixed**: `--no-configuration-cache` always, and `buildHealth` where the settings apply the build-health plugin. |
| ProGuard's own pom (the dead-code check) | **Fixed**: `java.fetch-proguard` fetches its dependencies in the dependency step. |
| `scripts/TestReports.java` (every test class ran, none skipped) | **Fixed**: `java.test-reports`, after the build, where the repository has it. |
| `JfrGate.java`, `dead-code.sh` | **Left**: the repository's own `validate.sh` runs them. |
| `./mvnw` and `./gradlew` | **Left**: a wrapper downloads its build tool from an address the repository chooses (the packs' rule); the image's Maven and Gradle run. A brief-set repository's own `validate.sh` calls the wrappers, which fail offline. The brief should fall back to `mvn`/`gradle` there. |
| `clean` before `verify` | **Left**: the gate's checkout is fresh. |
| `dependency:go-offline` may not fetch Error Prone's and NullAway's annotation-processor paths or Surefire's JUnit provider | **Left, unverified**: with no Maven in the sandbox here, it could not be measured. If a run's offline `verify` misses one, the fix is a pinned `dependency:resolve-plugins` setup step. |
