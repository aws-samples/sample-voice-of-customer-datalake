# Mutation notes: the engineering agents' critical components

Scope: property tests and mutation runs for the engineering agents' critical components (the Python side,
`voc-datalake/`). Property tests use Hypothesis, pinned in `voc-datalake/requirements-dev.txt` (6.135.0). The one
profile (256 cases, a committed failing-example database) is `lambda/shared/test/properties.py`; the database folder is
`lambda/shared/test/hypothesis-regressions/`, ignored but for its README: an entry a fix needs is added with `git add -f`.

## Components and why a wrong answer costs

| # | Component | Module | Why it is critical | Property tests | Mutation run (killed / survived / timeout) |
|---|---|---|---|---|---|
| 1 | The dial (fails closed) | `engineering/connectors/dial.py` | a wrong answer lets an agent push without a person's choice | `connectors/test/test_dial_properties.py` (5) | 31 mutants: before 27 / 4 / 0, after 31 / 0 / 0 |
| 2 | Write policy (branch, CI paths, customer text, personal data, commit identity) | `engineering/connectors/write_policy.py` | a wrong answer writes to the default branch or CI, or publishes a customer's words | `connectors/test/test_write_policy_properties.py` (12), `connectors/test/test_write_policy_words.py` | 297 mutants: before 267 / 30 / 0, after 295 / 2 / 0 (the 2: below) |
| 3 | Patch line split and hunk application | `engineering/connectors/patches.py` | a wrong answer commits a file the agent did not write | `connectors/test/test_patches_properties.py` (5) | not run yet |
| 4 | The GO ledger (`has_go`: the newest ended final go and gate runner, their records, their tree) | `engineering/connectors/records.py`, `engineering/flow/ledger.py` | a wrong answer opens a pull request without a GO for exactly that tree | `connectors/test/test_records_properties.py` (1, 80 cases: each builds a moto table) | not run yet |
| 5 | Spend ledger and alerts (levels, month totals, token deltas) | `engineering/spend.py` | money: a total off, an alert missed or sent twice | `test/test_spend_properties.py` (8) | not run yet |
| 6 | The hard cap on a start | `engineering/runtime/runs.py` `hard_capped` | money: a run allowed past the flow's month or its own cap | `runtime/test/test_hard_cap_properties.py` (4) | not run yet |
| 7 | The broker's role matrix | `engineering/connectors/broker.py` `permitted` | an agent makes a write that is not its role's | `connectors/test/test_broker_roles_properties.py` (4) | not run yet |
| 8 | The run-state machine (active, at a decision point, ended; resume, end) | `engineering/runtime/runs.py` `RunStore` | a stopped run resumes, or an ended one runs again | `runtime/test/test_run_state_properties.py` (1, model-based: 80 sequences on a moto table) | not run yet |

Each property states its invariant in words above it. No product code changed for them, and no test was weakened.

The GO ledger's property follows 6.29.00's rule (`flow/ledger.py` `go_tree`): the final go's GO counts only after the
newest ended gate runner's passing GO on the same tree; the generated tasks mix final goes, gate runners and builders.

Observation, not a defect: `end` does not remove the `needs_human` attribute, so a run that ends at a decision point
keeps the reason on its META row. Nothing reads it on an ended run.

## How the runs were made

`scripts/mutate-python.sh <module> <its unit tests> <its property tests> [<the tests written for its survivors>]`,
the whole module, from `voc-datalake/`. Every survivor was read: a missing test was written (the run then repeated),
and a mutant that no test can kill is listed below for a rewrite, never marked `# pragma: no mutate` here.

- The dial: the 4 survivors changed the sentence a failed read answers; the property now pins it word for word and
  checks the cause is kept.
- Write policy: the survivors were the refusals' sentences and codes (now pinned in `test_write_policy_words.py`), the
  `..` rule (no test had a `..` inside a component, which only that rule refuses), the leading-slash strip of a path,
  and four edges of `split_trailers` (trailing blank lines, a middle paragraph, several other trailers, a single
  paragraph or a mixed last paragraph).

## Survivors left for a rewrite (no test can kill them)

- `write_policy.py` `branch_refusal`: `'@{' in rest` can never decide, because the character set (`_BRANCH_REST`)
  refuses `@` and `{` first; and the `'/'` of `rest.endswith(('/', '.'))` can never decide, because a trailing `/`
  leaves an empty last component, which `not c` refuses. Both checks have no effect; dropping them changes nothing.
