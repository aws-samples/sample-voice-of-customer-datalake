---
item: 7.106.00
test: voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_the_upload_refuses_an_image_in_a_workspace_with_the_extractors_message_and_writes_nothing
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

In a workspace, an image upload is refused before its record is written: 400 `image_in_workspace`, with the S3
extractor's own message ("Images can't be described in a workspace yet. Upload the design as a .md or .txt file."). It
stays refused until the model picks move into the workspace (3f).

## Command

```bash
bash scripts/pinned.sh python -m pytest -c voc-datalake/pytest.ini --rootdir voc-datalake -p no:cacheprovider --no-cov -q voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_the_upload_refuses_an_image_in_a_workspace_with_the_extractors_message_and_writes_nothing
```

## Break

The upload route's refusal of an image in a workspace is switched off, so the image is taken and its record is
written. It was applied to the evaluated tree's product code, run, and restored byte for byte (`git diff` empty again).

```diff
--- a/voc-datalake/lambda/api/product_context.py
+++ b/voc-datalake/lambda/api/product_context.py
@@ -602,7 +602,7 @@ def create_upload_url(project_id: str, body: dict, *, actor: Mapping[str, str] |
             f'Unsupported file type. Accepted: {_ACCEPTED_EXTENSIONS_LABEL}.'
         )
 
-    if workspace is not None and content_type in IMAGE_CONTENT_TYPES:
+    if False and workspace is not None and content_type in IMAGE_CONTENT_TYPES:
         raise ValidationError(WORKSPACE_IMAGE_MESSAGE, code='image_in_workspace')
 
     max_bytes, kind = _type_cap(content_type)
```

## Red

```
collected 1 item

voc-datalake/lambda/api/test/test_product_routes_workspace.py F          [100%]

=================================== FAILURES ===================================
_ test_the_upload_refuses_an_image_in_a_workspace_with_the_extractors_message_and_writes_nothing _
voc-datalake/lambda/api/test/test_product_routes_workspace.py:320: in test_the_upload_refuses_an_image_in_a_workspace_with_the_extractors_message_and_writes_nothing
    assert (status, answer['error'], answer.get('code')) == (400, _extractor_image_message(), 'image_in_workspace')
                    ^^^^^^^^^^^^^^^
E   KeyError: 'error'
=========================== short test summary info ============================
FAILED voc-datalake/lambda/api/test/test_product_routes_workspace.py::test_the_upload_refuses_an_image_in_a_workspace_with_the_extractors_message_and_writes_nothing
========================= 1 failed, 1 warning in 1.80s =========================
```

## Green

```
========================= 1 passed, 1 warning in 1.82s =========================
```

```
========================= 1 passed, 1 warning in 1.81s =========================
```

```
========================= 1 passed, 1 warning in 1.77s =========================
```

## Reasons

The test drives the real projects handler (`projects_handler` through `workspace_route_call`) with the seam on, as A's
editor, in moto: the store and the bucket are the faked edges. It checks the status, the message and the code of the
answer, and that no row, counter or object was written (`world.state() == before`). The expected message is read from
the stdlib-only S3 extractor's source (`product_doc_extractor/handler.py`), not from the code under test, so the API and
the extractor must agree. With the refusal off, the upload answered 200 with no `error`, and the test failed at its own
assertion line (320). The failure is a KeyError on `answer['error']`, an expression inside that assertion, not a
collection error. A stricter form would compare `answer.get('error')`. That is a note for the author, not a reason to
reject.
