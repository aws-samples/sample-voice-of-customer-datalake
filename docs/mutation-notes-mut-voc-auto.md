# Mutation notes: the engineering agents' critical components

Scope: property tests and mutation runs for the engineering agents' critical components (the Python side,
`voc-datalake/`). Property tests use Hypothesis, pinned in `voc-datalake/requirements-dev.txt` (6.135.0). The one
profile (256 cases) is `lambda/shared/test/properties.py`. Its failing-example database is
`lambda/shared/test/hypothesis-regressions/`: the folder is ignored but for its README, and an entry a fix needs is
added with `git add -f`.

## Components and why a wrong answer costs

| # | Component | Module | Why it is critical | Property tests | Mutation run: killed / survived / timeout |
|---|---|---|---|---|---|
| 1 | The dial (fails closed) | `engineering/connectors/dial.py` | a wrong answer lets an agent push without a person's choice | `connectors/test/test_dial_properties.py` (5) | 31 mutants: before 27 / 4 / 0, after 31 / 0 / 0 |
| 2 | Write policy (branch, CI paths, customer text, personal data, commit identity) | `engineering/connectors/write_policy.py` | a wrong answer writes to the default branch or CI, or publishes a customer's words | `connectors/test/test_write_policy_properties.py` (12) | 297 mutants: before 267 / 30 / 0, after 295 / 2 / 0 |
| 3 | Patch line split and hunk application, the binary delta | `engineering/connectors/patches.py` | a wrong answer commits a file the agent did not write | `connectors/test/test_patches_properties.py` (5) | 958 mutants: before 789 / 157 / 12, after 938 / 10 / 10 |
| 4 | The GO ledger (`has_go`: the newest ended final go and gate runner, their records, their tree) | `engineering/flow/ledger.py` (read by `connectors/records.py`) | a wrong answer opens a pull request without a GO for exactly that tree | `connectors/test/test_records_properties.py` (1, 80 cases: each builds a moto table) | 176 mutants: before 158 / 18 / 0, after 175 / 1 / 0 |
| 5 | Spend ledger and alerts (levels, month totals, token deltas) | `engineering/spend.py` | money: a total off, an alert missed or sent twice | `test/test_spend_properties.py` (8) | 593 mutants: before 529 / 64 / 0, after 587 / 6 / 0 |
| 6 | The hard cap on a start | `engineering/runtime/runs.py` `hard_capped` | money: a run allowed past the flow's month or its own cap | `runtime/test/test_hard_cap_properties.py` (4) | with 8 (one module) |
| 7 | The broker (its role matrix, the order of its checks, what it hands the host) | `engineering/connectors/broker.py` | an agent makes a write that is not its role's | `connectors/test/test_broker_roles_properties.py` (4) | 294 mutants: before 278 / 16 / 0, after 292 / 2 / 0 |
| 8 | The run-state machine (active, at a decision point, ended; resume, end), the run caps | `engineering/runtime/runs.py` | a stopped run resumes, an ended one runs again, a run passes its cap | `runtime/test/test_run_state_properties.py` (1, model-based: 80 sequences on a moto table) | 1288 mutants: before 1088 / 178 / 0 (and 22 no test), after 1256 / 32 / 0 |

Each property states its invariant in words above it. No test was weakened. The tests written for the survivors:

| Module | Tests |
|---|---|
| `dial.py` | the failed read's sentence and cause, in `test_dial_properties.py` |
| `write_policy.py` | `connectors/test/test_write_policy_words.py` |
| `patches.py` | `connectors/test/test_patches_edges.py` (quoting, headers, hunks, file parts), `connectors/test/test_patches_binary.py` (base85, deltas, inflating, the reader) |
| `flow/ledger.py` | `flow/test/test_ledger_reads.py` |
| `spend.py` | `test/test_spend_edges.py` |
| `broker.py` | `connectors/test/test_broker_words.py` |
| `runtime/runs.py` | `runtime/test/test_runs_edges.py`, `runtime/test/test_runs_caps_edges.py` |

The GO ledger's property follows 6.29.00's rule (`flow/ledger.py` `go_tree`): the final go's GO counts only after the
newest ended gate runner's passing GO on the same tree; GO pairs are drawn on purpose (random tasks alone almost never
make one), and five `@example` cases pin a GO and the newer tasks that take it away or leave it.

Observation, not a defect: `end` does not remove the `needs_human` attribute, so a run that ends at a decision point
keeps the reason on its META row. Nothing reads it on an ended run.

## How the runs were made

`scripts/mutate-python.sh <module> <its unit tests> <its property tests> <the tests written for its survivors>`, the
whole module, from `voc-datalake/` (`spend.py` with the two runtime suites that reach its alerts:
`runtime/test/test_engineering_runs.py`, `test_engineering_runtime_handler.py`). Every survivor was read: a missing
test was written and the run repeated; a mutant that no test can kill is listed below for a rewrite, never marked
`# pragma: no mutate` here.

What the survivors were: refusal sentences and codes (an agent reads them, so they are pinned word for word),
comparisons at their bounds, the UTC conversions (a far time zone set for the test shows them), the exact DynamoDB
requests the spend ledger writes, the defaults of a row's missing attributes, the model-row cap, a copy or an insert
past a delta's data that would still add up to the target's size, the inflate bound (a small patch never inflates past
one byte more than its size), and functions no test had called (`is_active`, `coordinator_awaited`).

## Survivors left for a rewrite (no test can kill them)

Equivalent mutants (the code has no effect a test can see):

- `write_policy.py` `branch_refusal`: `'@{' in rest` (the character set refuses `@` and `{` first) and the `'/'` of
  `rest.endswith(('/', '.'))` (an empty last component is refused by `not c`).
- Codec names in any case (`'utf-8'`, `'UTF-8'`, the default): `patches.py` `_path`, `contents`, `_utf16_text`;
  `flow/ledger.py` `read_gate_record`.
- `patches.py`: `_unquote` reads `body[i+1:i+3]` for one escaped byte (only its first is used); `_utf16_text`'s extra printable
  `X` among the allowed whitespace; `WorkspacePatches._patch`'s 512-character key bound (no key the layout accepts
  comes near it).
- `spend.py`: `sum(..., Decimal(0))` without its start (every value is a Decimal); `month_spend`'s `max_items` bound
  (the loop stops at the cap's next row first).
- `broker.py` `push_bundle`: `check_push` without the default branch (`_open_write` refused it already);
  `prose=None` (falsy, as `False`).
- `runtime/runs.py`: lower-case DynamoDB keywords in `end`, `flag_budget`, `needs_human`, `resume`, `_typed_rows`,
  `listed`, `spend` (case-insensitive keywords); `datetime.fromtimestamp(now, UTC)` as a local time in `hard_capped`,
  `budget_alert`, `alert_sent` (every reader converts it back to the same instant); the `BoardStore` that `start`
  builds only for `coordinate_items`, which reads none of its arguments; `_keep_verdicts`' `newest_final_go` arguments
  (only the task, not the key, is read); `_update_status`' loop bound (the raise at the last try ends it);
  `resume`'s step for a run with no META (its transaction fails either way).

Timeouts (a mutant that breaks a loop's counter never ends: these loops are bounded only by their counter):
`patches.py` `_unquote`, `_quoted_end`, `_hunk_lines`, `_binary`, `_file` (9 or 10 a run: a few of the 12 sometimes
end in a kill instead).
