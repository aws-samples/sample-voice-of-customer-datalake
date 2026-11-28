---
item: 7.109.00
test: voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py::test_an_erasure_by_email_lists_a_workspace_paste_file_for_review
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
its key under "files needing review". This covers the paste confirm's whole file,
`{raw root}manual_import/{y}/{m}/{d}/{job_id}.json`, in either scope. It has the shape of a legacy per-item key, so
the item decides: the item's own archive is deleted, and any other key there is listed. Before 7.109.00 a paste file
was never listed. This test covers a workspace's paste file.

## Command

```bash
bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py::test_an_erasure_by_email_lists_a_workspace_paste_file_for_review
```

Each run below added `-p no:randomly` to this command, as the coordinator's brief asked.

## Break

`whole_upload_key` drops `manual_import/` from the folders it recognises, so a paste file is no longer taken for a
whole file. The break was made on the staged tree in the evaluation worktree, which was backed up first and restored
byte for byte afterwards (`cmp` against the backup, `git diff --stat -- voc-datalake` empty).

```diff
diff --git a/voc-datalake/lambda/shared/retention.py b/voc-datalake/lambda/shared/retention.py
--- a/voc-datalake/lambda/shared/retention.py
+++ b/voc-datalake/lambda/shared/retention.py
@@ -557,7 +557,7 @@ def whole_upload_key(item: Mapping[str, Any], bucket: str) -> str | None:
     root = raw_root(item_scope(item))
     if not key.startswith(root):
         return key
-    if not key.removeprefix(root).startswith((*_WHOLE_UPLOAD_FOLDERS, _PASTE_FOLDER)):
+    if not key.removeprefix(root).startswith(_WHOLE_UPLOAD_FOLDERS):
         return None
     # The item's own per-item copy there (in a whole-file folder a versioned one only: ``_own_raw_key``) goes with it.
     return None if item_raw_objects(item, bucket) is not None else key
```

## Red

```
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py F      [100%]
_______ test_an_erasure_by_email_lists_a_workspace_paste_file_for_review _______
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py:205: in test_an_erasure_by_email_lists_a_workspace_paste_file_for_review
    assert _after(aws, paste) == (True, [paste])
E   AssertionError: assert (True, []) == (True, ['ws/w...3e5f60.json'])
E     At index 1 diff: [] != ['ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/raw/manual_import/2026/01/01/0b6f6c1e-9d55-4a1e-8f4b-2a7d1c3e5f60.json']
FAILED voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py::test_an_erasure_by_email_lists_a_workspace_paste_file_for_review
========================= 1 failed, 1 warning in 0.46s =========================
```

## Green

```
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py .      [100%]
========================= 1 passed, 1 warning in 0.42s =========================
```

```
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py .      [100%]
========================= 1 passed, 1 warning in 0.41s =========================
```

```
voc-datalake/lambda/jobs/retention/test/test_whole_file_review.py .      [100%]
========================= 1 passed, 1 warning in 0.42s =========================
```

The warning is the hypothesis plugin's notice about `norecursedirs`. It is not a skip or a failure.

## Reasons

- **Tests the item.** The test stores a workspace paste file and a workspace review of that paste. The review's
  `source_id` is `manual-{job}-0`, as the paste confirm writes it, and its `s3_raw_uri` is the file. The test runs
  the deployment's erasure by email and checks that one item is deleted, no raw object is deleted, the file is still
  in the bucket, and the job row lists exactly that file's key. That is the release's promise for a paste file.
- **Real path.** `handler.handle_event` runs the real worker: the item walk, `ItemDeleter`, `copies._whole_upload`,
  `whole_upload_key` and `item_raw_objects`. DynamoDB and S3 are faked with moto, at the store edge only.
- **Not a tautology.** The expected key is the literal one the test wrote. No production code computes it.
- **Fails on the break.** Line 205 fails with the review list empty when `manual_import/` is not recognised. This is
  the paste part of the fix. Break 1 of the CSV verdict (ignoring `ws/` roots) would turn it red too, but this break
  hits the paste rule alone.
- **Stable.** Green 3/3 after the restore, with no sleeps or wall-clock waits.
- **Runs in the gate.** The brief resolved the test, and `validate.sh --only features` checks it.
