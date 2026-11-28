---
item: 7.109.01
test: voc-datalake/lambda/jobs/retention/test/test_project_erasure.py::TestAnErasureByEmailReachesTheWorkspacesProjects::test_a_workspaces_product_context_and_a_proposals_left_out_source_are_judged_by_their_routes
digest: ca9aa59bae4727525739fbcd8706ce98439b20c3e8b0b53efe9c323180e3ca0d
verdict: ACCEPT
evaluator: voc-e7109-01/evaluator
author: voc-p7109-01/author
sha: b9208710c8f5cc70349503d564c7db398d5b2b77
tree: d8e9012ed0d371596f8044961a2a14a13ed737e3
checks:
  tests_item: true
  real_path: true
  fails_on_break: true
  not_tautology: true
  stable_3x: true
  runs_in_gate: true
---

## Item

An erasure by email also reads the names of the sources an extract left out (a proposal's `skipped_sources`). A
proposal whose left-out source is named with the address is listed for review, as one whose sources read hold it
already was, and this holds in a workspace's projects as in the deployment's. The erasure also reads the product
description's text fields by the rule its one reader uses (`shared/product_proposals.py` `text_of`: a list field's
lines joined). Each match is listed by its route (`ws/<ws>/projects/<id>/product-context`, `…/product-proposals/<id>`)
and nothing is rewritten. The workspace's exports, which copy those rows, are closed.

## Command

```bash
bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/jobs/retention/test/test_project_erasure.py::TestAnErasureByEmailReachesTheWorkspacesProjects::test_a_workspaces_product_context_and_a_proposals_left_out_source_are_judged_by_their_routes
```

Every run below is this command, run from the root of a scratch copy of the staged tree (`git archive
d8e9012ed0d371596f8044961a2a14a13ed737e3` into `<scratch>`, its `voc-datalake/.venv` a link to the worktree's
`<venv>`), prefixed with `nice -n 10`. The shared worktree was not edited.

## Break

In the scratch copy, `_proposal_texts` no longer reads `skipped_sources`, the 7.109.01 fix taken out:

```diff
diff --git a/voc-datalake/lambda/jobs/retention/project_people.py b/voc-datalake/lambda/jobs/retention/project_people.py
--- a/voc-datalake/lambda/jobs/retention/project_people.py
+++ b/voc-datalake/lambda/jobs/retention/project_people.py
@@ -994,8 +994,7 @@
              if isinstance(entry.get(name), str)]
     for entry in entries:
         texts.extend(_texts_at(entry.get('citations'), 'quote'))
-    return [*texts, *_texts_at(row.get('questions'), 'question'), *_texts_at(row.get('sources'), 'name'),
-            *_texts_at(row.get('skipped_sources'), 'name')]
+    return [*texts, *_texts_at(row.get('questions'), 'question'), *_texts_at(row.get('sources'), 'name')]
 
 
 def _context_texts(row: Mapping[str, Any]) -> list[str]:
```

I ran two more breaks of my own, one at a time, each restored before the next. Each also went red on this command:

- `_PROPOSAL_PROJECTION` without `#skipped`: the workspace's Query no longer returns the attribute. It fails the same
  way, with the proposal's route missing.
- `_context_texts` reading only a field that is text, not a list field's lines: the product context's route is
  missing, and only the proposal is listed.

## Red

The run lists only the product context's route. The proposal that names the address in a left-out source is not
listed:

```
collected 1 item

voc-datalake/lambda/jobs/retention/test/test_project_erasure.py F        [100%]

=================================== FAILURES ===================================
_ TestAnErasureByEmailReachesTheWorkspacesProjects.test_a_workspaces_product_context_and_a_proposals_left_out_source_are_judged_by_their_routes _
voc-datalake/lambda/jobs/retention/test/test_project_erasure.py:412: in test_a_workspaces_product_context_and_a_proposals_left_out_source_are_judged_by_their_routes
    assert erasure_rows(aws, JOB_ID)[0]['files_needing_review']['keys'] == [
E   AssertionError: assert ['ws/ws_01JC3...duct-context'] == ['ws/ws_01JC3...ffffffffffff']
E     
E     Right contains one more item: 'ws/ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8/projects/proj_live_000001/product-proposals/pp_20261126T120005000000Z_ffffffffffff'
E     Use -v to get more diff
=========================== short test summary info ============================
FAILED voc-datalake/lambda/jobs/retention/test/test_project_erasure.py::TestAnErasureByEmailReachesTheWorkspacesProjects::test_a_workspaces_product_context_and_a_proposals_left_out_source_are_judged_by_their_routes
============================== 1 failed in 4.59s ===============================
```

## Green

After `project_people.py` was copied back and `cmp` showed it byte-identical to the staged blob:

```
collected 1 item

voc-datalake/lambda/jobs/retention/test/test_project_erasure.py .        [100%]

============================== 1 passed in 6.00s ===============================
```

```
collected 1 item

voc-datalake/lambda/jobs/retention/test/test_project_erasure.py .        [100%]

============================== 1 passed in 0.93s ===============================
```

```
collected 1 item

voc-datalake/lambda/jobs/retention/test/test_project_erasure.py .        [100%]

============================== 1 passed in 0.87s ===============================
```

## Reasons

- **Tests the item.** Workspace A's live project holds three rows. Its product context names the address, upper
  case, in one line of a list field (`key_features`). One proposal names the address only as a left-out source's
  file name. A second proposal names a clean source. The test then runs an erasure by email and checks three
  things:
  - the job row's `files_needing_review` is exactly the context's route then the first proposal's route, under
    `ws/<ws>/`, and the clean proposal is not listed (a negative control);
  - the workspace's export object is deleted (`deleted_export_objects == 1`);
  - all three rows read back exactly as written, so nothing was rewritten.

  That is the Security bullet and the Internal bullet of the CHANGELOG, in a workspace.
- **Real path.** `handler.handle_event` runs the real retention worker: the job row, the workspace listing and walk,
  `ProjectPeopleEraser`'s proposals step with its projection, `_context`, `_proposal`, `_holds_it`, the exports
  close, and the job and audit rows. Only DynamoDB and S3 are faked, through the suite's moto fixture. The projection
  break shows that the Query's attribute list is on the path.
- **Not a tautology.** The expected keys are built from the test's literal workspace id, project id and proposal
  id. The unchanged-rows check compares with the dicts the test itself wrote. Nothing expected comes from the code
  under test.
- **Still true on the 7.109.00 base.** 7.109.00 changed `jobs/retention/copies.py` (`ItemDeleter._whole_upload`)
  and `shared/retention.py` (`whole_upload_key`, `_own_raw_key`, `item_raw_objects`). That code runs only when an
  erasure deletes a feedback item. It feeds the same `review_files` list (`runs.note_review_file`) as these routes.
  This test seeds no feedback item, so the list holds only the project walk's routes. The test compares the whole
  list, in order, so any key 7.109.00 added for this scenario would fail it, and it is green on the staged tree that
  sits on 7.109.00 (b9208710c). 7.109.00 did not touch this test file (its last change is 7.99.00's).
- **Fails on the break.** Line 412 fails with the proposal's route missing.
- **Stable.** Green 3/3 after the restore. The Lambda context is a mock with a fixed remaining time, and there is
  no sleep.
- **Runs in the gate.** `brief` resolved the node, its file holds no skip or xfail mark, and `check` (run after
  `accept`) reports no problem for this test.
