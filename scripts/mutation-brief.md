# Mutation hardening — agent brief (one Python module or slice per agent; TypeScript jobs: see the last section)

Repo: VoC Data Lake. `voc-datalake/lambda` and `voc-datalake/plugins` are Python 3.12 Lambdas; the
tests are pytest. Steering in `.kiro/steering/*.md` applies. You get ONE module (or one line slice of a
big module), its existing test files, and the name of the new test file you create. Goal: every mutant
mutmut can make in your lines is killed by a test that asserts the exact behaviour, the test suite
contains no test that pins nothing, and the module carries no dead code.

## Hard rules
1. Work ONLY in your worktree (`cd <worktree> || exit 1` at the start of every command). Never touch
   the main checkout or another worktree. Your branch is already checked out.
2. Edit ONLY: your module, the test files listed as yours, and your new test file. Changes needed
   anywhere else (another module, a fixture in `conftest.py`, `scripts/mcp_gate.py` floors, any shared
   config) go into the report as "Integrator request: <file>: <exact change>: <why>".
3. If you own a SLICE that is not the file's last slice: add tests only in your new file; do not delete
   or edit existing tests (the last slice's owner prunes them). Never edit lines outside your slice
   except to delete code your slice proves dead (say so in the report).
4. No suppressions: no `noqa`, `type: ignore`, vulture allowlist entries, `pytest.mark.skip`. The one
   allowed marker is `# pragma: no mutate  <reason>` on a line whose mutant is EQUIVALENT (identical
   behaviour, e.g. a `>=` on a value that can never be equal) — justify each in the report; expect zero
   or one per module.
5. Never `git stash`, `reset --hard`, `checkout -- .`, `clean`, `rm -rf`. Don't kill processes you did
   not start. Never push. Never commit `*.bak`, `.mutmut-cache`, `html/`, `coverage_html/`.
6. Commit after every green step (small commits, `test(<stem>): …`, `refactor(<stem>): …`). A stop can
   come any time; uncommitted work is lost.
7. No behaviour change in the module except deleting code that nothing can observe (dead branches,
   unused parameters/functions, no-op statements). A deletion that changes an API response, a log line
   a test pins, or a DynamoDB write is a behaviour change — leave it and report it.

## Setup (from `<worktree>/voc-datalake`)
```
export PATH="$PWD/.venv/bin:$PATH" PYTHON_BIN="$PWD/.venv/bin/python"
bash scripts/mutate-python.sh [--lines <from>-<to>] <module.py> <test files...>
```
Paths are relative to `voc-datalake/`. The script runs your tests unmutated first (they must pass),
then mutmut, then `mutmut results`. `mutmut show <id>` prints one survivor's diff — only AFTER the run
finished (reading the cache during a run corrupts it). The runner is `pytest -x` on exactly the test
files you pass: pass only the files that exercise the module (the plan lists the files that import
it; add one you find, drop one that is unrelated) — the whole package suite per mutant is too slow.

Known mutmut 2.5 behaviour:
- "suspicious" = killed, but the test run was slow; count it as killed.
- A line with `f'{{{name}}}'` can crash mutmut's parser; apply that mutant by hand (edit, run tests,
  restore) and treat it like any other.
- `--lines` is inclusive; the hunk is read 0-based so the line just before your range may get mutated
  too — kill it or ignore it, do not edit outside your slice for it.
- An interrupted run leaves the mutant in the file; the script restores `<module>.bak`. If you abort by
  hand: `mv <module>.bak <module>` and `git diff` must be clean for the module.
- If a run of your slice takes longer than ~40 min, split it: run `--lines` on halves of your range.
  Put your NEW test file first in the runner list (a killed mutant stops at the first failing test).
- Pagination loops: a mocked table/client with `return_value` feeds an infinite-loop mutant forever and can
  eat all memory (MagicMock records every call). Use an exhaustible `side_effect=[page, ...]` so the mutant
  dies on StopIteration. The runner kills a run after MUTMUT_RUNNER_TIMEOUT (default 120 s) regardless.

## Long runs: detach and poll
A tool call is cut after ~30 min, and a cut foreground run is lost (or leaves a mutant on disk). Run every
mutmut job that may take more than ~10 min detached, then poll:
```
nohup bash scripts/mutate-python.sh --lines a-b <module> <tests...> > /tmp/<worktree-name>-run.log 2>&1 &
sleep 600; tail -5 /tmp/<worktree-name>-run.log      # repeat until "Results" appears
```
Keep each `--lines` range small enough to finish in ~30 min (≈ 150 mutants for a moto-backed suite), commit
after each range, and never start the next range before the previous one finished (one mutmut per worktree).
Parallelism: the round already runs one mutmut per agent (eight at once), and each mutant is a short
`pytest -x` on your few files, so do NOT add `-n` to the runner — worker start-up would cost more per
mutant than it saves. The per-mutant runner timeout is `MUTMUT_RUNNER_TIMEOUT` (default 120 s; a timed-out
mutant counts as killed); raise it for one run only if your files' unmutated baseline takes over ~30 s.
The standard does not change with any of this: 0 surviving mutants.

## Processes: only your own
Never run an unscoped `pkill -f "mutmut run"` (or `pkill pytest`): seven other agents run mutmut at the same
time and you would end their runs. Kill only PIDs you started — record `$!` when you launch, or match your own
worktree path: `pkill -f "/tmp/mut-1-N/.*mutmut run"`.

## What to do with each survivor
- A test can observe it → write the test in YOUR NEW FILE with literal expectations: the exact string,
  number, key, HTTP status, boundary value (`== 50` and `== 51`, not `> 0`), call arguments
  (`assert_called_once_with(...)`), order of items. No `assert result`/`assert mock.called`.
- Nothing can observe it → the statement is dead; delete it (and the parameter/function/import it makes
  unused), re-run ruff and vulture.
- Equivalent mutant → `# pragma: no mutate  <reason>` (rule 4).
Group the tests by behaviour (`class TestEveryRefusalNamesItsCause:`), parametrize over the literals,
and open the new file with a docstring that says what the mutation run found that the earlier tests
could not see (see `lambda/shared/test/test_category_config_mutation.py`).

## Pruning the existing tests (last-slice owner, or the whole-module owner)
After the run reaches 0 survivors, go through the module's existing test files and delete a test when
ALL of: it kills no mutant you can name (comment it out, re-run the module's mutants on the
survivors' ids or on the whole module if cheap — it must still be 0), it asserts nothing meaningful
(`scripts/check_tests_assert.py <file>` lists the ones with no assertion), or it is a weaker duplicate
of a test that stays. A test that pins behaviour (an error message, a boundary, a write) STAYS even if
it overlaps. Never delete a test to make a mutant "disappear". Fix the module's entries in this list of
silent tests if yours is among them: `lambda/aggregator/test/test_handler.py:1028`,
`lambda/api/test/test_integrations_security.py:921,928`, `lambda/api/test/test_manual_import_processor.py:139`,
`lambda/api/test/test_mcp_output_schema_conformance.py:2638`, `lambda/processor/test/test_handler.py:661`,
`lambda/shared/test/test_api.py:571`, `lambda/shared/test/test_cloudfront_signing.py:140`,
`plugins/_shared/test/test_circuit_breaker.py:95,168`.

## Gates before every commit (from `voc-datalake/`) — targeted, never the full validate
Agents do NOT run `scripts/validate.sh`: the integrator runs it ONCE on the integration branch, after
the round is merged and before the release commit. Yours are the gates for your own files:
```
ruff check <your module and test files>                       # every rule is enforced; no PENDING block remains
npx --prefix .. pyright --pythonpath .venv/bin/python <your module and test files>   # zero errors
python scripts/check_tests_assert.py <your test files>
bash scripts/lint-python.sh --dead-code --dead-code-tests     # vulture, both passes, must print nothing new
python -m pytest -q -o addopts= <your test files>
(cd .. && npx jscpd voc-datalake/lambda voc-datalake/plugins)          # duplication gate, threshold 0: "Found 0 clones."
```
jscpd: a clone between your new suite and an existing test file means the arrange block belongs in a
`*_fixtures.py` module next to the tests (project convention, e.g. `lambda/api/test/agents_handler_fixtures.py`,
`lambda/shared/test/instrumentation_fixtures.py` for the tracer-wrapper pin, `lambda/agents/test/document_node_fixtures.py`);
a clone inside your suite means a helper or a parametrize; a clone between your suite and the MODULE means
the test restates production code — import the constant instead. Fix every pair your files appear in.
pyright on tests: type a mock you call `assert_called_once_with` on as `MagicMock` (not the patched
function's type), guard `importlib.util.spec_from_file_location(...)` results with `assert spec and
spec.loader`, and annotate module-level fixtures' return types; never `# type: ignore`.
Once, before the final commit, the affected gates of your branch (from the worktree root; the prompt
gives the base and your share of the CPUs — eight agents run at once, so never more workers than that):
```
VALIDATE_PYTEST_WORKERS=2 bash scripts/validate-affected.sh kiro-voc
```
For a tests-only branch that is the Python group: ruff, vulture, pyright, check_tests_assert and the
WHOLE pytest suite in parallel (pytest-xdist, ≈ 4–6 min at 2 workers while the round runs), plus the
repo checks (version, gitleaks, jscpd). A change to the module itself adds the CDK suite. It stops at the
first failing step and prints that step's log tail; every step's log is under `.cache/validate/logs/`.
A test that fails only there and passes alone is shared state between tests (pytest-xdist runs them
in several processes in any order): fix the test (no fixed paths, no reliance on another test having
run) or, when the sharing is the point, mark the tests `@pytest.mark.xdist_group('<name>')`.
(`lambda/shared/test/test_document_versions.py::test_concurrent_first_reads_wait_and_return_the_same_persisted_identity`
uses 5–10 s thread timeouts and was seen to flake under heavy load — re-run it alone once before reporting it.) A
`lambda/api/test/test_mcp_*.py` file needs a `MODULE_FLOORS` entry in `scripts/mcp_gate.py`: report
the file name and its killed count as an Integrator request (do not edit the script).

## Report (final message, UNDER 3,000 characters)
```
MODULE <path>[:<from>-<to>] — branch <name>, last commit <sha>
Mutants: <total> → killed <n> (incl. suspicious <n>), survived <n>, no-mutate markers <n> (<reasons>)
New tests: <file>: <count>  | Existing tests deleted: <count> (<why, one line each or grouped>)
Dead code removed: <symbols, or none>
Behaviour changes: none | <list>
Integrator requests: <file: change: why> | none
Gates: ruff ok, check_tests_assert ok, vulture ok, pytest <n> passed (full suite: <n> passed)
Left: <what is unfinished and why, or nothing>
```

## CHANGELOG and version
Do NOT bump any version. Tests-only work needs no CHANGELOG bullet (the integrator records the round).
Add one bullet under `## [Unreleased]` → `### Changed` only when you deleted production code that an
operator could notice (never for defaults/guards nothing could observe).

# TypeScript (one job of one or more files of ONE package per agent)

Packages: `frontend` (`voc-datalake/frontend`, React + vitest/jsdom), `stream` (`voc-datalake/lambda/stream`,
the AI assistant Lambda, vitest/node), `cdk` (`voc-datalake` — `lib/`, vitest/node). The job lists its
targets (`file` or `file:<from>-<to>`), the existing specs YOU own (you may edit and prune them), the
specs another job owns (read-only), and a new spec name per target. Goal, same as Python: every mutant
Stryker makes in your targets is killed by a test that pins the exact behaviour, no test pins nothing,
no dead code. Hard rules 1–7 above apply unchanged (an "Integrator request" for anything outside your
files; `// Stryker disable` is the only marker, rule 4).

## Run
```
cd <worktree>/voc-datalake || exit 1
STRYKER_CONCURRENCY=2 bash scripts/mutate-ts.sh <package> <file>[:<from>-<to>] [more files...]
```
Paths are relative to the package dir (`src/...` for frontend/stream, `lib/...` for cdk). The script
runs Stryker (vitest runner, `perTest` coverage, only the specs vitest relates to your files), prints
one line per file and every open mutant as `[Survived|NoCoverage] file:line:col  Mutator  original → replacement`,
and exits 0 only at 0 open mutants. NoCoverage = no test even executes that code: as much a survivor.
- Stryker instruments your files IN PLACE while it runs: never edit them (or run tsc/eslint on them)
  until it finished. A killed run is restored by the script's EXIT trap; `git diff` must show only
  your own edits afterwards (a `stryMutAct_9fa48` in a file = restore it with `git checkout -- <file>`).
- Results are incremental per target set (`.cache/stryker/`): after a test edit, a rerun only re-tests
  mutants whose code or covering tests changed — iterate on ONE file (`mutate-ts.sh <pkg> <that file>`),
  then run the job's whole target list once at the end. After deleting tests, run once with `--force`.
- One Stryker run per worktree at a time. Long runs: `nohup … > /tmp/<worktree-name>-run.log 2>&1 &`
  and poll, as for Python. The first run of a job is planned to stay under ~20 min.
- No TypeScript checker (measured: +55 % time, no survivor removed), so a mutant that would not
  compile can survive. It is NOT equivalent: either the type already makes it impossible (then a test
  can still observe it at runtime — write it) or the code is dead.
- Processes: kill only what you started (`pkill -f "/tmp/mut-R-N/.*stryker"`), never all `vitest`/`stryker`.

## What counts as a pin
- Exact values: the rendered text (`getByText('Could not update the flag. Try again.')`), the accessible
  name (`getByRole('checkbox', { name: 'Fallback owner: ada@example.com' })`), attributes
  (`toHaveAttribute('title', '…')`), the call and its arguments (`toHaveBeenCalledWith('/users/vic/flags',
  { method: 'PUT', body: '{"memory_reviewer":true}' })`), both sides of a boundary, CDK template
  properties (`Template.fromStack(stack).hasResourceProperties('AWS::SQS::Queue', { … })` with the exact
  values), the stream's emitted events in order.
- Not a pin: `toBeTruthy()`/`toBeDefined()`/`toHaveBeenCalled()` without arguments, snapshot-only tests
  (`toMatchSnapshot`, inline snapshots of whole trees), asserting on implementation details (state
  setters, internal class names, the number of renders), `lib/app-baseline.test.ts`'s template hash
  (it synthesizes out of process and kills nothing; leave it alone).
- i18n: specs render the real English copy from `public/locales/en/*.json`, so a `t('key')` mutant dies
  by asserting the visible English text — one render test usually kills a whole component's keys.
- Repo conventions (copy them): `@testing-library/react` + `userEvent`, `renderWithQueryClient` /
  `createTestQueryClient` from `@test/query-client` (spy on the client for `invalidateQueries`),
  `vi.mock('../../api/client', …)` with a `vi.fn` fetch and `await import()` of the unit after the
  mock, the dev mock fixtures under `src/test/`; stream specs build events through the existing
  `*-fixtures.ts`; CDK specs use the stack fixtures in `lib/test-support/` (`*-stack-fixture.ts`) —
  never synthesize a new app per test when a fixture's template exists.
- Prefer adding to the namesake spec you own (`x.test.tsx` for `x.tsx`) when it already has the
  setup; otherwise the new spec the job names (`x.mutation.test.tsx`). Never duplicate a mock/factory
  block between two specs: jscpd (threshold 0) fails — move it to a `*-fixtures.ts(x)` next to them.
- Equivalent mutant: `// Stryker disable next-line <Mutator>: <reason>` on the line above (e.g. a
  `>=`/`>` on a value that is never equal), each justified in the report; expect zero or one per file.
  Never `Stryker disable all`, never a file-level disable.

## Ownership of specs
A spec belongs to exactly ONE job (the plan says which): only that job edits or deletes its tests.
A job that relies on a spec it does not own adds its tests in its own new spec. Before deleting a test
from a spec you own that also tests files of other jobs (the prompt lists them as "also run"), run
`mutate-ts.sh` on those files too and keep the test if it kills any of their mutants. Pruning: delete
a test only when it pins nothing (above) or is a weaker duplicate of one that stays, and the mutant
count of every file it touches stays at 0.

## Gates (from the package dir) — targeted, never the full validate
```
# frontend (voc-datalake/frontend)
npx tsc -b --noEmit --force && npx tsc -p tsconfig.test.json --noEmit
npx eslint --max-warnings 0 <your files and specs>
npx vitest run <your specs>
npx knip --no-progress && npx knip --no-progress --config ../../scripts/knip-production.mjs --production --strict
# stream (voc-datalake/lambda/stream)
npx tsc --noEmit && npx eslint --max-warnings 0 <files> && npx vitest run <specs>
npx knip --no-progress && npx knip --no-progress --config ../../../scripts/knip-production.mjs --production --strict
# cdk (voc-datalake)
npx tsc -p tsconfig.json --noEmit && npx eslint --max-warnings 0 <files> && npx vitest run <specs>
npx knip --no-progress && npx knip --no-progress --config ../scripts/knip-production.mjs --production --strict
# repo root
npx jscpd --fail-on-empty --reporters console --silent      # threshold 0: no output = no clones
```
The frontend `tsc` reads the stream Lambda's contract: never run it while a stream Stryker run is
active in the same worktree (you have one job, so this only matters if you started one by hand).
A frontend spec that adds a `fetchApi` call site needs its mock route (tech.md, `npm run check:mock`).
Once, before the final commit: `bash scripts/validate-affected.sh kiro-voc` from the worktree root.

## Report (final message, UNDER 3,000 characters)
```
JOB <id> (<package>) — branch <name>, last commit <sha>
<file>[:<range>]: mutants <n> → killed <n> (timeout <n>), open 0, disable markers <n> (<reasons>)   (one line per target)
New/changed specs: <file>: +<n> tests | Tests deleted: <count> (<why>)
Dead code removed: <symbols, or none>   Behaviour changes: none | <list>
Integrator requests: <file: change: why> | none
Gates: tsc ok, eslint ok, vitest <n> passed, knip ok, jscpd 0, validate-affected ok
Left: <what is unfinished and why, or nothing>
```

## Calibration (pilot, 12-core Mac, STRYKER_CONCURRENCY=2, three packages running at once)
| File | Mutants | Wall | Open after the run |
|---|---|---|---|
| frontend `src/utils/dateUtils.ts` (util) | 41 | 83 s | 2 |
| frontend `src/components/UserAdmin/UserFlagsPanel.tsx` (component) | 39 | 45 s | 16 → 0 (done in this pilot) |
| frontend `src/components/usePrototypeLinkRefresh.ts` (hook, 37 related specs) | 12 | 207 s | 3 |
| stream `src/attachments.ts` | 108 | 38 s | 22 |
| stream `src/assistant/runtime/memory-recall.ts` | 45 | 33 s | 9 |
| cdk `lib/utils/context.ts` | 21 | 32 s | 0 |
| cdk `lib/stacks/dlq-alarms.ts` (construct) | 116 | 359 s | 15 |
Whole-package sweep of the stream Lambda (`mutate-ts.sh stream --all`, concurrency 4, 81 min): 7,318
mutants, 2,756 open (38 %), 2 of 77 files clean. A partial CDK sweep (1,895 mutants, the 14 source-text
specs left out, so an upper bound) had 48 % open; it re-runs ~500 synth tests per static mutant, ~4 h for the package.
A run costs one dry run (10–60 s frontend, ~4 s stream, ~30 s cdk) plus ~0.5–1 s per mutant (frontend,
more for a widely imported hook), ~0.3 s (stream), ~3 s (cdk: module-level constants are "static"
mutants that re-run every related synth test). `scripts/mutation-plan-ts.mjs` holds the fitted model.
