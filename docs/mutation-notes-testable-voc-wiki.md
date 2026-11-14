# Mutation notes: testable-voc-wiki (2026-11-14)

Two pieces of voc-wiki that mutation testing could not reach safely: the mutation stage itself, for a module under
`voc-datalake/scripts/`, and the version fill of `lambda/shared/document_versions.py`, whose loops never ended under
some mutants. Both are now testable. Behaviour is unchanged, and tests written before the change pin it.

## 1. The mutation stage (`scripts/mutate-python.sh`, `scripts/mutmut_run.py`)

**What was wrong.** The stage copied only `lambda/` and `plugins/` and linked every other entry back to the tree. For
`scripts/project_bundle/exporter.py` (import name `project_bundle.exporter`, import root `scripts/`), `mutants`
resolved to the real `scripts/`, so mutmut would have written its mutants into the working tree. Then, with that
fixed, the baseline still found no import of the module. The export tests load `project_bundle.exporter` in a
module fixture and drop it from `sys.modules` on teardown, and the driver only read `sys.modules` after the run.

**The change.**
- The stage copies the module's own top directory (`scripts/` here) as git lists it, beside `lambda/` and `plugins/`.
- Before mutmut starts, the script refuses (exit 3, with a message naming the path) when `$STAGE/mutants` or the
  directory the module's mutants go to resolves inside the repository. That covers a module in an ignored directory,
  or one below a link. It uses `pwd -P`, so it works the same on Linux and macOS.
- `mutmut_run.py baseline` collects the module's import names before every test's teardown (the
  `ImportNameRecorder` pytest plugin) and again at the end.

**Tests.** `lambda/shared/test/test_mutate_python_stage.py` runs the real script in a throwaway repository, with a
stub in place of the driver that writes a mutant to `mutants/<source path>` the way mutmut does:
- modules under `scripts/`, `lambda/` and `plugins/`: the mutant lands in the stage's copy, and the repository is
  byte for byte the same (every file and link, plus `git status --ignored`);
- an ignored directory, and a directory link below a copied root: refused with exit 3, mutmut never started, and the
  tree is unchanged.

On the old script, 3 of these 5 fail: the `scripts/` mutant was written into the real tree, and neither refusal
happened. `test_mutmut_run.py` adds the recorder's unit test and a baseline run in a subprocess, where a fixture
loads the module and drops it again.

**The real run.** `bash scripts/mutate-python.sh scripts/project_bundle/exporter.py` with
`test_project_bundle_scripts.py`, `test_project_bundle_exporter_properties.py` and
`test_project_bundle_exporter_survivors.py` (32 children). The stage's `exporter.py` held mutmut's trampolines,
mutmut's clean run passed, and afterwards `git status` of the tree showed no change to anything under `scripts/` but
the two script edits.

| Module | Before | After: killed / survived / timeout |
|---|---|---|
| `scripts/project_bundle/exporter.py` | not runnable (the mutants would land in the tree; then "the tests never import" it) | 426 / 0 / 0 of 426 |

No survivors, so nothing needed a proof. The pager's endless-loop mutants (`if not last_key` inverted) end on the
fake's call cap, not on mutmut's timeout.

## 2. The version fill (`lambda/shared/document_versions.py`)

**What was wrong.** `normalize_document_versions` and `_assign_unpersisted_legacy_versions` each found the next free
version with `while n in used: n += 1`, bounded only by finding one. A mutant such as `n = 1` (normalize 73/74,
legacy 23) never ended, and only mutmut's timeout stopped it.

**Pinned first.** `lambda/shared/test/test_document_versions_testable.py` had 14 tests, all green on the old code
before anything moved. A 15th, the `used_by` record, was added with the change; it holds on the old code too, and
`test_document_versions_mutation_1_727.py` already pinned it. They cover:
- claims are kept, and the rest take the lowest free numbers in creation order, with input order kept;
- runs of claims, far claims, a contested claim, and a legacy suffix as a claim;
- each series is filled on its own, and unmanaged rows are left alone;
- the legacy fill starts above the floor, keeps prior assignments and reserves suffixes first;
- one identity seen twice is versioned once, and the versions given are recorded in `used_by`.

**The change.** Both loops are now one helper, `_lowest_free_versions(taken, start, count, limit)`. It looks at no
more than `limit` numbers, and its callers pass `count + len(taken)`. Among that many consecutive numbers at most
`len(taken)` are taken, so `count` free ones are always there. Past the limit it raises
`ServiceError('Document version fill found <k> of <count> free versions in <limit> numbers')`: a broken fill fails at
once. The legacy fill keeps its lazy "each identity once" rule as `dict.fromkeys` over the unassigned identities.
Twelve helper tests (seven cases of one parametrized test, plus five more) cover exact lists, the tight limit, the dict of claims, both errors and a limit counted from the
start.

**Scores** (whole module, 48 children, every version test file):

| Run | Mutants | Killed / survived / timeout |
|---|---|---|
| Before (mut-voc-wiki2's two slices, lines 1-727 and 728-1560) | 1046 + 1500 = 2546 | 2528 / 14 / 4 |
| After | 2569 | 2555 / 14 / 0 |
| After, the fill only: `normalize_document_versions`, `_lowest_free_versions`, `_assign_unpersisted_legacy_versions` | 140 (95 + 9 + 36) | 140 / 0 / 0 |

The 14 survivors left are all outside the fill: `split_versioned_title` 26, `series_base_title` 10/12,
`persist_legacy_document_versions` 21/22/30/34/35, `_acquire_legacy_migration` 33/40, `persist_versioned_document` 87,
`_counter_moved` 8 and `series_head_version` 12/34. They are mut-voc-wiki2's: all 14 are proved equivalent in its notes
(`docs/mutation-notes-mut-voc-wiki.md`, "Equivalent-mutant ignore list").

**Proofs for review: none.** No mutant of the changed code was called equivalent. `zip(..., strict=...)` was left out
on purpose: under the helper's guarantee, `strict=True` against `False` would be an equivalent mutant. So both loops
index `free[position]`, which a wrong position fails.
