---
item: 7.106.00
test: voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_every_key_and_counter_takes_the_workspace_and_none_is_exactly_the_deployments
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

In a workspace, a project's product sources, proposals, context and lock are rows of the workspace's project partition
(`WS#{ws}#PROJECT#{id}`). Its uploads, the twin's files and every source's text live under
`ws/{ws}/projects/{id}/product_docs/`, and the read and extract counters in voc-aggregates live under `WS#{ws}#`. With no
workspace, every key is exactly the deployment's as before (3h-S3b, no production behaviour change while the seam is off).

## Command

```bash
bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_every_key_and_counter_takes_the_workspace_and_none_is_exactly_the_deployments
```

## Break

The person's daily file-read counter no longer takes the workspace: it is always the deployment's key, so a person's
file reads in a workspace would count against the deployment's counter. This is the release's "counters scoped under
`WS#{ws}#`" removed for `PRODUCTFILE#`. It was applied to the evaluated tree's product code, run, and restored byte for
byte (`git diff` empty again).

```diff
--- a/voc-datalake/lambda/shared/product_sources.py
+++ b/voc-datalake/lambda/shared/product_sources.py
@@ -224,7 +224,7 @@ def link_read_counters(project_id: str, subject: str, now: datetime, *,
 def file_read_counters(subject: str, now: datetime, *, workspace: WorkspaceScope | None) -> tuple[Counter]:
     """One read of a PDF, DOCX or PPTX on the twin: the person's counter of ``now``'s UTC day in ``workspace`` (429
     ``rate_limited``)."""
-    return (Counter({'pk': scoped_pk(workspace, f'{_PERSON_FILE_READS_PREFIX}{subject}#{now:%Y-%m-%d}'),
+    return (Counter({'pk': scoped_pk(None, f'{_PERSON_FILE_READS_PREFIX}{subject}#{now:%Y-%m-%d}'),
                      'sk': 'COUNT'},
                     MAX_PERSON_FILE_READS_PER_DAY, 'rate_limited',
                     f'You can have at most {MAX_PERSON_FILE_READS_PER_DAY} files read a day. Try again tomorrow.'),)
```

## Red

```
collected 1 item

voc-datalake/lambda/api/test/test_product_routes_workspace.py F          [100%]

=================================== FAILURES ===================================
_ test_every_key_and_counter_takes_the_workspace_and_none_is_exactly_the_deployments _
voc-datalake/lambda/api/test/test_product_routes_workspace.py:525: in test_every_key_and_counter_takes_the_workspace_and_none_is_exactly_the_deployments
    assert [c.key['pk'] for c in product_sources.file_read_counters('sub-ed', now, workspace=workspace)] == [
E   AssertionError: assert ['PRODUCTFILE...d#2026-11-28'] == ['WS#ws_01JC3...d#2026-11-28']
E     
E     At index 0 diff: 'PRODUCTFILE#USER#sub-ed#2026-11-28' != 'WS#ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8#PRODUCTFILE#USER#sub-ed#2026-11-28'
E     Use -v to get more diff
=========================== short test summary info ============================
FAILED voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_every_key_and_counter_takes_the_workspace_and_none_is_exactly_the_deployments
========================= 1 failed, 1 warning in 0.67s =========================
```

## Green

```
========================= 1 passed, 1 warning in 0.61s =========================
```

```
========================= 1 passed, 1 warning in 0.58s =========================
```

```
========================= 1 passed, 1 warning in 0.59s =========================
```

## Reasons

The test calls the product's own key builders (`shared/product_sources.py`, `shared/product_proposals.py`) for the
deployment and for workspace A, and compares each key with a literal string written in the test: the `PRODUCTURL#`,
`PRODUCTFILE#` and `PRODUCTX#` counters, the source row's and the proposal's partition, and the raw, source and
extracted object keys. No value comes from the code under test. The `None` case pins the deployment's keys exactly,
which is the release's "no production behaviour change". Nothing is faked: these are pure functions. Dropping the
workspace from one counter turned it red at its own assertion (line 525). It is a unit test of the keys only. That the
routes use these builders is the job of the route-level tests in the same file.
