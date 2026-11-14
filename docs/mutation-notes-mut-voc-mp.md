# Property and mutation tests: voc-multiplayer (sessions mut-voc-mp, mut-voc-mp2)

The property tests sit beside the unit tests as `lambda/shared/test/test_*_properties.py`. They share one Hypothesis
profile and the generators of real values in `lambda/shared/test/ws_properties.py`: 256 cases a property, no deadline,
no example database (a run writes nothing into the tree). A case Hypothesis finds is added to its property as an
`@example`: that list is the committed regression set, run first on every run. `hypothesis==6.135.0` is pinned in
`voc-datalake/requirements-dev.txt`; `.hypothesis/` (where a failing run leaves its patch) is git-ignored.

Mutation runs: `voc-datalake/scripts/mutate-python.sh` (mutmut 3.8.1), from `voc-datalake/`, with
`MUTMUT_MAX_CHILDREN` 16-24, one file (or a `--lines` slice of a large one) at a time. "Before" is the existing unit tests alone; "after"
adds the properties. A refusal is checked by its exact message (`ws_properties.exactly`), so a mutant that only edits
the message (`'XX…XX'`, case changes, `None`) is caught: the message is what the 500's log says and what tells two
refusals apart.

## Critical components (by what a wrong answer costs)

1. **Workspace key builders and scope** (`lambda/shared/ws_repo.py`: `WorkspaceScope.key` / `owns`, every key
   builder, `s3_key`, `s3_prefix`, `exports_prefix`, `control_partition`, `control_query`). A key built for one
   workspace that another workspace's `WS#{ws}#` prefix or `ws/{ws}/` object prefix also matches is a cross-team read or
   write. Properties: every key a workspace builds is owned by it and by no other (ids one character apart included),
   each key is exactly the documented layout, `s3_key` never leaves `ws/{ws}/` nor carries an empty, `.` or `..`
   segment, a control-plane query reads only the workspace's own `WS#{ws}` / `AUDIT#WS#{ws}`.
2. **The table guard** (`ws_repo.py` `WorkspaceTable`: puts, gets, deletes, updates and their partition checks,
   queries and their cursors, scans, transactions, batch reads, the batch writer, the allowed options). Properties: an
   item, key, update, query, scan, transaction entry or batch key outside the scope is refused before any call reaches
   the (recording) table; one inside goes through unchanged; options outside `ALLOWED_OPTIONS` are refused; a
   transaction is all in scope or not sent; up to 100 entries; the table cannot be changed once built.
3. **Request workspace resolution** (`lambda/shared/workspace.py`: `_workspace_id`, `_load`, `resolve_workspace`,
   the delegated-credential cap, `MembershipCache`). Wrong: a non-member or a deleting workspace gets in, a delegated
   credential gets admin, or a stale cache entry outlives a removal beyond the 30 s TTL.
4. **Membership rules** (`lambda/shared/workspace_members.py`: the last-admin rule, role changes, removals and leaves,
   `plan_user_removal`). Wrong: a workspace with no admin, or a removed member who keeps access.
5. **Workspace id and credential names** (`lambda/shared/workspace_ids.py`). Properties: a workspace id is exactly
   `ws_` + a ULID (every near miss refused); two different (workspace, plugin) pairs never name the same SSM parameter
   nor one inside the other's path; a malformed plugin id, prefix or workspace id builds no name.
6. **Asynchronous message routing** (`ws_repo.py`: `message_scope`, `scope_from_message`, `scope_from_key`,
   `partition_scope`, `scope_from_lookup`). Properties: a message runs in the workspace it names, deployment-wide only
   with no `workspace_id` field, and is refused with a malformed one; a stored `WS#…` row that names no workspace is
   refused, never treated as deployment-wide; a public route follows only its stored routing row.
7. **Erasure, retention and the workspace export and delete jobs** (`shared/erasure_jobs.py`, `shared/export_jobs.py`,
   `ws_repo.py` `ExportObjects` / `WorkspaceObjects`, `jobs/retention`; the tombstone-first rule). Invariant to test:
   one live job per workspace (a second start while a live lock exists is refused, 409), and a release by a job that
   no longer holds the lock never frees its successor's; export objects never leave `ws/{ws}/exports/`.
8. **Limits and quotas** (the per-workspace allowance counters): to read.

## Ignore list (equivalent mutants)

None. Every mutant of the files below is caught.

## Tooling notes

- `lambda/shared/test/test_workspace_ids.py::test_it_imports_nothing_but_the_standard_library` fails under every
  mutmut run (the mutated copy imports mutmut's trampoline), so the "before" run of `workspace_ids.py` lists that
  file's other tests by node id. Not a code problem: mutmut's own import.

## Scores (killed / survived / no tests / timeout)

| Component | File (lines) | Before (unit tests) | After (with the properties) |
|---|---|---|---|
| 5 | `workspace_ids.py` (all, 32 mutants) | 28 / 4 / 0 / 0 | 32 / 0 / 0 / 0 |
| 1, 6 | `ws_repo.py` 192-491 (scope, keys, routing, control query; 309 mutants) | 217 / 15 / 77 / 0 | 309 / 0 / 0 / 0 |
| 2 | `ws_repo.py` 721-1067 (the table guard; 531 mutants) | 457 / 74 / 0 / 0 | 531 / 0 / 0 / 0 |

The survivors before were refusal messages that no test read exactly (most of them), the default key `pk`, a
delete's options not passed on, `iter_query`'s sort condition dropped on later pages, the 100-entry edge of a
transaction, voc-watermarks' duplicate rule (no sort key), a form id ending in `#`, and the key builders no test
called (`erasure_job_pk`, `reprocess_job_pk`, `conversants_pk`, the memory partitions).

## Bugs found by the properties

None so far.

## Observations (not bugs; for the layer's owner)

- On a `pk` table, `put_item` lets `source` through as a plain label (an import run's source name), while
  `update_item` / `check_update` treat `source` like every partition attribute: `SET source = :s` with a label value
  is refused ("source outside the workspace"). Stricter, so no isolation gap, and no caller sets `source` by an
  update today; the table properties pin both behaviours as they are, so a change to either is a decision.
