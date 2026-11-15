# Benchmark cases

The engineering agents' benchmark suite (docs/autonomous-engineering.md, "Evaluation"): tiny, fictional
repositories written for this sample, MIT licensed like the rest of this repository, each with a
`voc-bench/1` record (`case.json`) that says what an agent is asked and how its answer is checked. The harness
that loads and runs them is `voc-datalake/lambda/engineering/benchmark/` (`cases.py` reads and checks a case,
`runner.py` runs a candidate on each, `gate.py` decides a skill version's benchmark gate); its tests run every
case here for real. Every check needs only `python3` and `node`, installs nothing and uses no network.

| Case | Kind | Fixture | Check |
|---|---|---|---|
| `slug-cut-bug` | bug | a Python module with unittest tests | `python3 -m unittest`: a slug exactly `max_length` long loses its last word |
| `duration-hours-feature` | feature | a Node package with no dependencies | `node --test`: the acceptance tests for hours in a duration label |
| `pagination-review` | review | a Python module a pull request adds | three known findings (two `off-by-one`, one `unit-mismatch`), at most one other |
| `monorepo-units-bug` | bug | a monorepo: a Python package and a Node package | `node --test` in `packages/units`; `packages/stock` is protected |

Each case directory holds:

- `case.json`: the record (its id is the directory's name).
- `repo/`: the fixture, the repository a candidate gets a copy of. No links, no `.git`.
- `known-fix.diff` (bug and feature cases): the known fix, which only the tests' scripted candidates read. A
  candidate is given a copy of `repo/` alone, never this file or the record's check.

Each bug and feature case names the paths a patch may change (`allows`) and those it may not (`protected`).

Never run anything inside these directories: the runner copies a fixture to a temporary directory first.
