# Engineering gate packs

The deterministic half of the [quality gate](../../../../docs/autonomous-engineering.md#the-quality-gate): what an
autonomous engineering agent's committed change must pass in the target repository before any reviewer reads it.
The step itself (detection, the runner, review rounds, the final go, the gate record) is
[`lambda/engineering/quality_gate/`](../../../lambda/engineering/quality_gate/).

One pack per language (7.50.00): a repository gets exactly the packs of the languages it has, so a TypeScript-only
repository gets `typescript` alone and a Rust-only one `rust` alone. A flow stored before 7.50.00 may still name
`python-ts` or `rust-ts`; each stands for its two packs (`packs.ALIASES`).

| Pack | Language | Steps (in kind order, per root; each only when the repository uses the tool) |
|---|---|---|
| [`python`](python/manifest.toml) | Python (a marker, or test files alone at the root) | the gate's own virtual environment (`py.venv`), then `pip install` of `requirements(-dev).txt` into it (wheels only, from PyPI; pytest alone for a root without a marker); `ruff check`, `ruff format --check`, vulture, every test asserts, pyright (npm's or PyPI's), mypy, pytest (no test collected fails), each on that environment's interpreter |
| [`typescript`](typescript/manifest.toml) | TypeScript | `npm ci` / `pnpm install --frozen-lockfile` (no install scripts); eslint, knip, jscpd, tsc (each program), `npm test` or `vitest run` |
| [`rust`](rust/manifest.toml) | Rust | `cargo fetch` (`--locked` with a lock file); `cargo fmt --check`, `cargo clippy -D warnings`, the file-length check, `cargo test` (offline; at least one test must run) |
| [`java`](java/manifest.toml) | Java | `mvn dependency:go-offline`; `mvn --offline verify` (at least one test must run); `gradle check --offline` (`buildHealth` where the build has it); every test class ran |

What each pack runs follows the owner's briefs ([`briefs/`](briefs/): `python-ts.md`, `rust-ts.md`, `java.md`), and
[`briefs/RECONCILIATION.md`](briefs/RECONCILIATION.md) lists every difference between a manifest and its brief, fixed
or left, with why. They follow the quality gates this repository holds itself to (format, lint, types, tests, each a
hard stop with zero findings, and proof that each gate looked), adapted for running **inside a target repository**
instead of setting the gates up in one:

- **The repository's own gate first.** A repository a pack covers that has `scripts/validate.sh` runs that instead
  of the pack's checks, after the pack's dependency steps (it runs offline, like every check); a step uses the repository's own npm script (`lint`, `typecheck`, `test`) when it has one. A change
  whose diff (in any round) adds, edits or deletes `scripts/validate.sh` stops at a human decision point: the gate
  never lets a change rewrite the gate script it is judged by. A change can still weaken a check through the files
  that choose it (an npm `test` script, a lint config it deletes): the reviewers read that in the diff, and the
  plan (`plan`) lists every check that did not run and why.
- **Its own rules, never ours.** A step runs only where the repository adopted its tool (`when_any`: a ruff,
  eslint, pyright or mypy config, a test file). A change is judged against the rules the team chose; a lint the
  team never turned on is not the agent's to enforce.
- **Its own pins.** Lock files are honoured (`npm ci`, `--locked`, `--frozen-lockfile`); tools come from the
  repository's own dev dependencies (`npx --no-install`, `python -m ruff`), so the gate never fetches a tool the
  repository does not pin. `[image]` lists the toolchains the pack's agent image installs, `[tools]` the
  tools whose versions the gate records.
- **One dependency step, then offline.** `setup` steps are the dependency step: they fetch only what the lock or
  requirement files name, from the public registries in `network` (the repository's registry settings overridden),
  with install scripts off (`--ignore-scripts`, wheels only), and build nothing. No later step needs the network
  (cargo and Maven are told `--offline`), so the runtime gives it to the setup steps alone (the runner's
  `network` flag). Each round runs every root's setup first, before any repository code runs in it, on a checkout
  first put back to HEAD (`git reset --hard`, `git clean -ffdx`, as the agent), so nothing planted in it or written
  by an earlier round's code reaches the step with network; `LocalRunner` also gives each setup command a fresh
  HOME. pip runs isolated (`-I`, `--isolated`), pnpm without the repository's pnpmfile, cargo without its rustc
  wrappers. What lives outside the checkout (a cache, the gate's virtual environments) is the sandbox's to keep
  clean between commands.
- **Its own environment, never the image's.** Repository code cannot write the image's system locations, so no
  step installs there (7.54.00: the first live run's `pip install` into the image's site-packages failed with
  `Errno 13` and stopped the gate). The python pack makes a virtual environment per root (`py.venv`: `{base_python}
  -I -m venv --clear {venv}`, its pip the standard library's own, which reaches no registry; a setup step, since the
  runner gives the dependency step its registries only before any other repository code), outside the checkout
  (the gate hashes the checkout's tree) and writable by repository code (the images: `/home/code/.voc-gate/venvs`,
  `gate_tools.IMAGE_VENVS`); `{python}` is that environment's interpreter, so the dependency step installs into it
  and every later step runs against it. npm installs into the checkout's `node_modules` and its cache, cargo, Maven
  and Gradle into their homes under `/opt/voc/cache` (the images' `CARGO_HOME`, `-Dmaven.repo.local`,
  `GRADLE_USER_HOME`), all writable by repository code. A local plan with no environment (`plan(python=...)`, the
  local fake run) runs `{python}` as the interpreter it was given and skips `py.venv`. The image's Maven and Gradle run, not the
  repository's wrappers, which download a build tool from an address the repository chooses. Gradle has no fetch
  that runs no build script, so it runs offline against the image's cache and fails on a dependency the cache lacks.
  What the flags cannot stop (an index option, a URL or a local path inside a requirements file, a git dependency
  in a lock file, a `build.rustc` or a path toolchain the repository's cargo config names) is the dependency step's
  network allowlist and the sandbox's to contain, which are the runtime's. A Python repository with only a
  `pyproject.toml` gets no dependency step: installing it would build it.
- **Repository code never runs as the gate.** The checks run through the runtime's sandbox runner (a separate OS
  user, no credential, no network); the gate's own git command runs through the agent's runner, with hooks, file-system monitor,
  pager, external diff and every config but its own off. `{base_python}` is the sandbox's interpreter, never the
  gate's, and `{python}` the gate's virtual environment's, which repository code made.
  `LocalRunner` (the tests, a local run on a repository you trust) scrubs the environment to a short allowlist and
  gives every command a throwaway HOME.
- **A gate that looked at nothing fails.** `expect_output` (a test runner that ran no test; watched over the whole
  output, not only the tail the record keeps) and `empty_exit_codes` (pytest's 5) turn a vacuous pass into a
  failure, as does a repository where no check but a dependency install applies.
- **Monorepos.** A root is a directory holding a marker (`Cargo.toml`, `package.json`, `pyproject.toml`,
  `pom.xml`, …) with source files under it. A root that is a workspace (`workspace`: a Cargo `[workspace]`, npm
  `workspaces`, `pnpm-workspace.yaml`, Maven `<modules>`, a Gradle settings file, a uv workspace) checks its members
  through itself, once; a marker below any other root is a root of its own, so a tooling-only `package.json` at the
  top hides no app. A round checks the roots the change touches first (every root when it touches a shared file),
  then, once those pass, the rest: a round passes only on the whole tree.

## A manifest

Every key, on an illustrative pack (the real ones are linked above):

```toml
schema = "voc-gate-pack/1"
id = "example"              # the directory's name
name = "Example"
network = ["pypi.org", "files.pythonhosted.org"]   # the setup steps' registries

[image]                     # toolchain -> version the pack's image installs
python = "3.12"

[languages.python]          # a root: a directory with a marker and a source file under it
markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"]
extensions = [".py"]
workspace = [{ file = "pyproject.toml", contains = "[tool.uv.workspace]" }]   # its members are checked through it
root_globs = ["test_*.py"]  # no marker anywhere: the root is still a root when a file matches

[tools.python]              # its version is recorded in the gate record
version_argv = ["{python}", "--version"]

[[steps]]
id = "py.test"              # "<language>.<name>": steps with the same id in two packs must be identical
language = "python"
name = "pytest"
kind = "test"               # setup | format | lint | types | build | test (the order they run in)
when_any = [{ glob = "test_*.py" }, { glob = "*/test_*.py" }]   # file, glob or absent; contains, npm_script
argv = ["{python}", "-m", "pytest", "-q", "-p", "no:cacheprovider"]
timeout_s = 3600
empty_exit_codes = [5]      # exits that mean "nothing was checked"; also expect_output, a regex
[[steps.prefer]]            # the repository's own command, when every condition holds
when = [{ file = "Makefile", contains = "test:" }]
argv = ["make", "test"]
```

A step fails on an exit code other than 0, a timeout, a missing tool, or a sign that it checked nothing; a failing
`setup` step stops the rest of the plan; an unknown key is refused when the pack loads. `{venv}` is a root's
virtual environment, `{base_python}` the sandbox's interpreter (7.54.00).

When no check judged the code, the gate STOPS rather than says NO-GO, with one of its own reasons (`packs.STOPS`,
the bundle's `gates.stops`): `setup_failed` (a setup step failed, so nothing ran after it), `nothing_checked` (the
packs planned no check) or `tool_missing` (every check that did not pass found its tool missing). The gate runner's
record is STOPPED with that reason (the harness takes it from `run_gate`, never the model), and its task goes to a
person: a stopped gate is never a reason to revise the change. Only a NO-GO, a check that failed on the code, starts
a revision round. Adding a language is adding
a pack: a directory with its `manifest.toml` and two fixtures under [`test/fixtures/`](test/fixtures/README.md).
The packs need no scripts of their own today: every step is one command of the repository's toolchain.

## Running it

From `voc-datalake/lambda` (the agent images keep these packs at `/opt/voc/gates`, `packs.default_packs_dir()`), on a committed
checkout:

```bash
python -m engineering.quality_gate plan  --repo <checkout> [--changed <file of paths>] [--python <sandbox python>]
python -m engineering.quality_gate check --repo <checkout> [--changed <file of paths>]
python -m engineering.quality_gate gate  --repo <checkout> --input <change.json> [--markdown <pr-section.md>] \
                                          [--fresh-checkout]
```

`gate` reads `{"task", "diff", "review_guide", "authors", "changed_paths", "params"}` and runs the whole gate
review-only (no reviser: the first blocking round stops it for a person); the flows pass their fixer or builder as
the reviser. `--fresh-checkout` puts the checkout back to HEAD before each round, deleting untracked and ignored
files: the runtime's gate checkout always runs that way; leave it off on your own working copy. These commands run
the checks as their own user: on a repository you do not trust, run them only where the runtime's sandbox runs the
checks. Their tests: `voc-datalake/lambda/engineering/quality_gate/test/`.
