---
item: 7.109.00
test: voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py::test_an_erasure_by_email_lists_a_workspace_csv_upload_for_review
digest: 6bb83d5cd86ac90aea3e4f7bce13f630ced78e2b726de6e63c2daa3d9fc92381
verdict: ACCEPT
evaluator: eval-bf2/1
author: voc-lead-3h/bf-whole
sha: 47b79594b4c422aec2d0cce775ae0e1f23d70eec
tree: 51d6a05e61a498eba9bb0426a78c47c32e71fd5b
checks:
  tests_item: true
  real_path: true
  fails_on_break: true
  not_tautology: true
  stable_3x: true
  runs_in_gate: true
---

## Item

An erasure or a retention window's run that deletes an item which came from a whole file keeps the file and lists
its key under "files needing review" on the job and audit rows. Before 7.109.00 only the deployment's
`raw/csv_upload/` and `raw/json_upload/` were recognised. A workspace's `ws/{ws}/raw/csv_upload/…` and
`json_upload/…` uploads, every paste file (`manual_import/{y}/{m}/{d}/{job_id}.json`) and every form import's
original (`feedback_form/import/…`) were kept without being listed. This test covers the workspace CSV upload.

## Command

```bash
bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py::test_an_erasure_by_email_lists_a_workspace_csv_upload_for_review
```

Each run below added `-p no:randomly` to this command, as the coordinator's brief asked.

## Break

`whole_upload_key` ignores every workspace-scoped item, which restores the pre-fix rule that a whole file under
`ws/{ws}/raw/` is never one. The break was made on the staged tree in the evaluation worktree, which was backed up
first and restored byte for byte afterwards (`cmp` against the backup, `git diff --stat -- voc-datalake` empty).

```diff
diff --git a/voc-datalake/lambda/shared/retention.py b/voc-datalake/lambda/shared/retention.py
--- a/voc-datalake/lambda/shared/retention.py
+++ b/voc-datalake/lambda/shared/retention.py
@@ -554,6 +554,8 @@ def whole_upload_key(item: Mapping[str, Any], bucket: str) -> str | None:
     key = _raw_uri_key(item, bucket)
     if key is None:
         return None
+    if item_scope(item) is not None:
+        return None
     root = raw_root(item_scope(item))
     if not key.startswith(root):
         return key
```

## Red

```
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py F      [100%]
_______ test_an_erasure_by_email_lists_a_workspace_csv_upload_for_review _______
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py:134: in test_an_erasure_by_email_lists_a_workspace_csv_upload_for_review
    assert _after(aws, upload) == (True, [upload])
E   AssertionError: assert (True, []) == (True, ['ws/w...c3e5f60.csv'])
E     At index 1 diff: [] != ['ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/raw/csv_upload/2026/01/01/0b6f6c1e-9d55-4a1e-8f4b-2a7d1c3e5f60.csv']
FAILED voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py::test_an_erasure_by_email_lists_a_workspace_csv_upload_for_review
========================= 1 failed, 1 warning in 0.45s =========================
```

## Green

```
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py .      [100%]
========================= 1 passed, 1 warning in 0.41s =========================
```

```
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py .      [100%]
========================= 1 passed, 1 warning in 0.42s =========================
```

```
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py .      [100%]
========================= 1 passed, 1 warning in 0.41s =========================
```

The warning is the hypothesis plugin's notice about `norecursedirs`. It is not a skip or a failure.

## Reasons

- **Tests the item.** The test stores a workspace CSV upload holding two people's rows and runs the deployment's
  erasure by email for one of them. It then checks four things: one item is deleted, no raw object is deleted (the
  file is kept), the job row lists exactly that file's key for review, and so does the audit row. That is what the
  release promises for a workspace upload.
- **Real path.** `handler.handle_event` runs the real worker: the item walk, `ItemDeleter`, `copies._whole_upload`
  and `shared/retention.py`. The only fakes are DynamoDB and S3, through the suite's moto fixture.
- **Not a tautology.** The expected key is the literal one the test wrote to the bucket. No production code computes
  it.
- **Fails on the break.** Line 134 fails with the review list empty, which is exactly the pre-fix behaviour.
- **Stable.** Green 3/3 after the restore, with no sleeps or wall-clock waits.
- **Runs in the gate.** The brief resolved the test, and `validate.sh --only features` checks it.
