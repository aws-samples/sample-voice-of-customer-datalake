"""The extractor's key layout must stay under the prefix a project delete sweeps.

Three components spell the same S3 layout and they must not drift:

  * `api/product_context.py` WRITES the raw upload key and owns the prefix
    (`product_docs_project_prefix`);
  * `handler.py` WRITES the extracted key (`_extracted_key`) and MATCHES the raw
    one (`RAW_KEY_PATTERN`);
  * `api/projects.py::delete_project` EMPTIES the prefix when a project is deleted.

The delete is why this now needs enforcing. It sweeps
`projects/{project_id}/product_docs/`, so an extracted key written anywhere else
survives the project it belongs to — unreferenced, still reachable through a
presigned read, and billed indefinitely (`rawDataBucket` has no lifecycle
expiration). That failure is silent in the only place anyone would look: the
project is gone from the list and the objects are not.

The extractor cannot import product_context to check this at runtime — that module
reaches powertools and boto3 through `shared/`, which is the whole reason this
handler is stdlib-only (see its docstring) — but a TEST can. Same approach as
`test_content_type_lockstep.py` and `test_default_model_lockstep.py` next door.
"""
from api.product_context import product_docs_project_prefix

from product_doc_extractor.handler import RAW_KEY_PATTERN, _extracted_key

PROJECT = 'proj_1'
DOC = 'abc123'


class TestProductDocsPrefixLockstep:
    def test_the_extracted_key_lands_under_the_swept_prefix(self):
        assert _extracted_key(PROJECT, DOC).startswith(
            product_docs_project_prefix(PROJECT),
        ), (
            'The extractor writes outside the prefix `delete_project` sweeps, so '
            'extracted text survives the project that owns it.'
        )

    def test_the_raw_key_the_extractor_matches_lands_under_it_too(self):
        # Built from the boundary's own prefix and matched by the handler's
        # pattern: the two directions of the same contract. A prefix change that
        # broke either would leave uploads unextracted or extractions unswept.
        raw_key = f'{product_docs_project_prefix(PROJECT)}raw/{DOC}.pdf'
        matched = RAW_KEY_PATTERN.match(raw_key)

        assert matched is not None
        assert matched.group('project_id') == PROJECT
        assert matched.group('doc_id') == DOC

    def test_the_prefix_ends_in_a_slash_so_a_sibling_id_is_not_swept(self):
        """`projects/proj_1` also prefixes `projects/proj_10/...`.

        The sweep lists on this string, so without the trailing slash deleting
        `proj_1` would remove `proj_10`'s product docs. The negative control is the
        assertion that matters: the positive one holds for either spelling.
        """
        prefix = product_docs_project_prefix(PROJECT)

        assert prefix.endswith('/')
        assert not f'{product_docs_project_prefix("proj_10")}raw/x.pdf'.startswith(
            prefix,
        )
