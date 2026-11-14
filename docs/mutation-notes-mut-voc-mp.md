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
   the delegated-credential cap, `MembershipCache`, `is_active`, `list_my_workspaces`). Wrong: a non-member or a
   deleting workspace gets in, a delegated credential gets admin, or a stale cache entry outlives a removal beyond the
   30 s TTL. Properties (`test_workspace_resolve_properties.py`): every generated request gets the answer of a plain
   oracle of the documented rules (the one 404 for every kind of "not yours", the delegated cap, the live-checked and
   audited platform-admin entry); a stranger costs one read whether or not the workspace exists; a cached membership
   lives at most the TTL and is never another person's; reads are strongly consistent and of the row's own attributes.
4. **Membership rules** (`lambda/shared/workspace_members.py`: the last-admin rule, role changes, removals and leaves,
   `plan_user_removal`, `remove_user_memberships`). Wrong: a workspace with no admin, or a removed member who keeps
   access. Properties: random runs of adds, changes, removals and leaves against a model on moto
   (`test_workspace_members_properties.py`: always an admin, MEMBER# and USER# rows agree, a demoted admin changes
   nothing, a deleted user never silently orphans a workspace); and on a recording double
   (`test_workspace_members_requests_properties.py`): each change is one transaction of exactly the documented items,
   a cancelled one is answered by which item failed in the documented precedence, every audit row and log line.
5. **Workspace id and credential names** (`lambda/shared/workspace_ids.py`). Properties: a workspace id is exactly
   `ws_` + a ULID (every near miss refused); two different (workspace, plugin) pairs never name the same SSM parameter
   nor one inside the other's path; a malformed plugin id, prefix or workspace id builds no name.
6. **Asynchronous message routing** (`ws_repo.py`: `message_scope`, `scope_from_message`, `scope_from_key`,
   `partition_scope`, `scope_from_lookup`). Properties: a message runs in the workspace it names, deployment-wide only
   with no `workspace_id` field, and is refused with a malformed one; a stored `WS#…` row that names no workspace is
   refused, never treated as deployment-wide; a public route follows only its stored routing row.
7. **Erasure, retention and the workspace export and delete jobs** (`shared/erasure_jobs.py`, `shared/export_jobs.py`,
   `ws_repo.py` `ExportObjects` / `WorkspaceObjects`, `jobs/retention`; the tombstone-first rule). Properties
   (`test_erasure_jobs_properties.py`): random starts, renewals and releases by several jobs at increasing times keep
   the lock row equal to a model of the rule (one live job; a stale lock taken over after an hour; a release by a job
   whose lock was taken over never frees its successor's; a released lock is never renewed); the exact conditional
   UpdateItem; a quiet release logs its own failure only. `test_ws_objects_properties.py`: every export object the job
   touches stays under `ws/{ws}/exports/` with clean segments and the export tag, only a work object is deleted, a
   download name is a plain file name, and the workspace's own objects are read without its exports or another's.
   `test_export_jobs_properties.py`: random claims, progress writes, endings, failures and erasures of one export
   job, duplicated, late or out of order, keep its row equal to a model of the generation protocol (a generation is
   claimed once, from the state just before it, while fresh; only the holding generation writes progress; nothing
   revives an erased export); each step's exact conditional UpdateItem; an erasure marks only its exports by their own
   ids; and what a reader sees of every row shape (expired, stalled, never started). Not covered here:
   `jobs/retention` (see "Not done").
8. **Limits and credentials** (`lambda/shared/workspace_credentials.py`, the SSM store and its 4096-byte limit; the
   other workspace limits are constants checked where they are used: `MAX_TRANSACT_ITEMS` in component 2,
   `MAX_NAMED_WORKSPACES` in component 4). Properties (`test_workspace_credentials_properties.py`): what is saved is
   read back from its own name only; up to 4096 UTF-8 bytes is kept and one byte more refused with nothing written; a
   workspace's status lists its own plugins only, a malformed one left out; only "not found" reads as nothing saved.

## Ignore list (equivalent mutants)

No mutant is marked equivalent in the code. The survivors below are written up as escalations (each with its proof,
in the project's escalation list) for a reviewer to accept or for a rewrite that removes them:

| File::function | Mutant (the line as mutated) | Why no test can tell it apart |
|---|---|---|
| `workspace.py::_load` | 79: `role=role or ''` -> `role or 'XXXX'` | that return is reached only with a non-empty stored role |
| `workspace.py::member_subject` | 7: `caller_from_claims(claims_from_event(event), [])` -> `(…, None)` | called only for a synthetic sub, whose two paths never read the groups |
| `workspace.py::member_subject` | 11: `acting = ''` -> `acting = None` (the ValueError branch) | both are falsy before `not acting` |
| `workspace.py::member_subject` | 15: `is_synthetic_subject(acting)` -> `is_synthetic_subject(None)` | caller_from_claims already blanks a synthetic acting subject (`mcp:` sets `''`, agents go through `_human_sub`) |
| `workspace_credentials.py::checked_credentials` | 3: `ensure_ascii=False` -> `ensure_ascii=None` | json tests the flag for truth only |
| `workspace_members.py::_raise_for_actor` | 4: `codes[index:index + 1]` -> `codes[index:index + 2]` | the actor's check is always the transaction's last item |
| `workspace_members.py::add_member` | 138: `3 if actor_check is not None else None` -> `3 if (…) or True else None` | without the actor's check the transaction has 3 items, so `codes[3:4]` is empty |
| `workspace_members.py::_refuse_last_admin` | 6, 7: `after == 'admin'` -> `== 'XXadminXX'` / `== 'ADMIN'` | an admin-to-admin change returns before the check; a removal passes None |
| `workspace_members.py::change_role` | 21: `_refuse_last_admin(…, before, role)` -> `(…, before, None)` | same: `after` only matters for an admin-to-admin change, which never gets there |
| `workspace_members.py::_remove_deleted_users_membership` | 4, 5, 6, 13: the context's `role=''`, `name=…`, `slug=…` -> `None` / `'XXXX'` | the context is only for `_audit`, which reads its `ws` and `platform_admin` |

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
| 3 | `workspace.py` (all, 355 mutants) | 314 / 26 / 15 / 0 | 351 / 4 / 0 / 0 (4 escalated) |
| 4 | `workspace_members.py` (956 mutants; the run's `--lines 279-606` mutated the whole module) | 818 / 114 / 24 / 0 | 947 / 9 / 0 / 0 (9 escalated) |
| 7 | `erasure_jobs.py` (all, 113 mutants) | 105 / 8 / 0 / 0 | 113 / 0 / 0 / 0 |
| 7 | `ws_repo.py` 492-720 (`ExportObjects`, `WorkspaceObjects`; 446 mutants) | 223 / 31 / 192 / 0 | 446 / 0 / 0 / 0 |
| 7 | `export_jobs.py` 128-335 (the job row and its view; 471 mutants) | 407 / 22 / 42 / 0 | 471 / 0 / 0 / 0 |
| 8 | `workspace_credentials.py` (all, 160 mutants) | 143 / 17 / 0 / 0 | 159 / 1 / 0 / 0 (1 escalated) |

"Before" for `workspace.py` is `test_workspace.py`; for `workspace_members.py` `test_workspace_members.py` and
`test_workspace_members_user_delete.py`; for `erasure_jobs.py` the erasure routes' and the retention worker's tests;
for `workspace_credentials.py` `test_workspace_plugin_store.py` and `test_operator_routes_workspace.py`. An earlier
"after" run of `workspace_members.py` had 15 timeouts (the moto properties kept every run's rows, and moto copies the
table on each transaction); with each run's rows cleared there are none.

The survivors before were refusal messages that no test read exactly (most of them), the default key `pk`, a
delete's options not passed on, `iter_query`'s sort condition dropped on later pages, the 100-entry edge of a
transaction, voc-watermarks' duplicate rule (no sort key), a form id ending in `#`, and the key builders no test
called (`erasure_job_pk`, `reprocess_job_pk`, `conversants_pk`, the memory partitions).

The survivors before, for components 3, 4, 7 and 8, were mostly what no test read: the exact transaction items and
conditions, the audit rows' fields, the log lines, `ConsistentRead`, the precedence of cancellation codes, a fault
answer with no `Error` field, the defaults of a bare GetObject answer; and `is_active`, the export objects' calls and
`audit_account_creation`, which no test called.

## Not done

- `jobs/retention` (the worker's sweep, the tombstone-first rule) and `export_jobs.py` 336-431 (the routes' steps:
  start, status, link, which `test_export_jobs.py` covers): no properties yet; the retention worker is a multi-module
  job whose sweep needs its own model, the next session's first item.

## Bugs found by the properties

None.

## Observations (not bugs; for the layer's owner)

- On a `pk` table, `put_item` lets `source` through as a plain label (an import run's source name), while
  `update_item` / `check_update` treat `source` like every partition attribute: `SET source = :s` with a label value
  is refused ("source outside the workspace"). Stricter, so no isolation gap, and no caller sets `source` by an
  update today; the table properties pin both behaviours as they are, so a change to either is a decision.
