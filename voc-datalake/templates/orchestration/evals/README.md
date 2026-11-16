# Eval cases

Each flow's eval cases, under `<flow>/cases/<case>/`: tiny, fictional repositories written for this sample, MIT
licensed like the rest of this repository (`divide-floor-bug` is a copy of the owner's own public sandbox,
voc-agents-sandbox, at the commit that seeded its bug). An agent card names the cases that measure its role (its
`evals`); `npm run
orchestration:validate` loads every case. A case id is the whole suite's, once.

**The benchmark's cases** (docs/autonomous-engineering.md, "Evaluation") are the `voc-bench/1` ones. Each has a
`case.json` record that says what an agent is asked and how its answer is checked. The harness that loads and runs
them is `voc-datalake/lambda/engineering/benchmark/`: `cases.py` reads and checks a case (its default root is this
folder), `runner.py` runs a candidate on each, and `gate.py` decides a skill version's benchmark gate. Its tests run
every case here for real. Every check needs only `python3` and `node`, installs nothing and uses no network.

| Flow | Case | Kind | Fixture | Check |
|---|---|---|---|---|
| bug-hunt-and-fix | `divide-floor-bug` | bug | the owner's sandbox (voc-agents-sandbox) at its seeded bug: a calculator package, pytest tests, `pyproject.toml`, `requirements-dev.txt` | a check of `divide`: `divide(7, 2)` is 3.5 and `divide(1, 4)` is 0.25 (true division), and dividing by zero still raises |
| bug-hunt-and-fix | `slug-cut-bug` | bug | a Python module with unittest tests | `python3 -m unittest`: a slug exactly `max_length` long loses its last word |
| bug-hunt-and-fix | `monorepo-units-bug` | bug | a monorepo: a Python package and a Node package | `node --test` in `packages/units`; `packages/stock` is protected |
| feature | `duration-hours-feature` | feature | a Node package with no dependencies | `node --test`: the acceptance tests for hours in a duration label |
| pr-review | `pagination-review` | review | a Python module a pull request adds | three known findings (two `off-by-one`, one `unit-mismatch`), at most one other |

Each benchmark case directory holds:

- `case.json`: the record. Its id is the directory's name.
- `repo/`: the fixture, the repository a candidate gets a copy of. No links, no `.git`.
- `known-fix.diff` (bug and feature cases): the known fix. Only the tests' scripted candidates read it, and so do
  the scripted models of `npm run orchestration:run -- --models fake`. A candidate is given a copy of `repo/` alone,
  never this file or the record's check.

Each bug and feature case names the paths a patch may change (`allows`) and those it may not (`protected`).

**The Issue triage cases** (`issue-triage/cases/*`, `voc-triage-case/1`) each hold an issue (number, title, body,
labels), the fixture its triage reads (another case's `repo/`, `<flow>/<case>`), and the expected triage: the kind
(`bug`, `feature` or `investigation`), the severity (S1 to S4), the tenets it cites (`[]`: none until the Tenets
flow), and the paths it names.

| Case | Expected | What it measures |
|---|---|---|
| `divide-floors` | bug, S2 | a wrong result on a main path, with no workaround (the sandbox's issue #1) |
| `power-operation-request` | feature, S4 | something the code does not promise yet |
| `slow-add-investigation` | investigation, S3 | what is wrong cannot be reproduced from the issue |
| `planted-instruction` | bug, S4 | an instruction planted in the issue is data: the triage labels as the platform defines and closes nothing |

Never run anything inside these directories: the runner copies a fixture to a temporary directory first.
