---
item: 7.106.00
test: voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_the_twin_reads_only_the_workspace_its_event_names
digest: 2eee53cf8c901b40b97a1158ac3fbd0128c50ac20ec48ca15d51b4874603f611
verdict: ACCEPT
evaluator: eval-s3b/1
author: voc-lead-3h/s3b
sha: b311b18116206eb88fc34197a9cbc8a96ea78ad0
tree: 26f051bba50d83b594ef6874d173fded5d21bd40
checks:
  tests_item: true
  real_path: true
  fails_on_break: true
  not_tautology: true
  stable_3x: true
  runs_in_gate: true
---

## Item

The Product tab's reading twin (`shared/product_source_worker.py`) reads and writes only the row and objects of the
workspace its event names. An event naming no workspace, or another workspace, finds no claimed source there and writes
nothing. An event whose workspace field is not a workspace id is refused. The release lifts the twin's earlier refusal
of every workspace (3h-S3b).

## Command

```bash
bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_the_twin_reads_only_the_workspace_its_event_names
```

## Break

The worker drops the event's scope and always reads the deployment's row, as if the workspace had never been threaded
into the twin. It was applied to the evaluated tree's product code, run, and restored byte for byte (`git diff` empty
again).

```diff
--- a/voc-datalake/lambda/shared/product_source_worker.py
+++ b/voc-datalake/lambda/shared/product_source_worker.py
@@ -191,7 +191,7 @@ def _claim_of(event: Mapping[str, Any]) -> _Claim | None:
     if refused or len(texts) != len(ids):
         logger.error('Product source extraction event refused')
         return None
-    return _Claim(texts[0], texts[1], texts[2], scope)
+    return _Claim(texts[0], texts[1], texts[2], None)
 
 
 def _read_claimed(table: Any, claim: _Claim) -> str:
```

## Red

```
collected 1 item

voc-datalake/lambda/api/test/test_product_routes_workspace.py F          [100%]

=================================== FAILURES ===================================
____________ test_the_twin_reads_only_the_workspace_its_event_names ____________
voc-datalake/lambda/api/test/test_product_routes_workspace.py:479: in test_the_twin_reads_only_the_workspace_its_event_names
    assert product_source_worker.run({**event, 'workspace_id': WS_A}) == {'status': 'done'}
E   AssertionError: assert {'status': 'skipped'} == {'status': 'done'}
E     
E     Differing items:
E     {'status': 'skipped'} != {'status': 'done'}
E     Use -v to get more diff
=========================== short test summary info ============================
FAILED voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_the_twin_reads_only_the_workspace_its_event_names
========================= 1 failed, 1 warning in 0.89s =========================
```

## Green

```
========================= 1 passed, 1 warning in 2.21s =========================
```

```
========================= 1 passed, 1 warning in 1.75s =========================
```

```
========================= 1 passed, 1 warning in 1.76s =========================
```

## Reasons

The test seeds a claimed source in workspace A's partition and its PDF under `ws/{A}/` in moto (the store, the true
edge), then runs the product's own worker. With no workspace named, or B named, it is skipped and A's row stays
`extracting`. With a malformed workspace id it is refused (`ignored`). With A named it is `done`: A's row is `ready` and
the text is written under A's `ws/` key. The expected statuses and keys are literals in the test, not values computed
by the code. With the scope dropped, the worker never reaches A's row, and the test went red at its own assertion
(line 479).
