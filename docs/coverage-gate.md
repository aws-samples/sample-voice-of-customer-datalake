# Per-file coverage gate

Every production file of the three test suites (Python, frontend, stream Lambda) must reach a minimum **line
coverage of 80 %**, except the files a suite's baseline lists, and a baselined file may not lose coverage. The
baselines only ever shrink. `scripts/validate.sh` checks it right after each suite runs, in the same step.

## Why

Before this gate, coverage could fall without anyone seeing it: the pytest step ran with `--no-cov`, and the vitest
configs had no thresholds. A total percentage would not help much either: one new, untested file hides behind
thousands of well-tested lines. A per-file floor makes every new file carry its own tests, and the baseline keeps
the handful of files that were under the floor when the gate started from getting worse while they wait for tests.

## What is measured

| Suite | Report | Measured files | Not measured |
|---|---|---|---|
| Python (`voc-datalake/`) | coverage.py JSON, statements | `lambda/`, `plugins/` | tests (`test/`, `tests/`, `test_*.py`, `*_test.py`, `conftest.py`), `plugins/_template/`, `lambda/layers/` (`scripts/coverage/python.coveragerc`) |
| Frontend | vitest v8 `json-summary`, lines | `frontend/src/**/*.{ts,tsx}` | specs, `*-fixtures.*`, `__fixtures__/`, `src/test/`, `*.d.ts`, `main.tsx` (the `coverage` block of `frontend/vitest.config.ts`) |
| Stream Lambda | vitest v8 `json-summary`, lines | `lambda/stream/src/**/*.ts` | `*.test.ts`, `*-fixtures.ts`, `__fixtures__/` (the `coverage` block of `lambda/stream/vitest.config.ts`) |

The frontend and stream configs list every source file (`coverage.include`), so a file no test imports reports
0 % instead of disappearing from the report. A file with nothing to measure (types only, an empty `__init__.py`)
is skipped.

## The floor

The floor is set once per suite in `scripts/coverage/suites.json`. Like every gate value
(`eslint-rules/quality-gates.mjs`, max-lines, complexity), it belongs to the maintainers: never lower it to make a
change pass.

It was chosen from the per-file line rates measured when the gate was introduced:

| Suite | Files | Median | p25 | < 50 % | < 60 % | < 70 % | < 80 % |
|---|---|---|---|---|---|---|---|
| Python | 389 | 100 % | 98.3 % | 1 | 1 | 1 | 2 (0.5 %) |
| Frontend | 980 | 100 % | 95.0 % | 19 | 41 | 62 | 88 (9.0 %) |
| Stream | 141 | 100 % | 100 % | 0 | 0 | 1 | 1 (0.7 %) |

The rule was "80 % unless that baselines more than about 40 % of a suite's files". No suite comes close, so all
three use 80 %.

## What fails

`scripts/coverage/check-per-file-coverage.mjs` exits 1 when:

1. **A file not in the baseline is below the floor.** Add tests until it reaches the floor. A new file and a
   renamed file are both new paths to the gate: a renamed file must reach the floor too.
2. **A baselined file fell below the rate recorded for it** (by more than 0.1 point). Restore or add its tests.
   The 0.1 point absorbs the small moves a refactor of a large file makes; rates are recorded truncated to two
   decimals, so no rounding can trip it.
3. **A baseline row is stale**: the file reaches the floor now (it graduated), is gone from the report (deleted,
   renamed, no longer measured), or has nothing to measure. Run the refresh below and commit the shorter file.
   A **local** `scripts/validate.sh` deletes a graduated row itself (`--prune-graduated`), names it and passes, so
   the shorter baseline goes into the commit before the push; on GitHub Actions the step never edits files, and a
   graduated row still fails there. The 80 % floor is unchanged: no file is ever asked for more.

It exits 2 (cannot run) on any malformed input: a missing, unreadable or wrongly shaped report, a report with no
files, a report path outside the repository, a malformed, unsorted or duplicated baseline row. It fails closed.
A failing test run writes no coverage report (vitest's default; the step stops at the failed pytest run), and
each step deletes the previous report first, so the check never reads an old one.

## Refreshing a baseline (shrink only)

After a suite ran with coverage (the gate step, or the commands in `scripts/coverage/init-baselines.sh`):

```bash
node scripts/coverage/check-per-file-coverage.mjs --suite python --update-baseline     # or frontend, stream
```

It deletes the stale rows and copies every other line verbatim. It can never add a path or rewrite a rate; there
is no way to "accept" a new file under the floor.

## Creating the baselines

The baselines in `scripts/coverage/baselines/` (`python.txt`, `frontend.txt`, `stream.txt`) are created once.
To re-create them (for example after merging several branches that moved coverage), delete the ones to re-create
on purpose, so the decision shows in the diff, then run:

```bash
rm scripts/coverage/baselines/python.txt scripts/coverage/baselines/frontend.txt scripts/coverage/baselines/stream.txt
bash scripts/coverage/init-baselines.sh            # or name suites: init-baselines.sh frontend
```

It runs the suites with coverage one after another (about 14 minutes on 12 cores: pytest about 9, frontend about
4, stream under a minute), then `--init` for each. `--init` refuses when the baseline exists, and nothing is
written when a suite fails.

## Tests that assert a time budget

A test that bounds its own running time (`elapsed < N`) measures the machine as much as the code. Coverage tracing
slows tight Python loops several times over, and on CI the 4-vCPU runner was once shared with the other gate lanes and
the other pytest workers. Such tests went over their bounds there with nothing wrong in the code (for example a
capacity test bounded at 6 s that took 9 s, and a store test bounded at 0.25 s that took 0.33 s).

So a test that bounds its time is marked `@pytest.mark.timing` (on the test, its class or the module's
`pytestmark`), and the gate treats it differently:

- `conftest.py` adds `no_cover` to it, so it runs untraced wherever it runs.
- The `pytest` step of `scripts/validate.sh` leaves it out of the parallel, traced run (`-m "not timing"`) and runs
  every `timing` test afterwards in ONE process, untraced (`-p no:xdist --no-cov -m timing`).
- CI runs each `validate.sh` lane as its own job (`--lane py`, …), so the `pytest` step, the separate timing run
  included, has the py job's runner to itself (its lane runs one step at a time) with 4 workers. Locally the lanes
  run together; `--pytest-first` gives pytest the machine to itself first when a local run is loaded.
- `voc-datalake/scripts/check_timing_tests.py` (the `check_timing_tests` step) fails on a test that reads `time.perf_counter`,
  `monotonic` or `process_time` (directly or through a helper in its module) and asserts an ordering, unless it is
  marked.

A bound must still leave room for a slow, shared machine: a few times what a laptop measures, and well inside the
real limit the test protects (the capacity routes: 10 s of CPU against API Gateway's 29 s). A test proving that a slow
call was NOT made gives that call a cost the answer cannot reach by accident (the quota store's stand-in takes 1 s per
call). A timing test's own lines are not traced, so its code must be measured by the suite's other tests; if a file
falls under the floor, add a behaviour test, never a looser bound.

The frontend's equivalent: `findBy*` / `waitFor` wait up to 5 s (`src/test/setup.ts`), not testing-library's 1 s
default, so a dialog that mounts slowly on a loaded runner is not a failure.

## Cost

Measured on 12 cores with other work running, so read the numbers as ratios: pytest (8 xdist workers) 417 s
without coverage and 531 s with it (+27 %, HTML and JSON reports included); frontend 227 s and 253 s (+11 %);
stream 13 s either way. Coverage runs inside the existing test steps, so no suite runs twice. pytest-cov combines
the data of every xdist worker before it writes the report.

## Limits

- Lines and statements only, not branches.
- It judges only what the reports list; what is measured is decided by the include and exclude settings named
  above, so an over-broad exclude would hide a file. Exclude patterns are reviewed like gate values.
- A rate says code ran under a test, not that the test checked it. The mutation programme
  (`scripts/mutation-brief.md`) is the tool for that.
